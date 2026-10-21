import { useCallback, useEffect, useMemo, useState } from 'react'
import { Backend, CONFIG_MISSING, makeBackend } from './api'
import { FREEZER_STATUSES } from './types'
import { MergeForm, MergeHere, MixedBuilder, NewPalletChooser, PickMixed, SingleForm, SplitForm, TagForm, WeightForm, lbs } from './forms'
import { SettingsView } from './settings'
import { Sidebar } from './sidebar'
import { LoadForm, LoadView, PickLoad, TransitView, stopColor } from './loads'
import type { LoadCtx } from './loads'
import type { Freezer, FreezerStatus, InvEvent, Load, LoadItem, LoadStop, Pallet, Site, Slot, Snapshot } from './types'

const backend: Backend = makeBackend()

type View = 'map' | 'freezer' | 'transit' | 'load' | 'review' | 'activity' | 'settings'

// ---------- helpers ----------

// custom map colors from the Strains list (name or other names), set when data loads
let strainColors = new Map<string, string>()
function setStrainColors(snap: Snapshot) {
  strainColors = new Map((snap.strains ?? []).filter(s => s.color).flatMap(s => [s.name, ...(s.aliases ?? [])].map(n => [n.toLowerCase(), s.color!] as [string, string])))
}
function swatch(strain: string | null | undefined): { cls: string; style?: React.CSSProperties } {
  const c = strain ? strainColors.get(strain.toLowerCase()) : undefined
  if (c) return { cls: 'cc', style: { ['--c' as string]: c } }
  const h = hue(strain ?? null)
  return h < 0 ? { cls: 'unk' } : { cls: '', style: { ['--h' as string]: h } }
}
function hue(strain: string | null) {
  if (!strain) return -1
  let h = 0
  for (const c of strain.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const who = (email: string | null) => (email ?? '').split('@')[0]

function matches(p: Pallet, q: string, ix?: Index): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  if ([p.code, p.strain, p.package_tag, p.label].some(v => v?.toLowerCase().includes(s))) return true
  return p.kind === 'mixed' && !!ix && (ix.contentsOf.get(p.id) ?? []).some(c => matches(c, q))
}

interface Index {
  freezer: Map<number, Freezer>
  slot: Map<number, Slot>
  slotsOf: Map<number, Slot[]>
  inSlot: Map<number, Pallet[]>      // top-level pallets in a slot (not the packages on a mixed pallet)
  contentsOf: Map<number, Pallet[]>  // packages on each mixed pallet
  pallet: Map<number, Pallet>
  loadOf: Map<number, { item: LoadItem; load: Load; stop: LoadStop }>  // pallets on an open load
}

function buildIndex(s: Snapshot): Index {
  const freezer = new Map(s.freezers.map(f => [f.id, f]))
  const slot = new Map(s.slots.map(x => [x.id, x]))
  const slotsOf = new Map<number, Slot[]>()
  for (const x of s.slots) (slotsOf.get(x.freezer_id) ?? slotsOf.set(x.freezer_id, []).get(x.freezer_id)!).push(x)
  const inSlot = new Map<number, Pallet[]>()
  const contentsOf = new Map<number, Pallet[]>()
  for (const p of s.pallets) {
    if (p.container_id) (contentsOf.get(p.container_id) ?? contentsOf.set(p.container_id, []).get(p.container_id)!).push(p)
    else if (p.slot_id != null) (inSlot.get(p.slot_id) ?? inSlot.set(p.slot_id, []).get(p.slot_id)!).push(p)
  }
  const loadOf = new Map<number, { item: LoadItem; load: Load; stop: LoadStop }>()
  for (const it of s.items ?? []) {
    const load = s.loads?.find(l => l.id === it.load_id), stop = s.stops?.find(x => x.id === it.stop_id)
    if (load && stop && ['planning', 'loading', 'in_transit'].includes(load.status)) loadOf.set(it.pallet_id, { item: it, load, stop })
  }
  return { freezer, slot, slotsOf, inSlot, contentsOf, loadOf, pallet: new Map(s.pallets.map(p => [p.id, p])) }
}

/** weight of a pallet; a mixed pallet weighs what's on it */
function weightOf(ix: Index, p: Pallet) {
  return p.kind === 'mixed' ? (ix.contentsOf.get(p.id) ?? []).reduce((a, c) => a + (c.current_weight ?? 0), 0) : (p.current_weight ?? 0)
}
const isPackage = (p: Pallet) => p.kind !== 'mixed'
const loose = (p: Pallet) => isPackage(p) && !p.container_id && (p.status === 'in_freezer' || p.status === 'unslotted')

function whereIs(ix: Index, slotId: number | null) {
  if (slotId == null) return 'Needs a spot'
  const s = ix.slot.get(slotId)
  if (!s) return '?'
  const f = ix.freezer.get(s.freezer_id)!
  return `${f.site} F${f.number} · ${s.code}`
}

function describe(ix: Index, e: InvEvent, names?: Map<number, string>) {
  const code = e.pallet_id != null ? (ix.pallet.get(e.pallet_id)?.code ?? names?.get(e.pallet_id) ?? `#${e.pallet_id}`) : ''
  switch (e.type) {
    case 'move': return `${code} moved ${whereIs(ix, e.from_slot_id)} to ${whereIs(ix, e.to_slot_id)}`
    case 'unslot': return `${code} taken out of ${whereIs(ix, e.from_slot_id)}`
    case 'created': return `${code} entered by hand at ${whereIs(ix, e.to_slot_id)} (${lbs(e.lbs)})`
    case 'mixed_created': { const d = e.details as { packages?: string[] } | null
      return `${code} mixed pallet started at ${whereIs(ix, e.to_slot_id)} with ${(d?.packages ?? []).join(', ')}` }
    case 'mixed_added': { const d = e.details as { packages?: string[] } | null
      return `${code}: added ${(d?.packages ?? []).join(', ')}` }
    case 'mixed_on': { const d = e.details as { mixed?: string } | null
      return `${code} put on mixed pallet ${d?.mixed} (${lbs(e.lbs)})` }
    case 'mixed_off': { const d = e.details as { mixed?: string; broken?: boolean } | null
      return d?.broken ? `${code} unstacked from ${d?.mixed}, now its own pallet` : `${code} taken off ${d?.mixed} to ${whereIs(ix, e.to_slot_id)}` }
    case 'mixed_broken': { const d = e.details as { packages?: string[] } | null
      return `${code} broken apart: ${(d?.packages ?? []).join(', ')} now separate` }
    case 'import': return `${code} imported at ${whereIs(ix, e.to_slot_id)}`
    case 'review_cleared': return `${code} review flag cleared`
    case 'split': { const d = e.details as { child?: string; remaining?: number; mixed?: string } | null
      return `${code} split: ${lbs(e.lbs)} off to ${d?.child}${d?.mixed ? ` (onto ${d.mixed})` : ''}, ${lbs(d?.remaining)} left` }
    case 'split_from': { const d = e.details as { parent?: string; tag?: string | null; mixed?: string } | null
      return `${code} created from ${d?.parent} (${lbs(e.lbs)})${d?.mixed ? ` onto ${d.mixed}` : ''}${d?.tag ? '' : ', tag pending'}` }
    case 'merge': { const d = e.details as { sources?: string[] } | null
      return `${code} made by merging ${(d?.sources ?? []).join(', ')} (${lbs(e.lbs)})` }
    case 'merged_into': { const d = e.details as { into?: string } | null
      return `${code} merged into ${d?.into} (${lbs(e.lbs)})` }
    case 'tag_set': { const d = e.details as { from?: string | null; to?: string } | null
      return `${code} METRC tag ${d?.from ? `changed from ${d.from} ` : ''}set to ${d?.to}` }
    case 'weight_adjust': { const d = e.details as { from?: number | null; to?: number } | null
      return `${code} weight adjusted ${d?.from != null ? `from ${lbs(d.from)} ` : ''}to ${lbs(d?.to)}` }
    case 'freezer_status': {
      const f = e.freezer_id != null ? ix.freezer.get(e.freezer_id) : undefined
      const d = e.details as { from?: string; to?: string } | null
      return `${f ? `${f.site} Freezer ${f.number}` : 'Freezer'}: ${d?.from} to ${d?.to}`
    }
    case 'sheet_sync': { const d = e.details as { strain?: string; weight?: number } | null
      return `${code} filled in from the spreadsheet: ${d?.strain ?? ''} ${lbs(d?.weight)}` }
    case 'load_created': return `Load ${(e.details as { load?: string } | null)?.load} created`
    case 'load_updated': return `Load ${(e.details as { load?: string } | null)?.load} edited`
    case 'load_planned': { const d = e.details as { load?: string; position?: number } | null
      return `${code} planned on ${d?.load}, position ${d?.position}` }
    case 'load_removed': return `${code} removed from ${(e.details as { load?: string } | null)?.load}`
    case 'loaded': { const d = e.details as { load?: string; position?: number } | null
      return `${code} pulled from ${whereIs(ix, e.from_slot_id)} onto ${d?.load}, position ${d?.position}` }
    case 'unloaded': return `${code} taken off ${(e.details as { load?: string } | null)?.load}, back to ${whereIs(ix, e.to_slot_id)}`
    case 'load_departed': return `Load ${(e.details as { load?: string } | null)?.load} departed`
    case 'load_cancelled': return `Load ${(e.details as { load?: string } | null)?.load} cancelled`
    case 'stop_delivered': { const d = e.details as { load?: string; customer?: string; seq?: number } | null
      return `${d?.load} stop ${d?.seq} delivered to ${d?.customer}` }
    case 'shipped': { const d = e.details as { load?: string; customer?: string } | null
      return `${code} delivered to ${d?.customer} on ${d?.load} (${lbs(e.lbs)})` }
    case 'received': { const d = e.details as { load?: string; customer?: string } | null
      return `${code} received at ${d?.customer} from ${d?.load}, needs a spot` }
    case 'strain_renamed': { const d = e.details as { from?: string; to?: string } | null
      return `${code} strain renamed from ${d?.from} to ${d?.to}` }
    case 'settings': { const d = e.details as { list?: string; name?: string; active?: boolean } | null
      return `${d?.list ? d.list[0].toUpperCase() + d.list.slice(1, -1) : 'Setting'} "${d?.name}" ${e.note === 'added' ? 'added' : d?.active === false ? 'retired' : 'updated'}` }
    default: return `${e.type} ${code}`
  }
}

// ---------- app ----------

type FormState =
  | { kind: 'split' | 'merge' | 'tag' | 'weight'; p: Pallet }
  | { kind: 'newchoice' | 'newmixed' | 'newsingle' | 'newmerged'; slot: Slot }
  | { kind: 'addmixed'; m: Pallet; initial?: Pallet[] }
  | { kind: 'pickmixed'; p: Pallet }
interface Placing { title: string; sub: string; run: (slot: Slot) => Promise<void> }

export default function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [site, setSite] = useState<Site>('OHR')
  const [view, setView] = useState<View>('map')
  const [freezerId, setFreezerId] = useState<number | null>(null)
  const [palletId, setPalletId] = useState<number | null>(null)
  const [moving, setMoving] = useState<Pallet | null>(null)
  const [placing, setPlacing] = useState<Placing | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; ok: string; run: () => Promise<void> } | null>(null)
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [extra, setExtra] = useState<Pallet[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [pool, setPool] = useState<Pallet[]>([])
  const [loadId, setLoadId] = useState<number | null>(null)
  const [loadForm, setLoadForm] = useState<{ load?: Load } | null>(null)
  const [pickLoad, setPickLoad] = useState<Pallet | null>(null)
  const [side, setSide] = useState<boolean>(() => { try { return localStorage.getItem('fm.side') !== '0' && window.innerWidth >= 1000 } catch { return false } })
  const toggleSide = (v: boolean) => { setSide(v); try { localStorage.setItem('fm.side', v ? '1' : '0') } catch { /* private mode */ } }

  const reload = useCallback(async () => { const s = await backend.load(); setStrainColors(s); setSnap(s) }, [])
  const flash = (text: string, bad = false) => { setToast({ text, bad }); setTimeout(() => setToast(null), bad ? 5000 : 2500) }

  useEffect(() => { backend.getUser().then(setUser) }, [])
  useEffect(() => {
    if (!user) return
    reload().then(() => setLoadError(null)).catch(e => setLoadError(String(e?.message ?? e)))
    return backend.subscribe(() => { reload() })
  }, [user, reload])

  // search outside the live set (archived / old pallets) once the query is specific
  useEffect(() => {
    if (query.trim().length < 3) { setExtra([]); return }
    const t = setTimeout(() => backend.search(query.trim()).then(setExtra).catch(() => setExtra([])), 350)
    return () => clearTimeout(t)
  }, [query])

  const ix = useMemo(() => snap && buildIndex(snap), [snap])

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); await reload(); flash(ok) } catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }
  async function submit<T>(fn: () => Promise<T>, ok: (r: T) => string, after?: (r: T) => void) {
    setBusy(true)
    try { const r = await fn(); await reload(); setForm(null); flash(ok(r)); after?.(r) }
    catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }

  function slotLabel(slot: Slot) {
    const f = ix!.freezer.get(slot.freezer_id)!
    return `${f.site} F${f.number} · ${slot.code}`
  }

  function tapSlot(slot: Slot) {
    if (!ix) return
    const here = ix.inSlot.get(slot.id) ?? []
    const f = ix.freezer.get(slot.freezer_id)!
    if (placing) {
      const pl = placing
      const go = async () => { setPlacing(null); await pl.run(slot) }
      if (here.length) setConfirm({ text: `${slot.code} already has ${here.map(h => h.code).join(', ')}. Stack on top? Each pallet keeps its own number.`, ok: 'Stack', run: go })
      else go()
      return
    }
    if (moving) {
      const p = moving
      if (p.slot_id === slot.id) { flash('That is where it already is', true); return }
      if (here.length) {
        setConfirm({
          text: `${slot.code} already has ${here.map(h => h.code).join(', ')}. Stack ${p.code} on top? Each pallet keeps its own number. (To combine same-strain partials into one pallet with a new tag, use Merge.)`,
          ok: 'Stack',
          run: async () => { await act(() => backend.movePallet(p.id, slot.id, true), `${p.code} stacked in ${slot.code}`); setMoving(null) },
        })
      } else {
        setConfirm({
          text: `Move ${p.code} to ${f.site} Freezer ${f.number}, slot ${slot.code}?`, ok: 'Move',
          run: async () => { await act(() => backend.movePallet(p.id, slot.id, false), `${p.code} moved to ${slot.code}`); setMoving(null) },
        })
      }
      return
    }
    if (here.length) setPalletId(here[0].id)
    else if (f.status === 'Not Working') flash(`Freezer ${f.number} is marked Not Working`, true)
    else setForm({ kind: 'newchoice', slot })
  }

  if (CONFIG_MISSING) return (
    <div className="center"><h2>Setup needed</h2>
      <p className="muted">This build has no database connection. In Vercel, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy.</p></div>
  )
  if (user === undefined) return <div className="center muted">Loading…</div>
  if (!user) return <Login />
  if (loadError && !snap) return (
    <div className="center"><h2>Couldn't load freezers</h2>
      <p className="muted">{loadError}</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="primary" onClick={() => { setLoadError(null); reload().catch(e => setLoadError(String(e?.message ?? e))) }}>Try again</button>
        <button className="ghost" onClick={() => backend.signOut().then(() => setUser(null))}>Sign out</button>
      </div></div>
  )
  if (!snap || !ix) return <div className="center muted">Loading freezers…</div>

  const siteFreezers = snap.freezers.filter(f => f.site === site).sort((a, b) => a.number - b.number)
  const unplaced = snap.pallets.filter(p => p.status === 'unslotted' && !p.container_id)
  const review = snap.pallets.filter(p => p.needs_review)
  const pendingTags = snap.pallets.filter(p => p.tag_pending)
  const reviewCount = review.length + pendingTags.length + unplaced.length
  const selected = palletId != null ? (ix.pallet.get(palletId) ?? pool.find(p => p.id === palletId) ?? extra.find(p => p.id === palletId) ?? null) : null
  const where = (p: Pallet): string => {
    const m = p.container_id ? ix.pallet.get(p.container_id) : undefined
    if (m) return `on ${m.code} · ${where(m)}`
    const lo = ix.loadOf.get(p.id)
    if (p.status === 'in_transit' && lo) return `On truck ${lo.load.code} · position ${lo.item.position}`
    if (p.status === 'unslotted' && p.received_site) return `Received at ${p.received_site}, needs a spot`
    return whereIs(ix, p.slot_id)
  }
  const looseList = snap.pallets.filter(loose).filter(p => !ix.loadOf.has(p.id))
  const openLoads = (snap.loads ?? []).filter(l => ['planning', 'loading', 'in_transit'].includes(l.status))
  const ctx: LoadCtx = {
    loads: snap.loads ?? [], stops: snap.stops ?? [], items: snap.items ?? [],
    vehicles: snap.vehicles ?? [], customers: snap.customers ?? [],
    pallet: id => ix.pallet.get(id), contents: id => ix.contentsOf.get(id) ?? [], weight: p => weightOf(ix, p), where,
    freezerSpot: id => whereIs(ix, id),
    available: snap.pallets.filter(p => !p.container_id && p.status === 'in_freezer' && !ix.loadOf.has(p.id)),
    busy,
    run: async (fn, ok) => { setBusy(true); try { await fn(); await reload(); flash(ok); return true } catch (e) { flash((e as Error).message, true); await reload().catch(() => {}); return false } finally { setBusy(false) } },
    confirm: (text, ok, fn) => setConfirm({ text, ok, run: fn }),
    openPallet: id => setPalletId(id),
    putBack: (item, p) => { setView('map'); startPlacing({ title: `Putting ${p.code} back in a freezer`, sub: 'Open a freezer and tap the slot.', run: slot => act(() => backend.unloadPallet(item.id, slot.id), `${p.code} back in ${slot.code}`) }) },
    api: backend,
  }
  const byNearness = (p: Pallet) => (a: Pallet, b: Pallet) => {
    const fz = (x: Pallet) => ix.slot.get(x.slot_id ?? -1)?.freezer_id
    return Number(b.slot_id === p.slot_id) - Number(a.slot_id === p.slot_id)
      || Number(fz(b) === fz(p)) - Number(fz(a) === fz(p))
      || where(a).localeCompare(where(b), undefined, { numeric: true })
  }
  const mergeCandidates = (p: Pallet) => looseList
    .filter(x => x.id !== p.id && x.strain && p.strain && x.strain.toLowerCase() === p.strain.toLowerCase())
    .sort(byNearness(p))
  const mixedList = snap.pallets.filter(p => p.kind === 'mixed' && p.status === 'in_freezer')
    .map(p => ({ p, n: ix.contentsOf.get(p.id)?.length ?? 0, w: weightOf(ix, p) }))
  const strainNames = (snap.strains ?? []).filter(s => s.active).map(s => s.name)
  const openFreezer = (id: number) => { setFreezerId(id); setView('freezer'); window.scrollTo(0, 0) }
  const goTo = (slotId: number | null) => {
    const s = slotId != null ? ix.slot.get(slotId) : undefined
    if (s) { const f = ix.freezer.get(s.freezer_id)!; setSite(f.site); openFreezer(f.id) }
  }
  const startPlacing = (pl: Placing, from?: Pallet) => {
    setPlacing(pl); setPalletId(null); setForm(null)
    if (from) goTo(from.container_id ? ix.pallet.get(from.container_id)?.slot_id ?? null : from.slot_id)
  }
  const banner = moving
    ? { title: `Moving ${moving.code}`, sub: `${moving.kind === 'mixed' ? `Mixed · ${ix.contentsOf.get(moving.id)?.length ?? 0} packages` : moving.strain ?? ''} · ${lbs(weightOf(ix, moving))}. From ${whereIs(ix, moving.slot_id)}. Open a freezer and tap a slot.`, cancel: () => setMoving(null) }
    : placing ? { title: placing.title, sub: placing.sub, cancel: () => setPlacing(null) } : null

  return (
    <div className={`app ${banner ? 'is-moving' : ''} ${side ? 'with-side' : ''}`}>
      {side && <div className="side-scrim" onClick={() => toggleSide(false)} />}
      {side && (
        <Sidebar ctx={{
          snap, site, backend,
          slotsOf: id => ix.slotsOf.get(id) ?? [], inSlot: id => ix.inSlot.get(id) ?? [], weight: p => weightOf(ix, p),
          onLoad: p => ix.loadOf.has(p.id), slot: id => ix.slot.get(id),
          freezerOf: id => { const sl = ix.slot.get(id); return sl ? ix.freezer.get(sl.freezer_id) : undefined },
          describe: e => describe(ix, e),
          reviewCounts: { spot: unplaced.length, tags: pendingTags.length, issues: review.length },
          openFreezer: id => { const f = ix.freezer.get(id)!; setSite(f.site); openFreezer(id); if (window.innerWidth < 1000) toggleSide(false) },
          openPallet: id => setPalletId(id),
          openLoad: id => { setLoadId(id); setView('load'); if (window.innerWidth < 1000) toggleSide(false) },
          goReview: () => { setView('review'); if (window.innerWidth < 1000) toggleSide(false) },
          goActivity: () => { setView('activity'); if (window.innerWidth < 1000) toggleSide(false) },
          goTransit: () => { setView('transit'); if (window.innerWidth < 1000) toggleSide(false) },
          searchFor: q => { setQuery(q); setView('map'); if (window.innerWidth < 1000) toggleSide(false) },
          close: () => toggleSide(false),
        }} />
      )}
      <header className="top">
        <button className={`ghost small sidebtn ${side ? 'on-btn' : ''}`} title="Summary" onClick={() => toggleSide(!side)}>☰</button>
        <div className="brand" onClick={() => { setView('map'); setFreezerId(null) }}>
          <img className="logo-img" src="/logo.png" alt="Lifted Farms" /> <span className="app-name">Freezer Map</span> {backend.demo && <span className="demo">DEMO</span>}
        </div>
        <div className="seg">
          {(['OHR', 'GVR'] as Site[]).map(s => (
            <button key={s} className={s === site ? 'on' : ''} onClick={() => { setSite(s); if (view === 'freezer') setView('map') }}>{s}</button>
          ))}
        </div>
        <input className="search" type="search" placeholder="Pallet, strain or tag" value={query}
          onChange={e => { setQuery(e.target.value); if (view === 'freezer' || view === 'activity') setView('map') }} />
        <button className={`ghost small ${view === 'settings' ? 'on-btn' : ''}`} title="Settings" onClick={() => setView('settings')}>⚙ Settings</button>
        <button className="ghost small" title={`Signed in as ${user}. Click to sign out.`} onClick={() => backend.signOut().then(() => setUser(null))}>{who(user)} ⏏</button>
      </header>

      {banner && (
        <div className="movebar">
          <div><b>{banner.title}</b><div className="muted">{banner.sub}</div></div>
          <button className="ghost" onClick={banner.cancel}>Cancel</button>
        </div>
      )}

      <main>
        {view === 'map' && (
          <MapView ix={ix} freezers={siteFreezers} query={query} extra={extra} where={where}
            onOpen={openFreezer} onPallet={setPalletId} />
        )}
        {view === 'freezer' && freezerId != null && (
          <FreezerView ix={ix} freezer={ix.freezer.get(freezerId)!} query={query} moving={moving} placing={!!placing}
            siblings={siteFreezers}
            onOpen={openFreezer}
            onBack={() => setView('map')}
            onSlot={tapSlot}
            onPallet={setPalletId}
            onStatus={(st) => setConfirm({
              text: `Set Freezer ${ix.freezer.get(freezerId)!.number} to "${st}"?`, ok: 'Update',
              run: () => act(() => backend.setFreezerStatus(freezerId, st), 'Freezer status updated'),
            })} />
        )}
        {view === 'review' && (<>
          {unplaced.length > 0 && <>
            <ListView title={`Needs a spot (${unplaced.length})`} empty=""
              note="Pallets that aren't in a freezer slot, including ones just received from a load. Open one and tap Move to put it somewhere."
              items={unplaced} ix={ix} where={where} onPallet={setPalletId} />
            <div style={{ height: 18 }} />
          </>}
          <ListView title={`METRC tags pending (${pendingTags.length})`} empty="No pending tags."
            note="Splits, merges and new pallets waiting on a METRC tag. Open one and tap Enter tag."
            items={pendingTags} ix={ix} where={where} onPallet={setPalletId} />
          <div style={{ height: 18 }} />
          <ListView title={`Import issues (${review.length})`} empty="All clear."
            note="Flagged during import from the spreadsheet: duplicates, items not in the pallet list, or missing data. Fix the info and clear the flag."
            items={review} ix={ix} where={where} onPallet={setPalletId} showReason />
        </>)}
        {view === 'activity' && <ActivityView ix={ix} />}
        {view === 'transit' && <TransitView ctx={ctx} onOpen={id => { setLoadId(id); setView('load'); window.scrollTo(0, 0) }} onNew={() => setLoadForm({})} />}
        {view === 'load' && loadId != null && <LoadView ctx={ctx} loadId={loadId} onBack={() => setView('transit')} onEdit={() => setLoadForm({ load: (snap.loads ?? []).find(l => l.id === loadId) })} />}
        {view === 'settings' && <SettingsView backend={backend} flash={flash} onChanged={() => { reload() }}
          inventoryStrains={snap.pallets.reduce((m, p) => p.strain ? m.set(p.strain, (m.get(p.strain) ?? 0) + 1) : m, new Map<string, number>())} />}
      </main>

      <nav className="bottom">
        <button className={view === 'map' || view === 'freezer' ? 'on' : ''} onClick={() => setView(view !== 'map' && view !== 'freezer' && freezerId != null ? 'freezer' : 'map')}>Map</button>
        <button className={view === 'transit' || view === 'load' ? 'on' : ''} onClick={() => setView('transit')}>Transit{openLoads.length > 0 && <span className="badge">{openLoads.length}</span>}</button>
        <button className={view === 'review' ? 'on' : ''} onClick={() => setView('review')}>Review{reviewCount > 0 && <span className="badge warn">{reviewCount}</span>}</button>
        <button className={view === 'activity' ? 'on' : ''} onClick={() => setView('activity')}>Activity</button>
      </nav>

      {selected && !banner && (
        <PalletSheet ix={ix} p={selected} busy={busy} where={where}
          others={selected.slot_id != null && !selected.container_id ? (ix.inSlot.get(selected.slot_id) ?? []).filter(x => x.id !== selected.id) : []}
          onPick={setPalletId}
          onClose={() => setPalletId(null)}
          onGo={() => { goTo(selected.container_id ? ix.pallet.get(selected.container_id)?.slot_id ?? null : selected.slot_id); setPalletId(null) }}
          onMove={() => { setMoving(selected); setPalletId(null); goTo(selected.slot_id) }}
          onClear={() => act(() => backend.clearReview(selected.id), 'Flag cleared')}
          onForm={(kind) => {
            if (kind === 'addto') setForm({ kind: 'pickmixed', p: selected })
            else if (kind === 'addmixed') setForm({ kind: 'addmixed', m: selected })
            else setForm({ kind, p: selected })
          }}
          onTakeOff={() => {
            const m = ix.pallet.get(selected.container_id!)!
            startPlacing({ title: `Taking ${selected.code} off ${m.code}`, sub: 'Tap the slot it goes to.',
              run: slot => act(() => backend.takeOffMixed(selected.id, slot.id), `${selected.code} moved to ${slot.code}`) }, selected)
          }}
          onBreak={() => setConfirm({
            text: `Break ${selected.code} apart? Each package stays in ${whereIs(ix, selected.slot_id)} as its own pallet, stacked in that slot.`, ok: 'Break apart',
            run: async () => { await act(() => backend.breakMixed(selected.id), `${selected.code} broken apart`); setPalletId(null) },
          })}
          onLineage={(ps) => setPool(ps)}
          loadInfo={ix.loadOf.get(selected.id)}
          customerName={id => (snap.customers ?? []).find(c => c.id === id)?.name ?? ''}
          onOpenLoad={id => { setPalletId(null); setLoadId(id); setView('load') }}
          onPutOnLoad={() => setPickLoad(selected)}
          onPulled={() => { const lo = ix.loadOf.get(selected.id); if (lo) act(() => backend.loadPallet(lo.item.id), `${selected.code} on the truck`) }} />
      )}
      {loadForm && <LoadForm ctx={ctx} load={loadForm.load} onClose={() => setLoadForm(null)} onSaved={id => { setLoadForm(null); setLoadId(id); setView('load') }} />}
      {pickLoad && <PickLoad ctx={ctx} p={pickLoad} onClose={() => setPickLoad(null)} />}

      {form?.kind === 'split' && (
        <SplitForm p={form.p} where={form.p.slot_id != null ? where(form.p) : null} busy={busy} onClose={() => setForm(null)}
          onSubmit={(n, tag, pending, dest, note) => {
            const p = form.p
            const run = (slot: number | null) => submit(() => backend.splitPallet(p.id, n, tag, pending, slot, note), c => `${c.code} created (${lbs(n)})`, () => setPalletId(null))
            if (dest === 'same') run(null)
            else startPlacing({ title: `Splitting ${lbs(n)} off ${p.code}`, sub: 'Tap the slot the new piece goes to.', run: slot => run(slot.id) }, p)
          }} />
      )}
      {form?.kind === 'merge' && (
        <MergeForm p={form.p} candidates={mergeCandidates(form.p)} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(ids, tag, pending, dest, note) => {
            const p = form.p
            const run = (slot: number | null) => submit(() => backend.mergePallets(ids, tag, pending, slot ?? p.slot_id, note), m => `${m.code} created from ${ids.length} pallets`, m => setPalletId(m.id))
            if (dest === 'same') run(null)
            else startPlacing({ title: `Merging ${ids.length} pallets`, sub: 'Tap the slot for the merged pallet.', run: slot => run(slot.id) }, p)
          }} />
      )}
      {form?.kind === 'tag' && (
        <TagForm p={form.p} busy={busy} onClose={() => setForm(null)}
          onSubmit={tag => submit(() => backend.setTag(form.p.id, tag), () => 'Tag saved')} />
      )}
      {form?.kind === 'weight' && (
        <WeightForm p={form.p} busy={busy} onClose={() => setForm(null)}
          onSubmit={(w, note) => submit(() => backend.adjustWeight(form.p.id, w, note), () => 'Weight updated')} />
      )}
      {form?.kind === 'newchoice' && (
        <NewPalletChooser where={slotLabel(form.slot)} onClose={() => setForm(null)}
          onPick={k => setForm({ kind: k === 'mixed' ? 'newmixed' : k === 'merged' ? 'newmerged' : 'newsingle', slot: form.slot })} />
      )}
      {form?.kind === 'newmixed' && (
        <MixedBuilder title="New mixed pallet" target={slotLabel(form.slot)} candidates={looseList} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(lines, note) => submit(() => backend.createMixed(form.slot.id, lines, note), m => `${m.code} created with ${lines.length} package${lines.length === 1 ? '' : 's'}`, m => setPalletId(m.id))} />
      )}
      {form?.kind === 'newmerged' && (
        <MergeHere where={slotLabel(form.slot)} candidates={looseList.filter(p => p.kind !== 'mixed' && p.strain && p.current_weight)} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(ids, tag, pending, note) => submit(() => backend.mergePallets(ids, tag, pending, form.slot.id, note), m => `${m.code} created from ${ids.length} pallets`, m => setPalletId(m.id))} />
      )}
      {form?.kind === 'newsingle' && (
        <SingleForm where={slotLabel(form.slot)} strains={strainNames} busy={busy} onClose={() => setForm(null)}
          onSubmit={i => submit(() => backend.createSingle(form.slot.id, i), p => `${p.code} created`, p => setPalletId(p.id))} />
      )}
      {form?.kind === 'pickmixed' && (
        <PickMixed mixed={mixedList} whereOf={where} onClose={() => setForm(null)}
          onPick={m => setForm({ kind: 'addmixed', m, initial: [form.p] })} />
      )}
      {form?.kind === 'addmixed' && (
        <MixedBuilder title={`Pull for ${form.m.code}`} target={`${form.m.code} · ${whereIs(ix, form.m.slot_id)}`} candidates={looseList} initial={form.initial}
          whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(lines, note) => { const m = form.m; submit(() => backend.addToMixed(m.id, lines, note), () => `Pulled ${lines.length} for ${m.code}`, () => setPalletId(m.id)) }} />
      )}

      {confirm && (
        <div className="scrim" onClick={() => setConfirm(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <p>{confirm.text}</p>
            <div className="row end">
              <button className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={async () => { const c = confirm; setConfirm(null); await c.run() }}>{confirm.ok}</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}
    </div>
  )
}

// ---------- views ----------

function Login() {
  return (
    <div className="center login">
      <img className="logo-login" src="/logo-big.png" alt="Lifted Farms" />
      <h1>Freezer Map</h1>
      <p className="muted">Lifted Farms freezer inventory</p>
      <button className="primary big" onClick={() => backend.signIn()}>Sign in with Microsoft</button>
    </div>
  )
}

function MiniGrid({ ix, slots, query }: { ix: Index; slots: Slot[]; query: string }) {
  return (
    <div className="mini">
      {[...slots].sort((a, b) => a.row - b.row || a.col - b.col).map(s => {
        const ps = ix.inSlot.get(s.id) ?? []
        const mixed = ps.some(p => p.kind === 'mixed')
        const sw = swatch(ps[0]?.strain)
        const hit = ps.some(p => matches(p, query, ix))
        if (ps.length > 1) return (
          <i key={s.id} className={`full stack ${query && !hit ? 'dim' : ''}`}>
            {ps.map(p => { const w = swatch(p.strain); return <b key={p.id} className={p.kind === 'mixed' ? 'mx' : w.cls} style={p.kind === 'mixed' ? undefined : w.style} /> })}
          </i>
        )
        return <i key={s.id} className={`${ps.length ? `full ${mixed ? 'mx' : sw.cls}` : ''} ${query && !hit ? 'dim' : ''}`}
          style={ps.length && !mixed ? sw.style : undefined} />
      })}
    </div>
  )
}

function MapView({ ix, freezers, query, extra, where, onOpen, onPallet }: {
  ix: Index; freezers: Freezer[]; query: string; extra: Pallet[]; where: (p: Pallet) => string
  onOpen: (id: number) => void; onPallet: (id: number) => void
}) {
  const ids = new Set(freezers.map(f => f.id))
  const inSite = (p: Pallet) => p.slot_id != null && ids.has(ix.slot.get(p.slot_id)?.freezer_id ?? -1)
  const tops = [...ix.pallet.values()].filter(p => !p.container_id && inSite(p))
  const packages = [...ix.pallet.values()].filter(p => isPackage(p) && inSite(p))
  const total = packages.reduce((a, p) => a + (p.current_weight ?? 0), 0)
  const open = freezers.reduce((a, f) => f.status === 'Not Working' ? a : a + (ix.slotsOf.get(f.id) ?? []).filter(s => !ix.inSlot.get(s.id)?.length).length, 0)
  const hits = query ? [...ix.pallet.values()].filter(p => matches(p, query)) : []
  const hitIds = new Set(hits.map(h => h.id))
  const older = extra.filter(p => !hitIds.has(p.id))
  const hitLbs = hits.filter(isPackage).reduce((a, p) => a + (p.current_weight ?? 0), 0)
  return (
    <>
      <div className="stats">
        <div><b>{freezers.length}</b><span>freezers</span></div>
        <div><b>{tops.length}</b><span>pallets</span></div>
        <div><b>{Math.round(total).toLocaleString()}</b><span>lbs</span></div>
        <div><b>{open}</b><span>open slots</span></div>
      </div>
      {query && (
        <div className="hits">
          <div className="muted">{hits.length} in inventory matching "{query}"{hits.length > 0 && ` · ${lbs(hitLbs)}`}</div>
          <div className="hitlist">
            {hits.slice(0, 60).map(p => (
              <button key={p.id} className="hit" onClick={() => onPallet(p.id)}>
                <b>{p.code}</b> <span>{p.kind === 'mixed' ? 'Mixed' : p.strain}</span> <span className="muted">{where(p)}</span>
              </button>
            ))}
            {older.slice(0, 30).map(p => (
              <button key={p.id} className="hit old" onClick={() => onPallet(p.id)}>
                <b>{p.code}</b> <span>{p.strain}</span> <span className="muted">{p.status}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="cards">
        {freezers.map(f => {
          const slots = ix.slotsOf.get(f.id) ?? []
          const ps = slots.flatMap(s => ix.inSlot.get(s.id) ?? [])
          const used = slots.filter(s => ix.inSlot.get(s.id)?.length).length
          const w = ps.reduce((a, p) => a + weightOf(ix, p), 0)
          return (
            <button key={f.id} className={`card st-${f.status.replace(/ /g, '-')}`} onClick={() => onOpen(f.id)}>
              <div className="card-h"><b>F{f.number}</b><span className="dot" title={f.status} /></div>
              <MiniGrid ix={ix} slots={slots} query={query} />
              <div className="card-f">{used}/18 · {Math.round(w / 100) / 10}k</div>
            </button>
          )
        })}
      </div>
    </>
  )
}

function FreezerView({ ix, freezer, query, moving, placing, siblings, onOpen, onBack, onSlot, onPallet, onStatus }: {
  ix: Index; freezer: Freezer; query: string; moving: Pallet | null; placing: boolean; siblings: Freezer[]
  onOpen: (id: number) => void; onBack: () => void; onSlot: (s: Slot) => void
  onPallet: (id: number) => void; onStatus: (s: FreezerStatus) => void
}) {
  const slots = ix.slotsOf.get(freezer.id) ?? []
  const grid = [...slots].sort((a, b) => a.row - b.row || a.col - b.col)
  const ps = slots.flatMap(s => ix.inSlot.get(s.id) ?? [])
  const i = siblings.findIndex(f => f.id === freezer.id)
  const prev = siblings[i - 1], next = siblings[i + 1]
  const dead = freezer.status === 'Not Working'
  const choosing = !!moving || placing
  return (
    <div className="freezer">
      <div className="fz-head">
        <button className="ghost" onClick={onBack}>‹ All</button>
        <div className="fz-title">
          <h2>{freezer.site} Freezer {freezer.number}</h2>
          <div className="muted">{ps.length} pallet{ps.length === 1 ? '' : 's'} · {lbs(ps.reduce((a, p) => a + weightOf(ix, p), 0))}</div>
        </div>
        <select className={`status st-${freezer.status.replace(/ /g, '-')}`} value={freezer.status}
          onChange={e => onStatus(e.target.value as FreezerStatus)}>
          {FREEZER_STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="row between">
        <button className="ghost small" disabled={!prev} onClick={() => prev && onOpen(prev.id)}>‹ F{prev?.number ?? ''}</button>
        <span className="muted small-t">BACK</span>
        <button className="ghost small" disabled={!next} onClick={() => next && onOpen(next.id)}>F{next?.number ?? ''} ›</button>
      </div>
      <div className={`grid ${dead && choosing ? 'dead' : ''}`}>
        {grid.map(s => {
          const here = ix.inSlot.get(s.id) ?? []
          const isSrc = moving?.slot_id === s.id
          const stacked = here.length > 1
          const mixed = !stacked && here.some(p => p.kind === 'mixed')
          const sw = swatch(here[0]?.strain)
          const dim = query && !here.some(p => matches(p, query, ix))
          return (
            <button key={s.id}
              className={`tile ${here.length ? 'full' : 'empty'} ${isSrc ? 'src' : ''} ${choosing && !isSrc && !dead ? (here.length ? 'can-combine' : 'can-drop') : ''} ${dim ? 'dim' : ''} ${stacked ? 'stacked' : here.length ? (mixed ? 'mx' : sw.cls) : ''}`}
              style={here.length && !mixed && !stacked ? sw.style : undefined}
              disabled={choosing && dead}
              onClick={() => onSlot(s)}>
              <span className="code">{s.code}</span>
              {here.length === 0 && <span className="muted">{choosing ? (dead ? 'Not working' : 'Place here') : dead ? 'empty' : '+ New pallet'}</span>}
              {here.map(p => {
                const on = ix.contentsOf.get(p.id) ?? []
                const ps = swatch(p.strain)
                return (
                  <span key={p.id} className={`p ${stacked ? `band ${p.kind === 'mixed' ? 'mx' : ps.cls}` : ''}`} style={stacked && p.kind !== 'mixed' ? ps.style : undefined} onClick={e => { if (!choosing) { e.stopPropagation(); onPallet(p.id) } }}>
                    <b>{p.code}{p.needs_review && <span className="flag" title={p.needs_review}>!</span>}{(p.tag_pending || on.some(c => c.tag_pending)) && <span className="flag tag" title="METRC tag pending">T</span>}{ix.loadOf.has(p.id) && <span className="flag load" title={`Planned on ${ix.loadOf.get(p.id)!.load.code}`}>L</span>}</b>
                    <span className="strain">{p.kind === 'mixed' ? `Mixed · ${on.length} pkg${on.length === 1 ? '' : 's'}: ${[...new Set(on.map(c => c.strain))].join(', ')}` : p.strain ?? p.label ?? 'No strain'}</span>
                    <span className="w">{p.kind !== 'mixed' && p.current_weight == null ? 'no weight' : lbs(weightOf(ix, p))}</span>
                  </span>
                )
              })}
            </button>
          )
        })}
      </div>
      <div className="door">DOOR</div>
    </div>
  )
}

function ListView({ title, note, empty, items, ix, where, onPallet, showReason }: {
  title: string; note?: string; empty: string; items: Pallet[]; ix: Index; where: (p: Pallet) => string
  onPallet: (id: number) => void; showReason?: boolean
}) {
  return (
    <div className="list">
      <h2>{title}</h2>
      {note && <p className="muted">{note}</p>}
      {items.length === 0 && empty && <p className="muted">{empty}</p>}
      {items.map(p => (
        <button key={p.id} className="li" onClick={() => onPallet(p.id)}>
          <div><b>{p.code}</b> {p.strain ?? p.label} <span className="muted">{lbs(weightOf(ix, p))}</span></div>
          <div className="muted">{where(p)}{showReason && p.needs_review && <> · <span className="warn-t">{p.needs_review}</span></>}</div>
        </button>
      ))}
    </div>
  )
}

function ActivityView({ ix }: { ix: Index }) {
  const [events, setEvents] = useState<InvEvent[] | null>(null)
  const [names, setNames] = useState<Map<number, string>>(new Map())
  useEffect(() => {
    backend.recentEvents(300).then(async evs => {
      setEvents(evs)
      const missing = [...new Set(evs.map(e => e.pallet_id).filter((id): id is number => id != null && !ix.pallet.has(id)))]
      if (missing.length) setNames(new Map((await backend.byIds(missing)).map(p => [p.id, p.code])))
    })
  }, [ix])
  return (
    <div className="list">
      <h2>Activity</h2>
      {events?.length === 0 && <p className="muted">No moves yet. Everything people do in the app shows up here.</p>}
      {events?.map(e => (
        <div key={e.id} className="li static">
          <div>{describe(ix, e, names)}</div>
          <div className="muted">{when(e.at)} · {who(e.user_email)}{e.note && <> · "{e.note}"</>}</div>
        </div>
      ))}
    </div>
  )
}

type SheetAction = 'split' | 'merge' | 'tag' | 'weight' | 'addto' | 'addmixed'

function PalletSheet({ ix, p, others, busy, where, onClose, onGo, onMove, onClear, onPick, onForm, onTakeOff, onBreak, onLineage, loadInfo, customerName, onOpenLoad, onPutOnLoad, onPulled }: {
  ix: Index; p: Pallet; others: Pallet[]; busy: boolean; where: (p: Pallet) => string
  onClose: () => void; onGo: () => void; onMove: () => void; onClear: () => void; onPick: (id: number) => void
  onForm: (kind: SheetAction) => void; onTakeOff: () => void; onBreak: () => void; onLineage: (ps: Pallet[]) => void
  loadInfo?: { item: LoadItem; load: Load; stop: LoadStop }; customerName: (id: number) => string
  onOpenLoad: (id: number) => void; onPutOnLoad: () => void; onPulled: () => void
}) {
  const [hist, setHist] = useState<InvEvent[] | null>(null)
  const [kin, setKin] = useState<Pallet[]>([])
  const contents = ix.contentsOf.get(p.id) ?? []
  useEffect(() => { setHist(null); backend.palletEvents(p.id).then(setHist) }, [p.id, p.slot_id, p.needs_review, p.current_weight, p.package_tag, p.status, p.container_id, contents.length])
  useEffect(() => {
    if (p.parent_id == null && p.merged_into == null && !/^C\d+$/.test(p.code) && !hist?.some(e => e.type === 'split')) { setKin([]); return }
    backend.lineage(p).then(ps => { setKin(ps); onLineage(ps) }).catch(() => setKin([]))
  }, [p.id, p.parent_id, p.merged_into, hist])
  const live = p.status === 'in_freezer' || p.status === 'unslotted'
  const inFreezer = p.status === 'in_freezer'
  const isMixed = p.kind === 'mixed'
  const loadEditable = loadInfo && ['planning', 'loading'].includes(loadInfo.load.status)
  const container = p.container_id ? ix.pallet.get(p.container_id) : undefined
  const parent = kin.find(k => k.id === p.parent_id)
  const children = kin.filter(k => k.parent_id === p.id)
  const into = kin.find(k => k.id === p.merged_into)
  const sources = kin.filter(k => k.merged_into === p.id)
  const link = (k: Pallet) => <a key={k.id} onClick={() => onPick(k.id)}>{k.code}</a>
  const join = (ks: Pallet[]) => ks.map((k, i) => <span key={k.id}>{i > 0 && ', '}{link(k)}</span>)
  const statusText: Record<string, string> = { merged: 'Merged (closed out)', shipped: 'Delivered (left inventory)', depleted: isMixed ? 'Broken apart' : 'Depleted', archived: 'Not in a freezer (old record)', in_transit: where(p) }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-h">
          <div>
            <h2>{p.code}</h2>
            <div>{isMixed ? `Mixed pallet · ${contents.length} package${contents.length === 1 ? '' : 's'}` : p.strain ?? p.label ?? 'No strain'}</div>
          </div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {p.needs_review && <div className="warnbox">{p.needs_review}</div>}
        {p.tag_pending && live && <div className="warnbox">METRC tag pending. <a onClick={() => onForm('tag')}>Enter tag</a></div>}
        {container && <div className="infobox">On mixed pallet {link(container)}. It moves with {container.code}.</div>}
        {loadInfo && (
          <div className="infobox load" style={{ ['--sc' as string]: stopColor(loadInfo.stop.seq) }}>
            {loadInfo.item.loaded ? 'On the truck: ' : 'Planned on '}<a onClick={() => onOpenLoad(loadInfo.load.id)}>{loadInfo.load.code}</a>
            {' '}· stop {loadInfo.stop.seq} {customerName(loadInfo.stop.customer_id)} · position {loadInfo.item.position}
            {loadEditable && !loadInfo.item.loaded && <div className="row" style={{ marginTop: 6 }}><button className="primary small" disabled={busy} onClick={onPulled}>Pulled onto truck</button></div>}
          </div>
        )}
        <dl>
          <dt>Location</dt><dd>{live && (p.slot_id != null || container) ? <a onClick={onGo}>{container ? whereIs(ix, container.slot_id) : whereIs(ix, p.slot_id)}</a> : live ? where(p) : statusText[p.status] ?? p.status}</dd>
          <dt>Weight</dt><dd>{lbs(weightOf(ix, p)) || 'unknown'}{!isMixed && p.og_weight && p.og_weight !== p.current_weight ? <span className="muted"> (started at {lbs(p.og_weight)})</span> : null}</dd>
          {!isMixed && <>
            <dt>METRC tag</dt><dd className="mono">{p.package_tag ?? (p.tag_pending ? 'pending' : 'none')}</dd>
            <dt>Harvested</dt><dd>{p.harvest_date ?? ''}</dd>
            <dt>Zone</dt><dd>{p.zone ?? ''}</dd>
          </>}
          {parent && <><dt>Split from</dt><dd>{link(parent)}</dd></>}
          {children.length > 0 && <><dt>Split off</dt><dd>{join(children)}</dd></>}
          {sources.length > 0 && <><dt>Made from</dt><dd>{join(sources)}</dd></>}
          {into && <><dt>Merged into</dt><dd>{link(into)}</dd></>}
          {p.notes && <><dt>Notes</dt><dd>{p.notes}</dd></>}
        </dl>
        {isMixed && (
          <div className="contents">
            {contents.length === 0 && <div className="muted">Nothing on this pallet.</div>}
            {contents.map(c => (
              <button key={c.id} className="content" onClick={() => onPick(c.id)}>
                <b>{c.code}</b><span>{c.strain}</span><span>{lbs(c.current_weight)}</span>
                <span className="mono">{c.package_tag ?? (c.tag_pending ? 'tag pending' : 'no tag')}</span>
              </button>
            ))}
          </div>
        )}
        {others.length > 0 && <div className="muted">Stacked with {join(others)}</div>}

        {live && isMixed && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onMove}>Move</button>
            <button className="ghost big" disabled={busy || !!loadInfo} onClick={() => onForm('addmixed')}>Pull packages</button>
            <button className="ghost big" disabled={busy || !!loadInfo} onClick={onBreak}>Break apart</button>
          </div>
          {inFreezer && !loadInfo && <div className="row"><button className="ghost small" disabled={busy} onClick={onPutOnLoad}>Put on a load</button></div>}
        </>)}
        {live && container && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onTakeOff}>Take off {container.code}</button>
          </div>
          <div className="row">
            <button className="ghost small" disabled={busy} onClick={() => onForm('weight')}>Adjust weight</button>
            <button className="ghost small" disabled={busy} onClick={() => onForm('tag')}>{p.package_tag ? 'Edit tag' : 'Enter tag'}</button>
          </div>
        </>)}
        {live && !isMixed && !container && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onMove}>Move</button>
            <button className="ghost big" disabled={busy || !p.current_weight} onClick={() => onForm('split')}>Split</button>
            <button className="ghost big" disabled={busy || !p.strain} onClick={() => onForm('merge')}>Merge</button>
          </div>
          <div className="row">
            <button className="ghost small" disabled={busy || !!loadInfo} onClick={() => onForm('addto')}>Pull for mixed pallet</button>
            {inFreezer && !loadInfo && <button className="ghost small" disabled={busy} onClick={onPutOnLoad}>Put on a load</button>}
            <button className="ghost small" disabled={busy} onClick={() => onForm('weight')}>Adjust weight</button>
            <button className="ghost small" disabled={busy} onClick={() => onForm('tag')}>{p.package_tag ? 'Edit tag' : 'Enter tag'}</button>
            {p.needs_review && <button className="ghost small" disabled={busy} onClick={onClear}>Clear flag</button>}
          </div>
        </>)}
        <h3>History</h3>
        {!hist && <p className="muted">Loading…</p>}
        {hist?.length === 0 && <p className="muted">No history.</p>}
        <div className="timeline">
          {hist?.map(e => (
            <div key={e.id} className={`hist t-${e.type}`}>
              <div>{describe(ix, e, new Map([[p.id, p.code]]))}</div>
              <div className="muted">{when(e.at)} · {who(e.user_email)}{e.note && <> · "{e.note}"</>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
