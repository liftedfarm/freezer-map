import { Select } from '../combo'
import { TagInput } from '../taginput'
import { CompFleet } from '../fleet/Fleet'
import { StrainLink } from '../strainCard'
import { useBack } from '../nav'
import '../cult/cult.css'
import './proc.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Backend } from '../api'
import type { Customer, Pallet, Product, Strain } from '../types'
import { PRODUCT_LABEL } from '../types'
import { ProcApi } from './api'
import type { DryHarvest, History, Labor, OLine, OutRow, PData, Processor, Req, Run, Shares, Yield } from './api'
import type { PTab } from './tabs'
import { Card, Cards, DashHead, Empty, Tile, Tiles } from '../dash'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, TextIn, errText, useSel, SelAll, SelBox, SelBar, SelButton } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { sameTag, useScanHandler } from '../scanroute'
import { ModulePeople } from '../users'
import { Fold } from '../fold'
import { CrewTab, RunDayLog } from '../pay/CrewView'
import type { RunLite } from '../pay/CrewView'
import { InvTable } from '../invtable'
import { ItemLotRows, TestRows } from '../comp/trace'
import { PackageActions } from '../pkgactions'
import type { Col, GroupBy, Chip } from '../invtable'
import { MetrcNote } from '../metrc'
import type { InvAction } from '../metrc'
import { openMetrcManifest } from '../metrcCall'
import type { PalletManifest } from '../metrcCall'
import { CloseLotButton, ComingBack, NeedsOurTag, ReceiveBackButton, lotBack } from './Returns'

/** the freezer map's pallet actions, handed down from App (same dialogs, same METRC queue) */
export interface InvBridge { act: (p: Pallet, kind: InvAction) => void; info: (id: number) => { load?: string; mixed?: string; inSnap: boolean }; tick: number
  /** flag for review (why) or clear the flag (null) */
  flag?: (p: Pallet, why: string | null) => void }

// ---------- small helpers ----------
const n0 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : Math.round(x).toLocaleString())
const n1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : (Math.round(x * 10) / 10).toLocaleString())
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '')
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
const days = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86400000)
const fmtD = (iso: string | null | undefined) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '')
const canon = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const live = (p: Pallet) => (p.status === 'in_freezer' || p.status === 'unslotted') && p.pushed !== false
const w = (p: Pallet) => p.current_weight ?? 0
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const PL = (p: Product | string | undefined) => PRODUCT_LABEL[(p ?? 'fresh_frozen') as Product] ?? p
const REQ_PRODUCT: Record<Req['product'], string> = { standards: 'Standards', smalls: 'Smalls', trim: 'Trim', any: 'Trimmed (any)' }
const KIND: Record<Run['kind'], string> = { buck: 'Bucking', sort: 'Sorting', trim: 'Trimming', machine: 'Machine trim' }
const OUTS: Record<Run['kind'], Product[]> = { buck: ['bucked', 'trim'], sort: ['bucked_standards', 'smalls'], trim: ['standards', 'smalls', 'trim'], machine: ['standards', 'trim'] }
/** what each run takes in. Hand trim also takes machine trimmed standards (to finish them by hand). */
const takes = (kind: Run['kind'], p: Pallet) => kind === 'buck' ? p.product === 'unbucked' || p.product === 'wet'
  : kind === 'sort' ? p.product === 'bucked'
  : kind === 'machine' ? ['bucked', 'bucked_standards', 'smalls'].includes(p.product ?? '')
  : ['bucked', 'bucked_standards', 'smalls'].includes(p.product ?? '') || (p.product === 'standards' && !!p.machine_trimmed)
const TAKES: Record<Run['kind'], string> = { buck: 'wet or unbucked', sort: 'bucked', trim: 'bucked, bucked standards, smalls or machine trimmed standards', machine: 'bucked, bucked standards or smalls' }
/** sort and machine runs are simple: weight in, weight out, no crew or piece rate */
const simple = (k: Run['kind']) => k === 'sort' || k === 'machine'

interface Ctx {
  d: PData; api: ProcApi; flash: Flash; canEdit: boolean; isAdmin: boolean; reload: () => Promise<void>
  where: (p: Pallet) => string; procName: (id: number | null | undefined) => string; heldFor: (id: number) => string | null
  runOf: (palletId: number) => Run | undefined; openRun: (r: Run, logDate?: string) => void; openPkg: (p: Pallet) => void
  start: (kind: Run['kind'], ids?: number[]) => void; send: (ids: number[]) => void; putAway: (p: Pallet) => void
  manifest: (ids: number[]) => Promise<void>; dried: (ids: number[]) => Promise<void>
  /** the METRC manifest a package went out on, and a button that opens it */
  mfst: (p: Pallet) => ReactNode
  sb: ReturnType<Backend['client']>
  inv?: InvBridge
}

export default function ProcessingView({ backend, flash, tab, go, isAdmin, canEdit, strains, onChanged, inv }: {
  backend: Backend; flash: Flash; tab: PTab; go: (t: PTab) => void; isAdmin: boolean; canEdit: boolean; customers: Customer[]; strains: Strain[]; onChanged: () => void
  inv?: InvBridge
}) {
  const sb = useMemo(() => backend.client(), [backend])
  const api = useMemo(() => (sb ? new ProcApi(sb) : null), [sb])
  const [d, setD] = useState<PData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [logDate, setLogDate] = useState<string | null>(null)
  useBack(!!logDate, () => setLogDate(null))
  const [pkg, setPkg] = useState<Pallet | null>(null)
  const [startKind, setStartKind] = useState<{ kind: Run['kind']; req?: Req; ids?: number[] } | null>(null)
  const [sendIds, setSendIds] = useState<number[] | null>(null)
  const [away, setAway] = useState<Pallet | null>(null)
  const load = useCallback(async () => {
    if (!api) return
    try { setD(await api.load()); setErr(null) } catch (e) { setErr(errText(e)) }
  }, [api])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (inv?.tick) load() }, [inv?.tick])   // a map action (split, merge, weight...) finished
  const [mf, setMf] = useState<Map<number, PalletManifest>>(new Map())
  useEffect(() => {
    if (!sb || !d) return
    const ids = d.pallets.filter(p => p.package_tag && (p.status === 'at_processor' || p.product === 'wet' || p.product === 'unbucked')).map(p => p.id)
    if (!ids.length) return
    sb.rpc('pallet_manifests', { p_ids: ids }).then(({ data }) => setMf(new Map(((data ?? []) as PalletManifest[]).map(x => [x.pallet_id, x]))))
  }, [d, sb])
  // Scan in Processing opens the package card (Buck, Trim, Send to processor...); other tags go to the app's pallet card
  useScanHandler(tag => {
    const p = d?.pallets.find(x => sameTag(x.package_tag, tag))
    if (!p) return false
    setRun(null); setPkg(p); return true
  })

  if (!api) return <div className="list"><h2>Processing</h2><p className="muted">Processing needs the database (not available in the demo).</p></div>
  if (err) return <div className="list"><h2>Processing</h2><div className="warnbox">Couldn't load Processing. If this is the first time, run 047_processing.sql in Supabase. ({err})</div></div>
  if (!d) return <div className="list"><h2>Processing</h2><p className="muted">Loading…</p></div>

  const reload = async () => { await load(); onChanged() }
  const where = (p: Pallet) => {
    if (p.status === 'at_processor') return `At ${d.processors.find(x => x.id === p.processor_id)?.short ?? 'processor'}${p.sent_on ? ` since ${fmtD(p.sent_on)}` : ''}`
    if (p.status === 'depleted') return 'Used up'
    if (p.status === 'shipped') return 'Shipped'
    if (p.status === 'in_transit') return 'On a truck'
    if (p.slot_id == null) return `Needs a spot${p.received_site ? ` (${p.received_site})` : ''}`
    const s = d.slots.get(p.slot_id), f = s ? d.freezers.get(s.freezer_id) : undefined
    if (!s || !f) return '?'
    return f.kind === 'trailer' ? `${f.site} Reefer ${f.number - 100} · ${s.code.slice(2)}` : f.kind === 'staging' ? `${f.site} Staging · ${s.row}` : `${f.site} F${f.number} · ${s.code}`
  }
  const openRuns = new Map(d.inputs.filter(i => d.runs.find(r => r.id === i.run_id)?.status === 'open').map(i => [i.pallet_id, d.runs.find(r => r.id === i.run_id)!]))
  const held = new Map(d.held.map(h => [h.pallet_id, `${h.so ?? ''} ${h.customer}`.trim()]))
  const c: Ctx = {
    d, api, flash, canEdit, isAdmin, reload, where,
    procName: id => d.processors.find(x => x.id === id)?.name ?? '',
    heldFor: id => held.get(id) ?? null, runOf: id => openRuns.get(id),
    openRun: (r, date) => { setRun(r); setLogDate(date ?? null) }, openPkg: p => setPkg(p),
    sb, inv,
    start: (kind, ids) => setStartKind({ kind, ids }), send: ids => setSendIds(ids), putAway: p => setAway(p),
    manifest: async ids => {
      try { const m = await api.manifest(ids); const { manifestPdf, manifestFile } = await import('../manifest'); const b = await manifestPdf(m)
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = manifestFile(m); a.click() } catch (e) { flash(errText(e), true) }
    },
    mfst: p => { const m = mf.get(p.id); return m && sb ? <button className="ghost small" title={`METRC manifest ${m.manifest} (${m.license})`}
      onClick={e => { e.stopPropagation(); openMetrcManifest(sb, m.license, m.manifest).catch(er => flash(errText(er), true)) }}>Manifest {m.manifest.replace(/^0+/, '')}</button> : null },
    dried: async ids => { try { await api.dried(ids); flash(`${ids.length} now unbucked`); await reload() } catch (e) { flash(errText(e), true) } },
  }
  return (
    <div className="proc">
      {tab === 'dashboard' && <Dashboard c={c} go={go} />}
      {tab === 'inbound' && <Inbound c={c} />}
      {tab === 'incoming' && <Drying c={c} />}
      {tab === 'runs' && <Runs c={c} onStart={k => setStartKind({ kind: k })} />}
      {tab === 'crew' && sb && <CrewTab sb={sb} runs={d.runs.filter(r => !simple(r.kind)) as RunLite[]} flash={flash} canEdit={canEdit} isAdmin={isAdmin} onOpenRun={(id, date) => { const r = d.runs.find(x => x.id === id); if (r) c.openRun(r, date) }} />}
      {tab === 'orders' && <Orders c={c} />}
      {tab === 'inventory' && <Inventory c={c} />}
      {tab === 'yields' && <Yields c={c} />}
      {tab === 'review' && <Review c={c} go={go} />}
      {tab === 'settings' && (isAdmin ? <SettingsTab c={c} sb={sb} /> : <div className="list"><h2>Settings</h2><p className="muted">Only Processing Admins can change Processing settings.</p></div>)}
      {sendIds && <SendSheet c={c} ids={sendIds} onClose={() => setSendIds(null)} />}
      {away && <PutAwaySheet c={c} p={away} sb={sb} onClose={() => setAway(null)} />}
      {startKind && <StartRun c={c} kind={startKind.kind} req={startKind.req} pre={startKind.ids} onClose={() => setStartKind(null)} onDone={r => { setStartKind(null); setRun(r) }} />}
      {run && <RunSheet key={run.id} c={c} run={d.runs.find(x => x.id === run.id) ?? run} logDate={logDate} setLogDate={setLogDate} onClose={() => { setRun(null); setLogDate(null) }} />}
      {pkg && <PackageSheet c={c} p={d.pallets.find(x => x.id === pkg.id) ?? pkg} onClose={() => setPkg(null)} />}
    </div>
  )
}

