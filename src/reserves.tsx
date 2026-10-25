import { SampleHolds, SampleSheet } from './samples'
import { CustomerDashboard } from './statement'
import { StrainLink } from './strainCard'
import { useBack } from './nav'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PRODUCT_LABEL } from './types'
import type { Backend } from './api'
import { readSheet } from 'read-excel-file/browser'
import { parseCsv } from './settings'
import { OpenMenu } from './menu'
import { CatalogButton } from './catalog'
import { RequestsPanel } from './requests'
import { STATE_LABEL } from './fulfill'
import type { FOrder, MenuNumbers, ReserveRequest, ReserveYears, Balance, Customer, ImportResult, Order, RoshiRow, Strain } from './types'

const n0 = (x: number) => Math.round(x).toLocaleString()

const STATUS_LABEL: Record<string, string> = { shipped: 'Shipped', pending: 'Confirmed', submitted: 'Submitted', draft: 'Draft', cancelled: 'Cancelled' }
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
  }).filter(r => /FL2[56]/.test(r.sku_name) && /fresh frozen/i.test(r.sku_name) && r.so_number)
}

export type SalesMode = 'customer' | 'strain' | 'orders' | 'requests' | 'menu'
export const SALES_TITLES: Record<SalesMode, string> = { menu: 'Open menu', orders: 'Orders', requests: 'Requests', customer: 'Reserves by customer', strain: 'Reserves by strain' }

