import '../cult/cult.css'
import './proc.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Backend } from '../api'
import type { Customer, Pallet, Product, Strain } from '../types'
import { PRODUCT_LABEL } from '../types'
import { ProcApi } from './api'
import type { DryHarvest, OLine, OutRow, PData, Processor, Req, Run, Yield } from './api'
import type { PTab } from './tabs'
import { Card, Cards, DashHead, Empty, Tile, Tiles } from '../dash'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn, errText, useSel, SelAll, SelBox, SelBar, SelButton } from '../cult/ui'
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
  const [startKind, setStartKind] = useState<{ kind: Run['kind']; req?: Req } | null>(null)
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
  }
  const strainNames = strains.filter(s => s.active).map(s => s.name)
  return (
    <div className="proc">
      {tab === 'dashboard' && <Dashboard c={c} go={go} />}
      {tab === 'incoming' && <Drying c={c} />}
      {tab === 'runs' && <Runs c={c} onStart={k => setStartKind({ kind: k })} />}
      {tab === 'crew' && sb && <CrewTab sb={sb} runs={d.runs} flash={flash} canEdit={canEdit} strainNames={strainNames} />}
      {tab === 'requests' && <Requests c={c} strainNames={strainNames} onTrim={q => setStartKind({ kind: 'trim', req: q })} />}
      {tab === 'inventory' && <Inventory c={c} />}
      {tab === 'yields' && <Yields c={c} />}
      {tab === 'review' && <Review c={c} go={go} />}
      {tab === 'settings' && (isAdmin ? <SettingsTab c={c} sb={sb} /> : <div className="list"><h2>Settings</h2><p className="muted">Only Processing Admins can change Processing settings.</p></div>)}
      {startKind && <StartRun c={c} kind={startKind.kind} req={startKind.req} onClose={() => setStartKind(null)} onDone={r => { setStartKind(null); setRun(r) }} />}
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
/** what a request has had made for it so far */
function made(d: PData, q: Req) {
  const runs = d.runs.filter(r => r.request_id === q.id)
  const done = sum(d.pallets.filter(p => p.run_id != null && runs.some(r => r.id === p.run_id && r.status === 'done') && (q.product === 'any' || p.product === q.product)).map(p => p.og_weight ?? 0))
  const going = runs.filter(r => r.status === 'open')
  return { done, going }
}
/** dry harvests that still need their wet package (last 3 weeks; older ones were handled before the app) */
const toPackage = (d: PData, all = false) => d.harvests.filter(h => (h.status === 'done' || h.harvested_on) && !d.pallets.some(p => p.from_harvest === h.id) && (all || (h.harvested_on ?? h.planned_on ?? '') >= addDays(today(), -21)))
const bucked = (d: PData, strain: string) => d.pallets.filter(p => p.product === 'bucked' && live(p) && canon(p.strain) === canon(strain))

// ---------- Dashboard ----------
function Dashboard({ c, go }: { c: Ctx; go: (t: PTab) => void }) {
  const { d } = c
  const oh = onHand(d), g = (k: Product) => oh.get(k) ?? { n: 0, lbs: 0 }
  const away = d.pallets.filter(p => p.status === 'at_processor')
  const openRuns = d.runs.filter(r => r.status === 'open')
  const openReq = d.requests.filter(q => q.status === 'open')
  const soon = openReq.filter(q => q.due_on && q.due_on <= addDays(today(), 7))
  const late = openReq.filter(q => q.due_on && q.due_on < today())
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
        <Tile label="Trim requests" value={openReq.length} sub={late.length ? `${late.length} overdue` : soon.length ? `${soon.length} due this week` : openReq.length ? 'none due this week' : 'none open'}
          tone={late.length ? 'bad' : soon.length ? 'warn' : 'ok'} onClick={() => go('requests')} />
        <Tile label="Open runs" value={openRuns.length} sub={openRuns.length ? openRuns.map(r => r.code).slice(0, 3).join(', ') : 'nothing being worked'} onClick={() => go('runs')} />
        <Tile label="Needs a spot" value={spot.length} sub={spot.length ? `${n0(sum(spot.map(w)))} lbs to put in a trailer` : 'all put away'} tone={spot.length ? 'warn' : 'ok'} onClick={() => go('review')} />
        {(pend.length > 0 || toPack.length > 0) && <Tile label="To do" value={pend.length + toPack.length} sub={[toPack.length && `${toPack.length} dry harvests to package`, pend.length && `${pend.length} tags pending`].filter(Boolean).join(' · ')} tone="warn" onClick={() => go('review')} />}
      </Tiles>
      <Cards>
        <Card title="Trim requests due" badge={soon.length} action="Requests" onAction={() => go('requests')}>
          {openReq.length ? <div className="dlist">{openReq.slice(0, 8).map(q => { const m = made(d, q)
            return <div key={q.id} className="drow"><span className="grow"><b>{q.strain}</b> {REQ_PRODUCT[q.product]} <span className="muted">{q.customer_id ? d.customers.find(x => x.id === q.customer_id)?.name : 'stock'}</span></span>
              <span className={q.due_on && q.due_on < today() ? 'bad-t' : 'muted'}>{q.due_on ? fmtD(q.due_on) : 'no date'}</span><b>{n0(m.done)}/{n0(q.lbs)}</b></div> })}</div>
            : <Empty>No open trim requests.</Empty>}
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
  const [sendIds, setSendIds] = useState<number[] | null>(null)
  const [backIds, setBackIds] = useState<number[] | null>(null)
  const selWet = useSel(), selAway = useSel()
  const [older, setOlder] = useState(false)
  const toPack = toPackage(d, older), hidden = toPackage(d, true).length - toPackage(d).length
  const wetHere = d.pallets.filter(p => p.product === 'wet' && live(p))
  const away = d.pallets.filter(p => p.status === 'at_processor').sort((a, b) => (a.sent_on ?? '').localeCompare(b.sent_on ?? ''))
  const byProc = new Map<number, Pallet[]>()
  for (const p of away) { const k = p.processor_id ?? 0; byProc.set(k, [...(byProc.get(k) ?? []), p]) }
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); c.flash(ok); await c.reload() } catch (e) { c.flash(errText(e), true) } }
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
        { label: 'Send to a processor', run: async ids => setSendIds(ids) },
        { label: 'Dried in house', run: ids => run(() => c.api.dried(ids), `${ids.length} now unbucked`) },
      ]} />

      <h3 className="csec row between"><span>At processors <span className="muted">{away.length ? `${away.length} · ${n0(sum(away.map(w)))} lbs wet` : ''}</span></span>{away.length > 0 && c.canEdit && <SelButton sel={selAway} />}</h3>
      {!away.length && <p className="muted">Nothing out at a processor.</p>}
      {[...byProc.entries()].map(([pid, ps]) => <div key={pid}>
        <h4 className="subh">{c.procName(pid) || 'Unknown processor'} <span className="muted">{ps.length} · {n0(sum(ps.map(w)))} lbs</span></h4>
        <PkgTable c={c} rows={ps} sel={selAway} extra={p => p.sent_on ? <span className={days(p.sent_on, today()) > 21 ? 'warn-t' : 'muted'}>{days(p.sent_on, today())} days out</span> : null} />
      </div>)}
      <SelBar sel={selAway} noun="package" actions={[{ label: 'Back unbucked', run: async ids => setBackIds(ids) }]} />

      {wet && <WetSheet c={c} h={wet} onClose={() => setWet(null)} />}
      {sendIds && <SendSheet c={c} ids={sendIds} onClose={() => setSendIds(null)} />}
      {backIds && <BackSheet c={c} ids={backIds} onClose={() => setBackIds(null)} />}
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
    try { const codes = await c.api.makeWet(h.id, rows.filter(r => r.lbs).map(r => ({ lbs: r.lbs!, tag: r.tag })), proc, sent); c.flash(`${codes.join(', ')} made`); await c.reload(); onClose() }
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
    <p className="muted small-note">{proc == null || inHouse ? 'It lands as "Needs a spot" at ' + h.site + '. Mark it "Dried in house" when it comes off the drying racks.' : 'It shows under At processors until it comes back unbucked.'}</p>
    <SaveBar busy={busy} onCancel={onClose} onSave={save} saveLabel="Make package" disabled={!tot} />
  </Sheet>
}

