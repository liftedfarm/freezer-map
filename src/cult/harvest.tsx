import { useEffect, useMemo, useRef, useState } from 'react'
import type { CultApi } from './api'
import { calcHarvest, fieldName, fmtD, KIND_LABEL, n0, n1, sum, today } from './calc'
import type { Ctx } from './calc'
import type { CWeight, CultData, Harvest } from './types'
import { DateIn, errText, NumIn } from './ui'
import type { Flash } from './ui'
import { ScanButton } from '../scan'

// Production > Harvest: log a harvest as it happens. Built for a phone in the field or the pack shed.
// Fresh frozen: raw bins, then each pallet as it's made (it lands in Staging on the freezer map right away).
// Dry flower: raw weight only (bucking and trimming belong to Processing later).
// Combine biomass: each tote's dry weight. Stripper header: log the cut, it dries, then enter the dry weight.

const STEP: Record<string, string> = { ff: 'Raw bins, then pallets', dry: 'Raw weight', combine: 'Dry weight per tote', strip: 'Cut, dry, then dry weight' }

export function HarvestTab({ d, c, site, api, flash, onSaved }: { d: CultData; c: Ctx; site: string | null; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [day, setDay] = useState(today())
  const [openId, setOpenId] = useState<number | null>(null)
  const hs = d.harvests.filter(h => (!site || h.site === site) && h.status !== 'cancelled')
  const open = hs.find(h => h.id === openId)
  if (open) return <LogPage h={open} d={d} c={c} api={api} flash={flash} onSaved={onSaved} back={() => setOpenId(null)} />

  const now = today()
  const going = hs.filter(h => h.stage === 'harvesting')
  const drying = hs.filter(h => h.stage === 'drying')
  const planned = hs.filter(h => h.status === 'planned' && !h.stage && h.planned_on === day)
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
        {planned.length ? planned.map(h => card(h)) : <p className="muted">Nothing scheduled{site ? ` at ${site}` : ''}. Pick another day, or add the harvest on the Schedule.</p>}</section>
      {drying.length > 0 && <section><h3 className="csec">Drying</h3>{drying.map(h => card(h, `Cut ${fmtD(h.harvested_on, true)} · enter the dry weight when it's out`))}</section>}
      {behind.length > 0 && <section><h3 className="csec">Not logged yet <span className="muted">from earlier days</span></h3>{behind.map(h => card(h, `Scheduled ${fmtD(h.planned_on, true)}`))}</section>}
      {done.length > 0 && <section><h3 className="csec">Finished {day === now ? 'today' : fmtD(day, true)}</h3>{done.map(h => card(h, 'Done'))}</section>}
    </div>
  )
}

