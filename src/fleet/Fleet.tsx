import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FleetApi } from './api'
import type { Asset, AssetKind, Carrier, Checklist, Dept, Driver, FleetData, InspResult, Log, LogKind } from './api'
import type { Doc, DocType } from '../comp/api'
import { AddDocsSheet, DropZone, Expiry, FileChip, SITES, daysTo, fmtD, today } from '../comp/files'
import { Choices, DateIn, F, NumIn, Pick, SaveBar, Sheet, TextIn, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { Card, DashHead, Empty, Tile, Tiles } from '../dash'
import { t } from '../i18n'
import { reportPdf } from './pdf'
import './fleet.css'

// Vehicles and equipment.
//  - Compliance › Vehicles: the list, insurance and registrations (with expiry → Deadlines), every report, closing defects and incidents.
//  - Top bar › Vehicles (everyone on staff): file an inspection, maintenance or incident report from a phone, with photos.

export const KIND_L: Record<AssetKind, string> = { vehicle: 'Vehicle', trailer: 'Trailer', equipment: 'Equipment' }
export const LOG_L: Record<LogKind, string> = { maintenance: 'Maintenance', inspection: 'Inspection', incident: 'Incident' }
const RESULT_L: Record<InspResult, string> = { pass: 'Passed', defects: 'Defects found', out_of_service: 'Out of service' }
const STATUS_L: Record<Asset['status'], string> = { active: 'In service', out_of_service: 'Out of service', retired: 'Retired' }
const DOC_KINDS: { key: string; l: string; add: string }[] = [{ key: 'insurance', l: 'Insurance', add: 'Add insurance policy' }, { key: 'transport', l: 'Registration', add: 'Add registration' }]
const who = (e: string | null | undefined) => (e ?? '').split('@')[0]
const n0 = (x: number | null | undefined) => (x == null ? '' : Math.round(Number(x)).toLocaleString())
export const assetName = (a: Asset | undefined) => (a ? `${a.unit_no ? `${a.unit_no} · ` : ''}${a.name}` : '')
const reading = (a: Asset | undefined) => (a?.kind === 'vehicle' ? 'odometer' : 'hours') as 'odometer' | 'hours'

function useFleet(sb: SupabaseClient | null) {
  const api = useMemo(() => (sb ? new FleetApi(sb) : null), [sb])
  const [d, setD] = useState<FleetData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = async () => { if (!api) return; try { setD(await api.data()); setErr(null) } catch (e) { setErr(errText(e)) } }
  useEffect(() => { load() }, [api])
  return { api, d, err, load }
}

/** insurance / registration status for one asset: ok, expiring, expired or missing */
function paperOf(a: Asset, key: string) {
  const ds = a.docs.filter(x => x.doc_type === key)
  if (!ds.length) return { tone: a.kind === 'equipment' ? 'cp-mute' : 'cp-warn', text: 'none', d: null as string | null }
  const exp = ds.map(x => x.expires_on).filter((x): x is string => !!x).sort().pop() ?? null
  const n = daysTo(exp)
  return { tone: n == null ? 'cp-ok' : n < 0 ? 'cp-bad' : n <= 60 ? 'cp-warn' : 'cp-ok', text: exp ? (n! < 0 ? `expired ${fmtD(exp)}` : `to ${fmtD(exp)}`) : 'on file', d: exp }
}
function inspDue(a: Asset) {
  if (!a.inspect_every_days || a.status === 'retired') return null
  const base = a.last_inspection ?? null
  if (!base) return 0
  return (daysTo(base) ?? 0) + a.inspect_every_days
}

// =====================================================================================================
// Top bar › Vehicles: for everyone on staff
// =====================================================================================================
export function CrewFleet({ sb, flash }: { sb: SupabaseClient | null; flash: Flash }) {
  const { api, d, err, load } = useFleet(sb)
  const [rep, setRep] = useState<Partial<Log> | null>(null)
  if (!api) return <div className="list"><h2>{t('Vehicles')}</h2><p className="muted">{t('Needs the database (not in the demo).')}</p></div>
  if (err) return <div className="list"><h2>{t('Vehicles')}</h2><div className="warnbox">{err}</div></div>
  if (!d) return <div className="list"><h2>{t('Vehicles')}</h2><p className="muted">{t('Loading…')}</p></div>
  const mine = d.logs.filter(l => l.created_by === d.me).slice(0, 20)
  const open = d.logs.filter(l => l.status === 'open')
  const mineIds = new Set(d.drivers.filter(x => x.email && x.email === d.me).flatMap(x => x.asset_ids))
  const dueNow = d.assets.filter(a => a.carrier_id == null && a.status === 'active' && (inspDue(a) ?? 99) <= 0).sort((a, b) => Number(mineIds.has(b.id)) - Number(mineIds.has(a.id)))
  return <div className="list fleet comp">
    <h2>{t('Vehicles and equipment')}</h2>
    <p className="muted">{t('File a report from your phone. Photos help.')}</p>
    <div className="fbig">
      <button className="fbtn" onClick={() => setRep({ kind: 'inspection' })}><b>{t('Inspection')}</b><span>{t('Pre-trip or equipment check')}</span></button>
      <button className="fbtn" onClick={() => setRep({ kind: 'maintenance' })}><b>{t('Maintenance')}</b><span>{t('Service, repair, oil change')}</span></button>
      <button className="fbtn bad" onClick={() => setRep({ kind: 'incident' })}><b>{t('Report an incident')}</b><span>{t('Accident, damage, injury, near miss')}</span></button>
    </div>
    {dueNow.length > 0 && <section className="dcard"><h3>{t('Inspection due')}</h3>
      <div className="dlist">{dueNow.map(a => <button key={a.id} className="drow linkrow" onClick={() => setRep({ kind: 'inspection', asset_id: a.id })}>
        <span className="grow"><b>{assetName(a)}</b> <span className="muted">{a.site ?? ''}</span></span><span className="pill cp-warn">{a.last_inspection ? t('last {d}', { d: fmtD(a.last_inspection) }) : t('never')}</span></button>)}</div></section>}
    {open.length > 0 && <section className="dcard"><h3>{t('Open items')}</h3><LogList d={d} logs={open} onOpen={l => setRep(l)} /></section>}
    <section className="dcard"><h3>{t('My reports')}</h3>{mine.length ? <LogList d={d} logs={mine} onOpen={l => setRep(l)} /> : <p className="muted">{t('Nothing yet.')}</p>}</section>
    {rep && <ReportSheet api={api} d={d} x0={rep} flash={flash} onClose={() => setRep(null)} onSaved={async m => { setRep(null); await load(); flash(m) }} />}
  </div>
}

// =====================================================================================================
// Compliance › Vehicles
// =====================================================================================================
export const DEPT_L: Record<Dept, string> = { distribution: 'Distribution', cultivation: 'Production', nursery: 'Nursery', processing: 'Processing', company: 'Company-wide' }
const DEPTS: Dept[] = ['distribution', 'cultivation', 'nursery', 'processing', 'company']
type FTab = 'assets' | 'drivers' | 'carriers' | 'reports'

/** Compliance › Vehicles (everything), or one department's Settings › Vehicles (dept set: only theirs, no paperwork) */
export function CompFleet({ sb, flash, dept }: { sb: SupabaseClient | null; flash: Flash; dept?: Dept }) {
  const { api, d, err, load } = useFleet(sb)
  const [tab, setTab] = useState<FTab>('assets')
  const [asset, setAsset] = useState<Partial<Asset> | null>(null)
  const [driver, setDriver] = useState<Partial<Driver> | null>(null)
  const [carrier, setCarrier] = useState<Partial<Carrier> | null>(null)
  const [rep, setRep] = useState<Partial<Log> | null>(null)
  const [kind, setKind] = useState<'all' | LogKind>('all')
  const [depF, setDepF] = useState<'all' | Dept>('all')
  const [openOnly, setOpenOnly] = useState(false)
  const [q, setQ] = useState('')
  const [retired, setRetired] = useState(false)
  const title = dept ? `${DEPT_L[dept]} vehicles` : 'Vehicles'
  if (!api) return <div className="list"><h2>{title}</h2><p className="muted">Needs the database (not in the demo).</p></div>
  if (err) return <div className="list"><h2>{title}</h2><div className="warnbox">{err}</div></div>
  if (!d) return <div className="list"><h2>{title}</h2><p className="muted">Loading…</p></div>
  const ql = q.trim().toLowerCase()
  const has = (xs: (string | number | null | undefined)[]) => !ql || xs.some(x => String(x ?? '').toLowerCase().includes(ql))
  const ours = d.assets.filter(a => a.carrier_id == null && (!dept || a.department === dept))
  const live = ours.filter(a => a.status !== 'retired')
  const paperIssues = live.filter(a => a.kind !== 'equipment' && DOC_KINDS.some(k => paperOf(a, k.key).tone !== 'cp-ok'))
  const openDef = d.logs.filter(l => l.status === 'open' && l.kind === 'inspection')
  const openInc = d.logs.filter(l => l.status === 'open' && l.kind === 'incident')
  const out = live.filter(a => a.status === 'out_of_service')
  const due = live.filter(a => (inspDue(a) ?? 99) <= 0)
  const assets = ours.filter(a => (retired || a.status !== 'retired') && (dept || depF === 'all' || a.department === depF)
    && has([a.name, a.unit_no, a.plate, a.vin, a.make, a.model, a.site, a.body_type, ...d.drivers.filter(x => a.driver_ids.includes(x.id)).map(x => x.name)]))
  const drivers = d.drivers.filter(x => x.carrier_id == null && (!dept || x.department === dept) && (retired || x.active) && has([x.name, x.phone, x.email]))
  const carriers = d.carriers.filter(c => (retired || c.active) && has([c.name, c.contact_name, c.phone, c.license_no]))
  const logs = d.logs.filter(l => (kind === 'all' || l.kind === kind) && (!openOnly || l.status === 'open')
    && (!dept || ours.some(a => a.id === l.asset_id))
    && has([l.summary, assetName(d.assets.find(a => a.id === l.asset_id)), l.created_by, l.vendor]))
  const myDepts = d.my_depts
  const canAdd = dept ? myDepts.includes(dept) : myDepts.length > 0
  const showCarriers = !dept || dept === 'distribution'
  const tabs: [FTab, string][] = [['assets', 'Vehicles & equipment'], ['drivers', 'Drivers'], ...(showCarriers ? [['carriers', 'Outside carriers']] as [FTab, string][] : []), ['reports', 'Reports']]
  return <div className={`list fleet comp ${dept ? 'deptfleet' : ''}`}>
    {dept ? <><h2>{title}</h2><p className="muted">{DEPT_L[dept]}'s vehicles, equipment and drivers. Same list as Compliance › Vehicles, where Compliance keeps the insurance and registrations.</p></>
      : <DashHead title="Vehicles and equipment" sub="Every company vehicle and piece of equipment by department, our drivers, outside carriers, and reports" />}
    {!dept && <Tiles>
      <Tile value={live.length} label="Vehicles and equipment" sub={DEPTS.map(x => [x, live.filter(a => a.department === x).length] as const).filter(([, n]) => n).map(([x, n]) => `${n} ${DEPT_L[x].toLowerCase()}`).join(' · ') || 'none yet'} onClick={() => { setTab('assets'); setQ('') }} />
      <Tile value={out.length} label="Out of service" tone={out.length ? 'bad' : 'ok'} sub={out.map(a => a.unit_no ?? a.name).join(', ') || 'none'} onClick={() => setTab('assets')} />
      <Tile value={openDef.length} label="Open defects" sub="from inspections" tone={openDef.length ? 'warn' : 'ok'} onClick={() => { setTab('reports'); setKind('inspection'); setOpenOnly(true) }} />
      <Tile value={openInc.length} label="Open incidents" sub="to follow up" tone={openInc.length ? 'warn' : 'ok'} onClick={() => { setTab('reports'); setKind('incident'); setOpenOnly(true) }} />
      <Tile value={paperIssues.length} label="Insurance / registration" sub="missing, expiring or expired" tone={paperIssues.length ? 'warn' : 'ok'} onClick={() => setTab('assets')} />
      <Tile value={d.drivers.filter(x => x.active && x.carrier_id == null).length} label="Our drivers" sub={`${d.drivers.filter(x => x.active && x.carrier_id == null && !x.has_login).length} not on the app yet`} onClick={() => setTab('drivers')} />
      <Tile value={d.carriers.filter(c => c.active).length} label="Outside carriers" sub={`${d.carriers.filter(c => c.active && (!c.license_expires || (daysTo(c.license_expires) ?? 0) < 30)).length} license missing or expiring`} onClick={() => setTab('carriers')} />
      <Tile value={due.length} label="Inspection due" sub="by each one's schedule" tone={due.length ? 'warn' : 'ok'} onClick={() => setTab('assets')} />
    </Tiles>}
    <div className="row toolbar wrap">
      <div className="seg">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <input className="search" type="search" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
      {tab === 'assets' && canAdd && <button className="primary" onClick={() => setAsset({ kind: 'vehicle', status: 'active', checklist: 'vehicle', department: dept ?? (depF !== 'all' ? depF : myDepts[0]) })}>+ Add</button>}
      {tab === 'drivers' && canAdd && <button className="primary" onClick={() => setDriver({ active: true, department: dept ?? (myDepts.includes('distribution') ? 'distribution' : myDepts[0]) })}>+ Driver</button>}
      {tab === 'carriers' && d.carrier_admin && <button className="primary" onClick={() => setCarrier({ active: true })}>+ Carrier</button>}
      {tab === 'reports' && <span className="row wrap">
        <button className="ghost small" onClick={() => setRep({ kind: 'inspection' })}>+ Inspection</button>
        <button className="ghost small" onClick={() => setRep({ kind: 'maintenance' })}>+ Maintenance</button>
        <button className="ghost small" onClick={() => setRep({ kind: 'incident' })}>+ Incident</button></span>}
    </div>
    {tab === 'assets' && <>
      {!dept && <div className="row wrap"><Choices value={depF} options={[{ v: 'all', l: 'All' }, ...DEPTS.map(x => ({ v: x, l: DEPT_L[x] }))]} onChange={setDepF} /></div>}
      {!assets.length ? <Empty>{ours.length ? 'Nothing matches.' : canAdd ? 'Nothing here yet. Add the trucks, trailers, pickups, tractors and other equipment.' : 'Nothing here yet.'}</Empty>
        : <div className="clist">{assets.map(a => {
          const di = inspDue(a)
          const dn = d.drivers.filter(x => a.driver_ids.includes(x.id)).map(x => x.name)
          return <button key={a.id} className={`crow fasset ${a.status === 'retired' ? 'retired' : ''}`} onClick={() => setAsset(a)}>
            <span className="grow"><span className="kind">{dept ? '' : `${DEPT_L[a.department]} · `}{a.body_type ?? KIND_L[a.kind]}{a.site ? ` · ${a.site}` : ''}{a.plate ? ` · ${a.plate}` : ''}</span>
              <b>{assetName(a)}</b> <span className="muted">{[a.year, a.make, a.model].filter(Boolean).join(' ')}{a.pallet_spaces ? ` · ${a.pallet_spaces} pallet spaces` : ''}</span>
              {dn.length > 0 && <div className="muted small">Drivers: {dn.join(', ')}</div>}
              <div className="row wrap fpills">
                {a.status !== 'active' && <span className={`pill ${a.status === 'out_of_service' ? 'cp-bad' : 'cp-mute'}`}>{STATUS_L[a.status]}</span>}
                {!dept && a.kind !== 'equipment' && DOC_KINDS.map(k => { const p = paperOf(a, k.key); return <span key={k.key} className={`pill ${p.tone}`}>{k.l}: {p.text}</span> })}
                {di != null && <span className={`pill ${di <= 0 ? 'cp-warn' : 'cp-ok'}`}>{di <= 0 ? 'inspection due' : `inspect in ${di}d`}</span>}
                {a.open > 0 && <span className="pill cp-bad">{a.open} open</span>}
              </div></span>
            <span className="muted small nowrap">{a.odometer ? `${n0(a.odometer)} mi` : a.hours ? `${n0(a.hours)} hrs` : ''}</span>
          </button>
        })}</div>}
      <label className="check small-check"><input type="checkbox" checked={retired} onChange={e => setRetired(e.target.checked)} /> Show retired</label>
    </>}
    {tab === 'drivers' && <>
      {!drivers.length ? <Empty>No drivers yet. Add your drivers, with or without an app login, and the vehicles each one drives.</Empty>
        : <div className="clist">{drivers.map(x => <button key={x.id} className={`crow ${x.active ? '' : 'retired'}`} onClick={() => setDriver(x)}>
          <span className="grow"><span className="kind">{x.department ? DEPT_L[x.department] : ''}{x.phone ? ` · ${x.phone}` : ''}</span>
            <b>{x.name}</b> <span className="muted">{d.assets.filter(a => x.asset_ids.includes(a.id)).map(a => assetName(a)).join(', ')}</span>
            <div className="row wrap fpills">
              <span className={`pill ${x.has_login ? 'cp-ok' : 'cp-mute'}`}>{x.has_login ? 'on the app' : 'no app login'}</span>
              {x.license_expires ? <Expiry d={x.license_expires} warn={30} /> : <span className="pill cp-warn">no license date</span>}
            </div></span>
        </button>)}</div>}
      <label className="check small-check"><input type="checkbox" checked={retired} onChange={e => setRetired(e.target.checked)} /> Show inactive</label>
    </>}
    {tab === 'carriers' && <>
      {!carriers.length ? <Empty>No outside carriers yet.</Empty>
        : <div className="clist">{carriers.map(c => {
          const trucks = d.assets.filter(a => a.carrier_id === c.id && a.status !== 'retired'), ds = d.drivers.filter(x => x.carrier_id === c.id && x.active)
          const coi = c.docs.filter(x => x.doc_type === 'insurance').map(x => x.expires_on).filter((x): x is string => !!x).sort().pop() ?? null
          return <button key={c.id} className={`crow ${c.active ? '' : 'retired'}`} onClick={() => setCarrier(c)}>
            <span className="grow"><span className="kind">{[c.contact_name, c.phone].filter(Boolean).join(' · ') || 'no contact yet'}</span>
              <b>{c.name}</b> <span className="muted">{trucks.length} truck{trucks.length === 1 ? '' : 's'} · {ds.length} driver{ds.length === 1 ? '' : 's'}</span>
              <div className="row wrap fpills">
                {c.license_expires ? <span className="pill cp-mute">License</span> : <span className="pill cp-warn">no license on file</span>}{c.license_expires && <Expiry d={c.license_expires} warn={30} />}
                {coi ? <><span className="pill cp-mute">Insurance</span><Expiry d={coi} warn={30} /></> : <span className="pill cp-warn">no insurance certificate</span>}
              </div></span>
          </button>
        })}</div>}
      <label className="check small-check"><input type="checkbox" checked={retired} onChange={e => setRetired(e.target.checked)} /> Show inactive</label>
    </>}
    {tab === 'reports' && <>
      <div className="row wrap"><Choices value={kind} options={[{ v: 'all', l: 'All' }, { v: 'inspection', l: 'Inspections' }, { v: 'maintenance', l: 'Maintenance' }, { v: 'incident', l: 'Incidents' }]} onChange={setKind} />
        <label className="check small-check"><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> Open only</label></div>
      {logs.length ? <LogList d={d} logs={logs} onOpen={l => setRep(l)} showAsset /> : <Empty>No reports{openOnly ? ' open' : ''}.</Empty>}
    </>}
    {asset && <AssetSheet api={api} d={d} a0={asset} flash={flash} paperwork={!dept} onClose={() => setAsset(null)} onSaved={async (m, keep) => { await load(); flash(m); if (!keep) setAsset(null) }}
      onReport={x => setRep(x)} />}
    {driver && <DriverSheet api={api} d={d} x0={driver} flash={flash} onClose={() => setDriver(null)} onSaved={async (m, keep) => { await load(); flash(m); if (!keep) setDriver(null) }} />}
    {carrier && <CarrierSheet api={api} d={d} x0={carrier} flash={flash} onClose={() => setCarrier(null)} onSaved={async (m, keep) => { await load(); flash(m); if (!keep) setCarrier(null) }} />}
    {rep && <ReportSheet api={api} d={d} x0={rep} flash={flash} onClose={() => setRep(null)} onSaved={async m => { setRep(null); await load(); flash(m) }} />}
  </div>
}

/** Compliance dashboard card */
export function FleetCard({ sb, go }: { sb: SupabaseClient | null; go: () => void }) {
  const { d } = useFleet(sb)
  if (!d || !d.assets.length) return null
  const live = d.assets.filter(a => a.status !== 'retired' && a.carrier_id == null)
  const rows: [string, number, string][] = [
    ['Out of service', live.filter(a => a.status === 'out_of_service').length, 'cp-bad'],
    ['Open defects', d.logs.filter(l => l.status === 'open' && l.kind === 'inspection').length, 'cp-warn'],
    ['Open incidents', d.logs.filter(l => l.status === 'open' && l.kind === 'incident').length, 'cp-bad'],
    ['Insurance / registration issues', live.filter(a => a.kind !== 'equipment' && DOC_KINDS.some(k => paperOf(a, k.key).tone !== 'cp-ok')).length, 'cp-warn'],
  ]
  return <Card title="Vehicles and equipment" action="Open" onAction={go}>
    <div className="dlist">{rows.map(([l, n, tone]) => <div key={l} className="drow"><span className="grow">{l}</span><span className={`pill ${n ? tone : 'cp-ok'}`}>{n}</span></div>)}</div>
  </Card>
}

function LogList({ d, logs, onOpen, showAsset = true }: { d: FleetData; logs: Log[]; onOpen: (l: Log) => void; showAsset?: boolean }) {
  return <div className="clist">{logs.map(l => {
    const a = d.assets.find(x => x.id === l.asset_id)
    return <button key={l.id} className="crow" onClick={() => onOpen(l)}>
      <span className="grow"><span className="kind">{t(LOG_L[l.kind])} · {fmtD(l.happened_on)}{l.created_by ? ` · ${who(l.created_by)}` : ''}</span>
        <b>{l.summary ?? (l.result ? t(RESULT_L[l.result]) : t(LOG_L[l.kind]))}</b>{showAsset && a && <span className="muted"> {assetName(a)}</span>}
        {l.files > 0 && <span className="muted small"> · {l.files} {l.files === 1 ? t('photo') : t('photos')}</span>}</span>
      {l.status === 'open' ? <span className={`pill ${l.kind === 'incident' ? 'cp-bad' : 'cp-warn'}`}>{t('open')}</span>
        : l.kind === 'inspection' && l.result ? <span className={`pill ${l.result === 'pass' ? 'cp-ok' : 'cp-mute'}`}>{t(RESULT_L[l.result])}</span>
        : l.cost ? <span className="muted small">${Number(l.cost).toLocaleString()}</span> : null}
    </button>
  })}</div>
}

// =====================================================================================================
// One vehicle / piece of equipment
// =====================================================================================================
function AssetSheet({ api, d, a0, flash, paperwork = true, onClose, onSaved, onReport }: {
  api: FleetApi; d: FleetData; a0: Partial<Asset>; flash: Flash; paperwork?: boolean; onClose: () => void; onSaved: (m: string, keep?: boolean) => Promise<void>; onReport: (x: Partial<Log>) => void
}) {
  const [x, setX] = useState<Partial<Asset>>(() => ({ driver_ids: [], ...a0 }))
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Asset>) => setX(s => ({ ...s, ...v }))
  const carrierTruck = x.carrier_id != null
  const can = carrierTruck ? d.carrier_admin : d.my_depts.includes((a0.department ?? x.department ?? 'company') as Dept)
  const a = d.assets.find(y => y.id === a0.id)
  const logs = d.logs.filter(l => l.asset_id === a0.id)
  const transport = x.kind !== 'equipment'
  const ourDrivers = d.drivers.filter(r => r.carrier_id == null && (r.active || (x.driver_ids ?? []).includes(r.id)))
  async function save() {
    setBusy(true)
    try {
      const { docs: _docs, open: _open, last_inspection: _li, last_service: _ls, ...p } = x as Asset
      const id = await api.saveAsset(p)
      if (!x.id) set({ id })
      await onSaved(x.id ? 'Saved' : `${x.name} added.${paperwork && !carrierTruck ? ' Now attach its insurance and registration.' : ''}`, !x.id && paperwork && !carrierTruck)
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const txt = (k: keyof Asset, l: string, hint?: string) => <F label={l} hint={hint}><TextIn value={x[k] as string | null} onChange={v => set({ [k]: v } as Partial<Asset>)} /></F>
  const num = (k: keyof Asset, l: string, hint?: string) => <F label={l} hint={hint}><NumIn value={x[k] as number | null} onChange={v => set({ [k]: v } as Partial<Asset>)} /></F>
  const carrier = d.carriers.find(c => c.id === x.carrier_id)
  return <Sheet wide title={x.id ? assetName(a ?? (x as Asset)) : carrierTruck ? `Add a ${carrier?.name ?? 'carrier'} truck` : 'Add vehicle or equipment'}
    sub={x.id ? `${carrierTruck ? carrier?.name ?? 'Outside carrier' : DEPT_L[(x.department ?? 'company') as Dept]} · ${x.body_type ?? KIND_L[x.kind ?? 'vehicle']}${x.site ? ` · ${x.site}` : ''}` : undefined} onClose={onClose}>
    {x.id && !carrierTruck && <div className="row wrap freps">
      <button className="ghost small" onClick={() => onReport({ kind: 'inspection', asset_id: x.id })}>+ Inspection</button>
      <button className="ghost small" onClick={() => onReport({ kind: 'maintenance', asset_id: x.id })}>+ Maintenance</button>
      <button className="ghost small" onClick={() => onReport({ kind: 'incident', asset_id: x.id })}>+ Incident</button>
    </div>}
    <fieldset disabled={!can} className="fset">
      <div className="grid3">
        {!carrierTruck && <F label="Department"><Pick value={(x.department ?? 'company') as Dept} options={DEPTS.filter(k => d.my_depts.includes(k) || k === x.department).map(k => ({ v: k, l: DEPT_L[k] }))}
          onChange={v => set({ department: v ?? 'company' })} /></F>}
        <F label="Type"><Pick value={x.kind ?? 'vehicle'} options={(['vehicle', 'trailer', 'equipment'] as AssetKind[]).map(k => ({ v: k, l: KIND_L[k] }))}
          onChange={v => set({ kind: v ?? 'vehicle', checklist: x.checklist && x.checklist !== x.kind ? x.checklist : v ?? 'vehicle' })} /></F>
        {txt('body_type', 'What it is', x.kind === 'equipment' ? 'Tractor, Combine, Forklift…' : 'Reefer truck, Box truck, Pickup…')}
        {txt('name', 'Name', 'e.g. 20\' Freezer Truck')}
        {!carrierTruck && txt('unit_no', 'Unit #', 'our number, e.g. T3')}
        {!carrierTruck && <F label="Home site"><Pick value={x.site ?? null} blank="—" options={SITES.map(s => ({ v: s, l: s }))} onChange={v => set({ site: v })} /></F>}
        {txt('make', 'Make')}{txt('model', 'Model')}
        {num('year', 'Year')}{txt('vin', x.kind === 'equipment' ? 'Serial #' : 'VIN')}{transport && txt('plate', 'Plate')}
        {transport && num('pallet_spaces', 'Pallet spaces', 'for loads')}
        {transport && num('pallets_across', 'Pallets across', 'usually 2')}
        <F label="Status"><Pick value={x.status ?? 'active'} options={(['active', 'out_of_service', 'retired'] as Asset['status'][]).map(s => ({ v: s, l: STATUS_L[s] }))} onChange={v => set({ status: v ?? 'active' })} /></F>
        {!carrierTruck && <F label="Inspection checklist"><Pick value={x.checklist ?? null} blank="—" options={d.checklists.map(c => ({ v: c.key, l: c.label }))} onChange={v => set({ checklist: v })} /></F>}
      </div>
      {!carrierTruck && <>
        <F label="Drivers" hint="who drives it (they see it first when filing an inspection)">
          <div className="row wrap fchips">{ourDrivers.map(r => { const on = (x.driver_ids ?? []).includes(r.id)
            return <button type="button" key={r.id} className={`chip ${on ? 'on' : ''}`} onClick={() => set({ driver_ids: on ? (x.driver_ids ?? []).filter(i => i !== r.id) : [...(x.driver_ids ?? []), r.id] })}>{r.name}</button> })}
            {!ourDrivers.length && <span className="muted small">No drivers yet. Add them on the Drivers tab.</span>}</div></F>
        <h3>Schedule</h3>
        <div className="grid3">
          {num('inspect_every_days', 'Inspect every (days)', 'blank = no schedule')}
          {num('service_every_days', 'Service every (days)')}
          {x.kind === 'vehicle' ? num('service_every_miles', 'Service every (miles)') : num('service_every_hours', 'Service every (hours)')}
          {x.kind === 'vehicle' ? num('odometer', 'Odometer (mi)', 'updates from reports') : num('hours', 'Hours', 'updates from reports')}
        </div>
      </>}
      <F label="Notes"><textarea value={x.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
    </fieldset>
    {can ? <SaveBar busy={busy} onSave={save} onCancel={onClose} disabled={!x.name?.trim()} saveLabel={x.id ? 'Save' : 'Add'} />
      : <p className="muted small">Only Compliance or this department's Admins can change it. Anyone can file reports.</p>}
    {x.id && paperwork && !carrierTruck && <AssetDocs api={api} refKind="asset" refId={x.id} name={x.name ?? ''} site={x.site ?? null} can={d.can_edit} flash={flash} onChanged={() => onSaved('Saved', true)} />}
    {x.id && !carrierTruck && <><h3>History</h3>{logs.length ? <LogList d={d} logs={logs} onOpen={l => onReport(l)} showAsset={false} /> : <p className="muted">No reports yet.</p>}</>}
  </Sheet>
}

// =====================================================================================================
// One driver (ours, with or without an app login; or a carrier's)
// =====================================================================================================
function DriverSheet({ api, d, x0, flash, onClose, onSaved }: { api: FleetApi; d: FleetData; x0: Partial<Driver>; flash: Flash; onClose: () => void; onSaved: (m: string, keep?: boolean) => Promise<void> }) {
  const [x, setX] = useState<Partial<Driver>>(() => ({ asset_ids: [], active: true, ...x0 }))
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Driver>) => setX(s => ({ ...s, ...v }))
  const isCarrier = x.carrier_id != null
  const can = isCarrier ? d.carrier_admin : d.my_depts.includes((x0.department ?? x.department ?? 'distribution') as Dept)
  const carrier = d.carriers.find(c => c.id === x.carrier_id)
  const ours = d.assets.filter(a => a.carrier_id == null && a.status !== 'retired' && a.kind !== 'equipment' || (x.asset_ids ?? []).includes(a.id))
  const live = d.drivers.find(r => r.id === x.id)
  async function save() {
    setBusy(true)
    try { const { has_login: _h, ...p } = x as Driver; const id = await api.saveDriver(isCarrier ? { ...p, asset_ids: undefined } : p); if (!x.id) set({ id }); await onSaved(x.id ? 'Saved' : `${x.name} added`) }
    catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  async function invite() {
    if (!x.email?.trim()) { flash('Add their email first', true); return }
    setBusy(true)
    try {
      if (x.id) await api.saveDriver({ id: x.id, name: x.name, email: x.email })
      await api.addToApp(x.name ?? '', x.email, (x.department && x.department !== 'company' ? x.department : 'distribution'))
      await onSaved(`${x.name} is on the app. They sign in with their email${/@lifted-organics\.com$/i.test(x.email) ? ' (Microsoft)' : ' and a code'}.`, true)
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const txt = (k: keyof Driver, l: string, hint?: string, ph?: string) => <F label={l} hint={hint}><TextIn value={x[k] as string | null} placeholder={ph} onChange={v => set({ [k]: v } as Partial<Driver>)} /></F>
  return <Sheet title={x.id ? x.name : isCarrier ? `New ${carrier?.name ?? 'carrier'} driver` : 'New driver'} sub={isCarrier ? carrier?.name : x.department ? DEPT_L[x.department] : undefined} onClose={onClose}>
    <fieldset disabled={!can} className="fset">
      <div className="grid2">
        {txt('name', 'Name')}
        {!isCarrier && <F label="Department"><Pick value={(x.department ?? 'distribution') as Dept} options={DEPTS.filter(k => d.my_depts.includes(k) || k === x.department).map(k => ({ v: k, l: DEPT_L[k] }))} onChange={v => set({ department: v })} /></F>}
        {txt('phone', 'Phone')}
        {!isCarrier && txt('email', 'Email', 'their app login', 'name@…')}
        {txt('license_no', "Driver's license #")}
        {txt('license_class', 'Class', 'C, B, A…')}
        <F label="License expires" hint="shows on Deadlines"><DateIn value={x.license_expires} onChange={v => set({ license_expires: v })} /></F>
        <F label="Status"><Pick value={x.active === false ? 'off' : 'on'} options={[{ v: 'on', l: 'Active' }, { v: 'off', l: 'Inactive' }]} onChange={v => set({ active: v !== 'off' })} /></F>
      </div>
      {!isCarrier && <F label="Drives" hint="vehicles they drive">
        <div className="row wrap fchips">{ours.map(a => { const on = (x.asset_ids ?? []).includes(a.id)
          return <button type="button" key={a.id} className={`chip ${on ? 'on' : ''}`} onClick={() => set({ asset_ids: on ? (x.asset_ids ?? []).filter(i => i !== a.id) : [...(x.asset_ids ?? []), a.id] })}>{assetName(a)}</button> })}
          {!ours.length && <span className="muted small">No vehicles yet.</span>}</div></F>}
      <F label="Notes"><textarea value={x.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
    </fieldset>
    {!isCarrier && x.id && (live?.has_login ? <p className="okbox">On the app as {live.email}.</p>
      : can && <div className="infobox">Not on the app yet. {x.email ? <><button className="ghost small" disabled={busy} onClick={invite}>Add {x.name?.split(' ')[0]} to the app</button> as a {DEPT_L[(x.department && x.department !== 'company' ? x.department : 'distribution') as Dept]} User, so they can file vehicle reports.</> : 'Add their email to put them on the app.'}</div>)}
    {can ? <SaveBar busy={busy} onSave={save} onCancel={onClose} disabled={!x.name?.trim()} saveLabel={x.id ? 'Save' : 'Add'} /> : <p className="muted small">Only Compliance or this department's Admins can change drivers.</p>}
  </Sheet>
}

// =====================================================================================================
// One outside carrier: contact, license, insurance certificate, their trucks and drivers
// =====================================================================================================
function CarrierSheet({ api, d, x0, flash, onClose, onSaved }: { api: FleetApi; d: FleetData; x0: Partial<Carrier>; flash: Flash; onClose: () => void; onSaved: (m: string, keep?: boolean) => Promise<void> }) {
  const [x, setX] = useState<Partial<Carrier>>(() => ({ active: true, ...x0 }))
  const [busy, setBusy] = useState(false)
  const [truck, setTruck] = useState<Partial<Asset> | null>(null)
  const [drv, setDrv] = useState<Partial<Driver> | null>(null)
  const set = (v: Partial<Carrier>) => setX(s => ({ ...s, ...v }))
  const can = d.carrier_admin
  const trucks = d.assets.filter(a => a.carrier_id === x.id), drivers = d.drivers.filter(r => r.carrier_id === x.id)
  async function save() {
    setBusy(true)
    try { const { docs: _d, ...p } = x as Carrier; const id = await api.saveCarrier(p); if (!x.id) set({ id }); await onSaved(x.id ? 'Saved' : `${x.name} added. Add their trucks, drivers and insurance certificate below.`, true) }
    catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const txt = (k: keyof Carrier, l: string, hint?: string) => <F label={l} hint={hint}><TextIn value={x[k] as string | null} onChange={v => set({ [k]: v } as Partial<Carrier>)} /></F>
  return <Sheet wide title={x.id ? x.name : 'New outside carrier'} sub="Outside carrier" onClose={onClose}>
    <fieldset disabled={!can} className="fset">
      <div className="grid3">
        {txt('name', 'Company')}
        {txt('license_no', 'License #', 'their DCC distributor / transport license')}
        <F label="License expires" hint="shows on Deadlines"><DateIn value={x.license_expires} onChange={v => set({ license_expires: v })} /></F>
        {txt('contact_name', 'Contact')}{txt('phone', 'Phone')}{txt('email', 'Email')}
      </div>
      {txt('address', 'Address')}
      <F label="Notes"><textarea value={x.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
      {x.id && <label className="check"><input type="checkbox" checked={x.active !== false} onChange={e => set({ active: e.target.checked })} /> Active (off takes their trucks off the load list)</label>}
    </fieldset>
    {can ? <SaveBar busy={busy} onSave={save} onCancel={onClose} disabled={!x.name?.trim()} saveLabel={x.id ? 'Save' : 'Add'} /> : <p className="muted small">Only Compliance or a Distribution Admin can change carriers.</p>}
    {x.id && <>
      <AssetDocs api={api} refKind="carrier" refId={x.id} name={x.name ?? ''} site={null} can={can} flash={flash} onChanged={() => onSaved('Saved', true)}
        kinds={[{ key: 'insurance', l: 'Insurance certificate (COI)', add: 'Add insurance certificate' }, { key: 'partners', l: 'License', add: 'Add license copy' }]} />
      <div className="row between"><h3>Trucks</h3>{can && <button className="ghost small" onClick={() => setTruck({ kind: 'trailer', status: 'active', carrier_id: x.id, department: 'company', pallet_spaces: 24, pallets_across: 2 })}>+ Truck</button>}</div>
      {trucks.length ? <div className="clist">{trucks.map(a => <button key={a.id} className={`crow ${a.status === 'retired' ? 'retired' : ''}`} onClick={() => setTruck(a)}>
        <span className="grow"><b>{a.name}</b> <span className="muted">{[a.body_type, a.plate, a.pallet_spaces ? `${a.pallet_spaces} pallet spaces` : ''].filter(Boolean).join(' · ')}</span></span></button>)}</div>
        : <p className="muted">No trucks yet. Their trucks show up when you build a load.</p>}
      <div className="row between"><h3>Drivers</h3>{can && <button className="ghost small" onClick={() => setDrv({ carrier_id: x.id, active: true })}>+ Driver</button>}</div>
      {drivers.length ? <div className="clist">{drivers.map(r => <button key={r.id} className={`crow ${r.active ? '' : 'retired'}`} onClick={() => setDrv(r)}>
        <span className="grow"><b>{r.name}</b> <span className="muted">{[r.phone, r.license_no].filter(Boolean).join(' · ')}</span></span>{r.license_expires && <Expiry d={r.license_expires} warn={30} />}</button>)}</div>
        : <p className="muted">No drivers yet. They're only names here, never app users.</p>}
    </>}
    {truck && <AssetSheet api={api} d={d} a0={truck} flash={flash} paperwork={false} onClose={() => setTruck(null)} onSaved={async (m, keep) => { await onSaved(m, true); if (!keep) setTruck(null) }} onReport={() => {}} />}
    {drv && <DriverSheet api={api} d={d} x0={drv} flash={flash} onClose={() => setDrv(null)} onSaved={async (m, keep) => { await onSaved(m, true); if (!keep) setDrv(null) }} />}
  </Sheet>
}

function AssetDocs({ api, refKind, refId, name, site, can, flash, onChanged, kinds = DOC_KINDS }: {
  api: FleetApi; refKind: 'asset' | 'carrier'; refId: number; name: string; site: string | null; can: boolean; flash: Flash; onChanged: () => void; kinds?: { key: string; l: string; add: string }[]
}) {
  const assetId = refId
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [types, setTypes] = useState<DocType[]>([])
  const [adding, setAdding] = useState<{ key: string; files: File[] } | null>(null)
  const [linking, setLinking] = useState<{ key: string; all: Doc[] } | null>(null)
  const load = async () => { try { setDocs((await api.comp.docsFor(refKind, assetId)).filter(x => x.doc_type !== 'fleet')) } catch (e) { setDocs([]); flash(errText(e), true) } }
  useEffect(() => { load(); api.comp.docTypes().then(setTypes).catch(() => {}) }, [assetId])
  async function unlink(doc: Doc) {
    if (!confirm(`Take "${doc.title}" off ${name}? The document stays in the Library.`)) return
    try { await api.comp.link(doc.id, refKind, String(assetId), false); await load(); onChanged() } catch (e) { flash(errText(e), true) }
  }
  return <div className="fdocs">
    {kinds.map(k => {
      const ds = (docs ?? []).filter(x => x.doc_type === k.key)
      return <div key={k.key} className="cdoclist">
        <div className="cdl-h">{k.l}</div>
        {docs == null ? <p className="muted small">Loading…</p> : !ds.length ? <p className="muted small">No {k.l.toLowerCase()} on file.</p>
          : ds.map(doc => <div key={doc.id} className="row cdl-row"><FileChip api={api.comp} f={doc} flash={flash} sub={fmtD(doc.effective_on ?? doc.created_at)} />
            {doc.expires_on ? <Expiry d={doc.expires_on} /> : <span className="pill cp-warn">no expiry date</span>}
            {can && <button className="ghost small" title="Take off this vehicle" onClick={() => unlink(doc)}>✕</button>}</div>)}
        {can && <div className="row wrap">
          <DropZone compact onFiles={fs => setAdding({ key: k.key, files: fs })} label={k.add} />
          <button className="linkbtn small" onClick={async () => { try { setLinking({ key: k.key, all: (await api.comp.docs()).filter(x => x.doc_type === k.key && x.current) }) } catch (e) { flash(errText(e), true) } }}>
            {refKind === 'carrier' ? 'Pick one already in the Library' : k.key === 'insurance' ? 'Already uploaded? Add this vehicle to a policy' : 'Pick one already in the Library'}</button></div>}
      </div>
    })}
    {adding && <AddDocsSheet api={api.comp} files={adding.files} types={types} flash={flash} lockType
      preset={{ doc_type: adding.key, site, title: `${name} ${adding.key === 'insurance' ? (refKind === 'carrier' ? 'insurance certificate' : 'insurance') : refKind === 'carrier' ? 'license' : 'registration'}`, links: [{ kind: refKind, id: String(assetId) }] }}
      onClose={() => setAdding(null)} onDone={async () => { setAdding(null); await load(); onChanged() }} />}
    {linking && <Sheet title={linking.key === 'insurance' ? 'Add to a policy' : 'Pick a registration'} onClose={() => setLinking(null)}>
      {!linking.all.length ? <p className="muted">None in the Library yet.</p>
        : <div className="clist">{linking.all.map(doc => <button key={doc.id} className="crow" disabled={(docs ?? []).some(x => x.id === doc.id)} onClick={async () => {
          try { await api.comp.link(doc.id, refKind, String(assetId)); setLinking(null); await load(); onChanged(); flash(`${name} added to ${doc.title}`) } catch (e) { flash(errText(e), true) }
        }}><span className="grow"><b>{doc.title}</b> <span className="muted">{doc.site ?? ''}</span></span>{doc.expires_on && <Expiry d={doc.expires_on} />}</button>)}</div>}
    </Sheet>}
  </div>
}

// =====================================================================================================
// One report: maintenance, inspection or incident
// =====================================================================================================
type Ans = 'ok' | 'defect' | 'na'
interface Det {
  items?: Record<string, Ans>; item_notes?: Record<string, string>; defects?: string; by?: string; parts?: string
  location?: string; people?: string; injuries?: boolean; injury_notes?: string; damage?: string; police_report?: string; witnesses?: string; actions?: string; vehicle_other?: string
}

export function ReportSheet({ api, d, x0, flash, onClose, onSaved }: { api: FleetApi; d: FleetData; x0: Partial<Log>; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState<Partial<Log>>(() => ({ happened_on: today(), ...x0 }))
  const [det, setDet] = useState<Det>(() => ({ ...((x0.details ?? {}) as Det) }))
  const [files, setFiles] = useState<File[]>([])
  const [saved, setSaved] = useState<Doc[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const set = (v: Partial<Log>) => setX(s => ({ ...s, ...v }))
  const sd = (v: Partial<Det>) => setDet(s => ({ ...s, ...v }))
  const kind = x.kind as LogKind
  const a = d.assets.find(y => y.id === x.asset_id)
  const isNew = !x.id
  const mineToday = x.created_by === d.me && !!x.created_at && Date.now() - new Date(x.created_at).getTime() < 86400000
  const canSave = isNew || d.can_edit || mineToday
  const canPhoto = isNew || d.can_edit || x.created_by === d.me
  const cl: Checklist | undefined = d.checklists.find(c => c.key === (a?.checklist ?? a?.kind ?? 'vehicle'))
  const items = det.items ?? {}
  const defects = cl?.items.filter(i => items[i.k] === 'defect') ?? []
  const unanswered = cl?.items.filter(i => !items[i.k]) ?? []
  useEffect(() => { if (x.id) api.files(x.id).then(setSaved).catch(() => setSaved([])) }, [x.id])
  // the result follows the checklist until someone picks one
  useEffect(() => { if (kind === 'inspection' && isNew && x.result !== 'out_of_service') set({ result: defects.length ? 'defects' : unanswered.length ? undefined : 'pass' }) }, [defects.length, unanswered.length])

  // the vehicles this person drives come first
  const mine = new Set(d.drivers.filter(r => r.email && r.email === d.me).flatMap(r => r.asset_ids))
  const assetOpts = d.assets.filter(y => (y.carrier_id == null && y.status !== 'retired') || y.id === x.asset_id)
    .sort((p, q) => Number(mine.has(q.id)) - Number(mine.has(p.id)) || assetName(p).localeCompare(assetName(q)))
    .map(y => ({ v: y.id, l: `${mine.has(y.id) ? '★ ' : ''}${assetName(y)}${y.status === 'out_of_service' ? ` (${t('out of service')})` : ''}` }))
  const missing = kind !== 'incident' && !x.asset_id ? t('Pick the vehicle or equipment')
    : kind === 'inspection' && !x.result ? (unanswered.length ? t('{n} checklist items left', { n: unanswered.length }) : t('Pick the result'))
    : kind !== 'inspection' && !x.summary?.trim() ? (kind === 'incident' ? t('Say what happened') : t('Say what was done')) : null

  async function save() {
    setBusy(t('Saving…'))
    try {
      const summary = kind === 'inspection' && !x.summary?.trim() ? `${t(RESULT_L[x.result as InspResult])}${defects.length ? `: ${defects.map(i => t(i.l)).join(', ')}` : ''}` : x.summary
      const id = await api.saveLog({ ...x, summary, details: det, files: undefined })
      if (files.length) await api.addFiles(id, files, s => setBusy(t('Uploading photos {s}', { s })))
      await onSaved(isNew ? (kind === 'incident' ? t('Incident reported. Compliance will follow up.') : t('Report saved')) : t('Saved'))
    } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  async function addNow(fs: File[]) {
    if (!x.id) { setFiles(f => [...f, ...fs]); return }
    setBusy(t('Uploading…'))
    try { await api.addFiles(x.id, fs, s => setBusy(t('Uploading photos {s}', { s }))); setSaved(await api.files(x.id)); flash(t('Photos added')) } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  async function close(reopen = false) {
    setBusy('…')
    try { await api.closeLog(x.id!, note, reopen); await onSaved(reopen ? 'Reopened' : 'Closed') } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  async function del() {
    setBusy('…')
    try { await api.deleteLog(x.id!); await onSaved(t('Report removed')) } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  async function pdf() {
    try { const b = await reportPdf(x as Log, det as Record<string, unknown>, a, cl, saved ?? []); const u = URL.createObjectURL(b); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000) } catch (e) { flash(errText(e), true) }
  }
  const title = isNew ? (kind === 'incident' ? t('Report an incident') : kind === 'inspection' ? t('New inspection') : t('New maintenance')) : `${t(LOG_L[kind])} · ${fmtD(x.happened_on)}`
  const rd = reading(a)
  const ta = (k: keyof Det, l: string, ph?: string) => <F label={t(l)}><textarea value={(det[k] as string) ?? ''} placeholder={ph ? t(ph) : undefined} onChange={e => sd({ [k]: e.target.value } as Partial<Det>)} /></F>
  return <Sheet wide title={title} sub={!isNew ? `${assetName(a)}${x.created_by ? ` · ${t('by {w}', { w: who(x.created_by) })}` : ''}` : undefined} onClose={onClose}>
    {!isNew && x.status === 'open' && <div className={kind === 'incident' ? 'warnbox' : 'infobox'}>{kind === 'incident' ? t('Open: Compliance is following up.') : t('Open: defects to fix.')}</div>}
    {!isNew && x.status === 'closed' && x.closed_at && <div className="okbox">{t('Closed {d} by {w}', { d: fmtD(x.closed_at), w: who(x.closed_by) })}{x.closed_note ? `: ${x.closed_note}` : ''}</div>}
    {!canSave && <p className="muted small">{t('View only. Only Compliance can change a report after the day it was filed.')}</p>}
    <fieldset disabled={!canSave || !!busy} className="fset">
      <div className="grid3">
        <F label={kind === 'incident' ? t('Vehicle or equipment (if any)') : t('Vehicle or equipment')}><Pick value={x.asset_id ?? null} blank={kind === 'incident' ? t('None / other') : t('Pick one…')} options={assetOpts} onChange={v => set({ asset_id: v })} /></F>
        <F label={t('Date')}><DateIn value={x.happened_on} onChange={v => set({ happened_on: v ?? today() })} /></F>
        {kind === 'incident' ? <F label={t('Time')}><input type="time" value={x.happened_at?.slice(0, 5) ?? ''} onChange={e => set({ happened_at: e.target.value || null })} /></F>
          : a && a.kind !== 'trailer' || kind === 'maintenance' ? <F label={rd === 'odometer' ? t('Odometer (mi)') : t('Hours')} hint={a?.[rd] ? t('last {n}', { n: n0(a[rd]) }) : undefined}>
            <NumIn value={x[rd] ?? null} onChange={v => set({ [rd]: v } as Partial<Log>)} /></F> : null}
      </div>

      {kind === 'inspection' && <>
        {!a ? <p className="muted">{t('Pick the vehicle or equipment to see its checklist.')}</p> : !cl ? <p className="muted">{t('No checklist set for this one.')}</p> : <>
          <div className="row between"><h3>{t(cl.label)}</h3>
            {canSave && <button type="button" className="linkbtn small" onClick={() => sd({ items: Object.fromEntries(cl.items.map(i => [i.k, items[i.k] === 'defect' ? 'defect' : 'ok'])) })}>{t('Mark the rest OK')}</button>}</div>
          <div className="fcheck">{cl.items.map(i => <div key={i.k} className={`fci ${items[i.k] ?? ''}`}>
            <span className="grow">{t(i.l)}</span>
            <span className="fcb">{(['ok', 'defect', 'na'] as Ans[]).map(v => <button type="button" key={v} className={items[i.k] === v ? `on ${v}` : ''}
              onClick={() => sd({ items: { ...items, [i.k]: v } })}>{v === 'ok' ? t('OK') : v === 'defect' ? t('Problem') : t('N/A')}</button>)}</span>
            {items[i.k] === 'defect' && <input className="fcnote" placeholder={t('What\'s wrong?')} value={det.item_notes?.[i.k] ?? ''} onChange={e => sd({ item_notes: { ...(det.item_notes ?? {}), [i.k]: e.target.value } })} />}
          </div>)}</div>
          <F label={t('Result')}><Choices value={(x.result ?? '') as InspResult} options={[{ v: 'pass', l: t('Passed') }, { v: 'defects', l: t('Defects found') }, { v: 'out_of_service', l: t('Out of service') }]} onChange={v => set({ result: v })} /></F>
          {x.result === 'out_of_service' && <p className="small neg">{t('Not safe to use. It shows as out of service until Compliance puts it back.')}</p>}
          {ta('defects', 'Other notes')}
        </>}
      </>}

      {kind === 'maintenance' && <>
        <F label={t('What was done')}><TextIn value={x.summary} onChange={v => set({ summary: v })} placeholder={t('Oil change, new tires, brake pads…')} /></F>
        {ta('parts', 'Parts and details')}
        <div className="grid3">
          <F label={t('Done by')}><TextIn value={x.performed_by} onChange={v => set({ performed_by: v })} placeholder={t('our crew or shop name')} /></F>
          <F label={t('Shop / vendor')}><TextIn value={x.vendor} onChange={v => set({ vendor: v })} /></F>
          <F label={t('Cost ($)')}><NumIn value={x.cost ?? null} onChange={v => set({ cost: v })} /></F>
        </div>
        <h3>{t('Next service')}</h3>
        <div className="grid3">
          <F label={t('Due date')}><DateIn value={x.next_due_on} onChange={v => set({ next_due_on: v })} /></F>
          {rd === 'odometer' ? <F label={t('Due at (mi)')}><NumIn value={x.next_due_miles ?? null} onChange={v => set({ next_due_miles: v })} /></F>
            : <F label={t('Due at (hours)')}><NumIn value={x.next_due_hours ?? null} onChange={v => set({ next_due_hours: v })} /></F>}
        </div>
      </>}

      {kind === 'incident' && <>
        <F label={t('What happened')}><TextIn value={x.summary} onChange={v => set({ summary: v })} placeholder={t('One line, e.g. backed into the gate post at GVR')} /></F>
        {ta('actions', 'Full description', 'What happened, step by step')}
        <div className="grid2">
          <F label={t('Where')}><TextIn value={det.location} onChange={v => sd({ location: v ?? '' })} /></F>
          <F label={t('People involved')}><TextIn value={det.people} onChange={v => sd({ people: v ?? '' })} /></F>
        </div>
        <F label={t('Anyone hurt?')}><Choices value={det.injuries == null ? '' : det.injuries ? 'yes' : 'no'} options={[{ v: 'no', l: t('No') }, { v: 'yes', l: t('Yes') }]} onChange={v => sd({ injuries: v === 'yes' })} /></F>
        {det.injuries && ta('injury_notes', 'Who and what kind of injury')}
        {det.injuries && <p className="small neg">{t('Get care first. Tell your supervisor right away.')}</p>}
        {ta('damage', 'Damage', 'Our vehicle or equipment, other vehicles, property')}
        <div className="grid2">
          <F label={t('Other vehicle (plate, driver, insurance)')}><TextIn value={det.vehicle_other} onChange={v => sd({ vehicle_other: v ?? '' })} /></F>
          <F label={t('Police report #')}><TextIn value={det.police_report} onChange={v => sd({ police_report: v ?? '' })} /></F>
        </div>
        <F label={t('Witnesses')}><TextIn value={det.witnesses} onChange={v => sd({ witnesses: v ?? '' })} /></F>
      </>}
    </fieldset>

    <h3>{t('Photos and files')}</h3>
    {saved && saved.length > 0 && <div className="cdoclist">{saved.map(f => <div key={f.id} className="row cdl-row"><FileChip api={api.comp} f={f} flash={flash} /></div>)}</div>}
    {files.length > 0 && <div className="ffiles">{files.map((f, i) => <span key={i} className="pill cp-mute">{f.name} <a onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}>✕</a></span>)}</div>}
    {canPhoto && !busy && <DropZone compact onFiles={addNow} label={t('Take photos of the damage, defects or receipts')} accept="image/*,application/pdf" />}
    {busy && <p className="muted">{busy}</p>}

    {canSave && <SaveBar busy={!!busy} onSave={save} onCancel={onClose} disabled={!!missing} saveLabel={isNew ? (kind === 'incident' ? t('Send report') : t('Save report')) : t('Save')}
      onDelete={!isNew ? del : undefined} />}
    {missing && canSave && <p className="muted small right">{missing}</p>}
    {!canSave && <div className="row"><button className="ghost" onClick={onClose}>{t('Close')}</button></div>}
    {!isNew && <div className="row wrap fclose">
      <button className="ghost small" onClick={pdf}>PDF</button>
      {d.can_edit && x.status === 'open' && <><input placeholder="How it was fixed / followed up" value={note} onChange={e => setNote(e.target.value)} />
        <button className="primary small" disabled={!!busy || !note.trim()} onClick={() => close()}>Close it</button></>}
      {d.can_edit && x.status === 'closed' && (kind === 'incident' || x.result !== 'pass') && <button className="ghost small" disabled={!!busy} onClick={() => close(true)}>Reopen</button>}
    </div>}
  </Sheet>
}