function SendSheet({ c, ids, onClose }: { c: Ctx; ids: number[]; onClose: () => void }) {
  const procs = c.d.processors.filter(p => p.active && !p.in_house)
  const [proc, setProc] = useState<number | null>(procs[0]?.id ?? null)
  const [on, setOn] = useState<string | null>(today())
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { await c.api.send(ids, proc!, on); c.flash(`${ids.length} sent to ${c.procName(proc)}`); await c.reload(); onClose() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title={`Send ${ids.length} to a processor`} onClose={onClose}>
    <F label="Processor"><Pick value={proc} options={procs.map(p => ({ v: p.id, l: p.name }))} onChange={setProc} /></F>
    <F label="Sent"><DateIn value={on} onChange={setOn} /></F>
    <p className="muted small-note">Make the METRC transfer to them as usual. The packages leave the map until they come back.</p>
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

function StartRun({ c, kind, req, onClose, onDone }: { c: Ctx; kind: Run['kind']; req?: Req; onClose: () => void; onDone: (r: Run) => void }) {
  const need: Product = kind === 'buck' ? 'unbucked' : 'bucked'
  const cands = c.d.pallets.filter(p => p.product === need && live(p) && !c.runOf(p.id) && !c.heldFor(p.id))
  const strains = [...new Set(cands.map(p => p.strain ?? ''))].sort()
  const [strain, setStrain] = useState<string | null>(req ? (strains.find(s => canon(s) === canon(req.strain)) ?? req.strain) : strains.length === 1 ? strains[0] : null)
  const [pick, setPick] = useState<Record<number, number | null>>({})
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
  return <Sheet wide title={kind === 'buck' ? 'Start bucking' : 'Start trimming'} sub={kind === 'buck' ? 'Unbucked packages go in whole (they aren\'t weighed on the stem)' : 'Bucked packages, all or part of each'} onClose={onClose}>
    {!cands.length ? <p className="muted">No {PL(need).toLowerCase()} packages free to work on.</p> : <>
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

// ---------- Requests: trim to order or ahead; commit to orders ----------
function Requests({ c, strainNames, onTrim }: { c: Ctx; strainNames: string[]; onTrim: (q: Req) => void }) {
  const { d } = c
  const [ed, setEd] = useState<Partial<Req> | null>(null)
  const [f, setF] = useState<'open' | 'done' | 'all'>('open')
  const rows = d.requests.filter(q => f === 'all' ? true : q.status === f)
  const t = today(), wk = addDays(t, 7)
  const groups: [string, Req[]][] = f === 'open'
    ? [['Overdue', rows.filter(q => q.due_on && q.due_on < t)], ['Due this week', rows.filter(q => q.due_on && q.due_on >= t && q.due_on <= wk)],
       ['Later', rows.filter(q => q.due_on && q.due_on > wk)], ['No date', rows.filter(q => !q.due_on)]]
    : [['', rows]]
  const linesWaiting = d.lines.filter(l => l.picked < l.lbs && !d.requests.some(q => q.order_line_id === l.id && q.status === 'open'))
  const reqFor = (l: OLine) => d.requests.find(q => q.order_line_id === l.id && q.status === 'done')
  const status = async (q: Req, s: Req['status']) => { try { await c.api.requestStatus(q.id, s); c.flash(`Request ${s === 'open' ? 'reopened' : 'marked ' + s}`); await c.reload() } catch (e) { c.flash(errText(e), true) } }
  return (
    <div className="list">
      <div className="row between wrap toolbar"><h2>Trim requests</h2>{c.canEdit && <button className="primary" onClick={() => setEd({ product: 'standards' })}>+ Request</button>}</div>
      <p className="muted">What needs trimming and by when, for a customer or for stock. Trimming runs can fill a request or be done ahead; finished packages get committed to orders from Inventory.</p>
      <div className="seg">{([['open', `Open (${d.requests.filter(q => q.status === 'open').length})`], ['done', 'Done'], ['all', 'All']] as const).map(([k, l]) =>
        <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
      {!rows.length && <p className="muted">No requests here.</p>}
      {groups.filter(([, qs]) => qs.length).map(([g, qs]) => <div key={g}>
        {g && <h3 className={`csec ${g === 'Overdue' ? 'bad-t' : ''}`}>{g} <span className="muted">{qs.length}</span></h3>}
        <div className="cwrap"><table className="ctable">
          <thead><tr><th>Due</th><th>Strain</th><th>Product</th><th>For</th><th className="num">Wanted</th><th className="num">Made</th><th className="num hide-s">Bucked on hand</th><th /></tr></thead>
          <tbody>{qs.map(q => { const m = made(d, q), bk = sum(bucked(d, q.strain).map(w))
            return <tr key={q.id} className={q.status !== 'open' ? 'done' : ''}>
              <td className="nowrap">{q.due_on ? fmtD(q.due_on) : <span className="muted">none</span>}</td><td>{q.strain} <span className="muted">{q.crop_year ?? ''}</span></td><td>{REQ_PRODUCT[q.product]}</td>
              <td className="small">{q.customer_id ? d.customers.find(x => x.id === q.customer_id)?.name : 'Stock'}{q.order_line_id ? <span className="muted"> · {d.lines.find(l => l.id === q.order_line_id)?.so ?? 'order'}</span> : null}{q.note ? <div className="muted">{q.note}</div> : null}</td>
              <td className="num">{n0(q.lbs)}</td><td className="num"><b className={m.done >= q.lbs ? 'ok-t' : ''}>{n0(m.done)}</b>{m.going.length ? <div className="muted small">{m.going.map(r => r.code).join(', ')} working</div> : null}</td>
              <td className="num hide-s">{n0(bk) || <span className="warn-t">none</span>}</td>
              <td className="num nowrap">{c.canEdit && q.status === 'open' && <><button className="ghost small" onClick={() => onTrim(q)}>Trim</button><button className="ghost small" onClick={() => setEd(q)}>Edit</button><button className="ghost small" onClick={() => status(q, 'done')}>Done</button></>}
                {c.canEdit && q.status !== 'open' && <button className="ghost small" onClick={() => status(q, 'open')}>Reopen</button>}</td></tr> })}</tbody>
        </table></div>
      </div>)}
      <h3 className="csec">Order lines waiting for dry product <span className="muted">{linesWaiting.length || ''}</span></h3>
      {linesWaiting.length ? <div className="cwrap"><table className="ctable">
        <thead><tr><th>Order</th><th>Customer</th><th>Strain</th><th>Product</th><th className="num">Lbs</th><th className="num">Committed</th><th>Wanted</th><th /></tr></thead>
        <tbody>{linesWaiting.map(l => <tr key={l.id}><td>{l.so}</td><td>{l.customer}</td><td>{l.strain}</td><td>{PL(l.product)}</td><td className="num">{n0(l.lbs)}</td><td className="num">{n0(l.picked)}</td>
          <td className="nowrap">{fmtD(l.wanted)}</td>
          <td className="num">{reqFor(l) ? <span className="muted small">trimmed: commit it from Inventory</span> : c.canEdit && ['standards', 'smalls', 'trim'].includes(l.product) && <button className="ghost small" onClick={() => setEd({ strain: l.strain, crop_year: l.crop_year, product: l.product as Req['product'], lbs: l.lbs - l.picked, due_on: l.wanted, customer_id: l.customer_id, order_line_id: l.id })}>Make request</button>}</td></tr>)}</tbody>
      </table></div> : <p className="muted">No confirmed orders waiting on standards, smalls or trim.</p>}
      {ed && <RequestSheet c={c} q={ed} strainNames={strainNames} onClose={() => setEd(null)} />}
    </div>
  )
}

function RequestSheet({ c, q: q0, strainNames, onClose }: { c: Ctx; q: Partial<Req>; strainNames: string[]; onClose: () => void }) {
  const [q, setQ] = useState<Partial<Req>>(q0)
  const [busy, setBusy] = useState(false)
  const lines = c.d.lines.filter(l => !q.strain || canon(l.strain) === canon(q.strain))
  async function save() {
    setBusy(true)
    try { await c.api.saveRequest(q); c.flash(q.id ? 'Request saved' : 'Request added'); await c.reload(); onClose() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function cancel() {
    setBusy(true)
    try { await c.api.requestStatus(q.id!, 'cancelled'); c.flash('Request cancelled'); await c.reload(); onClose() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title={q.id ? 'Trim request' : 'New trim request'} onClose={onClose}>
    <StrainList id="proc-strains" names={strainNames} />
    <div className="grid2"><F label="Strain"><TextIn list="proc-strains" value={q.strain} onChange={v => setQ({ ...q, strain: v ?? '' })} /></F>
      <F label="Crop year" hint="(optional)"><NumIn value={q.crop_year} onChange={v => setQ({ ...q, crop_year: v })} /></F></div>
    <div className="grid2"><F label="Product"><Pick value={q.product ?? 'standards'} options={(Object.keys(REQ_PRODUCT) as Req['product'][]).map(k => ({ v: k, l: REQ_PRODUCT[k] }))} onChange={v => setQ({ ...q, product: v ?? 'standards' })} /></F>
      <F label="Lbs"><NumIn value={q.lbs} onChange={v => setQ({ ...q, lbs: v ?? undefined })} /></F></div>
    <F label="Due"><DateIn value={q.due_on} onChange={v => setQ({ ...q, due_on: v })} /></F>
    <F label="For" hint="(blank = stock / our brand)"><Pick value={q.customer_id} blank="Stock (trim ahead)" options={c.d.customers.map(x => ({ v: x.id, l: x.name }))} onChange={v => setQ({ ...q, customer_id: v, order_line_id: null })} /></F>
    {lines.length > 0 && <F label="Order line" hint="(optional)"><Pick value={q.order_line_id} blank="Not tied to an order yet" options={lines.map(l => ({ v: l.id, l: `${l.so} · ${l.customer} · ${n0(l.lbs)} lbs ${PL(l.product)}` }))}
      onChange={v => { const l = lines.find(x => x.id === v); setQ({ ...q, order_line_id: v, customer_id: l?.customer_id ?? q.customer_id, due_on: q.due_on ?? l?.wanted ?? null }) }} /></F>}
    <F label="Note"><TextIn value={q.note} onChange={v => setQ({ ...q, note: v })} /></F>
    <SaveBar busy={busy} onCancel={onClose} onSave={save} onDelete={q.id && q.status === 'open' ? cancel : undefined} disabled={!q.strain || !q.lbs} />
  </Sheet>
}

// ---------- Inventory ----------
function Inventory({ c }: { c: Ctx }) {
  const { d } = c
  const [prod, setProd] = useState<Product | 'all'>('all')
  const [q, setQ] = useState('')
  const kinds: Product[] = ['wet', 'unbucked', 'bucked', 'standards', 'smalls', 'trim']
  const oh = onHand(d)
  const ql = q.trim().toLowerCase()
  const rows = d.pallets.filter(p => (live(p) || p.status === 'at_processor') && (prod === 'all' || p.product === prod)
    && (!ql || `${p.code} ${p.strain} ${p.package_tag ?? ''}`.toLowerCase().includes(ql)))
    .sort((a, b) => (a.strain ?? '').localeCompare(b.strain ?? '') || kinds.indexOf(a.product!) - kinds.indexOf(b.product!) || a.code.localeCompare(b.code))
  return (
    <div className="list">
      <h2>Inventory</h2>
      <div className="row wrap toolbar">
        <div className="seg wrap">{(['all', ...kinds] as const).map(k => <button key={k} className={prod === k ? 'on' : ''} onClick={() => setProd(k)}>
          {k === 'all' ? 'All' : `${PL(k)} ${oh.get(k)?.n ? `(${oh.get(k)!.n})` : ''}`}</button>)}</div>
        <input className="search" type="search" placeholder="Strain, package or tag" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <p className="muted">{rows.length} packages · {n0(sum(rows.map(w)))} lbs{prod === 'unbucked' || prod === 'wet' ? ' (wet weight on paper)' : ''}. Tap one to commit it to an order. Move packages between trailer spots on the Distribution map.</p>
      {rows.length ? <PkgTable c={c} rows={rows} showProduct={prod === 'all'} /> : <p className="muted">Nothing here.</p>}
    </div>
  )
}

function PackageSheet({ c, p, onClose }: { c: Ctx; p: Pallet; onClose: () => void }) {
  const { d } = c
  const lines = d.lines.filter(l => l.product === p.product && canon(l.strain) === canon(p.strain) && !l.on_load && l.picked < l.lbs)
  const [line, setLine] = useState<number | null>(lines.length === 1 ? lines[0].id : null)
  const L = lines.find(l => l.id === line)
  const [lbs, setLbs] = useState<number | null>(null)
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const r = c.runOf(p.id), h = c.heldFor(p.id)
  const made = p.run_id ? d.runs.find(x => x.id === p.run_id) : undefined
  const usedIn = d.inputs.filter(i => i.pallet_id === p.id).map(i => d.runs.find(x => x.id === i.run_id)).filter((x): x is Run => !!x && x.status !== 'cancelled')
  const canCommit = c.canEdit && live(p) && !r && !h && ['standards', 'smalls', 'trim', 'bucked', 'unbucked'].includes(p.product ?? '')
  const want = L ? Math.min(L.lbs - L.picked, w(p)) : null
  const part = lbs != null && lbs < w(p)
  async function commit() {
    setBusy(true)
    try { await c.api.commit(line!, p.id, part ? lbs : null, part ? tag : null); c.flash(`${part ? n0(lbs) + ' lbs of ' : ''}${p.code} committed to ${L?.so}`); await c.reload(); onClose() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title={p.code} sub={<>{p.strain} <Prod p={p.product} /></>} onClose={onClose}>
    {r && <div className="infobox">In run <a onClick={() => c.openRun(r)}>{r.code}</a> ({KIND[r.kind].toLowerCase()})</div>}
    {h && <div className="infobox held">Committed to {h}. Distribution ships it from Fulfillment.</div>}
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
    {canCommit && <>
      <h3 className="csec">Commit to an order</h3>
      {!lines.length ? <p className="muted">No confirmed order is waiting on {p.strain} {PL(p.product).toLowerCase()}. Sales adds the order first.</p> : <>
        <F label="Order line"><Pick value={line} blank="Pick an order…" options={lines.map(l => ({ v: l.id, l: `${l.so} · ${l.customer} · ${n0(l.lbs - l.picked)} of ${n0(l.lbs)} lbs still needed${l.wanted ? ` · wanted ${fmtD(l.wanted)}` : ''}` }))} onChange={v => { setLine(v); setLbs(null) }} /></F>
        {L && <>
          <F label="Lbs" hint={`(blank = the whole package, ${n0(w(p))} lbs)`}><NumIn value={lbs} placeholder={want != null && want < w(p) ? `${n0(want)} needed` : 'whole package'} onChange={setLbs} /></F>
          {part && <F label="New METRC tag for the part" hint="(blank = pending)"><TagIn value={tag} onChange={setTag} /></F>}
          <SaveBar busy={busy} onCancel={onClose} onSave={commit} saveLabel={part ? `Split off ${n0(lbs)} lbs and commit` : 'Commit whole package'} />
        </>}
      </>}
    </>}
  </Sheet>
}

// ---------- Yields ----------
function Yields({ c }: { c: Ctx }) {
  const years = [...new Set([...c.d.runs.map(r => r.crop_year), ...c.d.pallets.map(p => p.crop_year)].filter((x): x is number => !!x))].sort((a, b) => b - a)
  const [yr, setYr] = useState<number | null>(years[0] ?? new Date().getFullYear())
  const [rows, setRows] = useState<Yield[] | null>(null)
  useEffect(() => { setRows(null); c.api.yields(yr).then(setRows).catch(e => c.flash(errText(e), true)) }, [yr])
  const T = (k: keyof Yield) => sum((rows ?? []).map(r => Number(r[k] ?? 0)))
  const tot = rows && rows.length > 1 ? { strain: 'All strains', crop_year: yr, wet_lbs: T('wet_lbs'), bucked_in: T('bucked_in'), bucked: T('bucked'), buck_trim: T('buck_trim'), buck_mold: T('buck_mold'), moisture: T('moisture'),
    trim_in: T('trim_in'), standards: T('standards'), smalls: T('smalls'), trim_lbs: T('trim_lbs'), trim_mold: T('trim_mold'), trim_loss: T('trim_loss'), buck_runs: T('buck_runs'), trim_runs: T('trim_runs') } as Yield : null
  const row = (y: Yield, bold = false) => <tr key={y.strain + (bold ? 'T' : '')} className={bold ? 'total' : ''}>
    <td>{bold ? <b>{y.strain}</b> : y.strain}</td><td className="num">{n0(y.wet_lbs)}</td>
    <td className="num">{n0(y.bucked)} <span className="muted">{pct(y.bucked, y.bucked_in)}</span></td><td className="num">{n0(y.buck_trim)} <span className="muted">{pct(y.buck_trim, y.bucked_in)}</span></td>
    <td className="num hide-s">{n0(y.buck_mold)} <span className="muted">{pct(y.buck_mold, y.bucked_in)}</span></td><td className="num hide-s">{pct(y.moisture, y.bucked_in)}</td>
    <td className="num">{n0(y.standards)} <span className="muted">{pct(y.standards, y.trim_in)}</span></td><td className="num">{n0(y.smalls)} <span className="muted">{pct(y.smalls, y.trim_in)}</span></td>
    <td className="num">{n0(y.trim_lbs)} <span className="muted">{pct(y.trim_lbs, y.trim_in)}</span></td><td className="num hide-s">{n0(y.trim_mold)} <span className="muted">{pct(y.trim_mold, y.trim_in)}</span></td>
    <td className="num"><b>{pct(y.bucked + y.buck_trim, y.bucked_in)}</b></td></tr>
  return (
    <div className="list">
      <div className="row between wrap toolbar"><h2>Yields</h2>
        <div className="seg">{(years.length ? years : [new Date().getFullYear()]).map(y => <button key={y} className={yr === y ? 'on' : ''} onClick={() => setYr(y)}>{y}</button>)}</div></div>
      <p className="muted">Per strain and crop year, from finished runs. Bucking percents are of the wet weight that went in; trimming percents are of the bucked lbs that went in. Return from raw = bucked flower + buck trim, as a share of wet.</p>
      {!rows ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No finished runs for {yr} yet.</p> : <div className="cwrap"><table className="ctable">
        <thead><tr><th>Strain</th><th className="num">Wet</th><th className="num">Bucked</th><th className="num">Buck trim</th><th className="num hide-s">Buck mold</th><th className="num hide-s">Moisture</th>
          <th className="num">Standards</th><th className="num">Smalls</th><th className="num">Trim</th><th className="num hide-s">Trim mold</th><th className="num">Return from raw</th></tr></thead>
        <tbody>{rows.map(y => row(y))}{tot && row(tot, true)}</tbody>
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
  const late = d.requests.filter(q => q.status === 'open' && q.due_on && q.due_on < today())
  const none = !spot.length && !pend.length && !longOut.length && !oldRuns.length && !toPack.length && !late.length
  return (
    <div className="list">
      <h2>Review</h2>
      {none && <p className="muted">Nothing to look at. Everything's packaged, tagged and put away.</p>}
      {spot.length > 0 && <Fold id="proc.spot" open title="Needs a spot" count={spot.length}><p className="muted">Put these in a reefer trailer on the Distribution map (GVR).</p><PkgTable c={c} rows={spot} showProduct /></Fold>}
      {pend.length > 0 && <Fold id="proc.pend" open title="METRC tag pending" count={pend.length}><p className="muted">Open the package on the map and tap Enter tag.</p><PkgTable c={c} rows={pend} showProduct /></Fold>}
      {toPack.length > 0 && <Fold id="proc.pack" open title="Dry harvests with no wet package" count={toPack.length} right={<button className="linkbtn" onClick={() => go('incoming')}>Drying ›</button>}>
        <div className="dlist">{toPack.map(h => <div key={h.id} className="drow"><span className="grow">{h.strain} <span className="muted">{h.site} {h.field ?? ''}</span></span><span className="muted">{fmtD(h.harvested_on ?? h.planned_on)}</span><b>{n0(h.raw_lbs)} lbs</b></div>)}</div></Fold>}
      {longOut.length > 0 && <Fold id="proc.out" open title="Out at a processor over 3 weeks" count={longOut.length}><PkgTable c={c} rows={longOut} /></Fold>}
      {oldRuns.length > 0 && <Fold id="proc.runs" open title="Runs open over a week" count={oldRuns.length}>
        <div className="dlist">{oldRuns.map(r => <button key={r.id} className="drow linkrow" onClick={() => c.openRun(r)}><span className="grow"><b>{r.code}</b> {KIND[r.kind]} · {r.strain}</span><span className="muted">since {fmtD(r.started_on)}</span></button>)}</div></Fold>}
      {late.length > 0 && <Fold id="proc.late" open title="Trim requests past due" count={late.length} right={<button className="linkbtn" onClick={() => go('requests')}>Requests ›</button>}>
        <div className="dlist">{late.map(q => <div key={q.id} className="drow"><span className="grow">{q.strain} {REQ_PRODUCT[q.product]}</span><span className="bad-t">{fmtD(q.due_on)}</span><b>{n0(q.lbs)} lbs</b></div>)}</div></Fold>}
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
        <p className="muted">Where dry flower gets dried. "In house" is our own trailers (no transfer).</p>
        <div className="dlist">{c.d.processors.map(p => <button key={p.id} className="drow linkrow" onClick={() => setEd(p)}>
          <span className="grow"><b>{p.name}</b> <span className="muted">{p.short ?? ''}{p.in_house ? ' · in house' : ''}{p.license ? ` · ${p.license}` : ''}</span></span>{!p.active && <span className="muted">off</span>}</button>)}</div>
      </Fold>
      <Fold id="proc.set.tags" title="METRC tags">
        <p className="muted">"Fill next tags" on a run uses the "Processing packages" tag range for the site (Admin › Settings › Licenses, on the GVR processor license). Without one, scan or type the tags, or leave them pending.</p>
      </Fold>
      <Fold id="proc.set.people" title="People"><ModulePeople sb={sb} module="processing" flash={c.flash} /></Fold>
      {ed && <Sheet title={ed.id ? ed.name : 'New processor'} onClose={() => setEd(null)}>
        <F label="Name"><TextIn value={ed.name} onChange={v => setEd({ ...ed, name: v ?? '' })} /></F>
        <div className="grid2"><F label="Short name"><TextIn value={ed.short} onChange={v => setEd({ ...ed, short: v })} /></F><F label="License"><TextIn value={ed.license} onChange={v => setEd({ ...ed, license: v })} /></F></div>
        <label className="check"><input type="checkbox" checked={!!ed.in_house} onChange={e => setEd({ ...ed, in_house: e.target.checked })} /> In house (our own trailers)</label>
        <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> Active</label>
        <F label="Notes"><TextIn value={ed.notes} onChange={v => setEd({ ...ed, notes: v })} /></F>
        <SaveBar busy={busy} onCancel={() => setEd(null)} onSave={save} disabled={!ed.name} />
      </Sheet>}
    </div>
  )
}

export type { OLine }