function LogPage({ h, d, c, api, flash, onSaved, back }: { h: Harvest; d: CultData; c: Ctx; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void>; back: () => void }) {
  const [ws, setWs] = useState<CWeight[] | null>(null)
  const [busy, setBusy] = useState(false)
  const k = calcHarvest(c, h)
  const loadW = () => api.weights(h.id).then(setWs).catch(e => { setWs([]); flash(errText(e), true) })
  useEffect(() => { loadW() }, [h.id])
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await Promise.all([loadW(), onSaved(ok)]) } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const raw = (ws ?? []).filter(w => w.kind === 'raw'), totes = (ws ?? []).filter(w => w.kind === 'tote'), dry = (ws ?? []).filter(w => w.kind === 'dry')
  const pallets = k.pallets.filter(p => p.status !== 'archived').sort((a, b) => a.id - b.id)
  const done = h.status === 'done'
  return (
    <div className="hlog">
      <button className="ghost small hback" onClick={back}>‹ Harvest</button>
      <h2>{h.strain} <span className="muted">{h.site} {fieldName(c, h.field_id)}</span></h2>
      <div className="row wrap"><span className={`kpill k-${h.kind}`}>{KIND_LABEL[h.kind]}</span>
        <span className="muted">{done ? `Finished · harvested ${fmtD(h.harvested_on, true)}` : h.stage === 'drying' ? `Drying since ${fmtD(h.harvested_on, true)}` : h.stage === 'harvesting' ? `Harvesting · started ${fmtD(h.harvested_on, true)}` : `Scheduled ${fmtD(h.planned_on, true)}`}
          {h.plants ? ` · ${n0(h.plants)} plants` : ''}{h.acres ? ` · ${n1(h.acres)} acres` : ''}</span></div>

      {h.kind === 'ff' && <>
        <div className="ckpis hk">
          <div><b>{n0(k.palletLbs)}</b><span>lbs packed{k.estFF ? ` of ~${n0(k.estFF)}` : ''}</span></div>
          <div><b>{pallets.length}</b><span>pallets</span></div>
          <div><b>{n0(sum(raw.map(w => w.lbs)) || sum(h.raw_bins))}</b><span>lbs raw ({raw.length || h.raw_bins.length} bin{(raw.length || h.raw_bins.length) === 1 ? '' : 's'})</span></div>
          <div><b>{k.palletLbs && (h.plants_harvested ?? h.plants) ? n1(k.palletLbs / (h.plants_harvested ?? h.plants)!) : ''}</b><span>lbs / plant{h.est_lbs_per_plant ? ` (est ${n1(h.est_lbs_per_plant)})` : ''}</span></div>
        </div>
        <Weights title="Raw bins" kind="raw" rows={raw} busy={busy} done={done} unit="bin" onAdd={lbs => run(() => api.logWeight(h.id, 'raw', lbs), `Bin ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')} />
        <PalletLog h={h} api={api} busy={busy} done={done} pallets={pallets} run={run} />
      </>}

      {h.kind === 'dry' && <>
        <div className="ckpis hk"><div><b>{n0(sum(raw.map(w => w.lbs)) || sum(h.raw_bins))}</b><span>lbs raw{k.estRaw ? ` of ~${n0(k.estRaw)}` : ''}</span></div><div><b>{raw.length || h.raw_bins.length}</b><span>bin{(raw.length || h.raw_bins.length) === 1 ? '' : 's'}</span></div></div>
        <Weights title="Raw weight" kind="raw" rows={raw} busy={busy} done={done} unit="bin" onAdd={lbs => run(() => api.logWeight(h.id, 'raw', lbs), `Bin ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')} />
        <p className="cnote">Only the raw weight is logged here. Bucking and trimming will be logged in Processing.</p>
      </>}

      {h.kind === 'combine' && <>
        <div className="ckpis hk"><div><b>{n0(sum(totes.map(w => w.lbs)))}</b><span>lbs dry{k.estBiomass ? ` of ~${n0(k.estBiomass)}` : ''}</span></div><div><b>{totes.length}</b><span>totes</span></div></div>
        <Weights title="Totes" kind="tote" rows={totes} busy={busy} done={done} unit="tote" withTag
          onAdd={(lbs, tag) => run(() => api.logWeight(h.id, 'tote', lbs, tag), `Tote ${n0(lbs)} lbs`)} onRemove={id => run(() => api.removeWeight(id), 'Removed')} />
      </>}

      {h.kind === 'strip' && <StripLog h={h} api={api} busy={busy} done={done} dry={dry} run={run} estDry={k.estBiomass} />}

      {!done && (h.kind !== 'strip' || h.stage === 'drying') && <Finish h={h} busy={busy} run={run} api={api} back={back}
        ready={h.kind === 'ff' ? pallets.length > 0 : h.kind === 'dry' ? raw.length > 0 || h.raw_bins.length > 0 : h.kind === 'combine' ? totes.length > 0 : dry.length > 0} />}
      {done && <p className="cnote">Finished. To change anything, open the harvest on the Schedule.</p>}
      {d.year !== d.currentYear && <p className="cnote">This is the {d.year} season.</p>}
    </div>
  )
}

/** a list of weights with a quick add box (Enter adds) */
function Weights({ title, kind, rows, busy, done, unit, withTag, onAdd, onRemove }: {
  title: string; kind: string; rows: CWeight[]; busy: boolean; done: boolean; unit: string; withTag?: boolean
  onAdd: (lbs: number, tag: string | null) => void; onRemove: (id: number) => void
}) {
  const [v, setV] = useState('')
  const [tag, setTag] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const add = () => { const n = Number(v); if (!(n > 0)) return; onAdd(n, tag.trim() || null); setV(''); setTag(''); ref.current?.focus() }
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>{title} <span className="muted">{rows.length} · {n0(sum(rows.map(r => r.lbs)))} lbs</span></h3></div>
      {!done && <div className="hadd">
        <input ref={ref} type="number" inputMode="decimal" placeholder={`${unit} lbs`} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} data-kind={kind} />
        {withTag && <><input placeholder="Tag (optional)" value={tag} onChange={e => setTag(e.target.value)} /><ScanButton onScan={setTag} disabled={busy} /></>}
        <button className="primary" disabled={busy || !(Number(v) > 0)} onClick={add}>Add {unit}</button>
      </div>}
      {rows.length > 0 && <div className="binrow">{rows.map((r, i) => <span key={r.id} title={r.tag ?? ''}>{i + 1}: {n1(r.lbs)}{r.tag ? ` · ${r.tag.slice(-6)}` : ''}{!done && <a onClick={() => !busy && onRemove(r.id)}>×</a>}</span>)}</div>}
    </section>
  )
}

