import { useEffect, useState } from 'react'
import type { CultApi } from './api'
import { avg, calcHarvest, fieldName, fmtD, n0, n1, n2, pct, sum, yieldsByStrain } from './calc'
import type { Ctx } from './calc'
import type { CultData, YieldHist } from './types'
import { Kpis } from './ui'

type Sort = 'lpp' | 'lbs' | 'name' | 'vs'

export function YieldsTab({ d, c, site, q, api }: { d: CultData; c: Ctx; site: string | null; q: string; api: CultApi }) {
  const [sort, setSort] = useState<Sort>('lpp')
  const [hist, setHist] = useState<YieldHist[]>([])
  const [view, setView] = useState<'strain' | 'field' | 'harvest'>('strain')
  useEffect(() => { api.history().then(setHist).catch(() => setHist([])) }, [api])
  const ql = q.trim().toLowerCase()
  const ys = yieldsByStrain(d, c, site).filter(y => !ql || y.strain.toLowerCase().includes(ql))
  const histYears = [...new Set(hist.map(h => h.crop_year))].filter(y => y < d.year).sort((a, b) => b - a).slice(0, 2)
  const hlpp = (strain: string, year: number) => {
    const hs = hist.filter(h => h.crop_year === year && h.strain.toLowerCase() === strain.toLowerCase() && h.plants && h.ff_lbs)
    const p = sum(hs.map(h => h.plants)), l = sum(hs.map(h => h.ff_lbs))
    return p ? l / p : null
  }
  const sorted = [...ys].sort((a, b) => sort === 'name' ? a.strain.localeCompare(b.strain) : sort === 'lbs' ? b.lbs - a.lbs
    : sort === 'vs' ? (b.est ? b.lbs / b.est : 0) - (a.est ? a.lbs / a.est : 0) : b.lbs / b.plants - a.lbs / a.plants)
  const P = sum(ys.map(y => y.plants)), L = sum(ys.map(y => y.lbs)), E = sum(ys.map(y => y.est))

  // by field
  const byField = new Map<string, { plants: number; lbs: number; acres: number | null }>()
  const done = d.harvests.filter(h => h.kind === 'ff' && h.status === 'done' && (!site || h.site === site))
  for (const h of done) {
    const k = calcHarvest(c, h)
    if (k.actFF == null || !k.actPlants) continue
    const key = `${h.site} ${fieldName(c, h.field_id)}`
    const x = byField.get(key) ?? byField.set(key, { plants: 0, lbs: 0, acres: h.field_id != null ? c.field.get(h.field_id)?.acres ?? null : null }).get(key)!
    x.plants += k.actPlants; x.lbs += k.actFF
  }

  return (
    <>
      <Kpis items={[[n0(L), 'lbs fresh frozen harvested'], [n0(P), 'plants'], [n2(P ? L / P : null), 'lbs / plant'], [E ? pct(L / E) : '', 'of the estimate'], [ys.length, 'strains']]} />
      <div className="row toolbar">
        <div className="seg">
          <button className={view === 'strain' ? 'on' : ''} onClick={() => setView('strain')}>By strain</button>
          <button className={view === 'field' ? 'on' : ''} onClick={() => setView('field')}>By field</button>
          <button className={view === 'harvest' ? 'on' : ''} onClick={() => setView('harvest')}>Every harvest</button>
        </div>
        {view === 'strain' && <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
          <option value="lpp">Best lbs / plant</option><option value="lbs">Most lbs</option><option value="vs">Best vs estimate</option><option value="name">Name</option>
        </select>}
      </div>

      {view === 'strain' && <div className="cwrap"><table className="ctable">
        <thead><tr><th>#</th><th>Strain</th><th className="num">Plants</th><th className="num">FF lbs</th><th className="num">Lbs / plant</th><th className="num hide-s">Estimate</th><th className="num">vs est.</th>
          <th className="num hide-s">Days in ground</th><th className="num hide-s">Days flowering</th>{histYears.map(y => <th key={y} className="num">{y} lbs/pl</th>)}</tr></thead>
        <tbody>{sorted.map((y, i) => (
          <tr key={y.strain}><td className="muted">{i + 1}</td><td>{y.strain}{y.harvests > 1 && <span className="muted"> · {y.harvests} harvests</span>}</td>
            <td className="num">{n0(y.plants)}</td><td className="num">{n0(y.lbs)}</td><td className="num"><b>{n2(y.lbs / y.plants)}</b></td>
            <td className="num hide-s">{y.est ? n2(y.est / y.plants) : ''}</td>
            <td className={`num ${y.est && y.lbs < y.est ? 'neg' : 'pos'}`}>{y.est ? pct(y.lbs / y.est) : ''}</td>
            <td className="num hide-s">{n0(avg(y.daysInGround))}</td><td className="num hide-s">{n0(avg(y.daysFlower))}</td>
            {histYears.map(yr => <td key={yr} className="num">{n2(hlpp(y.strain, yr))}</td>)}</tr>
        ))}
        {!sorted.length && <tr><td colSpan={9 + histYears.length} className="muted">No fresh frozen harvests logged for {d.year}.</td></tr>}</tbody>
      </table></div>}

      {view === 'field' && <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>Field</th><th className="num">Plants</th><th className="num">FF lbs</th><th className="num">Lbs / plant</th><th className="num">Field acres</th><th className="num">Lbs / acre</th></tr></thead>
        <tbody>{[...byField.entries()].sort().map(([k, x]) => (
          <tr key={k}><td><span className="fpill">{k}</span></td><td className="num">{n0(x.plants)}</td><td className="num">{n0(x.lbs)}</td><td className="num"><b>{n2(x.lbs / x.plants)}</b></td>
            <td className="num">{n1(x.acres)}</td><td className="num">{x.acres ? n0(x.lbs / x.acres) : ''}</td></tr>))}</tbody>
      </table></div>}

      {view === 'harvest' && <div className="cwrap"><table className="ctable">
        <thead><tr><th>Harvested</th><th>Strain</th><th>Field</th><th className="num">Plants</th><th className="num">Raw lbs</th><th className="num">FF lbs</th><th className="num">FF / raw</th><th className="num">Lbs / plant</th><th className="num">Pallets</th></tr></thead>
        <tbody>{done.filter(h => !ql || h.strain.toLowerCase().includes(ql)).sort((a, b) => (a.harvested_on ?? '').localeCompare(b.harvested_on ?? '')).map(h => {
          const k = calcHarvest(c, h)
          return <tr key={h.id}><td className="nowrap">{fmtD(h.harvested_on, true)}</td><td>{h.strain}</td><td><span className="fpill">{h.site} {fieldName(c, h.field_id)}</span></td>
            <td className="num">{n0(k.actPlants)}</td><td className="num">{n0(k.actRaw)}</td><td className="num">{n0(k.actFF)}</td>
            <td className="num">{k.actFF && k.actRaw ? pct(k.actFF / k.actRaw) : ''}</td><td className="num"><b>{n2(k.actLbsPerPlant)}</b></td><td className="num">{k.pallets.length || ''}</td></tr>
        })}</tbody>
      </table></div>}
      <p className="cnote">Fresh frozen lbs are the packaged weight (Harvest METRC, or the sum of the harvest's pallets). Days in ground and days flowering need the planting date and first flower on the planting.</p>
    </>
  )
}
