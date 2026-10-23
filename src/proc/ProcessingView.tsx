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
import { ScanButton } from '../scan'
import { ModulePeople } from '../users'
import { Fold } from '../fold'
import { CrewTab } from '../pay/CrewView'

// ---------- small helpers ----------
const n0 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : Math.round(x).toLocaleString())
const n1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : (Math.round(x * 10) / 10).toLocaleString())
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '')
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
const days = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86400000)
const fmtD = (iso: string | null | undefined) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '')
const canon = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const live = (p: Pallet) => p.status === 'in_freezer' || p.status === 'unslotted'
const w = (p: Pallet) => p.current_weight ?? 0
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const PL = (p: Product | string | undefined) => PRODUCT_LABEL[(p ?? 'fresh_frozen') as Product] ?? p
const REQ_PRODUCT: Record<Req['product'], string> = { standards: 'Standards', smalls: 'Smalls', trim: 'Trim', any: 'Trimmed (any)' }
const KIND: Record<Run['kind'], string> = { buck: 'Bucking', trim: 'Trimming' }
const OUTS: Record<Run['kind'], Product[]> = { buck: ['bucked', 'trim'], trim: ['standards', 'smalls', 'trim'] }

interface Ctx {
  d: PData; api: ProcApi; flash: Flash; canEdit: boolean; isAdmin: boolean; reload: () => Promise<void>
  where: (p: Pallet) => string; procName: (id: number | null | undefined) => string; heldFor: (id: number) => string | null
  runOf: (palletId: number) => Run | undefined; openRun: (r: Run) => void; openPkg: (p: Pallet) => void
  start: (kind: Run['kind'], ids?: number[]) => void; send: (ids: number[]) => void; back: (ids: number[]) => void; putAway: (p: Pallet) => void
  manifest: (ids: number[]) => Promise<void>; dried: (ids: number[]) => Promise<void>
}

