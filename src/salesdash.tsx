import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { Balance, Customer, MenuNumbers, Order, ReserveRequest, ReserveYears } from './types'
import type { SalesMode } from './reserves'
import { DeadlineEdit } from './reserves'
import { Card, Cards, DashHead, Empty, Meter, Tile, Tiles } from './dash'

const n0 = (x: number) => Math.round(x).toLocaleString()
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const money = (x: number) => '$' + Math.round(x).toLocaleString()
const fmt = (s: string | null) => s ? new Date(s + (s.length === 10 ? 'T12:00:00' : '')).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
const daysTo = (s: string) => Math.ceil((new Date(s + 'T23:59:59').getTime() - Date.now()) / 864e5)
interface Data { bal: Balance[]; orders: Order[]; reqs: ReserveRequest[]; nums: MenuNumbers[]; ys: ReserveYears }
const loadAll = (b: Backend) => Promise.all([b.listBalances(), b.listOrders().catch(() => [] as Order[]), b.listRequests().catch(() => [] as ReserveRequest[]),
  b.menuNumbers().catch(() => [] as MenuNumbers[]), b.reserveYears()]).then(([bal, orders, reqs, nums, ys]) => ({ bal, orders, reqs, nums, ys }))

/** Sales Dashboard */
export function SalesDashboard({ backend, customers, isAdmin, go }: { backend: Backend; customers: Customer[]; isAdmin: boolean; go: (m: SalesMode) => void }) {
  const [d, setD] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { loadAll(backend).then(setD).catch(e => setErr(String(e?.message ?? e))) }, [backend])
  if (err) return <div className="list"><div className="warnbox">Couldn't load sales. ({err})</div></div>
  if (!d) return <p className="muted">Loading…</p>
  const cname = (id: number) => customers.find(c => c.id === id)?.name ?? `#${id}`
  const cur = d.ys.current
  const balC = d.bal.filter(r => (r.crop_year ?? cur) === cur)
  const S = (k: 'reserved' | 'shipped' | 'pending' | 'remaining', rs = balC) => rs.reduce((a, r) => a + Number(r[k]), 0)
  const pend = d.reqs.filter(r => r.status === 'pending')
  const toConfirm = d.orders.filter(o => o.status === 'submitted')
  const menu = d.nums.filter(m => m.on_menu && m.crop_year === cur)
  const free = menu.reduce((a, m) => a + Math.max(0, Number(m.free)), 0)
  const next = d.ys.years.filter(y => y.year > cur).sort((a, b) => a.year - b.year)[0]
  const nextBal = next ? d.bal.filter(r => r.crop_year === next.year) : []
  const nextReq = next ? pend.filter(r => r.crop_year === next.year) : []
  const t0 = new Date(), moS = `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, '0')}-01`
  const placed = (o: Order) => o.order_date ?? ((o as Order & { created_at?: string }).created_at ?? '').slice(0, 10)
  const monthOrders = d.orders.filter(o => o.status !== 'cancelled' && o.status !== 'draft' && placed(o) >= moS)
  const lines = (os: Order[]) => os.flatMap(o => o.order_lines)
  const lbsMonth = lines(monthOrders).reduce((a, l) => a + Number(l.lbs), 0)
  const valMonth = lines(monthOrders).reduce((a, l) => a + Number(l.lbs) * Number(l.price_per_lb ?? 0), 0)
  const shippedMonth = lines(d.orders.filter(o => o.status === 'shipped' && (o.shipped_date ?? '') >= moS)).reduce((a, l) => a + Number(l.lbs), 0)
  const cm = new Map<number, { res: number; left: number }>()
  for (const r of balC) { const x = cm.get(r.customer_id) ?? { res: 0, left: 0 }; x.res += Number(r.reserved); x.left += Number(r.remaining); cm.set(r.customer_id, x) }
  const byCust = [...cm].sort((a, b) => b[1].res - a[1].res).slice(0, 8)
  const top = [...menu].sort((a, b) => Number(b.free) - Number(a.free)).slice(0, 6)
  return (
    <div className="dash">
      <DashHead title="Dashboard" sub={`Sales · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`} />
      <Tiles>
        <Tile label="Orders to confirm" value={toConfirm.length} sub={toConfirm.length ? `oldest ${fmt(toConfirm.map(o => o.order_date ?? '').sort()[0] || null)}` : 'all caught up'} tone={toConfirm.length ? 'warn' : 'ok'} onClick={() => go('orders')} />
        <Tile label="Reserve requests" value={pend.length} sub={pend.length ? `${plural(new Set(pend.map(r => r.customer_id)).size, 'customer')} waiting${isAdmin ? '' : ' (Sales Admin approves)'}` : 'none waiting'} tone={pend.length ? 'warn' : 'ok'} onClick={() => go('requests')} />
        <Tile label={`${cur} reserves left`} value={`${n0(S('remaining'))} lbs`} sub={`of ${n0(S('reserved'))} reserved · ${n0(S('shipped'))} shipped`} onClick={() => go('customer')} />
        <Tile label="Open menu" value={`${n0(free)} lbs`} sub={`free to sell across ${menu.filter(m => Number(m.free) > 0).length} strains`} tone="info" onClick={() => go('menu')} />
        <Tile label="This month" value={`${n0(lbsMonth)} lbs`} sub={`${monthOrders.length} orders${valMonth ? ` · ${money(valMonth)}` : ''} · ${n0(shippedMonth)} shipped`} onClick={() => go('orders')} />
        {next && <Tile label={`${next.year} requests`} value={next.deadline ? `${Math.max(0, daysTo(next.deadline))} days` : 'no deadline'} sub={`${next.deadline ? `to ${fmt(next.deadline)} · ` : ''}${n0(nextBal.reduce((a, r) => a + Number(r.reserved), 0))} lbs approved, ${n0(nextReq.reduce((a, r) => a + Number(r.requested_lbs), 0))} asked`}
          tone={next.deadline && daysTo(next.deadline) < 14 ? 'warn' : undefined} onClick={() => go('strain')} />}
      </Tiles>
      <Cards>
        <Card title="Orders to confirm" badge={toConfirm.length} action="Orders" onAction={() => go('orders')}>
          {toConfirm.length ? <div className="dlist">{toConfirm.slice(0, 8).map(o => (
            <button key={o.id} className="drow click" onClick={() => go('orders')}><span><b>{cname(o.customer_id)}</b><span className="muted"> · {o.order_lines.length} lines{o.wanted_date ? ` · wanted ${fmt(o.wanted_date)}` : ''}</span></span>
              <b>{n0(o.order_lines.reduce((a, l) => a + Number(l.lbs), 0))} lbs</b></button>))}</div> : <Empty>No orders waiting.</Empty>}
        </Card>
        <Card title="Reserve requests" badge={pend.length} action="Requests" onAction={() => go('requests')}>
          {pend.length ? <div className="dlist">{[...new Set(pend.map(r => r.customer_id))].map(id => { const rs = pend.filter(r => r.customer_id === id)
            return <button key={id} className="drow click" onClick={() => go('requests')}><span><b>{cname(id)}</b><span className="muted"> · {rs.length} strains · {[...new Set(rs.map(r => r.crop_year ?? cur))].join(', ')} crop</span></span>
              <b>{n0(rs.reduce((a, r) => a + Number(r.requested_lbs) - Number(r.current_lbs), 0))} lbs</b></button> })}</div> : <Empty>No requests waiting.</Empty>}
        </Card>
        <Card title={`${cur} reserves by customer`} action="Reserves" onAction={() => go('customer')}>
          <div className="dlist">{byCust.map(([id, x]) => <Meter key={id} label={cname(id)} right={<>{n0(x.left)} left of {n0(x.res)}</>} value={x.res - x.left} max={x.res} tone="ok" />)}
            {!byCust.length && <Empty>No reserves for {cur}.</Empty>}</div>
        </Card>
        <Card title="Most to sell" action="Open menu" onAction={() => go('menu')}>
          {top.length ? <div className="dlist">{top.map(m => <div key={m.strain} className="drow"><span><b>{m.strain}</b><span className="muted"> · {n0(Number(m.on_hand))} on hand</span></span><b>{n0(Number(m.free))} lbs free</b></div>)}</div> : <Empty>Nothing on the menu.</Empty>}
        </Card>
      </Cards>
    </div>
  )
}

