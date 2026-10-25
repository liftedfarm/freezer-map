import { addDays, calcHarvest, daySummary, fieldName, fmtD, KIND_SHORT, monday, n0, sum, testRows, today } from './calc'
import type { Ctx } from './calc'
import type { CultData, Harvest } from './types'
import type { CultTab } from './tabs'
import { axisDate, Bars, Card, Cards, DashHead, Empty, Legend, Meter, Spark, Tile, Tiles } from '../dash'

const z = (x: number) => (x ? n0(x) : '')

/** Production Dashboard: what needs doing this week, and how the season is going. */
export function CultDashboard({ d, c, site, onOpen, go }: { d: CultData; c: Ctx; site: string | null; onOpen: (h: Harvest) => void; go: (t: CultTab) => void }) {
  const now = today()
  const live = d.harvests.filter(h => h.status !== 'cancelled' && (!site || h.site === site))
  const sites = d.sites.map(s => s.code).filter(s => !site || s === site)
  const thisYear = d.year === d.currentYear

  // next 7 days, from today
  const days = Array.from({ length: 7 }, (_, i) => addDays(now, i))
  const ds = daySummary(c, live, days)
  const dayTot = days.map(day => {
    const xs = [...(ds.get(day)?.values() ?? [])]
    return { day, plants: sum(xs.map(x => x.plants)), lbs: sum(xs.map(x => x.lbs)), ice: sum(xs.map(x => x.dryIce)),
      people: sum(xs.map(x => x.deleafPeople + x.buckPeople)), deleaf: sum(xs.map(x => x.deleafPeople)), buck: sum(xs.map(x => x.buckPeople)), n: sum(xs.map(x => x.strains.length)) }
  })
  const week = { plants: sum(dayTot.map(x => x.plants)), lbs: sum(dayTot.map(x => x.lbs)), n: sum(dayTot.map(x => x.n)) }
  const peak = dayTot.reduce((a, x) => (x.people > a.people ? x : a), dayTot[0])

  // dry ice ordered on the Wednesday of the week before the harvest
  const wk = monday(now)
  const ice = live.filter(h => h.status === 'planned' && h.kind === 'ff').map(h => ({ h, k: calcHarvest(c, h) }))
    .filter(x => x.k.dryIceOrder && x.k.dryIceOrder >= wk && x.k.dryIceOrder <= addDays(wk, 13) && (x.h.planned_on ?? '') >= now)
    .sort((a, b) => a.k.dryIceOrder!.localeCompare(b.k.dryIceOrder!) || a.h.planned_on!.localeCompare(b.h.planned_on!))
  const iceNow = ice.filter(x => x.k.dryIceOrder! <= addDays(wk, 6))
  const iceBy = new Map<string, { lbs: number; hs: typeof ice }>()
  for (const x of ice) { const g = iceBy.get(x.k.dryIceOrder!) ?? iceBy.set(x.k.dryIceOrder!, { lbs: 0, hs: [] }).get(x.k.dryIceOrder!)!; g.lbs += x.k.dryIce ?? 0; g.hs.push(x) }

  // testing that needs action
  const tr = testRows(d, c, now)
  const act = [...tr.area, ...tr.strain].filter(r => (!site || r.site === site) && (r.status === 'ORDER NOW' || r.status === 'Window passed - sample ASAP'))
    .sort((a, b) => (a.suggested ?? a.first ?? '').localeCompare(b.suggested ?? b.first ?? ''))
  const late = act.filter(r => r.status !== 'ORDER NOW').length

  // harvests whose day has passed but nobody logged them
  const unlogged = live.filter(h => h.status === 'planned' && !h.stage && h.planned_on && h.planned_on < now).sort((a, b) => a.planned_on!.localeCompare(b.planned_on!))

  // today on the Harvest screen
  const ids = new Set(live.map(h => h.id))
  const todayP = d.pallets.filter(p => ids.has(p.harvest_id) && p.harvest_date === now && !p.parent_id && p.status !== 'archived')
  const going = live.filter(h => h.stage === 'harvesting')
  const todayH = live.filter(h => h.planned_on === now && h.status === 'planned' && !h.stage)

  // season: fresh frozen actual vs estimate
  const ff = live.filter(h => h.kind === 'ff')
  const season = sites.map(s => {
    const hs = ff.filter(h => h.site === s)
    const done = hs.filter(h => h.status === 'done')
    const est = sum(hs.map(h => calcHarvest(c, h).estFF))
    const doneEst = sum(done.map(h => calcHarvest(c, h).estFF))
    const act = sum(done.map(h => calcHarvest(c, h).actFF))
    return { s, n: hs.length, done: done.length, est, doneEst, act }
  })
  const S = { n: sum(season.map(x => x.n)), done: sum(season.map(x => x.done)), est: sum(season.map(x => x.est)), doneEst: sum(season.map(x => x.doneEst)), act: sum(season.map(x => x.act)) }
  const vs = S.doneEst ? S.act / S.doneEst - 1 : null

  // season curve: fresh frozen in so far vs the estimate, week by week
  const curve = (() => {
    const pts = ff.map(h => ({ h, k: calcHarvest(c, h) }))
    const days = pts.flatMap(x => [x.h.planned_on, x.h.harvested_on]).filter((x): x is string => !!x).sort()
    if (!days.length) return null
    const wk0 = monday(days[0]), end = monday(days[days.length - 1] > now ? days[days.length - 1] : now)
    const weeks: string[] = []
    for (let w = wk0; w <= end; w = addDays(w, 7)) weeks.push(w)
    const nowI = weeks.findIndex(w => addDays(w, 6) >= now)
    let ea = 0, aa = 0
    const est = weeks.map(w => { const e = addDays(w, 6); ea += sum(pts.filter(x => x.h.planned_on && x.h.planned_on >= w && x.h.planned_on <= e).map(x => x.k.estFF ?? 0)); return ea })
    const act = weeks.map((w, i) => { const e = addDays(w, 6); aa += sum(pts.filter(x => x.h.status === 'done' && (x.h.harvested_on ?? x.h.planned_on) && (x.h.harvested_on ?? x.h.planned_on)! >= w && (x.h.harvested_on ?? x.h.planned_on)! <= e).map(x => x.k.actFF ?? 0)); return nowI >= 0 && i > nowI ? null : aa })
    return { weeks, est, act }
  })()
  const estToDate = curve ? curve.est[Math.max(0, curve.act.reduce<number>((a, v, i) => (v != null ? i : a), 0))] : 0
  return (
    <div className="dash">
      <DashHead title="Dashboard" sub={`Production · ${site ?? 'both sites'} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`} />
      {thisYear && <Tiles>
        <Tile label="Harvest today" value={`${n0(sum(todayP.map(p => p.og_weight)))} lbs`} sub={[todayP.length && `${todayP.length} pallets packed`, going.length && `${going.length} harvesting now`, todayH.length && `${todayH.length} not started`].filter(Boolean).join(' · ') || 'nothing scheduled today'}
          tone={going.length ? 'info' : undefined} onClick={() => go('harvest')} />
        <Tile wide label="Next 7 days" value={`${n0(week.lbs)} lbs`} onClick={() => go('week')} range="Next 7 days"
          kv={week.n ? [[week.n, 'harvests'], [n0(week.plants), 'plants'], ...(peak.people ? [[`${peak.people} people`, fmtD(peak.day, true)] as [string, string]] : [])] : undefined}
          sub={week.n ? undefined : 'no harvests scheduled'}
          chart={week.n ? <Bars items={dayTot.map(x => ({ label: new Date(x.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' }), value: x.lbs, title: `${fmtD(x.day, true)}: ${n0(x.lbs)} lbs · ${x.people} people` }))} /> : undefined}
          foot={iceNow.length ? `Dry ice: order ${n0(sum(iceNow.map(x => x.k.dryIce)))} lbs by ${fmtD(iceNow[0].k.dryIceOrder!, true)}` : 'Week'} />
        <Tile label="Most people needed" value={peak.people || 0} sub={peak.people ? `${fmtD(peak.day, true)} · ${peak.deleaf} deleaf, ${peak.buck} buck` : 'no crews needed'} tone={peak.people ? 'info' : undefined} onClick={() => go('week')} />
        <Tile label="Dry ice to order this week" value={`${n0(sum(iceNow.map(x => x.k.dryIce)))} lbs`} sub={iceNow.length ? `by ${fmtD(iceNow[0].k.dryIceOrder!, true)} for ${iceNow.length} harvests` : 'nothing due'} tone={iceNow.length ? 'heads' : 'ok'} />
        <Tile label="Tests to sample" value={act.length} sub={act.length ? (late ? `${late} past the window` : 'window open now') : 'nothing due'} tone={late ? 'warn' : act.length ? 'heads' : 'ok'} foot={act.length ? 'Sample' : undefined} onClick={() => go('testing')} />
        <Tile label="Harvests not logged" value={unlogged.length} sub={unlogged.length ? `oldest ${fmtD(unlogged[0].planned_on, true)}` : 'all caught up'} tone={unlogged.length ? 'warn' : 'ok'} foot={unlogged.length ? 'Log them' : undefined} onClick={() => go('schedule')} />
        <Tile wide label="Season fresh frozen" value={`${n0(S.act)} lbs`} tone={vs == null ? undefined : vs < -0.1 ? 'heads' : 'ok'} onClick={() => go('yields')}
          range={<><Legend now="Actual" then="Estimate" /><span>Season</span></>}
          kv={[[S.est ? `${Math.round(S.act / S.est * 100)}%` : '–', `of ${n0(S.est)} est.`], ...season.filter(x => x.n).map(x => [`${n0(x.act)}`, x.s] as [string, string]), [`${S.done}/${S.n}`, 'harvests']]}
          chart={curve ? <Spark data={curve.act} ghost={curve.est} labels={[axisDate(curve.weeks[0]), axisDate(curve.weeks[curve.weeks.length - 1])]} /> : undefined}
          foot={S.doneEst ? `${vs! >= 0 ? '+' : ''}${Math.round(vs! * 100)}% vs estimate so far${estToDate ? ` · ${n0(estToDate)} expected by now` : ''}` : 'Yields'} />
      </Tiles>}
      {!thisYear && <p className="muted">Looking at the {d.year} season. The this-week numbers only show for {d.currentYear}.</p>}
      <Cards>
        {thisYear && <Card title="Next 7 days" action="Week" onAction={() => go('week')} wide>
          <div className="cwrap"><table className="ctable">
            <thead><tr><th>Day</th>{!site && <th>Site</th>}<th>Harvesting</th><th className="num">Plants</th><th className="num">Lbs FF</th><th className="num">Dry ice</th><th className="num">Deleaf</th><th className="num">Buck</th></tr></thead>
            <tbody>{days.map(day => {
              const cs = sites.map(s => ({ s, x: ds.get(day)?.get(s) })).filter(v => v.x && (v.x.strains.length || v.x.deleafStrains.length))
              if (!cs.length) return <tr key={day} className="heat0"><td className="nowrap">{fmtD(day, true)}{day === now && ' (today)'}</td><td colSpan={site ? 6 : 7} className="muted">—</td></tr>
              return cs.map((v, i) => (
                <tr key={day + v.s} className={day === now ? 'today' : ''}>
                  <td className="nowrap">{i === 0 ? <>{fmtD(day, true)}{day === now && ' (today)'}</> : ''}</td>{!site && <td>{v.s}</td>}
                  <td>{v.x!.strains.join(', ') || <span className="muted">deleaf for tomorrow</span>}</td>
                  <td className="num">{z(v.x!.plants)}</td><td className="num">{z(v.x!.lbs)}</td><td className="num">{z(v.x!.dryIce)}</td>
                  <td className="num"><b>{v.x!.deleafPeople || ''}</b></td><td className="num"><b>{v.x!.buckPeople || ''}</b></td>
                </tr>
              ))
            })}</tbody>
          </table></div>
          <div className="muted small-note">Deleaf and buck are people for the day. Deleafing happens the day before each fresh frozen harvest.</div>
        </Card>}

        {thisYear && <Card title="Testing: act now" badge={act.length} action="Testing" onAction={() => go('testing')}>
          {act.length ? <div className="dlist">{act.slice(0, 8).map(r => (
            <div key={r.key} className="drow"><span><b>{r.ref}</b><span className="muted"> · first harvest {fmtD(r.first, true)}</span></span>
              <span className={`pill ${r.status === 'ORDER NOW' ? 'warnp' : 'badp'}`}>{r.status === 'ORDER NOW' ? `sample by ${fmtD(r.suggested, true)}` : 'sample ASAP'}</span></div>
          ))}{act.length > 8 && <div className="muted small-note">+{act.length - 8} more</div>}</div> : <Empty>No samples due right now.</Empty>}
        </Card>}

        {thisYear && <Card title="Dry ice orders" action="Week" onAction={() => go('week')}>
          {iceBy.size ? <div className="dlist">{[...iceBy.entries()].map(([on, g]) => (
            <div key={on} className="drow"><span><b>Order {fmtD(on, true)}</b><span className="muted"> · {g.hs.map(x => `${x.h.strain} ${fmtD(x.h.planned_on)}`).join(', ')}</span></span><b>{n0(g.lbs)} lbs</b></div>
          ))}</div> : <Empty>No dry ice orders due in the next two weeks.</Empty>}
        </Card>}

        <Card title="Needs logging" badge={unlogged.length} action="Schedule" onAction={() => go('schedule')}>
          {unlogged.length ? <div className="dlist">{unlogged.slice(0, 8).map(h => (
            <button key={h.id} className="drow click" onClick={() => onOpen(h)}>
              <span><b>{h.strain}</b><span className="muted"> · {h.site} {fieldName(c, h.field_id)} · {KIND_SHORT[h.kind]}</span></span><span className="pill badp">{fmtD(h.planned_on, true)}</span></button>
          ))}{unlogged.length > 8 && <div className="muted small-note">+{unlogged.length - 8} more</div>}</div> : <Empty>Every past harvest has been logged.</Empty>}
        </Card>

        <Card title={`${d.year} season`} action="Yields" onAction={() => go('yields')}>
          <div className="dlist">
            {season.filter(x => x.n).map(x => (
              <Meter key={x.s} label={<><b>{x.s}</b> <span className="muted">{x.done}/{x.n} harvests</span></>}
                right={<>{n0(x.act)} of {n0(x.est)} lbs est.</>} value={x.act} max={Math.max(x.est, x.act)} tone="ok" />
            ))}
            {!season.some(x => x.n) && <Empty>No fresh frozen harvests this season.</Empty>}
            {S.doneEst > 0 && <div className="muted small-note">Harvests done so far came in at {n0(S.act)} lbs against {n0(S.doneEst)} estimated ({vs! >= 0 ? '+' : ''}{Math.round(vs! * 100)}%).</div>}
          </div>
        </Card>
      </Cards>
    </div>
  )
}