// ---------- shared bits ----------
function Prod({ p }: { p: Product | undefined }) { return <span className={`pill prod pr-${p}`}>{PL(p)}</span> }
function Tag({ p }: { p: Pallet }) { return p.package_tag ? <span className="mono small">…{p.package_tag.slice(-6)}</span> : p.tag_pending ? <span className="warn-t small">tag pending</span> : null }

/** on hand by product (live packages only) */
function onHand(d: PData) {
  const m = new Map<Product, { n: number; lbs: number }>()
  for (const p of d.pallets) {
    if (!(live(p) || p.status === 'at_processor')) continue
    const k = p.product ?? 'fresh_frozen'; const x = m.get(k) ?? { n: 0, lbs: 0 }
    x.n++; x.lbs += w(p); m.set(k, x)
  }
  return m
}
/** dry harvests that still need their wet package (last 3 weeks; older ones were handled before the app) */
const toPackage = (d: PData, all = false) => d.harvests.filter(h => (h.status === 'done' || h.harvested_on) && !d.pallets.some(p => p.from_harvest === h.id) && (all || (h.harvested_on ?? h.planned_on ?? '') >= addDays(today(), -21)))
// ---------- forecasts (049) ----------
type Src = 'strain' | 'all' | 'default'
/** the shares to use for a strain: its own runs + FL25 workbook first, then all strains, then defaults */
export function shares(d: PData, strain: string | null | undefined, harvestDry?: number | null) {
  const s = d.rates.strains[canon(strain)] ?? {}, a = d.rates.all ?? {}
  const pick = (k: keyof Shares, def: number): [number, Src] => { const v = s[k] as number | null | undefined, u = a[k] as number | null | undefined
    return v != null ? [v, 'strain'] : u != null ? [u, 'all'] : [def, 'default'] }
  const dryOwn = s.dry ?? null
  const dry: [number, Src] = dryOwn != null ? [dryOwn, 'strain'] : a.dry != null ? [a.dry, 'all'] : [d.rates.default_dry ?? harvestDry ?? 0.2, 'default']
  return { dry, bt: pick('bt', 0.08), std: pick('std', 0.65), sml: pick('sml', 0.12), trm: pick('trm', 0.18), mold: pick('mold', 0.04) }
}
/** wet / unbucked weight > bucked flower + buck trim; bucked > standards / smalls / trim */
export function forecast(d: PData, p: Pallet) {
  const f = shares(d, p.strain, d.harvests.find(h => h.id === p.from_harvest)?.dry_conversion)
  const bk = p.product === 'bucked' ? w(p) : p.product === 'wet' || p.product === 'unbucked' ? w(p) * f.dry[0] : 0
  return { f, bucked: bk, buckTrim: p.product === 'bucked' ? 0 : bk * f.bt[0], std: bk * f.std[0], sml: bk * f.sml[0], trm: bk * f.trm[0] }
}
const SRC: Record<Src, string> = { strain: "this strain's history", all: 'all strains', default: 'the default' }


// ---------- Dashboard ----------
function Dashboard({ c, go }: { c: Ctx; go: (t: PTab) => void }) {
  const { d } = c
  const oh = onHand(d), g = (k: Product) => oh.get(k) ?? { n: 0, lbs: 0 }
  const away = d.pallets.filter(p => p.status === 'at_processor')
  const openRuns = d.runs.filter(r => r.status === 'open')
  const waiting = d.lines.filter(l => l.picked < l.lbs - 0.01)
  const spot = d.pallets.filter(p => p.status === 'unslotted')
  const pend = d.pallets.filter(p => live(p) && p.tag_pending)
  const toPack = toPackage(d)
  const trimmed = ['standards', 'smalls', 'trim'] as Product[]
  return (
    <div className="dash">
      <DashHead title="Processing" sub="Dry flower: drying, bucking, trimming" />
      <Tiles>
        <Tile label="At processors" value={`${n0(sum(away.map(w)))} lbs`} sub={away.length ? `${away.length} wet package${away.length === 1 ? '' : 's'} out drying` : 'nothing out'} onClick={() => go('incoming')} />
        <Tile label="Unbucked on hand" value={`${n0(g('unbucked').lbs)} lbs`} sub={g('unbucked').n ? `${g('unbucked').n} package${g('unbucked').n === 1 ? '' : 's'} · wet weight on paper` : 'none'} onClick={() => go('inventory')} />
        <Tile label="Bucked on hand" value={`${n0(g('bucked').lbs)} lbs`} sub={g('bucked').n ? `${g('bucked').n} package${g('bucked').n === 1 ? '' : 's'} ready to trim` : 'none'} onClick={() => go('inventory')} />
        <Tile label="Trimmed on hand" value={`${n0(sum(trimmed.map(k => g(k).lbs)))} lbs`} sub={trimmed.map(k => `${PL(k)} ${n0(g(k).lbs)}`).join(' · ')} onClick={() => go('inventory')} />
        <Tile label="Dry orders" value={waiting.length} sub={waiting.length ? `${n0(sum(waiting.map(l => l.lbs - l.picked)))} lbs still to fill (Fulfillment)` : 'nothing waiting'}
          tone={waiting.length ? 'warn' : 'ok'} onClick={() => go('orders')} />
        <Tile label="Open runs" value={openRuns.length} sub={openRuns.length ? openRuns.map(r => r.code).slice(0, 3).join(', ') : 'nothing being worked'} onClick={() => go('runs')} />
        <Tile label="Needs a spot" value={spot.length} sub={spot.length ? `${n0(sum(spot.map(w)))} lbs to put in a trailer` : 'all put away'} tone={spot.length ? 'warn' : 'ok'} onClick={() => go('review')} />
        {(pend.length > 0 || toPack.length > 0) && <Tile label="To do" value={pend.length + toPack.length} sub={[toPack.length && `${toPack.length} dry harvests to package`, pend.length && `${pend.length} tags pending`].filter(Boolean).join(' · ')} tone="warn" onClick={() => go('review')} />}
      </Tiles>
      <Cards>
        <Card title="Dry orders waiting" badge={waiting.length} action="Orders" onAction={() => go('orders')}>
          {waiting.length ? <div className="dlist">{waiting.slice(0, 8).map(l =>
            <div key={l.id} className="drow"><span className="grow"><b>{l.strain}</b> {PL(l.product)} <span className="muted">{l.so} · {l.customer}</span></span>
              <span className="muted">{l.wanted ? fmtD(l.wanted) : ''}</span><b>{n0(l.picked)}/{n0(l.lbs)}</b></div>)}</div>
            : <Empty>No dry orders waiting.</Empty>}
        </Card>
        <Card title="Being worked" badge={openRuns.length} action="Runs" onAction={() => go('runs')}>
          {openRuns.length ? <div className="dlist">{openRuns.map(r => <div key={r.id} className="drow">
            <button className="rowbtn grow" onClick={() => c.openRun(r)}><b>{r.code}</b> {KIND[r.kind]} · {r.strain} <span className="muted">since {fmtD(r.started_on)} · {n0(r.input_lbs)} lbs</span></button>
            {c.canEdit && <button className="ghost small" onClick={() => c.openRun(r, today())}>Log today</button>}</div>)}</div>
            : <Empty>No runs open.</Empty>}
        </Card>
        <Card wide title="On hand by strain, with forecast" action="Inventory" onAction={() => go('inventory')}>
          <ByStrain d={d} />
        </Card>
      </Cards>
    </div>
  )
}

function ByStrain({ d }: { d: PData }) {
  const cols: Product[] = ['wet', 'unbucked', 'bucked', 'bucked_standards', 'standards', 'smalls', 'trim']
  const m = new Map<string, { lbs: Record<string, number>; std: number; sml: number; trm: number }>()
  for (const p of d.pallets) {
    if (!(live(p) || p.status === 'at_processor') || !cols.includes(p.product as Product)) continue
    const k = p.strain ?? '?'; const r = m.get(k) ?? { lbs: {}, std: 0, sml: 0, trm: 0 }
    r.lbs[p.product!] = (r.lbs[p.product!] ?? 0) + w(p)
    const f = forecast(d, p); r.std += f.std; r.sml += f.sml; r.trm += f.trm
    m.set(k, r)
  }
  const rows = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (!rows.length) return <Empty>Nothing on hand yet.</Empty>
  return <div className="cwrap"><table className="ctable small-t">
    <thead><tr><th>Strain</th>{cols.map(k => <th key={k} className="num">{PL(k)}</th>)}<th className="num">~Std to come</th><th className="num">~Smalls</th><th className="num">~Trim</th></tr></thead>
    <tbody>{rows.map(([s, r]) => <tr key={s}><td>{s}</td>{cols.map(k => <td key={k} className="num">{n0(r.lbs[k])}</td>)}
      <td className="num muted">{r.std ? `~${n0(r.std)}` : ''}</td><td className="num muted">{r.sml ? `~${n0(r.sml)}` : ''}</td><td className="num muted">{r.trm ? `~${n0(r.trm)}` : ''}</td></tr>)}</tbody>
  </table></div>
}

