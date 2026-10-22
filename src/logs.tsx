import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// Spray, feed and labor logs, shared by Production and the Nursery (each sees its own).
// Production works like Farm Data OHR: rates per acre x acres; the Nursery mixes per gallon of water.
// Everything is grouped by year, month and calendar week.
type Flash = (t: string, bad?: boolean) => void
export type LogKind = 'spray' | 'feed' | 'labor'
type Basis = 'acre' | 'gal'
interface ProductLine { product: string; manufacturer?: string | null; rate: number | null; unit: string | null; basis?: Basis; total: number | null; total_unit: string | null }
export interface OpsLog {
  id: number; module: string; kind: LogKind; site: string; area: string | null; log_on: string; start_at: string | null; end_at: string | null
  sqft: number | null; spray_type: string | null; water_gal: number | null; applicator: string | null; products: ProductLine[]
  task: string | null; strain: string | null; batch_id: number | null; qty: number | null; crew: number | null; hours: number | null; notes: string | null; created_by: string | null
  method: string | null; acres: number | null; run_min: number | null; equipment: string | null; recipe: string | null
}
interface Product { id: number; name: string; manufacturer: string | null; rate: number | null; rate_unit: string | null; kind: string | null; active: boolean; price: number | null; price_unit: string | null; pesticide: boolean }
interface Recipe { id: number; module: string; kind: 'spray' | 'feed'; name: string; method: string | null; stage: string | null; water_per_acre: number | null; products: ProductLine[]; active: boolean }

const KIND_LABEL: Record<LogKind, string> = { spray: 'Spray', feed: 'Feed', labor: 'Labor' }
const SPRAY_TYPES = ['Feed', 'Pesticide', 'Feed + pesticide', 'Sulfur', 'Other']
const FEED_METHODS = ['Fertigation', 'Foliar feed', 'Amendment / side dress', 'Drench', 'Other']
export const TASKS = ['Cut', 'Clean / manicure', 'Stick', 'Sort', 'Transplant', 'Move clones', 'Plant', 'Top', 'Other']
const FIELD_TASKS = ['Bed shaping', 'Planting', 'Cultivation', 'Hand weeding', 'Fertilizer side dress', 'Disc dead beds', 'Male scouting', 'Spraying', 'Fertigation', 'Irrigation repair', 'Harvest', 'Other']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const n = (x: unknown) => (x == null || x === '' ? null : Number(x))
const num = (x: number | null | undefined, d = 0) => (x == null || !isFinite(x) ? '' : x.toLocaleString(undefined, { maximumFractionDigits: d }))
const money = (x: number) => x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const unitKey = (u: string | null | undefined) => (u ?? '').toLowerCase().replace(/\/.*$/, '').replace(/gallons?|gal\.?/, 'gal').replace(/^lbs?$/, 'lb').replace(/^oz$/, 'fl oz').trim()

/** ISO week (1-53) and its Monday */
export function isoWeek(s: string): { year: number; week: number; monday: string } {
  const d = new Date(s + 'T12:00:00'), day = (d.getDay() + 6) % 7
  const mon = new Date(d); mon.setDate(d.getDate() - day)
  const th = new Date(mon); th.setDate(mon.getDate() + 3)
  const jan4 = new Date(th.getFullYear(), 0, 4), w1 = new Date(jan4); w1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return { year: th.getFullYear(), week: Math.round((mon.getTime() - w1.getTime()) / 6048e5) + 1, monday: iso(mon) }
}
const md = (s: string) => { const [, m, d] = s.split('-'); return `${Number(m)}/${Number(d)}` }
const addD = (s: string, k: number) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/** a product line's total: rate x acres, or rate x gallons of water */
function lineTotal(l: ProductLine, x: Partial<OpsLog>, def: Basis): number | null {
  if (l.rate == null) return null
  const k = (l.basis ?? def) === 'acre' ? x.acres : x.water_gal
  return k == null ? null : Math.round(l.rate * k * 100) / 100
}
function lineCost(l: ProductLine, p: Product | undefined): number | null {
  if (!p?.price || l.total == null) return null
  if (p.price_unit && l.total_unit && unitKey(p.price_unit) !== unitKey(l.total_unit)) return null
  return l.total * p.price
}

