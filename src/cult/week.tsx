import { useState } from 'react'
import { addDays, biomassEvents, calcHarvest, daySummary, fieldName, fmtD, monday, n0, n1, sum, today } from './calc'
import type { Ctx } from './calc'
import type { CultData, Harvest } from './types'
import { Kpis } from './ui'

export function WeekTab({ d, c, site, onOpen }: { d: CultData; c: Ctx; site: string | null; onOpen: (h: Harvest) => void }) {
  const first = () => {
    const now = today()
    if (d.year === d.currentYear) return monday(now)
    const ds = d.harvests.map(h => h.planned_on).filter(Boolean).sort() as string[]
    return monday(ds[0] ?? now)
  }
  const [wk, setWk] = useState(first)
  const days = Array.from({ length: 7 }, (_, i) => addDays(wk, i))
  const sites = d.sites.map(s => s.code).filter(s => !site || s === site)
  const hs = d.harvests.filter(h => !site || h.site === site)
  const sum7 = daySummary(c, hs, [...days, addDays(wk, 7)])
  const cells = (day: string) => sites.map(s => ({ s, x: sum7.get(day)?.get(s) })).filter(v => v.x)
  const bio = biomassEvents(c, hs, d.settings.equipment).filter(e => e.date >= wk && e.date <= days[6])
  // dry ice to order this week (for harvests next week or later)
  const ice = hs.filter(h => h.status === 'planned' && h.kind === 'ff').map(h => ({ h, k: calcHarvest(c, h) }))
    .filter(x => x.k.dryIceOrder && x.k.dryIceOrder >= wk && x.k.dryIceOrder <= days[6])
  const tot = (f: (x: NonNullable<ReturnType<typeof cells>[number]['x']>) => number) => sum(days.flatMap(day => cells(day).map(v => f(v.x!))))
  const now = today()

  return (
    <>
      <div className="cweek">
        <button className="ghost small" onClick={() => setWk(addDays(wk, -7))}>‹ Prev</button>
        <b>Week of {fmtD(wk)} – {fmtD(days[6])}</b>
        <button className="ghost small" onClick={() => setWk(addDays(wk, 7))}>Next ›</button>
        {wk !== monday(now) && <button className="ghost small" onClick={() => setWk(monday(now))}>This week</button>}
      </div>
      <Kpis items={[
        [n0(tot(x => x.plants)), 'plants to harvest'], [n0(tot(x => x.lbs)), 'lbs fresh frozen (est.)'],
        [n0(tot(x => x.dryIce)), 'lbs dry ice'], [n0(tot(x => x.deleafHours)), 'deleaf man-hours'], [n0(tot(x => x.buckHours)), 'buck man-hours'],
      ]} />

      <h3 className="csec">Harvest <span className="muted">by harvest day</span></h3>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Day</th><th>Site</th><th>Strains</th><th className="num">Plants</th><th className="num">Lbs FF (est.)</th><th className="num">Dry ice</th><th className="num">Buck hrs</th><th className="num">People to buck</th></tr></thead>
        <tbody>
          {days.map(day => {
            const cs = cells(day)
            if (!cs.some(v => v.x!.strains.length)) return <tr key={day} className="heat0"><td className="nowrap">{fmtD(day, true)}</td><td colSpan={7} className="muted">—</td></tr>
            return cs.filter(v => v.x!.strains.length).map((v, i) => (
              <tr key={day + v.s}>
                <td className="nowrap">{i === 0 ? fmtD(day, true) : ''}</td>
                <td>{v.s}</td><td>{v.x!.strains.join(', ')}</td><td className="num">{n0(v.x!.plants)}</td><td className="num">{n0(v.x!.lbs)}</td>
                <td className="num">{n0(v.x!.dryIce)}</td><td className="num">{n1(v.x!.buckHours)}</td><td className="num"><b>{v.x!.buckPeople || ''}</b></td>
              </tr>
            ))
          })}
        </tbody>
      </table></div>

      <h3 className="csec">Deleafing <span className="muted">the day before each fresh frozen harvest</span></h3>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Day</th><th>Site</th><th>Strains (harvested next day)</th><th className="num">Plants</th><th className="num">Deleaf hrs</th><th className="num">People</th></tr></thead>
        <tbody>
          {days.map(day => {
            const cs = cells(day).filter(v => v.x!.deleafStrains.length)
            if (!cs.length) return <tr key={day} className="heat0"><td className="nowrap">{fmtD(day, true)}</td><td colSpan={5} className="muted">—</td></tr>
            return cs.map((v, i) => (
              <tr key={day + v.s}>
                <td className="nowrap">{i === 0 ? fmtD(day, true) : ''}</td>
                <td>{v.s}</td><td>{v.x!.deleafStrains.join(', ')}</td><td className="num">{n0(v.x!.deleafPlants)}</td>
                <td className="num">{n1(v.x!.deleafHours)}</td><td className="num"><b>{v.x!.deleafPeople || ''}</b></td>
              </tr>
            ))
          })}
        </tbody>
      </table></div>

      {(bio.length > 0 || hs.some(h => h.kind === 'combine' || h.kind === 'strip')) && <>
        <h3 className="csec">Biomass <span className="muted">cut → merge → combine, and strip header</span></h3>
        {bio.length ? <div className="cwrap"><table className="ctable">
          <thead><tr><th>Day</th><th>Activity</th><th>Equipment</th><th>Strain</th><th>Field</th><th className="num">Acres</th><th className="num">Est. dry lbs</th></tr></thead>
          <tbody>{bio.map((e, i) => (
            <tr key={i} className="tap" onClick={() => onOpen(e.h)}>
              <td className="nowrap">{fmtD(e.date, true)}</td><td>{e.activity}</td><td>{e.equipment}</td><td>{e.h.strain}</td>
              <td><span className="fpill">{e.h.site} {fieldName(c, e.h.field_id)}</span></td><td className="num">{n1(e.acres)}</td><td className="num">{n0(e.lbs)}</td>
            </tr>))}
          </tbody>
          <tfoot><tr className="tot"><td colSpan={5}>Biomass harvested this week (est.)</td><td className="num">{n1(sum(bio.filter(e => e.activity === 'Harvest' || e.activity === 'Strip Harvest').map(e => e.acres)))}</td>
            <td className="num">{n0(sum(bio.map(e => e.lbs)))}</td></tr></tfoot>
        </table></div> : <p className="muted">No biomass work this week.</p>}
      </>}

      <h3 className="csec">Dry ice to order this week <span className="muted">Wednesday the week before each harvest</span></h3>
      {ice.length ? <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>Order by</th><th>For harvest</th><th>Strain</th><th>Field</th><th className="num">Dry ice lbs</th></tr></thead>
        <tbody>{ice.map(({ h, k }) => (
          <tr key={h.id} className="tap" onClick={() => onOpen(h)}><td>{fmtD(k.dryIceOrder, true)}</td><td>{fmtD(h.planned_on, true)}</td><td>{h.strain}</td>
            <td><span className="fpill">{h.site} {fieldName(c, h.field_id)}</span></td><td className="num">{n0(k.dryIce)}</td></tr>))}
        </tbody>
        <tfoot><tr className="tot"><td colSpan={4}>Total</td><td className="num">{n0(sum(ice.map(x => x.k.dryIce)))}</td></tr></tfoot>
      </table></div> : <p className="muted">Nothing to order this week.</p>}
    </>
  )
}
