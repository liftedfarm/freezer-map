import { useEffect, useState } from 'react'
import type { Backend, Overview } from './api'
import { MODULES } from './types'
import type { AppUser } from './types'
import { Card, Cards, DashHead, Empty, Meter, Tile, Tiles } from './dash'

const n0 = (x: number) => Math.round(Number(x)).toLocaleString()
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w === 'person' ? 'people' : /(ch|sh|s|x)$/.test(w) ? w + 'es' : w + 's'}`
const money = (x: number) => '$' + Math.round(Number(x)).toLocaleString()
const fmt = (s: string | null) => s ? new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''

export type Jump = 'dist.review' | 'dist.map' | 'dist.transit' | 'dist.fulfill' | 'sales.requests' | 'sales.orders' | 'sales.customer' | 'sales.strain' | 'sales.invoices' | 'cult.review' | 'cult.yields' | 'cult.logs'
  | 'nurs.dashboard' | 'nurs.orders' | 'nurs.batches' | 'nurs.mothers' | 'nurs.breeding' | 'nurs.review' | 'nurs.logs' | 'nurs.invoices' | 'admin.users' | 'admin.settings'

/** Admin Dashboard: the whole company on one page */
export function AdminDashboard({ backend, open }: { backend: Backend; open: (j: Jump) => void }) {
  const [o, setO] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { backend.adminOverview().then(setO).catch(e => setErr(String(e?.message ?? e))) }, [backend])
  if (err) return <div className="list"><h2>Dashboard</h2><div className="warnbox">{err}</div></div>
  if (!o) return <p className="muted">Loading…</p>
  const vs = o.season.done_est ? o.season.actual / o.season.done_est - 1 : null
  const N = o.nursery, B = o.billing, L = o.logs
  const waiting = o.sales.requests + o.sales.to_confirm + o.needs_spot + o.season.unlogged + (N?.late ?? 0) + (N?.positive_tests ?? 0) + (B?.overdue ?? 0) + (o.licenses?.expiring.length ?? 0)
  const month = new Date().toLocaleDateString(undefined, { month: 'long' })
  return (
    <div className="dash">
      <DashHead title="Dashboard" sub={`Company overview · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`} />
      <Tiles>
        <Tile label="In the freezers" value={`${n0(o.freezers.lbs)} lbs`} sub={`${n0(o.freezers.pallets)} pallets · ${n0(o.open_spaces)} open spots`} onClick={() => open('dist.map')} />
        <Tile label={`${o.crop_year} fresh frozen`} value={`${n0(o.season.actual)} lbs`} sub={vs != null ? `${vs >= 0 ? '+' : ''}${Math.round(vs * 100)}% vs estimate · ${o.season.done}/${o.season.harvests} harvests` : `${o.season.done}/${o.season.harvests} harvests`}
          tone={vs == null ? undefined : vs < -0.1 ? 'warn' : 'ok'} onClick={() => open('cult.yields')} />
        <Tile label={`${o.crop_year} reserves left`} value={`${n0(o.reserves.remaining)} lbs`} sub={`of ${n0(o.reserves.reserved)} · ${plural(o.reserves.customers, 'customer')}`} onClick={() => open('sales.customer')} />
        <Tile label={`${o.next.year} reserves`} value={`${n0(o.next.reserved)} lbs`} sub={`${plural(o.next.customers, 'customer')} · ${n0(o.next.requested)} lbs asked${o.next.deadline ? ` · deadline ${fmt(o.next.deadline)}` : ''}`} tone="info" onClick={() => open('sales.strain')} />
        <Tile label={`Sold in ${month}`} value={`${n0(o.sales.lbs_ordered_month)} lbs`} sub={`${plural(o.sales.orders_month, 'order')}${o.sales.value_month ? ` · ${money(o.sales.value_month)}` : ''} · ${n0(o.sales.lbs_shipped_month)} shipped`} onClick={() => open('sales.orders')} />
        {N && <Tile label="Nursery" value={`${n0(N.rooting + N.ready)} clones`} sub={`${n0(N.ready)} ready · ${n0(N.owed)} owed on ${plural(N.open_orders, 'order')}${N.late ? `, ${N.late} late` : ''}`}
          tone={N.late ? 'bad' : undefined} onClick={() => open('nurs.dashboard')} />}
        {B && <Tile label="Unpaid invoices" value={money(B.open_amt)} sub={`${plural(B.open, 'invoice')}${B.overdue ? ` · ${money(B.overdue_amt)} overdue` : ' · none overdue'}`} tone={B.overdue ? 'bad' : B.open ? 'info' : 'ok'} onClick={() => open('sales.invoices')} />}
        <Tile label="Waiting on someone" value={waiting} sub={waiting ? 'requests, orders, deliveries, invoices' : 'nothing waiting'} tone={waiting ? 'warn' : 'ok'} />
        <Tile label="Loads" value={o.loads.active} sub={`${o.loads.active ? `${o.loads.in_transit} in transit` : 'none active'}${o.open_orders != null ? ` · ${plural(o.open_orders, 'order')} to ship` : ''}`} onClick={() => open('dist.transit')} />
        {L && <Tile label={`Logs in ${month}`} value={L.month} sub={`${L.pesticide_month ? `${plural(L.pesticide_month, 'pesticide spray')}` : 'no pesticide sprays'}${L.labor_hours_month ? ` · ${n0(L.labor_hours_month)} labor hrs` : ''}`} onClick={() => open('cult.logs')} />}
      </Tiles>
      <Cards>
        <Card title="Waiting on someone">
          <div className="dlist">
            {[
              [o.sales.to_confirm, 'Orders to confirm', 'Sales', 'sales.orders'],
              [o.sales.requests, 'Reserve requests to approve', 'Sales', 'sales.requests'],
              [o.needs_spot, 'Pallets that need a spot', 'Distribution', 'dist.review'],
              [o.season.unlogged, 'Harvests not logged', 'Production', 'cult.review'],
              ...(N ? [[N.late, 'Late clone deliveries', 'Nursery', 'nurs.review'], [N.positive_tests, 'Positive lab tests, nothing culled', 'Nursery', 'nurs.review'],
                [N.no_tag, 'Clone batches with no METRC tag', 'Nursery', 'nurs.review']] : []),
              ...(B ? [[B.overdue, 'Overdue invoices', 'Billing', 'sales.invoices'], [B.not_sent, 'Open invoices not emailed yet', 'Billing', 'sales.invoices']] : []),
              ...(o.licenses ? [[o.licenses.expiring.length, 'Licenses expiring in 90 days', 'Admin', 'admin.settings']] : []),
            ].map(([n, l, m, j]) => (
              <button key={String(l)} className="drow click" onClick={() => open(j as Jump)}><span><b>{l}</b><span className="muted"> · {m}</span></span>
                <span className={`pill ${n ? 'warnp' : ''}`}>{n}</span></button>
            ))}
          </div>
        </Card>
        <Card title={`${o.crop_year} season`}>
          <div className="dlist">
            <Meter label="Fresh frozen harvested" right={<>{n0(o.season.actual)} of {n0(o.season.est)} lbs est.</>} value={o.season.actual} max={Math.max(o.season.est, o.season.actual)} tone="ok" />
            <Meter label="Reserves shipped" right={<>{n0(o.reserves.shipped)} of {n0(o.reserves.reserved)} lbs</>} value={o.reserves.shipped} max={o.reserves.reserved} tone="ok" />
            <Meter label="Reserves on open orders" right={<>{n0(o.reserves.pending)} lbs</>} value={o.reserves.pending} max={o.reserves.reserved} />
          </div>
        </Card>
        {N && <Card title="Nursery" action="Nursery" onAction={() => open('nurs.dashboard')}>
          <div className="dlist">
            <Meter label="Ready vs owed" right={<>{n0(N.ready)} ready · {n0(N.rooting)} rooting / {n0(N.owed)} owed</>} value={N.ready + N.rooting} max={Math.max(N.owed, N.ready + N.rooting, 1)}
              tone={N.ready + N.rooting >= N.owed ? 'ok' : 'warn'} />
            <button className="drow click" onClick={() => open('nurs.mothers')}><span><b>Mother plants</b><span className="muted"> · {plural(N.mom_lots, 'lot')}</span></span><b>{n0(N.moms)}</b></button>
            <button className="drow click" onClick={() => open('nurs.batches')}><span><b>Rooting</b><span className="muted"> · {plural(N.rooting_batches, 'batch')}</span></span><b>{n0(N.rooting)}</b></button>
            <button className="drow click" onClick={() => open('nurs.orders')}><span><b>Delivered</b><span className="muted"> · {month} {n0(N.delivered_month)}</span></span><b>{n0(N.delivered_year)} this year</b></button>
            <button className="drow click" onClick={() => open('nurs.breeding')}><span><b>Breeding</b><span className="muted"> · {plural(N.runs, 'run')}, {plural(N.hunts, 'hunt')}, {N.scored} of {N.phenos} phenos scored</span></span><b>{plural(N.keepers, 'keeper')}</b></button>
          </div>
        </Card>}
        {B && <Card title="Billing" action="Invoices" onAction={() => open('sales.invoices')}>
          <div className="dlist">
            <Meter label={`Paid in ${month}`} right={<>{money(B.paid_month)} of {money(B.billed_month)} billed</>} value={B.paid_month} max={Math.max(B.billed_month, B.paid_month, 1)} tone="ok" />
            <div className="drow"><span><b>Open</b><span className="muted"> · {plural(B.open, 'invoice')}</span></span><b>{money(B.open_amt)}</b></div>
            <div className="drow"><span><b>Overdue</b><span className="muted"> · {plural(B.overdue, 'invoice')}</span></span><b className={B.overdue ? 'bad-t' : ''}>{money(B.overdue_amt)}</b></div>
            {B.nursery_open_amt > 0 && <button className="drow click" onClick={() => open('nurs.invoices')}><span><b>Clone invoices open</b><span className="muted"> · Nursery</span></span><b>{money(B.nursery_open_amt)}</b></button>}
          </div>
        </Card>}
        {L && <Card title={`Field logs · ${month}`} action="Production logs" onAction={() => open('cult.logs')}>
          <div className="dlist">
            {([['cultivation', 'Production', 'cult.logs'], ['nursery', 'Nursery', 'nurs.logs']] as const).map(([m, l, j]) => (
              <button key={m} className="drow click" onClick={() => open(j)}><span><b>{l}</b><span className="muted"> · {(['spray', 'feed', 'labor'] as const).map(k => `${L.by[`${m}.${k}`] ?? 0} ${k}`).join(' · ')}</span></span>
                <b>{(['spray', 'feed', 'labor'] as const).reduce((a, k) => a + (L.by[`${m}.${k}`] ?? 0), 0)}</b></button>))}
            <div className="drow"><span><b>Pesticide sprays</b><span className="muted"> · for the use report</span></span><b className={L.pesticide_month ? 'warn-t' : ''}>{L.pesticide_month}</b></div>
            {L.last && <div className="muted small-note">Last log {fmt(L.last)}.</div>}
          </div>
        </Card>}
        {o.licenses && o.licenses.expiring.length > 0 && <Card title="Licenses expiring" action="Licenses" onAction={() => open('admin.settings')}>
          <div className="dlist">{o.licenses.expiring.map(x => <div key={x.license} className="drow"><span><b>{x.license}</b><span className="muted"> · {x.kind}</span></span><span className="pill warnp">{fmt(x.expires)}</span></div>)}</div>
        </Card>}
        <Card title="Who uses what" action="Users" onAction={() => open('admin.users')}>
          <div className="dlist">
            <button className="drow click" onClick={() => open('admin.users')}><span><b>Signed in this week</b><span className="muted"> · {o.people.staff_week} of {o.people.staff} staff · {o.people.customers_month} of {o.people.customers} customers this month</span></span><b>{o.people.staff_week}</b></button>
            <div className="drow"><span><b>Owners</b><span className="muted"> · everything</span></span><b>{o.people.owners}</b></div>
            {MODULES.map(m => <div key={m.key} className="drow"><span><b>{m.label}</b><span className="muted"> · {m.what}</span></span><b>{(o.people.by_module ?? {})[m.key] ?? 0}</b></div>)}
            {!o.people.staff && <Empty>No staff yet.</Empty>}
          </div>
          <div className="muted small-note">Owners aren't counted per module.{o.people.view_only ? ` ${plural(o.people.view_only, 'person')} view only somewhere.` : ''}</div>
        </Card>
      </Cards>
    </div>
  )
}

const APP_KEYS: { k: string; l: string; hint?: string; area?: boolean }[] = [
  { k: 'crop_year', l: 'Current crop year', hint: 'The crop on the open menu and current reserves. Change it when the new crop takes over.' },
  { k: 'company.legal', l: 'Legal name on documents', hint: 'Default: DNA Organics, Inc. (dba Lifted Farms)' },
  { k: 'company.address', l: 'Address', hint: 'Use a new line for the city line. Default: 1961 Main St. #146 / Watsonville, CA 95076' },
  { k: 'company.email', l: 'Email', hint: 'On invoices and in the portal. Default: accounting@lifted-organics.com' },
  { k: 'company.phone', l: 'Phone' }, { k: 'company.web', l: 'Website' }, { k: 'company.license', l: 'License #', hint: 'Optional, under the address on documents' },
  { k: 'company.remit', l: 'Remit to (bank details)', hint: 'e.g. Remit to: [Bank] · Account ••••0000 · Routing 122243224 | Check payable to: DNA Organics, Inc.', area: true },
  { k: 'company.crypto', l: 'Crypto line' },
  { k: 'company.late_terms', l: 'Late payment terms', hint: 'The 1.5% monthly finance charge paragraph. Blank = the standard wording.', area: true },
]

/** Admin > Settings > App settings: things that apply to the whole app */
export function AppSettingsPanel({ backend, flash }: { backend: Backend; flash: (t: string, bad?: boolean) => void }) {
  const [v, setV] = useState<Record<string, string> | null>(null)
  const [was, setWas] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { backend.appSettings().then(x => { setV(x); setWas(x) }).catch(() => setV({})) }, [backend])
  if (!v) return <p className="muted">Loading…</p>
  const changed = APP_KEYS.filter(x => (v[x.k] ?? '') !== (was[x.k] ?? ''))
  async function save() {
    setBusy(true)
    try { for (const x of changed) await backend.setAppSetting(x.k, (v![x.k] ?? '').trim()); setWas(v!); flash('Saved') }
    catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="form-panel">
      {APP_KEYS.map(x => (
        <div key={x.k} className="field"><label>{x.l}</label>
          {x.area || x.k === 'company.address' ? <textarea rows={3} value={v[x.k] ?? ''} onChange={e => setV({ ...v, [x.k]: e.target.value })} />
            : <input value={v[x.k] ?? ''} inputMode={x.k === 'crop_year' ? 'numeric' : undefined} onChange={e => setV({ ...v, [x.k]: e.target.value })} />}
          {x.hint && <p className="muted">{x.hint}</p>}</div>
      ))}
      <p className="muted">These show on every sales order and invoice. Each module's own settings (vehicles, customers, payment terms, sites, fields) are under Settings in that module.</p>
      <button className="primary" disabled={busy || !changed.length} onClick={save}>Save{changed.length ? ` ${changed.length} change${changed.length > 1 ? 's' : ''}` : ''}</button>
    </div>
  )
}

/** Admin > Review: what's stuck anywhere in the company, plus people and logins that need a look */
export function AdminReview({ backend, open }: { backend: Backend; open: (j: Jump) => void }) {
  const [o, setO] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AppUser[] | null>(null)
  const [logins, setLogins] = useState<Map<string, { claimed: boolean; invited_at: string | null }>>(new Map())
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    backend.adminOverview().then(setO).catch(e => setErr(String(e?.message ?? e)))
    Promise.all([backend.listUsers(), backend.userLogins()]).then(([u, l]) => { setUsers(u); setLogins(l) }).catch(() => setUsers([]))
  }, [backend])
  if (err) return <div className="list"><h2>Review</h2><div className="warnbox">{err}</div></div>
  if (!o || !users) return <p className="muted">Loading…</p>
  const staff = users.filter(u => ['admin', 'sales', 'crew'].includes(u.role))
  const noMods = staff.filter(u => !u.owner && !Object.keys(u.access ?? {}).length)
  const never = staff.filter(u => !u.last_seen)
  const custs = users.filter(u => u.role === 'customer')
  const notInvited = custs.filter(u => !logins.get(u.email)?.invited_at && !logins.get(u.email)?.claimed)
  const notSetUp = custs.filter(u => logins.get(u.email)?.invited_at && !logins.get(u.email)?.claimed)
  const work: [number, string, string, Jump][] = [
    [o.sales.to_confirm, 'Orders to confirm', 'Sales', 'sales.orders'],
    [o.sales.requests, 'Reserve requests to approve', 'Sales', 'sales.requests'],
    [o.needs_spot, 'Pallets that need a spot', 'Distribution', 'dist.review'],
    [o.season.unlogged, 'Harvests not logged', 'Production', 'cult.review'],
  ]
  const stuck = work.filter(w => w[0] > 0)
  const people: [AppUser[], string, string][] = [
    [noMods, 'Staff with no modules', 'They can sign in but see nothing. Give them a module or set them to No access.'],
    [never, 'Never signed in', 'Added but haven\'t used the app yet.'],
    [notInvited, 'Customers not invited', 'No portal invite link made yet.'],
    [notSetUp, 'Customers invited, not set up', 'Link sent but no password yet. Links work for 14 days.'],
  ]
  const nothing = !stuck.length && people.every(p => !p[0].length)
  return (
    <div className="list dash">
      <h2>Review</h2>
      {nothing && <p className="muted">Nothing needs attention anywhere.</p>}
      {stuck.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Waiting in the modules</h3></div>
        <div className="dlist">{stuck.map(([n, l, m, j]) => <button key={l} className="drow click" onClick={() => open(j)}><span><b>{l}</b><span className="muted"> · {m}</span></span><span className="pill warnp">{n}</span></button>)}</div></section>}
      {people.filter(p => p[0].length).map(([list, l, note]) => (
        <section key={l} className="dcard"><div className="dcard-h"><h3>{l} <span className="side-badge">{list.length}</span></h3><button className="linkbtn" onClick={() => open('admin.users')}>Users ›</button></div>
          <p className="muted">{note}</p>
          <div className="dlist">{list.map(u => <div key={u.email} className="drow"><span><b>{u.display_name || u.email}</b>{u.display_name && <span className="muted"> · {u.email}</span>}</span></div>)}</div></section>
      ))}
    </div>
  )
}
