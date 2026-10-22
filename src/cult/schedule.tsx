import { useMemo, useState } from 'react'
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
  ).sort((a, b) => (a.planned_on ?? '9999').localeCompare(b.planned_on ?? '9999') || a.site.localeCompare(b.site) || a.strain.localeCompare(b.strain)),
  [d, c, site, mode, kind, ql])
  const weeks = new Map<string, Harvest[]>()
  for (const h of rows) { const w = h.planned_on ? monday(h.planned_on) : 'none'; (weeks.get(w) ?? weeks.set(w, []).get(w)!).push(h) }
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
                      <tr key={h.id} className={`tap ${h.status}`} onClick={() => sel.on ? sel.toggle(h.id) : onOpen(h)}>
                        <SelBox sel={sel} id={h.id} />
                        <td className="nowrap">{fmtD(h.planned_on, true)}{h.status === 'done' && h.harvested_on && h.harvested_on !== h.planned_on && <div className="muted small">cut {fmtD(h.harvested_on)}</div>}</td>
                        <td>{h.strain}<div className="show-s"><span className="fpill">{h.site} {fieldName(c, h.field_id)}</span><span className={`kpill k-${h.kind}`}>{KIND_SHORT[h.kind]}</span></div>
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
      <p className="cnote">Lbs are fresh frozen estimates (plants × lbs/plant) until a harvest is logged, then what came in (✓). People = man-hours ÷ the site's work day. Dry ice is for fresh frozen, ordered the Wednesday the week before.</p>
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

