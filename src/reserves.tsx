import { useEffect, useMemo, useState } from 'react'
import type { Backend } from './api'
import type { Customer, Reserve, Strain } from './types'

const n0 = (x: number) => Math.round(x).toLocaleString()

export function ReservesView({ backend, customers, strains, onHand, flash }: {
  backend: Backend; customers: Customer[]; strains: Strain[]; onHand: Map<string, number>
  flash: (t: string, bad?: boolean) => void
}) {
  const [rows, setRows] = useState<Reserve[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<'customer' | 'strain'>('customer')
  const [open, setOpen] = useState<number | null>(null)
  const [edit, setEdit] = useState<{ customer_id: number | null; strain: string; lbs: string; isNew: boolean } | null>(null)
  const [q, setQ] = useState('')
  const load = () => backend.listReserves().then(r => { setRows(r); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])

  const cust = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])
  const onHandOf = (s: string) => onHand.get(s.toLowerCase()) ?? 0

  if (err) return <div className="list"><h2>Reserves</h2><div className="warnbox">Reserves aren't set up in the database yet. Run 009_reserves.sql in Supabase, then refresh. ({err})</div></div>
  if (!rows) return <div className="list"><h2>Reserves</h2><p className="muted">Loading…</p></div>

  const ql = q.toLowerCase()
  const byCust = [...rows.reduce((m, r) => m.set(r.customer_id, [...(m.get(r.customer_id) ?? []), r]), new Map<number, Reserve[]>())]
    .map(([id, rs]) => ({ id, name: cust.get(id)?.name ?? `#${id}`, rs, total: rs.reduce((a, r) => a + Number(r.lbs), 0) }))
    .filter(c => !ql || c.name.toLowerCase().includes(ql) || c.rs.some(r => r.strain.toLowerCase().includes(ql)))
    .sort((a, b) => a.name.localeCompare(b.name))
  const strainNames = new Set([...rows.map(r => r.strain)])
  const byStrain = [...strainNames].map(s => {
    const rs = rows.filter(r => r.strain === s)
    const reserved = rs.reduce((a, r) => a + Number(r.lbs), 0), have = onHandOf(s)
    return { s, rs, reserved, have, free: have - reserved }
  }).filter(x => !ql || x.s.toLowerCase().includes(ql) || x.rs.some(r => (cust.get(r.customer_id)?.name ?? '').toLowerCase().includes(ql)))
    .sort((a, b) => a.s.localeCompare(b.s))
  const total = rows.reduce((a, r) => a + Number(r.lbs), 0)

  async function save() {
    if (!edit || edit.customer_id == null) return
    const lbs = Number(edit.lbs)
    try { await backend.setReserve(edit.customer_id, edit.strain, lbs); await load(); setOpen(edit.customer_id); setEdit(null); flash(lbs === 0 ? 'Reserve removed' : 'Reserve saved') }
    catch (e) { flash(String((e as Error).message ?? e), true) }
  }

  return (
    <div className="list reserves">
      <h2>Reserves <span className="muted">{n0(total)} lbs fresh frozen</span></h2>
      <div className="row toolbar">
        <div className="seg">
          <button className={mode === 'customer' ? 'on' : ''} onClick={() => setMode('customer')}>By customer</button>
          <button className={mode === 'strain' ? 'on' : ''} onClick={() => setMode('strain')}>By strain</button>
        </div>
        <input className="search" type="search" placeholder="Search customer or strain" value={q} onChange={e => setQ(e.target.value)} />
        <button className="primary" onClick={() => setEdit({ customer_id: null, strain: '', lbs: '', isNew: true })}>+ Add reserve</button>
      </div>

      {mode === 'customer' && byCust.map(c => (
        <div key={c.id} className="rescard">
          <button className="li setrow" onClick={() => setOpen(open === c.id ? null : c.id)}>
            <div className="grow"><b>{c.name}</b><div className="muted">{c.rs.length} strain{c.rs.length === 1 ? '' : 's'}</div></div>
            <b>{n0(c.total)} lbs</b>
          </button>
          {open === c.id && (
            <table className="restable">
              <thead><tr><th>Strain</th><th className="num">Reserved</th><th className="num">On hand</th><th /></tr></thead>
              <tbody>
                {c.rs.map(r => (
                  <tr key={r.id}>
                    <td>{r.strain}</td><td className="num">{n0(Number(r.lbs))}</td><td className="num muted">{n0(onHandOf(r.strain))}</td>
                    <td className="num"><button className="ghost small" onClick={() => setEdit({ customer_id: c.id, strain: r.strain, lbs: String(r.lbs), isNew: false })}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={4}><button className="ghost small" onClick={() => setEdit({ customer_id: c.id, strain: '', lbs: '', isNew: true })}>+ Add strain for {c.name}</button></td></tr></tfoot>
            </table>
          )}
        </div>
      ))}

      {mode === 'strain' && (
        <table className="restable wide">
          <thead><tr><th>Strain</th><th className="num">On hand</th><th className="num">Reserved</th><th className="num">Not reserved</th></tr></thead>
          <tbody>
            {byStrain.map(x => (
              <tr key={x.s} title={x.rs.map(r => `${cust.get(r.customer_id)?.name}: ${n0(Number(r.lbs))}`).join('\n')}>
                <td>{x.s}<div className="muted small">{x.rs.map(r => cust.get(r.customer_id)?.name).join(', ')}</div></td>
                <td className="num">{n0(x.have)}</td><td className="num">{n0(x.reserved)}</td>
                <td className={`num ${x.free < 0 ? 'warn-t' : ''}`}>{n0(x.free)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length === 0 && <p className="muted">No reserves yet.</p>}
      <p className="muted">On hand is what's in the freezers in this app (including pallets waiting for a spot). Shipped and pending orders come next.</p>

      {edit && (
        <div className="scrim" onClick={() => setEdit(null)}>
          <div className="sheet form" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><h2>{edit.isNew ? 'Add reserve' : 'Edit reserve'}</h2><button className="ghost" onClick={() => setEdit(null)}>✕</button></div>
            <div className="field"><label>Customer</label>
              <select value={edit.customer_id ?? ''} disabled={!edit.isNew} onChange={e => setEdit({ ...edit, customer_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Pick a customer…</option>
                {customers.filter(c => c.active && c.kind === 'external').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="field"><label>Strain</label>
              <input list="reserve-strains" value={edit.strain} disabled={!edit.isNew} onChange={e => setEdit({ ...edit, strain: e.target.value })} placeholder="Start typing" />
              <datalist id="reserve-strains">{strains.filter(s => s.active).map(s => <option key={s.id} value={s.name} />)}</datalist></div>
            <div className="field"><label>Reserved lbs</label>
              <input type="number" min="0" step="10" value={edit.lbs} onChange={e => setEdit({ ...edit, lbs: e.target.value })} autoFocus={!edit.isNew} />
              {edit.strain && <span className="muted">{n0(onHandOf(edit.strain))} lbs on hand</span>}</div>
            <div className="row between">
              {!edit.isNew ? <button className="ghost" onClick={() => { setEdit({ ...edit, lbs: '0' }); }}>Set to 0 (remove)</button> : <span />}
              <div className="row">
                <button className="ghost" onClick={() => setEdit(null)}>Cancel</button>
                <button className="primary" disabled={edit.customer_id == null || !edit.strain.trim() || edit.lbs === '' || Number(edit.lbs) < 0} onClick={save}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// read-only list for the customer portal
export function MyReserves({ backend }: { backend: Backend }) {
  const [rows, setRows] = useState<Reserve[] | null>(null)
  useEffect(() => { backend.listReserves().then(setRows).catch(() => setRows([])) }, [])
  if (!rows) return <p className="muted">Loading…</p>
  if (!rows.length) return <p className="muted">No reserves on file yet.</p>
  const total = rows.reduce((a, r) => a + Number(r.lbs), 0)
  return (
    <table className="restable">
      <thead><tr><th>Strain</th><th className="num">Reserved (lbs)</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td>{r.strain}</td><td className="num">{n0(Number(r.lbs))}</td></tr>)}</tbody>
      <tfoot><tr><td><b>Total</b></td><td className="num"><b>{n0(total)}</b></td></tr></tfoot>
    </table>
  )
}
