import { useCallback, useEffect, useMemo, useState } from 'react'
import { Backend, CONFIG_MISSING, makeBackend } from './api'
import { FREEZER_STATUSES } from './types'
import { MergeForm, SplitForm, TagForm, WeightForm, lbs } from './forms'
import { SettingsView } from './settings'
import type { Freezer, FreezerStatus, InvEvent, Pallet, Site, Slot, Snapshot } from './types'

const backend: Backend = makeBackend()

type View = 'map' | 'freezer' | 'staging' | 'review' | 'activity' | 'settings'

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

function matches(p: Pallet, q: string) {
  if (!q) return true
  const s = q.toLowerCase()
  return [p.code, p.strain, p.package_tag, p.label].some(v => v?.toLowerCase().includes(s))
}

interface Index {
  freezer: Map<number, Freezer>
  slot: Map<number, Slot>
  slotsOf: Map<number, Slot[]>
  inSlot: Map<number, Pallet[]>
  pallet: Map<number, Pallet>
}

function buildIndex(s: Snapshot): Index {
  const freezer = new Map(s.freezers.map(f => [f.id, f]))
  const slot = new Map(s.slots.map(x => [x.id, x]))
  const slotsOf = new Map<number, Slot[]>()
  for (const x of s.slots) (slotsOf.get(x.freezer_id) ?? slotsOf.set(x.freezer_id, []).get(x.freezer_id)!).push(x)
  const inSlot = new Map<number, Pallet[]>()
  for (const p of s.pallets) if (p.slot_id != null) (inSlot.get(p.slot_id) ?? inSlot.set(p.slot_id, []).get(p.slot_id)!).push(p)
  return { freezer, slot, slotsOf, inSlot, pallet: new Map(s.pallets.map(p => [p.id, p])) }
}

function whereIs(ix: Index, slotId: number | null) {
  if (slotId == null) return 'Staging'
  const s = ix.slot.get(slotId)
  if (!s) return '?'
  const f = ix.freezer.get(s.freezer_id)!
  return `${f.site} F${f.number} · ${s.code}`
}

function describe(ix: Index, e: InvEvent, names?: Map<number, string>) {
  const code = e.pallet_id != null ? (ix.pallet.get(e.pallet_id)?.code ?? names?.get(e.pallet_id) ?? `#${e.pallet_id}`) : ''
  switch (e.type) {
    case 'move': return `${code} moved ${whereIs(ix, e.from_slot_id)} to ${whereIs(ix, e.to_slot_id)}`
    case 'unslot': return `${code} taken out of ${whereIs(ix, e.from_slot_id)} to staging`
    case 'import': return `${code} imported at ${whereIs(ix, e.to_slot_id)}`
    case 'review_cleared': return `${code} review flag cleared`
    case 'split': { const d = e.details as { child?: string; remaining?: number } | null
      return `${code} split: ${lbs(e.lbs)} off to ${d?.child}, ${lbs(d?.remaining)} left` }
    case 'split_from': { const d = e.details as { parent?: string; tag?: string | null } | null
      return `${code} created from ${d?.parent} (${lbs(e.lbs)})${d?.tag ? '' : ', tag pending'}` }
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
    case 'settings': { const d = e.details as { list?: string; name?: string; active?: boolean } | null
      return `${d?.list ? d.list[0].toUpperCase() + d.list.slice(1, -1) : 'Setting'} "${d?.name}" ${e.note === 'added' ? 'added' : d?.active === false ? 'retired' : 'updated'}` }
    default: return `${e.type} ${code}`
  }
}

// ---------- app ----------

