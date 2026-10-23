import { useEffect, useMemo, useState } from 'react'
import type { Backend } from './api'
import { Card, Cards, DashHead, Meter, Tile, Tiles } from './dash'
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
      const fz = ctx.snap.freezers.filter(f => sites.includes(f.site) && (f.kind ?? 'freezer') === 'freezer')
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
  const fz = ctx.snap.freezers.filter(f => (f.kind ?? 'freezer') === 'freezer')
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
  return (
    <div className="dash">
      <DashHead title="Dashboard" sub={`Distribution · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`} />
      <Tiles>
        {staged && <Tile label="Harvest staging" value={staged.n} sub={staged.n ? `${n0(staged.lbs)} lbs in ${staged.sites.join(' + ')} Staging to put away` : 'nothing waiting'} tone={staged.n ? 'warn' : 'ok'} onClick={staged.n ? staged.go : undefined} />}
        <Tile label="Needs a spot" value={rc.spot} sub={rc.spot ? 'pallets not in a freezer' : 'all pallets placed'} tone={rc.spot ? 'warn' : 'ok'} onClick={ctx.goReview} />
        <Tile label="METRC tags pending" value={rc.tags} sub={rc.issues ? `${rc.issues} import issues` : ''} tone={rc.tags ? 'warn' : 'ok'} onClick={ctx.goReview} />
        {fulfill && <Tile label="Orders to fulfill" value={fulfill.open + fulfill.ready} sub={[fulfill.open && `${fulfill.open} need pallets`, fulfill.ready && `${fulfill.ready} ready to load`, fulfill.waiting && `${fulfill.waiting} waiting on Sales`].filter(Boolean).join(' · ') || 'all caught up'}
          tone={fulfill.open + fulfill.ready ? 'warn' : 'ok'} onClick={fulfill.go} />}
        <Tile label="Loads" value={loads.length} sub={loads.length ? [outToday && `${outToday} going out today`, moving && `${moving} in transit`].filter(Boolean).join(' · ') || 'being planned' : 'none active'} tone={outToday ? 'info' : undefined} onClick={ctx.goTransit} />
        <Tile label="Open spaces" value={n0(all.open)} sub={`about ${n0(all.open * avg)} lbs of room`} tone={all.open < 10 ? 'warn' : undefined} onClick={goMap} />
        <Tile label="In the freezers" value={`${n0(all.lbs)} lbs`} sub={`${n0(all.pallets)} pallets · ${n0(avg)} avg`} />
        <Tile label="Freezer problems" value={trouble.length} sub={trouble.length ? trouble.map(f => `${f.site} F${f.number}`).slice(0, 4).join(', ') : 'all running'} tone={trouble.some(f => f.status === 'Not Working') ? 'bad' : trouble.length ? 'warn' : 'ok'}
          onClick={trouble.length ? () => ctx.openFreezer(trouble[0].id) : undefined} />
        {sales && <Tile label="Sales" value={sales.orders + (sales.isAdmin ? sales.requests : 0)} sub={[`${sales.orders} orders to confirm`, sales.isAdmin && `${sales.requests} reserve requests`].filter(Boolean).join(' · ')} tone={sales.orders + (sales.isAdmin ? sales.requests : 0) ? 'info' : undefined} onClick={sales.go} />}
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
