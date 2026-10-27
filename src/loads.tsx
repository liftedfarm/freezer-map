import { ListInput, Select } from './combo'
import { ScanButton } from './scan'
import { sameTag, useScanHandler } from './scanroute'
import { useEffect, useMemo, useState } from 'react'
import { metrcRun } from './metrcCall'
import type { AppTransfer, StopCheckRow } from './metrcCall'
import type { SupabaseClient } from '@supabase/supabase-js'
import { lbs } from './forms'
import type { Customer, FOrder, Load, LoadDriver, LoadItem, LoadStop, Pallet, StopInput, StopManifest, Vehicle } from './types'
import { STATE_LABEL, orderGot, orderLbs } from './fulfill'

// Everything the transit screens need from the app, passed in to avoid circular imports.
export interface LoadCtx {
  loads: Load[]; stops: LoadStop[]; items: LoadItem[]
  vehicles: Vehicle[]; customers: Customer[]; drivers?: LoadDriver[]
  pallet: (id: number) => Pallet | undefined
  contents: (id: number) => Pallet[]
  weight: (p: Pallet) => number
  where: (p: Pallet) => string
  freezerSpot: (slotId: number | null) => string
  available: Pallet[]                          // top-level pallets in a freezer (or received at a site) and not on an open load
  siteOf: (p: Pallet) => string | null         // OHR / GVR: the freezer it's in, or where it was received
  held: (id: number) => string | undefined     // "Customer · SO" when held for an order
  busy: boolean
  run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>
  confirm: (text: string, ok: string, fn: () => Promise<void>) => void
  openPallet: (id: number) => void
  putBack: (item: LoadItem, p: Pallet) => void // start "tap a freezer slot" for a loaded pallet
  orders?: FOrder[]                            // Fulfillment orders (confirmed): which stop each one is on
  openOrder?: (id: number) => void             // open the order in Distribution > Fulfillment
  refreshOrders?: () => Promise<void>
  api: {
    createLoad(v: number, d: string, s: StopInput[], driver: string, notes: string): Promise<Load>
    updateLoad(id: number, v: number, d: string, driver: string, notes: string): Promise<void>
    setStops(id: number, s: StopInput[]): Promise<void>
    planPallet(l: number, s: number, p: number, pos: number | null, share: boolean): Promise<void>
    moveItem(i: number, pos: number | null, s: number | null, share: boolean): Promise<void>
    arrangeLoad(l: number): Promise<void>
    removeItem(i: number): Promise<void>
    loadPallet(i: number): Promise<void>
    departLoad(l: number): Promise<void>
    deliverStop(s: number): Promise<void>
    cancelLoad(l: number): Promise<void>
    stackTop(i: number): Promise<void>
    orderToLoad(orderId: number, loadId: number): Promise<void>
    orderOffLoad(orderId: number): Promise<void>
    stopManifest(s: number): Promise<StopManifest>
    client(): SupabaseClient | null
  }
}

type Lic = { license_no: string; kind: string; site: string | null; hub: boolean; sort: number; active: boolean }
/** the license a site's freezers sit under: the hub there (GVR processor), else the site's cultivation license (same rule as site_license() in 045) */
export function siteLicense(lics: Lic[], site: string) {
  const c = lics.filter(l => l.active && (l.site ?? '').toUpperCase() === site.toUpperCase() && ['processor', 'distributor', 'cultivation'].includes(l.kind))
    .sort((a, b) => Number(b.hub) - Number(a.hub) || Number(b.kind === 'processor') - Number(a.kind === 'processor') || a.sort - b.sort || a.license_no.localeCompare(b.license_no))
  return c[0]?.license_no ?? null
}

