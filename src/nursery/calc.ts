import { addDays, today } from '../cult/calc'
import type { Batch, Mother, NData, NOrder } from './types'
export { addDays, daysBetween, fmtD, n0, sum, today } from '../cult/calc'

/** everything the screens need worked out once */
export interface NCtx {
  delivered: Map<number, number>          // per order
  fromBatch: Map<number, number>          // per batch
  left: (b: Batch) => number              // plants still in a batch
  owed: (o: NOrder) => number             // plants still to deliver on an order
  isOpen: (o: NOrder) => boolean
  to: (o: NOrder) => string               // OHR, GVR or the customer
  room: (id: number | null) => string
  cutFor: Map<number, number>             // cuttings taken for each order (batches linked to it, not cancelled)
  byStrain: Map<string, { ready: number; rooting: number; mothers: number; owed: number }>
  short: Map<number, number>              // plants an order is still short after ready + rooting plants are shared out (earliest delivery first)
}

const key = (s: string) => s.trim().toLowerCase()
/** plants still alive in a mother lot */
export const live = (m: Mother) => (m.status === 'active' ? Math.max(0, m.qty - m.lost) : 0)
/** rooted so far from the sorts: first sort vigorous + second sort vigorous (the workbook's "Final Qty Rooted") */
export const rooted = (b: Batch) => (b.sort1_on || b.s1_vigorous != null ? (b.s1_vigorous ?? 0) + (b.s2_vigorous ?? 0) : null)
export const GEN_LABEL: Record<number, string> = { 1: 'G1', 2: 'G2', 3: 'G3', 4: 'G4' }
export const GEN_WHAT: Record<number, string> = { 1: 'G1 starter moms', 2: 'G2 greenhouse moms', 3: 'G3 field moms', 4: 'G4 production clones' }

export function makeCtx(d: NData, customers: Map<number, string>): NCtx {
  const delivered = new Map<number, number>(), fromBatch = new Map<number, number>()
  for (const x of d.deliveries) {
    delivered.set(x.order_id, (delivered.get(x.order_id) ?? 0) + x.plants)
    if (x.batch_id != null) fromBatch.set(x.batch_id, (fromBatch.get(x.batch_id) ?? 0) + x.plants)
  }
  const planted = new Map<number, number>()   // G1-G3 batches planted out as mother lots
  for (const m of d.mothers) if (m.batch_id != null) planted.set(m.batch_id, (planted.get(m.batch_id) ?? 0) + m.qty + m.lost)
  const left = (b: Batch) => Math.max(0, b.cuttings - b.lost - (fromBatch.get(b.id) ?? 0) - (planted.get(b.id) ?? 0))
  const owed = (o: NOrder) => Math.max(0, o.plants - (delivered.get(o.id) ?? 0))
  const isOpen = (o: NOrder) => o.status !== 'cancelled' && o.status !== 'received' && owed(o) > 0
  const rooms = new Map(d.rooms.map(r => [r.id, r.name]))
  const cutFor = new Map<number, number>()
  for (const b of d.batches) if (b.order_id != null && b.stage !== 'cancelled') cutFor.set(b.order_id, (cutFor.get(b.order_id) ?? 0) + b.cuttings - b.lost)
  const byStrain = new Map<string, { ready: number; rooting: number; mothers: number; owed: number }>()
  const g = (s: string) => byStrain.get(key(s)) ?? byStrain.set(key(s), { ready: 0, rooting: 0, mothers: 0, owed: 0 }).get(key(s))!
  for (const b of d.batches) { if (b.stage === 'ready') g(b.strain).ready += left(b); else if (b.stage === 'rooting') g(b.strain).rooting += left(b) }
  for (const m of d.mothers) if (m.status === 'active') g(m.strain).mothers += live(m)
  for (const o of d.orders) if (isOpen(o) && o.status !== 'planned') g(o.strain).owed += owed(o)
  // share each strain's ready + rooting plants out over its open orders, earliest delivery first (planned ones last)
  const short = new Map<number, number>()
  const supply = new Map([...byStrain.entries()].map(([k, v]) => [k, v.ready + v.rooting]))
  const queue = d.orders.filter(isOpen).sort((a, b) => (a.status === 'planned' ? 1 : 0) - (b.status === 'planned' ? 1 : 0) || (a.deliver_on ?? '9').localeCompare(b.deliver_on ?? '9'))
  for (const o of queue) {
    const have = supply.get(key(o.strain)) ?? 0, need = owed(o), take = Math.min(have, need)
    supply.set(key(o.strain), have - take)
    if (need > take) short.set(o.id, need - take)
  }
  return {
    delivered, fromBatch, left, owed, isOpen, cutFor, byStrain, short,
    to: o => o.site ?? (o.customer_id != null ? customers.get(o.customer_id) ?? `#${o.customer_id}` : '?'),
    room: id => (id == null ? '' : rooms.get(id) ?? ''),
  }
}
export const strainKey = key

/** METRC plant batch name: 1PN-261022-RumRunner */
export const batchName = (site: string, cutOn: string, strain: string) =>
  `${site}-${cutOn.slice(2).replace(/-/g, '')}-${strain.replace(/[^A-Za-z0-9#]/g, '')}`

