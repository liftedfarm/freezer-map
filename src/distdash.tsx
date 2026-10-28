import { useEffect, useMemo, useState } from 'react'
import type { Backend } from './api'
import { axisDate, Card, Cards, DashHead, lastDays, Legend, Meter, projectTo, Spark, Tile, Tiles, ymd } from './dash'
import type { Freezer, InvEvent, Load, LoadItem, LoadStop, Pallet, Site, Slot, Snapshot } from './types'

// Distribution Dashboard (and the old summary pieces it's built from): the workbook's Summary tab, plus loads, review and activity.

export interface SideCtx {
  snap: Snapshot
  site: Site
  slotsOf: (freezerId: number) => Slot[]
  inSlot: (slotId: number) => Pallet[]          // top-level pallets in a slot
  weight: (p: Pallet) => number
  onLoad: (p: Pallet) => boolean                // planned/loaded on an open load
  freezerOf: (slotId: number) => Freezer | undefined
  slot: (slotId: number) => Slot | undefined
  describe: (e: InvEvent) => string
  reviewCounts: { spot: number; tags: number; issues: number }
  backend: Backend
  openFreezer: (id: number) => void
  openPallet: (id: number) => void
  openLoad: (id: number) => void
  goReview: () => void
  goActivity: () => void
  goTransit: () => void
  searchFor: (q: string) => void
}

const n0 = (n: number) => Math.round(n).toLocaleString()

// ---------- Site Overview (workbook rows 5 to 15) ----------

