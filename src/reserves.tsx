import { useEffect, useMemo, useState } from 'react'
import type { Backend } from './api'
import { readSheet } from 'read-excel-file/browser'
import { parseCsv } from './settings'
import type { MenuNumbers, ReserveRequest, Role, Balance, Customer, ImportResult, Order, RoshiRow, Strain } from './types'

const n0 = (x: number) => Math.round(x).toLocaleString()

const STATUS_LABEL: Record<string, string> = { shipped: 'Shipped', pending: 'Pending', draft: 'Draft', cancelled: 'Cancelled' }
const orderLbs = (o: Order) => o.order_lines.reduce((a, l) => a + Number(l.lbs), 0)
const fmtDate = (d: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : ''

// Roshi "SO Detail" export -> rows for the import
const ROSHI_COLS: Record<string, keyof RoshiRow> = {
  'id1': 'line_id', 'sales order #': 'so_number', 'customer': 'customer', 'sku name': 'sku_name', 'sku id': 'sku_id',
  'so status': 'status', 'total - gross': 'gross', 'units': 'units', 'sales order date': 'order_date', 'date shipped': 'shipped_date',
  'package tag/lot': 'package_tag',
}
async function readRoshi(f: File): Promise<RoshiRow[]> {
  const grid: unknown[][] = /\.csv$/i.test(f.name)
    ? parseCsv((await f.text()).replace(/^﻿/, ''))
    : (await readSheet(f)).map(r => r.map(c => c instanceof Date ? c.toISOString() : c))
  const hdr = (grid[0] ?? []).map(h => String(h ?? '').trim().toLowerCase())
  const idx = Object.fromEntries(Object.entries(ROSHI_COLS).map(([h, k]) => [k, hdr.indexOf(h)])) as Record<keyof RoshiRow, number>
  for (const need of ['so_number', 'customer', 'sku_name', 'status', 'units'] as const)
    if (idx[need] < 0) throw new Error(`This doesn't look like a Roshi sales order export (no "${Object.keys(ROSHI_COLS).find(h => ROSHI_COLS[h] === need)}" column)`)
  const seen = new Map<string, number>()
  return grid.slice(1).map(r => {
    const get = (k: keyof RoshiRow) => idx[k] >= 0 && r[idx[k]] != null && String(r[idx[k]]).trim() !== '' ? String(r[idx[k]]).trim() : null
    const so = get('so_number') ?? '', sku = get('sku_name') ?? ''
    const key = `${so}|${get('sku_id') ?? sku}`; const n = (seen.get(key) ?? 0) + 1; seen.set(key, n)
    return {
      line_id: get('line_id') ?? `${key}|${n}`, so_number: so, customer: get('customer') ?? '', sku_name: sku, sku_id: get('sku_id'),
      status: get('status') ?? '', gross: get('gross') != null ? Number(String(get('gross')).replace(/[$,]/g, '')) : null,
      units: get('units') != null ? Number(String(get('units')).replace(/,/g, '')) : null,
      order_date: get('order_date'), shipped_date: get('shipped_date'), package_tag: get('package_tag'),
    }
  }).filter(r => /FL26/.test(r.sku_name) && /fresh frozen/i.test(r.sku_name) && r.so_number)
}

export function ReservesView({ backend, customers, strains, onHand, flash, role, initialMode }: {
  backend: Backend; customers: Customer[]; strains: Strain[]; onHand: Map<string, number>
  flash: (t: string, bad?: boolean) => void; role: Role; initialMode?: 'requests'
}) {
  const isAdmin = role === 'admin'
  const [reqs, setReqs] = useState<ReserveRequest[]>([])
  const [nums, setNums] = useState<MenuNumbers[]>([])
  const [decideNote, setDecideNote] = useState<Record<number, string>>({})
  const [bal, setBal] = useState<Balance[] | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<'customer' | 'strain' | 'orders' | 'requests'>(initialMode ?? 'customer')
  const [open, setOpen] = useState<number | null>(null)
  const [edit, setEdit] = useState<{ customer_id: number | null; strain: string; lbs: string; isNew: boolean } | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const load = () => Promise.all([backend.listBalances(), backend.listOrders().catch(() => [] as Order[]),
      backend.listRequests().catch(() => [] as ReserveRequest[]), backend.menuNumbers().catch(() => [] as MenuNumbers[])])
    .then(([b, o, r, m]) => { setBal(b); setOrders(o); setReqs(r); setNums(m); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])

  const cust = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])
  const cname = (id: number) => cust.get(id)?.name ?? `#${id}`
  const onHandOf = (s: string) => onHand.get(s.toLowerCase()) ?? 0
  const pendingByStrain = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of orders) if (o.status === 'pending') for (const l of o.order_lines) m.set(l.strain.toLowerCase(), (m.get(l.strain.toLowerCase()) ?? 0) + Number(l.lbs))
    return m
  }, [orders])

  if (err) return <div className="list"><h2>Reserves</h2><div className="warnbox">Reserves or orders aren't set up in the database yet. Run 009_reserves.sql and 010_orders.sql in Supabase, then refresh. ({err})</div></div>
  if (!bal) return <div className="list"><h2>Reserves</h2><p className="muted">Loading…</p></div>

  const ql = q.toLowerCase()
  const sum = (rs: Balance[], k: 'reserved' | 'shipped' | 'pending' | 'remaining') => rs.reduce((a, r) => a + Number(r[k]), 0)
  const byCust = [...bal.reduce((m, r) => m.set(r.customer_id, [...(m.get(r.customer_id) ?? []), r]), new Map<number, Balance[]>())]
    .map(([id, rs]) => ({ id, name: cname(id), rs }))
    .filter(c => !ql || c.name.toLowerCase().includes(ql) || c.rs.some(r => r.strain.toLowerCase().includes(ql)))
    .sort((a, b) => sum(b.rs, 'reserved') - sum(a.rs, 'reserved'))
  // numbers come from the database (same math as the customer menu); fall back to local math before 011 is run
  const byStrain = (nums.length ? nums.map(m => ({ s: m.strain, rs: bal.filter(r => r.strain.toLowerCase() === m.strain.toLowerCase()),
      left: Number(m.reserved_left), have: Number(m.on_hand), pend: Number(m.pending), held: Number(m.held), free: Number(m.free) }))
    : [...new Set([...bal.map(r => r.strain), ...[...onHand.keys()].map(k => strains.find(s => s.name.toLowerCase() === k)?.name ?? k)])].map(s => {
      const rs = bal.filter(r => r.strain.toLowerCase() === s.toLowerCase())
      const left = sum(rs, 'remaining'), have = onHandOf(s), pend = pendingByStrain.get(s.toLowerCase()) ?? 0
      return { s, rs, left, have, pend, held: 0, free: have - pend - left }
    })).filter(x => (x.have > 0 || x.left > 0) && (!ql || x.s.toLowerCase().includes(ql) || x.rs.some(r => cname(r.customer_id).toLowerCase().includes(ql))))
    .sort((a, b) => a.s.localeCompare(b.s))
  const shownOrders = orders.filter(o => !ql || cname(o.customer_id).toLowerCase().includes(ql) || (o.so_number ?? '').toLowerCase().includes(ql) || o.order_lines.some(l => l.strain.toLowerCase().includes(ql)))

  async function save() {
    if (!edit || edit.customer_id == null) return
    const lbs = Number(edit.lbs)
    try { await backend.setReserve(edit.customer_id, edit.strain, lbs); await load(); setOpen(edit.customer_id); setEdit(null); flash(lbs === 0 ? 'Reserve removed' : 'Reserve saved') }
    catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  async function decide(id: number, approve: boolean) {
    setBusy(true)
    try { await backend.decideRequest(id, approve, decideNote[id] ?? ''); await load(); flash(approve ? 'Approved. Reserve updated.' : 'Declined') }
    catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  async function importFile(f: File) {
    setBusy(true); setResult(null)
    try {
      const rows = await readRoshi(f)
      if (!rows.length) throw new Error('No 2026 fresh frozen lines found in that file')
      const res = await backend.importRoshi(rows); setResult(res); await load(); setMode('orders')
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }

  return (
    <div className="list reserves">
      <h2>Reserves <span className="muted">{n0(sum(bal, 'remaining'))} lbs left of {n0(sum(bal, 'reserved'))}</span></h2>
      <div className="seg tabs">
        <button className={mode === 'customer' ? 'on' : ''} onClick={() => setMode('customer')}>By customer</button>
        <button className={mode === 'strain' ? 'on' : ''} onClick={() => setMode('strain')}>By strain</button>
        <button className={mode === 'orders' ? 'on' : ''} onClick={() => setMode('orders')}>Orders <span className="muted">{orders.length}</span></button>
        <button className={mode === 'requests' ? 'on' : ''} onClick={() => setMode('requests')}>Requests {reqs.some(r => r.status === 'pending') ? <span className="badge warn">{reqs.filter(r => r.status === 'pending').length}</span> : <span className="muted">0</span>}</button>
      </div>
      <div className="row toolbar">
        <input className="search" type="search" placeholder="Search customer, strain or SO #" value={q} onChange={e => setQ(e.target.value)} />
        {mode === 'orders'
          ? <label className={`primary filebtn ${busy ? 'disabled' : ''}`}>{busy ? 'Importing…' : 'Import Roshi orders'}
              <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f) }} /></label>
          : isAdmin && mode !== 'requests' && <button className="primary" onClick={() => setEdit({ customer_id: null, strain: '', lbs: '', isNew: true })}>+ Add reserve</button>}
      </div>
      {result && (
        <div className="okbox">
          Imported: {result.orders_added} new orders, {result.orders_updated} orders with a new status or date, {result.lines_added} new lines, {result.lines_updated} changed lines.
          {result.new_customers.length > 0 && <> New customers added: {result.new_customers.join(', ')}.</>}
          {result.new_strains.length > 0 && <> New strains added: {result.new_strains.join(', ')}.</>}
          <a onClick={() => setResult(null)}> Dismiss</a>
        </div>
      )}

      {mode === 'customer' && byCust.map(c => (
        <div key={c.id} className="rescard">
          <button className="li setrow" onClick={() => setOpen(open === c.id ? null : c.id)}>
            <div className="grow"><b>{c.name}</b>
              <div className="muted">{c.rs.length} strain{c.rs.length === 1 ? '' : 's'} · {n0(sum(c.rs, 'shipped'))} shipped{sum(c.rs, 'pending') > 0 ? ` · ${n0(sum(c.rs, 'pending'))} pending` : ''}</div></div>
            <div className="num"><b>{n0(sum(c.rs, 'remaining'))}</b><div className="muted">of {n0(sum(c.rs, 'reserved'))} left</div></div>
          </button>
          {open === c.id && (
            <table className="restable">
              <thead><tr><th>Strain</th><th className="num">Reserved</th><th className="num">Shipped</th><th className="num">Pending</th><th className="num">Left</th></tr></thead>
              <tbody>
                {c.rs.map(r => (
                  <tr key={r.id} className={isAdmin ? 'tap' : ''} onClick={() => isAdmin && setEdit({ customer_id: c.id, strain: r.strain, lbs: String(r.reserved), isNew: false })}>
                    <td>{r.strain}</td><td className="num">{n0(Number(r.reserved))}</td><td className="num">{n0(Number(r.shipped))}</td>
                    <td className="num">{n0(Number(r.pending))}</td><td className="num"><b>{n0(Number(r.remaining))}</b></td>
                  </tr>
                ))}
              </tbody>
              {isAdmin && <tfoot><tr><td colSpan={5}><span className="muted">Tap a strain to change it. </span><button className="ghost small" onClick={() => setEdit({ customer_id: c.id, strain: '', lbs: '', isNew: true })}>+ Add strain for {c.name}</button></td></tr></tfoot>}
            </table>
          )}
        </div>
      ))}

      {mode === 'strain' && (
        <>
          <table className="restable wide">
            <thead><tr><th>Strain</th><th className="num">On hand</th><th className="num">Pending</th><th className="num">Res. left</th><th className="num">Free</th></tr></thead>
            <tbody>
              {byStrain.map(x => (
                <tr key={x.s} title={x.rs.map(r => `${cname(r.customer_id)}: ${n0(Number(r.remaining))} left`).join('\n')}>
                  <td>{x.s}{x.rs.length > 0 && <div className="muted small">{x.rs.length} customer{x.rs.length === 1 ? '' : 's'}</div>}</td>
                  <td className="num">{n0(x.have)}</td><td className="num">{n0(x.pend)}</td><td className="num">{n0(x.left)}</td>
                  <td className={`num ${x.free < 0 ? 'warn-t' : ''}`}><b>{n0(x.free)}</b>{x.held > 0 && <div className="muted small">{n0(x.held)} held</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Free = on hand − pending orders − reserves not yet shipped − increases customers have requested (held until approved or declined). Customers see Free rounded down to 10 lbs. On hand is what's in the freezers in this app. Negative means more is promised than is in the freezers.</p>
        </>
      )}

      {mode === 'requests' && (() => {
        const shown = reqs.filter(r => !ql || cname(r.customer_id).toLowerCase().includes(ql) || r.strain.toLowerCase().includes(ql))
        const open_ = shown.filter(r => r.status === 'pending'), done = shown.filter(r => r.status !== 'pending').slice(0, 60)
        const card = (r: ReserveRequest) => {
          const d = Number(r.requested_lbs) - Number(r.current_lbs)
          const m = nums.find(x => x.strain.toLowerCase() === r.strain.toLowerCase())
          return (
            <div key={r.id} className={`li reqcard ${r.status}`}>
              <div className="grow">
                <div><b>{cname(r.customer_id)}</b> · {r.strain} <span className={`pill r-${r.status}`}>{r.status}</span></div>
                <div>{n0(Number(r.current_lbs))} → <b>{n0(Number(r.requested_lbs))} lbs</b> <span className={d > 0 ? 'up' : 'down'}>({d > 0 ? '+' : ''}{n0(d)})</span></div>
                <div className="muted">{r.requested_by} · {new Date(r.requested_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{r.note && <> · "{r.note}"</>}</div>
                {r.status === 'pending' && m && <div className="muted">Free now {n0(Number(m.free))} lbs (this request already held)</div>}
                {r.status !== 'pending' && r.decided_by && <div className="muted">{r.status} by {r.decided_by}{r.decision_note && <> · "{r.decision_note}"</>}</div>}
                {r.status === 'pending' && isAdmin && (
                  <div className="row reqact">
                    <input placeholder="Note (optional)" value={decideNote[r.id] ?? ''} onChange={e => setDecideNote({ ...decideNote, [r.id]: e.target.value })} />
                    <button className="ghost small" disabled={busy} onClick={() => decide(r.id, false)}>Decline</button>
                    <button className="primary small" disabled={busy} onClick={() => decide(r.id, true)}>Approve</button>
                  </div>
                )}
              </div>
            </div>
          )
        }
        return (
          <>
            {!isAdmin && <p className="muted">Only an Admin can approve reserve changes.</p>}
            {open_.length === 0 && <p className="muted">No requests waiting.</p>}
            {open_.map(card)}
            {done.length > 0 && <><h3 className="grouph">Decided</h3>{done.map(card)}</>}
          </>
        )
      })()}

      {mode === 'orders' && (
        <>
          {shownOrders.length === 0 && <p className="muted">No orders yet. Export sales orders from Roshi and import the file here.</p>}
          {shownOrders.map(o => (
            <div key={o.id} className="rescard">
              <button className="li setrow" onClick={() => setOpen(open === -o.id ? null : -o.id)}>
                <div className="grow"><b>{o.so_number ?? `Order ${o.id}`}</b> <span className={`pill o-${o.status}`}>{STATUS_LABEL[o.status]}</span>
                  <div className="muted">{cname(o.customer_id)} · {fmtDate(o.order_date)}{o.roshi_status && o.roshi_status !== 'Fulfilled' ? ` · Roshi: ${o.roshi_status}` : ''}</div></div>
                <b className="num">{n0(orderLbs(o))} lbs</b>
              </button>
              {open === -o.id && (
                <table className="restable">
                  <thead><tr><th>Strain</th><th className="num">Lbs</th><th className="num">$/lb</th></tr></thead>
                  <tbody>{o.order_lines.map(l => <tr key={l.id}><td>{l.strain}{l.farm && <span className="muted"> · {l.farm}</span>}</td><td className="num">{n0(Number(l.lbs))}</td><td className="num">{l.price_per_lb != null ? `$${Number(l.price_per_lb).toFixed(2)}` : ''}</td></tr>)}</tbody>
                </table>
              )}
            </div>
          ))}
          <p className="muted">Import the Roshi sales order export (the same one the menu engine uses) any time. New orders are added and existing ones are updated. Only 2026 fresh frozen lines are used.</p>
        </>
      )}
      {bal.length === 0 && mode !== 'orders' && <p className="muted">No reserves yet.</p>}

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
            <div className="field"><label>Reserved lbs <span className="muted">(the full amount, including what's already shipped)</span></label>
              <input type="number" min="0" step="10" value={edit.lbs} onChange={e => setEdit({ ...edit, lbs: e.target.value })} autoFocus={!edit.isNew} />
              {edit.strain && <span className="muted">{n0(onHandOf(edit.strain))} lbs on hand</span>}</div>
            <div className="row between">
              {!edit.isNew ? <button className="ghost" onClick={() => setEdit({ ...edit, lbs: '0' })}>Set to 0 (remove)</button> : <span />}
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

// read-only lists for the customer portal
export function MyReserves({ backend }: { backend: Backend }) {
  const [rows, setRows] = useState<Balance[] | null>(null)
  useEffect(() => { backend.listBalances().then(setRows).catch(() => setRows([])) }, [])
  if (!rows) return <p className="muted">Loading…</p>
  if (!rows.length) return <p className="muted">No reserves on file yet.</p>
  const t = (k: 'reserved' | 'shipped' | 'pending' | 'remaining') => rows.reduce((a, r) => a + Number(r[k]), 0)
  return (
    <table className="restable">
      <thead><tr><th>Strain</th><th className="num">Reserved</th><th className="num">Shipped</th><th className="num">Pending</th><th className="num">Left</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td>{r.strain}</td><td className="num">{n0(Number(r.reserved))}</td><td className="num">{n0(Number(r.shipped))}</td><td className="num">{n0(Number(r.pending))}</td><td className="num"><b>{n0(Number(r.remaining))}</b></td></tr>)}</tbody>
      <tfoot><tr><td><b>Total lbs</b></td><td className="num">{n0(t('reserved'))}</td><td className="num">{n0(t('shipped'))}</td><td className="num">{n0(t('pending'))}</td><td className="num"><b>{n0(t('remaining'))}</b></td></tr></tfoot>
    </table>
  )
}

export function MyOrders({ backend }: { backend: Backend }) {
  const [rows, setRows] = useState<Order[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { backend.listOrders().then(setRows).catch(() => setRows([])) }, [])
  if (!rows) return <p className="muted">Loading…</p>
  if (!rows.length) return <p className="muted">No orders yet.</p>
  return (
    <>
      {rows.map(o => (
        <div key={o.id} className="rescard">
          <button className="li setrow" onClick={() => setOpen(open === o.id ? null : o.id)}>
            <div className="grow"><b>{o.so_number ?? `Order ${o.id}`}</b> <span className={`pill o-${o.status}`}>{STATUS_LABEL[o.status]}</span>
              <div className="muted">{fmtDate(o.order_date)}{o.shipped_date && o.status === 'shipped' ? ` · shipped ${fmtDate(o.shipped_date)}` : ''}</div></div>
            <b className="num">{n0(orderLbs(o))} lbs</b>
          </button>
          {open === o.id && (
            <table className="restable">
              <thead><tr><th>Strain</th><th className="num">Lbs</th><th className="num">$/lb</th></tr></thead>
              <tbody>{o.order_lines.map(l => <tr key={l.id}><td>{l.strain}</td><td className="num">{n0(Number(l.lbs))}</td><td className="num">{l.price_per_lb != null ? `$${Number(l.price_per_lb).toFixed(2)}` : ''}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      ))}
    </>
  )
}