export function HarvestSheet({ d, c, harvest, api, flash, onClose, onSaved }: {
  d: CultData; c: Ctx; harvest: Partial<Harvest>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (msg: string) => Promise<void>
}) {
  const [h, setH] = useState<Partial<Harvest>>({ raw_bins: [], ...harvest })
  const [busy, setBusy] = useState(false)
  const [bin, setBin] = useState('')
  const [rows, setRows] = useState<{ lbs: string; tag: string; code: string }[]>([])
  const [bulk, setBulk] = useState({ n: '', lbs: '' })
  const set = (x: Partial<Harvest>) => setH(v => ({ ...v, ...x }))
  const isNew = h.id == null
  const site = c.site.get(h.site ?? 'OHR')
  const fields = d.fields.filter(f => f.site === h.site && (f.active || f.id === h.field_id))
  const plantings = d.plantings.filter(p => p.site === h.site && (!h.field_id || p.field_id === h.field_id) && (!h.strain || p.strain.toLowerCase() === h.strain.toLowerCase()))
  const k = calcHarvest(c, { raw_bins: [], ...h } as Harvest)
  const logging = h.status === 'done'
  const strainNames = d.strains.filter(s => s.active !== false).map(s => s.name)
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
  function addBins(text: string) {
    const xs = text.split(/[\s,;]+/).map(Number).filter(x => isFinite(x) && x > 0)
    if (xs.length) set({ raw_bins: [...(h.raw_bins ?? []), ...xs] })
    setBin('')
  }
  async function makePallets() {
    const good = rows.filter(r => Number(r.lbs) > 0)
    if (!good.length) { flash('Enter a weight for each pallet', true); return }
    setBusy(true)
    try {
      // save the harvest first so the pallets get today's numbers
      await api.save<Harvest>('cult_harvests', { ...h, status: 'done', harvested_on: h.harvested_on ?? today() })
      const codes = await api.addPallets(h.id!, good.map(r => ({ lbs: Number(r.lbs), tag: r.tag.trim(), code: r.code.trim() || undefined })))
      setRows([])
      await onSaved(`${codes.length} pallet${codes.length === 1 ? '' : 's'} added: ${codes.join(', ')}. They're in Review as "Needs a spot".`)
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }

  return (
    <Sheet title={isNew ? 'Add harvest' : `${h.strain}`} sub={!isNew && <>{h.site} {fieldName(c, h.field_id ?? null)} · {KIND_LABEL[h.kind as HarvestKind]} · {h.status}</>} onClose={onClose} wide>
      <StrainList id="cult-strains" names={strainNames} />
      <div className="grid2">
        <F label="Strain"><TextIn value={h.strain} onChange={v => set({ strain: v ?? '' })} list="cult-strains" autoFocus={isNew} /></F>
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
        <h3>What came in</h3>
        <div className="grid3">
          <F label="Harvested on"><DateIn value={h.harvested_on} onChange={v => set({ harvested_on: v })} /></F>
          <F label="Plants harvested"><NumIn value={h.plants_harvested} onChange={v => set({ plants_harvested: v })} /></F>
          <F label="METRC harvest name"><TextIn value={h.metrc_name} onChange={v => set({ metrc_name: v })} /></F>
        </div>
        {!isBiomass(h.kind as HarvestKind) && (
          <F label="Raw weights" hint={`${(h.raw_bins ?? []).length} bins · ${n1(sum(h.raw_bins ?? []))} lbs`}>
            <div className="row">
              <input inputMode="decimal" placeholder="Bin weight, Enter to add (or paste a column)" value={bin} onChange={e => setBin(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addBins(bin) } }}
                onPaste={e => { const t = e.clipboardData.getData('text'); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); addBins(t) } }} />
              <button className="ghost small" onClick={() => addBins(bin)}>Add</button>
            </div>
            {(h.raw_bins ?? []).length > 0 && <div className="binrow">{(h.raw_bins ?? []).map((b, i) => <span key={i}>{b}<a onClick={() => set({ raw_bins: (h.raw_bins ?? []).filter((_, j) => j !== i) })}>×</a></span>)}</div>}
          </F>
        )}
        <div className="grid3">
          <F label="Raw lbs" hint={(h.raw_bins ?? []).length ? '(blank = bins)' : ''}><NumIn value={h.raw_lbs} placeholder={(h.raw_bins ?? []).length ? n1(sum(h.raw_bins ?? [])) : ''} onChange={v => set({ raw_lbs: v })} /></F>
          {h.kind === 'ff' && <F label="Fresh frozen lbs" hint={pallets.length ? '(blank = pallets)' : ''}><NumIn value={h.ff_lbs} placeholder={pallets.length ? n1(k.palletLbs) : ''} onChange={v => set({ ff_lbs: v })} /></F>}
          {h.kind === 'dry' && <><F label="Bucked lbs"><NumIn value={h.bucked_lbs} onChange={v => set({ bucked_lbs: v })} /></F>
            <F label="Trim lbs"><NumIn value={h.trim_lbs} onChange={v => set({ trim_lbs: v })} /></F>
            <F label="Mold lbs"><NumIn value={h.mold_lbs} onChange={v => set({ mold_lbs: v })} /></F></>}
        </div>
        {h.kind === 'ff' && k.actFF != null && k.actPlants ? <p className="cnote">{n2(k.actFF / k.actPlants)} lbs/plant fresh frozen{h.est_lbs_per_plant ? ` (estimate was ${n2(h.est_lbs_per_plant)})` : ''}{k.actRaw ? ` · ${pct(k.actFF / k.actRaw)} of raw` : ''}</p> : null}

        {h.kind === 'ff' && !isNew && <>
          <h3>Pallets <span className="muted">{pallets.length} · {n0(k.palletLbs)} lbs</span></h3>
          {pallets.length > 0 && (
            <div className="cwrap tight"><table className="ctable"><tbody>
              {pallets.map(p => <tr key={p.id}><td><b>{p.code}</b></td><td className="num">{n0(p.og_weight)} lbs</td><td className="mono small">{p.package_tag ?? 'tag pending'}</td>
                <td className="muted small">{p.status === 'in_freezer' ? 'in a freezer' : p.status === 'unslotted' ? 'needs a spot' : p.status}</td></tr>)}
            </tbody></table></div>
          )}
          <div className="row">
            <input className="grow-in" style={{ width: 70 }} inputMode="numeric" placeholder="How many" value={bulk.n} onChange={e => setBulk({ ...bulk, n: e.target.value })} />
            <span className="muted">×</span>
            <input style={{ width: 90 }} inputMode="decimal" placeholder="lbs each" value={bulk.lbs} onChange={e => setBulk({ ...bulk, lbs: e.target.value })} />
            <button className="ghost small" onClick={() => { const n = Math.min(60, Number(bulk.n) || 1); setRows([...rows, ...Array.from({ length: n }, () => ({ lbs: bulk.lbs, tag: '', code: '' }))]) }}>Add pallets</button>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="palrow">
              <input inputMode="decimal" placeholder="lbs" value={r.lbs} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, lbs: e.target.value } : x))} />
              <input placeholder="METRC tag (blank = pending)" value={r.tag} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, tag: e.target.value.toUpperCase() } : x))} />
              <button className="ghost small" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {rows.length > 0 && <div className="row">
            {rows[0].tag && rows.length > 1 && <button className="ghost small" onClick={() => setRows(rows.map((x, j) => ({ ...x, tag: nextTag(rows[0].tag, j) })))}>Number the tags in order from the first</button>}
            <button className="primary" disabled={busy} onClick={makePallets}>Create {rows.length} pallet{rows.length === 1 ? '' : 's'} ({n0(sum(rows.map(r => Number(r.lbs) || 0)))} lbs)</button>
          </div>}
          <p className="cnote">New pallets get the next {site?.pallet_prefix ?? 'P'} number{c.field.get(h.field_id ?? -1)?.kind === 'trials' ? ' (T for the trials field)' : ''} and show up in the freezer app under Review as "Needs a spot".</p>
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
