import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { Order, SampleHold } from './types'

// Sample holds (feedback #3, 061): a sample order holds product for that customer while the sample is on its way
// and for N days after it ships (Settings › Customers › Sample hold days, default 10). What they order of it afterwards
// uses the hold up. Sales can release a hold or change the date it runs until.

const n0 = (x: number | null | undefined) => Math.round(Number(x ?? 0)).toLocaleString()
const d = (iso: string | null | undefined) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '')
const STATE_L: Record<SampleHold['state'], string> = { waiting: 'Holding until the sample ships', active: 'Holding', expired: 'Expired', used: 'Ordered', released: 'Released', cancelled: 'Cancelled' }
const live = (h: SampleHold) => h.state === 'waiting' || h.state === 'active'
export const holdLine = (h: SampleHold) => h.state === 'waiting' ? 'holding, clock starts when the sample ships' : h.state === 'active' ? `held until ${d(h.until)}` : STATE_L[h.state].toLowerCase()

/** a customer's (or everyone's) sample holds. Staff can release or extend. */
export function SampleHolds({ backend, customerId, staff, flash, title = 'Sample holds', showCustomer, rev = 0, onChanged }: {
  backend: Backend; customerId?: number | null; staff?: boolean; flash?: (t: string, bad?: boolean) => void; title?: string; showCustomer?: boolean; rev?: number; onChanged?: () => void
}) {
  const [rows, setRows] = useState<SampleHold[] | null>(null)
  const [past, setPast] = useState(false)
  const [ext, setExt] = useState<{ id: number; until: string } | null>(null)
  const load = () => backend.sampleHolds(customerId, past).then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [customerId, past, rev])
  if (!rows) return null
  const shown = rows.filter(h => past || live(h) || (h.until && h.until >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)))
  if (!shown.length && !staff) return null
  async function act(h: SampleHold, release: boolean, until?: string) {
    try { await backend.setSampleHold(h.line_id, release, until ?? null); flash?.(release ? `${h.strain} hold released` : `${h.strain} held until ${d(until)}`); setExt(null); await load(); onChanged?.() }
    catch (e) { flash?.(String((e as Error).message ?? e), true) }
  }
  return (
    <div className="sholds">
      <h3>{title} {staff && <label className="check small-check sh-past"><input type="checkbox" checked={past} onChange={e => setPast(e.target.checked)} /> Show old ones</label>}</h3>
      {!shown.length ? <p className="muted">No sample holds right now. Check "Sample order" on an order to hold product while the customer tries it.</p> : (
        <div className="cwrap"><table className="restable wide">
          <thead><tr>{showCustomer && <th>Customer</th>}<th>Strain</th><th className="num">Held</th><th>Status</th>{staff && <th className="hide-s">Sample</th>}{staff && <th />}</tr></thead>
          <tbody>{shown.map(h => <tr key={h.line_id} className={live(h) ? '' : 'muted'}>
            {showCustomer && <td>{h.customer}</td>}
            <td>{h.strain}{h.crop_year !== new Date().getFullYear() && <span className="pill old">{h.crop_year} crop</span>}</td>
            <td className="num"><b>{n0(live(h) ? h.remaining : h.hold_lbs)}</b>{h.used_lbs > 0 && <div className="muted small">{n0(h.used_lbs)} of {n0(h.hold_lbs)} ordered</div>}</td>
            <td><span className={`pill ${h.state === 'active' ? 'cp-ok' : h.state === 'waiting' ? 'cp-warn' : 'cp-mute'}`}>{STATE_L[h.state]}</span>
              {h.state === 'active' && <div className="muted small">until {d(h.until)}</div>}</td>
            {staff && <td className="hide-s small">{h.so_number ?? `#${h.order_id}`}{h.shipped_on ? ` · shipped ${d(h.shipped_on)}` : ''}</td>}
            {staff && <td className="nowrap">
              {ext?.id === h.line_id
                ? <span className="row"><input type="date" value={ext.until} onChange={e => setExt({ id: h.line_id, until: e.target.value })} />
                    <button className="primary small" disabled={!ext.until} onClick={() => act(h, false, ext.until)}>Save</button><button className="ghost small" onClick={() => setExt(null)}>✕</button></span>
                : <>{(live(h) || h.state === 'expired' || h.state === 'released') && <button className="ghost small" onClick={() => setExt({ id: h.line_id, until: h.until ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) })}>{live(h) ? 'Extend' : 'Hold again'}</button>}
                    {live(h) && <button className="ghost small" onClick={() => { if (confirm(`Release the ${n0(h.remaining)} lb ${h.strain} hold for ${h.customer}? It goes back on the open menu.`)) act(h, true) }}>Release</button>}</>}
            </td>}
          </tr>)}</tbody>
        </table></div>)}
    </div>
  )
}

/** Sales: mark which lines of an order are samples and how much each holds */
export function SampleSheet({ backend, o, days, flash, onClose, onDone }: { backend: Backend; o: Order; days?: number | null; flash: (t: string, bad?: boolean) => void; onClose: () => void; onDone: () => void }) {
  const lines = o.order_lines.filter(l => (l.product ?? 'fresh_frozen') === 'fresh_frozen')
  const [smp, setSmp] = useState<Record<number, boolean>>(() => Object.fromEntries(lines.map(l => [l.id, !!l.is_sample])))
  const [hold, setHold] = useState<Record<number, string>>(() => Object.fromEntries(lines.map(l => [l.id, l.hold_lbs ? String(l.hold_lbs) : ''])))
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await backend.setOrderSample(o.id, false, lines.map(l => ({ line_id: l.id, sample: !!smp[l.id], hold_lbs: smp[l.id] && hold[l.id] !== '' ? Number(hold[l.id]) : null })))
      flash('Sample lines saved'); onDone()
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Samples · {o.so_number ?? `#${o.id}`}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <p className="muted">Check the lines that are samples and how much to hold for them. The hold comes off the open menu now, lasts until {days ?? 10} days after the order ships (customer setting), and goes away if the order is cancelled.</p>
        <table className="restable"><thead><tr><th>Strain</th><th className="num">Lbs</th><th className="ctr">Sample</th><th className="num">Hold lbs</th></tr></thead>
          <tbody>{lines.map(l => <tr key={l.id}><td>{l.strain}</td><td className="num">{n0(l.lbs)}</td>
            <td className="ctr"><input type="checkbox" checked={!!smp[l.id]} onChange={e => setSmp({ ...smp, [l.id]: e.target.checked })} /></td>
            <td className="num">{smp[l.id] && <input className="qty" type="number" min="0" step="10" value={hold[l.id] ?? ''} placeholder="0" onChange={e => setHold({ ...hold, [l.id]: e.target.value })} />}</td></tr>)}</tbody></table>
        <div className="row between csave"><span />
          <div className="row"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>Save</button></div></div>
      </div>
    </div>
  )
}