export default function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [site, setSite] = useState<Site>('OHR')
  const [view, setView] = useState<View>('map')
  const [freezerId, setFreezerId] = useState<number | null>(null)
  const [palletId, setPalletId] = useState<number | null>(null)
  const [moving, setMoving] = useState<Pallet | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; ok: string; run: () => Promise<void> } | null>(null)
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [extra, setExtra] = useState<Pallet[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<{ kind: 'split' | 'merge' | 'tag' | 'weight'; p: Pallet } | null>(null)
  const [pool, setPool] = useState<Pallet[]>([])

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

  async function act(fn: () => Promise<void>, ok: string) {
    setBusy(true)
    try { await fn(); await reload(); flash(ok) } catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }

  function tapSlot(slot: Slot) {
    if (!ix) return
    const here = ix.inSlot.get(slot.id) ?? []
    if (moving) {
      const p = moving
      if (p.slot_id === slot.id) { flash('That is where it already is', true); return }
      const f = ix.freezer.get(slot.freezer_id)!
      const dest = `${f.site} Freezer ${f.number}, slot ${slot.code}`
      if (here.length) {
        setConfirm({
          text: `${slot.code} already has ${here.map(h => h.code).join(', ')}. Put ${p.code} in the same slot? Each pallet keeps its own number. (To combine same-strain pallets into one, use Merge on the pallet card.)`,
          ok: 'Share slot',
          run: async () => { await act(() => backend.movePallet(p.id, slot.id, true), `${p.code} now shares ${slot.code}`); setMoving(null) },
        })
      } else {
        setConfirm({
          text: `Move ${p.code} to ${dest}?`,
          ok: 'Move',
          run: async () => { await act(() => backend.movePallet(p.id, slot.id, false), `${p.code} moved to ${slot.code}`); setMoving(null) },
        })
      }
      return
    }
    if (here.length === 1) setPalletId(here[0].id)
    else if (here.length > 1) setPalletId(here[0].id)
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
  const staging = snap.pallets.filter(p => p.status === 'unslotted')
  const review = snap.pallets.filter(p => p.needs_review)
  const pendingTags = snap.pallets.filter(p => p.tag_pending)
  const selected = palletId != null ? (ix.pallet.get(palletId) ?? pool.find(p => p.id === palletId) ?? extra.find(p => p.id === palletId) ?? null) : null
  const where = (p: Pallet) => whereIs(ix, p.slot_id)
  const mergeCandidates = (p: Pallet) => snap.pallets
    .filter(x => x.id !== p.id && x.strain && p.strain && x.strain.toLowerCase() === p.strain.toLowerCase())
    .sort((a, b) => Number(b.slot_id === p.slot_id) - Number(a.slot_id === p.slot_id)
      || Number(ix.slot.get(b.slot_id ?? -1)?.freezer_id === ix.slot.get(p.slot_id ?? -1)?.freezer_id) - Number(ix.slot.get(a.slot_id ?? -1)?.freezer_id === ix.slot.get(p.slot_id ?? -1)?.freezer_id)
      || where(a).localeCompare(where(b), undefined, { numeric: true }))
  async function submit<T>(fn: () => Promise<T>, ok: (r: T) => string, after?: (r: T) => void) {
    setBusy(true)
    try { const r = await fn(); await reload(); setForm(null); flash(ok(r)); after?.(r) }
    catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }
  const openFreezer = (id: number) => { setFreezerId(id); setView('freezer'); window.scrollTo(0, 0) }

  return (
    <div className={`app ${moving ? 'is-moving' : ''}`}>
      <header className="top">
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

      {moving && (
        <div className="movebar">
          <div>
            <b>Moving {moving.code}</b> {moving.strain && <>· {moving.strain}</>} {moving.current_weight != null && <>· {lbs(moving.current_weight)}</>}
            <div className="muted">From {whereIs(ix, moving.slot_id)}. Open a freezer and tap a slot.</div>
          </div>
          <div className="row">
            {moving.slot_id != null && (
              <button className="ghost" onClick={() => setConfirm({
                text: `Take ${moving.code} out of the freezer to staging?`, ok: 'Take out',
                run: async () => { await act(() => backend.movePallet(moving.id, null, false), `${moving.code} moved to staging`); setMoving(null) },
              })}>To staging</button>
            )}
            <button className="ghost" onClick={() => setMoving(null)}>Cancel</button>
          </div>
        </div>
      )}

      <main>
        {view === 'map' && (
          <MapView ix={ix} freezers={siteFreezers} query={query} extra={extra}
            onOpen={openFreezer} onPallet={setPalletId} />
        )}
        {view === 'freezer' && freezerId != null && (
          <FreezerView ix={ix} freezer={ix.freezer.get(freezerId)!} query={query} moving={moving}
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
        {view === 'staging' && (
          <ListView title="Staging" empty="Nothing in staging. Pallets taken out of a freezer land here until they're placed again."
            items={staging} ix={ix} onPallet={setPalletId} />
        )}
        {view === 'review' && (<>
          <ListView title={`METRC tags pending (${pendingTags.length})`} empty="No pending tags."
            note="Splits and merges waiting on a new METRC tag. Open one and tap Enter tag."
            items={pendingTags} ix={ix} onPallet={setPalletId} />
          <div style={{ height: 18 }} />
          <ListView title={`Import issues (${review.length})`} empty="All clear."
            note="Flagged during import from the spreadsheet: duplicates, items not in the pallet list, or missing data. Fix the info and clear the flag."
            items={review} ix={ix} onPallet={setPalletId} showReason />
        </>)}
        {view === 'activity' && <ActivityView ix={ix} />}
        {view === 'settings' && <SettingsView backend={backend} flash={flash} onChanged={() => { reload() }}
          inventoryStrains={snap.pallets.reduce((m, p) => p.strain ? m.set(p.strain, (m.get(p.strain) ?? 0) + 1) : m, new Map<string, number>())} />}
      </main>

      <nav className="bottom">
        <button className={view === 'map' || view === 'freezer' ? 'on' : ''} onClick={() => setView(view !== 'map' && view !== 'freezer' && freezerId != null ? 'freezer' : 'map')}>Map</button>
        <button className={view === 'staging' ? 'on' : ''} onClick={() => setView('staging')}>Staging{staging.length > 0 && <span className="badge">{staging.length}</span>}</button>
        <button className={view === 'review' ? 'on' : ''} onClick={() => setView('review')}>Review{review.length + pendingTags.length > 0 && <span className="badge warn">{review.length + pendingTags.length}</span>}</button>
        <button className={view === 'activity' ? 'on' : ''} onClick={() => setView('activity')}>Activity</button>
      </nav>

      {selected && !moving && (
        <PalletSheet ix={ix} p={selected} busy={busy}
          others={selected.slot_id != null ? (ix.inSlot.get(selected.slot_id) ?? []).filter(x => x.id !== selected.id) : []}
          onPick={setPalletId}
          onClose={() => setPalletId(null)}
          onGo={() => {
            const s = selected.slot_id != null ? ix.slot.get(selected.slot_id) : undefined
            if (s) { const f = ix.freezer.get(s.freezer_id)!; setSite(f.site); openFreezer(f.id) }
            setPalletId(null)
          }}
          onMove={() => { setMoving(selected); setPalletId(null); if (selected.slot_id != null) { const f = ix.freezer.get(ix.slot.get(selected.slot_id)!.freezer_id)!; setSite(f.site) } }}
          onClear={() => act(() => backend.clearReview(selected.id), 'Flag cleared')}
          onForm={(kind) => setForm({ kind, p: selected })}
          onLineage={(ps) => setPool(ps)} />
      )}

      {form?.kind === 'split' && (
        <SplitForm p={form.p} where={form.p.slot_id != null ? where(form.p) : null} busy={busy} onClose={() => setForm(null)}
          onSubmit={(n, tag, pending, dest, note) => submit(
            () => backend.splitPallet(form.p.id, n, tag, pending, dest === 'same' ? 'same' : 'staging', note),
            c => `${c.code} created (${lbs(n)})`,
            c => { setPalletId(null); if (dest === 'other') setMoving(c) })} />
      )}
      {form?.kind === 'merge' && (
        <MergeForm p={form.p} candidates={mergeCandidates(form.p)} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(ids, tag, pending, dest, note) => submit(
            () => backend.mergePallets(ids, tag, pending, dest === 'same' ? form.p.slot_id : null, note),
            m => `${m.code} created from ${ids.length} pallets`,
            m => { if (dest === 'other') { setPalletId(null); setMoving(m) } else setPalletId(m.id) })} />
      )}
      {form?.kind === 'tag' && (
        <TagForm p={form.p} busy={busy} onClose={() => setForm(null)}
          onSubmit={tag => submit(() => backend.setTag(form.p.id, tag), () => 'Tag saved')} />
      )}
      {form?.kind === 'weight' && (
        <WeightForm p={form.p} busy={busy} onClose={() => setForm(null)}
          onSubmit={(w, note) => submit(() => backend.adjustWeight(form.p.id, w, note), () => 'Weight updated')} />
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
        const sw = swatch(ps[0]?.strain)
        const hit = ps.some(p => matches(p, query))
        return <i key={s.id} className={`${ps.length ? `full ${sw.cls}` : ''} ${query && !hit ? 'dim' : ''}`}
          style={ps.length ? sw.style : undefined} />
      })}
    </div>
  )
}

function MapView({ ix, freezers, query, extra, onOpen, onPallet }: {
  ix: Index; freezers: Freezer[]; query: string; extra: Pallet[]
  onOpen: (id: number) => void; onPallet: (id: number) => void
}) {
  const ids = new Set(freezers.map(f => f.id))
  const live = [...ix.pallet.values()].filter(p => p.slot_id != null && ids.has(ix.slot.get(p.slot_id)!.freezer_id))
  const total = live.reduce((a, p) => a + (p.current_weight ?? 0), 0)
  const open = freezers.reduce((a, f) => f.status === 'Not Working' ? a : a + (ix.slotsOf.get(f.id) ?? []).filter(s => !ix.inSlot.get(s.id)?.length).length, 0)
  const hits = query ? [...ix.pallet.values()].filter(p => matches(p, query)) : []
  const hitIds = new Set(hits.map(h => h.id))
  const older = extra.filter(p => !hitIds.has(p.id))
  const hitLbs = hits.reduce((a, p) => a + (p.current_weight ?? 0), 0)
  return (
    <>
      <div className="stats">
        <div><b>{freezers.length}</b><span>freezers</span></div>
        <div><b>{live.length}</b><span>pallets</span></div>
        <div><b>{Math.round(total).toLocaleString()}</b><span>lbs</span></div>
        <div><b>{open}</b><span>open slots</span></div>
      </div>
      {query && (
        <div className="hits">
          <div className="muted">{hits.length} in inventory matching "{query}"{hits.length > 0 && ` · ${lbs(hitLbs)}`}</div>
          <div className="hitlist">
            {hits.slice(0, 60).map(p => (
              <button key={p.id} className="hit" onClick={() => onPallet(p.id)}>
                <b>{p.code}</b> <span>{p.strain}</span> <span className="muted">{whereIs(ix, p.slot_id)}</span>
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
          const w = ps.reduce((a, p) => a + (p.current_weight ?? 0), 0)
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

function FreezerView({ ix, freezer, query, moving, siblings, onOpen, onBack, onSlot, onPallet, onStatus }: {
  ix: Index; freezer: Freezer; query: string; moving: Pallet | null; siblings: Freezer[]
  onOpen: (id: number) => void; onBack: () => void; onSlot: (s: Slot) => void
  onPallet: (id: number) => void; onStatus: (s: FreezerStatus) => void
}) {
  const slots = ix.slotsOf.get(freezer.id) ?? []
  const grid = [...slots].sort((a, b) => a.row - b.row || a.col - b.col)
  const ps = slots.flatMap(s => ix.inSlot.get(s.id) ?? [])
  const i = siblings.findIndex(f => f.id === freezer.id)
  const prev = siblings[i - 1], next = siblings[i + 1]
  const dead = freezer.status === 'Not Working'
  return (
    <div className="freezer">
      <div className="fz-head">
        <button className="ghost" onClick={onBack}>‹ All</button>
        <div className="fz-title">
          <h2>{freezer.site} Freezer {freezer.number}</h2>
          <div className="muted">{ps.length} pallets · {lbs(ps.reduce((a, p) => a + (p.current_weight ?? 0), 0))}</div>
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
      <div className={`grid ${dead && moving ? 'dead' : ''}`}>
        {grid.map(s => {
          const here = ix.inSlot.get(s.id) ?? []
          const isSrc = moving?.slot_id === s.id
          const sw = swatch(here[0]?.strain)
          const dim = query && !here.some(p => matches(p, query))
          return (
            <button key={s.id}
              className={`tile ${here.length ? 'full' : 'empty'} ${isSrc ? 'src' : ''} ${moving && !isSrc && !dead ? (here.length ? 'can-combine' : 'can-drop') : ''} ${dim ? 'dim' : ''} ${here.length ? sw.cls : ''}`}
              style={here.length ? sw.style : undefined}
              disabled={!!moving && dead}
              onClick={() => onSlot(s)}>
              <span className="code">{s.code}</span>
              {here.length === 0 && <span className="muted">{moving ? (dead ? 'Not working' : 'Place here') : 'empty'}</span>}
              {here.map(p => (
                <span key={p.id} className="p" onClick={e => { if (!moving) { e.stopPropagation(); onPallet(p.id) } }}>
                  <b>{p.code}{p.needs_review && <span className="flag" title={p.needs_review}>!</span>}{p.tag_pending && <span className="flag tag" title="METRC tag pending">T</span>}</b>
                  <span className="strain">{p.strain ?? p.label ?? 'No strain'}</span>
                  <span className="w">{lbs(p.current_weight)}</span>
                </span>
              ))}
            </button>
          )
        })}
      </div>
      <div className="door">DOOR</div>
    </div>
  )
}

function ListView({ title, note, empty, items, ix, onPallet, showReason }: {
  title: string; note?: string; empty: string; items: Pallet[]; ix: Index
  onPallet: (id: number) => void; showReason?: boolean
}) {
  return (
    <div className="list">
      <h2>{title}</h2>
      {note && <p className="muted">{note}</p>}
      {items.length === 0 && <p className="muted">{empty}</p>}
      {items.map(p => (
        <button key={p.id} className="li" onClick={() => onPallet(p.id)}>
          <div><b>{p.code}</b> {p.strain ?? p.label} <span className="muted">{lbs(p.current_weight)}</span></div>
          <div className="muted">{whereIs(ix, p.slot_id)}{showReason && p.needs_review && <> · <span className="warn-t">{p.needs_review}</span></>}</div>
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

function PalletSheet({ ix, p, others, busy, onClose, onGo, onMove, onClear, onPick, onForm, onLineage }: {
  ix: Index; p: Pallet; others: Pallet[]; busy: boolean
  onClose: () => void; onGo: () => void; onMove: () => void; onClear: () => void; onPick: (id: number) => void
  onForm: (kind: 'split' | 'merge' | 'tag' | 'weight') => void; onLineage: (ps: Pallet[]) => void
}) {
  const [hist, setHist] = useState<InvEvent[] | null>(null)
  const [kin, setKin] = useState<Pallet[]>([])
  useEffect(() => { setHist(null); backend.palletEvents(p.id).then(setHist) }, [p.id, p.slot_id, p.needs_review, p.current_weight, p.package_tag, p.status])
  useEffect(() => {
    if (p.parent_id == null && p.merged_into == null && !/^C\d+$/.test(p.code) && !hist?.some(e => e.type === 'split')) { setKin([]); return }
    backend.lineage(p).then(ps => { setKin(ps); onLineage(ps) }).catch(() => setKin([]))
  }, [p.id, p.parent_id, p.merged_into, hist])
  const live = p.status === 'in_freezer' || p.status === 'unslotted'
  const parent = kin.find(k => k.id === p.parent_id)
  const children = kin.filter(k => k.parent_id === p.id)
  const into = kin.find(k => k.id === p.merged_into)
  const sources = kin.filter(k => k.merged_into === p.id)
  const link = (k: Pallet) => <a key={k.id} onClick={() => onPick(k.id)}>{k.code}</a>
  const join = (ks: Pallet[]) => ks.map((k, i) => <span key={k.id}>{i > 0 && ', '}{link(k)}</span>)
  const statusText: Record<string, string> = { merged: 'Merged (closed out)', shipped: 'Shipped', depleted: 'Depleted', archived: 'Not in a freezer (old record)' }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-h">
          <div>
            <h2>{p.code}</h2>
            <div>{p.strain ?? p.label ?? 'No strain'}</div>
          </div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {p.needs_review && <div className="warnbox">{p.needs_review}</div>}
        {p.tag_pending && live && <div className="warnbox">METRC tag pending. <a onClick={() => onForm('tag')}>Enter tag</a></div>}
        <dl>
          <dt>Location</dt><dd>{live ? <a onClick={onGo}>{whereIs(ix, p.slot_id)}</a> : statusText[p.status] ?? p.status}</dd>
          <dt>Weight</dt><dd>{lbs(p.current_weight) || 'unknown'}{p.og_weight && p.og_weight !== p.current_weight ? <span className="muted"> (started at {lbs(p.og_weight)})</span> : null}</dd>
          <dt>METRC tag</dt><dd className="mono">{p.package_tag ?? (p.tag_pending ? 'pending' : 'none')}</dd>
          <dt>Harvested</dt><dd>{p.harvest_date ?? ''}</dd>
          <dt>Zone</dt><dd>{p.zone ?? ''}</dd>
          {parent && <><dt>Split from</dt><dd>{link(parent)}</dd></>}
          {children.length > 0 && <><dt>Split off</dt><dd>{join(children)}</dd></>}
          {sources.length > 0 && <><dt>Made from</dt><dd>{join(sources)}</dd></>}
          {into && <><dt>Merged into</dt><dd>{link(into)}</dd></>}
          {p.notes && <><dt>Notes</dt><dd>{p.notes}</dd></>}
        </dl>
        {others.length > 0 && (
          <div className="muted">Shares the slot with {join(others)}</div>
        )}
        {live && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onMove}>Move</button>
            <button className="ghost big" disabled={busy || !p.current_weight} onClick={() => onForm('split')}>Split</button>
            <button className="ghost big" disabled={busy || !p.strain} onClick={() => onForm('merge')}>Merge</button>
          </div>
          <div className="row">
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
