import { useEffect, useMemo, useState } from 'react'
import { lbs } from './forms'
import type { Backend } from './api'
import type { Freezer, InvEvent, Load, LoadItem, LoadStop, Pallet, Site, Slot, Snapshot } from './types'

// Summary sidebar: same ideas as the workbook's Summary tab, plus loads, review and activity.

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
  close: () => void
}

const SECTIONS = ['overview', 'order', 'loads', 'review', 'activity', 'status'] as const
type Sec = typeof SECTIONS[number]
const TITLES: Record<Sec, string> = { overview: 'Site Overview', order: 'Order Builder', loads: 'Loads', review: 'Review', activity: 'Recent Activity', status: 'Freezer Status' }
const PICKABLE = new Set(['On', 'Needs Attention'])

function readOpen(): Record<Sec, boolean> {
  const def = { overview: true, order: true, loads: true, review: true, activity: false, status: false }
  try { return { ...def, ...JSON.parse(localStorage.getItem('fm.side.sections') ?? '{}') } } catch { return def }
}
const n0 = (n: number) => Math.round(n).toLocaleString()

export function Sidebar({ ctx }: { ctx: SideCtx }) {
  const [open, setOpen] = useState<Record<Sec, boolean>>(readOpen)
  const toggle = (s: Sec) => setOpen(o => {
    const n = { ...o, [s]: !o[s] }
    try { localStorage.setItem('fm.side.sections', JSON.stringify(n)) } catch { /* private mode */ }
    return n
  })
  const sec = (s: Sec, body: React.ReactNode, extra?: React.ReactNode) => (
    <section className={`side-sec ${open[s] ? 'open' : ''}`}>
      <button className="side-h" onClick={() => toggle(s)}><span>{open[s] ? '▾' : '▸'} {TITLES[s]}</span>{extra}</button>
      {open[s] && <div className="side-b">{body}</div>}
    </section>
  )
  const activeLoads = (ctx.snap.loads ?? []).filter(l => ['planning', 'loading', 'in_transit'].includes(l.status))
  const rc = ctx.reviewCounts
  return (
    <aside className="sidebar">
      <div className="side-top"><b>Summary</b><button className="ghost small" onClick={ctx.close} title="Hide summary">⟨ Hide</button></div>
      {sec('overview', <Overview ctx={ctx} />)}
      {sec('order', <OrderBuilder ctx={ctx} />)}
      {sec('loads', <Loads ctx={ctx} loads={activeLoads} />, activeLoads.length ? <span className="side-badge">{activeLoads.length}</span> : null)}
      {sec('review', (
        <div className="side-list">
          <button className="side-row" onClick={ctx.goReview}><span>Needs a spot</span><b className={rc.spot ? 'warn-t' : ''}>{rc.spot}</b></button>
          <button className="side-row" onClick={ctx.goReview}><span>METRC tags pending</span><b className={rc.tags ? 'warn-t' : ''}>{rc.tags}</b></button>
          <button className="side-row" onClick={ctx.goReview}><span>Import issues</span><b className={rc.issues ? 'warn-t' : ''}>{rc.issues}</b></button>
        </div>
      ), rc.spot + rc.tags + rc.issues ? <span className="side-badge warn">{rc.spot + rc.tags + rc.issues}</span> : null)}
      {sec('activity', <Activity ctx={ctx} />)}
      {sec('status', <FreezerStatus ctx={ctx} />)}
    </aside>
  )
}

// ---------- Site Overview (workbook rows 5 to 15) ----------

