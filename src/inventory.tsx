// Inventory tabs for Distribution and Sales, built on the shared InvTable (Processing has its own in proc/).
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { InvTable } from './invtable'
import type { Col, GroupBy, Chip } from './invtable'
import { FINISH_LABEL, PRODUCT_LABEL } from './types'
import type { Balance, Grade, HarvestLot, Item, Pallet, Product, Strain } from './types'
import type { SelAction } from './cult/ui'
import type { SupabaseClient } from '@supabase/supabase-js'

const n0 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : Math.round(x).toLocaleString())
const daysSince = (iso: string | null | undefined) => iso ? Math.max(0, Math.round((Date.now() - new Date(iso.slice(0, 10) + 'T12:00:00').getTime()) / 864e5)) : null
const GradeChip = ({ g }: { g: Grade }) => <span className={`pill grade ${g.toLowerCase()}`}>{g}</span>
const prodOf = (p: Pallet) => (p.product ?? 'fresh_frozen') as Product

/** what the inventory screens need from the app */
export interface InvCtx {
  pallets: Pallet[]                         // everything in the snapshot (packages and mixed pallets)
  pallet: (id: number) => Pallet | undefined
  where: (p: Pallet) => string              // "OHR F2 · 2A", "on M3 · OHR F2 · 2A", "Needs a spot"
  grade: (p: Pallet) => { grade: Grade; from: string }
  item: (id: number | null | undefined) => Item | undefined
  lot: (id: number | null | undefined) => HarvestLot | undefined
  held: (id: number) => string | undefined  // "Customer · SO-..."
  onLoad: (id: number) => string | undefined
  inRun: (id: number) => string | undefined
  open: (id: number) => void                // pallet card
}

const live = (p: Pallet) => p.status === 'in_freezer' || p.status === 'unslotted' || p.status === 'in_transit'
const itemName = (i: Item | undefined) => i ? `${FINISH_LABEL[i.finish] ?? i.finish} · ${i.crop_year} · ${i.site}` : ''
const yearOf = (c: InvCtx, p: Pallet) => p.crop_year ?? c.item(p.item_id)?.crop_year ?? (p.harvest_date ? Number(p.harvest_date.slice(0, 4)) : null)