export const STOP_COLORS = ['#2563eb', '#d97706', '#16a34a', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#65a30d']
export const stopColor = (seq: number) => STOP_COLORS[(seq - 1) % STOP_COLORS.length]
const STATUS: Record<string, string> = { planning: 'Planning', loading: 'Loading', in_transit: 'In transit', delivered: 'Delivered', cancelled: 'Cancelled' }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const fmtDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const editable = (l: Load) => l.status === 'planning' || l.status === 'loading'

const n0 = (x: number) => Math.round(Number(x)).toLocaleString()
const soOf = (o: FOrder) => o.so ?? `Order #${o.id}`
const palletIds = (o: FOrder) => o.lines.flatMap(l => l.picks.map(pk => pk.pallet_id))
/** orders for a customer that aren't on a load yet (not shipped/cancelled) */
const notLoaded = (ctx: LoadCtx, customerId: number) => (ctx.orders ?? []).filter(o => o.customer_id === customerId && !o.stop && ['open', 'needs_ok', 'ready'].includes(o.state))
/** put orders on a load, then refresh Fulfillment so both sides match */
async function attachOrders(ctx: LoadCtx, loadId: number, ids: number[]) {
  for (const id of ids) await ctx.api.orderToLoad(id, loadId)
  await ctx.refreshOrders?.()
}

function label(ctx: LoadCtx, p: Pallet) {
  if (p.kind === 'mixed') { const c = ctx.contents(p.id); return `Mixed · ${c.length} pkg${c.length === 1 ? '' : 's'}` }
  return p.strain ?? p.label ?? ''
}

// ---------- list ----------

export function TransitView({ ctx, onOpen, onNew }: { ctx: LoadCtx; onOpen: (id: number) => void; onNew: () => void }) {
  const open = ctx.loads.filter(l => l.status !== 'delivered' && l.status !== 'cancelled')
  const done = ctx.loads.filter(l => l.status === 'delivered' || l.status === 'cancelled')
  const card = (l: Load) => {
    const v = ctx.vehicles.find(x => x.id === l.vehicle_id)
    const st = ctx.stops.filter(s => s.load_id === l.id).sort((a, b) => a.seq - b.seq)
    const it = ctx.items.filter(i => i.load_id === l.id)
    const w = it.reduce((a, i) => { const p = ctx.pallet(i.pallet_id); return a + (p ? ctx.weight(p) : 0) }, 0)
    return (
      <button key={l.id} className="li loadcard" onClick={() => onOpen(l.id)}>
        <div className="row between"><b>{l.code}</b><span className={`pill s-${l.status}`}>{STATUS[l.status]}</span></div>
        <div>{v?.name ?? 'Vehicle?'} · {fmtDate(l.load_date)}{l.driver ? ` · ${l.driver}` : ''}</div>
        <div className="stopline">
          {st.map(s => <span key={s.id} className={`stopchip ${s.status}`} style={{ ['--sc' as string]: stopColor(s.seq) }}>{s.seq}. {ctx.customers.find(c => c.id === s.customer_id)?.name}</span>)}
        </div>
        {(() => {
          const os = (ctx.orders ?? []).filter(o => o.stop && st.some(s => s.id === o.stop!.id))
          return os.length > 0 && <div className="muted small">Orders: {os.map(o => `${soOf(o)} ${o.customer}`).join(' · ')}</div>
        })()}
        <div className="muted">{it.length}/{v?.spaces ?? '?'} positions used · {it.filter(i => i.loaded).length} loaded · {lbs(w)}</div>
      </button>
    )
  }
  return (
    <div className="list">
      <div className="row between"><h2>Transit</h2><button className="primary" onClick={onNew}>+ New load</button></div>
      {open.length === 0 && <p className="muted">No active loads. Tap New load to plan one.</p>}
      {open.map(card)}
      {done.length > 0 && <><h3>Last 14 days</h3>{done.map(card)}</>}
    </div>
  )
}

// ---------- create / edit ----------

export function LoadForm({ ctx, load, onClose, onSaved }: { ctx: LoadCtx; load?: Load; onClose: () => void; onSaved: (id: number) => void }) {
  const vehicles = ctx.vehicles.filter(v => v.active || v.id === load?.vehicle_id)
  const customers = ctx.customers.filter(c => c.active)
  const existing = load ? ctx.stops.filter(s => s.load_id === load.id).sort((a, b) => a.seq - b.seq) : []
  const [vehicle, setVehicle] = useState<number | null>(load?.vehicle_id ?? vehicles[0]?.id ?? null)
  const [date, setDate] = useState(load?.load_date ?? today())
  const [driver, setDriver] = useState(load?.driver ?? '')
  const [notes, setNotes] = useState(load?.notes ?? '')
  const [stops, setStops] = useState<(StopInput & { delivered?: boolean })[]>(existing.map(s => ({ id: s.id, customer_id: s.customer_id, manifest: s.manifest ?? '', delivered: s.status === 'delivered' })))
  // ready orders to put on this load when it's saved (ticked by default for stops added here)
  const [attach, setAttach] = useState<Set<number>>(new Set())
  const addStop = (id: number) => {
    setStops(s => [...s, { customer_id: id, manifest: '' }])
    const ready = notLoaded(ctx, id).filter(o => o.state === 'ready').map(o => o.id)
    if (ready.length) setAttach(a => new Set([...a, ...ready]))
  }
  const removeStop = (i: number) => {
    const cid = stops[i]?.customer_id
    setStops(st => st.filter((_, j) => j !== i))
    if (cid != null && !stops.some((x, j) => j !== i && x.customer_id === cid)) setAttach(a => new Set([...a].filter(id => (ctx.orders ?? []).find(o => o.id === id)?.customer_id !== cid)))
  }
  const toggleAttach = (id: number) => setAttach(a => { const n = new Set(a); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const move = (i: number, d: number) => setStops(s => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n })
  const ok = vehicle != null && stops.length > 0
  async function save() {
    const clean = stops.map(({ delivered: _d, ...s }) => s)
    const ids = [...attach].filter(id => { const o = (ctx.orders ?? []).find(x => x.id === id); return o && o.state === 'ready' && !o.stop && clean.some(s => s.customer_id === o.customer_id) })
    const withOrders = ids.length ? ` with ${ids.length} order${ids.length === 1 ? '' : 's'}` : ''
    if (load) {
      const a = await ctx.run(() => ctx.api.updateLoad(load.id, vehicle!, date, driver, notes), 'Load updated')
      if (a && await ctx.run(async () => { await ctx.api.setStops(load.id, clean); if (ids.length) await attachOrders(ctx, load.id, ids) }, `Stops saved${withOrders}`)) onSaved(load.id)
    } else {
      let id = 0
      if (await ctx.run(async () => { id = (await ctx.api.createLoad(vehicle!, date, clean, driver, notes)).id; if (ids.length) await attachOrders(ctx, id, ids) }, `Load created${withOrders}`)) onSaved(id)
    }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{load ? `Edit ${load.code}` : 'New load'}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="field"><label>Vehicle</label>
          <div className="choices col">
            {vehicles.map(v => (
              <button key={v.id} className={vehicle === v.id ? 'on' : ''} onClick={() => setVehicle(v.id)}>
                <b>{v.name}</b> <span className="muted">· {v.spaces} spaces{v.owner && v.owner !== 'Lifted' ? ` · ${v.owner}` : ''}</span>
              </button>
            ))}
            {vehicles.length === 0 && <span className="muted">Add vehicles in Distribution › Settings › Vehicles first.</span>}
          </div>
        </div>
        <div className="field"><label>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
        <div className="field"><label>Stops, in delivery order</label>
          {stops.map((s, i) => (
            <div key={i} className="stoprow" style={{ ['--sc' as string]: stopColor(i + 1) }}>
              <span className="stopnum">{i + 1}</span>
              <div className="grow">
                <b>{customers.find(c => c.id === s.customer_id)?.name ?? ctx.customers.find(c => c.id === s.customer_id)?.name}</b>{s.delivered && <span className="muted"> · delivered</span>}
                <input placeholder="Manifest # (optional)" value={s.manifest} onChange={e => setStops(st => st.map((x, j) => j === i ? { ...x, manifest: e.target.value } : x))} />
                {stops.findIndex(x => x.customer_id === s.customer_id) === i && (() => {
                  const on = s.id != null ? (ctx.orders ?? []).filter(o => o.stop?.id === s.id) : []
                  const waiting = notLoaded(ctx, s.customer_id)
                  if (!on.length && !waiting.length) return null
                  return <div className="stoporders">
                    {on.map(o => <div key={o.id} className="small ok-t">✓ {soOf(o)} on this stop · {n0(orderGot(o))} lbs</div>)}
                    {waiting.map(o => o.state === 'ready'
                      ? <label key={o.id} className="sattach"><input type="checkbox" checked={attach.has(o.id)} onChange={() => toggleAttach(o.id)} />
                          <span>Load <b>{soOf(o)}</b> <span className="muted">· {n0(orderGot(o))} lbs · {o.lines.length} strain{o.lines.length === 1 ? '' : 's'}</span></span></label>
                      : <div key={o.id} className="small muted">{soOf(o)} · {STATE_LABEL[o.state]} ({n0(orderGot(o))} of {n0(orderLbs(o))} lbs) · finish it in Fulfillment</div>)}
                  </div>
                })()}
              </div>
              <div className="stopbtns">
                <button className="ghost small" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="ghost small" disabled={i === stops.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="ghost small" disabled={s.delivered} onClick={() => removeStop(i)}>✕</button>
              </div>
            </div>
          ))}
          <StopSearch ctx={ctx} customers={customers} taken={new Set(stops.map(s => s.customer_id))} onPick={addStop} />
          {customers.filter(c => c.kind === 'external').length === 0 && <div className="muted small-note">No customers yet. Add them in Settings, Customers.</div>}
        </div>
        <div className="field"><label>Driver (optional)</label><ListInput list="load-drivers" value={driver} onChange={e => setDriver(e.target.value)} placeholder="Pick or type a name" />
          <datalist id="load-drivers">{(() => {
            const v = ctx.vehicles.find(x => x.id === vehicle)
            const ds = (ctx.drivers ?? []).filter(x => x.active && (v?.carrier_id != null ? x.carrier_id === v.carrier_id : x.carrier_id == null))
            return [...ds.filter(x => vehicle != null && x.asset_ids.includes(vehicle)), ...ds.filter(x => vehicle == null || !x.asset_ids.includes(vehicle))].map(x => <option key={x.id} value={x.name} />)
          })()}</datalist>
          <span className="muted small">Drivers are kept in Distribution › Settings › Vehicles.</span></div>
        <div className="field"><label>Notes (optional)</label><input value={notes} onChange={e => setNotes(e.target.value)} /></div>
        <div className="row end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ok || ctx.busy} onClick={save}>{load ? 'Save' : 'Create load'}</button>
        </div>
      </div>
    </div>
  )
}

// ---------- detail ----------

export function LoadView({ ctx, loadId, onBack, onEdit }: { ctx: LoadCtx; loadId: number; onBack: () => void; onEdit: () => void }) {
  const l = ctx.loads.find(x => x.id === loadId)
  const [placeItem, setPlaceItem] = useState<LoadItem | null>(null)
  const [picker, setPicker] = useState<{ stop: number | null; position: number | null; pre?: number; stack?: boolean } | null>(null)
  const [posOpen, setPosOpen] = useState<number | null>(null)
  const [lics, setLics] = useState<Lic[]>([])
  const [making, setMaking] = useState<number | null>(null)
  const [checks, setChecks] = useState<StopCheckRow[]>([])
  const [xfers, setXfers] = useState<AppTransfer[]>([])
  const [modes, setModes] = useState<Record<string, string>>({})
  const [checking, setChecking] = useState(false)
  const [openCheck, setOpenCheck] = useState<number | null>(null)
  useEffect(() => {
    const sb = ctx.api.client(); if (!sb) return
    sb.from('licenses').select('license_no, kind, site, hub, sort, active').then(({ data }) => setLics((data ?? []) as Lic[]))
    sb.from('metrc_push_kinds').select('kind,mode').in('kind', ['transfer', 'manifest']).then(({ data }) => setModes(Object.fromEntries((data ?? []).map(k => [k.kind, k.mode]))))
  }, [ctx.api])
  const stopIds = ctx.stops.filter(s => s.load_id === loadId).map(s => s.id)
  const loadMetrc = async () => {
    const sb = ctx.api.client(); if (!sb || !stopIds.length) return
    const [a, b] = await Promise.all([sb.from('metrc_stop_checks').select('*').in('stop_id', stopIds), sb.from('metrc_app_transfers').select('*').in('stop_id', stopIds)])
    setChecks((a.data ?? []) as StopCheckRow[]); setXfers((b.data ?? []) as AppTransfer[])
  }
  useEffect(() => { loadMetrc() }, [loadId, stopIds.join(',')])
  async function runChecks() {
    const sb = ctx.api.client(); if (!sb || !l) return
    setChecking(true)
    await ctx.run(async () => { await metrcRun(sb, { action: 'checklist', load_id: l.id }); await loadMetrc() }, 'METRC check done')
    setChecking(false)
  }
  async function depart() {
    if (!l) return
    if (await ctx.run(() => ctx.api.departLoad(l.id), `${l.code} in transit`)) {
      const sb = ctx.api.client()
      if (sb && (modes.transfer === 'auto' || modes.manifest === 'auto')) {
        await ctx.run(async () => {
          const r = await metrcRun<{ live: boolean; results: { state: string; info?: string; error?: string }[] }>(sb, { action: 'depart', load_id: l.id })
          await loadMetrc()
          const bad = r.results.find(x => x.state === 'failed')
          if (bad) throw new Error(`METRC manifest not made: ${bad.error}`)
        }, 'METRC manifests made')
      }
    }
  }
  // Scan while loading: a planned pallet is marked on the truck; one that isn't on this load can be added
  useScanHandler(l && editable(l) ? tag => {
    const its = ctx.items.filter(i => i.load_id === l.id)
    const it = its.find(i => sameTag(ctx.pallet(i.pallet_id)?.package_tag, tag) || ctx.contents(i.pallet_id).some(c => sameTag(c.package_tag, tag)))
    if (it) {
      const p = ctx.pallet(it.pallet_id)
      if (it.loaded) setPosOpen(it.position)
      else ctx.run(() => ctx.api.loadPallet(it.id), `${p?.code ?? 'Pallet'} on the truck · position ${it.position}`)
      return true
    }
    const p = ctx.available.find(x => sameTag(x.package_tag, tag))
    if (p) { setPicker({ stop: null, position: null, pre: p.id }); return true }
    return false
  } : null)
  if (!l) return <div className="list"><button className="ghost" onClick={onBack}>‹ Transit</button><p className="muted">Load not found.</p></div>
  const v = ctx.vehicles.find(x => x.id === l.vehicle_id)
  const stops = ctx.stops.filter(s => s.load_id === l.id).sort((a, b) => a.seq - b.seq)
  const items = ctx.items.filter(i => i.load_id === l.id)
  const stopOf = (id: number) => stops.find(s => s.id === id)
  const cust = (s?: LoadStop) => ctx.customers.find(c => c.id === s?.customer_id)
  const totalW = items.reduce((a, i) => { const p = ctx.pallet(i.pallet_id); return a + (p ? ctx.weight(p) : 0) }, 0)
  const unloaded = items.filter(i => !i.loaded).length
  const canEdit = editable(l)
  const spaces = v?.spaces ?? 0, across = v?.across ?? 2
  const rows = Math.ceil(spaces / across)
  // stops the app sends to METRC need a green checklist from the last hour before Depart (depart_load checks it too)
  const internalStop = (s: LoadStop) => { const c = cust(s); return c?.kind === 'internal' && ['OHR', 'GVR'].includes((c?.name ?? '').toUpperCase()) }
  const fresh = (iso: string) => Date.now() - new Date(iso).getTime() < 60 * 60000
  const metrcOn = stops.some(s => s.status === 'pending' && (modes[internalStop(s) ? 'transfer' : 'manifest'] ?? 'off') !== 'off')
  const metrcBlock = stops.filter(s => s.status === 'pending' && items.some(i => i.stop_id === s.id) && (modes[internalStop(s) ? 'transfer' : 'manifest'] ?? 'off') !== 'off')
    .filter(s => { const cs = checks.filter(x => x.stop_id === s.id); return !cs.length || cs.some(x => !x.ok || !fresh(x.checked_at)) }).map(s => s.seq)

  function tapPos(pos: number) {
    const here = items.filter(i => i.position === pos)
    if (placeItem) {
      const it = placeItem
      if (pos === it.position) { setPlaceItem(null); return }
      const others = here.filter(i => i.id !== it.id)
      const go = async () => { setPlaceItem(null); await ctx.run(() => ctx.api.moveItem(it.id, pos, null, others.length > 0), `Moved to position ${pos}`) }
      if (others.length) ctx.confirm(`Position ${pos} has ${others.map(o => ctx.pallet(o.pallet_id)?.code).join(', ')}. Stack them?`, 'Stack', go)
      else go()
      return
    }
    if (here.length) setPosOpen(pos)
    else if (canEdit) setPicker({ stop: null, position: pos })
  }

  return (
    <div className="loadview">
      <div className="fz-head">
        <button className="ghost" onClick={onBack}>‹ Transit</button>
        <div className="fz-title">
          <h2>{l.code} <span className={`pill s-${l.status}`}>{STATUS[l.status]}</span></h2>
          <div className="muted">{v?.name} · {fmtDate(l.load_date)}{l.driver ? ` · ${l.driver}` : ''} · {items.length}/{spaces} positions · {lbs(totalW)}</div>
          {l.notes && <div className="muted">{l.notes}</div>}
        </div>
        {canEdit && <button className="ghost small" onClick={onEdit}>Edit</button>}
      </div>

      <div className="stops">
        {stops.map(s => {
          const its = items.filter(i => i.stop_id === s.id)
          const w = its.reduce((a, i) => { const p = ctx.pallet(i.pallet_id); return a + (p ? ctx.weight(p) : 0) }, 0)
          const c = cust(s)
          const site = c?.kind === 'internal' && ['OHR', 'GVR'].includes((c?.name ?? '').toUpperCase())
          const dest = site ? (c?.name ?? '').toUpperCase() : null
          const froms = [...new Set(its.map(i => { const p = ctx.pallet(i.pallet_id); return i.from_site ?? (p ? ctx.siteOf(p) : null) }).filter((x): x is string => !!x))].sort()
          const L = (st: string) => { const n = siteLicense(lics, st); return n ? `${st} ${n}` : st }
          const already = dest && froms.includes(dest)
          // orders riding on this stop, ready orders that could, and pallets that belong to no order
          const sOrders = (ctx.orders ?? []).filter(o => o.stop?.id === s.id)
          const waiting = canEdit && s.status === 'pending' && c?.kind === 'external' ? notLoaded(ctx, s.customer_id) : []
          const top = (id: number) => ctx.pallet(id)?.container_id ?? id
          const mine = new Set(sOrders.flatMap(palletIds).flatMap(id => [id, top(id)]))
          const loose = c?.kind === 'external' ? its.filter(i => !mine.has(i.pallet_id)).length : 0
          const carrying = site ? [...new Set(its.map(i => ctx.held(i.pallet_id)).filter((x): x is string => !!x))] : []
          return (
            <div key={s.id} className={`stopcard ${s.status}`} style={{ ['--sc' as string]: stopColor(s.seq) }}>
              <div className="row between">
                <div><span className="stopnum">{s.seq}</span> <b>{c?.name}</b>{s.manifest && <span className="muted"> · manifest {s.manifest}</span>}</div>
                {s.status === 'delivered'
                  ? <span className="pill s-delivered">Delivered</span>
                  : l.status === 'in_transit' && <button className="primary small" disabled={ctx.busy} onClick={() => ctx.confirm(
                      `Mark stop ${s.seq} (${c?.name}) delivered? ${its.length} pallet${its.length === 1 ? '' : 's'} ${site ? `will be received at ${c?.name} and need a freezer spot` : 'will leave inventory'}.`,
                      'Delivered', async () => { await ctx.run(() => ctx.api.deliverStop(s.id), `Stop ${s.seq} delivered`) })}>Mark delivered</button>}
              </div>
              <div className="muted">{its.length} pallet{its.length === 1 ? '' : 's'} · {lbs(w)}</div>
              {(sOrders.length > 0 || waiting.length > 0 || loose > 0 || carrying.length > 0) && <div className="stoporders">
                {sOrders.map(o => {
                  const ids = palletIds(o), tops = new Set(ids.map(top)), on = its.filter(i => tops.has(i.pallet_id)), onTruck = ids.filter(id => on.some(i => i.loaded && i.pallet_id === top(id))).length
                  return <div key={o.id} className="row sorderrow">
                    <button className="sorder" onClick={() => ctx.openOrder?.(o.id)}>
                      <span><b>{soOf(o)}</b> <span className="muted">· {n0(orderGot(o))} lbs · {o.lines.length} strain{o.lines.length === 1 ? '' : 's'}</span></span>
                      <span className="muted">{s.status === 'delivered' ? 'shipped' : `${onTruck}/${ids.length} on truck`} ›</span>
                    </button>
                    {canEdit && s.status === 'pending' && <button className="ghost small" disabled={ctx.busy || onTruck > 0} title={onTruck ? 'Put its pallets back in a freezer first' : 'Take this order off the load'}
                      onClick={() => ctx.confirm(`Take ${soOf(o)} off ${l.code}? Its pallets come off the truck plan and it goes back to Ready in Fulfillment.`, 'Take off',
                        async () => { await ctx.run(async () => { await ctx.api.orderOffLoad(o.id); await ctx.refreshOrders?.() }, `${soOf(o)} taken off ${l.code}`) })}>Take off</button>}
                  </div>
                })}
                {waiting.map(o => o.state === 'ready'
                  ? <div key={o.id} className="sorder ready"><span><b>{soOf(o)}</b> <span className="muted">· ready · {n0(orderGot(o))} lbs</span></span>
                      <button className="primary small" disabled={ctx.busy} onClick={() => ctx.run(() => attachOrders(ctx, l.id, [o.id]), `${soOf(o)} on ${l.code}`)}>+ Add to stop</button></div>
                  : <button key={o.id} className="sorder" onClick={() => ctx.openOrder?.(o.id)}><span><b>{soOf(o)}</b> <span className="muted">· {STATE_LABEL[o.state]} · {n0(orderGot(o))} of {n0(orderLbs(o))} lbs</span></span><span className="muted">Fulfillment ›</span></button>)}
                {loose > 0 && <div className="small-note warn-t">{loose} pallet{loose === 1 ? " isn't" : "s aren't"} on any order for {c?.name}, so {loose === 1 ? "it won't" : "they won't"} be invoiced. Put {loose === 1 ? 'it' : 'them'} on an order in Fulfillment.</div>}
                {carrying.length > 0 && <div className="small-note muted">Carrying pallets held for {carrying.join(', ')}</div>}
              </div>}
              {its.length > 0 && <div className={`small-note lic ${froms.length > 1 || already ? 'warn-t' : 'muted'}`}>
                {dest ? <>Transfer: {froms.map(L).join(' + ') || '?'} → <b>{L(dest)}</b>{already ? ` · some of these are already at ${dest}` : ''}</>
                  : <>Ships from {froms.map(L).join(' and ') || '?'}{froms.length > 1 ? ' · two licenses means two METRC manifests' : ''}</>}
              </div>}
              {its.length > 0 && <StopMetrc checks={checks.filter(x => x.stop_id === s.id)} xfers={xfers.filter(x => x.stop_id === s.id)}
                on={modes[site ? 'transfer' : 'manifest'] ?? 'off'} open={openCheck === s.id} onToggle={() => setOpenCheck(o => o === s.id ? null : s.id)} pending={s.status === 'pending'} />}
              <div className="row">
                {canEdit && <button className="ghost small" onClick={() => setPicker({ stop: s.id, position: null })}>+ Add pallets</button>}
                {its.length > 0 && <button className="ghost small" disabled={making === s.id} onClick={async () => {
                  setMaking(s.id)
                  try {
                    const m = await ctx.api.stopManifest(s.id)
                    const { manifestPdf, manifestFile } = await import('./manifest')
                    const url = URL.createObjectURL(await manifestPdf(m))
                    const a = document.createElement('a'); a.href = url; a.download = manifestFile(m); a.click()
                    setTimeout(() => URL.revokeObjectURL(url), 30000)
                  } catch (e) { await ctx.run(() => Promise.reject(e), '') } finally { setMaking(null) }
                }}>{making === s.id ? 'Making…' : 'Manifest sheet'}</button>}
              </div>
            </div>
          )
        })}
      </div>

      {placeItem && <div className="movebar"><div><b>Moving {ctx.pallet(placeItem.pallet_id)?.code} on the truck</b><div className="muted">Tap a position.</div></div><button className="ghost" onClick={() => setPlaceItem(null)}>Cancel</button></div>}

      <div className="truck-wrap">
        <div className="truck-label">NOSE</div>
        <div className="truck" style={{ gridTemplateColumns: `repeat(${across}, 1fr)` }}>
          {Array.from({ length: rows * across }, (_, k) => {
            const pos = k + 1
            if (pos > spaces) return <div key={pos} />
            const here = items.filter(i => i.position === pos).sort((a, b) => (b.layer ?? 1) - (a.layer ?? 1) || b.id - a.id)
            // top comes off first: a lower layer for an earlier stop means unstacking at that stop
            const blocked = here.some((u, k) => here.slice(k + 1).some(d => (stopOf(d.stop_id)?.seq ?? 0) < (stopOf(u.stop_id)?.seq ?? 0) && stopOf(d.stop_id)?.status !== 'delivered'))
            return (
              <button key={pos} className={`tpos ${here.length ? 'full' : 'empty'} ${here.length > 1 ? 'stacked' : ''} ${placeItem ? 'target' : ''}`} onClick={() => tapPos(pos)}
                style={here.length ? { ['--sc' as string]: stopColor(stopOf(here[0].stop_id)?.seq ?? 1) } : undefined}>
                <span className="code">{pos}{here.length > 1 && <span className="stackbadge">stack of {here.length}</span>}</span>
                {blocked && <span className="small warn-t">Unstack at stop {Math.min(...here.map(i => stopOf(i.stop_id)?.seq ?? 99))}</span>}
                {here.length === 0 && <span className="muted">{placeItem ? 'Here' : canEdit ? '+ Add' : 'empty'}</span>}
                {here.map(i => {
                  const p = ctx.pallet(i.pallet_id)
                  const s = stopOf(i.stop_id)
                  return (
                    <span key={i.id} className={`titem ${s?.status === 'delivered' ? 'done' : ''}`} style={{ ['--sc' as string]: stopColor(s?.seq ?? 1) }}>
                      <b>{p?.code}</b> <span className="tstop">{s?.seq}</span>{here.length > 1 && <span className="tlayer">{i === here[0] ? 'top' : i === here[here.length - 1] ? 'bottom' : 'middle'}</span>}
                      <span className="strain">{p ? label(ctx, p) : ''}</span>
                      <span className="w">{p ? lbs(ctx.weight(p)) : ''} · {s?.status === 'delivered' ? '✓ delivered' : i.loaded ? '✓ on truck' : p ? ctx.freezerSpot(p.slot_id) : ''}</span>
                    </span>
                  )
                })}
              </button>
            )
          })}
        </div>
        <div className="truck-label door">DOOR</div>
      </div>

      <div className="row actions">
        {canEdit && <button className="ghost" disabled={ctx.busy || !items.length} onClick={() => ctx.run(() => ctx.api.arrangeLoad(l.id), 'Arranged: last stop at the nose')}>Auto-arrange</button>}
        {canEdit && items.length > 0 && <button className="ghost" disabled={ctx.busy || checking} onClick={runChecks}>{checking ? 'Checking METRC…' : 'Check METRC'}</button>}
        {canEdit && <button className="primary" disabled={ctx.busy || !items.length || unloaded > 0 || metrcBlock.length > 0}
          title={unloaded ? `${unloaded} not loaded yet` : metrcBlock.length ? `METRC checklist not green: stop ${metrcBlock.join(', ')}` : ''}
          onClick={() => ctx.confirm(`Truck is leaving with ${items.length} pallet${items.length === 1 ? '' : 's'}?${metrcOn ? ' The app makes the METRC manifests now.' : ''}`, 'Depart', depart)}>
          {unloaded ? `Depart (${unloaded} not loaded)` : metrcBlock.length ? 'Depart (METRC check)' : 'Depart'}</button>}
        {canEdit && <button className="ghost" disabled={ctx.busy} onClick={() => ctx.confirm(`Cancel ${l.code}? Planned pallets stay where they are${(ctx.orders ?? []).some(o => o.stop?.load_id === l.id) ? ', and its orders go back to Ready in Fulfillment' : ''}.`, 'Cancel load', async () => { if (await ctx.run(async () => { await ctx.api.cancelLoad(l.id); await ctx.refreshOrders?.() }, `${l.code} cancelled`)) onBack() })}>Cancel load</button>}
      </div>
      {canEdit && <p className="muted">Planned pallets stay in their freezer until someone taps "Pulled onto truck" (or scans the pallet's tag with Scan). Depart unlocks when everything is loaded.</p>}

      {posOpen != null && (
        <PositionSheet ctx={ctx} load={l} pos={posOpen} items={items.filter(i => i.position === posOpen)} stops={stops}
          onClose={() => setPosOpen(null)} onMove={it => { setPosOpen(null); setPlaceItem(it) }}
          onStack={() => { const p = posOpen; setPosOpen(null); setPicker({ stop: null, position: p, stack: true }) }} />
      )}
      {picker && (
        <PalletPicker ctx={ctx} load={l} stops={stops.filter(s => s.status === 'pending')} initialStop={picker.stop} position={picker.position} pre={picker.pre} stack={picker.stack}
          free={spaces - new Set(items.map(i => i.position)).size} onClose={() => setPicker(null)} />
      )}
    </div>
  )
}

/** the METRC side of a stop: the checklist (Check METRC) and the manifest the app made */
function StopMetrc({ checks, xfers, on, open, onToggle, pending }: { checks: StopCheckRow[]; xfers: AppTransfer[]; on: string; open: boolean; onToggle: () => void; pending: boolean }) {
  const made = xfers.filter(x => x.state !== 'voided')
  const fresh = (iso: string) => Date.now() - new Date(iso).getTime() < 60 * 60000
  const ok = checks.length > 0 && checks.every(c => c.ok && fresh(c.checked_at))
  const bad = checks.flatMap(c => c.checks.filter(x => !x.ok).map(x => ({ ...x, license: c.license })))
  if (!made.length && !checks.length && (!pending || on === 'off')) return null
  return <div className="small-note">
    {made.map(x => <div key={x.id}><b>METRC manifest {x.manifest ?? '(number pending)'}</b> <span className="muted">· made by the app · {x.transfer_type ?? ''}{x.state === 'received' ? ' · received' : ''}</span></div>)}
    {pending && !made.length && <button className="linkbtn" onClick={onToggle}>
      <span className={`pill ${!checks.length ? 'm-mute' : ok ? 'm-ok' : 'm-bad'}`}>{!checks.length ? 'METRC: not checked' : ok ? 'METRC: ready' : !bad.length ? 'METRC: check again (over an hour old)' : `METRC: ${bad.length} to fix`}</span>
      {on === 'off' && <span className="muted"> (done by hand in METRC)</span>} {open ? '▴' : '▾'}</button>}
    {open && checks.map(c => <div key={c.license} className="mlist">
      <div className="muted small">From {c.license} · checked {new Date(c.checked_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      {c.checks.map(x => <div key={x.key} className={x.ok ? '' : 'neg'}>{x.ok ? '✓' : '✗'} {x.label}{x.detail ? <span className={x.ok ? 'muted' : ''}>: {x.detail}</span> : null}</div>)}
    </div>)}
  </div>
}

/** type to find a stop: customers with ready orders first, then Lifted sites and labs, then everyone else */
function StopSearch({ ctx, customers, taken, onPick }: { ctx: LoadCtx; customers: Customer[]; taken: Set<number>; onPick: (id: number) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const ready = useMemo(() => {
    const m = new Map<number, FOrder[]>()
    for (const o of ctx.orders ?? []) if (o.state === 'ready' && !o.stop) m.set(o.customer_id, [...(m.get(o.customer_id) ?? []), o])
    return m
  }, [ctx.orders])
  const ql = q.trim().toLowerCase()
  const group = (c: Customer) => ready.has(c.id) ? 0 : c.kind === 'internal' ? 1 : 2
  const GROUP = ['Ready orders', 'Lifted sites and labs', 'Customers']
  const shown = customers
    .filter(c => !taken.has(c.id) && (!ql || c.name.toLowerCase().includes(ql)))
    .sort((a, b) => group(a) - group(b) || (ql ? Number(!a.name.toLowerCase().startsWith(ql)) - Number(!b.name.toLowerCase().startsWith(ql)) : 0) || a.name.localeCompare(b.name))
    .slice(0, 60)
  const pick = (c: Customer) => { onPick(c.id); setQ(''); setHi(0); setOpen(false) }
  return (
    <div className="stopsearch">
      <input value={q} placeholder="+ Add a stop: type a customer or site" autoComplete="off" role="combobox" aria-expanded={open}
        onFocus={() => { setOpen(true); setHi(0) }} onClick={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={e => { setQ(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(i => Math.min(i + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (open && shown[hi]) pick(shown[hi]) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      <button type="button" className="combo-arrow" tabIndex={-1} aria-label="Show stops" onMouseDown={e => { e.preventDefault(); setOpen(o => !o) }}>▾</button>
      {open && <ul className="stoplist" role="listbox">
        {shown.length === 0 && <li className="none muted">No match{ql ? ` for "${q.trim()}"` : ''}. Customers are added in Sales › Settings › Customers.</li>}
        {shown.map((c, i) => {
          const os = ready.get(c.id) ?? []
          return <li key={c.id} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onMouseDown={e => { e.preventDefault(); pick(c) }}>
            {(i === 0 || group(shown[i - 1]) !== group(c)) && <div className="sgroup">{GROUP[group(c)]}</div>}
            <div className="sname">{c.name}{os.length > 0 && <span className="sready">{os.map(soOf).join(', ')} ready · {n0(os.reduce((a, o) => a + orderGot(o), 0))} lbs</span>}</div>
          </li>
        })}
      </ul>}
    </div>
  )
}

function PositionSheet({ ctx, load, pos, items: raw, stops, onClose, onMove, onStack }: {
  ctx: LoadCtx; load: Load; pos: number; items: LoadItem[]; stops: LoadStop[]; onClose: () => void; onMove: (i: LoadItem) => void; onStack: () => void
}) {
  const canEdit = editable(load)
  const items = [...raw].sort((a, b) => (b.layer ?? 1) - (a.layer ?? 1) || b.id - a.id)   // top first
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Position {pos}{items.length > 1 ? ` · stack of ${items.length}` : ''}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {items.length > 1 && <p className="muted small-note">Top first. The top pallet comes off first, so it should be for the earliest stop.</p>}
        {items.map((i, k) => {
          const p = ctx.pallet(i.pallet_id)
          if (!p) return null
          return (
            <div key={i.id} className="mixline">
              <div className="row between">
                <div>{items.length > 1 && <span className="tlayer">{k === 0 ? 'top' : k === items.length - 1 ? 'bottom' : 'middle'}</span>} <a onClick={() => { onClose(); ctx.openPallet(p.id) }}><b>{p.code}</b></a> {label(ctx, p)} <span className="muted">· {lbs(ctx.weight(p))}</span></div>
                <span className={`pill ${i.loaded ? 's-in_transit' : 's-planning'}`}>{i.loaded ? 'On truck' : 'Planned'}</span>
              </div>
              {!i.loaded && <div className="muted">Pull from {p.slot_id != null ? ctx.freezerSpot(p.slot_id) : ctx.where(p)}</div>}
              {canEdit && (
                <div className="field">
                  <label>Stop</label>
                  <Select value={i.stop_id} onChange={e => ctx.run(() => ctx.api.moveItem(i.id, null, +e.target.value, false), 'Stop changed')}>
                    {stops.filter(s => s.status === 'pending').map(s => <option key={s.id} value={s.id}>{s.seq}. {ctx.customers.find(c => c.id === s.customer_id)?.name}</option>)}
                  </Select>
                </div>
              )}
              {canEdit && (
                <div className="row">
                  {!i.loaded && <button className="primary" disabled={ctx.busy} onClick={async () => { if (await ctx.run(() => ctx.api.loadPallet(i.id), `${p.code} on the truck`)) onClose() }}>Pulled onto truck</button>}
                  <button className="ghost" disabled={ctx.busy} onClick={() => onMove(i)}>Move on truck</button>
                  {items.length > 1 && k > 0 && <button className="ghost" disabled={ctx.busy} onClick={() => ctx.run(() => ctx.api.stackTop(i.id), `${p.code} on top`)}>Put on top</button>}
                  {!i.loaded
                    ? <button className="ghost" disabled={ctx.busy} onClick={async () => { if (await ctx.run(() => ctx.api.removeItem(i.id), `${p.code} removed from ${load.code}`)) onClose() }}>Remove from load</button>
                    : <button className="ghost" disabled={ctx.busy} onClick={() => { onClose(); ctx.putBack(i, p) }}>Put back in a freezer</button>}
                </div>
              )}
            </div>
          )
        })}
        {canEdit && <div className="row end"><button className="ghost" onClick={onStack}>+ Stack a pallet here</button></div>}
      </div>
    </div>
  )
}

function PalletPicker({ ctx, load, stops, initialStop, position, free, onClose, pre, stack }: {
  ctx: LoadCtx; load: Load; stops: LoadStop[]; initialStop: number | null; position: number | null; free: number; onClose: () => void; pre?: number; stack?: boolean
}) {
  const [stop, setStop] = useState<number | null>(initialStop ?? (stops.length === 1 ? stops[0].id : null))
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<number[]>(pre != null ? [pre] : [])
  const single = position != null
  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return ctx.available.filter(p => [p.code, p.strain, p.package_tag].some(v => v?.toLowerCase().includes(s))
      || (p.kind === 'mixed' && ctx.contents(p.id).some(c => [c.code, c.strain].some(v => v?.toLowerCase().includes(s))))).slice(0, 40)
  }, [q, ctx.available])
  const toggle = (id: number) => setPicked(x => x.includes(id) ? x.filter(y => y !== id) : single ? [id] : [...x, id])
  const pickedW = picked.reduce((a, id) => { const p = ctx.pallet(id); return a + (p ? ctx.weight(p) : 0) }, 0)
  async function save() {
    let done = 0
    const ok = await ctx.run(async () => {
      for (const id of picked) { await ctx.api.planPallet(load.id, stop!, id, single ? position : null, !!stack); done++ }
      if (!single) await ctx.api.arrangeLoad(load.id)
    }, `${picked.length} pallet${picked.length === 1 ? '' : 's'} planned on ${load.code}`)
    if (ok || done) onClose()
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{single ? `${stack ? 'Stack on' : 'Add to'} position ${position}` : `Add pallets to ${load.code}`}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {pre != null && <div className="infobox">{ctx.pallet(pre)?.code} isn't on {load.code} yet. Pick the stop and tap Add to load.{ctx.held(pre) ? ` It's held for ${ctx.held(pre)}.` : ''}</div>}
        <div className="field"><label>Stop</label>
          <div className="choices">
            {stops.map(s => <button key={s.id} className={stop === s.id ? 'on' : ''} style={{ ['--sc' as string]: stopColor(s.seq) }} onClick={() => setStop(s.id)}>
              <span className="stopnum">{s.seq}</span> {ctx.customers.find(c => c.id === s.customer_id)?.name}</button>)}
          </div>
        </div>
        <div className="field"><label>Find pallets {!single && <span className="muted">({free} open position{free === 1 ? '' : 's'})</span>}</label>
          <div className="row tagrow"><input className="grow-in" value={q} onChange={e => setQ(e.target.value)} placeholder="Search strain, pallet # or tag" autoFocus={pre == null} /><ScanButton onScan={setQ} /></div>
          {(results.length > 0 || picked.length > 0) && (
            <div className="picklist">
              {[...picked.map(id => ctx.pallet(id)!).filter(Boolean), ...results.filter(r => !picked.includes(r.id))].map(p => (
                <label key={p.id} className={`pick ${picked.includes(p.id) ? 'on' : ''}`}>
                  <input type={single ? 'radio' : 'checkbox'} checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                  <b>{p.code}</b><span>{label(ctx, p)} · {lbs(ctx.weight(p))}{p.origin_site ? <span className="muted"> · grown at {p.origin_site}</span> : null}</span>
                  <span className="muted">{ctx.where(p)}{ctx.held(p.id) ? <span className="warn-t"> · held for {ctx.held(p.id)}</span> : null}</span>
                </label>
              ))}
            </div>
          )}
          {q.trim() && results.length === 0 && <div className="muted small-note">Nothing available matches. Pallets already on a load, or packages on a mixed pallet, don't show here.</div>}
          <div className="muted small-note">A pallet held for an order can go to that customer, or to OHR/GVR on a transfer (it stays held).</div>
        </div>
        {picked.length > 0 && <div className="muted">{picked.length} selected · {lbs(pickedW)}{!single && picked.length > free ? ` · only ${free} open position${free === 1 ? '' : 's'}: the rest get stacked two high, earlier stop on top` : ''}</div>}
        <p className="muted small-note">Need part of a pallet? Split it first (or build a mixed pallet), then add the new piece here.</p>
        <div className="row end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!stop || !picked.length || ctx.busy} onClick={save}>Add to load</button>
        </div>
      </div>
    </div>
  )
}

/** From a pallet card: choose an open load and stop */
export function PickLoad({ ctx, ps, onClose }: { ctx: LoadCtx; ps: Pallet[]; onClose: () => void }) {
  const label = ps.length === 1 ? ps[0].code : `${ps.length} pallets`
  const open = ctx.loads.filter(editable)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Put {label} on a load</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {open.length === 0 && <p className="muted">No loads being planned. Create one in Transit first.</p>}
        {open.map(l => {
          const v = ctx.vehicles.find(x => x.id === l.vehicle_id)
          return (
            <div key={l.id} className="mixline">
              <div><b>{l.code}</b> · {v?.name} · {fmtDate(l.load_date)}</div>
              <div className="choices">
                {ctx.stops.filter(s => s.load_id === l.id && s.status === 'pending').sort((a, b) => a.seq - b.seq).map(s => (
                  <button key={s.id} style={{ ['--sc' as string]: stopColor(s.seq) }} disabled={ctx.busy}
                    onClick={async () => { if (await ctx.run(async () => { for (const p of ps) await ctx.api.planPallet(l.id, s.id, p.id, null, false); await ctx.api.arrangeLoad(l.id) }, `${label} planned on ${l.code}`)) onClose() }}>
                    <span className="stopnum">{s.seq}</span> {ctx.customers.find(c => c.id === s.customer_id)?.name}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        <div className="metrcnote"><b>METRC</b> At Depart each stop gets its METRC transfer manifest (to the customer or the other license): made by the app when Compliance has it switched on, otherwise on the METRC to-do list.</div>
      </div>
    </div>
  )
}