export function Overview({ ctx }: { ctx: SideCtx }) {
  const stats = useMemo(() => {
    const calc = (sites: Site[]) => {
      const fz = ctx.snap.freezers.filter(f => sites.includes(f.site) && (f.kind ?? 'freezer') === 'freezer' && f.active !== false)
      let open = 0, withOpen = 0, pallets = 0, w = 0
      for (const f of fz) {
        const slots = ctx.slotsOf(f.id)
        const empty = f.status === 'Not Working' ? 0 : slots.filter(s => ctx.inSlot(s.id).length === 0).length
        open += empty; if (empty > 0) withOpen++
        for (const s of slots) for (const p of ctx.inSlot(s.id)) { pallets++; w += ctx.weight(p) }
      }
      const by = (st: string) => fz.filter(f => f.status === st).length
      const avg = pallets ? w / pallets : 0
      return { total: fz.length, on: by('On'), off: by('Off'), att: by('Needs Attention'), dead: by('Not Working'), withOpen, open, pallets, w, avg, est: open * avg }
    }
    return { OHR: calc(['OHR']), GVR: calc(['GVR']), All: calc(['OHR', 'GVR']) }
  }, [ctx.snap])
  const rows: [string, (s: typeof stats.OHR) => string, string?][] = [
    ['Total freezers', s => String(s.total)],
    ['On', s => String(s.on)],
    ['Off', s => String(s.off)],
    ['Needs attention', s => String(s.att), 'att'],
    ['Not working', s => String(s.dead), 'dead'],
    ['Freezers w/ open spaces', s => String(s.withOpen)],
    ['Open spaces', s => String(s.open)],
    ['Pallets stored', s => String(s.pallets)],
    ['Total weight (lbs)', s => n0(s.w)],
    ['Avg lbs / pallet', s => n0(s.avg)],
    ['Est. open space (lbs)', s => n0(s.est)],
  ]
  return (
    <table className="side-table">
      <thead><tr><th /><th>OHR</th><th>GVR</th><th>Both</th></tr></thead>
      <tbody>
        {rows.map(([label, f, cls]) => (
          <tr key={label} className={cls === 'att' && stats.All.att ? 'att' : cls === 'dead' && stats.All.dead ? 'dead' : ''}>
            <td>{label}</td><td>{f(stats.OHR)}</td><td>{f(stats.GVR)}</td><td><b>{f(stats.All)}</b></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------- Loads ----------

export function Loads({ ctx, loads }: { ctx: SideCtx; loads: Load[] }) {
  const st: Record<string, string> = { planning: 'Planning', loading: 'Loading', in_transit: 'In transit' }
  const stops = ctx.snap.stops ?? [], items = ctx.snap.items ?? []
  return (
    <div className="side-list">
      {loads.length === 0 && <div className="muted small-note">No active loads.</div>}
      {loads.map(l => {
        const v = ctx.snap.vehicles?.find(x => x.id === l.vehicle_id)
        const its: LoadItem[] = items.filter(i => i.load_id === l.id)
        const sts: LoadStop[] = stops.filter(s => s.load_id === l.id).sort((a, b) => a.seq - b.seq)
        return (
          <button key={l.id} className="side-load" onClick={() => ctx.openLoad(l.id)}>
            <div className="row between"><b>{l.code}</b><span className={`pill s-${l.status}`}>{st[l.status]}</span></div>
            <div className="muted">{v?.name} · {its.filter(i => i.loaded).length}/{its.length} loaded · {sts.map(s => ctx.snap.customers?.find(c => c.id === s.customer_id)?.name).join(' → ')}</div>
          </button>
        )
      })}
      <button className="ghost small" onClick={ctx.goTransit}>All loads</button>
    </div>
  )
}

// ---------- Activity ----------

export function Activity({ ctx }: { ctx: SideCtx }) {
  const [evs, setEvs] = useState<InvEvent[] | null>(null)
  // Distribution's own work only (Processing and payroll have their own Activity)
  useEffect(() => { ctx.backend.recentEvents(40).then(es => setEvs(es.filter(e => !/^(proc_|pay_|acct_|cult_log|nursery)/.test(e.type)).slice(0, 10))).catch(() => setEvs([])) }, [ctx.snap])
  return (
    <div className="side-list">
      {evs === null && <div className="muted small-note">Loading…</div>}
      {evs?.length === 0 && <div className="muted small-note">Nothing yet.</div>}
      {evs?.map(e => (
        <div key={e.id} className="side-ev">
          <div>{ctx.describe(e)}</div>
          <div className="muted">{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {(e.user_email ?? '').split('@')[0]}</div>
        </div>
      ))}
      <button className="ghost small" onClick={ctx.goActivity}>All activity</button>
    </div>
  )
}

// ---------- Distribution Dashboard ----------

export interface SalesNums { orders: number; requests: number; isAdmin: boolean; go: () => void }

export function DistDashboard({ ctx, sales, goMap, fulfill, staged }: { ctx: SideCtx; sales?: SalesNums; goMap: () => void; fulfill?: { open: number; ready: number; waiting: number; go: () => void }; staged?: { n: number; lbs: number; sites: string[]; go: () => void } }) {
  const fz = ctx.snap.freezers.filter(f => (f.kind ?? 'freezer') === 'freezer' && f.active !== false)
  const per = useMemo(() => {
    const out = new Map<number, { slots: number; used: number; pallets: number; lbs: number; open: number }>()
    for (const f of fz) {
      const slots = ctx.slotsOf(f.id)
      let used = 0, pallets = 0, w = 0
      for (const s of slots) { const ps = ctx.inSlot(s.id); if (ps.length) used++; pallets += ps.length; for (const p of ps) w += ctx.weight(p) }
      out.set(f.id, { slots: slots.length, used, pallets, lbs: w, open: f.status === 'Not Working' ? 0 : slots.length - used })
    }
    return out
  }, [ctx.snap])
  const tot = (fs: typeof fz) => fs.reduce((a, f) => { const x = per.get(f.id)!; return { slots: a.slots + x.slots, used: a.used + x.used, pallets: a.pallets + x.pallets, lbs: a.lbs + x.lbs, open: a.open + x.open } }, { slots: 0, used: 0, pallets: 0, lbs: 0, open: 0 })
  const all = tot(fz)
  const avg = all.pallets ? all.lbs / all.pallets : 0
  const trouble = fz.filter(f => f.status === 'Needs Attention' || f.status === 'Not Working')
  const loads = (ctx.snap.loads ?? []).filter(l => ['planning', 'loading', 'in_transit'].includes(l.status))
  const moving = loads.filter(l => l.status === 'in_transit').length
  const rc = ctx.reviewCounts
  const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`
  const outToday = loads.filter(l => l.load_date === today && l.status !== 'in_transit').length
  const siteLbs = (s: Site) => tot(fz.filter(f => f.site === s)).lbs
  const fullPct = all.slots ? all.used / all.slots : 0

  // trend lines (066): save today's numbers, read back the last 90 days (+ the same days last year)
  const [hist, setHist] = useState<Map<string, Map<string, number>>>(new Map())
  useEffect(() => {
    if (!fz.length) return
    ctx.backend.dashRecord({ freezer_lbs: Math.round(all.lbs), freezer_lbs_ohr: Math.round(siteLbs('OHR')), freezer_lbs_gvr: Math.round(siteLbs('GVR')),
      pallets: all.pallets, open_spaces: all.open, tags_pending: rc.tags, metrc_issues: rc.issues, freezer_problems: trouble.length }).catch(() => {})
  }, [ctx.snap, rc.tags, rc.issues])
  useEffect(() => {
    const from = new Date(); from.setDate(from.getDate() - 90 - 366)
    ctx.backend.dashSeries(['freezer_lbs', 'open_spaces', 'metrc_issues'], ymd(from)).then(rows => {
      const m = new Map<string, Map<string, number>>()
      for (const r of rows) (m.get(r.key) ?? m.set(r.key, new Map()).get(r.key)!).set(r.day, r.value)
      setHist(m)
    }).catch(() => {})
  }, [ctx.backend])
  const series = (key: string, days: string[], now?: number) => days.map((d, i) => (i === days.length - 1 && now != null ? now : hist.get(key)?.get(d) ?? null))
  const d90 = lastDays(90), d30 = lastDays(30), d14 = lastDays(14)
  const yearAgo = (d: string) => { const x = new Date(d + 'T12:00:00'); x.setFullYear(x.getFullYear() - 1); return ymd(x) }
  const lbs90 = series('freezer_lbs', d90, all.lbs)
  const lbsLY = d90.map(d => hist.get('freezer_lbs')?.get(yearAgo(d)) ?? null)
  const hasLY = lbsLY.filter(v => v != null).length > 1
  const wkAgo = lbs90[lbs90.length - 8]
  const wkPct = wkAgo ? (all.lbs - wkAgo) / wkAgo : null
  const lyNow = lbsLY[lbsLY.length - 1]
  const open30 = series('open_spaces', d30, all.open)
  const fill = projectTo(open30, 0)
  const proj = fill.hitsIn != null && fill.hitsIn <= 60 ? [...open30.map(() => null), ...Array.from({ length: Math.min(fill.hitsIn, 14) }, (_, i) => Math.max(0, all.open + fill.slope * (i + 1)))] : undefined
  const iss14 = series('metrc_issues', d14, rc.issues)
  const iss7 = iss14[iss14.length - 8]
  const pctTxt = (p: number) => `${p >= 0 ? '▲' : '▼'} ${Math.abs(p * 100).toFixed(1)}%`
  const spaceTone = all.open < 10 ? 'warn' : (fullPct >= 0.85 || (fill.hitsIn != null && fill.hitsIn <= 14)) ? 'heads' : undefined
  const dead = trouble.filter(f => f.status === 'Not Working')
  return (
    <div className="dash">
      <DashHead title="Dashboard" sub={`Distribution · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`} />
      <Tiles>
        <Tile wide label="In the freezers" value={`${n0(all.lbs)} lbs`} onClick={goMap}
          range={<>{hasLY && <Legend now={d0.getFullYear()} then={d0.getFullYear() - 1} />}<span>90 days</span></>}
          kv={[[n0(all.pallets), 'pallets'], [n0(avg), 'avg lbs'], ...(lyNow ? [[`${all.lbs >= lyNow ? '+' : ''}${Math.round((all.lbs / lyNow - 1) * 100)}%`, 'vs this day last year'] as [string, string]] : [[`OHR ${all.lbs ? Math.round(siteLbs('OHR') / all.lbs * 100) : 0}%`, `GVR ${all.lbs ? Math.round(siteLbs('GVR') / all.lbs * 100) : 0}%`] as [string, string]])]}
          chart={<Spark data={lbs90} ghost={hasLY ? lbsLY : undefined} labels={[axisDate(d90[0]), 'Today']} />}
          foot={wkPct != null ? `${pctTxt(wkPct)} this week` : 'Map'} />
        {dead.length > 0
          ? <Tile label="Freezer problems" value={`${dead.map(f => `${f.site} F${f.number}`).slice(0, 2).join(', ')} down`} sub={trouble.length > dead.length ? `${trouble.length - dead.length} more need attention` : 'not working'}
              tone="bad" foot="Act now" onClick={() => ctx.openFreezer(dead[0].id)} />
          : <Tile label="Freezer problems" value={trouble.length} sub={trouble.length ? trouble.map(f => `${f.site} F${f.number}`).slice(0, 4).join(', ') : `all ${fz.filter(f => f.status === 'On').length} running`}
              tone={trouble.length ? 'heads' : 'ok'} foot={trouble.length ? 'Needs attention' : undefined} onClick={trouble.length ? () => ctx.openFreezer(trouble[0].id) : undefined} />}
        <Tile label="Open spaces" value={n0(all.open)} sub={`${Math.round(fullPct * 100)}% full · about ${n0(all.open * avg)} lbs of room`} tone={spaceTone} onClick={goMap} range="30 days"
          chart={<Spark data={open30} project={proj} />} foot={fill.hitsIn != null && fill.hitsIn <= 60 ? `Full in ~${fill.hitsIn} days` : 'Map'} />
        <Tile label="METRC tags pending" value={rc.tags} sub={rc.issues ? `${rc.issues} import issues` : 'no import issues'} tone={rc.tags ? 'warn' : rc.issues ? 'heads' : 'ok'} onClick={ctx.goReview} range="14 days"
          chart={<Spark data={iss14} />} foot={rc.tags || rc.issues ? `${iss7 != null && rc.issues !== iss7 ? `${rc.issues > iss7 ? '▲' : '▼'} ${Math.abs(rc.issues - iss7)} issues this week · ` : ''}Fix` : undefined} />
        {staged && <Tile label="Harvest staging" value={staged.n} sub={staged.n ? `${n0(staged.lbs)} lbs in ${staged.sites.join(' + ')} Staging` : 'nothing waiting'} tone={staged.n ? 'heads' : 'ok'} foot={staged.n ? 'Put away' : undefined} onClick={staged.n ? staged.go : undefined} />}
        <Tile label="Needs a spot" value={rc.spot} sub={rc.spot ? 'pallets not in a freezer' : 'all pallets placed'} tone={rc.spot ? 'warn' : 'ok'} foot={rc.spot ? 'Place them' : undefined} onClick={ctx.goReview} />
        {fulfill && <Tile label="Orders to fulfill" value={fulfill.open + fulfill.ready} sub={[fulfill.open && `${fulfill.open} need pallets`, fulfill.ready && `${fulfill.ready} ready to load`, fulfill.waiting && `${fulfill.waiting} waiting on Sales`].filter(Boolean).join(' · ') || 'all caught up'}
          tone={fulfill.open ? 'warn' : fulfill.ready ? 'heads' : 'ok'} foot={fulfill.open + fulfill.ready ? 'Fulfillment' : undefined} onClick={fulfill.go} />}
        <Tile label="Loads" value={loads.length} sub={loads.length ? [outToday && `${outToday} going out today`, moving && `${moving} in transit`].filter(Boolean).join(' · ') || 'being planned' : 'none active'} tone={outToday ? 'info' : undefined} onClick={ctx.goTransit} />
        {sales && <Tile label="Sales" value={sales.orders + (sales.isAdmin ? sales.requests : 0)} sub={[`${sales.orders} orders to confirm`, sales.isAdmin && `${sales.requests} reserve requests`].filter(Boolean).join(' · ')} tone={sales.orders + (sales.isAdmin ? sales.requests : 0) ? 'info' : undefined}
          foot={sales.orders + (sales.isAdmin ? sales.requests : 0) ? 'Review' : undefined} onClick={sales.go} />}
      </Tiles>
      <Cards>
        <Card title="Freezer space" action="Map" onAction={goMap} wide>
          <div className="dsites">
            {(['OHR', 'GVR'] as Site[]).map(site => {
              const fs = fz.filter(f => f.site === site).sort((a, b) => a.number - b.number)
              if (!fs.length) return null
              const t = tot(fs)
              return (
                <div key={site} className="dsite">
                  <Meter label={<b>{site}</b>} right={<>{n0(t.used)} of {n0(t.slots)} spots full · <b>{n0(t.open)} open</b></>} value={t.used} max={t.slots} tone={t.slots && t.used / t.slots > 0.92 ? 'warn' : 'ok'} />
                  <div className="dfz">
                    {fs.map(f => { const x = per.get(f.id)!; const full = x.slots ? x.used / x.slots : 0
                      return (
                        <button key={f.id} className={`dfz-c st-${f.status.replace(/ /g, '-')}`} title={`${site} F${f.number}: ${f.status} · ${x.open} open · ${n0(x.lbs)} lbs`} onClick={() => ctx.openFreezer(f.id)}>
                          <span>F{f.number}</span><i style={{ height: `${Math.round(full * 100)}%` }} /><em>{f.status === 'Not Working' ? '✕' : x.open}</em>
                        </button>
                      ) })}
                  </div>
                </div>
              )
            })}
            <div className="muted small-note">Each box is a freezer: fill shows how full it is, the number is open spots. Amber needs attention, red isn't working, grey is off.</div>
          </div>
        </Card>
        <Card title="Loads" badge={loads.length}>
          <Loads ctx={ctx} loads={loads} />
        </Card>
        <Card title="Recent activity"><Activity ctx={ctx} /></Card>
        <Card title="Site overview"><Overview ctx={ctx} /></Card>
      </Cards>
    </div>
  )
}
