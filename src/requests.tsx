import { useState } from 'react'
import type { Backend } from './api'
import type { MenuNumbers, ReserveRequest } from './types'

const n0 = (x: number) => Math.round(x).toLocaleString()
const when = (s: string) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Sales > Requests: waiting requests grouped by what the customer sent together; Admins approve or decline
 *  several at once and can approve a different amount than asked. */
export function RequestsPanel({ backend, reqs, nums, cname, cur, isAdmin, flash, onDone }: {
  backend: Backend; reqs: ReserveRequest[]; nums: MenuNumbers[]; cname: (id: number) => string; cur: number; isAdmin: boolean
  flash: (t: string, bad?: boolean) => void; onDone: () => Promise<void>
}) {
  const pending = reqs.filter(r => r.status === 'pending')
  const groups = new Map<string, ReserveRequest[]>()
  for (const r of pending) { const k = r.batch_id ?? `one-${r.id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r) }
  const done = reqs.filter(r => r.status !== 'pending').slice(0, 80)
  return (
    <>
      {!isAdmin && <p className="muted">Only an Admin can approve reserve changes.</p>}
      {groups.size === 0 && <p className="muted">No requests waiting.</p>}
      {[...groups.entries()].map(([k, rs]) => <Batch key={k} backend={backend} rs={rs} nums={nums} cname={cname} cur={cur} isAdmin={isAdmin} flash={flash} onDone={onDone} />)}
      {done.length > 0 && <>
        <h3 className="grouph">Decided</h3>
        <table className="restable wide">
          <thead><tr><th>Customer</th><th>Strain</th><th className="num">Asked</th><th className="num">Result</th><th>By</th></tr></thead>
          <tbody>{done.map(r => (
            <tr key={r.id}>
              <td>{cname(r.customer_id)}{r.crop_year && r.crop_year !== cur ? <span className="pill old">{r.crop_year}</span> : null}<div className="muted small">{when(r.requested_at)}</div></td>
              <td>{r.strain}</td>
              <td className="num">{n0(Number(r.current_lbs))} → {n0(Number(r.requested_lbs))}</td>
              <td className="num"><span className={`pill r-${r.status}`}>{r.status}</span>{r.status === 'approved' && r.approved_lbs != null && Number(r.approved_lbs) !== Number(r.requested_lbs) && <div className="small">at {n0(Number(r.approved_lbs))}</div>}</td>
              <td className="small">{r.decided_by?.split('@')[0]}{r.decision_note && <div className="muted">"{r.decision_note}"</div>}</td>
            </tr>))}
          </tbody>
        </table>
      </>}
    </>
  )
}

function Batch({ backend, rs, nums, cname, cur, isAdmin, flash, onDone }: {
  backend: Backend; rs: ReserveRequest[]; nums: MenuNumbers[]; cname: (id: number) => string; cur: number; isAdmin: boolean
  flash: (t: string, bad?: boolean) => void; onDone: () => Promise<void>
}) {
  const first = rs[0]
  const [pick, setPick] = useState<Set<number>>(() => new Set(rs.map(r => r.id)))
  const [amt, setAmt] = useState<Record<number, string>>(() => Object.fromEntries(rs.map(r => [r.id, String(Number(r.requested_lbs))])))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const yr = first.crop_year ?? cur
  const sorted = [...rs].sort((a, b) => a.strain.localeCompare(b.strain))
  const tog = (id: number) => setPick(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const all = pick.size === rs.length
  async function go(approve: boolean) {
    const ids = sorted.filter(r => pick.has(r.id))
    if (!ids.length) { flash('Tick the lines first', true); return }
    const bad = ids.find(r => approve && !(Number(amt[r.id]) >= 0))
    if (bad) { flash(`${bad.strain}: enter an amount`, true); return }
    setBusy(true)
    try {
      const res = await backend.decideRequests(ids.map(r => ({ id: r.id, approve, lbs: approve ? Number(amt[r.id]) : null })), note)
      await onDone()
      flash(approve ? `Approved ${res.approved}. Reserves updated.` : `Declined ${res.declined}`)
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="rescard reqbatch">
      <div className="reqhead">
        <div><b>{cname(first.customer_id)}</b> <span className="pill old">{yr} crop</span> <span className="pill r-pending">{rs.length} waiting</span></div>
        <div className="muted">{first.requested_by} · {when(first.requested_at)}{first.note && <> · "{first.note}"</>}</div>
      </div>
      <table className="restable">
        <thead><tr>{isAdmin && <th className="selcol"><input type="checkbox" checked={all} onChange={() => setPick(all ? new Set() : new Set(rs.map(r => r.id)))} aria-label="Pick all" /></th>}
          <th>Strain</th><th className="num">Now</th><th className="num">Asked</th>{isAdmin && <th className="num">Approve at</th>}{yr === cur && <th className="num">Free</th>}</tr></thead>
        <tbody>{sorted.map(r => {
          const d = Number(r.requested_lbs) - Number(r.current_lbs)
          const m = yr === cur ? nums.find(x => x.strain.toLowerCase() === r.strain.toLowerCase() && x.crop_year === cur) : undefined
          return (
            <tr key={r.id} className={pick.has(r.id) ? '' : 'unpicked'}>
              {isAdmin && <td className="selcol"><input type="checkbox" checked={pick.has(r.id)} onChange={() => tog(r.id)} aria-label={`Pick ${r.strain}`} /></td>}
              <td>{r.strain}</td><td className="num">{n0(Number(r.current_lbs))}</td>
              <td className="num"><b>{n0(Number(r.requested_lbs))}</b> <span className={d > 0 ? 'up' : 'down'}>({d > 0 ? '+' : ''}{n0(d)})</span></td>
              {isAdmin && <td className="num"><input className="qty" type="number" min="0" step="10" value={amt[r.id] ?? ''} onChange={e => setAmt({ ...amt, [r.id]: e.target.value })} aria-label={`Approve ${r.strain} at`} /></td>}
              {yr === cur && <td className="num">{m ? n0(Number(m.free)) : ''}</td>}
            </tr>
          )
        })}</tbody>
      </table>
      {isAdmin && (
        <div className="row reqact">
          <input placeholder="Note to the customer (optional)" value={note} onChange={e => setNote(e.target.value)} />
          <button className="ghost small" disabled={busy || !pick.size} onClick={() => go(false)}>Decline {pick.size}</button>
          <button className="primary small" disabled={busy || !pick.size} onClick={() => go(true)}>Approve {pick.size}</button>
        </div>
      )}
    </div>
  )
}
