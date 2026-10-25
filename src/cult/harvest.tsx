import { StrainLink } from '../strainCard'
import { useBack } from '../nav'
import { useEffect, useRef, useState } from 'react'
import type { CultApi } from './api'
import { addDays, calcHarvest, fieldName, fmtD, KIND_LABEL, n0, n1, sum, today } from './calc'
import type { Ctx } from './calc'
import type { CPallet, CWeight, CultData, Harvest } from './types'
import { DateIn, errText, F, NumIn, TextIn } from './ui'
import type { Flash } from './ui'
import { ScanButton } from '../scan'
import { can } from '../fold'
import { nextTag } from './schedule'

// Production > Harvest: log a harvest as it happens. Built for a phone in the field or the pack shed.
// Fresh frozen: raw bins, then each pallet as it's made (it lands in Staging on the freezer map right away).
// Dry flower: raw weight only (bucking and trimming belong to Processing later).
// Combine biomass: each tote's dry weight. Stripper header: log the cut, it dries, then enter the dry weight.

const STEP: Record<string, string> = { ff: 'Raw bins, then pallets', dry: 'Raw weight', combine: 'Dry weight per tote', strip: 'Cut, dry, then dry weight' }

export function HarvestTab({ d, c, site, api, flash, onSaved, openFirst }: { d: CultData; c: Ctx; site: string | null; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void>; openFirst?: number | null }) {
  const [day, setDay] = useState(today())
  const [openId, setOpenId] = useState<number | null>(openFirst ?? null)
  const hs = d.harvests.filter(h => (!site || h.site === site) && h.status !== 'cancelled')
  const open = d.harvests.find(h => h.id === openId && h.status !== 'cancelled')
  useBack(!!open, () => setOpenId(null))
  if (open) return <LogPage h={open} d={d} c={c} api={api} flash={flash} onSaved={onSaved} back={() => setOpenId(null)} />

  const now = today()
  const going = hs.filter(h => h.stage === 'harvesting')
  const drying = hs.filter(h => h.stage === 'drying')
  const planned = hs.filter(h => h.status === 'planned' && !h.stage && h.planned_on === day)
  // the week after the picked day, grouped by day
  const weekEnd = addDays(day, 7)
  const ahead = hs.filter(h => h.status === 'planned' && !h.stage && h.planned_on && h.planned_on > day && h.planned_on <= weekEnd)
  const aheadDays = [...new Set(ahead.map(h => h.planned_on!))].sort()
  const behind = day === now ? hs.filter(h => h.status === 'planned' && !h.stage && h.planned_on && h.planned_on < now) : []
  const done = hs.filter(h => h.status === 'done' && h.harvested_on === day)
  const card = (h: Harvest, extra?: string) => {
    const k = calcHarvest(c, h)
    const logged = h.kind === 'ff' ? k.palletLbs : h.kind === 'dry' ? sum(h.raw_bins) : Number(h.dry_lbs ?? 0)
    const est = h.kind === 'ff' ? k.estFF : h.kind === 'dry' ? k.estRaw : k.estBiomass
    return (
      <button key={h.id} className="li setrow hcard" onClick={() => { setOpenId(h.id); window.scrollTo(0, 0) }}>
        <div className="grow">
          <div><b>{h.strain}</b> <span className="muted">{h.site} {fieldName(c, h.field_id)}</span> <span className={`kpill k-${h.kind}`}>{KIND_LABEL[h.kind]}</span></div>
          <div className="muted">{extra ?? STEP[h.kind]}{h.kind === 'ff' && k.pallets.length ? ` · ${k.pallets.length} pallets` : ''}{logged ? ` · ${n0(logged)} lbs logged` : ''}{est ? ` of ~${n0(est)} est.` : ''}</div>
        </div>
        <span className="hgo">›</span>
      </button>
    )
  }
  return (
    <div className="hlog">
      <div className="row wrap hday">
        <DateIn value={day} onChange={v => setDay(v ?? now)} />
        {day !== now && <button className="ghost small" onClick={() => setDay(now)}>Today</button>}
      </div>
      {going.length > 0 && <section><h3 className="csec">Harvesting now</h3>{going.map(h => card(h, `Started ${fmtD(h.harvested_on, true)}`))}</section>}
      <section><h3 className="csec">{day === now ? 'On the schedule today' : `Scheduled ${fmtD(day, true)}`}</h3>
        {planned.length ? planned.map(h => card(h)) : <p className="muted">Nothing scheduled{site ? ` at ${site}` : ''}{aheadDays.length ? '' : ' this week'}. Pick another day, or add the harvest on the Schedule.</p>}</section>
      <section><h3 className="csec">Next 7 days <span className="muted">through {fmtD(weekEnd, true)}</span></h3>
        {aheadDays.length ? aheadDays.map(dd => <div key={dd} className="hahead"><div className="hahead-d">{fmtD(dd, true)}</div>{ahead.filter(h => h.planned_on === dd).map(h => card(h))}</div>)
          : <p className="muted">Nothing else scheduled{site ? ` at ${site}` : ''} in the next 7 days.</p>}</section>
      {drying.length > 0 && <section><h3 className="csec">Drying</h3>{drying.map(h => card(h, `Cut ${fmtD(h.harvested_on, true)} · enter the dry weight when it's out`))}</section>}
      {behind.length > 0 && <section><h3 className="csec">Not logged yet <span className="muted">from earlier days</span></h3>{behind.map(h => card(h, `Scheduled ${fmtD(h.planned_on, true)}`))}</section>}
      {done.length > 0 && <section><h3 className="csec">Finished {day === now ? 'today' : fmtD(day, true)}</h3>{done.map(h => card(h, 'Done'))}</section>}
    </div>
  )
}