export default function ProcessingView({ backend, flash, tab, go, isAdmin, canEdit, strains, onChanged }: {
  backend: Backend; flash: Flash; tab: PTab; go: (t: PTab) => void; isAdmin: boolean; canEdit: boolean; customers: Customer[]; strains: Strain[]; onChanged: () => void
}) {
  const sb = useMemo(() => backend.client(), [backend])
  const api = useMemo(() => (sb ? new ProcApi(sb) : null), [sb])
  const [d, setD] = useState<PData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [pkg, setPkg] = useState<Pallet | null>(null)
  const [startKind, setStartKind] = useState<{ kind: Run['kind']; req?: Req; ids?: number[] } | null>(null)
  const [sendIds, setSendIds] = useState<number[] | null>(null)
  const [backIds, setBackIds] = useState<number[] | null>(null)
  const [away, setAway] = useState<Pallet | null>(null)
  const load = useCallback(async () => {
    if (!api) return
    try { setD(await api.load()); setErr(null) } catch (e) { setErr(errText(e)) }
  }, [api])
  useEffect(() => { load() }, [load])

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
    openRun: r => setRun(r), openPkg: p => setPkg(p),
    start: (kind, ids) => setStartKind({ kind, ids }), send: ids => setSendIds(ids), back: ids => setBackIds(ids), putAway: p => setAway(p),
    manifest: async ids => {
      try { const m = await api.manifest(ids); const { manifestPdf, manifestFile } = await import('../manifest'); const b = await manifestPdf(m)
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = manifestFile(m); a.click() } catch (e) { flash(errText(e), true) }
    },
    dried: async ids => { try { await api.dried(ids); flash(`${ids.length} now unbucked`); await reload() } catch (e) { flash(errText(e), true) } },
  }
  const strainNames = strains.filter(s => s.active).map(s => s.name)
  return (
    <div className="proc">
      {tab === 'dashboard' && <Dashboard c={c} go={go} />}
      {tab === 'incoming' && <Drying c={c} />}
      {tab === 'runs' && <Runs c={c} onStart={k => setStartKind({ kind: k })} />}
      {tab === 'crew' && sb && <CrewTab sb={sb} runs={d.runs} flash={flash} canEdit={canEdit} strainNames={strainNames} />}
      {tab === 'available' && <Available c={c} />}
      {tab === 'inventory' && <Inventory c={c} />}
      {tab === 'yields' && <Yields c={c} />}
      {tab === 'review' && <Review c={c} go={go} />}
      {tab === 'settings' && (isAdmin ? <SettingsTab c={c} sb={sb} /> : <div className="list"><h2>Settings</h2><p className="muted">Only Processing Admins can change Processing settings.</p></div>)}
      {sendIds && <SendSheet c={c} ids={sendIds} onClose={() => setSendIds(null)} />}
      {backIds && <BackSheet c={c} ids={backIds} onClose={() => setBackIds(null)} />}
      {away && <PutAwaySheet c={c} p={away} sb={sb} onClose={() => setAway(null)} />}
      {startKind && <StartRun c={c} kind={startKind.kind} req={startKind.req} pre={startKind.ids} onClose={() => setStartKind(null)} onDone={r => { setStartKind(null); setRun(r) }} />}
      {run && <RunSheet c={c} run={d.runs.find(x => x.id === run.id) ?? run} onClose={() => setRun(null)} />}
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
const promisedOn = (d: PData, id: number, product?: string) => sum(d.promises.filter(x => x.pallet_id === id && (!product || x.product === product)).map(x => x.lbs))


// ---------- Dashboard ----------
function Dashboard({ c, go }: { c: Ctx; go: (t: PTab) => void }) {
  const { d } = c
  const oh = onHand(d), g = (k: Product) => oh.get(k) ?? { n: 0, lbs: 0 }
  const away = d.pallets.filter(p => p.status === 'at_processor')
  const openRuns = d.runs.filter(r => r.status === 'open')
  const waiting = d.lines.filter(l => l.picked + l.promised < l.lbs - 0.01)
  const spot = d.pallets.filter(p => p.status === 'unslotted')
  const pend = d.pallets.filter(p => live(p) && p.tag_pending)
  const toPack = toPackage(d)
  const trimmed = ['standards', 'smalls', 'trim'] as Product[]
  return (
    <div className="list">
      <DashHead title="Processing" sub="Dry flower: drying, bucking, trimming" />
      <Tiles>
        <Tile label="At processors" value={`${n0(sum(away.map(w)))} lbs`} sub={away.length ? `${away.length} wet packages out drying` : 'nothing out'} onClick={() => go('incoming')} />
        <Tile label="Unbucked on hand" value={`${n0(g('unbucked').lbs)} lbs`} sub={g('unbucked').n ? `${g('unbucked').n} package${g('unbucked').n === 1 ? '' : 's'} · wet weight on paper` : 'none'} onClick={() => go('inventory')} />
        <Tile label="Bucked on hand" value={`${n0(g('bucked').lbs)} lbs`} sub={g('bucked').n ? `${g('bucked').n} package${g('bucked').n === 1 ? '' : 's'} ready to trim` : 'none'} onClick={() => go('inventory')} />
        <Tile label="Trimmed on hand" value={`${n0(sum(trimmed.map(k => g(k).lbs)))} lbs`} sub={trimmed.map(k => `${PL(k)} ${n0(g(k).lbs)}`).join(' · ')} onClick={() => go('inventory')} />
        <Tile label="Orders waiting" value={waiting.length} sub={waiting.length ? `${n0(sum(waiting.map(l => l.lbs - l.picked - l.promised)))} lbs of dry product not covered yet` : 'every dry order line is covered'}
          tone={waiting.length ? 'warn' : 'ok'} onClick={() => go('available')} />
        <Tile label="Open runs" value={openRuns.length} sub={openRuns.length ? openRuns.map(r => r.code).slice(0, 3).join(', ') : 'nothing being worked'} onClick={() => go('runs')} />
        <Tile label="Needs a spot" value={spot.length} sub={spot.length ? `${n0(sum(spot.map(w)))} lbs to put in a trailer` : 'all put away'} tone={spot.length ? 'warn' : 'ok'} onClick={() => go('review')} />
        {(pend.length > 0 || toPack.length > 0) && <Tile label="To do" value={pend.length + toPack.length} sub={[toPack.length && `${toPack.length} dry harvests to package`, pend.length && `${pend.length} tags pending`].filter(Boolean).join(' · ')} tone="warn" onClick={() => go('review')} />}
      </Tiles>
      <Cards>
        <Card title="Dry orders waiting" badge={waiting.length} action="Available" onAction={() => go('available')}>
          {waiting.length ? <div className="dlist">{waiting.slice(0, 8).map(l =>
            <div key={l.id} className="drow"><span className="grow"><b>{l.strain}</b> {PL(l.product)} <span className="muted">{l.so} · {l.customer}</span></span>
              <span className="muted">{l.wanted ? fmtD(l.wanted) : ''}</span><b>{n0(l.picked + l.promised)}/{n0(l.lbs)}</b></div>)}</div>
            : <Empty>No dry orders waiting.</Empty>}
        </Card>
        <Card title="Being worked" badge={openRuns.length} action="Runs" onAction={() => go('runs')}>
          {openRuns.length ? <div className="dlist">{openRuns.map(r => <button key={r.id} className="drow linkrow" onClick={() => c.openRun(r)}>
            <span className="grow"><b>{r.code}</b> {KIND[r.kind]} · {r.strain}</span><span className="muted">since {fmtD(r.started_on)}</span><b>{n0(r.input_lbs)} lbs</b></button>)}</div>
            : <Empty>No runs open.</Empty>}
        </Card>
        <Card title="On hand by strain" action="Inventory" onAction={() => go('inventory')}>
          <ByStrain d={d} />
        </Card>
      </Cards>
    </div>
  )
}

function ByStrain({ d }: { d: PData }) {
  const cols: Product[] = ['unbucked', 'bucked', 'standards', 'smalls', 'trim']
  const m = new Map<string, Record<string, number>>()
  for (const p of d.pallets) {
    if (!live(p) || !cols.includes(p.product as Product)) continue
    const k = p.strain ?? '?'; const r = m.get(k) ?? {}; r[p.product!] = (r[p.product!] ?? 0) + w(p); m.set(k, r)
  }
  const rows = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (!rows.length) return <Empty>Nothing on hand yet.</Empty>
  return <div className="cwrap"><table className="ctable small-t">
    <thead><tr><th>Strain</th>{cols.map(k => <th key={k} className="num">{PL(k)}</th>)}</tr></thead>
    <tbody>{rows.map(([s, r]) => <tr key={s}><td>{s}</td>{cols.map(k => <td key={k} className="num">{n0(r[k])}</td>)}</tr>)}</tbody>
  </table></div>
}

// ---------- Drying: dry harvests > wet packages > processors > back unbucked ----------
function Drying({ c }: { c: Ctx }) {
  const { d } = c
  const [wet, setWet] = useState<DryHarvest | null>(null)
  const selWet = useSel(), selAway = useSel()
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
      <p className="muted">Dry flower leaves the farm as raw wet weight (not deleafed) in one METRC package, goes to a drying processor or our trailers, and comes back unbucked. It isn't weighed on the stem: the wet weight stays on paper until bucking.</p>

      <h3 className="csec">Dry harvests to package <span className="muted">{toPack.length || ''}</span></h3>
      {toPack.length ? <div className="cwrap"><table className="ctable">
        <thead><tr><th>Harvested</th><th>Strain</th><th>Site · field</th><th className="num">Raw lbs</th><th /></tr></thead>
        <tbody>{toPack.map(h => <tr key={h.id}><td className="nowrap">{fmtD(h.harvested_on ?? h.planned_on)}</td><td>{h.strain}</td><td>{h.site} {h.field ?? ''}</td>
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

      <h3 className="csec row between"><span>At processors <span className="muted">{away.length ? `${away.length} · ${n0(sum(away.map(w)))} lbs wet` : ''}</span></span>{away.length > 0 && c.canEdit && <SelButton sel={selAway} />}</h3>
      {!away.length && <p className="muted">Nothing out at a processor.</p>}
      {[...byProc.entries()].map(([pid, ps]) => <div key={pid}>
        <h4 className="subh row between"><span>{c.procName(pid) || 'Unknown processor'} <span className="muted">{ps.length} · {n0(sum(ps.map(w)))} lbs</span></span>
          <button className="ghost small" onClick={() => c.manifest(ps.map(p => p.id))}>Manifest sheet</button></h4>
        <PkgTable c={c} rows={ps} sel={selAway} extra={p => p.sent_on ? <span className={days(p.sent_on, today()) > 21 ? 'warn-t' : 'muted'}>{days(p.sent_on, today())} days out</span> : null} />
      </div>)}
      <SelBar sel={selAway} noun="package" actions={[{ label: 'Back unbucked', run: async ids => c.back(ids) }, { label: 'Manifest sheet', run: ids => c.manifest(ids) }]} />

      <h3 className="csec">Back, needs a spot <span className="muted">{backHere.length || ''}</span></h3>
      {backHere.length ? <PkgTable c={c} rows={backHere} extra={p => c.canEdit ? <span className="row"><button className="ghost small" onClick={e => { e.stopPropagation(); c.putAway(p) }}>Put in a trailer</button>
        <button className="primary small" onClick={e => { e.stopPropagation(); c.start('buck', [p.id]) }}>Buck</button></span> : null} />
        : <p className="muted">Everything that came back is in a trailer. Unbucked packages are in Inventory.</p>}

      {wet && <WetSheet c={c} h={wet} onClose={() => setWet(null)} />}
    </div>
  )
}

function PkgTable({ c, rows, sel, extra, showProduct }: { c: Ctx; rows: Pallet[]; sel?: ReturnType<typeof useSel>; extra?: (p: Pallet) => ReactNode; showProduct?: boolean }) {
  return <div className="cwrap"><table className="ctable">
    <thead><tr>{sel && <SelAll sel={sel} ids={rows.map(p => p.id)} />}<th>Package</th>{showProduct && <th>Product</th>}<th>Strain</th><th className="hide-s">Crop</th><th className="num">Lbs</th><th className="hide-s">Tag</th><th>Where</th>{extra && <th />}</tr></thead>
    <tbody>{rows.map(p => { const r = c.runOf(p.id), h = c.heldFor(p.id)
      return <tr key={p.id} className="tap" onClick={() => c.openPkg(p)}>
        {sel && <SelBox sel={sel} id={p.id} />}<td><b>{p.code}</b></td>{showProduct && <td><Prod p={p.product} /></td>}<td>{p.strain}</td><td className="hide-s">{p.crop_year ?? ''}</td>
        <td className="num">{n0(w(p))}</td><td className="hide-s"><Tag p={p} /></td>
        <td className="small">{c.where(p)}{r ? <span className="pill warnp">in {r.code}</span> : null}{h ? <span className="pill okp">for {h}</span> : null}</td>{extra && <td className="num">{extra(p)}</td>}</tr> })}</tbody>
  </table></div>
}

function TagIn({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <span className="row tagin"><input className="mono" value={value} placeholder={placeholder ?? 'METRC tag (blank = pending)'} onChange={e => onChange(e.target.value.toUpperCase())} /><ScanButton compact onScan={t => onChange(t.toUpperCase())} /></span>
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
    try { const codes = await c.api.makeWet(h.id, rows.filter(r => r.lbs).map(r => ({ lbs: r.lbs!, tag: r.tag })), proc, sent); c.flash(`${codes.join(', ')} made${proc != null && !inHouse ? '. Manifest sheet downloading.' : ''}`)
      if (proc != null && !inHouse) await c.manifest(await c.api.idsOf(codes))
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
    <p className="muted small-note">{proc == null || inHouse ? 'It lands as "Needs a spot" at ' + h.site + '. Mark it "Dried in house" when it comes off the drying racks.' : 'It shows under At processors until it comes back unbucked. The manifest sheet (PDF) downloads so you can enter the transfer in METRC.'}</p>
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
    <p>Print the manifest sheet: our license, theirs, the transporter, and every package with its tag, batch and wet weight. Then enter the transfer in METRC.</p>
    {!pr?.license && <p className="warn-t small-note">{pr?.name} has no license on file yet. Add it in Processing › Settings › Processors.</p>}
    <div className="row between csave"><span /><div className="row"><button className="ghost" onClick={onClose}>Done</button><button className="primary" onClick={() => c.manifest(ids)}>Manifest sheet (PDF)</button></div></div>
  </Sheet>
  return <Sheet title={`Send ${ids.length} to a processor`} onClose={onClose}>
    <F label="Processor"><Pick value={proc} options={procs.map(p => ({ v: p.id, l: p.name }))} onChange={setProc} /></F>
    <F label="Sent"><DateIn value={on} onChange={setOn} /></F>
    <p className="muted small-note">The packages leave the map until they come back. Next you can print the manifest sheet for the METRC transfer.</p>
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Sent" disabled={proc == null} />
  </Sheet>
}

function BackSheet({ c, ids, onClose }: { c: Ctx; ids: number[]; onClose: () => void }) {
  const ps = c.d.pallets.filter(p => ids.includes(p.id))
  const [site, setSite] = useState<string | null>('GVR')
  const [tags, setTags] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { await c.api.receive(ids, site ?? 'GVR', Object.fromEntries(Object.entries(tags).filter(([, v]) => v.trim()))); c.flash(`${ids.length} back, unbucked. Put them in a trailer.`); await c.reload(); onClose() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title={`${ids.length} back unbucked`} onClose={onClose}>
    <F label="Arrived at"><Pick value={site} options={[{ v: 'GVR', l: 'GVR (processor license)' }, { v: 'OHR', l: 'OHR' }]} onChange={setSite} /></F>
    <p className="muted small-note">Not weighed: each keeps its wet weight until it's bucked. If the processor sent it back on a new METRC tag, enter it.</p>
    {ps.map(p => <div key={p.id} className="row noline"><b className="grow">{p.code} <span className="muted">{p.strain} · {n0(w(p))} lbs · …{(p.package_tag ?? '').slice(-6)}</span></b>
      <TagIn value={tags[p.id] ?? ''} placeholder="New tag (if it changed)" onChange={v => setTags(t => ({ ...t, [p.id]: v }))} /></div>)}
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Back" />
  </Sheet>
}

/** put a package in a reefer trailer: first open spot, or pick one; pumpkin boxes stack 2 high */
function PutAwaySheet({ c, p, sb, onClose }: { c: Ctx; p: Pallet; sb: ReturnType<Backend['client']>; onClose: () => void }) {
  const site = p.received_site ?? (p.slot_id != null ? c.d.freezers.get(c.d.slots.get(p.slot_id)?.freezer_id ?? -1)?.site : null) ?? 'GVR'
  const trailers = [...c.d.freezers.values()].filter(f => f.kind === 'trailer' && f.site === site).sort((a, b) => a.number - b.number)
  const [tr, setTr] = useState<number | null>(trailers[0]?.id ?? null)
  const [occ, setOcc] = useState<Map<number, { code: string; strain: string | null }[]> | null>(null)
  const [busy, setBusy] = useState(false)
  const spots = [...c.d.slots.values()].filter(s => s.freezer_id === tr).sort((a, b) => a.code.localeCompare(b.code))
  useEffect(() => {
    if (!sb || !trailers.length) return
    const ids = [...c.d.slots.values()].filter(s => trailers.some(f => f.id === s.freezer_id)).map(s => s.id)
    sb.from('pallets').select('code,strain,slot_id').in('slot_id', ids).eq('status', 'in_freezer').is('container_id', null).then(({ data }) => {
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
  const first = spots.find(s => !(occ?.get(s.id)?.length))
  return <Sheet title={`Put ${p.code} in a trailer`} sub={`${p.strain} · ${PL(p.product)} · ${n0(w(p))} lbs`} onClose={onClose}>
    {!trailers.length ? <p className="muted">No reefer trailers at {site}.</p> : <>
      <div className="seg wrap">{trailers.map(f => <button key={f.id} className={tr === f.id ? 'on' : ''} onClick={() => setTr(f.id)}>Reefer {f.number - 100} <span className="muted">{occ ? `${free(f.id)} open` : ''}</span></button>)}</div>
      {first && <div className="row csave"><button className="primary" disabled={busy} onClick={() => put(first.id, false)}>First open spot ({first.code.slice(2)})</button></div>}
      <p className="muted small-note">Or tap a spot. A full spot stacks it on top (pumpkin boxes go 2 high). Back of the trailer at the top, door at the bottom.</p>
      <div className="putgrid">{spots.map(s => { const o = occ?.get(s.id) ?? []
        return <button key={s.id} className={`putspot ${o.length ? 'full' : ''}`} disabled={busy || o.length >= 2} onClick={() => put(s.id, o.length > 0)}>
          <b>{s.code.slice(2)}</b><span>{o.length ? o.map(x => x.code).join(' + ') : 'open'}</span></button> })}</div>
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
        {c.canEdit && <div className="row"><button className="primary" onClick={() => onStart('buck')}>+ Bucking</button><button className="primary" onClick={() => onStart('trim')}>+ Trimming</button></div>}</div>
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
  const need: Product[] = kind === 'buck' ? ['unbucked', 'wet'] : ['bucked']
  const cands = c.d.pallets.filter(p => need.includes(p.product as Product) && live(p) && !c.runOf(p.id) && !c.heldFor(p.id))
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
  return <Sheet wide title={kind === 'buck' ? 'Start bucking' : 'Start trimming'} sub={kind === 'buck' ? 'Wet or unbucked packages go in whole (not weighed on the stem; wet ones count as dried in house)' : 'Bucked packages, all or part of each'} onClose={onClose}>
    {!cands.length ? <p className="muted">No {kind === 'buck' ? 'wet or unbucked' : 'bucked'} packages free to work on.</p> : <>
      <F label="Strain"><Pick value={strain} blank="Pick a strain…" options={strains.map(s => ({ v: s, l: `${s} (${n0(sum(cands.filter(p => p.strain === s).map(w)))} lbs)` }))} onChange={v => { setStrain(v); setPick({}); setRequest(null) }} /></F>
      {strain && <div className="cwrap"><table className="ctable">
        <thead><tr><th /><th>Package</th><th className="num">Lbs</th><th className="hide-s">Where</th>{kind === 'trim' && <th className="num">Use</th>}</tr></thead>
        <tbody>{list.map(p => { const on_ = String(p.id) in pick
          return <tr key={p.id}><td className="selcol"><input type="checkbox" checked={on_} onChange={() => setPick(x => { const n = { ...x }; if (on_) delete n[p.id]; else n[p.id] = null; return n })} /></td>
            <td><b>{p.code}</b> <Tag p={p} /></td><td className="num">{n0(w(p))}</td><td className="small hide-s">{c.where(p)}</td>
            {kind === 'trim' && <td className="num">{on_ && <span className="qtyin"><NumIn value={pick[p.id]} placeholder={`all ${n0(w(p))}`} onChange={v => setPick(x => ({ ...x, [p.id]: v }))} /></span>}</td>}</tr> })}</tbody>
      </table></div>}
      {kind === 'trim' && reqs.length > 0 && <F label="For trim request" hint="(optional)"><Pick value={request} blank="None (trimming ahead)" options={reqs.map(q => ({ v: q.id, l: `${n0(q.lbs)} lbs ${REQ_PRODUCT[q.product]}${q.due_on ? ` by ${fmtD(q.due_on)}` : ''}${q.customer_id ? ` · ${c.d.customers.find(x => x.id === q.customer_id)?.name ?? ''}` : ''}` }))} onChange={setRequest} /></F>}
      <div className="grid2"><F label="Started"><DateIn value={on} onChange={setOn} /></F><F label="Notes"><TextIn value={notes} onChange={v => setNotes(v ?? '')} /></F></div>
      <p className="muted small-note">{chosen.length} package{chosen.length === 1 ? '' : 's'} · {n0(total)} lbs{kind === 'buck' ? ' wet weight on paper' : ''}. The packages stay where they are until the run is finished.</p>
    </>}
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Start" disabled={!chosen.length} />
  </Sheet>
}

function RunSheet({ c, run, onClose }: { c: Ctx; run: Run; onClose: () => void }) {
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
  const [crew, setCrew] = useState<{ people: number; days: number; lbs: number; other: number; hours: number; pay: number } | null>(null)
  useEffect(() => { c.api.crewOf(run.id).then(setCrew).catch(() => setCrew(null)) }, [run.id])
  const out = sum(rows.map(r => r.lbs ?? 0)), inp = run.input_lbs ?? 0, loss = inp - out - (mold ?? 0)
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
  return <Sheet wide title={`${run.code} · ${KIND[run.kind]}`} sub={`${run.strain ?? ''} ${run.crop_year ?? ''} · started ${fmtD(run.started_on)}${run.finished_on ? ` · done ${fmtD(run.finished_on)}` : ''}${run.status === 'cancelled' ? ' · cancelled' : ''}`} onClose={onClose}>
    {req && <div className="infobox">For trim request: {n0(req.lbs)} lbs {REQ_PRODUCT[req.product]}{req.due_on ? ` by ${fmtD(req.due_on)}` : ''}{req.customer_id ? ` · ${d.customers.find(x => x.id === req.customer_id)?.name}` : ''}</div>}
    <h3 className="csec">In <span className="muted">{n0(inp)} lbs{run.kind === 'buck' ? ' wet, on paper' : ''}</span></h3>
    <div className="dlist">{ins.map(({ i, p }) => <button key={i.id} className="drow linkrow" onClick={() => p && c.openPkg(p)}>
      <span className="grow"><b>{p?.code ?? `#${i.pallet_id}`}</b> <span className="muted">{p ? PL(p.product) : ''} · {p ? c.where(p) : ''}</span></span><b>{n0(i.lbs)} lbs</b>{!i.whole && <span className="muted">part</span>}</button>)}</div>
    {crew && crew.people > 0 && <div className="infobox">Crew logged {crew.people} people over {crew.days} day{crew.days === 1 ? '' : 's'}: {n1(crew.lbs)} lbs {run.kind === 'buck' ? 'bucked' : 'flower'}, {n1(crew.other)} lbs mold / smalls / trim, {n1(crew.hours)} hours, ${n0(crew.pay)} piece pay{run.status === 'done' && run.output_lbs ? ` (${pct(crew.lbs + crew.other, (run.output_lbs ?? 0) + (run.mold_lbs ?? 0))} of what came out)` : ''}.</div>}
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
      {rows.map((r, i) => <div key={i} className="row noline">
        <select value={r.product} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, product: e.target.value as Product } : x))}>{OUTS[run.kind].map(k => <option key={k} value={k}>{PL(k)}{run.kind === 'buck' && k === 'trim' ? ' (buck trim)' : ''}</option>)}</select>
        <NumIn value={r.lbs} placeholder="lbs" onChange={v => setRows(rs => rs.map((x, j) => j === i ? { ...x, lbs: v } : x))} />
        <TagIn value={r.tag} onChange={v => setRows(rs => rs.map((x, j) => j === i ? { ...x, tag: v } : x))} />
        {rows.length > 1 && <button className="ghost small" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button>}
      </div>)}
      <div className="row"><button className="ghost small" onClick={() => setRows(rs => [...rs, { product: rs[rs.length - 1]?.product ?? OUTS[run.kind][0], lbs: null, tag: '' }])}>+ Another package</button>
        <button className="ghost small" onClick={fill}>Fill next tags</button></div>
      <div className="grid2"><F label="Mold / refuse" hint="(lbs, METRC waste)"><NumIn value={mold} onChange={setMold} /></F><F label="Finished"><DateIn value={on} onChange={setOn} /></F></div>
      <F label="Notes"><TextIn value={notes} onChange={v => setNotes(v ?? '')} /></F>
      <div className="ckpis"><div><b>{n0(out)}</b><span>out ({pct(out, inp)})</span></div><div><b>{n0(mold)}</b><span>mold</span></div>
        <div><b className={loss < 0 ? 'bad-t' : ''}>{n1(loss)}</b><span>{run.kind === 'buck' ? 'moisture' : 'difference'} ({pct(loss, inp)})</span></div></div>
      {loss < 0 && <p className="bad-t small-note">More came out than went in. Check the weights.</p>}
      <div className="row between csave">
        {sure ? <span className="row"><button className="ghost danger" disabled={busy} onClick={cancel}>Yes, cancel run</button><button className="ghost small" onClick={() => setSure(false)}>Keep</button></span>
          : <button className="ghost" disabled={busy} onClick={() => setSure(true)}>Cancel run</button>}
        <div className="row"><button className="ghost" onClick={onClose}>Close</button><button className="primary" disabled={busy || !out} onClick={finish}>{busy ? 'Saving…' : 'Finish run'}</button></div>
      </div>
    </>}
  </Sheet>
}

// ---------- Inventory: every dry package, with its next step ----------
function Inventory({ c }: { c: Ctx }) {
  const { d } = c
  const [prod, setProd] = useState<Product | 'all'>('all')
  const [q, setQ] = useState('')
  const sel = useSel()
  const kinds: Product[] = ['wet', 'unbucked', 'bucked', 'standards', 'smalls', 'trim']
  const oh = onHand(d)
  const ql = q.trim().toLowerCase()
  const rows = d.pallets.filter(p => (live(p) || p.status === 'at_processor') && (prod === 'all' || p.product === prod)
    && (!ql || `${p.code} ${p.strain} ${p.package_tag ?? ''}`.toLowerCase().includes(ql)))
    .sort((a, b) => (a.strain ?? '').localeCompare(b.strain ?? '') || kinds.indexOf(a.product!) - kinds.indexOf(b.product!) || a.code.localeCompare(b.code))
  const picked = (ids: number[]) => d.pallets.filter(p => ids.includes(p.id))
  const all = (ids: number[], ok: (p: Pallet) => boolean, what: string) => { if (picked(ids).every(ok)) return true; c.flash(`Pick only ${what}`, true); return false }
  return (
    <div className="list">
      <div className="row between wrap toolbar"><h2>Inventory</h2>{c.canEdit && rows.length > 0 && <SelButton sel={sel} />}</div>
      <div className="row wrap toolbar">
        <div className="seg wrap">{(['all', ...kinds] as const).map(k => <button key={k} className={prod === k ? 'on' : ''} onClick={() => setProd(k)}>
          {k === 'all' ? 'All' : `${PL(k)} ${oh.get(k)?.n ? `(${oh.get(k)!.n})` : ''}`}</button>)}</div>
        <input className="search" type="search" placeholder="Strain, package or tag" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <p className="muted">{rows.length} packages · {n0(sum(rows.map(w)))} lbs{prod === 'unbucked' || prod === 'wet' ? ' (wet weight on paper)' : ''}. Tap a package for its next step, or Select several to buck, trim or send them together.</p>
      {rows.length ? <PkgTable c={c} rows={rows} sel={sel} showProduct={prod === 'all'} extra={p => { const f = forecast(d, p)
        return p.product === 'wet' || p.product === 'unbucked' ? <span className="muted small">~{n0(f.bucked)} bucked</span>
          : p.product === 'bucked' ? <span className="muted small">~{n0(f.std)} std</span> : null }} /> : <p className="muted">Nothing here.</p>}
      <SelBar sel={sel} noun="package" actions={[
        { label: 'Buck', run: async ids => { if (all(ids, p => (p.product === 'wet' || p.product === 'unbucked') && live(p), 'wet or unbucked packages that are here')) c.start('buck', ids) } },
        { label: 'Trim', run: async ids => { if (all(ids, p => p.product === 'bucked' && live(p), 'bucked packages')) c.start('trim', ids) } },
        { label: 'Send to processor', run: async ids => { if (all(ids, p => (p.product === 'wet' || p.product === 'unbucked') && live(p), 'wet or unbucked packages that are here')) c.send(ids) } },
      ]} />
    </div>
  )
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
  const proms = d.promises.filter(x => x.pallet_id === p.id)
  const [mode, setMode] = useState<'none' | 'sell' | 'promise'>('none')
  const go = (f: () => void) => { onClose(); f() }
  const unprom = async (id: number) => { try { await c.api.uncommit(id); c.flash('Promise taken off'); await c.reload() } catch (e) { c.flash(errText(e), true) } }
  return <Sheet title={p.code} sub={<>{p.strain} <Prod p={p.product} /></>} onClose={onClose}>
    {r && <div className="infobox">Being {r.kind === 'buck' ? 'bucked' : 'trimmed'} in <a onClick={() => c.openRun(r)}>{r.code}</a>. Open the run to finish it.</div>}
    {h && <div className="infobox held">Committed to {h}. Distribution ships it from Fulfillment.</div>}
    {can && <div className="actions">
      {free && p.slot_id == null && <button className="ghost" onClick={() => go(() => c.putAway(p))}>Put in a trailer</button>}
      {free && (p.product === 'wet' || p.product === 'unbucked') && <button className="primary" onClick={() => go(() => c.start('buck', [p.id]))}>Buck</button>}
      {free && (p.product === 'wet' || p.product === 'unbucked') && <button className="ghost" onClick={() => go(() => c.send([p.id]))}>Send to processor</button>}
      {free && p.product === 'wet' && <button className="ghost" onClick={() => go(() => c.dried([p.id]))}>Dried here</button>}
      {p.status === 'at_processor' && <button className="primary" onClick={() => go(() => c.back([p.id]))}>Back unbucked</button>}
      {p.status === 'at_processor' && <button className="ghost" onClick={() => c.manifest([p.id])}>Manifest sheet</button>}
      {free && p.product === 'bucked' && <button className="primary" onClick={() => go(() => c.start('trim', [p.id]))}>Trim</button>}
      {free && p.product === 'bucked' && <button className="ghost" onClick={() => setMode('promise')}>Promise forecast to an order</button>}
      {free && p.product === 'bucked' && !proms.length && <button className="ghost" onClick={() => setMode('sell')}>Sell as bucked</button>}
      {free && ['standards', 'smalls', 'trim', 'unbucked'].includes(p.product ?? '') && <button className="ghost" onClick={() => setMode('sell')}>{p.product === 'unbucked' ? 'Sell as unbucked' : 'Commit to an order'}</button>}
    </div>}
    <Forecast c={c} p={p} />
    {proms.length > 0 && <div className="dlist">{proms.map(x => <div key={x.id} className="drow"><span className="grow">Promised: <b>{n0(x.lbs)} lbs {PL(x.product)}</b> to {x.so} · {x.customer}</span>
      {can && <button className="ghost small" onClick={() => unprom(x.id)}>Take off</button>}</div>)}</div>}
    {mode === 'sell' && <CommitForm c={c} p={p} onDone={onClose} />}
    {mode === 'promise' && <PromiseForm c={c} p={p} onDone={onClose} />}
    <dl>
      <dt>Where</dt><dd>{c.where(p)}</dd>
      <dt>Weight</dt><dd>{n0(w(p))} lbs{p.og_weight && p.og_weight !== p.current_weight ? <span className="muted"> (started {n0(p.og_weight)})</span> : null}{p.product === 'wet' || p.product === 'unbucked' ? <span className="muted"> · wet, on paper</span> : null}</dd>
      <dt>METRC tag</dt><dd className="mono">{p.package_tag ?? (p.tag_pending ? 'pending' : 'none')}</dd>
      <dt>Crop year</dt><dd>{p.crop_year ?? ''}</dd>
      <dt>Harvested</dt><dd>{p.harvest_date ?? ''} {p.zone ? <span className="muted">· {p.zone}</span> : null}</dd>
      <dt>Grown at</dt><dd>{p.origin_site ?? ''}</dd>
      {p.processor_id ? <><dt>Dried by</dt><dd>{c.procName(p.processor_id)}</dd></> : null}
      {made && <><dt>Made in</dt><dd><a onClick={() => c.openRun(made)}>{made.code}</a></dd></>}
      {usedIn.length > 0 && <><dt>Used in</dt><dd>{usedIn.map(x => <a key={x.id} onClick={() => c.openRun(x)}>{x.code} </a>)}</dd></>}
    </dl>
  </Sheet>
}

/** a real package (or part of it) onto a confirmed order line of the same product */
function CommitForm({ c, p, onDone }: { c: Ctx; p: Pallet; onDone: () => void }) {
  const lines = c.d.lines.filter(l => l.product === p.product && canon(l.strain) === canon(p.strain) && !l.on_load && l.picked < l.lbs)
  const [line, setLine] = useState<number | null>(lines.length === 1 ? lines[0].id : null)
  const L = lines.find(l => l.id === line)
  const [lbs, setLbs] = useState<number | null>(null)
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const want = L ? Math.min(L.lbs - L.picked, w(p)) : null
  const part = lbs != null && lbs < w(p)
  async function commit() {
    setBusy(true)
    try { await c.api.commit(line!, p.id, part ? lbs : null, part ? tag : null); c.flash(`${part ? n0(lbs) + ' lbs of ' : ''}${p.code} committed to ${L?.so}`); await c.reload(); onDone() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  if (!lines.length) return <p className="muted">No confirmed order is waiting on {p.strain} {PL(p.product).toLowerCase()}. Sales adds the order first (Sales › Orders › New order, product {PL(p.product)}).</p>
  return <>
    <F label="Order line"><Pick value={line} blank="Pick an order…" options={lines.map(l => ({ v: l.id, l: `${l.so} · ${l.customer} · ${n0(l.lbs - l.picked)} of ${n0(l.lbs)} lbs still needed${l.wanted ? ` · wanted ${fmtD(l.wanted)}` : ''}` }))} onChange={v => { setLine(v); setLbs(null) }} /></F>
    {L && <>
      <F label="Lbs" hint={`(blank = the whole package, ${n0(w(p))} lbs)`}><NumIn value={lbs} placeholder={want != null && want < w(p) ? `${n0(want)} needed` : 'whole package'} onChange={setLbs} /></F>
      {part && <F label="New METRC tag for the part" hint="(blank = pending)"><TagIn value={tag} onChange={setTag} /></F>}
      <SaveBar busy={busy} onCancel={onDone} onSave={commit} saveLabel={part ? `Split off ${n0(lbs)} lbs and commit` : 'Commit whole package'} />
    </>}
  </>
}

/** forecast standards / smalls / trim from a bucked package onto an order line; filled automatically when it's trimmed */
function PromiseForm({ c, p, onDone }: { c: Ctx; p: Pallet; onDone: () => void }) {
  const f = forecast(c.d, p)
  const left = (k: 'standards' | 'smalls' | 'trim') => Math.max(0, (k === 'standards' ? f.std : k === 'smalls' ? f.sml : f.trm) - promisedOn(c.d, p.id, k))
  const lines = c.d.lines.filter(l => ['standards', 'smalls', 'trim'].includes(l.product) && canon(l.strain) === canon(p.strain) && !l.on_load && l.picked + l.promised < l.lbs)
  const [line, setLine] = useState<number | null>(lines.length === 1 ? lines[0].id : null)
  const L = lines.find(l => l.id === line)
  const max = L ? Math.floor(Math.min(L.lbs - L.picked - L.promised, left(L.product as 'standards'))) : 0
  const [lbs, setLbs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { await c.api.commitForecast(line!, p.id, lbs ?? max); c.flash(`${n0(lbs ?? max)} lbs ${PL(L!.product)} promised to ${L!.so}`); await c.reload(); onDone() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  if (!lines.length) return <p className="muted">No confirmed order is waiting on {p.strain} standards, smalls or trim. Sales adds the order first.</p>
  return <>
    <p className="muted small-note">Still free to promise from {p.code}: ~{n0(left('standards'))} Standards, ~{n0(left('smalls'))} Smalls, ~{n0(left('trim'))} Trim. When it's trimmed, the real packages go on the order by themselves.</p>
    <F label="Order line"><Pick value={line} blank="Pick an order…" options={lines.map(l => ({ v: l.id, l: `${l.so} · ${l.customer} · ${PL(l.product)} · ${n0(l.lbs - l.picked - l.promised)} of ${n0(l.lbs)} lbs still needed` }))} onChange={v => { setLine(v); setLbs(null) }} /></F>
    {L && <>
      <F label="Lbs" hint={`(up to ${n0(max)})`}><NumIn value={lbs} placeholder={n0(max)} onChange={setLbs} /></F>
      <SaveBar busy={busy} onCancel={onDone} onSave={save} saveLabel="Promise" disabled={!max} />
    </>}
  </>
}

// ---------- Available to sell: on hand by stage, forecast, promised, free ----------
function Available({ c }: { c: Ctx }) {
  const { d } = c
  const rows = new Map<string, { strain: string; wet: number; wetBk: number; bk: number; fc: { std: number; sml: number; trm: number }; laterFc: { std: number; sml: number; trm: number }; have: Record<string, number>; held: Record<string, number>; prom: Record<string, number> }>()
  const row = (s: string | null) => { const k = canon(s); let r = rows.get(k); if (!r) { r = { strain: s ?? '?', wet: 0, wetBk: 0, bk: 0, fc: { std: 0, sml: 0, trm: 0 }, laterFc: { std: 0, sml: 0, trm: 0 }, have: {}, held: {}, prom: {} }; rows.set(k, r) } return r }
  for (const p of d.pallets) {
    if (!(live(p) || p.status === 'at_processor')) continue
    const r = row(p.strain), f = forecast(d, p)
    if (p.product === 'wet' || p.product === 'unbucked') { r.wet += w(p); r.wetBk += f.bucked; r.laterFc.std += f.std; r.laterFc.sml += f.sml; r.laterFc.trm += f.trm }
    else if (p.product === 'bucked') { r.bk += w(p); if (!c.heldFor(p.id)) { r.fc.std += f.std; r.fc.sml += f.sml; r.fc.trm += f.trm } }
    if (p.product) { r.have[p.product] = (r.have[p.product] ?? 0) + w(p); if (c.heldFor(p.id)) r.held[p.product] = (r.held[p.product] ?? 0) + w(p) }
  }
  for (const x of d.promises) { const p = d.pallets.find(y => y.id === x.pallet_id); if (p) { const r = row(p.strain); r.prom[x.product] = (r.prom[x.product] ?? 0) + x.lbs } }
  const list = [...rows.values()].sort((a, b) => a.strain.localeCompare(b.strain))
  const free = (r: (typeof list)[number], k: 'standards' | 'smalls' | 'trim') => (r.have[k] ?? 0) - (r.held[k] ?? 0) + (k === 'standards' ? r.fc.std : k === 'smalls' ? r.fc.sml : r.fc.trm) - (r.prom[k] ?? 0)
  const waiting = d.lines.filter(l => l.picked + l.promised < l.lbs - 0.01)
  return (
    <div className="list wide">
      <h2>Available to sell</h2>
      <p className="muted">Per strain: trimmed on hand plus the forecast from bucked packages, minus what's committed or promised. Sales can promise forecast standards, smalls and trim from bucked packages (tap one in Inventory). Wet and unbucked show what's coming later; they can't be promised yet.</p>
      {!list.length ? <p className="muted">No dry product on hand.</p> : <div className="cwrap"><table className="ctable">
        <thead>
          <tr><th rowSpan={2}>Strain</th><th className="num" rowSpan={2}>Bucked</th><th className="num" colSpan={3}>Free to sell now (lbs)</th><th className="num" colSpan={2}>Coming later</th></tr>
          <tr><th className="num">Standards</th><th className="num">Smalls</th><th className="num">Trim</th><th className="num">Wet / unbucked</th><th className="num">~Standards</th></tr>
        </thead>
        <tbody>{list.map(r => <tr key={r.strain}><td>{r.strain}</td>
          <td className="num">{n0(r.bk - (r.held.bucked ?? 0)) || ''}</td>
          {(['standards', 'smalls', 'trim'] as const).map(k => { const v = free(r, k), fc = k === 'standards' ? r.fc.std : k === 'smalls' ? r.fc.sml : r.fc.trm
            return <td key={k} className="num"><b className={v < 0 ? 'bad-t' : ''}>{n0(v) || ''}</b>{fc > 0 && <div className="muted small">{n0(r.have[k] ?? 0)} on hand + ~{n0(fc)}</div>}{(r.prom[k] ?? 0) > 0 && <div className="muted small">{n0(r.prom[k])} promised</div>}</td> })}
          <td className="num">{r.wet ? <>{n0(r.wet)}<div className="muted small">~{n0(r.wetBk)} bucked</div></> : ''}</td>
          <td className="num muted">{r.laterFc.std ? `~${n0(r.laterFc.std)}` : ''}</td></tr>)}</tbody>
      </table></div>}
      <h3 className="csec">Orders waiting on dry product <span className="muted">{waiting.length || ''}</span></h3>
      {waiting.length ? <div className="cwrap"><table className="ctable">
        <thead><tr><th>Order</th><th>Customer</th><th>Strain</th><th>Product</th><th className="num">Lbs</th><th className="num">Committed</th><th className="num">Promised</th><th>Wanted</th></tr></thead>
        <tbody>{waiting.map(l => <tr key={l.id}><td>{l.so}</td><td>{l.customer}</td><td>{l.strain}</td><td>{PL(l.product)}</td><td className="num">{n0(l.lbs)}</td>
          <td className="num">{n0(l.picked)}</td><td className="num">{n0(l.promised)}</td><td className="nowrap">{fmtD(l.wanted)}</td></tr>)}</tbody>
      </table></div> : <p className="muted">Every confirmed dry order line is covered.</p>}
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
    all.push({ strain: h.strain, crop_year: h.crop_year, wet_lbs: 0, bucked_in: h.bucked + h.buck_trim + h.buck_mold, bucked: h.bucked, buck_trim: h.buck_trim, buck_mold: h.buck_mold, moisture: 0,
      trim_in: ti, standards: h.standards, smalls: h.smalls, trim_lbs: h.trim_lbs, trim_mold: h.trim_mold, trim_loss: 0, buck_runs: 0, trim_runs: 0, src: h.source })
  }
  all.sort((a, b) => a.strain.localeCompare(b.strain))
  const cost = (strain: string, task: 'buck' | 'trim') => { const x = labor.filter(l => canon(l.strain) === canon(strain) && l.task === task); const lbs = sum(x.map(l => l.lbs)), pay = sum(x.map(l => l.pay))
    return lbs ? { per: pay / lbs, pay } : null }
  const $ = (x: { per: number; pay: number } | null) => x ? <>${x.per.toFixed(2)}<div className="muted small">${n0(x.pay)}</div></> : ''
  const row = (y: Yield & { src?: string }) => { const wetKnown = y.wet_lbs > 0
    return <tr key={y.strain}>
      <td>{y.strain}{y.src && <div className="muted small">{y.src}</div>}</td><td className="num">{wetKnown ? n0(y.wet_lbs) : ''}</td>
      <td className="num">{n0(y.bucked)} <span className="muted">{wetKnown ? pct(y.bucked, y.bucked_in) : ''}</span></td><td className="num">{n0(y.buck_trim)}</td>
      <td className="num hide-s">{n0(y.buck_mold)}</td><td className="num hide-s">{wetKnown ? pct(y.moisture, y.bucked_in) : ''}</td>
      <td className="num">{n0(y.standards)} <span className="muted">{pct(y.standards, y.trim_in)}</span></td><td className="num">{n0(y.smalls)} <span className="muted">{pct(y.smalls, y.trim_in)}</span></td>
      <td className="num">{n0(y.trim_lbs)} <span className="muted">{pct(y.trim_lbs, y.trim_in)}</span></td><td className="num hide-s">{n0(y.trim_mold)} <span className="muted">{pct(y.trim_mold, y.trim_in)}</span></td>
      <td className="num"><b>{wetKnown ? pct(y.bucked + y.buck_trim, y.wet_lbs) : ''}</b></td>
      <td className="num">{$(cost(y.strain, 'buck'))}</td><td className="num">{$(cost(y.strain, 'trim'))}</td></tr> }
  return (
    <div className="list wide">
      <div className="row between wrap toolbar"><h2>Yields</h2>
        <div className="seg">{(years.length ? years : [new Date().getFullYear()]).map(y => <button key={y} className={yr === y ? 'on' : ''} onClick={() => setYr(y)}>{y}</button>)}</div></div>
      <p className="muted">Per strain and crop year, from finished runs (and the FL25 workbook). Bucking % are of the wet weight in; trimming % are of the bucked lbs in. Return from raw = bucked flower + buck trim as a share of wet. Labor $/lb = piece pay ÷ flower lbs from the crew logs. These numbers drive the forecasts.</p>
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
