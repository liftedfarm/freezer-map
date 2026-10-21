import { useCallback, useEffect, useMemo, useState } from 'react'
import { Backend, makeBackend } from './api'
import { FREEZER_STATUSES } from './types'
import type { Freezer, FreezerStatus, InvEvent, Pallet, Site, Slot, Snapshot } from './types'

const backend: Backend = makeBackend()

type View = 'map' | 'freezer' | 'staging' | 'review' | 'activity'

// ---------- helpers ----------

function hue(strain: string | null) {
  if (!strain) return -1
  let h = 0
  for (const c of strain.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
const lbs = (n: number | null | undefined) => n == null ? '' : `${Math.round(n).toLocaleString()} lbs`
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

function describe(ix: Index, e: InvEvent) {
  const code = e.pallet_id != null ? (ix.pallet.get(e.pallet_id)?.code ?? `#${e.pallet_id}`) : ''
  switch (e.type) {
    case 'move': return `${code} moved ${whereIs(ix, e.from_slot_id)} to ${whereIs(ix, e.to_slot_id)}`
    case 'unslot': return `${code} taken out of ${whereIs(ix, e.from_slot_id)} to staging`
    case 'import': return `${code} imported at ${whereIs(ix, e.to_slot_id)}`
    case 'review_cleared': return `${code} review flag cleared`
    case 'freezer_status': {
      const f = e.freezer_id != null ? ix.freezer.get(e.freezer_id) : undefined
      const d = e.details as { from?: string; to?: string } | null
      return `${f ? `${f.site} Freezer ${f.number}` : 'Freezer'}: ${d?.from} to ${d?.to}`
    }
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

  const reload = useCallback(async () => { setSnap(await backend.load()) }, [])
  const flash = (text: string, bad = false) => { setToast({ text, bad }); setTimeout(() => setToast(null), bad ? 5000 : 2500) }

  useEffect(() => { backend.getUser().then(setUser) }, [])
  useEffect(() => {
    if (!user) return
    reload().catch(e => flash(String(e.message ?? e), true))
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
          text: `${slot.code} already has ${here.map(h => h.code).join(', ')}. Combine ${p.code} into the same slot?`,
          ok: 'Combine',
          run: async () => { await act(() => backend.movePallet(p.id, slot.id, true), `${p.code} combined into ${slot.code}`); setMoving(null) },
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

  if (user === undefined) return <div className="center muted">Loading…</div>
  if (!user) return <Login />
  if (!snap || !ix) return <div className="center muted">Loading freezers…</div>

  const siteFreezers = snap.freezers.filter(f => f.site === site).sort((a, b) => a.number - b.number)
  const staging = snap.pallets.filter(p => p.status === 'unslotted')
  const review = snap.pallets.filter(p => p.needs_review)
  const selected = palletId != null ? (ix.pallet.get(palletId) ?? extra.find(p => p.id === palletId) ?? null) : null
  const openFreezer = (id: number) => { setFreezerId(id); setView('freezer'); window.scrollTo(0, 0) }

  return (
    <div className={`app ${moving ? 'is-moving' : ''}`}>
      <header className="top">
        <div className="brand" onClick={() => { setView('map'); setFreezerId(null) }}>
          <span className="logo">❄</span> Freezer Map {backend.demo && <span className="demo">DEMO</span>}
        </div>
        <div className="seg">
          {(['OHR', 'GVR'] as Site[]).map(s => (
            <button key={s} className={s === site ? 'on' : ''} onClick={() => { setSite(s); if (view === 'freezer') setView('map') }}>{s}</button>
          ))}
        </div>
        <input className="search" type="search" placeholder="Pallet, strain or tag" value={query}
          onChange={e => { setQuery(e.target.value); if (view === 'freezer' || view === 'activity') setView('map') }} />
        <button className="ghost small" title={user} onClick={() => backend.signOut().then(() => setUser(null))}>{who(user)} ⏏</button>
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
        {view === 'review' && (
          <ListView title="Needs review" empty="All clear."
            note="Flagged during import from the spreadsheet: duplicates, items not in the pallet list, or missing data. Fix the info in the spreadsheet for now and clear the flag here."
            items={review} ix={ix} onPallet={setPalletId} showReason />
        )}
        {view === 'activity' && <ActivityView ix={ix} />}
      </main>

      <nav className="bottom">
        <button className={view === 'map' || view === 'freezer' ? 'on' : ''} onClick={() => setView(view !== 'map' && view !== 'freezer' && freezerId != null ? 'freezer' : 'map')}>Map</button>
        <button className={view === 'staging' ? 'on' : ''} onClick={() => setView('staging')}>Staging{staging.length > 0 && <span className="badge">{staging.length}</span>}</button>
        <button className={view === 'review' ? 'on' : ''} onClick={() => setView('review')}>Review{review.length > 0 && <span className="badge warn">{review.length}</span>}</button>
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
          onClear={() => act(() => backend.clearReview(selected.id), 'Flag cleared')} />
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
      <div className="logo big">❄</div>
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
        const h = hue(ps[0]?.strain ?? null)
        const hit = ps.some(p => matches(p, query))
        return <i key={s.id} className={`${ps.length ? 'full' : ''} ${query && !hit ? 'dim' : ''} ${ps.length && h < 0 ? 'unk' : ''}`}
          style={ps.length && h >= 0 ? { ['--h' as string]: h } : undefined} />
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
          const h = hue(here[0]?.strain ?? null)
          const dim = query && !here.some(p => matches(p, query))
          return (
            <button key={s.id}
              className={`tile ${here.length ? 'full' : 'empty'} ${isSrc ? 'src' : ''} ${moving && !isSrc && !dead ? (here.length ? 'can-combine' : 'can-drop') : ''} ${dim ? 'dim' : ''} ${here.length && h < 0 ? 'unk' : ''}`}
              style={here.length && h >= 0 ? { ['--h' as string]: h } : undefined}
              disabled={!!moving && dead}
              onClick={() => onSlot(s)}>
              <span className="code">{s.code}</span>
              {here.length === 0 && <span className="muted">{moving ? (dead ? 'Not working' : 'Place here') : 'empty'}</span>}
              {here.map(p => (
                <span key={p.id} className="p" onClick={e => { if (!moving) { e.stopPropagation(); onPallet(p.id) } }}>
                  <b>{p.code}{p.needs_review && <span className="flag" title={p.needs_review}>!</span>}</b>
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
  useEffect(() => { backend.recentEvents(300).then(setEvents) }, [ix])
  return (
    <div className="list">
      <h2>Activity</h2>
      {events?.length === 0 && <p className="muted">No moves yet. Everything people do in the app shows up here.</p>}
      {events?.map(e => (
        <div key={e.id} className="li static">
          <div>{describe(ix, e)}</div>
          <div className="muted">{when(e.at)} · {who(e.user_email)}{e.note && <> · "{e.note}"</>}</div>
        </div>
      ))}
    </div>
  )
}

function PalletSheet({ ix, p, others, busy, onClose, onGo, onMove, onClear, onPick }: {
  ix: Index; p: Pallet; others: Pallet[]; busy: boolean
  onClose: () => void; onGo: () => void; onMove: () => void; onClear: () => void; onPick: (id: number) => void
}) {
  const [hist, setHist] = useState<InvEvent[] | null>(null)
  useEffect(() => { setHist(null); backend.palletEvents(p.id).then(setHist) }, [p.id, p.slot_id, p.needs_review])
  const live = p.status === 'in_freezer' || p.status === 'unslotted'
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
        <dl>
          <dt>Location</dt><dd>{live ? <a onClick={onGo}>{whereIs(ix, p.slot_id)}</a> : p.status}</dd>
          <dt>Weight</dt><dd>{lbs(p.current_weight) || 'unknown'}{p.og_weight && p.og_weight !== p.current_weight ? <span className="muted"> (orig {lbs(p.og_weight)})</span> : null}</dd>
          <dt>METRC tag</dt><dd className="mono">{p.package_tag ?? 'none'}</dd>
          <dt>Harvested</dt><dd>{p.harvest_date ?? ''}</dd>
          <dt>Zone</dt><dd>{p.zone ?? ''}</dd>
          {p.notes && <><dt>Notes</dt><dd>{p.notes}</dd></>}
        </dl>
        {others.length > 0 && (
          <div className="muted">Shares the slot with {others.map(o => <a key={o.id} onClick={() => onPick(o.id)}>{o.code} </a>)}</div>
        )}
        {live && (
          <div className="row">
            <button className="primary big" disabled={busy} onClick={onMove}>Move</button>
            {p.needs_review && <button className="ghost" disabled={busy} onClick={onClear}>Clear flag</button>}
          </div>
        )}
        <h3>History</h3>
        {!hist && <p className="muted">Loading…</p>}
        {hist?.length === 0 && <p className="muted">No history.</p>}
        {hist?.map(e => (
          <div key={e.id} className="hist">
            <div>{describe(ix, e)}</div>
            <div className="muted">{when(e.at)} · {who(e.user_email)}{e.note && <> · "{e.note}"</>}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