/** Sales screens. The Sales module menu picks the screen (mode); isAdmin = Sales Admin (approvals, reserves, deadlines). */
export function ReservesView({ backend, customers, strains, onHand, flash, isAdmin, mode, onCounts, fulfil, onFulfil, onNewOrder, onDoc, onInvoice }: {
  backend: Backend; customers: Customer[]; strains: Strain[]; onHand: Map<string, number>
  flash: (t: string, bad?: boolean) => void; isAdmin: boolean; mode: SalesMode; onCounts?: () => void
  fulfil?: Map<number, FOrder>; onFulfil?: () => Promise<void>
  onNewOrder?: () => void; onDoc?: (kind: 'invoice' | 'so', id: number) => void; onInvoice?: (orderId: number) => void
}) {
  const [reqs, setReqs] = useState<ReserveRequest[]>([])
  const [nums, setNums] = useState<MenuNumbers[]>([])
  const [year, setYear] = useState<number | null>(null)
  const [bal, setBal] = useState<Balance[] | null>(null)
  const [ys, setYs] = useState<ReserveYears | null>(null)
  const [ry, setRy] = useState<number | null>(null)   // which crop's reserves
  useEffect(() => { backend.reserveYears().then(setYs).catch(() => {}) }, [])
  const [orders, setOrders] = useState<Order[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [edit, setEdit] = useState<{ customer_id: number | null; strain: string; lbs: string; isNew: boolean } | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [sampleOf, setSampleOf] = useState<Order | null>(null)
  const [holdRev, setHoldRev] = useState(0)
  const load = () => Promise.all([backend.listBalances(), backend.listOrders().catch(() => [] as Order[]),
      backend.listRequests().catch(() => [] as ReserveRequest[]), backend.menuNumbers().catch(() => [] as MenuNumbers[])])
    .then(([b, o, r, m]) => {
      setBal(b); setOrders(o); setReqs(r); setNums(m); setErr(null); onCounts?.()
    }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])
  // By customer: one customer at a time, with a Back button (and the phone's Back) to the full list
  const listY = useRef(0)
  const openCust = (id: number) => { listY.current = window.scrollY; setOpen(id); window.scrollTo(0, 0) }
  const closeCust = () => { setOpen(null); requestAnimationFrame(() => window.scrollTo(0, listY.current)) }
  useBack(mode === 'customer' && open != null && open > 0, closeCust)
  useEffect(() => { setOpen(null) }, [mode])

  const cust = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])
  const cname = (id: number) => cust.get(id)?.name ?? `#${id}`
  const onHandOf = (s: string) => onHand.get(s.toLowerCase()) ?? 0
  const pendingByStrain = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of orders) if (o.status === 'pending') for (const l of o.order_lines) if ((l.product ?? 'fresh_frozen') === 'fresh_frozen') m.set(l.strain.toLowerCase(), (m.get(l.strain.toLowerCase()) ?? 0) + Number(l.lbs))
    return m
  }, [orders])

  if (err) return <div className="list"><h2>Reserves</h2><div className="warnbox">Reserves or orders aren't set up in the database yet. Run 009_reserves.sql and 010_orders.sql in Supabase, then refresh. ({err})</div></div>
  if (!bal) return <div className="list"><h2>Reserves</h2><p className="muted">Loading…</p></div>
  const cur = ys?.current ?? new Date().getFullYear()
  const rYear = ry ?? cur
  const future = rYear > cur
  const menuYears = [...new Set(nums.map(m => m.crop_year))].sort((a, b) => b - a)
  const yrSel = mode === 'strain' && !future ? (year ?? menuYears[0] ?? cur) : rYear
  const dl = ys?.years.find(y => y.year === rYear)?.deadline ?? null
  const allBal = bal
  const yearsWith = [...new Set([cur, ...(ys?.years ?? []).map(y => y.year), ...allBal.map(r => r.crop_year ?? cur), ...(mode === 'strain' ? menuYears : [])])].sort((a, b) => a - b)
  const balY = allBal.filter(r => (r.crop_year ?? cur) === rYear)

  const ql = q.toLowerCase()
  const sum = (rs: Balance[], k: 'reserved' | 'shipped' | 'pending' | 'remaining') => rs.reduce((a, r) => a + Number(r[k]), 0)
  const byCust = [...balY.reduce((m, r) => m.set(r.customer_id, [...(m.get(r.customer_id) ?? []), r]), new Map<number, Balance[]>())]
    .map(([id, rs]) => ({ id, name: cname(id), rs }))
    .filter(c => !ql || c.name.toLowerCase().includes(ql) || c.rs.some(r => r.strain.toLowerCase().includes(ql)))
    .sort((a, b) => sum(b.rs, 'reserved') - sum(a.rs, 'reserved'))
  const focus = mode === 'customer' && open != null && open > 0 ? [...balY.reduce((m, r) => m.set(r.customer_id, [...(m.get(r.customer_id) ?? []), r]), new Map<number, Balance[]>())].map(([id, rs]) => ({ id, name: cname(id), rs })).find(c => c.id === open) : undefined
  // numbers come from the database (same math as the customer menu); fall back to local math before 011 is run
  const years = [...new Set(nums.map(m => m.crop_year))].sort((a, b) => b - a)
  const yr = year ?? years[0]
  const byStrain = (nums.length ? nums.filter(m => m.crop_year === yr).map(m => ({ s: m.strain, rs: balY.filter(r => r.strain.toLowerCase() === m.strain.toLowerCase()),
      left: Number(m.reserved_left), have: Number(m.on_hand), pend: Number(m.pending), held: Number(m.held), free: Number(m.free), hidden: !m.on_menu }))
    : [...new Set([...balY.map(r => r.strain), ...[...onHand.keys()].map(k => strains.find(s => s.name.toLowerCase() === k)?.name ?? k)])].map(s => {
      const rs = balY.filter(r => r.strain.toLowerCase() === s.toLowerCase())
      const left = sum(rs, 'remaining'), have = onHandOf(s), pend = pendingByStrain.get(s.toLowerCase()) ?? 0
      return { s, rs, left, have, pend, held: 0, free: have - pend - left, hidden: false }
    })).filter(x => (x.have > 0 || x.left > 0) && (!ql || x.s.toLowerCase().includes(ql) || x.rs.some(r => cname(r.customer_id).toLowerCase().includes(ql))))
    .sort((a, b) => a.s.localeCompare(b.s))
  const shownOrders = [...orders].sort((a, b) => Number(b.status === 'submitted') - Number(a.status === 'submitted')).filter(o => !ql || cname(o.customer_id).toLowerCase().includes(ql) || (o.so_number ?? '').toLowerCase().includes(ql) || o.order_lines.some(l => l.strain.toLowerCase().includes(ql)))

  async function save() {
    if (!edit || edit.customer_id == null) return
    const lbs = Number(edit.lbs)
    try { await backend.setReserve(edit.customer_id, edit.strain, lbs, undefined, rYear !== cur ? rYear : undefined); await load(); setOpen(edit.customer_id); setEdit(null); flash(lbs === 0 ? 'Reserve removed' : 'Reserve saved') }
    catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  async function copyMenu() {
    try {
      const rows = (await backend.openMenu()).filter(r => Number(r.available) > 0)
      const years = [...new Set(rows.map(r => r.crop_year))].sort((a, b) => b - a)
      const text = years.map(y => `${y} crop, fresh frozen (lbs open)\n` + rows.filter(r => r.crop_year === y).map(r => `${r.strain}: ${n0(Number(r.available))}`).join('\n')).join('\n\n')
      await navigator.clipboard.writeText(text); flash('Menu copied')
    } catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  async function importFile(f: File) {
    setBusy(true); setResult(null)
    try {
      const rows = await readRoshi(f)
      if (!rows.length) throw new Error('No 2026 fresh frozen lines found in that file')
      const res = await backend.importRoshi(rows); setResult(res); await load()
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }

  return (
    <div className="list reserves">
      <h2>{SALES_TITLES[mode]} {(mode === 'customer' || mode === 'strain') && <span className="muted">{cur} reserves: {n0(sum(allBal.filter(r => (r.crop_year ?? cur) === cur), 'remaining'))} lbs left of {n0(sum(allBal.filter(r => (r.crop_year ?? cur) === cur), 'reserved'))}</span>}</h2>
      <div className="row toolbar">
        <input className="search" type="search" placeholder="Search customer, strain or SO #" value={q} onChange={e => setQ(e.target.value)} />
        {mode === 'orders'
          ? <>{onNewOrder && <button className="primary" onClick={onNewOrder}>+ New order</button>}
            <label className={`ghost filebtn ${busy ? 'disabled' : ''}`}>{busy ? 'Importing…' : 'Import Roshi orders'}
              <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f) }} /></label></>
          : isAdmin && mode !== 'requests' && mode !== 'menu' && <button className="primary" onClick={() => setEdit({ customer_id: null, strain: '', lbs: '', isNew: true })}>+ Add reserve</button>}
      </div>
      {result && (
        <div className="okbox">
          Imported: {result.orders_added} new orders, {result.orders_updated} orders with a new status or date, {result.lines_added} new lines, {result.lines_updated} changed lines.
          {result.new_customers.length > 0 && <> New customers added: {result.new_customers.join(', ')}.</>}
          {result.new_strains.length > 0 && <> New strains added: {result.new_strains.join(', ')}.</>}
          <a onClick={() => setResult(null)}> Dismiss</a>
        </div>
      )}

      {(mode === 'customer' || mode === 'strain') && yearsWith.length > 1 && (
        <div className="row yearpick">
          <div className="seg yearseg">{yearsWith.map(y => <button key={y} className={y === yrSel ? 'on' : ''} onClick={() => { setRy(y); if (y <= cur) setYear(y) }}>{y} crop</button>)}</div>
          {future && <span className="muted">{dl ? `Customers can request ${rYear} reserves until ${new Date(dl + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}.` : `${rYear} requests are closed.`}</span>}
          {future && isAdmin && <DeadlineEdit year={rYear} value={dl} onSave={async v => { try { await backend.setReserveDeadline(rYear, v); setYs(await backend.reserveYears()); flash('Deadline saved') } catch (e) { flash(String((e as Error).message ?? e), true) } }} />}
        </div>
      )}
      {mode === 'customer' && !focus && byCust.length === 0 && <p className="muted">No {rYear} reserves yet.</p>}
      {mode === 'customer' && focus && (() => {
        const c = focus
        const cOrders = orders.filter(o => o.customer_id === c.id && o.status !== 'cancelled').sort((a, b) => (b.order_date ?? '').localeCompare(a.order_date ?? ''))
        const cReqs = reqs.filter(r => r.customer_id === c.id && r.status === 'pending')
        return (
          <div className="custfocus">
            <button className="ghost backbtn" onClick={closeCust}>‹ All customers</button>
            <div className="rescard">
              <div className="li setrow static">
                <div className="grow"><b>{c.name}</b>
                  <div className="muted">{c.rs.length} strain{c.rs.length === 1 ? '' : 's'} · {n0(sum(c.rs, 'shipped'))} shipped{sum(c.rs, 'pending') > 0 ? ` · ${n0(sum(c.rs, 'pending'))} pending` : ''}</div></div>
                <div className="num"><b>{n0(sum(c.rs, 'remaining'))}</b><div className="muted">of {n0(sum(c.rs, 'reserved'))} left</div></div>
              </div>
              <table className="restable">
                <thead><tr><th>Strain</th><th className="num">Reserved</th><th className="num">Shipped</th><th className="num">Pending</th><th className="num">Left</th></tr></thead>
                <tbody>
                  {c.rs.map(r => (
                    <tr key={r.id} className={isAdmin ? 'tap' : ''} onClick={() => isAdmin && setEdit({ customer_id: c.id, strain: r.strain, lbs: String(r.reserved), isNew: false })}>
                      <td><StrainLink name={r.strain} /></td><td className="num">{n0(Number(r.reserved))}</td><td className="num">{n0(Number(r.shipped))}</td>
                      <td className="num">{n0(Number(r.pending))}</td><td className="num"><b>{n0(Number(r.remaining))}</b></td>
                    </tr>
                  ))}
                </tbody>
                {isAdmin && <tfoot><tr><td colSpan={5}><span className="muted">Tap a strain to change it. </span><button className="ghost small" onClick={() => setEdit({ customer_id: c.id, strain: '', lbs: '', isNew: true })}>+ Add strain for {c.name}</button></td></tr></tfoot>}
              </table>
            </div>
            <SampleHolds backend={backend} customerId={c.id} staff flash={flash} rev={holdRev} onChanged={load} />
            <h3>Account</h3>
            <CustomerDashboard backend={backend} customerId={c.id} staff />
            {cReqs.length > 0 && <><h3>Reserve requests waiting</h3>
              <table className="restable wide"><thead><tr><th>Strain</th><th className="num">Now</th><th className="num">Asked for</th><th>Crop</th></tr></thead>
                <tbody>{cReqs.map(r => <tr key={r.id}><td>{r.strain}</td><td className="num">{n0(Number(r.current_lbs))}</td><td className="num"><b>{n0(Number(r.requested_lbs))}</b></td><td>{r.crop_year ?? cur}</td></tr>)}</tbody></table></>}
            <h3>Orders</h3>
            {cOrders.length === 0 ? <p className="muted">No orders yet.</p> : (
              <table className="restable wide"><thead><tr><th>Order</th><th>Date</th><th>Status</th><th className="num">Lbs</th></tr></thead>
                <tbody>{cOrders.slice(0, 25).map(o => <tr key={o.id}><td>{o.so_number ?? `#${o.id}`}</td><td>{fmtDate(o.order_date)}</td>
                  <td><span className={`pill o-${o.status}`}>{STATUS_LABEL[o.status]}</span></td><td className="num">{n0(orderLbs(o))}</td></tr>)}</tbody></table>)}
            <button className="ghost backbtn" onClick={closeCust}>‹ All customers</button>
          </div>
        )
      })()}
      {mode === 'customer' && !focus && byCust.map(c => (
        <div key={c.id} className="rescard">
          <button className="li setrow" onClick={() => openCust(c.id)}>
            <div className="grow"><b>{c.name}</b>
              <div className="muted">{c.rs.length} strain{c.rs.length === 1 ? '' : 's'} · {n0(sum(c.rs, 'shipped'))} shipped{sum(c.rs, 'pending') > 0 ? ` · ${n0(sum(c.rs, 'pending'))} pending` : ''}</div></div>
            <div className="num"><b>{n0(sum(c.rs, 'remaining'))}</b><div className="muted">of {n0(sum(c.rs, 'reserved'))} left ›</div></div>
          </button>
        </div>
      ))}

      {mode === 'strain' && future && (() => {
        const tot = [...balY.reduce((m, r) => m.set(r.strain, [...(m.get(r.strain) ?? []), r]), new Map<string, Balance[]>())].sort((a, b) => a[0].localeCompare(b[0]))
        const pend = reqs.filter(r => r.status === 'pending' && r.crop_year === rYear)
        return (
          <table className="restable wide">
            <thead><tr><th>Strain</th><th className="num">Customers</th><th className="num">Reserved</th><th className="num">Requested (waiting)</th></tr></thead>
            <tbody>{tot.map(([st, rs]) => <tr key={st}><td>{st}</td><td className="num">{rs.length}</td><td className="num"><b>{n0(sum(rs, 'reserved'))}</b></td>
              <td className="num">{n0(pend.filter(q => q.strain.toLowerCase() === st.toLowerCase()).reduce((a, q) => a + Number(q.requested_lbs) - Number(q.current_lbs), 0)) || ''}</td></tr>)}
            {!tot.length && <tr><td colSpan={4} className="muted">No {rYear} reserves yet.</td></tr>}</tbody>
          </table>
        )
      })()}
      {mode === 'strain' && !future && (
        <>
                    <table className="restable wide">
            <thead><tr><th>Strain</th><th className="num">On hand</th><th className="num">Pending</th><th className="num">Res. left</th><th className="num">Free</th></tr></thead>
            <tbody>
              {byStrain.map(x => (
                <tr key={x.s} title={x.rs.map(r => `${cname(r.customer_id)}: ${n0(Number(r.remaining))} left`).join('\n')}>
                  <td><StrainLink name={x.s} />{x.hidden && <span className="pill old">hidden</span>}{x.rs.length > 0 && <div className="muted small">{x.rs.length} customer{x.rs.length === 1 ? '' : 's'}</div>}</td>
                  <td className="num">{n0(x.have)}</td><td className="num">{n0(x.pend)}</td><td className="num">{n0(x.left)}</td>
                  <td className={`num ${x.free < 0 ? 'warn-t' : ''}`}><b>{n0(x.free)}</b>{x.held > 0 && <div className="muted small">{n0(x.held)} held</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Free = on hand − pending orders − reserves not yet shipped − increases customers have requested (held until approved or declined) − sample holds. Customers see Free rounded down to 10 lbs. On hand is what's in the freezers in this app. Negative means more is promised than is in the freezers.</p>
        </>
      )}

      {mode === 'menu' && <>
        <p className="muted">Exactly what customers see on the portal: open lbs rounded down to 10, hidden strains left out. <a onClick={copyMenu}>Copy as text</a></p>
        <div className="row toolbar"><CatalogButton backend={backend} flash={flash} /></div>
        <OpenMenu backend={backend} reserves={false} />
      </>}

      {mode === 'requests' && <SampleHolds backend={backend} staff showCustomer flash={flash} rev={holdRev} onChanged={load} />}
      {mode === 'requests' && <RequestsPanel backend={backend} reqs={reqs.filter(r => !ql || cname(r.customer_id).toLowerCase().includes(ql) || r.strain.toLowerCase().includes(ql))}
        nums={nums} cname={cname} cur={cur} isAdmin={isAdmin} flash={flash} onDone={load} />}

      {mode === 'orders' && (
        <>
          {shownOrders.length === 0 && <p className="muted">No orders yet. Export sales orders from Roshi and import the file here.</p>}
          {shownOrders.map(o => (
            <div key={o.id} className="rescard">
              <button className="li setrow" onClick={() => setOpen(open === -o.id ? null : -o.id)}>
                <div className="grow"><b>{o.so_number ?? `Order #${o.id}`}</b> <span className={`pill o-${o.status}`}>{STATUS_LABEL[o.status]}</span>{o.is_sample && <span className="pill sample">Sample</span>}
                  {o.status === 'pending' && fulfil?.get(o.id) && <span className={`pill fs-${fulfil.get(o.id)!.state}`}>{STATE_LABEL[fulfil.get(o.id)!.state]}{fulfil.get(o.id)!.stop ? ` · ${fulfil.get(o.id)!.stop!.load}` : ''}</span>}
                  <div className="muted">{cname(o.customer_id)} · {fmtDate(o.order_date)}{o.source === 'portal' ? ' · from portal' : ''}{o.roshi_status && o.roshi_status !== 'Fulfilled' ? ` · Roshi: ${o.roshi_status}` : ''}</div></div>
                <b className="num">{n0(orderLbs(o))} lbs</b>
              </button>
              {open === -o.id && fulfil?.get(o.id)?.state === 'needs_ok' && <FillOk f={fulfil.get(o.id)!} backend={backend} flash={flash} onDone={async () => { await load(); await onFulfil?.() }} />}
              {open === -o.id && (o.status === 'pending' || o.status === 'shipped') && onDoc && <div className="row wrap orderdocs">
                <button className="ghost small" onClick={() => onDoc('so', o.id)}>Sales order PDF</button>
                {onInvoice && <button className="ghost small" onClick={() => onInvoice(o.id)}>{o.status === 'shipped' ? 'Invoice' : 'Make invoice now'}</button>}</div>}
              {open === -o.id && o.status !== 'cancelled' && <div className="row wrap orderdocs"><button className="ghost small" onClick={() => setSampleOf(o)}>{o.is_sample ? `Samples: ${o.order_lines.filter(l => l.is_sample).map(l => `${l.strain}${Number(l.hold_lbs ?? 0) > 0 ? ` (holding ${n0(Number(l.hold_lbs))})` : ''}`).join(', ')} · change` : 'Mark sample lines…'}</button></div>}
              {open === -o.id && <OrderEditor backend={backend} o={o} strains={strains} flash={flash} onChanged={load} />}
            </div>
          ))}
          <p className="muted">Import the Roshi sales order export (the same one the menu engine uses) any time. New orders are added and existing ones are updated. Only 2026 fresh frozen lines, plus open 2025 ones, are used.</p>
        </>
      )}


      {sampleOf && <SampleSheet backend={backend} o={sampleOf} days={cust.get(sampleOf.customer_id)?.sample_hold_days ?? null} flash={flash} onClose={() => setSampleOf(null)}
        onDone={async () => { setSampleOf(null); setHoldRev(r => r + 1); await load() }} />}
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

export function DeadlineEdit({ year, value, onSave }: { year: number; value: string | null; onSave: (v: string | null) => Promise<void> }) {
  const [v, setV] = useState(value ?? '')
  const [open, setOpen] = useState(false)
  if (!open) return <a onClick={() => { setV(value ?? ''); setOpen(true) }}>Change deadline</a>
  return (
    <span className="row">
      <input type="date" value={v} onChange={e => setV(e.target.value)} />
      <button className="primary small" onClick={async () => { await onSave(v || null); setOpen(false) }}>Save</button>
      <button className="ghost small" onClick={() => setOpen(false)}>Cancel</button>
      <span className="muted">Blank closes {year} requests.</span>
    </span>
  )
}

// read-only lists for the customer portal
export function MyReserves({ backend, year }: { backend: Backend; year?: number }) {
  const [rows, setRows] = useState<Balance[] | null>(null)
  useEffect(() => { backend.listBalances().then(b => setRows(b.filter(r => !year || r.crop_year == null || r.crop_year === year))).catch(() => setRows([])) }, [year])
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

export function MyOrders({ backend, onChange }: { backend: Backend; onChange?: (msg: string) => void }) {
  const [rows, setRows] = useState<Order[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { backend.listOrders().then(setRows).catch(() => setRows([])) }, [])
  if (!rows) return <p className="muted">Loading…</p>
  if (!rows.length) return <p className="muted">No orders yet.</p>
  const maxYear = Math.max(...rows.flatMap(o => o.order_lines.map(l => l.crop_year ?? 0)))
  return (
    <>
      {rows.map(o => (
        <div key={o.id} className="rescard">
          <button className="li setrow" onClick={() => setOpen(open === o.id ? null : o.id)}>
            <div className="grow"><b>{o.so_number ?? `Order #${o.id}`}</b> <span className={`pill o-${o.status}`}>{STATUS_LABEL[o.status]}</span>{o.is_sample && <span className="pill sample">Sample</span>}
              <div className="muted">{fmtDate(o.order_date)}{o.shipped_date && o.status === 'shipped' ? ` · shipped ${fmtDate(o.shipped_date)}` : ''}</div></div>
            <b className="num">{n0(orderLbs(o))} lbs</b>
          </button>
          {open === o.id && (
            <table className="restable">
              <thead><tr><th>Strain</th><th className="num">Lbs</th><th className="num">$/lb</th></tr></thead>
              <tbody>{o.order_lines.map(l => <tr key={l.id}><td>{l.strain}{l.is_sample && <span className="pill sample">sample{Number(l.hold_lbs ?? 0) > 0 ? ` · holding ${n0(Number(l.hold_lbs))}` : ''}</span>}{l.product && l.product !== 'fresh_frozen' ? <span className="pill prod">{PRODUCT_LABEL[l.product]}</span> : null}{l.crop_year && l.crop_year < maxYear ? <span className="pill old">{l.crop_year} crop</span> : null}</td><td className="num">{n0(Number(l.lbs))}</td><td className="num">{l.price_per_lb != null ? `$${Number(l.price_per_lb).toFixed(2)}` : ''}</td></tr>)}</tbody>
              {(o.po_number || o.notes || o.status === 'submitted') && <tfoot><tr><td colSpan={3}>
                {o.po_number && <div className="muted">PO {o.po_number}</div>}{o.notes && <div className="muted">"{o.notes}"</div>}
                {o.status === 'submitted' && <button className="ghost small" onClick={async () => {
                  try { await backend.cancelMyOrder(o.id); onChange?.(`Order #${o.id} cancelled`) } catch (e) { onChange?.(String((e as Error).message)) }
                }}>Cancel this order</button>}
              </td></tr></tfoot>}
            </table>
          )}
        </div>
      ))}
    </>
  )
}

// staff: confirm / ship / cancel an order, change lbs or price on a line, add a line
function OrderEditor({ backend, o, strains, flash, onChanged }: {
  backend: Backend; o: Order; strains: Strain[]; flash: (t: string, bad?: boolean) => void; onChanged: () => void
}) {
  const [so, setSo] = useState(o.so_number ?? '')
  const [shipOn, setShipOn] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  const [edits, setEdits] = useState<Record<number, { lbs: string; price: string }>>({})
  const [add, setAdd] = useState({ strain: '', lbs: '' })
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<void>, ok: string) => {
    setBusy(true)
    try { await f(); flash(ok); setEdits({}); setAdd({ strain: '', lbs: '' }); onChanged() } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const open_ = o.status === 'submitted' || o.status === 'pending'
  const total = o.order_lines.reduce((a, l) => a + Number(l.lbs) * Number(l.price_per_lb ?? 0), 0)
  return (
    <div className="ordered">
      <table className="restable">
        <thead><tr><th>Strain</th><th className="num">Lbs</th><th className="num">$/lb</th>{open_ && <th />}</tr></thead>
        <tbody>{o.order_lines.map(l => {
          const e = edits[l.id]
          return (
            <tr key={l.id}>
              <td>{l.strain}{l.is_sample && <span className="pill sample">sample{Number(l.hold_lbs ?? 0) > 0 ? ` · holding ${n0(Number(l.hold_lbs))}` : ""}</span>}{l.product && l.product !== 'fresh_frozen' ? <span className="pill prod">{PRODUCT_LABEL[l.product]}</span> : null}<span className="muted">{l.farm ? ` · ${l.farm}` : ''}{l.crop_year ? ` · ${l.crop_year}` : ''}</span>{l.price_override && <div className="muted small">price overridden</div>}</td>
              {e ? <>
                <td className="num"><input className="qty" type="number" step="10" min="0" value={e.lbs} onChange={x => setEdits({ ...edits, [l.id]: { ...e, lbs: x.target.value } })} /></td>
                <td className="num"><input className="qty" type="number" step="0.5" min="0" value={e.price} onChange={x => setEdits({ ...edits, [l.id]: { ...e, price: x.target.value } })} /></td>
                <td className="num"><button className="primary small" disabled={busy} onClick={() => run(() => backend.setOrderLine(o.id, l.id, l.strain, Number(e.lbs), e.price === '' ? null : Number(e.price)), Number(e.lbs) === 0 ? 'Line removed' : 'Line saved')}>Save</button></td>
              </> : <>
                <td className="num">{n0(Number(l.lbs))}</td>
                <td className="num">{l.price_per_lb != null ? `$${Number(l.price_per_lb).toFixed(2)}` : ''}</td>
                {open_ && <td className="num"><button className="ghost small" onClick={() => setEdits({ ...edits, [l.id]: { lbs: String(l.lbs), price: l.price_per_lb != null ? String(l.price_per_lb) : '' } })}>Edit</button></td>}
              </>}
            </tr>
          )
        })}</tbody>
        <tfoot>
          {open_ && <tr><td><input list="order-strains" placeholder="Add a strain" value={add.strain} onChange={e => setAdd({ ...add, strain: e.target.value })} />
            <datalist id="order-strains">{strains.filter(s => s.active).map(s => <option key={s.id} value={s.name} />)}</datalist></td>
            <td className="num"><input className="qty" type="number" step="10" min="0" placeholder="lbs" value={add.lbs} onChange={e => setAdd({ ...add, lbs: e.target.value })} /></td>
            <td className="muted small">customer price</td>
            <td className="num"><button className="ghost small" disabled={busy || !add.strain || !(Number(add.lbs) > 0)} onClick={() => run(() => backend.setOrderLine(o.id, null, add.strain, Number(add.lbs), null), 'Line added')}>Add</button></td></tr>}
          <tr><td colSpan={open_ ? 4 : 3}>
            <div className="muted">{total > 0 && <>Total ${total.toLocaleString(undefined, { maximumFractionDigits: 0 })} · </>}{o.po_number && <>PO {o.po_number} · </>}{o.wanted_date && <>wanted by {fmtDate(o.wanted_date)} · </>}{o.placed_by && <>placed by {o.placed_by}</>}{o.confirmed_by && <> · confirmed by {o.confirmed_by}</>}</div>
            {o.notes && <div className="muted">"{o.notes}"</div>}
          </td></tr>
        </tfoot>
      </table>
      {open_ && (
        <div className="row reqact">
          <input placeholder="Roshi SO # (optional)" value={so} onChange={e => setSo(e.target.value)} />
          {o.status === 'submitted' && <button className="primary small" disabled={busy} onClick={() => run(() => backend.setOrderStatus(o.id, 'pending', so, ''), 'Order confirmed')}>Confirm</button>}
          {o.status === 'pending' && so !== (o.so_number ?? '') && <button className="ghost small" disabled={busy} onClick={() => run(() => backend.setOrderStatus(o.id, 'pending', so, ''), 'SO # saved')}>Save SO #</button>}
          <span className="row"><input type="date" value={shipOn} onChange={e => setShipOn(e.target.value)} aria-label="Shipped on" title="The day it actually shipped" style={{ maxWidth: 150 }} />
            <button className="ghost small" disabled={busy} onClick={() => run(() => backend.setOrderStatus(o.id, 'shipped', so, '', shipOn || null), 'Marked shipped')}>Mark shipped</button></span>
          <button className="ghost small" disabled={busy} onClick={() => run(() => backend.setOrderStatus(o.id, 'cancelled', so, ''), 'Order cancelled')}>Cancel order</button>
        </div>
      )}
    </div>
  )
}

/** Sales OKs what Distribution assigned when it isn't exactly what was ordered */
export function FillOk({ f, backend, flash, onDone }: { f: FOrder; backend: Backend; flash: (t: string, bad?: boolean) => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const diffs = f.lines.map(l => ({ l, got: l.picks.reduce((a, p) => a + Number(p.lbs), 0) })).filter(x => (x.got > 0 || x.l.cant_fill) && x.got !== Number(x.l.lbs))
  return (
    <div className="warnbox fillok">
      <b>Distribution assigned different amounts.</b> OK them and the order lines change to match (and bill from there).
      <table className="restable"><thead><tr><th>Strain</th><th className="num">Ordered</th><th className="num">Assigned</th><th className="num">Diff</th></tr></thead>
        <tbody>{diffs.map(({ l, got }) => <tr key={l.id}><td>{l.strain}</td><td className="num">{n0(Number(l.lbs))}</td><td className="num"><b>{l.cant_fill && !got ? "can't fill" : n0(got)}</b></td>
          <td className={`num ${got > Number(l.lbs) ? 'up' : 'down'}`}>{got > Number(l.lbs) ? '+' : ''}{n0(got - Number(l.lbs))}</td></tr>)}</tbody></table>
      <div className="row"><button className="primary small" disabled={busy} onClick={async () => {
        setBusy(true); try { const n = await backend.approveFill(f.id); await onDone(); flash(`${n} line${n === 1 ? '' : 's'} OK'd`) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) } }}>OK these amounts</button>
        <span className="muted">Or ask Distribution to change the pallets.</span></div>
    </div>
  )
}
