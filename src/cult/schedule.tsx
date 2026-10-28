import { useMemo, useRef, useState } from 'react'
import type { CultApi } from './api'
import { KIND_LABEL, KIND_SHORT, addDays, calcHarvest, fieldName, fmtD, isBiomass, monday, n0, n1, n2, pct, sum, today } from './calc'
import type { Ctx } from './calc'
import type { CultData, Harvest, HarvestKind, HarvestStatus } from './types'
import { Choices, DateIn, F, NumIn, Pick, SaveBar, SelAll, SelBar, SelBox, SelButton, Sheet, StrainList, TextIn, errText, useSel } from './ui'
import type { Flash } from './ui'

type Mode = 'upcoming' | 'all' | 'done'

export function ScheduleTab({ d, c, site, q, onOpen, api, flash, onSaved }: { d: CultData; c: Ctx; site: string | null; q: string; onOpen: (h: Partial<Harvest>) => void
  api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const sel = useSel()
  const bulk = (f: () => Promise<unknown>, m: string) => async () => { try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } }
  const [mode, setMode] = useState<Mode>(d.year === d.currentYear ? 'upcoming' : 'all')
  const [kind, setKind] = useState<'all' | 'flower' | 'biomass'>('all')
  const now = today()
  const ql = q.trim().toLowerCase()
  const rows = useMemo(() => d.harvests.filter(h =>
    (!site || h.site === site) &&
    (kind === 'all' || (kind === 'biomass') === isBiomass(h.kind)) &&
    (mode === 'all' || (mode === 'done' ? h.status === 'done' : h.status === 'planned' && (!h.planned_on || h.planned_on >= addDays(now, -7)))) &&
    (!ql || `${h.strain} ${fieldName(c, h.field_id)} ${h.site} ${h.notes ?? ''}`.toLowerCase().includes(ql))
  ).sort((a, b) => (a.planned_on ?? '9999').localeCompare(b.planned_on ?? '9999') || (a.sched_order ?? 1e9) - (b.sched_order ?? 1e9) || a.site.localeCompare(b.site) || a.strain.localeCompare(b.strain)),
  [d, c, site, mode, kind, ql])
  const weeks = new Map<string, Harvest[]>()
  for (const h of rows) { const w = h.planned_on ? monday(h.planned_on) : 'none'; (weeks.get(w) ?? weeks.set(w, []).get(w)!).push(h) }
  const trialOf = (h: Harvest) => !!(h.planting_id && c.planting.get(h.planting_id)?.trial) || c.field.get(h.field_id ?? -1)?.kind === 'trials'
  // drag a planned harvest to reorder (desktop): it takes the date of the row it's dropped next to, and its place in that day
  const drag = useRef<number | null>(null)
  const [drop, setDrop] = useState<{ id: number; after: boolean } | null>(null)
  const canDrag = mode === 'upcoming' && !sel.on
  async function move(id: number, target: Harvest, after: boolean) {
    const h = rows.find(x => x.id === id)
    if (!h || !target.planned_on || id === target.id) return
    const day = rows.filter(x => x.planned_on === target.planned_on && x.id !== id)
    const at = day.findIndex(x => x.id === target.id) + (after ? 1 : 0)
    day.splice(at, 0, h)
    try {
      for (let i = 0; i < day.length; i++) {
        const x = day[i], o = (i + 1) * 10
        if (x.id === id) await api.save<Harvest>('cult_harvests', { id, planned_on: target.planned_on, sched_order: o })
        else if (x.sched_order !== o) await api.save<Harvest>('cult_harvests', { id: x.id, sched_order: o })
      }
      await onSaved(`${h.strain} moved to ${fmtD(target.planned_on, true)}, #${at + 1} that day`)
    } catch (e) { flash(/sched_order/.test(errText(e)) ? 'Run 088_harvest_order.sql in Supabase first' : errText(e), true) }
  }
  const late = d.harvests.filter(h => h.status === 'planned' && h.planned_on && h.planned_on < now && (!site || h.site === site))

  return (
    <>
      <div className="row toolbar">
        <div className="seg">
          {(['upcoming', 'all', 'done'] as Mode[]).map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'upcoming' ? 'Coming up' : m === 'all' ? 'All' : 'Harvested'}</button>)}
        </div>
        <Pick value={kind} onChange={v => setKind(v ?? 'all')} options={[{ v: 'all', l: 'Flower + biomass' }, { v: 'flower', l: 'Flower only' }, { v: 'biomass', l: 'Biomass only' }]} />
        <SelButton sel={sel} />
        <button className="primary" onClick={() => onOpen({ crop_year: d.year, site: site ?? 'OHR', kind: 'ff', status: 'planned', raw_bins: [] })}>+ Add harvest</button>
      </div>
      {late.length > 0 && mode !== 'done' && <p className="cnote">{late.length} harvest{late.length === 1 ? ' is' : 's are'} past {late.length === 1 ? 'its' : 'their'} date and not logged yet. Open {late.length === 1 ? 'it' : 'them'} to log what came in, move the date or cancel.</p>}
      {!rows.length && <p className="muted">Nothing here. {mode === 'upcoming' ? 'Try All.' : ''}</p>}
      {rows.length > 0 && (
        <div className="cwrap fit">
          <table className="ctable">
            <thead><tr><SelAll sel={sel} ids={rows.map(h => h.id)} /><th>Date</th><th>Strain</th><th className="hide-s">Field</th><th className="hide-s">Type</th><th className="num">Plants</th><th className="num">Lbs</th>
              <th className="num hide-s">Deleaf</th><th className="num hide-s">Buck</th><th className="num hide-s">Dry ice</th><th>Status</th></tr></thead>
            <tbody>
              {[...weeks.entries()].map(([w, hs]) => {
                const ks = hs.map(h => calcHarvest(c, h))
                return [
                  <tr key={w} className="wk"><td colSpan={sel.on ? 3 : 2}>{w === 'none' ? 'No date yet' : `Week of ${fmtD(w)}`}</td><td className="hide-s" /><td className="hide-s" />
                    <td className="num">{n0(sum(hs.filter(h => !isBiomass(h.kind)).map(h => h.plants)))}</td>
                    <td className="num">{n0(sum(ks.map((k, i) => hs[i].kind === 'ff' ? (k.actFF ?? k.estFF) : null)))}</td>
                    <td className="num hide-s" /><td className="num hide-s" /><td className="num hide-s">{n0(sum(ks.map(k => k.dryIce)))}</td><td /></tr>,
                  ...hs.map((h, i) => {
                    const k = ks[i]
                    const lbs = h.kind === 'ff' ? (k.actFF != null ? <><b>{n0(k.actFF)}</b> <span className="muted">✓</span></> : n0(k.estFF))
                      : h.kind === 'dry' ? (k.actRaw != null ? <><b>{n0(k.actRaw)}</b> <span className="muted">raw ✓</span></> : k.estRaw != null ? <span title="raw lbs">{n0(k.estRaw)} raw</span> : '')
                      : k.estBiomass != null ? `${n0(k.estBiomass)} dry` : h.acres ? `${n1(h.acres)} ac` : ''
                    return (
                      <tr key={h.id} className={`tap ${h.status}${drop?.id === h.id ? (drop.after ? ' dropa' : ' dropb') : ''}`} onClick={() => sel.on ? sel.toggle(h.id) : onOpen(h)}
                        draggable={canDrag && h.status === 'planned'}
                        onDragStart={e => { drag.current = h.id; e.dataTransfer.effectAllowed = 'move' }}
                        onDragEnd={() => { drag.current = null; setDrop(null) }}
                        onDragOver={e => { if (!canDrag || drag.current == null || !h.planned_on || h.status !== 'planned') return; e.preventDefault()
                          const r = e.currentTarget.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2
                          if (drop?.id !== h.id || drop.after !== after) setDrop({ id: h.id, after }) }}
                        onDrop={e => { e.preventDefault(); const id = drag.current; const a = drop?.after ?? false; drag.current = null; setDrop(null); if (id != null) move(id, h, a) }}>
                        <SelBox sel={sel} id={h.id} />
                        <td className="nowrap">{mode === 'upcoming' && h.status === 'planned'
                          ? <span onClick={e => e.stopPropagation()}><input type="date" className="cdate" value={h.planned_on ?? ''} aria-label={`${h.strain} harvest date`}
                              onChange={e => { const v = e.target.value || null; if (v !== h.planned_on) bulk(() => api.save<Harvest>('cult_harvests', { id: h.id, planned_on: v }), `${h.strain} moved to ${fmtD(v, true)}`)() }} /></span>
                          : fmtD(h.planned_on, true)}{h.status === 'done' && h.harvested_on && h.harvested_on !== h.planned_on && <div className="muted small">cut {fmtD(h.harvested_on)}</div>}</td>
                        <td>{h.strain}{trialOf(h) && <> <span className="kpill k-trial" title="Trial strain">T</span></>}{(h.day_no ?? 1) > 1 && <> <span className="kpill s-planned">Day {h.day_no}</span></>}
                          {h.planted_strain && h.planted_strain !== h.strain && <div className="muted small">planted as {h.planted_strain}</div>}<div className="show-s"><span className="fpill">{h.site} {fieldName(c, h.field_id)}</span><span className={`kpill k-${h.kind}`}>{KIND_SHORT[h.kind]}</span></div>
                          {h.notes && <div className="muted small">{h.notes.length > 60 ? h.notes.slice(0, 60) + '…' : h.notes}</div>}</td>
                        <td className="hide-s"><span className="fpill">{h.site} {fieldName(c, h.field_id)}</span></td>
                        <td className="hide-s"><span className={`kpill k-${h.kind}`}>{KIND_SHORT[h.kind]}</span></td>
                        <td className="num">{n0(h.status === 'done' ? (h.plants_harvested ?? h.plants) : h.plants)}</td>
                        <td className="num">{lbs}</td>
                        <td className="num hide-s">{k.deleafPeople != null && h.status !== 'done' ? `${k.deleafPeople} ppl` : ''}</td>
                        <td className="num hide-s">{k.buckPeople != null && h.status !== 'done' ? `${k.buckPeople} ppl` : ''}</td>
                        <td className="num hide-s">{h.status !== 'done' ? n0(k.dryIce) : ''}</td>
                        <td><span className={`kpill s-${h.status}`}>{h.status === 'done' ? `Harvested${k.pallets.length ? ` · ${k.pallets.length} pal` : ''}` : h.status === 'planned' ? (h.planned_on && h.planned_on < now ? 'Not logged' : 'Planned') : 'Cancelled'}</span></td>
                      </tr>
                    )
                  }),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
      <SelBar sel={sel} noun="harvest" actions={[
        { label: 'Cancel harvests', run: async ids => bulk(() => api.updateMany('cult_harvests', ids, { status: 'cancelled' }), `${ids.length} cancelled`)() },
        { label: 'Back to planned', run: async ids => bulk(() => api.updateMany('cult_harvests', ids, { status: 'planned' }), `${ids.length} back to planned`)() },
        { label: 'Delete', danger: true, run: async ids => bulk(() => api.removeMany('cult_harvests', ids), `Deleted ${ids.length} harvests`)() }]} />
      <p className="cnote">On a computer, drag a planned harvest up or down to reorder it; dropped next to another day's harvest, it takes that day. Lbs are fresh frozen estimates (plants × lbs/plant) until a harvest is logged, then what came in (✓). People = man-hours ÷ the site's work day. Dry ice is for fresh frozen, ordered the Wednesday the week before.</p>
    </>
  )
}

// ---------- one harvest ----------
const KINDS: { v: HarvestKind; l: string }[] = [{ v: 'ff', l: 'Fresh frozen' }, { v: 'dry', l: 'Dry' }, { v: 'combine', l: 'Combine (biomass)' }, { v: 'strip', l: 'Strip header (biomass)' }]

/** METRC tags count up: 1A406030007AD3D000010001 -> ...0002 */
export function nextTag(tag: string, by = 1) {
  const m = tag.match(/^(.*?)(\d+)$/)
  if (!m) return tag
  const n = (BigInt(m[2]) + BigInt(by)).toString().padStart(m[2].length, '0')
  return m[1] + n
}

export function HarvestSheet({ d, c, harvest, api, flash, onClose, onSaved, onLog }: {
  d: CultData; c: Ctx; harvest: Partial<Harvest>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (msg: string) => Promise<void>; onLog?: (id: number) => void
}) {
  const [h, setH] = useState<Partial<Harvest>>({ raw_bins: [], ...harvest })
  const [busy, setBusy] = useState(false)
  const set = (x: Partial<Harvest>) => setH(v => ({ ...v, ...x }))
  const isNew = h.id == null
  const site = c.site.get(h.site ?? 'OHR')
  const fields = d.fields.filter(f => f.site === h.site && (f.active || f.id === h.field_id))
  const plantings = d.plantings.filter(p => p.site === h.site && (!h.field_id || p.field_id === h.field_id) && (!h.strain || p.strain.toLowerCase() === h.strain.toLowerCase()))
  const k = calcHarvest(c, { raw_bins: [], ...h } as Harvest)
  const logging = h.status === 'done'
  // the strains actually planted this crop year (at this site), so a harvest can only be scheduled for something in the ground
  const planted = [...new Set(d.plantings.filter(p => !h.site || p.site === h.site).map(p => p.strain))].sort((a, b) => a.localeCompare(b))
  const strainNames = planted.length ? planted : d.strains.filter(s => s.active !== false).map(s => s.name)
  const offList = !!h.strain?.trim() && planted.length > 0 && !planted.some(n => n.toLowerCase() === h.strain!.trim().toLowerCase())
  const pallets = !isNew ? (c.palletsOf.get(h.id!) ?? []) : []

  async function save(extra: Partial<Harvest> = {}, msg = 'Saved') {
    const row = { ...h, ...extra }
    if (!row.strain?.trim()) { flash('Pick a strain', true); return }
    if (!row.site) { flash('Pick a site', true); return }
    setBusy(true)
    try {
      if (row.planting_id == null && row.field_id) {
        const p = d.plantings.filter(p => p.site === row.site && p.field_id === row.field_id && p.strain.toLowerCase() === row.strain!.toLowerCase())
          .sort((a, b) => (b.plants ?? 0) - (a.plants ?? 0))[0]
        if (p) row.planting_id = p.id
      }
      if (row.status === 'done' && !row.harvested_on) row.harvested_on = row.planned_on ?? today()
      await api.save<Harvest>('cult_harvests', row)
      await onSaved(msg)
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  async function del() {
    setBusy(true)
    try { await api.remove('cult_harvests', h.id!); await onSaved('Deleted') } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={isNew ? 'Add harvest' : `${h.strain}`} sub={!isNew && <>{h.site} {fieldName(c, h.field_id ?? null)} · {KIND_LABEL[h.kind as HarvestKind]} · {h.status}</>} onClose={onClose} wide>
      <StrainList id="cult-strains" names={strainNames} />
      <div className="grid2">
        <F label="Strain" hint={offList ? <span className="warn-t">not planted at {h.site} this year</span> : 'planted strains'}><TextIn value={h.strain} onChange={v => set({ strain: v ?? '', planting_id: null })} list="cult-strains" autoFocus={isNew} /></F>
        <F label="Site"><Choices value={h.site ?? 'OHR'} options={d.sites.map(s => ({ v: s.code, l: s.code }))} onChange={v => set({ site: v, field_id: null, planting_id: null })} /></F>
        <F label="Field"><Pick value={h.field_id ?? null} blank="Pick a field…" onChange={v => set({ field_id: v, planting_id: null })} options={fields.map(f => ({ v: f.id, l: `${f.code}  (${f.name})` }))} /></F>
        <F label="Type"><Pick value={h.kind ?? 'ff'} onChange={v => set({ kind: v ?? 'ff' })} options={KINDS} /></F>
      </div>
      <div className="grid2">
        <F label={h.kind === 'combine' ? 'Cut date' : 'Harvest date'} hint={k.dryIceOrder ? `dry ice order by ${fmtD(k.dryIceOrder, true)}` : undefined}><DateIn value={h.planned_on} onChange={v => set({ planned_on: v })} /></F>
        {plantings.length > 0 && <F label="Planting"><Pick value={h.planting_id ?? null} blank="Biggest match" onChange={v => set({ planting_id: v })}
          options={plantings.map(p => ({ v: p.id, l: `${fmtD(p.planted_on)} · ${n0(p.plants)} plants${p.batch ? ` · batch ${p.batch}` : ''}` }))} /></F>}
      </div>

      {(h.kind === 'ff' || h.kind === 'dry') && (
        <div className="grid3">
          <F label="Plants"><NumIn value={h.plants} onChange={v => set({ plants: v })} /></F>
          {h.kind === 'ff' && <F label="Lbs / plant" hint="FF"><NumIn value={h.est_lbs_per_plant} onChange={v => set({ est_lbs_per_plant: v })} /></F>}
          {h.kind === 'dry' && <F label="Raw lbs / plant"><NumIn value={h.est_raw_per_plant} onChange={v => set({ est_raw_per_plant: v })} /></F>}
          {h.kind === 'dry' && <F label="Dry conversion" hint={`(${pct(site?.dry_conversion)} default)`}><NumIn value={h.dry_conversion} placeholder={String(site?.dry_conversion ?? 0.075)} onChange={v => set({ dry_conversion: v })} /></F>}
          {h.kind === 'ff' && <F label="Deleaf rate" hint="plants/man-hr"><NumIn value={h.deleaf_rate} placeholder={site?.deleaf_rate != null ? `${site.deleaf_rate} (site)` : ''} onChange={v => set({ deleaf_rate: v })} /></F>}
          {h.kind === 'ff' && <F label="Buck rate" hint="lbs/man-hr"><NumIn value={h.buck_rate} placeholder={site?.buck_rate != null ? `${site.buck_rate} (site)` : ''} onChange={v => set({ buck_rate: v })} /></F>}
        </div>
      )}
      {isBiomass(h.kind as HarvestKind) && (
        <div className="grid3">
          <F label="Acres"><NumIn value={h.acres} onChange={v => set({ acres: v })} /></F>
          <F label="Dry lbs / acre"><NumIn value={h.est_yield_per_acre} onChange={v => set({ est_yield_per_acre: v })} /></F>
          {h.kind === 'combine' && <F label="Days to merge"><NumIn value={h.days_to_merge} onChange={v => set({ days_to_merge: v })} /></F>}
          {h.kind === 'combine' && <F label="Days to harvest"><NumIn value={h.days_to_harvest} onChange={v => set({ days_to_harvest: v })} /></F>}
        </div>
      )}

      <div className="calcbox">
        {h.kind === 'ff' && <><span>Est. fresh frozen</span><b>{n0(k.estFF)} lbs</b>
          <span>Dry ice</span><b>{n0(k.dryIce)} lbs{k.dryIceOrder ? `, order ${fmtD(k.dryIceOrder, true)}` : ''}</b>
          <span>Deleaf (day before)</span><b>{k.deleafHours != null ? `${n1(k.deleafHours)} hrs · ${k.deleafPeople} people` : ''}</b>
          <span>Buck</span><b>{k.buckHours != null ? `${n1(k.buckHours)} hrs · ${k.buckPeople} people` : ''}</b></>}
        {h.kind === 'dry' && <><span>Raw weight</span><b>{n0(k.estRaw)} lbs</b><span>Dry flower</span><b>{n0(k.estDry)} lbs</b><span>Trucks</span><b>{n2(k.trucks)}</b></>}
        {isBiomass(h.kind as HarvestKind) && <><span>Est. dry yield</span><b>{n0(k.estBiomass)} lbs</b>
          {h.kind === 'combine' && <><span>Merge</span><b>{fmtD(k.mergeOn, true)}</b><span>Combine</span><b>{fmtD(k.combineOn, true)}</b></>}</>}
        {k.usedDefaults.length > 0 && <span style={{ gridColumn: '1 / -1' }}>Using the site's default {k.usedDefaults.join(' and ')}.</span>}
      </div>
      <F label="Notes"><textarea value={h.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>

      {!isNew && !logging && h.status !== 'cancelled' && (
        <p className="cnote">Log what comes in on the Harvest screen (raw bins{h.kind === 'ff' ? ', then each pallet' : ''}). This is the plan.</p>
      )}

      {logging && <>
        <div className="row between"><h3>What came in</h3>{onLog && h.id != null && <button className="ghost small" onClick={() => onLog(h.id!)}>Open harvest log ›</button>}</div>
        <div className="calcbox">
          <span>Harvested</span><b>{fmtD(h.harvested_on, true) || '—'}</b>
          <span>Plants harvested</span><b>{n0(h.plants_harvested ?? h.plants)}</b>
          {h.metrc_name && <><span>METRC harvest</span><b>{h.metrc_name}</b></>}
          {!isBiomass(h.kind as HarvestKind) && <><span>Raw</span><b>{n0(h.raw_lbs ?? sum(h.raw_bins ?? []))} lbs{(h.raw_bins ?? []).length ? ` · ${(h.raw_bins ?? []).length} bins` : ''}</b></>}
          {h.kind === 'ff' && <><span>Fresh frozen</span><b>{n0(h.ff_lbs ?? k.palletLbs)} lbs</b></>}
          {h.kind === 'dry' && <><span>Bucked / trim / mold</span><b>{[h.bucked_lbs, h.trim_lbs, h.mold_lbs].map(v => (v == null ? '—' : n0(v))).join(' / ')} lbs</b></>}
        </div>
        <p className="cnote">Results are logged and fixed in the harvest log (fixing a finished harvest is for Production Admins).</p>
        {h.kind === 'ff' && k.actFF != null && k.actPlants ? <p className="cnote">{n2(k.actFF / k.actPlants)} lbs/plant fresh frozen{h.est_lbs_per_plant ? ` (estimate was ${n2(h.est_lbs_per_plant)})` : ''}{k.actRaw ? ` · ${pct(k.actFF / k.actRaw)} of raw` : ''}</p> : null}

        {h.kind === 'ff' && !isNew && <>
          <h3>Pallets <span className="muted">{pallets.length} · {n0(k.palletLbs)} lbs</span></h3>
          {pallets.length > 0 && (
            <div className="cwrap tight"><table className="ctable"><tbody>
              {pallets.map(p => <tr key={p.id}><td><b>{p.code}</b></td><td className="num">{n0(p.og_weight)} lbs</td><td className="mono small">{p.package_tag ?? 'tag pending'}</td>
                <td className="muted small">{p.status === 'in_freezer' ? 'in a freezer' : p.status === 'unslotted' ? 'needs a spot' : p.status}</td></tr>)}
            </tbody></table></div>
          )}
          {!pallets.length && <p className="muted">No pallets logged.</p>}
          <p className="cnote">Pallets are only made on the Harvest screen while harvesting (tag, pallet #, then Staging on the freezer map). To fix a pallet's weight or tag, open it on the freezer map.</p>
        </>}
      </>}

      <SaveBar busy={busy} onCancel={onClose} onDelete={isNew ? undefined : del}
        onSave={() => save({}, isNew ? 'Harvest added' : 'Saved')} />
      {!isNew && <div className="row">
        {h.status !== 'cancelled' && <button className="ghost small" disabled={busy} onClick={() => save({ status: 'cancelled' as HarvestStatus }, 'Harvest cancelled')}>Cancel this harvest</button>}
        {h.status !== 'planned' && <button className="ghost small" disabled={busy} onClick={() => save({ status: 'planned' as HarvestStatus }, 'Back to planned')}>Back to planned</button>}
        {h.updated_by && <span className="muted">Last change {h.updated_by.split('@')[0]}{h.updated_at ? ` · ${new Date(h.updated_at).toLocaleDateString()}` : ''}</span>}
      </div>}
    </Sheet>
  )
}