function Overview({ ctx }: { ctx: SideCtx }) {
  const stats = useMemo(() => {
    const calc = (sites: Site[]) => {
      const fz = ctx.snap.freezers.filter(f => sites.includes(f.site))
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

// ---------- Order Builder (workbook L3:T187) ----------

function OrderBuilder({ ctx }: { ctx: SideCtx }) {
  const [strain, setStrain] = useState('')
  const [need, setNeed] = useState('')
  const [where, setWhere] = useState<'Both' | Site>('Both')
  // pickable = loose package in a working freezer, not on a load
  const pickable = useMemo(() => {
    const out: { p: Pallet; f: Freezer; s: Slot }[] = []
    for (const p of ctx.snap.pallets) {
      if (p.status !== 'in_freezer' || p.container_id || p.kind === 'mixed' || p.slot_id == null || !p.strain || !p.current_weight) continue
      if (ctx.onLoad(p)) continue
      const f = ctx.freezerOf(p.slot_id), s = ctx.slot(p.slot_id)
      if (!f || !s || !PICKABLE.has(f.status)) continue
      out.push({ p, f, s })
    }
    return out
  }, [ctx.snap])
  const strains = useMemo(() => [...new Set(pickable.map(x => x.p.strain!))].sort(), [pickable])
  const q = strain.trim().toLowerCase()
  const lbsNeeded = parseFloat(need) || 0
  const rows = pickable.filter(x => x.p.strain!.toLowerCase() === q && (where === 'Both' || x.f.site === where))
  const available = rows.reduce((a, x) => a + (x.p.current_weight ?? 0), 0)
  const best = lbsNeeded > 0 ? rows.filter(x => (x.p.current_weight ?? 0) >= lbsNeeded).sort((a, b) => (a.p.current_weight! - b.p.current_weight!) || (a.s.front_rank - b.s.front_rank))[0] : undefined
  // easiest to grab: closest to the door first, then lighter pallets
  const easy = [...rows].sort((a, b) => (a.s.front_rank - b.s.front_rank) || (a.p.current_weight! - b.p.current_weight!))
  let run = 0
  const list = easy.map(x => { const pull = lbsNeeded > 0 && run < lbsNeeded; run += x.p.current_weight!; return { ...x, pull, run } })
  const pulled = list.filter(x => x.pull)
  const pulledLbs = pulled.reduce((a, x) => a + x.p.current_weight!, 0)
  const line = (x: { p: Pallet; f: Freezer; s: Slot }, extra?: React.ReactNode) => (
    <button key={x.p.id} className="side-pick" onClick={() => ctx.openPallet(x.p.id)}>
      {extra}<b>{x.p.code}</b><span>{x.f.site} F{x.f.number} · {x.s.code}</span><span>{lbs(x.p.current_weight)}</span>
      <span className="muted">front {x.s.front_rank}{x.f.status !== 'On' ? ` · ${x.f.status}` : ''}</span>
    </button>
  )
  return (
    <div className="order">
      <div className="order-in">
        <input list="side-strains" placeholder="Strain" value={strain} onChange={e => setStrain(e.target.value)} />
        <datalist id="side-strains">{strains.map(s => <option key={s} value={s} />)}</datalist>
        <input type="number" inputMode="decimal" placeholder="Lbs needed" value={need} onChange={e => setNeed(e.target.value)} />
        <select value={where} onChange={e => setWhere(e.target.value as 'Both' | Site)}><option>Both</option><option>OHR</option><option>GVR</option></select>
      </div>
      {q && rows.length === 0 && <div className="muted small-note">Nothing pickable for "{strain}". Pallets on a load, on mixed pallets, or in Off / Not Working freezers aren't counted.</div>}
      {rows.length > 0 && (<>
        <div className="order-kpis">
          <div><span>Available</span><b>{n0(available)} lbs</b></div>
          <div><span>Pallets to pull</span><b>{pulled.length}</b></div>
          <div><span>Lbs pulled</span><b>{n0(pulledLbs)}</b></div>
          <div className={lbsNeeded > pulledLbs ? 'short' : ''}><span>Short by</span><b>{n0(Math.max(0, lbsNeeded - pulledLbs))}</b></div>
        </div>
        {lbsNeeded > 0 && (<>
          <div className="side-sub">Best pick: smallest single pallet that covers it</div>
          {best ? line(best) : <div className="muted small-note">No single pallet has {n0(lbsNeeded)} lbs.</div>}
        </>)}
        <div className="side-sub">Easiest to grab: front slots first{lbsNeeded > 0 ? ' (✔ pull these)' : ''}</div>
        <div className="side-list">
          {list.slice(0, Math.max(12, pulled.length + 3)).map(x => line(x, <span className={`chk ${x.pull ? 'on' : ''}`}>{x.pull ? '✔' : ''}</span>))}
          {list.length > Math.max(12, pulled.length + 3) && <div className="muted small-note">+{list.length - Math.max(12, pulled.length + 3)} more</div>}
        </div>
        <button className="ghost small" onClick={() => ctx.searchFor(strain)}>Show {strain} on the map</button>
      </>)}
    </div>
  )
}

// ---------- Loads ----------

function Loads({ ctx, loads }: { ctx: SideCtx; loads: Load[] }) {
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

function Activity({ ctx }: { ctx: SideCtx }) {
  const [evs, setEvs] = useState<InvEvent[] | null>(null)
  useEffect(() => { ctx.backend.recentEvents(10).then(setEvs).catch(() => setEvs([])) }, [ctx.snap])
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

// ---------- Freezer Status (workbook B17:G73) ----------

function FreezerStatus({ ctx }: { ctx: SideCtx }) {
  const fz = ctx.snap.freezers.filter(f => f.site === ctx.site).sort((a, b) => a.number - b.number)
  return (
    <table className="side-table status-t">
      <thead><tr><th>{ctx.site}</th><th>Status</th><th>Open</th><th>Pallets</th><th>Lbs</th></tr></thead>
      <tbody>
        {fz.map(f => {
          const slots = ctx.slotsOf(f.id)
          const ps = slots.flatMap(s => ctx.inSlot(s.id))
          const open = f.status === 'Not Working' ? 0 : slots.filter(s => ctx.inSlot(s.id).length === 0).length
          return (
            <tr key={f.id} className={`click st-${f.status.replace(/ /g, '-')}`} onClick={() => ctx.openFreezer(f.id)}>
              <td>F{f.number}</td><td><span className="dot" /> {f.status}</td><td>{open}</td><td>{ps.length}</td><td>{n0(ps.reduce((a, p) => a + ctx.weight(p), 0))}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