// ---------- Drying: dry harvests > wet packages > processors > back unbucked ----------
function Inbound({ c }: { c: Ctx }) {
  return <div className="list">
    <h2>Inbound</h2>
    <p className="muted">Product coming back from processors on their METRC manifest. Open a manifest, give every package a spot (our tag and a reweigh if you have them), and Receive. Which wet lot each package came from is sorted out in Drying › Receive back.</p>
    {c.sb && <ComingBack sb={c.sb} api={c.api} flash={c.flash} reload={c.reload} isAdmin={c.isAdmin} />}
    {c.sb && <NeedsOurTag d={c.d} api={c.api} sb={c.sb} flash={c.flash} reload={c.reload} isAdmin={c.isAdmin} openPkg={c.openPkg} />}
  </div>
}

function Drying({ c }: { c: Ctx }) {
  const { d } = c
  const [wet, setWet] = useState<DryHarvest | null>(null)
  const selWet = useSel()
  const [older, setOlder] = useState(false)
  const toPack = toPackage(d, older), hidden = toPackage(d, true).length - toPackage(d).length
  const wetHere = d.pallets.filter(p => p.product === 'wet' && live(p))
  const away = d.pallets.filter(p => p.status === 'at_processor').sort((a, b) => (a.sent_on ?? '').localeCompare(b.sent_on ?? ''))
  const byProc = new Map<number, Pallet[]>()
  for (const p of away) { const k = p.processor_id ?? 0; byProc.set(k, [...(byProc.get(k) ?? []), p]) }
  const backHere = d.pallets.filter(p => p.status === 'unslotted' && p.product === 'unbucked')
  return (
    <div className="list">
      <h2>Drying</h2>
      <p className="muted">Dry flower leaves the farm as raw wet weight (not deleafed) in one METRC package and goes to a drying processor or our trailers. Processors send it back dry on their METRC manifest, received in Processing › Inbound. Here, put what came back toward each wet lot (Receive back) and close the lot when it's all back.</p>

      <h3 className="csec">Dry harvests to package <span className="muted">{toPack.length || ''}</span></h3>
      {toPack.length ? <div className="cwrap fit"><table className="ctable">
        <thead><tr><th>Harvested</th><th>Strain</th><th className="hide-s">Site · field</th><th className="num">Raw lbs</th><th /></tr></thead>
        <tbody>{toPack.map(h => <tr key={h.id}><td className="nowrap">{fmtD(h.harvested_on ?? h.planned_on)}</td><td>{h.strain}</td><td className="hide-s">{h.site} {h.field ?? ''}</td>
          <td className="num">{h.raw_lbs != null ? n0(h.raw_lbs) : <span className="muted">not logged</span>}</td>
          <td className="num">{c.canEdit && <button className="primary small" onClick={() => setWet(h)}>Make wet package</button>}</td></tr>)}</tbody>
      </table></div> : <p className="muted">Every dry harvest from the last 3 weeks has its wet package.</p>}
      {hidden > 0 && <button className="linkbtn" onClick={() => setOlder(!older)}>{older ? 'Hide older harvests' : `Show ${hidden} older dry harvest${hidden === 1 ? '' : 's'} with no package`}</button>}

      <h3 className="csec row between"><span>Wet, with us <span className="muted">{wetHere.length || ''}</span></span>{wetHere.length > 0 && c.canEdit && <SelButton sel={selWet} />}</h3>
      {wetHere.length ? <PkgTable c={c} rows={wetHere} sel={selWet} /> : <p className="muted">No wet packages waiting here.</p>}
      <SelBar sel={selWet} noun="package" actions={[
        { label: 'Send to a processor', run: async ids => c.send(ids) },
        { label: 'Dried in house', run: ids => c.dried(ids) },
        { label: 'Buck', run: async ids => c.start('buck', ids) },
      ]} />

      <h3 className="csec"><span>At processors <span className="muted">{away.length ? `${away.length} · ${n0(sum(away.map(w)))} lbs wet` : ''}</span></span></h3>
      {!away.length && <p className="muted">Nothing out at a processor.</p>}
      {[...byProc.entries()].map(([pid, ps]) => <div key={pid}>
        <h4 className="subh row between"><span>{c.procName(pid) || 'Unknown processor'} <span className="muted">{ps.length} · {n0(sum(ps.map(w)))} lbs</span></span></h4>
        <PkgTable c={c} rows={ps} extra={p => <span className="row nowrap" style={{ justifyContent: 'flex-end', gap: 6 }}>{c.mfst(p)}{p.sent_on ? <span className={days(p.sent_on, today()) > 21 ? 'warn-t' : 'muted'}>{days(p.sent_on, today())} days out</span> : null}
          {lotBack(p, d) && <span className="okp pill">{lotBack(p, d)}</span>}
          {c.isAdmin && <ReceiveBackButton p={p} d={d} api={c.api} flash={c.flash} reload={c.reload} />}
          {c.isAdmin && <CloseLotButton p={p} d={d} api={c.api} flash={c.flash} reload={c.reload} />}</span>} />
      </div>)}

      <h3 className="csec">Back, needs a spot <span className="muted">{backHere.length || ''}</span></h3>
      {backHere.length ? <PkgTable c={c} rows={backHere} extra={p => c.canEdit ? <span className="row"><button className="ghost small" onClick={e => { e.stopPropagation(); c.putAway(p) }}>Put in a trailer</button>
        <button className="primary small" onClick={e => { e.stopPropagation(); c.start('buck', [p.id]) }}>Buck</button></span> : null} />
        : <p className="muted">Everything that came back is in a trailer. Unbucked packages are in Inventory.</p>}

      {wet && <WetSheet c={c} h={wet} onClose={() => setWet(null)} />}
    </div>
  )
}

function PkgTable({ c, rows, sel, extra, showProduct, extraOnPhone = true }: { c: Ctx; rows: Pallet[]; sel?: ReturnType<typeof useSel>; extra?: (p: Pallet) => ReactNode; showProduct?: boolean; extraOnPhone?: boolean }) {
  return <div className="cwrap fit"><table className="ctable">
    <thead><tr>{sel && <SelAll sel={sel} ids={rows.map(p => p.id)} />}<th>Package</th>{showProduct && <th className="hide-s">Product</th>}<th>Strain</th><th className="hide-s">Crop</th><th className="num">Lbs</th><th className="hide-s">Tag</th><th>Where</th>{extra && <th className={extraOnPhone ? '' : 'hide-s'} />}</tr></thead>
    <tbody>{rows.map(p => { const r = c.runOf(p.id), h = c.heldFor(p.id)
      return <tr key={p.id} className="tap" onClick={() => c.openPkg(p)}>
        {sel && <SelBox sel={sel} id={p.id} />}<td><b>{p.code}</b>{showProduct && <span className="show-s"><Prod p={p.product} /></span>}</td>{showProduct && <td className="hide-s"><Prod p={p.product} /></td>}<td>{p.strain}</td><td className="hide-s">{p.crop_year ?? ''}</td>
        <td className="num">{n0(w(p))}</td><td className="hide-s"><Tag p={p} /></td>
        <td className="small">{c.where(p)}{r ? <span className="pill warnp">in {r.code}</span> : null}{h ? <span className="pill okp">for {h}</span> : null}</td>{extra && <td className={`num ${extraOnPhone ? '' : 'hide-s'}`}>{extra(p)}</td>}</tr> })}</tbody>
  </table></div>
}

function TagIn({ value, onChange, placeholder, pallet }: { value: string; onChange: (v: string) => void; placeholder?: string; pallet?: number }) {
  return <TagInput compact value={value} onChange={onChange} where={{ pallet: pallet ?? null }} placeholder={placeholder ?? 'Last digits or scan (blank = pending)'} />
}