function LogPage({ h, d, c, api, flash, onSaved, back }: { h: Harvest; d: CultData; c: Ctx; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void>; back: () => void }) {
  const [ws, setWs] = useState<CWeight[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [metrc, setMetrc] = useState<{ open: number; due: string | null } | null>(null)
  const k = calcHarvest(c, h)
  const loadW = () => api.weights(h.id).then(setWs).catch(e => { setWs([]); flash(errText(e), true) })
  const loadM = () => api.metrcStatus().then(m => setMetrc(m.get(h.id) ?? null)).catch(() => setMetrc(null))
  useEffect(() => { loadW(); loadM() }, [h.id])
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await Promise.all([loadW(), loadM(), onSaved(ok)]) } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const raw = (ws ?? []).filter(w => w.kind === 'raw'), totes = (ws ?? []).filter(w => w.kind === 'tote'), dry = (ws ?? []).filter(w => w.kind === 'dry')
  const pallets = k.pallets.filter(p => p.status !== 'archived').sort((a, b) => a.id - b.id)
  const done = h.status === 'done'
  const canFix = can('cultivation', 'edit_finished')
  const [editing, setEditing] = useState(false)
  const locked = done && !editing
  const pl = h.planting_id ? c.planting.get(h.planting_id) : undefined
  const trial = !!pl?.trial || c.field.get(h.field_id ?? -1)?.kind === 'trials'
  const prefix = trial ? 'T' : c.site.get(h.site)?.pallet_prefix ?? 'P'
  // plants still standing in the planting (before this harvest)
  const leftBefore = pl ? Math.max((pl.plants ?? 0) - (pl.plant_loss ?? 0) - sum(d.harvests.filter(x => x.planting_id === pl.id && x.id !== h.id && x.status === 'done' && x.kind === h.kind).map(x => x.plants_harvested ?? 0)), 0) : null
  const rawLbs = sum(raw.map(w => w.lbs)) || sum(h.raw_bins)
  return (
    <div className="hlog">
      <button className="ghost small hback" onClick={back}>‹ Harvest</button>
      <h2><StrainLink name={h.strain} /> {trial && <span className="kpill k-trial" title="Trial strain">T</span>} {(h.day_no ?? 1) > 1 && <span className="kpill s-planned">Day {h.day_no}</span>} <span className="muted">{h.site} {fieldName(c, h.field_id)}</span></h2>
      {h.planted_strain && h.planted_strain !== h.strain && <p className="muted small">Planted as {h.planted_strain} (renamed at harvest; the planting keeps its name)</p>}
      <div className="row wrap"><span className={`kpill k-${h.kind}`}>{KIND_LABEL[h.kind]}</span>
        <span className="muted">{done ? `Finished · harvested ${fmtD(h.harvested_on, true)}` : h.stage === 'drying' ? `Drying since ${fmtD(h.harvested_on, true)}` : h.stage === 'harvesting' ? `Harvesting · started ${fmtD(h.harvested_on, true)}` : `Scheduled ${fmtD(h.planned_on, true)}`}
          {h.plants ? ` · ${n0(h.plants)} plants scheduled` : ''}{h.acres ? ` · ${n1(h.acres)} acres` : ''}{cultBatch(h) ? ` · METRC batch ${cultBatch(h)}` : ''}</span></div>
      {metrc && metrc.open > 0 && <p className="cnote">Waiting on METRC: {metrc.open} step{metrc.open === 1 ? '' : 's'} on the Compliance to-do list{metrc.due ? `, next due ${new Date(metrc.due).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.</p>}
      {!locked && (h.kind === 'ff' || h.kind === 'dry') && <Rename h={h} d={d} api={api} busy={busy} run={run} />}

      {(h.kind === 'ff' || h.kind === 'dry') && <Plants h={h} api={api} busy={busy} done={locked} run={run} leftBefore={leftBefore} />}

      {h.kind === 'ff' && <>
        <div className="ckpis hk">
          <div><b>{n0(k.palletLbs)}</b><span>lbs packed{k.estFF ? ` of ~${n0(k.estFF)}` : ''}</span></div>
          <div><b>{pallets.length}</b><span>pallets ({pallets.filter(p => p.pushed !== false).length} pushed)</span></div>
          <div><b>{n0(rawLbs)}</b><span>lbs raw ({raw.length || h.raw_bins.length} bin{(raw.length || h.raw_bins.length) === 1 ? '' : 's'})</span></div>
          <div><b>{k.palletLbs && (h.plants_harvested ?? h.plants) ? n1(k.palletLbs / (h.plants_harvested ?? h.plants)!) : ''}</b><span>lbs / plant{h.est_lbs_per_plant ? ` (est ${n1(h.est_lbs_per_plant)})` : ''}</span></div>
        </div>
        <Weights title="Raw bins" kind="raw" rows={raw} busy={busy} done={locked} unit="bin" admin={canFix}
          onAdd={lbs => run(() => api.logWeight(h.id, 'raw', lbs), `Bin ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')}
          onEdit={(id, lbs) => run(() => api.editWeight(id, lbs), `Bin changed to ${n1(lbs)} lbs`)} />
        <PalletLog h={h} api={api} busy={busy} done={locked} pallets={pallets} run={run} prefix={prefix} />
        {!locked && <BulkPallets h={h} api={api} busy={busy} run={run} prefix={prefix} pallets={pallets} />}
      </>}

      {h.kind === 'dry' && <>
        <div className="ckpis hk"><div><b>{n0(rawLbs)}</b><span>lbs raw{k.estRaw ? ` of ~${n0(k.estRaw)}` : ''}</span></div><div><b>{raw.length || h.raw_bins.length}</b><span>bin{(raw.length || h.raw_bins.length) === 1 ? '' : 's'}</span></div></div>
        <Weights title="Raw weight" kind="raw" rows={raw} busy={busy} done={locked} unit="bin" admin={canFix}
          onAdd={lbs => run(() => api.logWeight(h.id, 'raw', lbs), `Bin ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')}
          onEdit={(id, lbs) => run(() => api.editWeight(id, lbs), `Bin changed to ${n1(lbs)} lbs`)} />
        <p className="cnote">Only the raw weight is logged here. Finishing sends the plants and wet weight to the METRC to-do list. Bucking and trimming are logged in Processing.</p>
      </>}

      {h.kind === 'combine' && <>
        <div className="ckpis hk"><div><b>{n0(sum(totes.map(w => w.lbs)))}</b><span>lbs dry{k.estBiomass ? ` of ~${n0(k.estBiomass)}` : ''}</span></div><div><b>{totes.length}</b><span>totes</span></div></div>
        <Weights title="Totes" kind="tote" rows={totes} busy={busy} done={locked} unit="tote" withTag
          onAdd={(lbs, tag) => run(() => api.logWeight(h.id, 'tote', lbs, tag), `Tote ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')} />
      </>}

      {h.kind === 'strip' && <StripLog h={h} api={api} busy={busy} done={locked} dry={dry} run={run} estDry={k.estBiomass} />}

      {!done && (h.kind !== 'strip' || h.stage === 'drying') && <Finish h={h} busy={busy} run={run} api={api} back={back} raw={raw} pallets={pallets}
        ready={h.kind === 'ff' ? pallets.length > 0 : h.kind === 'dry' ? raw.length > 0 || h.raw_bins.length > 0 : h.kind === 'combine' ? totes.length > 0 : dry.length > 0} />}
      {done && !canFix && <p className="cnote">Finished. Only a Production Admin can change a finished harvest.</p>}
      {done && canFix && !editing && <div className="row hfin"><button className="ghost" onClick={() => setEditing(true)}>Edit finished harvest…</button>
        <span className="muted">Fix totals, add a forgotten bin or pallet, or remove one logged by mistake.</span></div>}
      {done && canFix && editing && <FixTotals h={h} api={api} busy={busy} run={run} k={k} onDone={() => setEditing(false)} />}
      {d.year !== d.currentYear && <p className="cnote">This is the {d.year} season.</p>}
    </div>
  )
}

const cultBatch = (h: Harvest) => h.metrc_name ?? null

/** planting mix-up: the harvest (and its pallets) take the strain it really is; the planting keeps its planted name */
function Rename({ h, d, api, busy, run }: { h: Harvest; d: CultData; api: CultApi; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState<string | null>(null)
  if (!can('cultivation', 'rename_harvest', 'user')) return null
  if (!open) return <div className="row hfin"><button className="linkbtn" onClick={() => setOpen(true)}>Not {h.strain}? Rename this harvest…</button></div>
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Rename this harvest</h3><button className="linkbtn" onClick={() => setOpen(false)}>Close</button></div>
      <p className="muted small">For a planting mix-up. The harvest and its pallets take the new name; the planting stays {h.planted_strain ?? h.strain}.</p>
      <div className="hpal">
        <label className="htag"><span>It's really</span><TextIn value={v} onChange={setV} list="cult-strains-all" placeholder="Strain" autoFocus /></label>
        <datalist id="cult-strains-all">{d.strains.filter(s => s.active !== false).map(s => <option key={s.name} value={s.name} />)}</datalist>
        <button className="primary" disabled={busy || !v?.trim()} onClick={() => run(() => api.rename(h.id, v!.trim()), `Renamed to ${v}`).then(() => setOpen(false))}>Rename</button>
      </div>
    </section>
  )
}

/** plants harvested: starts as the scheduled plants; METRC harvests this many plants into the batch at push */
function Plants({ h, api, busy, done, run, leftBefore }: { h: Harvest; api: CultApi; busy: boolean; done: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; leftBefore: number | null }) {
  const saved = h.plants_harvested ?? h.plants ?? null
  const [v, setV] = useState<number | null>(saved)
  useEffect(() => setV(h.plants_harvested ?? h.plants ?? null), [h.plants_harvested, h.plants])
  const left = leftBefore == null ? null : Math.max(leftBefore - (v ?? 0), 0)
  const changed = v !== (h.plants_harvested ?? null)
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Plants harvested</h3>{(h.metrc_plants ?? 0) > 0 && <span className="muted small">{n0(h.metrc_plants!)} in METRC</span>}</div>
      <div className="hadd">
        <input type="number" inputMode="numeric" value={v ?? ''} disabled={done} onChange={e => setV(e.target.value === '' ? null : Number(e.target.value))} aria-label="Plants harvested" />
        {!done && <button className="primary" disabled={busy || v == null || !changed} onClick={() => run(() => api.setPlants(h.id, v!), `${n0(v!)} plants`)}>{h.plants_harvested == null ? 'Confirm' : 'Save'}</button>}
      </div>
      <p className="muted small">{h.plants_harvested == null && !done ? `Filled in from the schedule (${h.plants ? n0(h.plants) : 'none'}). Change it if the crew cut more or fewer.` : ''}
        {left != null ? ` ${n0(left)} plant${left === 1 ? '' : 's'} left in the planting after this.` : ''}</p>
    </section>
  )
}
/** a list of weights with a quick add box (Enter adds). Tap a bin to fix it while it isn't in METRC yet. */
function Weights({ title, kind, rows, busy, done, unit, withTag, admin, onAdd, onRemove, onEdit }: {
  title: string; kind: string; rows: CWeight[]; busy: boolean; done: boolean; unit: string; withTag?: boolean; admin?: boolean
  onAdd: (lbs: number, tag: string | null) => void; onRemove: (id: number) => void; onEdit?: (id: number, lbs: number) => void
}) {
  const [v, setV] = useState('')
  const [tag, setTag] = useState('')
  const [ed, setEd] = useState<{ id: number; v: string } | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const add = () => { const n = Number(v); if (!(n > 0)) return; onAdd(n, tag.trim() || null); setV(''); setTag(''); ref.current?.focus() }
  const open = (r: CWeight) => !done && (!r.pushed || admin)
  const saveEd = () => { if (ed && Number(ed.v) > 0 && onEdit) onEdit(ed.id, Number(ed.v)); setEd(null) }
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>{title} <span className="muted">{rows.length} · {n0(sum(rows.map(r => r.lbs)))} lbs</span></h3>
        {rows.some(r => r.pushed) && rows.some(r => !r.pushed) && <span className="muted small">{rows.filter(r => !r.pushed).length} not in METRC yet</span>}</div>
      {!done && <div className="hadd">
        <input ref={ref} type="number" inputMode="decimal" placeholder={`${unit} lbs`} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} data-kind={kind} />
        {withTag && <><input placeholder="Tag (optional)" value={tag} onChange={e => setTag(e.target.value)} /><ScanButton onScan={setTag} disabled={busy} /></>}
        <button className="primary" disabled={busy || !(Number(v) > 0)} onClick={add}>Add {unit}</button>
      </div>}
      {rows.length > 0 && <div className="binrow">{rows.map((r, i) => ed?.id === r.id
        ? <span key={r.id} className="binedit"><input type="number" inputMode="decimal" autoFocus value={ed.v} onChange={e => setEd({ id: r.id, v: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') saveEd(); if (e.key === 'Escape') setEd(null) }} onBlur={saveEd} aria-label={`${unit} ${i + 1} lbs`} /></span>
        : <span key={r.id} title={(r.tag ?? '') + (r.pushed ? ' · in METRC' : '')} className={r.pushed ? 'inmetrc' : ''}>
            {onEdit && open(r) ? <a className="binfix" onClick={() => !busy && setEd({ id: r.id, v: String(r.lbs) })}>{i + 1}: {n1(r.lbs)}</a> : <>{i + 1}: {n1(r.lbs)}</>}
            {r.tag ? ` · ${r.tag.slice(-6)}` : ''}{open(r) && <a onClick={() => !busy && onRemove(r.id)}>×</a>}</span>)}</div>}
      {onEdit && !done && rows.length > 0 && <p className="muted small">Tap a {unit} to fix its weight.{rows.some(r => r.pushed) ? ' Bins with a check are already in METRC.' : ''}</p>}
    </section>
  )
}

/** P + the METRC tag's last 4 digits: 1A4…10053 → P53 (trials: T053). Used only where a site has no tag rule. */
export function palletFromTag(tag: string, prefix = 'P') {
  const m = /(\d{4})$/.exec(tag.trim())
  if (!m) return ''
  const n = Number(m[1])
  return n ? prefix + (prefix === 'T' ? String(n).padStart(3, '0') : String(n)) : ''
}

type LogPallet = CPallet

/** fresh frozen pallets: logged as they're made (not pushed), fixed freely, then pushed to METRC as packages */
function PalletLog({ h, api, busy, done, pallets, run, prefix }: {
  h: Harvest; api: CultApi; busy: boolean; done: boolean; pallets: LogPallet[]
  run: (f: () => Promise<unknown>, ok: string) => Promise<void>; prefix: string
}) {
  const last = pallets[pallets.length - 1]
  const [lbs, setLbs] = useState<number | null>(650)
  const [boxes, setBoxes] = useState<number | null>(last?.boxes ?? null)
  const [partial, setPartial] = useState(false)
  const [next, setNext] = useState<{ code: string; tag: string | null; available: boolean | null } | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [pick, setPick] = useState<Set<number>>(new Set())
  const [edit, setEdit] = useState<number | null>(null)
  useEffect(() => { if (!done) api.nextPallet(h.id).then(setNext).catch(() => setNext(null)) }, [h.id, pallets.length, done])
  const shownCode = code ?? next?.code ?? ''
  const shownTag = tag ?? (code == null ? next?.tag ?? '' : '')
  const waiting = pallets.filter(p => p.pushed === false)
  const pushed = pallets.filter(p => p.pushed !== false)
  const canPush = can('cultivation', 'push', 'user')
  const canUnpush = can('cultivation', 'unpush')
  async function save() {
    const c = shownCode.trim()
    // a tag typed or cleared by hand wins; otherwise the database makes it from the pallet # (site tag rule)
    await run(() => api.addPallets(h.id, [{ lbs: lbs!, tag: shownTag.trim(), code: c || undefined, boxes, partial, pending: tag != null && !tag.trim() }]),
      `Pallet ${c} saved: ${n0(lbs!)} lbs, in Staging (not pushed yet)`)
    setPartial(false); setLbs(650); setCode(null); setTag(null)
  }
  async function push(ids: number[] | null) {
    const list = ids ? waiting.filter(p => ids.includes(p.id)) : waiting
    const pending = list.filter(p => !p.package_tag)
    if (pending.length && !window.confirm(`${pending.map(p => p.code).join(', ')} ha${pending.length === 1 ? 's' : 've'} no METRC tag. Push as tag pending?`)) return
    const plantsFirst = h.plants_harvested == null ? h.plants : null
    if (h.plants_harvested == null) {
      if (!h.plants) { window.alert('Enter the plants harvested first (above). METRC harvests the plants into the batch at the first push.'); return }
      if (!window.confirm(`Plants harvested: ${n0(h.plants)} (from the schedule). Push with that? Cancel to change it first.`)) return
    }
    await run(async () => {
      if (plantsFirst) await api.setPlants(h.id, plantsFirst)
      return api.push(h.id, ids, pending.length > 0)
    }, `${list.length} pallet${list.length === 1 ? '' : 's'} pushed. The packages are on the METRC to-do list.`)
    setPick(new Set())
  }
  const tog = (id: number) => setPick(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Pallets <span className="muted">{pallets.length} · {n0(sum(pallets.map(p => p.og_weight)))} lbs</span></h3></div>
      {!done && <div className="hpal">
        <label><span>Weight</span><NumIn value={lbs} onChange={setLbs} /></label>
        <label><span>Boxes</span><NumIn value={boxes} onChange={setBoxes} /></label>
        <label><span>Pallet # {code != null && next && code !== next.code ? <a className="linkbtn" onClick={() => { setCode(null); setTag(null) }}>use {next.code}</a> : <em className="muted">(next)</em>}</span>
          <input value={shownCode} placeholder={`${prefix}…`} onChange={e => { setCode(e.target.value.toUpperCase().replace(/\s/g, '')); setTag(null) }} style={{ width: 110 }} /></label>
        <label className="htag"><span>METRC tag {tag == null && code == null && next?.tag ? (next.available === false ? <em className="warn-t">(from the pallet #, but not on METRC's available list: check it)</em> : <em className="muted">(from the pallet #)</em>)
          : tag == null && code != null ? <em className="muted">(from the pallet # when saved)</em> : !shownTag ? <em className="muted">(blank = pending)</em> : null}</span>
          <div className="row"><input value={shownTag} onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder={code != null ? 'Auto from pallet #' : 'Scan or type'} /><ScanButton onScan={t => setTag(t)} disabled={busy} /></div></label>
        {shownCode && pallets.some(p => p.code === shownCode) && <p className="warn-t small">{shownCode} is already on this harvest.</p>}
        <label className="check"><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} /> <span>Last pallet (partial)</span></label>
        <button className="primary" disabled={busy || !(Number(lbs) > 0)} onClick={save}>Save pallet</button>
        <p className="cnote">Saved pallets go into {h.site} Staging on the freezer map and can be moved, but they aren't packages until they're pushed. Fix anything before you push.</p>
      </div>}

      {waiting.length > 0 && <>
        <h4 className="csec">Not pushed <span className="muted">{waiting.length} · {n0(sum(waiting.map(p => p.og_weight)))} lbs</span></h4>
        <div className="dlist">{[...waiting].reverse().map(p => edit === p.id
          ? <EditPallet key={p.id} p={p} busy={busy} onCancel={() => setEdit(null)} onSave={x => run(() => api.editPallet(p.id, x), `${x.code ?? p.code} fixed`).then(() => setEdit(null))} />
          : <div key={p.id} className="drow">
            {canPush && !done && <input type="checkbox" checked={pick.has(p.id)} onChange={() => tog(p.id)} aria-label={`Pick ${p.code}`} />}
            <span className="grow"><b>{p.code}</b> <span className="muted">{p.boxes ? `${p.boxes} boxes · ` : ''}{p.package_tag ? p.package_tag.slice(-8) : <em className="warn-t">tag pending</em>}{p.partial ? ' · partial' : ''}</span></span>
            <b>{n0(Number(p.og_weight))} lbs</b>
            {!done && <><button className="ghost small" disabled={busy} onClick={() => setEdit(p.id)}>Edit</button>
              <button className="ghost small" disabled={busy} title="Logged by mistake" onClick={() => run(() => api.removePallet(p.id), `${p.code} removed`)}>✕</button></>}
          </div>)}</div>
        {!done && canPush && <div className="row wrap hpush">
          <button className="primary" disabled={busy} onClick={() => push(null)}>Push all {waiting.length} to METRC</button>
          {pick.size > 0 && pick.size < waiting.length && <button className="ghost" disabled={busy} onClick={() => push([...pick])}>Push {pick.size} picked</button>}
        </div>}
        {!done && !canPush && <p className="cnote">A Production lead pushes these to METRC.</p>}
        <p className="cnote">Push puts the plants and the raw bins into the METRC batch, then makes a package for each pallet (on the Compliance METRC to-do list).</p>
      </>}

      {pushed.length > 0 && <>
        {waiting.length > 0 && <h4 className="csec">Pushed <span className="muted">{pushed.length} · {n0(sum(pushed.map(p => p.og_weight)))} lbs</span></h4>}
        <div className="dlist">{[...pushed].reverse().map(p => (
          <div key={p.id} className="drow"><span className="grow"><b>{p.code}</b> <span className="muted">{p.boxes ? `${p.boxes} boxes · ` : ''}{p.package_tag ? p.package_tag.slice(-8) : 'tag pending'}{p.partial ? ' · partial' : ''}</span></span>
            <b>{n0(Number(p.og_weight))} lbs</b>
            {!done && canUnpush && <button className="ghost small" disabled={busy} title="Take it back to Not pushed (only if METRC hasn't been done)" onClick={() => run(() => api.unpush(p.id), `${p.code} un-pushed`)}>Un-push</button>}
            {done && <button className="ghost small" disabled={busy} title="Logged by mistake" onClick={() => run(() => api.removePallet(p.id), `${p.code} removed`)}>✕</button>}
          </div>))}</div>
      </>}
    </section>
  )
}

function EditPallet({ p, busy, onSave, onCancel }: { p: LogPallet; busy: boolean; onSave: (x: { lbs: number | null; boxes: number | null; code?: string; tag?: string | null; pending?: boolean; partial: boolean }) => void; onCancel: () => void }) {
  const [lbs, setLbs] = useState<number | null>(p.og_weight)
  const [boxes, setBoxes] = useState<number | null>(p.boxes ?? null)
  const [code, setCode] = useState(p.code)
  const [tag, setTag] = useState(p.package_tag ?? '')
  const [partial, setPartial] = useState(!!p.partial)
  const tagChanged = tag !== (p.package_tag ?? '')
  return (
    <div className="dcard hedit">
      <div className="hpal">
        <label><span>Weight</span><NumIn value={lbs} onChange={setLbs} /></label>
        <label><span>Boxes</span><NumIn value={boxes} onChange={setBoxes} /></label>
        <label><span>Pallet #</span><input value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} /></label>
        <label className="htag"><span>METRC tag {code !== p.code && !tagChanged ? <em className="muted">(follows the new pallet #)</em> : null}</span>
          <div className="row"><input value={tag} onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="blank = pending" /><ScanButton onScan={setTag} disabled={busy} /></div></label>
        <label className="check"><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} /> <span>Partial</span></label>
        <div className="row"><button className="ghost" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy || !(Number(lbs) > 0)} onClick={() => onSave({ lbs, boxes, partial, ...(code !== p.code ? { code } : {}),
            ...(tagChanged ? (tag ? { tag } : { pending: true }) : {}) })}>Save</button></div>
      </div>
    </div>
  )
}

function StripLog({ h, api, busy, done, dry, run, estDry }: { h: Harvest; api: CultApi; busy: boolean; done: boolean; dry: CWeight[]; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; estDry: number | null }) {
  const [day, setDay] = useState<string | null>(h.planned_on && h.planned_on < today() ? h.planned_on : today())
  const [acres, setAcres] = useState<number | null>(h.acres)
  if (!h.stage && !done) return (
    <section className="dcard">
      <div className="dcard-h"><h3>Log the cut</h3></div>
      <p className="muted">Stripper header material comes off wet and isn't weighed until it's dry. Log the cut now; it waits under Drying until the dry weight is in.</p>
      <div className="hpal"><label><span>Cut on</span><DateIn value={day} onChange={setDay} /></label><label><span>Acres</span><NumIn value={acres} onChange={setAcres} /></label>
        <button className="primary" disabled={busy} onClick={() => run(() => api.startDrying(h.id, day, acres), 'Cut logged, now drying')}>Cut done, start drying</button></div>
    </section>
  )
  return <>
    <div className="ckpis hk"><div><b>{n0(sum(dry.map(w => w.lbs)))}</b><span>lbs dry{estDry ? ` of ~${n0(estDry)}` : ''}</span></div><div><b>{dry.length}</b><span>weights</span></div></div>
    <Weights title="Dry weight" kind="dry" rows={dry} busy={busy} done={done} unit="weight" withTag onAdd={(lbs, tag) => run(() => api.logWeight(h.id, 'dry', lbs, tag), `Dry ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')} />
  </>
}

function Finish({ h, busy, run, api, back, ready, raw, pallets }: { h: Harvest; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; api: CultApi; back: () => void; ready: boolean; raw: CWeight[]; pallets: LogPallet[] }) {
  const [plants, setPlants] = useState<number | null>(h.plants_harvested ?? h.plants)
  const [notes, setNotes] = useState('')
  const [open, setOpen] = useState<null | 'finish' | 'continue'>(null)
  const [on, setOn] = useState<string | null>(null)
  const waiting = pallets.filter(p => p.pushed === false)
  const wet = sum(raw.map(w => w.lbs)) || sum(h.raw_bins)
  const packed = sum(pallets.map(p => Number(p.og_weight ?? 0)))
  const waste = Math.max(wet - packed, 0)
  const blocked = h.kind === 'ff' && waiting.length > 0
  const flower = h.kind === 'ff' || h.kind === 'dry'
  // opened by mistake: nothing logged yet, so it can go back on the schedule
  const nothing = h.stage === 'harvesting' && raw.length === 0 && h.raw_bins.length === 0 && pallets.length === 0 && !(Number(h.metrc_plants ?? 0) > 0) && !(Number(h.metrc_wet_lbs ?? 0) > 0)
  if (!open) return (
    <div className="row wrap hfin">
      <button className="ghost" disabled={busy || !ready || blocked} onClick={() => setOpen('finish')}>Finish harvest…</button>
      {flower && <button className="ghost" disabled={busy || !ready || blocked} onClick={() => setOpen('continue')}>Continue tomorrow…</button>}
      {!ready ? <span className="muted">Log something first.</span> : blocked ? <span className="muted">Push every pallet first ({waiting.length} not pushed).</span> : null}
      {nothing && <button className="ghost" disabled={busy} onClick={() => run(() => api.unstart(h.id), `${h.strain} is back on the schedule${h.planned_on ? ` for ${fmtD(h.planned_on, true)}` : ''}`).then(back)}>Didn't start: back on the schedule</button>}
    </div>
  )
  const cont = open === 'continue'
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>{cont ? 'Continue tomorrow' : 'Finish harvest'}</h3></div>
      {cont && <p className="muted small">Today's part is finished as its own harvest. A new harvest is added for the rest of the planting, named {h.metrc_name ? `${h.metrc_name.replace(/-\d+$/, '')}-${(h.day_no ?? 1) + 1}` : 'with -2 on the batch name'}.</p>}
      {h.kind === 'ff' && wet > 0 && <p className="cnote">METRC: waste of <b>{n1(waste)} lbs</b> (raw {n1(wet)} − packed {n1(packed)}) is recorded 48 hours after you finish, then the harvest is finished in METRC. Both go on the Compliance to-do list.</p>}
      {h.kind === 'dry' && <p className="cnote">METRC: the plants and {n1(wet)} lbs wet weight go on the Compliance to-do list.</p>}
      <div className="hpal">
        {flower && <label><span>Plants harvested{cont ? ' today' : ''}</span><NumIn value={plants} onChange={setPlants} /></label>}
        {cont && <label><span>Next day</span><DateIn value={on} onChange={setOn} /></label>}
        <label className="htag"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" /></label>
        <div className="row"><button className="ghost" onClick={() => setOpen(null)}>Not yet</button>
          {cont
            ? <button className="primary" disabled={busy} onClick={() => run(() => api.continueTomorrow(h.id, plants, on, notes || null), 'Today finished. Tomorrow is on the schedule.').then(back)}>Finish today, continue tomorrow</button>
            : <button className="primary" disabled={busy} onClick={() => run(() => api.finish(h.id, plants, notes || null), 'Harvest finished').then(back)}>Finish</button>}</div>
      </div>
    </section>
  )
}

/** back-fill: several pallets at once (how many × lbs each); numbers and tags come from the next free pallet numbers */
function BulkPallets({ h, api, busy, run, prefix, pallets }: { h: Harvest; api: CultApi; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; prefix: string; pallets: { code: string }[] }) {
  const [open, setOpen] = useState(false)
  const [n, setN] = useState<number | null>(null)
  const [lbs, setLbs] = useState<number | null>(650)
  const [rows, setRows] = useState<{ lbs: string; tag: string; code: string; auto?: boolean }[]>([])
  const [loading, setLoading] = useState(false)
  const set = (i: number, v: Partial<{ lbs: string; tag: string; code: string; auto: boolean }>) => setRows(rs => rs.map((x, j) => (j === i ? { ...x, ...v } : x)))
  const dup = rows.map(r => r.code).filter((c, i, a) => c && (a.indexOf(c) !== i || pallets.some(p => p.code === c)))
  if (!open) return <div className="row hfin"><button className="ghost" disabled={busy} onClick={() => setOpen(true)}>Back-fill several pallets…</button><span className="muted">From paper, after the fact</span></div>
  async function addRows() {
    const k = Math.min(60, n ?? 1)
    setLoading(true)
    try {
      const out: { lbs: string; tag: string; code: string }[] = []
      for (let i = 0; i < k; i++) {
        const nx = await api.nextPallet(h.id, rows.length + i).catch(() => null)
        out.push({ lbs: lbs ? String(lbs) : '', code: nx?.code ?? '', tag: nx?.tag ?? '' })
      }
      setRows(rs => [...rs, ...out])
    } finally { setLoading(false) }
  }
  async function make() {
    const good = rows.filter(r => Number(r.lbs) > 0)
    await run(() => api.addPallets(h.id, good.map(r => ({ lbs: Number(r.lbs), tag: r.tag.trim(), code: r.code || undefined, pending: !r.auto && !r.tag.trim() }))),
      `${good.length} pallet${good.length === 1 ? '' : 's'} added, in Staging (not pushed yet)`)
    setRows([]); setOpen(false)
  }
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Back-fill pallets</h3><button className="linkbtn" onClick={() => { setRows([]); setOpen(false) }}>Close</button></div>
      <div className="hpal">
        <label><span>How many</span><NumIn value={n} onChange={setN} /></label>
        <label><span>Lbs each</span><NumIn value={lbs} onChange={setLbs} /></label>
        <button className="ghost" disabled={!n || n <= 0 || loading} onClick={addRows}>{loading ? 'Numbering…' : 'Add rows'}</button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="palrow bfrow">
          <span className="muted small">{i + 1}</span>
          <input inputMode="decimal" placeholder="lbs" value={r.lbs} onChange={e => set(i, { lbs: e.target.value })} />
          <input className="mono-in" placeholder="METRC tag (blank = pending)" value={r.tag} onChange={e => set(i, { tag: e.target.value.toUpperCase().replace(/\s/g, ''), auto: false })} />
          <ScanButton compact onScan={tag => set(i, { tag })} />
          <input className="bfcode" placeholder={`${prefix}…`} value={r.code} onChange={e => set(i, { code: e.target.value.toUpperCase().replace(/\s/g, ''), tag: '', auto: true })} title="Pallet # (the tag follows it when saved)" />
          <button className="ghost small" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {rows.length > 0 && <>
        {dup.length > 0 && <p className="warn-t small">Already used: {[...new Set(dup)].join(', ')}</p>}
        <div className="row">
          {rows[0].tag && rows.length > 1 && <button className="ghost small" onClick={() => setRows(rs => rs.map((x, j) => ({ ...x, tag: nextTag(rs[0].tag, j) })))}>Number the tags in order from the first</button>}
          <button className="primary" disabled={busy || !rows.some(r => Number(r.lbs) > 0) || dup.length > 0} onClick={make}>Create {rows.length} pallet{rows.length === 1 ? '' : 's'} ({n0(sum(rows.map(r => Number(r.lbs) || 0)))} lbs)</button>
        </div>
        <p className="cnote">Pallet # and tag are the next free numbers (the tag follows the pallet # where the site has a tag rule). New pallets go to {h.site} Staging, not pushed.</p>
      </>}
    </section>
  )
}

/** Production Admins: fix a finished harvest's totals, or reopen it */
function FixTotals({ h, api, busy, run, k, onDone }: { h: Harvest; api: CultApi; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; k: ReturnType<typeof calcHarvest>; onDone: () => void }) {
  const [x, setX] = useState<Partial<Harvest>>(h)
  const set = (v: Partial<Harvest>) => setX(s => ({ ...s, ...v }))
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Fix the totals</h3><span className="muted small">Production Admins only · every change is in Activity</span></div>
      <div className="grid3">
        <F label="Harvested on"><DateIn value={x.harvested_on} onChange={v => set({ harvested_on: v })} /></F>
        <F label="Plants harvested"><NumIn value={x.plants_harvested} onChange={v => set({ plants_harvested: v })} /></F>
        <F label="METRC harvest name"><TextIn value={x.metrc_name} onChange={v => set({ metrc_name: v })} /></F>
        {h.kind !== 'combine' && h.kind !== 'strip' && <F label="Raw lbs" hint="(blank = bins)"><NumIn value={x.raw_lbs} placeholder={sum(h.raw_bins) ? n1(sum(h.raw_bins)) : ''} onChange={v => set({ raw_lbs: v })} /></F>}
        {h.kind === 'ff' && <F label="Fresh frozen lbs" hint="(blank = pallets)"><NumIn value={x.ff_lbs} placeholder={k.palletLbs ? n1(k.palletLbs) : ''} onChange={v => set({ ff_lbs: v })} /></F>}
        {h.kind === 'dry' && <><F label="Bucked lbs"><NumIn value={x.bucked_lbs} onChange={v => set({ bucked_lbs: v })} /></F>
          <F label="Trim lbs"><NumIn value={x.trim_lbs} onChange={v => set({ trim_lbs: v })} /></F><F label="Mold lbs"><NumIn value={x.mold_lbs} onChange={v => set({ mold_lbs: v })} /></F></>}
      </div>
      <div className="row wrap">
        <button className="primary" disabled={busy} onClick={() => run(() => api.save<Harvest>('cult_harvests', { id: h.id, harvested_on: x.harvested_on, plants_harvested: x.plants_harvested ?? null, metrc_name: x.metrc_name ?? null,
          raw_lbs: x.raw_lbs ?? null, ff_lbs: x.ff_lbs ?? null, bucked_lbs: x.bucked_lbs ?? null, trim_lbs: x.trim_lbs ?? null, mold_lbs: x.mold_lbs ?? null }), 'Harvest fixed')}>Save totals</button>
        <button className="ghost" disabled={busy} onClick={() => run(() => api.reopen(h.id), 'Reopened: back to Harvesting')}>Reopen harvest</button>
        <button className="ghost" onClick={onDone}>Done editing</button>
      </div>
      <p className="cnote">Bins and pallets above are unlocked while you're editing. Reopen puts it back under Harvesting so the crew can keep logging, then Finish it again.</p>
    </section>
  )
}
