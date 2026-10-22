import { addDays, today } from '../cult/calc'
import type { Batch, NData, NOrder } from './types'
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

export function makeCtx(d: NData, customers: Map<number, string>): NCtx {
  const delivered = new Map<number, number>(), fromBatch = new Map<number, number>()
  for (const x of d.deliveries) {
    delivered.set(x.order_id, (delivered.get(x.order_id) ?? 0) + x.plants)
    if (x.batch_id != null) fromBatch.set(x.batch_id, (fromBatch.get(x.batch_id) ?? 0) + x.plants)
  }
  const left = (b: Batch) => Math.max(0, b.cuttings - b.lost - (fromBatch.get(b.id) ?? 0))
  const owed = (o: NOrder) => Math.max(0, o.plants - (delivered.get(o.id) ?? 0))
  const isOpen = (o: NOrder) => o.status !== 'cancelled' && o.status !== 'received' && owed(o) > 0
  const rooms = new Map(d.rooms.map(r => [r.id, r.name]))
  const cutFor = new Map<number, number>()
  for (const b of d.batches) if (b.order_id != null && b.stage !== 'cancelled') cutFor.set(b.order_id, (cutFor.get(b.order_id) ?? 0) + b.cuttings - b.lost)
  const byStrain = new Map<string, { ready: number; rooting: number; mothers: number; owed: number }>()
  const g = (s: string) => byStrain.get(key(s)) ?? byStrain.set(key(s), { ready: 0, rooting: 0, mothers: 0, owed: 0 }).get(key(s))!
  for (const b of d.batches) { if (b.stage === 'ready') g(b.strain).ready += left(b); else if (b.stage === 'rooting') g(b.strain).rooting += left(b) }
  for (const m of d.mothers) if (m.status === 'active') g(m.strain).mothers++
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