function WetSheet({ c, h, onClose }: { c: Ctx; h: DryHarvest; onClose: () => void }) {
  const procs = c.d.processors.filter(p => p.active)
  const [rows, setRows] = useState<{ lbs: number | null; tag: string }[]>([{ lbs: h.raw_lbs, tag: '' }])
  const [proc, setProc] = useState<number | null>(procs.find(p => !p.in_house)?.id ?? null)
  const [sent, setSent] = useState<string | null>(today())
  const [busy, setBusy] = useState(false)
  const tot = sum(rows.map(r => r.lbs ?? 0))
  const inHouse = procs.find(p => p.id === proc)?.in_house
  async function save() {
    setBusy(true)
    try { const codes = await c.api.makeWet(h.id, rows.filter(r => r.lbs).map(r => ({ lbs: r.lbs!, tag: r.tag })), proc, sent); c.flash(`${codes.join(', ')} made`)
      await c.reload(); onClose() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title="Wet package" sub={`${h.strain} · ${h.site} ${h.field ?? ''} · harvested ${fmtD(h.harvested_on ?? h.planned_on)}`} onClose={onClose}>
    <p className="muted">The raw wet weight that leaves the farm (not deleafed). Usually one package per harvest.</p>
    {rows.map((r, i) => <div key={i} className="row noline">
      <NumIn value={r.lbs} placeholder="lbs" onChange={v => setRows(rs => rs.map((x, j) => j === i ? { ...x, lbs: v } : x))} />
      <TagIn value={r.tag} onChange={v => setRows(rs => rs.map((x, j) => j === i ? { ...x, tag: v } : x))} />
      {rows.length > 1 && <button className="ghost small" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button>}
    </div>)}
    <button className="ghost small" onClick={() => setRows(rs => [...rs, { lbs: null, tag: '' }])}>+ Another package</button>
    {h.raw_lbs != null && tot !== h.raw_lbs && <p className="warn-t small-note">Packages add up to {n0(tot)} lbs; the harvest logged {n0(h.raw_lbs)} lbs raw.</p>}
    <F label="Going to"><Pick value={proc} blank="Stays here for now" options={procs.map(p => ({ v: p.id, l: p.name }))} onChange={setProc} /></F>
    {proc != null && !inHouse && <F label="Sent"><DateIn value={sent} onChange={setSent} /></F>}
    <p className="muted small-note">{proc == null || inHouse ? 'It lands as "Needs a spot" at ' + h.site + '. Mark it "Dried in house" when it comes off the drying racks.' : 'It shows under At processors until it comes back unbucked. Its METRC manifest shows on its line once METRC has it.'}</p>
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Make package" disabled={!tot} />
  </Sheet>
}

function SendSheet({ c, ids, onClose }: { c: Ctx; ids: number[]; onClose: () => void }) {
  const procs = c.d.processors.filter(p => p.active && !p.in_house)
  const [proc, setProc] = useState<number | null>(procs[0]?.id ?? null)
  const [on, setOn] = useState<string | null>(today())
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  async function save() {
    setBusy(true)
    try { await c.api.send(ids, proc!, on); c.flash(`${ids.length} sent to ${c.procName(proc)}`); setSent(true); await c.reload() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const pr = procs.find(p => p.id === proc)
  if (sent) return <Sheet title={`Sent to ${pr?.name ?? 'the processor'}`} onClose={onClose}>
    <p>Make the transfer in METRC if the app isn't sending processor transfers yet. Each package's METRC manifest shows on its line under At processors once METRC has it (nightly, or Compliance › METRC › Pull from METRC).</p>
    {!pr?.license && <p className="warn-t small-note">{pr?.name} has no license on file yet. Add it in Processing › Settings › Processors.</p>}
    <div className="row between csave"><span /><div className="row"><button className="primary" onClick={onClose}>Done</button></div></div>
  </Sheet>
  return <Sheet title={`Send ${ids.length} to a processor`} onClose={onClose}>
    <F label="Processor"><Pick value={proc} options={procs.map(p => ({ v: p.id, l: p.name }))} onChange={setProc} /></F>
    <F label="Sent"><DateIn value={on} onChange={setOn} /></F>
    <p className="muted small-note">The packages leave the map until they come back. Next you can print the manifest sheet for the METRC transfer.</p>
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Sent" disabled={proc == null} />
  </Sheet>
}

/** put a package in a reefer trailer: first open spot, or pick one; pumpkin boxes stack 2 high */
/** Put away (no spot yet) or Move (has a spot): reefer trailers first, then freezers and staging at the same site.
 *  Same move_pallet the freezer map uses. Going to the other farm is a load (transfer manifest), not a move. */
function PutAwaySheet({ c, p, sb, onClose }: { c: Ctx; p: Pallet; sb: ReturnType<Backend['client']>; onClose: () => void }) {
  const moving = p.slot_id != null
  const site = (p.slot_id != null ? c.d.freezers.get(c.d.slots.get(p.slot_id)?.freezer_id ?? -1)?.site : null) ?? p.received_site ?? 'GVR'
  const KO: Record<string, number> = { trailer: 0, freezer: 1, staging: 2 }
  const boxes = [...c.d.freezers.values()].filter(f => f.site === site && (moving || f.kind === 'trailer'))
    .sort((a, b) => (KO[a.kind] ?? 3) - (KO[b.kind] ?? 3) || a.number - b.number)
  const trailers = boxes.filter(f => f.kind === 'trailer')
  const curBox = p.slot_id != null ? c.d.slots.get(p.slot_id)?.freezer_id : undefined
  const [tr, setTr] = useState<number | null>(curBox ?? boxes[0]?.id ?? null)
  const [occ, setOcc] = useState<Map<number, { code: string; strain: string | null }[]> | null>(null)
  const [busy, setBusy] = useState(false)
  const box = boxes.find(f => f.id === tr)
  const cap = box?.kind === 'trailer' ? 2 : 3   // pumpkin boxes go 2 high; freezer pallets get stacked too
  const spots = [...c.d.slots.values()].filter(s => s.freezer_id === tr).sort((a, b) => box?.kind === 'staging' ? a.row - b.row : a.code.localeCompare(b.code, undefined, { numeric: true }))
  const spotName = (s: { code: string; row: number }) => box?.kind === 'trailer' ? s.code.slice(2) : box?.kind === 'staging' ? String(s.row) : s.code
  const boxName = (f: { kind: string; number: number }) => f.kind === 'trailer' ? `Reefer ${f.number - 100}` : f.kind === 'staging' ? 'Staging' : `F${f.number}`
  useEffect(() => {
    if (!sb || !boxes.length) return
    const ids = [...c.d.slots.values()].filter(s => boxes.some(f => f.id === s.freezer_id)).map(s => s.id)
    sb.from('pallets').select('code,strain,slot_id').in('slot_id', ids).eq('status', 'in_freezer').is('container_id', null).neq('id', p.id).then(({ data }) => {
      const m = new Map<number, { code: string; strain: string | null }[]>()
      for (const x of (data ?? []) as { code: string; strain: string | null; slot_id: number }[]) m.set(x.slot_id, [...(m.get(x.slot_id) ?? []), x])
      setOcc(m)
    })
  }, [sb])
  const free = (fid: number) => [...c.d.slots.values()].filter(s => s.freezer_id === fid && !(occ?.get(s.id)?.length)).length
  async function put(slot: number, stack: boolean) {
    if (!sb) return
    setBusy(true)
    try {
      const { error } = await sb.rpc('move_pallet', { p_pallet_id: p.id, p_to_slot: slot, p_combine: stack, p_note: stack ? 'stacked' : null })
      if (error) throw new Error(error.message)
      c.flash(`${p.code} in ${c.where({ ...p, slot_id: slot, status: 'in_freezer' })}`); await c.reload(); onClose()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const first = spots.find(s => s.id !== p.slot_id && !(occ?.get(s.id)?.length))
  return <Sheet title={moving ? `Move ${p.code}` : `Put ${p.code} in a trailer`} sub={`${p.strain} · ${PL(p.product)} · ${n0(w(p))} lbs${moving ? ` · now ${c.where(p)}` : ''}`} onClose={onClose}>
    {!boxes.length ? <p className="muted">No {moving ? 'freezers or trailers' : 'reefer trailers'} at {site}.</p> : <>
      <div className="seg wrap">{boxes.map(f => <button key={f.id} className={tr === f.id ? 'on' : ''} onClick={() => setTr(f.id)}>{boxName(f)} <span className="muted">{occ && f.kind !== 'staging' ? `${free(f.id)} open` : ''}</span></button>)}</div>
      {first && <div className="row csave"><button className="primary" disabled={busy} onClick={() => put(first.id, false)}>First open spot ({spotName(first)})</button></div>}
      <p className="muted small-note">Or tap a spot. A full spot stacks it on top{box?.kind === 'trailer' ? ' (pumpkin boxes go 2 high). Back of the trailer at the top, door at the bottom' : ''}.</p>
      <div className="putgrid">{spots.map(s => { const o = occ?.get(s.id) ?? [], here = s.id === p.slot_id
        return <button key={s.id} className={`putspot ${o.length ? 'full' : ''} ${here ? 'here' : ''}`} disabled={busy || here || o.length >= cap} onClick={() => put(s.id, o.length > 0)}>
          <b>{spotName(s)}</b><span>{here ? 'here now' : o.length ? o.map(x => x.code).join(' + ') : 'open'}</span></button> })}</div>
      {!trailers.length && !moving && <p className="muted">No reefer trailers at {site}.</p>}
      {moving && <MetrcNote kind="move" p={p} />}
    </>}
  </Sheet>
}

// ---------- Runs ----------
function Runs({ c, onStart }: { c: Ctx; onStart: (k: Run['kind']) => void }) {
  const [f, setF] = useState<'open' | 'done' | 'all'>('open')
  const rows = c.d.runs.filter(r => f === 'all' ? r.status !== 'cancelled' : r.status === f)
  return (
    <div className="list">
      <div className="row between wrap toolbar"><h2>Runs</h2>
        {c.canEdit && <div className="row"><button className="primary" onClick={() => onStart('buck')}>+ Bucking</button><button className="primary" onClick={() => onStart('sort')}>+ Sorting</button><button className="primary" onClick={() => onStart('trim')}>+ Trimming</button><button className="primary" onClick={() => onStart('machine')}>+ Machine trim</button></div>}</div>
      <div className="seg">{([['open', `Being worked (${c.d.runs.filter(r => r.status === 'open').length})`], ['done', 'Done'], ['all', 'All']] as const).map(([k, l]) =>
        <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
      {!rows.length ? <p className="muted">{f === 'open' ? 'Nothing being worked. Start a bucking or trimming run when the crew starts on a lot.' : 'No runs yet.'}</p> : <div className="cwrap"><table className="ctable">
        <thead><tr><th>Run</th><th>Strain</th><th className="num">In</th><th className="num">Out</th><th className="num hide-s">Mold</th><th className="num">Moisture / diff.</th><th>Dates</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className="tap" onClick={() => c.openRun(r)}>
          <td><b>{r.code}</b> <span className="muted">{KIND[r.kind]}</span></td><td>{r.strain} <span className="muted">{r.crop_year ?? ''}</span></td>
          <td className="num">{n0(r.input_lbs)}</td><td className="num">{r.status === 'done' ? n0(r.output_lbs) : ''}</td><td className="num hide-s">{r.status === 'done' ? n0(r.mold_lbs) : ''}</td>
          <td className="num">{r.status === 'done' ? <>{n0(r.loss_lbs)} <span className="muted">{pct(r.loss_lbs ?? 0, r.input_lbs ?? 0)}</span></> : ''}</td>
          <td className="nowrap small">{fmtD(r.started_on)}{r.finished_on ? ` – ${fmtD(r.finished_on)}` : r.status === 'open' ? ' · working' : ''}</td></tr>)}</tbody>
      </table></div>}
    </div>
  )
}

function StartRun({ c, kind, req, pre, onClose, onDone }: { c: Ctx; kind: Run['kind']; req?: Req; pre?: number[]; onClose: () => void; onDone: (r: Run) => void }) {
  const cands = c.d.pallets.filter(p => takes(kind, p) && live(p) && !c.runOf(p.id) && !c.heldFor(p.id))
  const strains = [...new Set(cands.map(p => p.strain ?? ''))].sort()
  const preStrain = pre?.length ? c.d.pallets.find(p => p.id === pre[0])?.strain ?? null : null
  const [strain, setStrain] = useState<string | null>(preStrain ?? (req ? (strains.find(s => canon(s) === canon(req.strain)) ?? req.strain) : strains.length === 1 ? strains[0] : null))
  const [pick, setPick] = useState<Record<number, number | null>>(() => Object.fromEntries((pre ?? []).filter(id => cands.some(p => p.id === id)).map(id => [id, null])))
  const [request, setRequest] = useState<number | null>(req?.id ?? null)
  const [notes, setNotes] = useState('')
  const [on, setOn] = useState<string | null>(today())
  const [busy, setBusy] = useState(false)
  const list = cands.filter(p => canon(p.strain) === canon(strain))
  const reqs = c.d.requests.filter(q => q.status === 'open' && canon(q.strain) === canon(strain))
  const chosen = Object.entries(pick)
  const total = sum(chosen.map(([id, lbs]) => lbs ?? w(c.d.pallets.find(p => p.id === Number(id))!)))
  async function save() {
    setBusy(true)
    try {
      const r = await c.api.startRun(kind, chosen.map(([id, lbs]) => ({ pallet: Number(id), lbs: kind === 'buck' ? null : lbs })), kind === 'trim' ? request : null, notes, 'GVR', on)
      c.flash(`${r.code} started`); await c.reload(); onDone(r)
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const TITLE: Record<Run['kind'], string> = { buck: 'Start bucking', sort: 'Start sorting', trim: 'Start trimming', machine: 'Start machine trim' }
  const SUB: Record<Run['kind'], string> = { buck: 'Wet or unbucked packages go in whole (not weighed on the stem; wet ones count as dried in house)',
    sort: 'Bucked flower in; bucked standards and smalls out. No piece rate.', trim: 'Bucked, bucked standards or smalls (or machine trimmed standards to finish by hand), all or part of each',
    machine: 'Smalls or bucked in; standards and trim out. No piece rate. Marked machine trimmed inside the app only (never in METRC or for customers).' }
  return <Sheet wide title={TITLE[kind]} sub={SUB[kind]} onClose={onClose}>
    {!cands.length ? <p className="muted">No {TAKES[kind]} packages free to work on.</p> : <>
      <F label="Strain"><Pick value={strain} blank="Pick a strain…" options={strains.map(s => ({ v: s, l: `${s} (${n0(sum(cands.filter(p => p.strain === s).map(w)))} lbs)` }))} onChange={v => { setStrain(v); setPick({}); setRequest(null) }} /></F>
      {strain && <div className="cwrap"><table className="ctable">
        <thead><tr><th /><th>Package</th><th className="num">Lbs</th><th className="hide-s">Where</th>{kind !== 'buck' && <th className="num">Use</th>}</tr></thead>
        <tbody>{list.map(p => { const on_ = String(p.id) in pick
          return <tr key={p.id}><td className="selcol"><input type="checkbox" checked={on_} onChange={() => setPick(x => { const n = { ...x }; if (on_) delete n[p.id]; else n[p.id] = null; return n })} /></td>
            <td><b>{p.code}</b> {kind !== 'buck' && kind !== 'sort' && <Prod p={p.product} />}{p.machine_trimmed && <span className="muted small"> machine</span>} <Tag p={p} /></td><td className="num">{n0(w(p))}</td><td className="small hide-s">{c.where(p)}</td>
            {kind !== 'buck' && <td className="num">{on_ && <span className="qtyin"><NumIn value={pick[p.id]} placeholder={`all ${n0(w(p))}`} onChange={v => setPick(x => ({ ...x, [p.id]: v }))} /></span>}</td>}</tr> })}</tbody>
      </table></div>}
      {kind === 'trim' && reqs.length > 0 && <F label="For trim request" hint="(optional)"><Pick value={request} blank="None (trimming ahead)" options={reqs.map(q => ({ v: q.id, l: `${n0(q.lbs)} lbs ${REQ_PRODUCT[q.product]}${q.due_on ? ` by ${fmtD(q.due_on)}` : ''}${q.customer_id ? ` · ${c.d.customers.find(x => x.id === q.customer_id)?.name ?? ''}` : ''}` }))} onChange={setRequest} /></F>}
      <div className="grid2"><F label="Started"><DateIn value={on} onChange={setOn} /></F><F label="Notes"><TextIn value={notes} onChange={v => setNotes(v ?? '')} /></F></div>
      <p className="muted small-note">{chosen.length} package{chosen.length === 1 ? '' : 's'} · {n0(total)} lbs{kind === 'buck' ? ' wet weight on paper' : ''}. The packages stay where they are until the run is finished.</p>
    </>}
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Start" disabled={!chosen.length} />
  </Sheet>
}

function RunSheet({ c, run, logDate, setLogDate, onClose }: { c: Ctx; run: Run; logDate: string | null; setLogDate: (d: string | null) => void; onClose: () => void }) {
  const { d } = c
  const ins = d.inputs.filter(i => i.run_id === run.id).map(i => ({ i, p: d.pallets.find(p => p.id === i.pallet_id) }))
  const outs = d.pallets.filter(p => p.run_id === run.id)
  const req = run.request_id ? d.requests.find(q => q.id === run.request_id) : undefined
  const open = run.status === 'open' && c.canEdit
  const [rows, setRows] = useState<OutRow[]>(() => OUTS[run.kind].map(product => ({ product, lbs: null, tag: '' })))
  const [mold, setMold] = useState<number | null>(null)
  const [notes, setNotes] = useState(run.notes ?? '')
  const [on, setOn] = useState<string | null>(today())
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const [crew, setCrew] = useState<Awaited<ReturnType<ProcApi['crewOf']>> | null>(null)
  const [filled, setFilled] = useState(false)
  const [touched, setTouched] = useState(false)   // someone typed a weight: stop filling from the crew log
  const loadCrew = () => c.api.crewOf(run.id).then(setCrew).catch(() => setCrew(null))
  useEffect(() => { loadCrew() }, [run.id])
  // fill what came out from the crew log, so nobody types the same numbers twice. Only while nothing has been typed yet.
  useEffect(() => {
    if (!crew || !crew.people || run.status !== 'open') return
    if (touched) return
    const r2 = (x: number) => Math.round(x * 100) / 100
    const got: Partial<Record<Product, number>> = run.kind === 'buck'
      ? { bucked: crew.lbs, trim: crew.trim + crew.smalls }
      : { standards: crew.lbs, smalls: crew.smalls, trim: crew.trim }
    setRows(rs => rs.map((r, i) => ({ ...r, lbs: got[r.product] && rs.findIndex(x => x.product === r.product) === i ? r2(got[r.product]!) : null })))
    setMold(crew.mold ? r2(crew.mold) : null)
    setFilled(true)
  }, [crew])
  const out = sum(rows.map(r => r.lbs ?? 0)), inp = run.input_lbs ?? 0, loss = inp - out - (mold ?? 0)
  const TRIM_TOL = 0.05   // trimming: in and out should match within 5% (water loss, sticky trays)
  const off = run.kind !== 'buck' && inp > 0 && Math.abs(loss) > inp * TRIM_TOL
  async function fill() {
    try {
      const n = rows.filter(r => r.lbs && !r.tag).length
      const tags = await c.api.nextTags(run.site, n)
      if (!tags.length) { c.flash('No processing tag range for ' + run.site + '. Add one in Admin > Settings > Licenses (Processing packages), or scan.', true); return }
      let k = 0; setRows(rs => rs.map(r => (r.lbs && !r.tag && k < tags.length ? { ...r, tag: tags[k++] } : r)))
    } catch (e) { c.flash(errText(e), true) }
  }
  async function finish() {
    setBusy(true)
    try { const codes = await c.api.finishRun(run.id, rows, mold ?? 0, notes, on); c.flash(`${run.code} done: ${codes.join(', ')} need a spot`); await c.reload(); onClose() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function cancel() {
    setBusy(true)
    try { await c.api.cancelRun(run.id); c.flash(`${run.code} cancelled`); await c.reload(); onClose() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  if (logDate && c.sb) return <Sheet wide title={`${run.code} · ${KIND[run.kind]} · crew`} sub={`${run.strain ?? ''} ${run.crop_year ?? ''}`} onClose={onClose}>
    <button className="ghost small backrun" onClick={() => setLogDate(null)}>← Back to the run</button>
    <RunDayLog sb={c.sb} run={run as RunLite} date0={logDate} flash={c.flash} canEdit={c.canEdit} onSaved={loadCrew} />
  </Sheet>
  return <Sheet wide title={`${run.code} · ${KIND[run.kind]}`} sub={`${run.strain ?? ''} ${run.crop_year ?? ''} · started ${fmtD(run.started_on)}${run.finished_on ? ` · done ${fmtD(run.finished_on)}` : ''}${run.status === 'cancelled' ? ' · cancelled' : ''}`} onClose={onClose}>
    {req && <div className="infobox">For trim request: {n0(req.lbs)} lbs {REQ_PRODUCT[req.product]}{req.due_on ? ` by ${fmtD(req.due_on)}` : ''}{req.customer_id ? ` · ${d.customers.find(x => x.id === req.customer_id)?.name}` : ''}</div>}
    <h3 className="csec">In <span className="muted">{n0(inp)} lbs{run.kind === 'buck' ? ' wet, on paper' : ''}</span></h3>
    <div className="dlist">{ins.map(({ i, p }) => <button key={i.id} className="drow linkrow" onClick={() => p && c.openPkg(p)}>
      <span className="grow"><b>{p?.code ?? `#${i.pallet_id}`}</b> <span className="muted">{p ? PL(p.product) : ''} · {p ? c.where(p) : ''}</span></span><b>{n0(i.lbs)} lbs</b>{!i.whole && <span className="muted">part</span>}</button>)}</div>
    {!simple(run.kind) && <h3 className="csec">Crew {run.status !== 'cancelled' && <button className="ghost small" onClick={() => setLogDate(today())}>{c.canEdit ? 'Log a day' : 'See the days'}</button>}</h3>}
    {!simple(run.kind) && crew && !crew.people && <p className="muted small-note">No crew days logged on this run yet.</p>}
    {!simple(run.kind) && crew && crew.people > 0 && <>
      <div className="cwrap tight"><table className="ctable crewdays">
        <thead><tr><th>Day</th><th className="num">People</th><th className="num">Hours</th><th className="num">{run.kind === 'buck' ? 'Bucked' : 'Flower'}</th><th className="num">lbs/hr</th>
<th className="num hide-s">At target</th><th className="num">Pay</th><th className="num hide-s">Rate</th></tr></thead>
        <tbody>{crew.byDay.map(x => <tr key={x.date} className="tap" onClick={() => setLogDate(x.date)}>
          <td className="nowrap">{fmtD(x.date)}</td><td className="num">{x.people}</td><td className="num">{n1(x.hours)}</td><td className="num">{n1(x.lbs)}</td>
          <td className="num"><b>{x.hours ? (x.lbs / x.hours).toFixed(2) : ''}</b></td>
          <td className="num hide-s">{x.hit}/{x.n}</td><td className="num">${n0(x.pay)}</td>
          <td className={`num hide-s${x.custom ? ' warn-t' : ''}`}>{x.rate != null ? `$${x.rate} @ ${x.target}` : ''}</td></tr>)}</tbody>
        {crew.byDay.length > 1 && <tfoot><tr><td>{crew.days} days</td><td className="num">{crew.people}</td><td className="num">{n1(crew.hours)}</td><td className="num">{n1(crew.lbs)}</td>
          <td className="num"><b>{crew.hours ? (crew.lbs / crew.hours).toFixed(2) : ''}</b></td><td className="num hide-s">{crew.hit}/{crew.n}</td><td className="num">${n0(crew.pay)}</td><td className="hide-s"></td></tr></tfoot>}
      </table></div>
      <p className="muted small-note">{n1(crew.other)} lbs mold / smalls / trim logged too.{run.status === 'done' && run.output_lbs ? ` The crew logged ${pct(crew.lbs + crew.other, (run.output_lbs ?? 0) + (run.mold_lbs ?? 0))} of what came out.` : ''} Tap a day to open it.</p>
    </>}
    {run.status === 'done' && <>
      <h3 className="csec">Out <span className="muted">{n0(run.output_lbs)} lbs</span></h3>
      <div className="dlist">{outs.map(p => <button key={p.id} className="drow linkrow" onClick={() => c.openPkg(p)}>
        <span className="grow"><b>{p.code}</b> <Prod p={p.product} /> <Tag p={p} /></span><span className="muted small">{c.where(p)}</span><b>{n0(p.og_weight)} lbs</b><span className="muted">{pct(p.og_weight ?? 0, inp)}</span></button>)}</div>
      <div className="ckpis"><div><b>{n0(run.mold_lbs)}</b><span>mold / refuse ({pct(run.mold_lbs ?? 0, inp)})</span></div>
        <div><b>{n0(run.loss_lbs)}</b><span>{run.kind === 'buck' ? 'moisture' : 'difference'} ({pct(run.loss_lbs ?? 0, inp)})</span></div></div>
      {run.kind === 'buck' && <p className="muted small-note">Record the mold as waste and the moisture as a weight change in METRC.</p>}
    </>}
    {open && <>
      <h3 className="csec">What came out</h3>
      {simple(run.kind) ? <p className="muted small-note">Weigh what came out. {run.kind === 'machine' ? 'The standards are marked machine trimmed in the app only.' : ''}</p>
        : filled ? <p className="muted small-note">Filled in from the crew log ({crew?.days} day{crew?.days === 1 ? '' : 's'}). If the scale says different on a package, change it here.</p>
        : !crew?.people && <p className="muted small-note">Log the crew's days above (Log a day) and these fill in.</p>}
      {rows.map((r, i) => <div key={i} className="row noline">
        <Select value={r.product} onChange={e => { setTouched(true); setRows(rs => rs.map((x, j) => j === i ? { ...x, product: e.target.value as Product } : x)) }}>{OUTS[run.kind].map(k => <option key={k} value={k}>{PL(k)}{run.kind === 'buck' && k === 'trim' ? ' (buck trim)' : ''}</option>)}</Select>
        <NumIn value={r.lbs} placeholder="lbs" onChange={v => { setTouched(true); setRows(rs => rs.map((x, j) => j === i ? { ...x, lbs: v } : x)) }} />
        <TagIn value={r.tag} onChange={v => setRows(rs => rs.map((x, j) => j === i ? { ...x, tag: v } : x))} />
        {rows.length > 1 && <button className="ghost small" onClick={() => { setTouched(true); setRows(rs => rs.filter((_, j) => j !== i)) }}>✕</button>}
      </div>)}
      <div className="row"><button className="ghost small" onClick={() => { setTouched(true); setRows(rs => [...rs, { product: rs[rs.length - 1]?.product ?? OUTS[run.kind][0], lbs: null, tag: '' }]) }}>+ Another package</button>
        <button className="ghost small" onClick={fill}>Fill next tags</button></div>
      <div className="grid2"><F label="Mold / refuse" hint="(lbs, METRC waste)"><NumIn value={mold} onChange={v => { setTouched(true); setMold(v) }} /></F><F label="Finished"><DateIn value={on} onChange={setOn} /></F></div>
      <F label="Notes"><TextIn value={notes} onChange={v => setNotes(v ?? '')} /></F>
      <div className="ckpis"><div><b>{n0(out)}</b><span>out ({pct(out, inp)})</span></div><div><b>{n0(mold)}</b><span>mold</span></div>
        <div><b className={loss < 0 ? 'bad-t' : ''}>{n1(loss)}</b><span>{run.kind === 'buck' ? 'moisture' : 'difference'} ({pct(loss, inp)})</span></div></div>
      {loss < 0 ? <p className="bad-t small-note">More came out than went in. Check the weights.</p>
        : off && <p className="warn-t small-note">The difference is {pct(loss, inp)} of what went in, more than the usual {TRIM_TOL * 100}%. Check the scale or a missing day in the crew log.</p>}
      <div className="row between csave">
        {sure ? <span className="row"><button className="ghost danger" disabled={busy} onClick={cancel}>Yes, cancel run</button><button className="ghost small" onClick={() => setSure(false)}>Keep</button></span>
          : <button className="ghost" disabled={busy} onClick={() => setSure(true)}>Cancel run</button>}
        <div className="row"><button className="ghost" onClick={onClose}>Close</button><button className="primary" disabled={busy || !out} onClick={finish}>{busy ? 'Saving…' : 'Finish run'}</button></div>
      </div>
    </>}
  </Sheet>
}

// ---------- Inventory: every dry package, as a table (shared InvTable) ----------
const STAGES = ['Wet', 'Out for drying', 'Unbucked', 'Bucked', 'Bucked Standards', 'Standards', 'Smalls', 'Trim']
function Inventory({ c }: { c: Ctx }) {
  const { d } = c
  const stage = (p: Pallet) => p.status === 'at_processor' ? 'Out for drying' : PL(p.product) as string
  const daysOut = (p: Pallet) => p.status === 'at_processor' && p.sent_on ? days(p.sent_on, today()) : null
  const rows = d.pallets.filter(p => live(p) || p.status === 'at_processor')
  const fc = (p: Pallet) => { const f = forecast(d, p); return p.product === 'wet' || p.product === 'unbucked' ? f.bucked : p.product === 'bucked' ? f.std : 0 }
  const cols: Col<Pallet>[] = [
    { k: 'code', l: 'Package', phone: true, get: p => <b>{p.code}</b>, val: p => p.code },
    { k: 'strain', l: 'Strain', phone: true, get: p => p.strain ?? '', val: p => p.strain ?? '' },
    { k: 'stage', l: 'Stage', phone: true, get: p => <><Prod p={p.product} />{p.machine_trimmed && <span className="muted small" title="Inside the app only"> machine</span>}</>, val: stage },
    { k: 'lbs', l: 'Lbs', num: true, phone: true, get: p => <>{n0(w(p))}{p.product === 'wet' || p.product === 'unbucked' ? <span className="muted small"> wet</span> : null}</>, val: w },
    { k: 'proc', l: 'Dried by', get: p => p.processor_id ? c.procName(p.processor_id) : '', val: p => c.procName(p.processor_id) },
    { k: 'sent', l: 'Sent on', get: p => fmtD(p.sent_on), val: p => p.sent_on ?? '' },
    { k: 'out', l: 'Days out', num: true, get: p => { const n = daysOut(p); return n == null ? '' : <span className={n > 21 ? 'warn-t' : ''}>{n}</span> }, val: p => daysOut(p) ?? -1 },
    { k: 'fc', l: 'Forecast', num: true, get: p => { const n = fc(p); return n ? <span className="muted small">~{n0(n)} {p.product === 'bucked' ? 'std' : 'bucked'}</span> : '' }, val: fc },
    { k: 'held', l: 'Committed to', get: p => c.heldFor(p.id) ? <span className="pill okp">{c.heldFor(p.id)}</span> : '', val: p => c.heldFor(p.id) ?? '' },
    { k: 'run', l: 'Open run', get: p => c.runOf(p.id) ? <span className="pill warnp">{c.runOf(p.id)!.code}</span> : '', val: p => c.runOf(p.id)?.code ?? '' },
    { k: 'where', l: 'Where', get: p => <span className="small">{c.where(p)}</span>, val: p => c.where(p) },
    { k: 'crop', l: 'Crop', get: p => p.crop_year ?? '', val: p => p.crop_year ?? 0 },
    { k: 'tag', l: 'METRC tag', on: false, get: p => <Tag p={p} />, val: p => p.package_tag ?? '' },
    { k: 'farm', l: 'Grown at', on: false, get: p => p.origin_site ?? '', val: p => p.origin_site ?? '' },
  ]
  const groups: GroupBy<Pallet>[] = [
    { k: 'stage', l: 'Stage', key: stage, order: k => STAGES.indexOf(k) },
    { k: 'strain', l: 'Strain', key: p => p.strain ?? '' },
    { k: 'proc', l: 'Processor', key: p => p.status === 'at_processor' ? c.procName(p.processor_id) || 'Processor' : 'Here' },
    { k: 'crop', l: 'Crop year', key: p => String(p.crop_year ?? ''), order: k => -Number(k || 0) },
  ]
  const chips: Chip<Pallet>[] = [
    { k: 'stage', l: 'Stage', get: stage, order: STAGES },
    { k: 'crop', l: 'Crop year', get: p => String(p.crop_year ?? '') },
    { k: 'farm', l: 'Grown at', get: p => p.origin_site ?? '' },
  ]
  const picked = (ids: number[]) => d.pallets.filter(p => ids.includes(p.id))
  const all = (ids: number[], ok: (p: Pallet) => boolean, what: string) => { if (picked(ids).every(ok)) return true; c.flash(`Pick only ${what}`, true); return false }
  return <InvTable id="proc" title="Inventory" rows={rows} rowId={p => p.id} cols={cols} groups={groups} defaultGroup="stage" defaultSort="strain" chips={chips}
    text={p => `${p.code} ${p.strain ?? ''} ${p.package_tag ?? ''} ${stage(p)} ${c.procName(p.processor_id)}`}
    lbs={w} onOpen={p => c.openPkg(p)}
    note={<>Every dry package from wet to finished, grouped like a pipeline. Wet and unbucked weights are wet weight on paper. Tap a package for its next step, or Select several to buck, trim or send them together.</>}
    totals={rs => { const fin = rs.filter(p => ['standards', 'smalls', 'trim'].includes(p.product ?? '')); return <>{n0(sum(fin.map(w)))} lbs finished · {rs.filter(p => p.status === 'at_processor').length} out for drying</> }}
    actions={c.canEdit ? [
      { label: 'Buck', run: async ids => { if (all(ids, p => (p.product === 'wet' || p.product === 'unbucked') && live(p), 'wet or unbucked packages that are here')) c.start('buck', ids) } },
      { label: 'Sort', run: async ids => { if (all(ids, p => takes('sort', p) && live(p), 'bucked packages')) c.start('sort', ids) } },
      { label: 'Trim', run: async ids => { if (all(ids, p => takes('trim', p) && live(p), TAKES.trim + ' packages')) c.start('trim', ids) } },
      { label: 'Machine trim', run: async ids => { if (all(ids, p => takes('machine', p) && live(p), TAKES.machine + ' packages')) c.start('machine', ids) } },
      { label: 'Send to processor', run: async ids => { if (all(ids, p => (p.product === 'wet' || p.product === 'unbucked') && live(p), 'wet or unbucked packages that are here')) c.send(ids) } },
    ] : undefined} />
}

/** forecast block: what a wet / unbucked / bucked package should turn into */
function Forecast({ c, p }: { c: Ctx; p: Pallet }) {
  const f = forecast(c.d, p)
  if (!f.bucked) return null
  const src = (x: [number, Src]) => x[1] === 'strain' ? '' : ` (${x[1] === 'all' ? 'all strains' : 'default'})`
  return <div className="fc">
    <b>Forecast</b> <span className="muted">from {SRC[f.f.std[1]]}{p.product !== 'bucked' ? `; drying ${Math.round(f.f.dry[0] * 1000) / 10}% from ${SRC[f.f.dry[1]]}` : ''}</span>
    <div>{p.product !== 'bucked' && <>{n0(w(p))} wet → <b>~{n0(f.bucked)} bucked</b> + ~{n0(f.buckTrim)} buck trim → </>}
      <b>~{n0(f.std)}</b> Standards{src(f.f.std)}, <b>~{n0(f.sml)}</b> Smalls, <b>~{n0(f.trm)}</b> Trim</div>
  </div>
}

function PackageSheet({ c, p, onClose }: { c: Ctx; p: Pallet; onClose: () => void }) {
  const { d } = c
  const r = c.runOf(p.id), h = c.heldFor(p.id)
  const made = p.run_id ? d.runs.find(x => x.id === p.run_id) : undefined
  const usedIn = d.inputs.filter(i => i.pallet_id === p.id).map(i => d.runs.find(x => x.id === i.run_id)).filter((x): x is Run => !!x && x.status !== 'cancelled')
  const here = live(p), free = here && !r && !h, can = c.canEdit
  const info = c.inv?.info(p.id)
  const go = (f: () => void) => { onClose(); f() }
  return <Sheet title={p.code} sub={<><StrainLink name={p.strain} /> <Prod p={p.product} /></>} onClose={onClose}>
    {r && <div className="infobox">Being {r.kind === 'buck' ? 'bucked' : r.kind === 'sort' ? 'sorted' : r.kind === 'machine' ? 'machine trimmed' : 'trimmed'} in <a onClick={() => c.openRun(r)}>{r.code}</a>. Open the run to finish it.</div>}
    {h && <div className="infobox held">Committed to {h}. Distribution ships it from Fulfillment.</div>}
    {can && <div className="actions">
      {free && p.slot_id == null && <button className="ghost" onClick={() => go(() => c.putAway(p))}>Put in a trailer</button>}
      {free && (p.product === 'wet' || p.product === 'unbucked') && <button className="primary" onClick={() => go(() => c.start('buck', [p.id]))}>Buck</button>}
      {free && (p.product === 'wet' || p.product === 'unbucked') && <button className="ghost" onClick={() => go(() => c.send([p.id]))}>Send to processor</button>}
      {free && p.product === 'wet' && <button className="ghost" onClick={() => go(() => c.dried([p.id]))}>Dried here</button>}
      {p.status === 'at_processor' && <span className="muted small">Comes back on the processor's METRC manifest: Processing › Drying › Coming back.</span>}
      {c.mfst(p)}
      {free && p.product === 'bucked' && <button className="ghost" onClick={() => go(() => c.start('sort', [p.id]))}>Sort</button>}
      {free && takes('trim', p) && <button className="primary" onClick={() => go(() => c.start('trim', [p.id]))}>Trim</button>}
      {free && takes('machine', p) && p.product !== 'bucked' && <button className="ghost" onClick={() => go(() => c.start('machine', [p.id]))}>Machine trim</button>}
    </div>}
    {can && here && c.inv && info?.inSnap && <>
      {info.mixed && <div className="infobox">On mixed pallet {info.mixed}. It moves with it; take it off on the freezer map to make a new package from it or merge it.</div>}
      {info.load && <div className="infobox">Planned on load {info.load}. Take it off the load in Transit to make a new package, merge or remove it.</div>}
      <PackageActions p={p} busy={false}
        move={p.slot_id != null && !info.mixed ? { label: 'Move', run: () => go(() => c.putAway(p)) } : null}
        onForm={k => go(() => c.inv!.act(p, k))}
        onLoad={p.status === 'in_freezer' && !info.load && !info.mixed ? () => go(() => c.inv!.act(p, 'load')) : null}
        onRemove={!info.load ? () => go(() => c.inv!.act(p, 'remove')) : null}
        onFlag={c.inv.flag ? why => c.inv!.flag!(p, why) : null} onClear={c.inv.flag ? () => c.inv!.flag!(p, null) : null}
        off={{ split: !!r || !!info.mixed || !w(p), merge: !!r || !!info.mixed, addto: !!r || !!info.mixed || !!info.load, remove: !!r || !!h }} />
      <p className="muted small-note">Each of these shows what to do in METRC and puts it on the Compliance METRC to-do list.</p>
    </>}
    <Forecast c={c} p={p} />
    <dl>
      <dt>Where</dt><dd>{c.where(p)}</dd>
      <dt>Weight</dt><dd>{n0(w(p))} lbs{p.og_weight && p.og_weight !== p.current_weight ? <span className="muted"> (started {n0(p.og_weight)})</span> : null}{p.product === 'wet' || p.product === 'unbucked' ? <span className="muted"> · wet, on paper</span> : null}</dd>
      <dt>METRC tag</dt><dd className="mono">{p.package_tag ?? (p.tag_pending ? 'pending' : 'none')}</dd>
      <dt>Crop year</dt><dd>{p.crop_year ?? ''}</dd>
      <dt>Harvested</dt><dd>{p.harvest_date ?? ''} {p.zone ? <span className="muted">· {p.zone}</span> : null}</dd>
      <dt>Grown at</dt><dd>{p.origin_site ?? ''}</dd>
      <ItemLotRows sb={c.sb} p={p} />
      <TestRows sb={c.sb} palletId={p.id} flash={c.flash} />
      {p.processor_id ? <><dt>Dried by</dt><dd>{c.procName(p.processor_id)}</dd></> : null}
      {made && <><dt>Made in</dt><dd><a onClick={() => c.openRun(made)}>{made.code}</a></dd></>}
      {usedIn.length > 0 && <><dt>Used in</dt><dd>{usedIn.map(x => <a key={x.id} onClick={() => c.openRun(x)}>{x.code} </a>)}</dd></>}
    </dl>
  </Sheet>
}

// ---------- Orders: confirmed orders with dry product (Distribution fills them in Fulfillment) ----------
function Orders({ c }: { c: Ctx }) {
  const { d } = c
  const [all, setAll] = useState(false)
  const byOrder = new Map<number, OLine[]>()
  for (const l of d.lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), l])
  const orders = [...byOrder.values()].filter(ls => all || ls.some(l => l.picked < l.lbs - 0.01))
    .sort((a, b) => (a[0].wanted ?? '9999').localeCompare(b[0].wanted ?? '9999') || (a[0].so ?? '').localeCompare(b[0].so ?? ''))
  return (
    <div className="list">
      <div className="row between wrap toolbar"><h2>Orders</h2>
        <label className="check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Show filled orders too</label></div>
      <p className="muted">Confirmed orders with dry product (bucked, standards, smalls, trim). Distribution fills them from inventory in Fulfillment, the same as fresh frozen.</p>
      {!orders.length ? <p className="muted">No confirmed orders waiting on dry product.</p> : <div className="dlist">{orders.map(ls => { const o = ls[0]
        return <section key={o.order_id} className="dcard ordcard">
          <div className="dcard-h"><h3>{o.so ?? 'Order'} <span className="muted">{o.customer}</span></h3><span className="muted">{o.wanted ? `wanted ${fmtD(o.wanted)}` : ''}{o.on_load ? ' · on a load' : ''}</span></div>
          <div className="dlist">{ls.map(l => { const f = (() => { const have = sum(d.pallets.filter(p => p.product === l.product && live(p) && canon(p.strain) === canon(l.strain) && !c.heldFor(p.id)).map(w)); return have })()
            return <div key={l.id} className="drow"><span className="grow"><b>{l.strain}</b> <Prod p={l.product} /> <span className="muted">{l.crop_year}</span></span>
              <span className="muted small">{n0(f)} lbs free in inventory</span>
              <b className={l.picked >= l.lbs - 0.01 ? 'ok-t' : ''}>{n0(l.picked)} / {n0(l.lbs)} lbs</b></div> })}</div>
        </section> })}</div>}
    </div>
  )
}

// ---------- Yields ----------
function Yields({ c }: { c: Ctx }) {
  const [hist, setHist] = useState<History[]>([])
  const [labor, setLabor] = useState<Labor[]>([])
  useEffect(() => { c.api.history().then(setHist).catch(() => {}) }, [])
  const years = [...new Set([...c.d.runs.map(r => r.crop_year), ...c.d.pallets.map(p => p.crop_year), ...hist.map(h => h.crop_year)].filter((x): x is number => !!x))].sort((a, b) => b - a)
  const [yr, setYr] = useState<number | null>(years[0] ?? new Date().getFullYear())
  const [rows, setRows] = useState<Yield[] | null>(null)
  useEffect(() => { setRows(null); c.api.yields(yr).then(setRows).catch(e => c.flash(errText(e), true)); c.api.labor(yr).then(setLabor) }, [yr])
  // FL25 and other workbook years: from the history table when there are no runs for that strain and year
  const all: (Yield & { src?: string })[] = [...(rows ?? [])]
  for (const h of hist.filter(h => h.crop_year === yr)) {
    if (all.some(y => canon(y.strain) === canon(h.strain) && (y.bucked_in || y.trim_in))) continue
    const ti = h.standards + h.smalls + h.trim_lbs + h.trim_mold
    const wet = Number(h.wet_lbs ?? 0)
    all.push({ strain: h.strain, crop_year: h.crop_year, wet_lbs: wet, bucked_in: wet || h.bucked + h.buck_trim + h.buck_mold, bucked: h.bucked, buck_trim: h.buck_trim, buck_mold: h.buck_mold,
      moisture: wet ? wet - h.bucked - h.buck_trim - h.buck_mold : 0,
      trim_in: ti, standards: h.standards, smalls: h.smalls, trim_lbs: h.trim_lbs, trim_mold: h.trim_mold, trim_loss: 0, buck_runs: 0, trim_runs: 0, src: h.source })
  }
  all.sort((a, b) => a.strain.localeCompare(b.strain))
  const cost = (strain: string, task: 'buck' | 'trim') => { const x = labor.filter(l => canon(l.strain) === canon(strain) && l.task === task); const lbs = sum(x.map(l => l.lbs)), pay = sum(x.map(l => l.pay))
    return lbs ? { per: pay / lbs, pay } : null }
  const $ = (x: { per: number; pay: number } | null) => x ? <>${x.per.toFixed(2)}<div className="muted small">${n0(x.pay)}</div></> : ''
  const z = (v: number | null | undefined) => (v ? n0(v) : '')
  const row = (y: Yield & { src?: string }) => { const wetKnown = y.wet_lbs > 0
    return <tr key={y.strain}>
      <td>{y.strain}{y.src && <div className="muted small">{y.src}</div>}</td><td className="num">{wetKnown ? z(y.wet_lbs) : ''}</td>
      <td className="num">{z(y.bucked)} <span className="muted">{wetKnown ? pct(y.bucked, y.bucked_in) : ''}</span></td><td className="num">{z(y.buck_trim)}</td>
      <td className="num hide-s">{z(y.buck_mold)}</td><td className="num hide-s">{wetKnown ? pct(y.moisture, y.bucked_in) : ''}</td>
      <td className="num">{z(y.standards)} <span className="muted">{pct(y.standards, y.trim_in)}</span></td><td className="num">{z(y.smalls)} <span className="muted">{pct(y.smalls, y.trim_in)}</span></td>
      <td className="num">{z(y.trim_lbs)} <span className="muted">{pct(y.trim_lbs, y.trim_in)}</span></td><td className="num hide-s">{z(y.trim_mold)} <span className="muted">{pct(y.trim_mold, y.trim_in)}</span></td>
      <td className="num"><b>{wetKnown && y.bucked_in ? pct(y.bucked + y.buck_trim, y.bucked_in) : ''}</b></td>
      <td className="num">{$(cost(y.strain, 'buck'))}</td><td className="num">{$(cost(y.strain, 'trim'))}</td></tr> }
  return (
    <div className="list wide">
      <div className="row between wrap toolbar"><h2>Yields</h2>
        <div className="seg">{(years.length ? years : [new Date().getFullYear()]).map(y => <button key={y} className={yr === y ? 'on' : ''} onClick={() => setYr(y)}>{y}</button>)}</div></div>
      <p className="muted">Per strain and crop year, from finished runs (and the FL25 workbook). Bucking % are of the wet weight in; trimming % are of the bucked lbs in. Return from raw = bucked flower + buck trim as a share of the wet weight that was bucked. Labor $/lb = piece pay ÷ flower lbs from the crew logs. These numbers drive the forecasts.</p>
      {!rows ? <p className="muted">Loading…</p> : !all.length ? <p className="muted">Nothing finished for {yr} yet.</p> : <div className="cwrap"><table className="ctable">
        <thead><tr><th>Strain</th><th className="num">Wet</th><th className="num">Bucked</th><th className="num">Buck trim</th><th className="num hide-s">Buck mold</th><th className="num hide-s">Moisture</th>
          <th className="num">Standards</th><th className="num">Smalls</th><th className="num">Trim</th><th className="num hide-s">Trim mold</th><th className="num">Return from raw</th><th className="num">Bucking $/lb</th><th className="num">Trimming $/lb</th></tr></thead>
        <tbody>{all.map(row)}</tbody>
      </table></div>}
    </div>
  )
}

// ---------- Review ----------
function Review({ c, go }: { c: Ctx; go: (t: PTab) => void }) {
  const { d } = c
  const spot = d.pallets.filter(p => p.status === 'unslotted')
  const pend = d.pallets.filter(p => live(p) && p.tag_pending)
  const longOut = d.pallets.filter(p => p.status === 'at_processor' && p.sent_on && days(p.sent_on, today()) > 21)
  const oldRuns = d.runs.filter(r => r.status === 'open' && days(r.started_on, today()) > 7)
  const toPack = toPackage(d)
  const none = !spot.length && !pend.length && !longOut.length && !oldRuns.length && !toPack.length
  return (
    <div className="list">
      <h2>Review</h2>
      {none && <p className="muted">Nothing to look at. Everything's packaged, tagged and put away.</p>}
      {spot.length > 0 && <Fold id="proc.spot" open title="Needs a spot" count={spot.length}><p className="muted">Put these in a reefer trailer.</p><PkgTable c={c} rows={spot} showProduct extra={p => c.canEdit ? <button className="ghost small" onClick={e => { e.stopPropagation(); c.putAway(p) }}>Put in a trailer</button> : null} /></Fold>}
      {pend.length > 0 && <Fold id="proc.pend" open title="METRC tag pending" count={pend.length}><p className="muted">Open the package on the map and tap Enter tag.</p><PkgTable c={c} rows={pend} showProduct /></Fold>}
      {toPack.length > 0 && <Fold id="proc.pack" open title="Dry harvests with no wet package" count={toPack.length} right={<button className="linkbtn" onClick={() => go('incoming')}>Drying ›</button>}>
        <div className="dlist">{toPack.map(h => <div key={h.id} className="drow"><span className="grow">{h.strain} <span className="muted">{h.site} {h.field ?? ''}</span></span><span className="muted">{fmtD(h.harvested_on ?? h.planned_on)}</span><b>{n0(h.raw_lbs)} lbs</b></div>)}</div></Fold>}
      {longOut.length > 0 && <Fold id="proc.out" open title="Out at a processor over 3 weeks" count={longOut.length}><PkgTable c={c} rows={longOut} /></Fold>}
      {oldRuns.length > 0 && <Fold id="proc.runs" open title="Runs open over a week" count={oldRuns.length}>
        <div className="dlist">{oldRuns.map(r => <button key={r.id} className="drow linkrow" onClick={() => c.openRun(r)}><span className="grow"><b>{r.code}</b> {KIND[r.kind]} · {r.strain}</span><span className="muted">since {fmtD(r.started_on)}</span></button>)}</div></Fold>}
    </div>
  )
}

// ---------- Settings ----------
function SettingsTab({ c, sb }: { c: Ctx; sb: ReturnType<Backend['client']> }) {
  const [ed, setEd] = useState<Partial<Processor> | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { await c.api.saveProcessor(ed!); c.flash('Processor saved'); await c.reload(); setEd(null) } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return (
    <div className="list">
      <h2>Processing settings</h2>
      <Fold id="proc.set.procs" open title="Processors" count={c.d.processors.length} right={<button className="ghost small" onClick={() => setEd({ active: true, in_house: false })}>+ Add</button>}>
        <p className="muted">Where dry flower gets dried. License, address and contact go on the manifest sheet. "In house" is our own trailers (no transfer).</p>
        <div className="dlist">{c.d.processors.map(p => <button key={p.id} className="drow linkrow" onClick={() => setEd(p)}>
          <span className="grow"><b>{p.name}</b> <span className="muted">{p.short ?? ''}{p.in_house ? ' · in house' : ''}{p.license ? ` · ${p.license}` : ' · no license on file'}</span></span>{!p.active && <span className="muted">off</span>}</button>)}</div>
      </Fold>
      <DryDefault c={c} />
      <Fold id="proc.set.tags" title="METRC tags">
        <p className="muted">"Fill next tags" on a run uses the "Processing packages" tag range for the site (Admin › Settings › Licenses, on the GVR processor license). Without one, scan or type the tags, or leave them pending.</p>
      </Fold>
      <Fold id="proc.set.vehicles" title="Vehicles and equipment"><CompFleet sb={sb} flash={c.flash} dept="processing" /></Fold>
      <Fold id="proc.set.people" title="People"><ModulePeople sb={sb} module="processing" flash={c.flash} /></Fold>
      {ed && <Sheet title={ed.id ? ed.name : 'New processor'} onClose={() => setEd(null)}>
        <F label="Name"><TextIn value={ed.name} onChange={v => setEd({ ...ed, name: v ?? '' })} /></F>
        <div className="grid2"><F label="Short name"><TextIn value={ed.short} onChange={v => setEd({ ...ed, short: v })} /></F><F label="License"><TextIn value={ed.license} onChange={v => setEd({ ...ed, license: v })} /></F></div>
        <F label="Address"><TextIn value={ed.address} onChange={v => setEd({ ...ed, address: v })} /></F>
        <div className="grid2"><F label="Contact"><TextIn value={ed.contact} onChange={v => setEd({ ...ed, contact: v })} /></F><F label="Phone"><TextIn value={ed.phone} onChange={v => setEd({ ...ed, phone: v })} /></F></div>
        <label className="check"><input type="checkbox" checked={!!ed.in_house} onChange={e => setEd({ ...ed, in_house: e.target.checked })} /> In house (our own trailers)</label>
        <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> Active</label>
        <F label="Notes"><TextIn value={ed.notes} onChange={v => setEd({ ...ed, notes: v })} /></F>
        <SaveBar busy={busy} onCancel={() => setEd(null)} onSave={save} disabled={!ed.name} />
      </Sheet>}
    </div>
  )
}

function DryDefault({ c }: { c: Ctx }) {
  const [v, setV] = useState<number | null>(Math.round((c.d.rates.default_dry ?? 0.2) * 1000) / 10)
  const [busy, setBusy] = useState(false)
  const save = async () => { setBusy(true); try { await c.api.setDryDefault((v ?? 0) / 100); c.flash('Saved'); await c.reload() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) } }
  return <Fold id="proc.set.fc" title="Forecasts">
    <p className="muted">Forecasts use each strain's own finished runs and the FL25 workbook first, then all strains together. Until there are bucking runs, wet to bucked uses this default.</p>
    <div className="row"><F label="Wet to bucked (%)"><NumIn value={v} onChange={setV} /></F><button className="ghost" disabled={busy || !v} onClick={save}>Save</button></div>
  </Fold>
}

export type { OLine }
