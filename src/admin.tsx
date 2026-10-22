import { useEffect, useState } from 'react'
import type { Backend, Overview } from './api'
import { MODULES } from './types'
import type { AppUser } from './types'
import { Card, Cards, DashHead, Empty, Meter, Tile, Tiles } from './dash'

const n0 = (x: number) => Math.round(Number(x)).toLocaleString()
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const money = (x: number) => '$' + Math.round(Number(x)).toLocaleString()
const fmt = (s: string | null) => s ? new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''

export type Jump = 'dist.review' | 'dist.map' | 'dist.transit' | 'sales.requests' | 'sales.orders' | 'sales.customer' | 'sales.strain' | 'cult.review' | 'cult.yields' | 'admin.users'

/** Admin Dashboard: the whole company on one page */
export function AdminDashboard({ backend, open }: { backend: Backend; open: (j: Jump) => void }) {
  const [o, setO] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { backend.adminOverview().then(setO).catch(e => setErr(String(e?.message ?? e))) }, [backend])
  if (err) return <div className="list"><h2>Dashboard</h2><div className="warnbox">{err}</div></div>
  if (!o) return <p className="muted">Loading…</p>
  const vs = o.season.done_est ? o.season.actual / o.season.done_est - 1 : null
  const waiting = o.sales.requests + o.sales.to_confirm + o.needs_spot + o.season.unlogged
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
        <Tile label="Waiting on someone" value={waiting} sub={waiting ? 'requests, orders, pallets, harvests' : 'nothing waiting'} tone={waiting ? 'warn' : 'ok'} />
        <Tile label="Loads" value={o.loads.active} sub={o.loads.active ? `${o.loads.in_transit} in transit` : 'none active'} onClick={() => open('dist.transit')} />
        <Tile label="People this week" value={o.people.staff_week} sub={`of ${o.people.staff} staff · ${o.people.customers_month} of ${o.people.customers} customers this month`} onClick={() => open('admin.users')} />
      </Tiles>
      <Cards>
        <Card title="Waiting on someone">
          <div className="dlist">
            {[
              [o.sales.to_confirm, 'Orders to confirm', 'Sales', 'sales.orders'],
              [o.sales.requests, 'Reserve requests to approve', 'Sales', 'sales.requests'],
              [o.needs_spot, 'Pallets that need a spot', 'Distribution', 'dist.review'],
              [o.season.unlogged, 'Harvests not logged', 'Production', 'cult.review'],
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
        <Card title="Who uses what" action="Users" onAction={() => open('admin.users')}>
          <div className="dlist">
            <div className="drow"><span><b>Owners</b><span className="muted"> · everything</span></span><b>{o.people.owners}</b></div>
            {MODULES.map(m => <div key={m.key} className="drow"><span><b>{m.label}</b><span className="muted"> · {m.what}</span></span><b>{(o.people.by_module ?? {})[m.key] ?? 0}</b></div>)}
            {!o.people.staff && <Empty>No staff yet.</Empty>}
          </div>
          <div className="muted small-note">Owners aren't counted per module.</div>
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