// ---------- Distribution: where is it ----------
export function DistInventory({ c, onMove, flash }: { c: InvCtx; onMove: (ids: number[]) => void; flash: (t: string, bad?: boolean) => void }) {
  const rows = c.pallets.filter(p => p.kind !== 'mixed' && live(p))
  const freezerOf = (p: Pallet) => { const w = c.where(p).replace(/^on \S+ · /, ''); return w.split(' · ')[0] }
  const spotOf = (p: Pallet) => { const m = p.container_id ? c.pallet(p.container_id) : undefined; return m ? `${c.where(m)} · ${m.code}` : c.where(p) }
  const flags = (p: Pallet): string[] => [
    p.slot_id == null && !p.container_id && p.status === 'unslotted' ? 'Needs a spot' : '',
    p.tag_pending ? 'Tag pending' : '', c.held(p.id) ? `Held: ${c.held(p.id)}` : '',
    c.onLoad(p.id) ? `On ${c.onLoad(p.id)}` : '', c.inRun(p.id) ? `In run ${c.inRun(p.id)}` : '',
    p.needs_review ? 'Flagged' : '',
  ].filter(Boolean)
  const physical = new Set(rows.map(p => p.container_id ?? p.id)).size
  const cols: Col<Pallet>[] = [
    { k: 'code', l: 'Pallet', phone: true, get: p => <><b>{p.code}</b>{p.container_id ? <span className="pill mixedp">on {c.pallet(p.container_id)?.code}</span> : null}</>, val: p => p.code },
    { k: 'strain', l: 'Strain', phone: true, get: p => <>{p.strain ?? p.label ?? ''}{prodOf(p) !== 'fresh_frozen' && <span className="pill prod">{PRODUCT_LABEL[prodOf(p)]}</span>}</>, val: p => p.strain ?? '' },
    { k: 'grade', l: 'Grade', phone: true, get: p => <GradeChip g={c.grade(p).grade} />, val: p => c.grade(p).grade },
    { k: 'lbs', l: 'Lbs', num: true, phone: true, get: p => n0(p.current_weight), val: p => Number(p.current_weight ?? 0) },
    { k: 'where', l: 'Location', phone: true, get: p => <span className="small">{c.where(p)}</span>, val: p => c.where(p) },
    { k: 'item', l: 'Item', get: p => <span className="small">{itemName(c.item(p.item_id))}</span>, val: p => c.item(p.item_id)?.sku ?? '' },
    { k: 'lot', l: 'Harvest lot', get: p => <span className="mono small">{c.lot(p.lot_id)?.code ?? ''}</span>, val: p => c.lot(p.lot_id)?.code ?? '' },
    { k: 'tag', l: 'METRC tag', get: p => <span className="mono small">{p.package_tag ?? (p.tag_pending ? 'pending' : '')}</span>, val: p => p.package_tag ?? '' },
    { k: 'age', l: 'Days', num: true, get: p => n0(daysSince(p.harvest_date)), val: p => daysSince(p.harvest_date) ?? -1 },
    { k: 'flags', l: 'Flags', get: p => <span className="flags">{flags(p).map(f => <span key={f} className="pill warnp">{f}</span>)}</span>, val: p => flags(p).join('; ') },
    { k: 'harvested', l: 'Harvested', on: false, get: p => p.harvest_date ?? '', val: p => p.harvest_date ?? '' },
    { k: 'farm', l: 'Grown at', on: false, get: p => p.origin_site ?? '', val: p => p.origin_site ?? '' },
    { k: 'sku', l: 'SKU', on: false, get: p => <span className="mono small">{c.item(p.item_id)?.sku ?? ''}</span>, val: p => c.item(p.item_id)?.sku ?? '' },
  ]
  const spotOrder = (k: string) => k.replace(/(\d+)/g, m => m.padStart(4, '0'))
  const containerByKey = new Map<string, number>()
  for (const p of rows) if (p.container_id) containerByKey.set(spotOf(p), p.container_id)
  const groups: GroupBy<Pallet>[] = [
    { k: 'freezer', l: 'Freezer', key: freezerOf, order: spotOrder },
    { k: 'spot', l: 'Spot', key: spotOf, order: spotOrder,
      head: (k, rs) => containerByKey.has(k) ? <>{k} <span className="pill mixedp">Mixed · {rs.length} pkg</span></> : k,
      open: k => { const id = containerByKey.get(k); if (id) c.open(id) } },
    { k: 'strain', l: 'Strain', key: p => p.strain ?? '' },
    { k: 'item', l: 'Item', key: p => itemName(c.item(p.item_id)) ? `${p.strain} · ${itemName(c.item(p.item_id))}` : `${p.strain ?? ''} · no item` },
    { k: 'lot', l: 'Harvest lot', key: p => c.lot(p.lot_id) ? `${c.lot(p.lot_id)!.code} · ${p.strain}` : 'No lot' },
    { k: 'grade', l: 'Grade', key: p => c.grade(p).grade },
  ]
  const chips: Chip<Pallet>[] = [
    { k: 'site', l: 'Site', get: p => freezerOf(p).split(' ')[0] },
    { k: 'year', l: 'Crop year', get: p => String(yearOf(c, p) ?? '') },
    { k: 'form', l: 'Form', get: p => PRODUCT_LABEL[prodOf(p)] },
    { k: 'grade', l: 'Grade', get: p => c.grade(p).grade },
    { k: 'flag', l: 'Status', get: p => flags(p)[0]?.split(':')[0] ?? 'OK' },
  ]
  const actions: SelAction[] = [{ label: 'Move', run: async ids => {
    const on = ids.filter(id => c.pallet(id)?.container_id)
    if (on.length) { const codes = on.map(id => c.pallet(id)!.code); flash(`${codes.join(', ')} ${codes.length === 1 ? 'is' : 'are'} on a mixed pallet. Open the package and use Take off, or move the mixed pallet itself.`, true); return }
    onMove(ids)
  } }]
  return <InvTable id="dist" title="Inventory" rows={rows} rowId={p => p.id} cols={cols} groups={groups} defaultGroup="freezer" chips={chips}
    text={p => `${p.code} ${p.strain ?? ''} ${p.package_tag ?? ''} ${c.lot(p.lot_id)?.code ?? ''} ${c.where(p)}`}
    lbs={p => Number(p.current_weight ?? 0)} onOpen={p => c.open(p.id)} actions={actions}
    note={<>Every package in inventory. Packages on a mixed pallet are listed one by one; group by Spot to see the mixed pallet. Sort by Days for the oldest product.</>}
    totals={rs => <>on <b>{new Set(rs.map(p => p.container_id ?? p.id)).size.toLocaleString()}</b> pallets{rs.length === rows.length ? '' : ` (of ${physical.toLocaleString()})`} · {rs.filter(p => c.grade(p).grade === 'BHO').length} BHO</>} />
}
// ---------- Sales: what can I sell ----------
interface PRow { id: number; strain: string; form: Product; grade: Grade; year: number | null; packages: Pallet[]; onHand: number; held: number; reserved: number; available: number; price: number | null }

