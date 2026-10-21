import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { MenuRow, ReserveRequest } from './types'

const n0 = (x: number | null | undefined) => Math.round(Number(x ?? 0)).toLocaleString()
const STATUS: Record<string, string> = { pending: 'Waiting for approval', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' }

// Customer portal: live open menu + reserve change requests
export function OpenMenu({ backend, reserves }: { backend: Backend; reserves: boolean }) {
  const [rows, setRows] = useState<MenuRow[] | null>(null)
  const [reqs, setReqs] = useState<ReserveRequest[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [mine, setMine] = useState(false)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<MenuRow | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const load = () => Promise.all([backend.openMenu(), backend.listRequests().catch(() => [] as ReserveRequest[])])
    .then(([m, r]) => { setRows(m); setReqs(r); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])

  if (err) return <p className="muted">The menu isn't available right now.</p>
  if (!rows) return <p className="muted">Loading…</p>
  const cy = Math.max(...rows.map(r => r.crop_year), 0)
  const older = rows.filter(r => r.crop_year < cy && Number(r.available) > 0 && (!q || r.strain.toLowerCase().includes(q.toLowerCase())))
  const olderYears = [...new Set(older.map(r => r.crop_year))].sort((a, b) => b - a)
  const cur = rows.filter(r => r.crop_year === cy)
  const shown = cur.filter(r => (reserves || Number(r.available) > 0) && (!mine || r.my_reserved != null || r.request_id != null) && (!q || r.strain.toLowerCase().includes(q.toLowerCase())))
  const totalAvail = cur.reduce((a, r) => a + Number(r.available), 0)

  return (
    <>
      <p className="muted">{cy} crop: {n0(totalAvail)} lbs of fresh frozen open right now, across {cur.filter(r => Number(r.available) > 0).length} strains.{olderYears.length > 0 && ` Older crop below.`} Numbers update live as orders and reserves change.</p>
      {msg && <div className="okbox">{msg} <a onClick={() => setMsg(null)}>Dismiss</a></div>}
      <div className="row toolbar">
        <input className="search" type="search" placeholder="Search strains" value={q} onChange={e => setQ(e.target.value)} />
        {reserves && <div className="seg">
          <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>All</button>
          <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>My reserves</button>
        </div>}
      </div>
      <table className="restable menu">
        <thead><tr><th>Strain</th><th className="num">Open</th>{reserves && <><th className="num">Your reserve</th><th /></>}</tr></thead>
        <tbody>
          {shown.map(r => (
            <tr key={r.strain}>
              <td>{r.strain}
                {r.request_id != null && <div className="reqnote">Requested {n0(r.requested_lbs)} lbs · waiting</div>}</td>
              <td className="num">{Number(r.available) > 0 ? n0(r.available) : <span className="muted">0</span>}</td>
              {reserves && <><td className="num">{r.my_reserved != null ? <>{n0(r.my_reserved)}<div className="muted small">{n0(r.my_left)} left</div></> : <span className="muted">-</span>}</td>
              <td className="num">
                {(Number(r.available) > 0 || r.my_reserved != null || r.request_id != null) &&
                  <button className="ghost small" onClick={() => setPick(r)}>{r.request_id != null ? 'Edit request' : r.my_reserved != null ? 'Change' : 'Reserve'}</button>}
              </td></>}
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="muted">Nothing matches.</p>}
      {olderYears.map(y => (
        <div key={y}>
          <h4 className="cropyear">{y} crop <span className="muted">{n0(older.filter(r => r.crop_year === y).reduce((a, r) => a + Number(r.available), 0))} lbs open</span></h4>
          <table className="restable menu">
            <thead><tr><th>Strain</th><th className="num">Open</th></tr></thead>
            <tbody>{older.filter(r => r.crop_year === y).map(r => <tr key={r.strain}><td>{r.strain}</td><td className="num">{n0(r.available)}</td></tr>)}</tbody>
          </table>
        </div>
      ))}

      {reserves && reqs.length > 0 && (
        <>
          <h3>Your reserve requests</h3>
          {reqs.slice(0, 30).map(r => (
            <div key={r.id} className={`li reqcard ${r.status}`}>
              <div className="grow">
                <div><b>{r.strain}</b> {n0(r.current_lbs)} → <b>{n0(r.requested_lbs)} lbs</b> <span className={`pill r-${r.status}`}>{STATUS[r.status]}</span></div>
                <div className="muted">{new Date(r.requested_at).toLocaleDateString()}{r.note && <> · "{r.note}"</>}{r.decision_note && <> · Lifted: "{r.decision_note}"</>}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {pick && <RequestSheet backend={backend} row={pick} req={reqs.find(x => x.id === pick.request_id) ?? null}
        onClose={() => setPick(null)}
        onDone={m => { setPick(null); setMsg(m); load() }} />}
    </>
  )
}

function RequestSheet({ backend, row, req, onClose, onDone }: {
  backend: Backend; row: MenuRow; req: ReserveRequest | null; onClose: () => void; onDone: (msg: string) => void
}) {
  const cur = Number(row.my_reserved ?? 0)
  const committed = Number(row.my_shipped ?? 0) + Number(row.my_pending ?? 0)
  const heldMine = Math.max(Number(row.requested_lbs ?? 0) - cur, 0)
  const max = cur + Math.floor((Number(row.available) + heldMine) / 10) * 10
  const min = Math.ceil(committed / 10) * 10
  const [val, setVal] = useState(String(row.requested_lbs ?? (cur || Math.min(100, max))))
  const [note, setNote] = useState(req?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const n = Number(val)
  const bad = val === '' || isNaN(n) ? 'Enter an amount' : n % 10 !== 0 ? 'Use multiples of 10 lbs' : n > max ? `The most you can ask for right now is ${n0(max)} lbs` : n < min ? `You've already shipped or ordered ${n0(committed)} lbs, so it can't go below ${n0(min)}` : n === cur ? 'That’s your current reserve' : null
  const step = (d: number) => setVal(String(Math.max(min, Math.min(max, (Number(val) || 0) + d))))

  async function send() {
    setBusy(true); setErr(null)
    try { await backend.requestReserve(row.strain, n, note); onDone(`Request sent: ${row.strain} ${n0(cur)} → ${n0(n)} lbs. Lifted will review it.`) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  async function cancel() {
    if (!req) return
    setBusy(true)
    try { await backend.cancelRequest(req.id); onDone('Request cancelled') } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{row.strain}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="stats">
          <div><span className="muted">Your reserve</span><b>{n0(cur)} lbs</b></div>
          <div><span className="muted">Shipped or ordered</span><b>{n0(committed)} lbs</b></div>
          <div><span className="muted">Open to add</span><b>{n0(max - cur)} lbs</b></div>
        </div>
        <div className="field"><label>New reserve total (lbs)</label>
          <div className="row stepper">
            <button className="ghost" onClick={() => step(-100)}>−100</button>
            <input type="number" min={min} max={max} step="10" value={val} onChange={e => setVal(e.target.value)} />
            <button className="ghost" onClick={() => step(100)}>+100</button>
          </div>
          {!bad && <span className="muted">{n > cur ? `+${n0(n - cur)} lbs` : `−${n0(cur - n)} lbs`} from your current reserve</span>}
          {bad && val !== '' && <span className="warn-t">{bad}</span>}
        </div>
        <div className="field"><label>Note <span className="muted">(optional)</span></label>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Anything Lifted should know" /></div>
        {err && <div className="warn-t">{err}</div>}
        <p className="muted">Changes need approval from Lifted. Increases are held for you while you wait.</p>
        <div className="row between">
          {req ? <button className="ghost" disabled={busy} onClick={cancel}>Cancel request</button> : <span />}
          <div className="row">
            <button className="ghost" onClick={onClose}>Close</button>
            <button className="primary" disabled={busy || !!bad} onClick={send}>{req ? 'Update request' : 'Send request'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Customer portal: place an order (by strain, from their reserve plus what's open)
export function OrderForm({ backend, reserves, onClose, onDone }: { backend: Backend; reserves: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState<MenuRow[] | null>(null)
  const [price, setPrice] = useState<number | null>(null)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const [po, setPo] = useState('')
  const [wanted, setWanted] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    backend.openMenu().then(setRows).catch(e => setErr(String(e?.message ?? e)))
    backend.myTerms().then(t => setPrice(t?.price_per_lb != null ? Number(t.price_per_lb) : null))
  }, [])
  const key = (r: { strain: string; crop_year: number }) => `${r.strain}|${r.crop_year}`
  const cy = Math.max(...(rows ?? []).map(r => r.crop_year), 0)
  const canOrder = (r: MenuRow) => (reserves && r.crop_year === cy ? Math.floor(Number(r.my_left ?? 0) / 10) * 10 : 0) + Number(r.available)
  const list = (rows ?? []).filter(r => canOrder(r) > 0 && (!q || r.strain.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => b.crop_year - a.crop_year || Number(b.my_left ?? 0) - Number(a.my_left ?? 0) || a.strain.localeCompare(b.strain))
  const lines = Object.entries(qty).map(([k, v]) => { const [strain, y] = k.split('|'); return { strain, crop_year: Number(y), lbs: Number(v) } }).filter(l => l.lbs > 0)
  const problems = lines.map(l => {
    const r = rows?.find(x => x.strain === l.strain && x.crop_year === l.crop_year)
    const nm = l.crop_year === cy ? l.strain : `${l.strain} (${l.crop_year})`
    if (l.lbs % 10 !== 0) return `${nm}: use multiples of 10 lbs`
    if (r && l.lbs > canOrder(r)) return `${nm}: up to ${n0(canOrder(r))} lbs`
    return null
  }).filter(Boolean) as string[]
  const total = lines.reduce((a, l) => a + l.lbs, 0)

  async function submit() {
    setBusy(true); setErr(null)
    try { const id = await backend.placeOrder(lines, note, po, wanted || null); onDone(`Order #${id} sent: ${n0(total)} lbs. Lifted will confirm it.`) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>New order</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <p className="muted">Fresh frozen, by the lb in steps of 10. You can order {reserves ? 'your reserve plus ' : ''}anything open on the menu.{price != null ? ` Your price: $${price.toFixed(2)}/lb.` : ''}</p>
        <input className="search" type="search" placeholder="Search strains" value={q} onChange={e => setQ(e.target.value)} />
        {!rows && !err && <p className="muted">Loading…</p>}
        <div className="picklist orderlist">
          <table className="restable">
            <thead><tr><th>Strain</th>{reserves && <th className="num">Your reserve left</th>}<th className="num">Can order</th><th className="num">Lbs</th></tr></thead>
            <tbody>
              {list.map(r => (
                <tr key={key(r)} className={Number(qty[key(r)] || 0) > 0 ? 'picked' : ''}>
                  <td>{r.strain}{r.crop_year !== cy && <span className="pill old">{r.crop_year} crop</span>}</td>
                  {reserves && <td className="num">{r.my_left != null ? n0(r.my_left) : <span className="muted">-</span>}</td>}
                  <td className="num">{n0(canOrder(r))}</td>
                  <td className="num"><input className="qty" type="number" min="0" step="10" max={canOrder(r)} value={qty[key(r)] ?? ''} placeholder="0"
                    onChange={e => setQty({ ...qty, [key(r)]: e.target.value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && list.length === 0 && <p className="muted">Nothing available to order{q ? ' matches' : ''}.</p>}
        </div>
        <div className="row orderfields">
          <div className="field"><label>PO # <span className="muted">(optional)</span></label><input value={po} onChange={e => setPo(e.target.value)} /></div>
          <div className="field"><label>Wanted by <span className="muted">(optional)</span></label><input type="date" value={wanted} onChange={e => setWanted(e.target.value)} /></div>
        </div>
        <div className="field"><label>Note <span className="muted">(optional)</span></label><input value={note} onChange={e => setNote(e.target.value)} placeholder="Pickup or delivery details" /></div>
        {problems.map(p => <div key={p} className="warn-t">{p}</div>)}
        {err && <div className="warn-t">{err}</div>}
        <div className="row between">
          <b>{n0(total)} lbs{price != null && total > 0 ? ` · $${(total * price).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ''}</b>
          <div className="row">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !lines.length || problems.length > 0} onClick={submit}>Send order</button>
          </div>
        </div>
      </div>
    </div>
  )
}