/** how many METRC tags a batch needs (one per 100 immature plants) */
export const tagsNeeded = (n: number) => Math.max(1, Math.ceil(n / 100))

export const STATUS_LABEL: Record<string, string> = { planned: 'Planned', ordered: 'Ordered', confirmed: 'Confirmed', received: 'Delivered', cancelled: 'Cancelled' }
export const STAGE_LABEL: Record<string, string> = { rooting: 'Rooting', ready: 'Ready', done: 'Delivered', cancelled: 'Cancelled' }

/** open orders due within n days (late ones too) */
export const dueWithin = (d: NData, c: NCtx, n: number) => {
  const until = addDays(today(), n)
  return d.orders.filter(o => c.isOpen(o) && o.deliver_on && o.deliver_on <= until).sort((a, b) => (a.deliver_on ?? '').localeCompare(b.deliver_on ?? ''))
}

// ---------- the season plan: work back from the farm orders ----------
export interface GenRow { need: number; have: number; rooting: number; cut: number; trays: number; cutBy: string | null }
export interface PlanRow {
  strain: string; orders: number; nOrders: number; firstDeliver: string | null
  g4: { cuttings: number; trays: number; cutBy: string | null; cut: number }
  g3: GenRow; g2: GenRow; g1: GenRow; plantBy: string | null
  cuts: { g3: number; g2: number; g1: number }; custom: boolean
}
export function planSeason(d: NData, c: NCtx, year: number): PlanRow[] {
  const S = d.settings, buf = 1 + S.buffer / 100, tray = S.tray || 72
  const sp = new Map(d.strainPlan.map(p => [key(p.strain), p]))
  const byS = new Map<string, NOrder[]>()
  for (const o of d.orders) if (o.status !== 'cancelled' && o.crop_year === year) (byS.get(key(o.strain)) ?? byS.set(key(o.strain), []).get(key(o.strain))!).push(o)
  // strains with moms or batches for the season but no orders yet still show
  for (const m of d.mothers) if (m.season === year && live(m) > 0 && !byS.has(key(m.strain))) byS.set(key(m.strain), [])
  const have = (s: string, gen: number) => d.mothers.filter(m => m.gen === gen && m.season === year && key(m.strain) === s).reduce((a, m) => a + live(m), 0)
  const rootingN = (s: string, gen: number) => d.batches.filter(b => b.gen === gen && (b.season ?? year) === year && key(b.strain) === s && (b.stage === 'rooting' || b.stage === 'ready')).reduce((a, b) => a + c.left(b), 0)
  const cutN = (s: string, gen: number) => d.batches.filter(b => b.gen === gen && (b.season ?? year) === year && key(b.strain) === s && b.stage !== 'cancelled').reduce((a, b) => a + b.cuttings, 0)
  const out: PlanRow[] = []
  for (const [s, os] of byS) {
    const name = os[0]?.strain ?? d.mothers.find(m => key(m.strain) === s)?.strain ?? s
    const p = sp.get(s)
    const cuts = { g3: p?.cuts_g3 || S.cutsG3, g2: p?.cuts_g2 || S.cutsG2, g1: p?.cuts_g1 || S.cutsG1 }
    const g4c = os.reduce((a, o) => a + Math.ceil(o.plants * buf / tray) * tray, 0)
    const first = os.map(o => o.deliver_on).filter((x): x is string => !!x).sort()[0] ?? null
    const g4CutBy = first ? addDays(first, -S.rootDays) : null
    const plantBy = g4CutBy ? addDays(g4CutBy, -S.g3VegDays) : null
    const g3CutBy = plantBy ? addDays(plantBy, -S.g3RootDays) : null
    const g2CutBy = g3CutBy ? addDays(g3CutBy, -S.g2Lead) : null
    const g1CutBy = g2CutBy ? addDays(g2CutBy, -S.g1Lead) : null
    // each generation only has to make up what the one below it is still short
    const still = (need: number, n: number) => Math.max(0, need - have(s, n) - rootingN(s, n))
    const g3need = Math.ceil(g4c / cuts.g3), g3cut = Math.ceil(still(g3need, 3) * buf)
    const g2need = Math.ceil(g3cut / cuts.g2), g2cut = Math.ceil(still(g2need, 2) * buf)
    const g1need = Math.ceil(g2cut / cuts.g1), g1cut = Math.ceil(still(g1need, 1) * buf)
    const gen = (n: number, need: number, cut: number, cutBy: string | null): GenRow => ({ need, have: have(s, n), rooting: rootingN(s, n), cut, trays: Math.ceil(cut / tray), cutBy })
    out.push({
      strain: name, orders: os.reduce((a, o) => a + o.plants, 0), nOrders: os.length, firstDeliver: first,
      g4: { cuttings: g4c, trays: Math.ceil(g4c / tray), cutBy: g4CutBy, cut: cutN(s, 4) },
      g3: gen(3, g3need, g3cut, g3CutBy), g2: gen(2, g2need, g2cut, g2CutBy), g1: gen(1, g1need, g1cut, g1CutBy), plantBy,
      cuts, custom: !!p && !!(p.cuts_g3 || p.cuts_g2 || p.cuts_g1),
    })
  }
  return out.sort((a, b) => (a.firstDeliver ?? '9').localeCompare(b.firstDeliver ?? '9') || a.strain.localeCompare(b.strain))
}