export function OpsLogs({ sb, module, sites, areas, strains, flash, batches, wage, extraTab, fieldAcres, canEditRecipes }: {
  sb: SupabaseClient; module: 'nursery' | 'cultivation'; sites: string[]; areas: string[]; strains: string[]; flash: Flash
  batches?: { id: number; label: string; strain: string }[]; wage?: number; extraTab?: { k: string; l: string; node: ReactNode }
  fieldAcres?: Record<string, number>; canEditRecipes?: boolean
}) {
  const field = module === 'cultivation'
  const [kind, setKind] = useState<LogKind | 'extra' | 'recipes'>('spray')
  const [rows, setRows] = useState<OpsLog[] | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Partial<OpsLog> | null>(null)
  const [site, setSite] = useState<string | null>(null)
  const [year, setYear] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [opened, setOpened] = useState<Set<string> | null>(null)   // null: only the latest month open
  const load = useCallback(async () => {
    const [l, p, r] = await Promise.all([
      sb.from('ops_logs').select('*').eq('module', module).order('log_on', { ascending: false }).order('id', { ascending: false }).limit(5000),
      sb.from('input_products').select('*').order('name'),
      sb.from('ops_recipes').select('*').eq('module', module).order('sort'),
    ])
    if (l.error) { setErr(/ops_logs/.test(l.error.message) ? 'Logs need 031 and 032 run in Supabase.' : l.error.message); return }
    setRows((l.data ?? []).map(x => ({ ...x, products: x.products ?? [], sqft: n(x.sqft), water_gal: n(x.water_gal), qty: n(x.qty), hours: n(x.hours), acres: n(x.acres), run_min: n(x.run_min) })) as OpsLog[])
    setProducts(((p.data ?? []) as Product[]).map(x => ({ ...x, price: n(x.price) })))
    setRecipes(r.error ? [] : (r.data ?? []) as Recipe[]); setErr(null)
  }, [sb, module])
  useEffect(() => { load() }, [load])
  const pmap = useMemo(() => new Map(products.map(p => [p.name.toLowerCase(), p])), [products])
  if (err) return <div className="warnbox">{err}</div>
  if (!rows) return <p className="muted">Loading…</p>
  const years = [...new Set(rows.map(r => Number(r.log_on.slice(0, 4))))].sort((a, b) => b - a)
  const yr = year ?? years[0] ?? new Date().getFullYear()
  const ql = q.trim().toLowerCase()
  const shown = kind === 'extra' || kind === 'recipes' ? [] : rows.filter(r => r.kind === kind && (!site || r.site === site) && Number(r.log_on.slice(0, 4)) === yr &&
    (!ql || `${r.area ?? ''} ${r.task ?? ''} ${r.strain ?? ''} ${r.method ?? ''} ${r.spray_type ?? ''} ${r.notes ?? ''} ${r.products.map(p => p.product).join(' ')}`.toLowerCase().includes(ql)))
  const cost = (r: OpsLog) => r.products.reduce((a, l) => a + (lineCost(l, pmap.get(l.product.toLowerCase())) ?? 0), 0)
  const hrs = (r: OpsLog) => (r.crew ?? 1) * (r.hours ?? 0)
  // year > month > week
  const months = new Map<number, Map<number, OpsLog[]>>()
  for (const r of shown) {
    const m = Number(r.log_on.slice(5, 7)) - 1, w = isoWeek(r.log_on).week
    const mm = months.get(m) ?? months.set(m, new Map()).get(m)!
    ;(mm.get(w) ?? mm.set(w, []).get(w)!).push(r)
  }
  const first = months.size ? `${yr}-${[...months.keys()][0]}` : ''
  const isOpen = (k: string) => (opened ?? new Set([first])).has(k)
  const toggle = (k: string) => setOpened(s => { const x = new Set(s ?? [first]); if (x.has(k)) x.delete(k); else x.add(k); return x })
  const labor = kind === 'labor'
  const cols = labor ? (field ? 8 : 9) : (kind === 'spray' ? 9 : 9) + (sites.length > 1 ? 1 : 0)
  const head = labor
    ? field ? <tr><th>Date</th>{sites.length > 1 && <th>Site</th>}<th>Task</th><th>Where</th><th className="num">People</th><th className="num">Hours</th><th className="num">Person-hrs</th><th className="hide-s">Equipment</th><th className="hide-s">Notes</th></tr>
      : <tr><th>Date</th>{sites.length > 1 && <th>Site</th>}<th>Task</th><th>Strain</th><th className="num">Qty</th><th className="num">People</th><th className="num">Hours</th><th className="num">Per person-hr</th>{wage ? <th className="num">Cost / each</th> : <th />}<th className="hide-s">Notes</th></tr>
    : <tr><th>Date</th>{sites.length > 1 && <th>Site</th>}<th>Where</th>{field && <th className="num">Acres</th>}<th>{kind === 'spray' ? 'Type' : 'Method'}</th><th>Products</th>
      <th className="num">{kind === 'feed' && field ? 'Solution gal' : 'Water gal'}</th>{!field && <th className="hide-s">By</th>}<th className="num">Cost</th><th className="hide-s">Notes</th></tr>
  const row = (r: OpsLog) => labor
    ? field ? <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{md(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.task}</td><td>{r.area}</td>
        <td className="num">{r.crew ?? ''}</td><td className="num">{num(r.hours, 2)}</td><td className="num">{num(hrs(r), 1)}</td><td className="hide-s small">{r.equipment}</td><td className="hide-s small">{r.notes?.replace('[import FarmData2026]', '').trim()}</td></tr>
      : <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{md(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.task}</td><td>{r.strain}</td>
        <td className="num">{num(r.qty)}</td><td className="num">{r.crew ?? ''}</td><td className="num">{num(r.hours, 2)}</td><td className="num">{r.qty && hrs(r) ? num(r.qty / hrs(r)) : ''}</td>
        <td className="num">{wage && r.qty && hrs(r) ? `$${(hrs(r) * wage / r.qty).toFixed(3)}` : ''}</td><td className="hide-s small">{r.notes}</td></tr>
    : <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{md(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.area}</td>{field && <td className="num">{num(r.acres, 1)}</td>}
      <td>{kind === 'spray' ? <span className={`pill ${/pest|sulfur/i.test(r.spray_type ?? '') || r.products.some(l => pmap.get(l.product.toLowerCase())?.pesticide) ? 'warnp' : ''}`}>{r.spray_type ?? r.method ?? 'Spray'}</span> : (r.recipe ?? r.method)}</td>
      <td className="small">{r.products.map(l => `${l.product}${l.rate != null ? ` ${num(l.rate, 2)} ${l.unit ?? ''}${(l.basis ?? 'acre') === 'acre' && field ? '/ac' : ''}` : ''}`).join(', ')}</td>
      <td className="num">{num(r.water_gal)}</td>{!field && <td className="hide-s">{r.applicator}</td>}<td className="num">{cost(r) ? money(cost(r)) : ''}</td>
      <td className="hide-s small">{r.notes?.replace('[import FarmData2026]', '').trim()}</td></tr>
  const sumLine = (rs: OpsLog[]) => labor ? `${rs.length} · ${num(rs.reduce((a, r) => a + hrs(r), 0), 1)} person-hrs`
    : `${rs.length} ${rs.length === 1 ? 'log' : 'logs'}${field ? ` · ${num(rs.reduce((a, r) => a + (r.acres ?? 0), 0), 1)} acres` : ''}${rs.some(cost) ? ` · ${money(rs.reduce((a, r) => a + cost(r), 0))}` : ''}`
  const newLog = (k: LogKind) => setOpen({ kind: k, module, site: site ?? sites[0], log_on: new Date().toISOString().slice(0, 10), products: [],
    method: k === 'feed' ? (field ? 'Fertigation' : 'Foliar feed') : k === 'spray' ? 'Foliar' : null })
  return <div className="opslogs">
    <div className="row toolbar between">
      <div className="row wrap">
        <div className="seg">{(['spray', 'feed', 'labor'] as LogKind[]).map(k => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
          {extraTab && <button className={kind === 'extra' ? 'on' : ''} onClick={() => setKind('extra')}>{extraTab.l}</button>}
          <button className={kind === 'recipes' ? 'on' : ''} onClick={() => setKind('recipes')}>Recipes</button></div>
        {kind !== 'extra' && kind !== 'recipes' && <>
          <select value={yr} onChange={e => setYear(Number(e.target.value))}>{(years.length ? years : [yr]).map(y => <option key={y} value={y}>{y}</option>)}</select>
          {sites.length > 1 && <div className="seg">{[null, ...sites].map(s => <button key={s ?? 'all'} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s ?? 'All'}</button>)}</div>}
          <input className="search" type="search" placeholder="Field, product, task" value={q} onChange={e => setQ(e.target.value)} />
        </>}
      </div>
      {kind !== 'extra' && kind !== 'recipes' && <button className="primary" onClick={() => newLog(kind)}>+ {KIND_LABEL[kind]} log</button>}
    </div>
    {kind === 'extra' && extraTab?.node}
    {kind === 'recipes' && <Recipes sb={sb} module={module} recipes={recipes} products={products} canEdit={!!canEditRecipes} flash={flash} onChanged={load} />}
    {kind !== 'extra' && kind !== 'recipes' && (!shown.length ? <p className="muted">No {KIND_LABEL[kind].toLowerCase()} logs in {yr}.</p> : <>
      <div className="cwrap"><table className="ctable logtable">
        <thead>{head}</thead>
        <tbody>{[...months.entries()].map(([m, weeks]) => {
          const mk = `${yr}-${m}`, mrows = [...weeks.values()].flat()
          return <Fragment key={mk}>
            <tr className="mhead" onClick={() => toggle(mk)}><td colSpan={cols + 1}><b>{isOpen(mk) ? '▾' : '▸'} {MONTHS[m]} {yr}</b> <span className="muted">· {sumLine(mrows)}</span></td></tr>
            {isOpen(mk) && [...weeks.entries()].map(([w, rs]) => {
              const mon = isoWeek(rs[0].log_on).monday
              return <Fragment key={`${mk}-${w}`}>
                <tr className="wk"><td colSpan={cols + 1}>Week {w} <span className="muted">· {md(mon)} to {md(addD(mon, 6))} · {sumLine(rs)}</span></td></tr>
                {rs.map(row)}
              </Fragment>
            })}
          </Fragment>
        })}</tbody>
      </table></div>
      {!labor && <ProductTotals rows={shown} pmap={pmap} label={`${yr}${site ? ` · ${site}` : ''}`} />}
      {labor && !field && <LaborTotals rows={shown} wage={wage} />}
    </>)}
    {open && <LogSheet sb={sb} x0={open} field={field} sites={sites} areas={[...new Set([...areas, ...rows.map(r => r.area).filter((a): a is string => !!a)])]} strains={strains} products={products} recipes={recipes.filter(r => r.active)} batches={batches} flash={flash}
      fieldAcres={fieldAcres} onClose={() => setOpen(null)} onSaved={async m => { setOpen(null); await load(); flash(m) }} />}
  </div>
}

/** what went on this year: each product's total and cost (pesticide use at a glance) */
function ProductTotals({ rows, pmap, label }: { rows: OpsLog[]; pmap: Map<string, Product>; label: string }) {
  const t = new Map<string, { name: string; unit: string; total: number; cost: number; logs: number; pest: boolean }>()
  for (const r of rows) for (const l of r.products) {
    if (!l.product) continue
    const k = `${l.product.toLowerCase()}|${unitKey(l.total_unit)}`
    const p = pmap.get(l.product.toLowerCase())
    const g = t.get(k) ?? t.set(k, { name: l.product, unit: l.total_unit ?? '', total: 0, cost: 0, logs: 0, pest: !!p?.pesticide }).get(k)!
    g.total += l.total ?? 0; g.cost += lineCost(l, p) ?? 0; g.logs++
  }
  const xs = [...t.values()].sort((a, b) => Number(b.pest) - Number(a.pest) || b.cost - a.cost || a.name.localeCompare(b.name))
  if (!xs.length) return null
  return <details className="ptotals"><summary><b>Product totals</b> <span className="muted">· {label} · {xs.length} products{xs.some(x => x.cost) ? ` · ${money(xs.reduce((a, x) => a + x.cost, 0))}` : ''}</span></summary>
    <div className="cwrap tight"><table className="ctable"><thead><tr><th>Product</th><th className="num">Total</th><th className="num">Logs</th><th className="num">Cost</th></tr></thead>
      <tbody>{xs.map(x => <tr key={x.name + x.unit}><td>{x.name}{x.pest && <span className="pill warnp"> pesticide</span>}</td><td className="num">{num(x.total, 1)} {x.unit}</td><td className="num">{x.logs}</td><td className="num">{x.cost ? money(x.cost) : ''}</td></tr>)}</tbody>
    </table></div></details>
}

function LaborTotals({ rows, wage }: { rows: OpsLog[]; wage?: number }) {
  const by = new Map<string, { qty: number; hrs: number }>()
  for (const r of rows) { const g = by.get(r.task ?? 'Other') ?? by.set(r.task ?? 'Other', { qty: 0, hrs: 0 }).get(r.task ?? 'Other')!; g.qty += r.qty ?? 0; g.hrs += (r.crew ?? 1) * (r.hours ?? 0) }
  return <div className="calcbox">{[...by.entries()].map(([t, g]) => <Fragment key={t}><span>{t}</span><b>{num(g.qty)} in {num(g.hrs, 1)} person-hrs{g.hrs && g.qty ? ` · ${num(g.qty / g.hrs)}/hr` : ''}{wage && g.qty ? ` · $${(g.hrs * wage / g.qty).toFixed(3)} each` : ''}</b></Fragment>)}</div>
}

function LogSheet({ sb, x0, field, sites, areas, strains, products, recipes, batches, flash, fieldAcres, onClose, onSaved }: {
  sb: SupabaseClient; x0: Partial<OpsLog>; field: boolean; sites: string[]; areas: string[]; strains: string[]; products: Product[]; recipes: Recipe[]
  batches?: { id: number; label: string; strain: string }[]; flash: Flash; fieldAcres?: Record<string, number>; onClose: () => void; onSaved: (m: string) => Promise<void>
}) {
  const basis: Basis = field ? 'acre' : 'gal'
  const blank = (): ProductLine => ({ product: '', rate: null, unit: null, basis, total: null, total_unit: null })
  const tag = /^\[import [^\]]+\]/.exec(x0.notes ?? '')?.[0] ?? ''
  const [x, setX] = useState<Partial<OpsLog>>({ ...x0, notes: tag ? (x0.notes ?? '').slice(tag.length).trim() : x0.notes, products: x0.products?.length ? x0.products : x0.kind === 'labor' ? [] : [blank()] })
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const pmap = useMemo(() => new Map(products.map(p => [p.name.toLowerCase(), p])), [products])
  const retotal = (s: Partial<OpsLog>): Partial<OpsLog> => ({ ...s, products: (s.products ?? []).map(l => ({ ...l, total: lineTotal(l, s, basis), total_unit: l.unit })) })
  const set = (v: Partial<OpsLog>) => setX(s => retotal({ ...s, ...v }))
  const setLine = (i: number, v: Partial<ProductLine>) => setX(s => {
    const ps = [...(s.products ?? [])]; let l = { ...ps[i], ...v }
    if (v.product !== undefined) { const p = pmap.get((v.product ?? '').toLowerCase()); if (p) l = { ...l, manufacturer: p.manufacturer, ...(l.rate == null ? { rate: p.rate, unit: p.rate_unit ? p.rate_unit.replace(/\/.*$/, '') : l.unit } : {}) } }
    ps[i] = l; return retotal({ ...s, products: ps })
  })
  const useRecipe = (name: string) => {
    const r = recipes.find(z => z.name === name); if (!r) return
    setX(s => retotal({ ...s, recipe: r.name, method: r.method ?? s.method, water_gal: r.water_per_acre && s.acres ? Math.round(r.water_per_acre * s.acres) : s.water_gal,
      products: r.products.map(l => ({ ...l, basis: l.basis ?? basis, total: null, total_unit: l.unit })) }))
  }
  const labor = x.kind === 'labor'
  const cost = (x.products ?? []).reduce((a, l) => a + (lineCost(l, pmap.get(l.product.toLowerCase())) ?? 0), 0)
  const pest = (x.products ?? []).filter(l => pmap.get(l.product.toLowerCase())?.pesticide)
  async function save() {
    setBusy(true)
    try {
      const ps = (x.products ?? []).filter(l => l.product.trim())
      const fresh = ps.filter(l => !pmap.has(l.product.trim().toLowerCase()))
      if (fresh.length) await sb.from('input_products').insert(fresh.map(l => ({ name: l.product.trim(), rate: l.rate, rate_unit: l.unit ? `${l.unit}/${l.basis ?? basis}` : null })))
      const row = { module: x.module, kind: x.kind, site: x.site, area: x.area || null, log_on: x.log_on, start_at: x.start_at || null, end_at: x.end_at || null, sqft: x.sqft ?? null,
        spray_type: x.spray_type || null, water_gal: x.water_gal ?? null, applicator: x.applicator || null, products: ps, task: x.task || null, strain: x.strain || null,
        batch_id: x.batch_id ?? null, qty: x.qty ?? null, crew: x.crew ?? null, hours: x.hours ?? null, notes: [tag, x.notes].filter(Boolean).join(' ') || null,
        method: x.method || null, acres: x.acres ?? null, run_min: x.run_min ?? null, equipment: x.equipment || null, recipe: x.recipe || null }
      const { error } = x.id ? await sb.from('ops_logs').update(row).eq('id', x.id) : await sb.from('ops_logs').insert(row)
      if (error) throw new Error(error.message.includes('column') ? 'Run 032_logs_recipes.sql in Supabase first' : error.message)
      await onSaved(x.id ? 'Log saved' : `${KIND_LABEL[x.kind!]} logged`)
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  async function del() {
    setBusy(true)
    const { error } = await sb.from('ops_logs').delete().eq('id', x.id!)
    setBusy(false)
    if (error) flash(error.message, true); else await onSaved('Log deleted')
  }
  const inp = (k: keyof OpsLog, type = 'text', ph = '') => <input type={type} value={(x[k] as string | number | null) ?? ''} placeholder={ph}
    onChange={e => set({ [k]: type === 'number' ? n(e.target.value) : e.target.value } as Partial<OpsLog>)} />
  const where = (v: string) => set({ area: v, ...(fieldAcres?.[v] != null && x.acres == null ? { acres: fieldAcres[v] } : {}) })
  const myRecipes = recipes.filter(r => r.kind === x.kind)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form csheet wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{x.id ? `${KIND_LABEL[x.kind!]} log` : `New ${KIND_LABEL[x.kind!].toLowerCase()} log`}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="grid3">
          <div className="field"><label>Date</label>{inp('log_on', 'date')}</div>
          {sites.length > 1 && <div className="field"><label>Site</label><select value={x.site} onChange={e => set({ site: e.target.value })}>{sites.map(s => <option key={s}>{s}</option>)}</select></div>}
          {(!labor || field) && <div className="field"><label>{field ? 'Field / block' : 'Where'}</label><input list="ops-areas" value={x.area ?? ''} onChange={e => where(e.target.value)} placeholder={field ? 'Block 6, Field 8A…' : 'Webb, GH, Hoops 1-4…'} />
            <datalist id="ops-areas">{areas.map(a => <option key={a} value={a} />)}</datalist></div>}
          {field && !labor && <div className="field"><label>Acres</label>{inp('acres', 'number')}</div>}
          {x.kind === 'spray' && <div className="field"><label>Type</label><select value={x.spray_type ?? ''} onChange={e => set({ spray_type: e.target.value })}><option value="">—</option>{SPRAY_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>}
          {x.kind === 'feed' && <div className="field"><label>Method</label><select value={x.method ?? ''} onChange={e => set({ method: e.target.value })}><option value="">—</option>{FEED_METHODS.map(t => <option key={t}>{t}</option>)}</select></div>}
          {!labor && myRecipes.length > 0 && <div className="field"><label>Recipe</label><select value={x.recipe ?? ''} onChange={e => e.target.value ? useRecipe(e.target.value) : set({ recipe: null })}><option value="">—</option>{myRecipes.map(r => <option key={r.id}>{r.name}</option>)}</select></div>}
          {!labor && <div className="field"><label>{x.method === 'Fertigation' ? 'Solution (gal)' : 'Water (gal)'}</label>{inp('water_gal', 'number')}</div>}
          {x.method === 'Fertigation' && <div className="field"><label>Run time (min)</label>{inp('run_min', 'number')}</div>}
          {!labor && !field && <div className="field"><label>Start</label>{inp('start_at', 'time')}</div>}
          {!labor && !field && <div className="field"><label>End</label>{inp('end_at', 'time')}</div>}
          {!labor && !field && <div className="field"><label>Area (sq ft)</label>{inp('sqft', 'number')}</div>}
          {!labor && <div className="field"><label>{x.kind === 'spray' ? 'Applicator' : 'By'}</label>{inp('applicator')}</div>}
          {labor && <div className="field"><label>Task</label><input list="ops-tasks" value={x.task ?? ''} onChange={e => set({ task: e.target.value })} /><datalist id="ops-tasks">{(field ? FIELD_TASKS : TASKS).map(t => <option key={t} value={t} />)}</datalist></div>}
          {labor && !field && <div className="field"><label>Strain</label><input list="ops-strains" value={x.strain ?? ''} onChange={e => set({ strain: e.target.value })} /><datalist id="ops-strains">{strains.map(s => <option key={s} value={s} />)}</datalist></div>}
          {labor && batches && <div className="field"><label>Batch</label><select value={x.batch_id ?? ''} onChange={e => { const b = batches.find(v => v.id === Number(e.target.value)); set({ batch_id: b?.id ?? null, ...(b && !x.strain ? { strain: b.strain } : {}) }) }}>
            <option value="">—</option>{batches.filter(b => !x.strain || b.strain.toLowerCase() === x.strain.toLowerCase()).map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select></div>}
          {labor && !field && <div className="field"><label>How many (clones, plants)</label>{inp('qty', 'number')}</div>}
          {labor && <div className="field"><label>People</label>{inp('crew', 'number')}</div>}
          {labor && <div className="field"><label>Hours (each)</label>{inp('hours', 'number')}</div>}
          {labor && field && <div className="field"><label>Equipment / tools</label>{inp('equipment', 'text', '6130M JD / cultivator')}</div>}
        </div>
        {!labor && <>
          <h3>Products <span className="muted small">rate per {basis === 'acre' ? 'acre' : 'gallon of water'}</span></h3>
          <datalist id="ops-products">{products.filter(p => p.active).map(p => <option key={p.id} value={p.name}>{p.manufacturer ?? ''}</option>)}</datalist>
          {(x.products ?? []).map((l, i) => <div key={i} className="row prodline">
            <input list="ops-products" value={l.product} placeholder="Product" onChange={e => setLine(i, { product: e.target.value })} />
            <input type="number" value={l.rate ?? ''} placeholder="Rate" onChange={e => setLine(i, { rate: n(e.target.value) })} />
            <input value={l.unit ?? ''} placeholder={field ? 'gal, lb, fl oz' : 'mL'} onChange={e => setLine(i, { unit: e.target.value })} />
            <span className="muted small">{l.total != null ? `= ${num(l.total, 1)} ${l.total_unit ?? ''}` : ''}{(() => { const c = lineCost(l, pmap.get(l.product.toLowerCase())); return c ? ` · ${money(c)}` : '' })()}</span>
            <button className="ghost small" onClick={() => setX(s => ({ ...s, products: (s.products ?? []).filter((_, j) => j !== i) }))}>✕</button>
          </div>)}
          <div className="row"><button className="ghost small" onClick={() => setX(s => ({ ...s, products: [...(s.products ?? []), blank()] }))}>+ Product</button>
            {cost > 0 && <span className="muted small">Cost {money(cost)}{x.acres ? ` · ${money(cost / x.acres)}/acre` : ''}</span>}</div>
          {pest.length > 0 && <p className="warn-t small-note">Pesticide: {pest.map(l => l.product).join(', ')}. Record the applicator and times for the use report.</p>}
        </>}
        <div className="field"><label>Notes</label>{inp('notes')}</div>
        <div className="row between csave">
          {x.id ? (sure ? <span className="row"><button className="ghost danger" disabled={busy} onClick={del}>Yes, delete</button><button className="ghost small" onClick={() => setSure(false)}>Keep</button></span>
            : <button className="ghost" onClick={() => setSure(true)}>Delete</button>) : <span />}
          <div className="row"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !x.log_on} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
        </div>
      </div>
    </div>
  )
}

/** recipes: a named product list with rates (Admins edit) */
function Recipes({ sb, module, recipes, products, canEdit, flash, onChanged }: { sb: SupabaseClient; module: string; recipes: Recipe[]; products: Product[]; canEdit: boolean; flash: Flash; onChanged: () => void }) {
  const [ed, setEd] = useState<Partial<Recipe> | null>(null)
  const [busy, setBusy] = useState(false)
  const pmap = new Map(products.map(p => [p.name.toLowerCase(), p]))
  const perAcre = (r: Partial<Recipe>) => (r.products ?? []).reduce((a, l) => a + (lineCost({ ...l, total: l.rate, total_unit: l.unit }, pmap.get(l.product.toLowerCase())) ?? 0), 0)
  async function save() {
    setBusy(true)
    const row = { module, kind: ed!.kind ?? 'feed', name: ed!.name!.trim(), method: ed!.method || null, stage: ed!.stage || null, water_per_acre: ed!.water_per_acre ?? null,
      products: (ed!.products ?? []).filter(l => l.product.trim()), active: ed!.active !== false }
    const { error } = ed!.id ? await sb.from('ops_recipes').update(row).eq('id', ed!.id) : await sb.from('ops_recipes').insert(row)
    setBusy(false)
    if (error) flash(error.message, true); else { setEd(null); onChanged(); flash('Recipe saved') }
  }
  return <>
    <div className="row toolbar between"><span className="muted">Pick a recipe on a log to fill its products and rates.</span>
      {canEdit && <button className="primary" onClick={() => setEd({ kind: 'feed', products: [{ product: '', rate: null, unit: null, basis: 'acre', total: null, total_unit: null }] })}>+ Recipe</button>}</div>
    {!recipes.length && <p className="muted">No recipes yet.</p>}
    <div className="dlist">{recipes.map(r => <button key={r.id} className={`drow click ${r.active ? '' : 'off'}`} onClick={() => canEdit && setEd(r)}>
      <span className="grow"><b>{r.name}</b><span className="muted"> · {r.kind === 'spray' ? 'Spray' : 'Feed'}{r.method ? ` · ${r.method}` : ''}{r.water_per_acre ? ` · ${r.water_per_acre} gal water/acre` : ''}</span>
        <div className="small muted">{r.products.map(l => `${l.product} ${num(l.rate, 2)} ${l.unit ?? ''}`).join(', ')}</div></span>
      {perAcre(r) > 0 && <b>{money(perAcre(r))}/acre</b>}</button>)}</div>
    {ed && <div className="scrim" onClick={() => setEd(null)}><div className="sheet form csheet wide" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2>{ed.id ? ed.name : 'New recipe'}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
      <div className="grid3">
        <div className="field"><label>Name</label><input value={ed.name ?? ''} onChange={e => setEd({ ...ed, name: e.target.value })} /></div>
        <div className="field"><label>For</label><select value={ed.kind} onChange={e => setEd({ ...ed, kind: e.target.value as 'spray' | 'feed' })}><option value="feed">Feed</option><option value="spray">Spray</option></select></div>
        <div className="field"><label>Method</label><input list="r-methods" value={ed.method ?? ''} onChange={e => setEd({ ...ed, method: e.target.value })} /><datalist id="r-methods">{[...FEED_METHODS, 'Foliar'].map(m => <option key={m} value={m} />)}</datalist></div>
        <div className="field"><label>Stage</label><input value={ed.stage ?? ''} onChange={e => setEd({ ...ed, stage: e.target.value })} placeholder="Vegetative, Flower…" /></div>
        <div className="field"><label>Water gal / acre</label><input type="number" value={ed.water_per_acre ?? ''} onChange={e => setEd({ ...ed, water_per_acre: n(e.target.value) })} /></div>
      </div>
      <datalist id="ops-products">{products.map(p => <option key={p.id} value={p.name} />)}</datalist>
      {(ed.products ?? []).map((l, i) => <div key={i} className="row prodline">
        <input list="ops-products" value={l.product} placeholder="Product" onChange={e => setEd({ ...ed, products: ed.products!.map((z, j) => j === i ? { ...z, product: e.target.value } : z) })} />
        <input type="number" value={l.rate ?? ''} placeholder="Rate" onChange={e => setEd({ ...ed, products: ed.products!.map((z, j) => j === i ? { ...z, rate: n(e.target.value) } : z) })} />
        <input value={l.unit ?? ''} placeholder="unit" onChange={e => setEd({ ...ed, products: ed.products!.map((z, j) => j === i ? { ...z, unit: e.target.value } : z) })} />
        <button className="ghost small" onClick={() => setEd({ ...ed, products: ed.products!.filter((_, j) => j !== i) })}>✕</button></div>)}
      <button className="ghost small" onClick={() => setEd({ ...ed, products: [...(ed.products ?? []), { product: '', rate: null, unit: null, basis: module === 'nursery' ? 'gal' : 'acre', total: null, total_unit: null }] })}>+ Product</button>
      <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> <span>In use</span></label>
      <div className="row between csave"><span />{<div className="row"><button className="ghost" onClick={() => setEd(null)}>Cancel</button><button className="primary" disabled={busy || !ed.name?.trim()} onClick={save}>Save</button></div>}</div>
    </div></div>}
  </>
}
