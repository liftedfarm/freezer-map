import { useMemo, useState } from 'react'
import { lbs } from './forms'
import type { Customer, Load, LoadItem, LoadStop, Pallet, StopInput, Vehicle } from './types'

// Everything the transit screens need from the app, passed in to avoid circular imports.
export interface LoadCtx {
  loads: Load[]; stops: LoadStop[]; items: LoadItem[]
  vehicles: Vehicle[]; customers: Customer[]
  pallet: (id: number) => Pallet | undefined
  contents: (id: number) => Pallet[]
  weight: (p: Pallet) => number
  where: (p: Pallet) => string
  freezerSpot: (slotId: number | null) => string
  available: Pallet[]                          // top-level pallets in a freezer and not on an open load
  busy: boolean
  run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>
  confirm: (text: string, ok: string, fn: () => Promise<void>) => void
  openPallet: (id: number) => void
  putBack: (item: LoadItem, p: Pallet) => void // start "tap a freezer slot" for a loaded pallet
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
  }
}

export const STOP_COLORS = ['#2563eb', '#d97706', '#16a34a', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#65a30d']
export const stopColor = (seq: number) => STOP_COLORS[(seq - 1) % STOP_COLORS.length]
const STATUS: Record<string, string> = { planning: 'Planning', loading: 'Loading', in_transit: 'In transit', delivered: 'Delivered', cancelled: 'Cancelled' }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const fmtDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const editable = (l: Load) => l.status === 'planning' || l.status === 'loading'

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
  const [add, setAdd] = useState('')
  const move = (i: number, d: number) => setStops(s => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n })
  const ok = vehicle != null && stops.length > 0
  async function save() {
    const clean = stops.map(({ delivered: _d, ...s }) => s)
    if (load) {
      const a = await ctx.run(() => ctx.api.updateLoad(load.id, vehicle!, date, driver, notes), 'Load updated')
      if (a && await ctx.run(() => ctx.api.setStops(load.id, clean), 'Stops saved')) onSaved(load.id)
    } else {
      let id = 0
      if (await ctx.run(async () => { id = (await ctx.api.createLoad(vehicle!, date, clean, driver, notes)).id }, 'Load created')) onSaved(id)
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
            {vehicles.length === 0 && <span className="muted">Add vehicles in Settings first.</span>}
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
              </div>
              <div className="stopbtns">
                <button className="ghost small" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="ghost small" disabled={i === stops.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="ghost small" disabled={s.delivered} onClick={() => setStops(st => st.filter((_, j) => j !== i))}>✕</button>
              </div>
            </div>
          ))}
          <select value={add} onChange={e => { const id = +e.target.value; if (id) setStops(s => [...s, { customer_id: id, manifest: '' }]); setAdd('') }}>
            <option value="">+ Add a stop…</option>
            <optgroup label="Lifted sites and labs">{customers.filter(c => c.kind === 'internal').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
            <optgroup label="Customers">{customers.filter(c => c.kind === 'external').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
          </select>
          {customers.filter(c => c.kind === 'external').length === 0 && <div className="muted small-note">No customers yet. Add them in Settings, Customers.</div>}
        </div>
        <div className="field"><label>Driver (optional)</label><input value={driver} onChange={e => setDriver(e.target.value)} /></div>
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
  const [picker, setPicker] = useState<{ stop: number | null; position: number | null } | null>(null)
  const [posOpen, setPosOpen] = useState<number | null>(null)
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

  function tapPos(pos: number) {
    const here = items.filter(i => i.position === pos)
    if (placeItem) {
      const it = placeItem
      if (pos === it.position) { setPlaceItem(null); return }
      const others = here.filter(i => i.id !== it.id)
      const go = async () => { setPlaceItem(null); await ctx.run(() => ctx.api.moveItem(it.id, pos, null, others.length > 0), `Moved to position ${pos}`) }
      if (others.length) ctx.confirm(`Position ${pos} has ${others.map(o => ctx.pallet(o.pallet_id)?.code).join(', ')}. Share it?`, 'Share', go)
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
              {canEdit && <button className="ghost small" onClick={() => setPicker({ stop: s.id, position: null })}>+ Add pallets</button>}
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
            const here = items.filter(i => i.position === pos)
            return (
              <button key={pos} className={`tpos ${here.length ? 'full' : 'empty'} ${placeItem ? 'target' : ''}`} onClick={() => tapPos(pos)}
                style={here.length ? { ['--sc' as string]: stopColor(stopOf(here[0].stop_id)?.seq ?? 1) } : undefined}>
                <span className="code">{pos}</span>
                {here.length === 0 && <span className="muted">{placeItem ? 'Here' : canEdit ? '+ Add' : 'empty'}</span>}
                {here.map(i => {
                  const p = ctx.pallet(i.pallet_id)
                  const s = stopOf(i.stop_id)
                  return (
                    <span key={i.id} className={`titem ${s?.status === 'delivered' ? 'done' : ''}`} style={{ ['--sc' as string]: stopColor(s?.seq ?? 1) }}>
                      <b>{p?.code}</b> <span className="tstop">{s?.seq}</span>
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
        {canEdit && <button className="primary" disabled={ctx.busy || !items.length || unloaded > 0}
          title={unloaded ? `${unloaded} not loaded yet` : ''}
          onClick={() => ctx.confirm(`Truck is leaving with ${items.length} pallet${items.length === 1 ? '' : 's'}?`, 'Depart', async () => { await ctx.run(() => ctx.api.departLoad(l.id), `${l.code} in transit`) })}>
          {unloaded ? `Depart (${unloaded} not loaded)` : 'Depart'}</button>}
        {canEdit && <button className="ghost" disabled={ctx.busy} onClick={() => ctx.confirm(`Cancel ${l.code}? Planned pallets stay where they are.`, 'Cancel load', async () => { if (await ctx.run(() => ctx.api.cancelLoad(l.id), `${l.code} cancelled`)) onBack() })}>Cancel load</button>}
      </div>
      {canEdit && <p className="muted">Planned pallets stay in their freezer until someone taps "Pulled onto truck". Depart unlocks when everything is loaded.</p>}

      {posOpen != null && (
        <PositionSheet ctx={ctx} load={l} pos={posOpen} items={items.filter(i => i.position === posOpen)} stops={stops}
          onClose={() => setPosOpen(null)} onMove={it => { setPosOpen(null); setPlaceItem(it) }} />
      )}
      {picker && (
        <PalletPicker ctx={ctx} load={l} stops={stops.filter(s => s.status === 'pending')} initialStop={picker.stop} position={picker.position}
          free={spaces - new Set(items.map(i => i.position)).size} onClose={() => setPicker(null)} />
      )}
    </div>
  )
}

function PositionSheet({ ctx, load, pos, items, stops, onClose, onMove }: {
  ctx: LoadCtx; load: Load; pos: number; items: LoadItem[]; stops: LoadStop[]; onClose: () => void; onMove: (i: LoadItem) => void
}) {
  const canEdit = editable(load)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Position {pos}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {items.map(i => {
          const p = ctx.pallet(i.pallet_id)
          if (!p) return null
          return (
            <div key={i.id} className="mixline">
              <div className="row between">
                <div><a onClick={() => { onClose(); ctx.openPallet(p.id) }}><b>{p.code}</b></a> {label(ctx, p)} <span className="muted">· {lbs(ctx.weight(p))}</span></div>
                <span className={`pill ${i.loaded ? 's-in_transit' : 's-planning'}`}>{i.loaded ? 'On truck' : 'Planned'}</span>
              </div>
              {!i.loaded && <div className="muted">Pull from {ctx.freezerSpot(p.slot_id)}</div>}
              {canEdit && (
                <div className="field">
                  <label>Stop</label>
                  <select value={i.stop_id} onChange={e => ctx.run(() => ctx.api.moveItem(i.id, null, +e.target.value, false), 'Stop changed')}>
                    {stops.filter(s => s.status === 'pending').map(s => <option key={s.id} value={s.id}>{s.seq}. {ctx.customers.find(c => c.id === s.customer_id)?.name}</option>)}
                  </select>
                </div>
              )}
              {canEdit && (
                <div className="row">
                  {!i.loaded && <button className="primary" disabled={ctx.busy} onClick={async () => { if (await ctx.run(() => ctx.api.loadPallet(i.id), `${p.code} on the truck`)) onClose() }}>Pulled onto truck</button>}
                  <button className="ghost" disabled={ctx.busy} onClick={() => onMove(i)}>Move on truck</button>
                  {!i.loaded
                    ? <button className="ghost" disabled={ctx.busy} onClick={async () => { if (await ctx.run(() => ctx.api.removeItem(i.id), `${p.code} removed from ${load.code}`)) onClose() }}>Remove from load</button>
                    : <button className="ghost" disabled={ctx.busy} onClick={() => { onClose(); ctx.putBack(i, p) }}>Put back in a freezer</button>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PalletPicker({ ctx, load, stops, initialStop, position, free, onClose }: {
  ctx: LoadCtx; load: Load; stops: LoadStop[]; initialStop: number | null; position: number | null; free: number; onClose: () => void
}) {
  const [stop, setStop] = useState<number | null>(initialStop ?? (stops.length === 1 ? stops[0].id : null))
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<number[]>([])
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
      for (const id of picked) { await ctx.api.planPallet(load.id, stop!, id, single ? position : null, false); done++ }
      if (!single) await ctx.api.arrangeLoad(load.id)
    }, `${picked.length} pallet${picked.length === 1 ? '' : 's'} planned on ${load.code}`)
    if (ok || done) onClose()
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{single ? `Add to position ${position}` : `Add pallets to ${load.code}`}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="field"><label>Stop</label>
          <div className="choices">
            {stops.map(s => <button key={s.id} className={stop === s.id ? 'on' : ''} style={{ ['--sc' as string]: stopColor(s.seq) }} onClick={() => setStop(s.id)}>
              <span className="stopnum">{s.seq}</span> {ctx.customers.find(c => c.id === s.customer_id)?.name}</button>)}
          </div>
        </div>
        <div className="field"><label>Find pallets {!single && <span className="muted">({free} open position{free === 1 ? '' : 's'})</span>}</label>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search strain, pallet # or tag" autoFocus />
          {(results.length > 0 || picked.length > 0) && (
            <div className="picklist">
              {[...picked.map(id => ctx.pallet(id)!).filter(Boolean), ...results.filter(r => !picked.includes(r.id))].map(p => (
                <label key={p.id} className={`pick ${picked.includes(p.id) ? 'on' : ''}`}>
                  <input type={single ? 'radio' : 'checkbox'} checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                  <b>{p.code}</b><span>{label(ctx, p)} · {lbs(ctx.weight(p))}</span><span className="muted">{ctx.where(p)}</span>
                </label>
              ))}
            </div>
          )}
          {q.trim() && results.length === 0 && <div className="muted small-note">Nothing available matches. Pallets already on a load, or packages on a mixed pallet, don't show here.</div>}
        </div>
        {picked.length > 0 && <div className="muted">{picked.length} selected · {lbs(pickedW)}{!single && picked.length > free ? ` · only ${free} open positions, extra pallets need a shared position` : ''}</div>}
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
export function PickLoad({ ctx, p, onClose }: { ctx: LoadCtx; p: Pallet; onClose: () => void }) {
  const open = ctx.loads.filter(editable)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Put {p.code} on a load</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {open.length === 0 && <p className="muted">No loads being planned. Create one in Transit first.</p>}
        {open.map(l => {
          const v = ctx.vehicles.find(x => x.id === l.vehicle_id)
          return (
            <div key={l.id} className="mixline">
              <div><b>{l.code}</b> · {v?.name} · {fmtDate(l.load_date)}</div>
              <div className="choices">
                {ctx.stops.filter(s => s.load_id === l.id && s.status === 'pending').sort((a, b) => a.seq - b.seq).map(s => (
                  <button key={s.id} style={{ ['--sc' as string]: stopColor(s.seq) }} disabled={ctx.busy}
                    onClick={async () => { if (await ctx.run(async () => { await ctx.api.planPallet(l.id, s.id, p.id, null, false); await ctx.api.arrangeLoad(l.id) }, `${p.code} planned on ${l.code}`)) onClose() }}>
                    <span className="stopnum">{s.seq}</span> {ctx.customers.find(c => c.id === s.customer_id)?.name}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