export function SalesInventory({ c, strains, sb, onNewOrder }: { c: InvCtx; strains: Strain[]; sb: SupabaseClient | null; onNewOrder?: () => void }) {
  const [bal, setBal] = useState<Balance[]>([])
  const [prices, setPrices] = useState<{ crop_year: number; strain_id: number; grade: Grade; price_per_lb: number }[]>([])
  useEffect(() => {
    if (!sb) return
    sb.from('reserve_balances').select('*').then(r => setBal((r.data ?? []) as Balance[]), () => {})
    sb.from('strain_prices').select('crop_year,strain_id,grade,price_per_lb').then(r => setPrices((r.data ?? []) as typeof prices), () => {})
  }, [sb])
  const canon = new Map<string, Strain>(); for (const s of strains) for (const n of [s.name, ...(s.aliases ?? [])]) canon.set(n.toLowerCase().trim(), s)
  const strainOf = (n: string | null | undefined) => canon.get((n ?? '').toLowerCase().trim())
  const pk = c.pallets.filter(p => p.kind !== 'mixed' && live(p) && p.status !== 'in_transit')
  const m = new Map<string, PRow>()
  let id = 0
  for (const p of pk) {
    const st = strainOf(p.strain), name = st?.name ?? p.strain ?? '?'
    const g = c.grade(p).grade, y = yearOf(c, p), f = prodOf(p)
    const k = `${name}|${f}|${g}|${y}`
    const r = m.get(k) ?? m.set(k, { id: ++id, strain: name, form: f, grade: g, year: y, packages: [], onHand: 0, held: 0, reserved: 0, available: 0, price: null }).get(k)!
    r.packages.push(p); const w = Number(p.current_weight ?? 0); r.onHand += w; if (c.held(p.id)) r.held += w
  }
  // reserves left (fresh frozen) go on the strain's row for its default grade
  for (const b of bal) {
    const st = strainOf(b.strain), name = st?.name ?? b.strain, g = st?.default_grade ?? 'SHO'
    const r = [...m.values()].find(x => x.strain === name && x.form === 'fresh_frozen' && x.grade === g && (b.crop_year == null || x.year === b.crop_year))
    if (r) r.reserved += Math.max(0, Number(b.remaining ?? 0))
  }
  for (const r of m.values()) {
    r.available = r.onHand - r.held - r.reserved
    const st = strainOf(r.strain)
    r.price = prices.find(x => st && x.strain_id === st.id && x.grade === r.grade && x.crop_year === r.year)?.price_per_lb ?? null
  }
  const rows = [...m.values()]
  const cols: Col<PRow>[] = [
    { k: 'strain', l: 'Strain', phone: true, get: r => <b>{r.strain}</b>, val: r => r.strain },
    { k: 'form', l: 'Form', phone: true, get: r => PRODUCT_LABEL[r.form], val: r => PRODUCT_LABEL[r.form] },
    { k: 'grade', l: 'Grade', phone: true, get: r => <GradeChip g={r.grade} />, val: r => r.grade },
    { k: 'year', l: 'Crop', get: r => r.year ?? '', val: r => r.year ?? 0 },
    { k: 'onhand', l: 'On hand', num: true, get: r => n0(r.onHand), val: r => r.onHand },
    { k: 'held', l: 'Held for orders', num: true, get: r => n0(r.held), val: r => r.held },
    { k: 'reserved', l: 'Reserved', num: true, get: r => n0(r.reserved), val: r => r.reserved },
    { k: 'avail', l: 'Available', num: true, phone: true, get: r => r.available < 0 ? <b className="bad-t">Short {n0(-r.available)}</b> : <b>{n0(r.available)}</b>, val: r => r.available },
    { k: 'pallets', l: 'Pallets', num: true, get: r => r.packages.length, val: r => r.packages.length },
    { k: 'price', l: 'List $/lb', num: true, get: r => r.price != null ? `$${r.price.toFixed(2)}` : '', val: r => r.price ?? '' },
  ]
  const groups: GroupBy<PRow>[] = [
    { k: 'form', l: 'Form', key: r => PRODUCT_LABEL[r.form], order: k => Object.values(PRODUCT_LABEL).indexOf(k) },
    { k: 'year', l: 'Crop year', key: r => String(r.year ?? ''), order: k => -Number(k || 0) },
    { k: 'grade', l: 'Grade', key: r => r.grade },
  ]
  const chips: Chip<PRow>[] = [
    { k: 'year', l: 'Crop year', get: r => String(r.year ?? '') },
    { k: 'form', l: 'Form', get: r => PRODUCT_LABEL[r.form] },
    { k: 'grade', l: 'Grade', get: r => r.grade },
    { k: 'short', l: 'Show', get: r => r.available < 0 ? 'Short' : r.available > 0 ? 'Available' : 'None left' },
  ]
  const expand = (r: PRow): ReactNode => {
    const byLot = new Map<string, Pallet[]>()
    for (const p of r.packages) { const k = c.lot(p.lot_id)?.code ?? 'No lot'; (byLot.get(k) ?? byLot.set(k, []).get(k)!).push(p) }
    return <div className="drill">{[...byLot.entries()].sort().map(([k, ps]) => <div key={k} className="drill-lot">
      <div className="row between"><span><span className="mono">{k}</span>{(() => { const l = c.lot(ps[0].lot_id); return l?.site ? <span className="muted"> · {l.site}</span> : null })()}</span>
        <span className="muted">{ps.length} · {n0(ps.reduce((a, p) => a + Number(p.current_weight ?? 0), 0))} lbs</span></div>
      <div className="drill-p">{ps.map(p => <a key={p.id} onClick={() => c.open(p.id)} className="chip">{p.code} {n0(p.current_weight)}{c.held(p.id) ? ' · held' : ''}{p.grade ? ` · ${p.grade}` : ''}</a>)}</div>
    </div>)}</div>
  }
  return <InvTable id="sales" title="Inventory" rows={rows} rowId={r => r.id} cols={cols} groups={groups} defaultGroup="form" chips={chips} noun="product"
    text={r => `${r.strain} ${PRODUCT_LABEL[r.form]} ${r.grade} ${r.year ?? ''} ${r.packages.map(p => `${p.code} ${c.lot(p.lot_id)?.code ?? ''}`).join(' ')}`}
    lbs={r => r.onHand} expand={expand}
    toolbar={onNewOrder ? <button className="primary small" onClick={onNewOrder}>New order</button> : undefined}
    rowClass={r => r.available < 0 ? 'shortrow' : ''}
    note={<>What you can sell, by strain, form and grade. Available = on hand − held for orders − reserves left. Tap a row to see its harvest lots and pallets.</>}
    totals={rs => <>available <b>{n0(rs.reduce((a, r) => a + Math.max(0, r.available), 0))}</b> lbs{rs.some(r => r.available < 0) ? <> · <b className="bad-t">{rs.filter(r => r.available < 0).length} short</b></> : null}</>} />
}