/** fresh frozen pallets, one at a time */
function PalletLog({ h, api, busy, done, pallets, run }: {
  h: Harvest; api: CultApi; busy: boolean; done: boolean; pallets: { id: number; code: string; og_weight: number | null; package_tag: string | null; boxes?: number | null; partial?: boolean }[]
  run: (f: () => Promise<unknown>, ok: string) => Promise<void>
}) {
  const last = pallets[pallets.length - 1]
  const [lbs, setLbs] = useState<number | null>(650)
  const [boxes, setBoxes] = useState<number | null>(last?.boxes ?? null)
  const [tag, setTag] = useState('')
  const [partial, setPartial] = useState(false)
  const [pool, setPool] = useState<string[]>([])
  useEffect(() => { api.nextTags(h.site).then(setPool).catch(() => setPool([])) }, [h.site, pallets.length])
  const used = useMemo(() => new Set(pallets.map(p => p.package_tag)), [pallets])
  const suggested = pool.find(t => !used.has(t)) ?? ''
  useEffect(() => { setTag(suggested) }, [suggested])
  async function save() {
    await run(() => api.addPallets(h.id, [{ lbs: lbs!, tag: tag.trim(), boxes, partial }]), `Pallet saved: ${n0(lbs!)} lbs, in Staging`)
    setPartial(false); setLbs(650)
  }
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Pallets <span className="muted">{pallets.length} · {n0(sum(pallets.map(p => p.og_weight)))} lbs</span></h3></div>
      {!done && <div className="hpal">
        <label><span>Weight</span><NumIn value={lbs} onChange={setLbs} /></label>
        <label><span>Boxes</span><NumIn value={boxes} onChange={setBoxes} /></label>
        <label className="htag"><span>METRC tag {suggested && tag === suggested ? <em className="muted">(next in range)</em> : !tag ? <em className="muted">(blank = pending)</em> : null}</span>
          <div className="row"><input value={tag} onChange={e => setTag(e.target.value.toUpperCase())} placeholder="Scan or type" /><ScanButton onScan={setTag} disabled={busy} /></div></label>
        <label className="check"><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} /> <span>Last pallet (partial)</span></label>
        <button className="primary" disabled={busy || !(Number(lbs) > 0)} onClick={save}>Save pallet</button>
        <p className="cnote">Saved pallets go into {h.site} Staging on the freezer map right away, so Distribution can move them into freezers. Extra boxes on top count in the pallet weight.</p>
      </div>}
      {pallets.length > 0 && <div className="dlist">{[...pallets].reverse().map(p => (
        <div key={p.id} className="drow"><span className="grow"><b>{p.code}</b> <span className="muted">{p.boxes ? `${p.boxes} boxes · ` : ''}{p.package_tag ? p.package_tag.slice(-8) : 'tag pending'}{p.partial ? ' · partial' : ''}</span></span>
          <b>{n0(Number(p.og_weight))} lbs</b>{!done && <button className="ghost small" disabled={busy} title="Logged by mistake" onClick={() => run(() => api.removePallet(p.id), `${p.code} removed`)}>✕</button>}</div>))}</div>}
    </section>
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

function Finish({ h, busy, run, api, back, ready }: { h: Harvest; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; api: CultApi; back: () => void; ready: boolean }) {
  const [plants, setPlants] = useState<number | null>(h.plants_harvested ?? h.plants)
  const [notes, setNotes] = useState('')
  const [open, setOpen] = useState(false)
  if (!open) return <div className="row hfin"><button className="ghost" disabled={busy || !ready} onClick={() => setOpen(true)}>Finish harvest…</button>{!ready && <span className="muted">Log something first.</span>}</div>
  return (
    <section className="dcard">
      <div className="dcard-h"><h3>Finish harvest</h3></div>
      <div className="hpal">
        {(h.kind === 'ff' || h.kind === 'dry') && <label><span>Plants harvested</span><NumIn value={plants} onChange={setPlants} /></label>}
        <label className="htag"><span>Notes</span><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" /></label>
        <div className="row"><button className="ghost" onClick={() => setOpen(false)}>Not yet</button>
          <button className="primary" disabled={busy} onClick={() => run(() => api.finish(h.id, plants, notes || null), 'Harvest finished').then(back)}>Finish</button></div>
      </div>
    </section>
  )
}