/** Sales > Review: what needs a decision, in one place */
export function SalesReview({ backend, customers, isAdmin, go }: { backend: Backend; customers: Customer[]; isAdmin: boolean; go: (m: SalesMode) => void }) {
  const [d, setD] = useState<Data | null>(null)
  useEffect(() => { loadAll(backend).then(setD).catch(() => {}) }, [backend])
  if (!d) return <p className="muted">Loading…</p>
  const cname = (id: number) => customers.find(c => c.id === id)?.name ?? `#${id}`
  const cur = d.ys.current
  const toConfirm = d.orders.filter(o => o.status === 'submitted')
  const pend = d.reqs.filter(r => r.status === 'pending')
  const over = d.bal.filter(r => (r.crop_year ?? cur) === cur && Number(r.remaining) < 0)
  const short = d.nums.filter(m => m.crop_year === cur && Number(m.free) < 0)
  const none = !toConfirm.length && !pend.length && !over.length && !short.length
  return (
    <div className="list dash">
      <h2>Review</h2>
      {none && <p className="muted">Nothing needs attention in Sales.</p>}
      {toConfirm.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Orders to confirm <span className="side-badge">{toConfirm.length}</span></h3><button className="linkbtn" onClick={() => go('orders')}>Orders ›</button></div>
        <div className="dlist">{toConfirm.map(o => <button key={o.id} className="drow click" onClick={() => go('orders')}><span><b>{cname(o.customer_id)}</b><span className="muted"> · placed {fmt(o.order_date)}</span></span><b>{n0(o.order_lines.reduce((a, l) => a + Number(l.lbs), 0))} lbs</b></button>)}</div></section>}
      {pend.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Reserve requests waiting <span className="side-badge">{pend.length}</span></h3><button className="linkbtn" onClick={() => go('requests')}>Requests ›</button></div>
        {!isAdmin && <p className="muted">A Sales Admin approves these.</p>}
        <div className="dlist">{[...new Set(pend.map(r => r.customer_id))].map(id => <button key={id} className="drow click" onClick={() => go('requests')}><span><b>{cname(id)}</b></span><span>{pend.filter(r => r.customer_id === id).length} strains</span></button>)}</div></section>}
      {over.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Ordered past their reserve <span className="side-badge">{over.length}</span></h3></div>
        <div className="dlist">{over.map(r => <div key={r.id} className="drow"><span><b>{cname(r.customer_id)}</b><span className="muted"> · {r.strain}</span></span><span className="pill badp">{n0(Number(r.remaining))} lbs</span></div>)}</div></section>}
      {short.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Promised more than we have <span className="side-badge">{short.length}</span></h3><button className="linkbtn" onClick={() => go('strain')}>By strain ›</button></div>
        <div className="dlist">{short.map(m => <div key={m.strain} className="drow"><span><b>{m.strain}</b><span className="muted"> · {n0(Number(m.on_hand))} on hand, {n0(Number(m.reserved_left))} reserved left</span></span><span className="pill badp">{n0(Number(m.free))} lbs</span></div>)}</div></section>}
    </div>
  )
}

/** Sales > Settings > Deadlines: when customers can request reserves for future crops */
export function DeadlinesPanel({ backend, flash }: { backend: Backend; flash: (t: string, bad?: boolean) => void }) {
  const [ys, setYs] = useState<ReserveYears | null>(null)
  useEffect(() => { backend.reserveYears().then(setYs).catch(() => {}) }, [backend])
  if (!ys) return <p className="muted">Loading…</p>
  const futures = [...new Set([ys.current + 1, ...ys.years.map(y => y.year).filter(y => y > ys.current)])].sort()
  return (
    <div className="dlist">
      <p className="muted">Customers can ask for reserves on a future crop in the portal until its deadline. You approve them under Requests.</p>
      {futures.map(y => (
        <div key={y} className="drow"><b>{y} crop</b>
          <DeadlineEdit year={y} value={ys.years.find(x => x.year === y)?.deadline ?? null}
            onSave={async v => { try { await backend.setReserveDeadline(y, v); setYs(await backend.reserveYears()); flash('Deadline saved') } catch (e) { flash(String((e as Error).message ?? e), true) } }} /></div>
      ))}
    </div>
  )
}
