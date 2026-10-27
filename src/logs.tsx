import { ListInput, Select } from './combo'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { pageAll } from './pageAll'
import type { ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MONTHS_ES, MONTHS_LONG_ES, lang, t, tn } from './i18n'

// Spray, feed and labor logs, shared by Production and the Nursery (each sees its own).
// Production works like Farm Data OHR: rates per acre x acres; the Nursery mixes per gallon of water.
// Everything is grouped by year, month and calendar week.
type Flash = (t: string, bad?: boolean) => void
export type LogKind = 'spray' | 'feed' | 'labor'
type Basis = 'acre' | 'gal'
/** CCOF (Compliance, 055): warn when a product isn't approved, or its listing had expired on the log date */
function ccofWarn(name: string, pmap: Map<string, Product>, on: string | null | undefined): string | null {
  const k = name.trim().toLowerCase(); if (!k) return null
  const p = pmap.get(k) as (Product & { ccof_status?: string; listing_expires?: string | null }) | undefined
  if (!p) return [...pmap.values()].some(x => 'ccof_status' in x) ? t('Not on the product list, so not CCOF approved yet. Check with Compliance before using it.') : null
  if (!('ccof_status' in p)) return null
  if (p.ccof_status === 'not_allowed') return t('Not allowed by CCOF. Check with Compliance before using it.')
  if (p.ccof_status !== 'approved') return t('Not CCOF approved yet. Check with Compliance before using it.')
  if (p.listing_expires && on && p.listing_expires < on) return t('Its CCOF listing had expired on this date. Tell Compliance.')
  return null
}
interface ProductLine { product: string; manufacturer?: string | null; rate: number | null; unit: string | null; basis?: Basis; total: number | null; total_unit: string | null }
export interface OpsLog {
  id: number; module: string; kind: LogKind; site: string; area: string | null; log_on: string; start_at: string | null; end_at: string | null
  sqft: number | null; spray_type: string | null; water_gal: number | null; applicator: string | null; products: ProductLine[]
  task: string | null; strain: string | null; batch_id: number | null; qty: number | null; crew: number | null; hours: number | null; notes: string | null; created_by: string | null
  method: string | null; acres: number | null; run_min: number | null; equipment: string | null; recipe: string | null
}
interface Product {
  id: number; module?: string; name: string; manufacturer: string | null; rate: number | null; rate_unit: string | null; kind: string | null; active: boolean; price: number | null; price_unit: string | null; pesticide: boolean
  full_name?: string | null; form?: string | null; npk?: string | null; nutrients?: string | null; notes?: string | null; label_url?: string | null; epa_reg?: string | null
  rei_hours?: number | null; phi_days?: number | null; active_ingredient?: string | null
}
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
const md = (s: string) => { const [, m, d] = s.split('-'); return lang() === 'es' ? `${Number(d)} ${MONTHS_ES[Number(m) - 1]}` : `${Number(m)}/${Number(d)}` }
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

export function OpsLogs({ sb, module, sites, areas, strains, flash, batches, wage, extraTabs, fieldAcres, canEditRecipes }: {
  sb: SupabaseClient; module: 'nursery' | 'cultivation'; sites: string[]; areas: string[]; strains: string[]; flash: Flash
  batches?: { id: number; label: string; strain: string }[]; wage?: number; extraTabs?: { k: string; l: string; node: ReactNode }[]
  fieldAcres?: Record<string, number>; canEditRecipes?: boolean
}) {
  const field = module === 'cultivation'
  const [kind, setKind] = useState<LogKind | 'extra' | 'recipes' | 'products'>('spray')
  const [extraK, setExtraK] = useState<string | null>(null)
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
      pageAll((a, b) => sb.from('ops_logs').select('*').eq('module', module).order('log_on', { ascending: false }).order('id', { ascending: false }).range(a, b)),
      sb.from('input_products').select('*').eq('module', module).order('name').then(r => (r.error ? sb.from('input_products').select('*').order('name') : r)),
      sb.from('ops_recipes').select('*').eq('module', module).order('sort'),
    ])
    if (l.error) { setErr(/ops_logs/.test(l.error.message) ? t('Logs need 031 and 032 run in Supabase.') : l.error.message); return }
    setRows((l.data ?? []).map(x => ({ ...x, products: x.products ?? [], sqft: n(x.sqft), water_gal: n(x.water_gal), qty: n(x.qty), hours: n(x.hours), acres: n(x.acres), run_min: n(x.run_min) })) as OpsLog[])
    setProducts(((p.data ?? []) as Product[]).map(x => ({ ...x, price: n(x.price) })))
    setRecipes(r.error ? [] : (r.data ?? []) as Recipe[]); setErr(null)
  }, [sb, module])
  useEffect(() => { load() }, [load])
  const pmap = useMemo(() => new Map(products.map(p => [p.name.toLowerCase(), p])), [products])
  if (err) return <div className="warnbox">{err}</div>
  if (!rows) return <p className="muted">{t('Loading…')}</p>
  const years = [...new Set(rows.map(r => Number(r.log_on.slice(0, 4))))].sort((a, b) => b - a)
  const yr = year ?? years[0] ?? new Date().getFullYear()
  const ql = q.trim().toLowerCase()
  const shown = kind === 'extra' || kind === 'recipes' || kind === 'products' ? [] : rows.filter(r => r.kind === kind && (!site || r.site === site) && Number(r.log_on.slice(0, 4)) === yr &&
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
    ? field ? <tr><th>{t('Date')}</th>{sites.length > 1 && <th>{t('Site')}</th>}<th>{t('Task')}</th><th>{t('Where')}</th><th className="num">{t('People')}</th><th className="num">{t('Hours')}</th><th className="num">{t('Person-hrs')}</th><th className="hide-s">{t('Equipment')}</th><th className="hide-s">{t('Notes')}</th></tr>
      : <tr><th>{t('Date')}</th>{sites.length > 1 && <th>{t('Site')}</th>}<th>{t('Task')}</th><th>{t('Strain')}</th><th className="num">{t('Qty')}</th><th className="num">{t('People')}</th><th className="num">{t('Hours')}</th><th className="num">{t('Per person-hr')}</th>{wage ? <th className="num">{t('Cost / each')}</th> : <th />}<th className="hide-s">{t('Notes')}</th></tr>
    : <tr><th>{t('Date')}</th>{sites.length > 1 && <th>{t('Site')}</th>}<th>{t('Where')}</th>{field && <th className="num">{t('Acres')}</th>}<th>{t(kind === 'spray' ? 'Type' : 'Method')}</th><th>{t('Products')}</th>
      <th className="num">{t(kind === 'feed' && field ? 'Solution gal' : 'Water gal')}</th>{!field && <th className="hide-s">{t('By')}</th>}<th className="num">{t('Cost')}</th><th className="hide-s">{t('Notes')}</th></tr>
  const row = (r: OpsLog) => labor
    ? field ? <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{md(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.task ? t(r.task) : ''}</td><td>{r.area}</td>
        <td className="num">{r.crew ?? ''}</td><td className="num">{num(r.hours, 2)}</td><td className="num">{num(hrs(r), 1)}</td><td className="hide-s small">{r.equipment}</td><td className="hide-s small">{r.notes?.replace('[import FarmData2026]', '').trim()}</td></tr>
      : <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{md(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.task ? t(r.task) : ''}</td><td>{r.strain}</td>
        <td className="num">{num(r.qty)}</td><td className="num">{r.crew ?? ''}</td><td className="num">{num(r.hours, 2)}</td><td className="num">{r.qty && hrs(r) ? num(r.qty / hrs(r)) : ''}</td>
        <td className="num">{wage && r.qty && hrs(r) ? `$${(hrs(r) * wage / r.qty).toFixed(3)}` : ''}</td><td className="hide-s small">{r.notes}</td></tr>
    : <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{md(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.area}</td>{field && <td className="num">{num(r.acres, 1)}</td>}
      <td>{kind === 'spray' ? <span className={`pill ${/pest|sulfur/i.test(r.spray_type ?? '') || r.products.some(l => pmap.get(l.product.toLowerCase())?.pesticide) ? 'warnp' : ''}`}>{t(r.spray_type ?? r.method ?? 'Spray')}</span> : (r.recipe ?? (r.method ? t(r.method) : ''))}</td>
      <td className="small">{r.products.map(l => `${l.product}${l.rate != null ? ` ${num(l.rate, 2)} ${l.unit ?? ''}${(l.basis ?? 'acre') === 'acre' && field ? '/ac' : ''}` : ''}`).join(', ')}</td>
      <td className="num">{num(r.water_gal)}</td>{!field && <td className="hide-s">{r.applicator}</td>}<td className="num">{cost(r) ? money(cost(r)) : ''}</td>
      <td className="hide-s small">{r.notes?.replace('[import FarmData2026]', '').trim()}</td></tr>
  const sumLine = (rs: OpsLog[]) => labor ? `${rs.length} · ${num(rs.reduce((a, r) => a + hrs(r), 0), 1)} ${t('person-hrs')}`
    : `${tn(rs.length, '{n} log', '{n} logs')}${field ? ` · ${num(rs.reduce((a, r) => a + (r.acres ?? 0), 0), 1)} ${t('acres')}` : ''}${rs.some(cost) ? ` · ${money(rs.reduce((a, r) => a + cost(r), 0))}` : ''}`
  const newLog = (k: LogKind) => setOpen({ kind: k, module, site: site ?? sites[0], log_on: new Date().toISOString().slice(0, 10), products: [],
    method: k === 'feed' ? (field ? 'Fertigation' : 'Foliar feed') : k === 'spray' ? 'Foliar' : null })
  return <div className="opslogs">
    <div className="row toolbar between">
      <div className="row wrap">
        <div className="seg">{(['spray', 'feed', 'labor'] as LogKind[]).map(k => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t(KIND_LABEL[k])}</button>)}
          {extraTabs?.map(x => <button key={x.k} className={kind === 'extra' && extraK === x.k ? 'on' : ''} onClick={() => { setKind('extra'); setExtraK(x.k) }}>{x.l}</button>)}
          <button className={kind === 'recipes' ? 'on' : ''} onClick={() => setKind('recipes')}>{t('Recipes')}</button>
          <button className={kind === 'products' ? 'on' : ''} onClick={() => setKind('products')}>{t('Products')}</button></div>
        {kind !== 'extra' && kind !== 'recipes' && kind !== 'products' && <>
          <Select value={yr} onChange={e => setYear(Number(e.target.value))}>{(years.length ? years : [yr]).map(y => <option key={y} value={y}>{y}</option>)}</Select>
          {sites.length > 1 && <div className="seg">{[null, ...sites].map(s => <button key={s ?? 'all'} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s ?? t('All')}</button>)}</div>}
          <input className="search" type="search" placeholder={t('Field, product, task')} value={q} onChange={e => setQ(e.target.value)} />
        </>}
      </div>
      {kind !== 'extra' && kind !== 'recipes' && kind !== 'products' && <button className="primary" onClick={() => newLog(kind)}>{t('+ ' + KIND_LABEL[kind] + ' log')}</button>}
    </div>
    {kind === 'extra' && extraTabs?.find(x => x.k === extraK)?.node}
    {kind === 'products' && <Products sb={sb} module={module} products={products} logs={rows} canEdit={!!canEditRecipes} field={field} flash={flash} onChanged={load} />}
    {kind === 'recipes' && <Recipes sb={sb} module={module} recipes={recipes} products={products} canEdit={!!canEditRecipes} flash={flash} onChanged={load} />}
    {kind !== 'extra' && kind !== 'recipes' && kind !== 'products' && (!shown.length ? <p className="muted">{t('No ' + KIND_LABEL[kind].toLowerCase() + ' logs in {yr}.', { yr })}</p> : <>
      <div className="cwrap"><table className="ctable logtable">
        <thead>{head}</thead>
        <tbody>{[...months.entries()].map(([m, weeks]) => {
          const mk = `${yr}-${m}`, mrows = [...weeks.values()].flat()
          return <Fragment key={mk}>
            <tr className="mhead" onClick={() => toggle(mk)}><td colSpan={cols + 1}><b>{isOpen(mk) ? '▾' : '▸'} {lang() === 'es' ? MONTHS_LONG_ES[m] : MONTHS[m]} {yr}</b> <span className="muted">· {sumLine(mrows)}</span></td></tr>
            {isOpen(mk) && [...weeks.entries()].map(([w, rs]) => {
              const mon = isoWeek(rs[0].log_on).monday
              return <Fragment key={`${mk}-${w}`}>
                <tr className="wk"><td colSpan={cols + 1}>{t('Week {w}', { w })} <span className="muted">· {t('{a} to {b}', { a: md(mon), b: md(addD(mon, 6)) })} · {sumLine(rs)}</span></td></tr>
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
  const tot = new Map<string, { name: string; unit: string; total: number; cost: number; logs: number; pest: boolean }>()
  for (const r of rows) for (const l of r.products) {
    if (!l.product) continue
    const k = `${l.product.toLowerCase()}|${unitKey(l.total_unit)}`
    const p = pmap.get(l.product.toLowerCase())
    const g = tot.get(k) ?? tot.set(k, { name: l.product, unit: l.total_unit ?? '', total: 0, cost: 0, logs: 0, pest: !!p?.pesticide }).get(k)!
    g.total += l.total ?? 0; g.cost += lineCost(l, p) ?? 0; g.logs++
  }
  const xs = [...tot.values()].sort((a, b) => Number(b.pest) - Number(a.pest) || b.cost - a.cost || a.name.localeCompare(b.name))
  if (!xs.length) return null
  return <details className="ptotals"><summary><b>{t('Product totals')}</b> <span className="muted">· {label} · {t('{n} products', { n: xs.length })}{xs.some(x => x.cost) ? ` · ${money(xs.reduce((a, x) => a + x.cost, 0))}` : ''}</span></summary>
    <div className="cwrap tight"><table className="ctable"><thead><tr><th>{t('Product')}</th><th className="num">{t('Total')}</th><th className="num">{t('Logs')}</th><th className="num">{t('Cost')}</th></tr></thead>
      <tbody>{xs.map(x => <tr key={x.name + x.unit}><td>{x.name}{x.pest && <span className="pill warnp"> {t('pesticide')}</span>}</td><td className="num">{num(x.total, 1)} {x.unit}</td><td className="num">{x.logs}</td><td className="num">{x.cost ? money(x.cost) : ''}</td></tr>)}</tbody>
    </table></div></details>
}

function LaborTotals({ rows, wage }: { rows: OpsLog[]; wage?: number }) {
  const by = new Map<string, { qty: number; hrs: number }>()
  for (const r of rows) { const g = by.get(r.task ?? 'Other') ?? by.set(r.task ?? 'Other', { qty: 0, hrs: 0 }).get(r.task ?? 'Other')!; g.qty += r.qty ?? 0; g.hrs += (r.crew ?? 1) * (r.hours ?? 0) }
  return <div className="calcbox">{[...by.entries()].map(([k, g]) => <Fragment key={k}><span>{t(k)}</span><b>{t('{q} in {h} person-hrs', { q: num(g.qty), h: num(g.hrs, 1) })}{g.hrs && g.qty ? ` · ${num(g.qty / g.hrs)}/${t('hr')}` : ''}{wage && g.qty ? ` · $${(g.hrs * wage / g.qty).toFixed(3)} ${t('each')}` : ''}</b></Fragment>)}</div>
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
  // CCOF checks only where the site is certified (Compliance > Settings > Sites; 056). Unknown: Production yes, Nursery no.
  const [certs, setCerts] = useState<Record<string, boolean> | null>(null)
  useEffect(() => { sb.from('comp_certs').select('site,ccof').then(r => { if (!r.error) setCerts(Object.fromEntries(((r.data ?? []) as { site: string; ccof: boolean }[]).map(c => [c.site.toUpperCase(), c.ccof]))) }, () => {}) }, [])
  const certSite = (x.site ?? (x.module === 'nursery' ? '1PN' : '')).toUpperCase()
  const certified = certs?.[certSite] ?? x.module !== 'nursery'
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
      if (fresh.length) await sb.from('input_products').insert(fresh.map(l => ({ module: x.module, name: l.product.trim(), rate: l.rate, rate_unit: l.unit ? `${l.unit}/${l.basis ?? basis}` : null })))
      const row = { module: x.module, kind: x.kind, site: x.site, area: x.area || null, log_on: x.log_on, start_at: x.start_at || null, end_at: x.end_at || null, sqft: x.sqft ?? null,
        spray_type: x.spray_type || null, water_gal: x.water_gal ?? null, applicator: x.applicator || null, products: ps, task: x.task || null, strain: x.strain || null,
        batch_id: x.batch_id ?? null, qty: x.qty ?? null, crew: x.crew ?? null, hours: x.hours ?? null, notes: [tag, x.notes].filter(Boolean).join(' ') || null,
        method: x.method || null, acres: x.acres ?? null, run_min: x.run_min ?? null, equipment: x.equipment || null, recipe: x.recipe || null }
      const { error } = x.id ? await sb.from('ops_logs').update(row).eq('id', x.id) : await sb.from('ops_logs').insert(row)
      if (error) throw new Error(error.message.includes('column') ? t('Run 032_logs_recipes.sql in Supabase first') : error.message)
      await onSaved(x.id ? t('Log saved') : t(KIND_LABEL[x.kind!] + ' logged'))
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  async function del() {
    setBusy(true)
    const { error } = await sb.from('ops_logs').delete().eq('id', x.id!)
    setBusy(false)
    if (error) flash(error.message, true); else await onSaved(t('Log deleted'))
  }
  const inp = (k: keyof OpsLog, type = 'text', ph = '') => <input type={type} value={(x[k] as string | number | null) ?? ''} placeholder={ph}
    onChange={e => set({ [k]: type === 'number' ? n(e.target.value) : e.target.value } as Partial<OpsLog>)} />
  const where = (v: string) => set({ area: v, ...(fieldAcres?.[v] != null && x.acres == null ? { acres: fieldAcres[v] } : {}) })
  const myRecipes = recipes.filter(r => r.kind === x.kind)
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form csheet wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{t(x.id ? KIND_LABEL[x.kind!] + ' log' : 'New ' + KIND_LABEL[x.kind!].toLowerCase() + ' log')}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="grid3">
          <div className="field"><label>{t('Date')}</label>{inp('log_on', 'date')}</div>
          {sites.length > 1 && <div className="field"><label>{t('Site')}</label><Select value={x.site} onChange={e => set({ site: e.target.value })}>{sites.map(s => <option key={s}>{s}</option>)}</Select></div>}
          {(!labor || field) && <div className="field"><label>{t(field ? 'Field / block' : 'Where')}</label><ListInput list="ops-areas" value={x.area ?? ''} onChange={e => where(e.target.value)} placeholder={field ? t('Block 6, Field 8A…') : t('Webb, GH, Hoops 1-4…')} />
            <datalist id="ops-areas">{areas.map(a => <option key={a} value={a} />)}</datalist></div>}
          {field && !labor && <div className="field"><label>{t('Acres')}</label>{inp('acres', 'number')}</div>}
          {x.kind === 'spray' && <div className="field"><label>{t('Type')}</label><Select value={x.spray_type ?? ''} onChange={e => set({ spray_type: e.target.value })}><option value="">—</option>{SPRAY_TYPES.map(o => <option key={o} value={o}>{t(o)}</option>)}</Select></div>}
          {x.kind === 'feed' && <div className="field"><label>{t('Method')}</label><Select value={x.method ?? ''} onChange={e => set({ method: e.target.value })}><option value="">—</option>{FEED_METHODS.map(o => <option key={o} value={o}>{t(o)}</option>)}</Select></div>}
          {!labor && myRecipes.length > 0 && <div className="field"><label>{t('Recipe')}</label><Select value={x.recipe ?? ''} onChange={e => e.target.value ? useRecipe(e.target.value) : set({ recipe: null })}><option value="">—</option>{myRecipes.map(r => <option key={r.id}>{r.name}</option>)}</Select></div>}
          {!labor && <div className="field"><label>{t(x.method === 'Fertigation' ? 'Solution (gal)' : 'Water (gal)')}</label>{inp('water_gal', 'number')}</div>}
          {x.method === 'Fertigation' && <div className="field"><label>{t('Run time (min)')}</label>{inp('run_min', 'number')}</div>}
          {!labor && !field && <div className="field"><label>{t('Start')}</label>{inp('start_at', 'time')}</div>}
          {!labor && !field && <div className="field"><label>{t('End')}</label>{inp('end_at', 'time')}</div>}
          {!labor && !field && <div className="field"><label>{t('Area (sq ft)')}</label>{inp('sqft', 'number')}</div>}
          {!labor && <div className="field"><label>{t(x.kind === 'spray' ? 'Applicator' : 'By')}</label>{inp('applicator')}</div>}
          {labor && <div className="field"><label>{t('Task')}</label><ListInput list="ops-tasks" value={x.task ?? ''} onChange={e => set({ task: e.target.value })} /><datalist id="ops-tasks">{(field ? FIELD_TASKS : TASKS).map(o => <option key={o} value={o}>{lang() === 'es' ? t(o) : ''}</option>)}</datalist></div>}
          {labor && !field && <div className="field"><label>{t('Strain')}</label><ListInput list="ops-strains" value={x.strain ?? ''} onChange={e => set({ strain: e.target.value })} /><datalist id="ops-strains">{strains.map(s => <option key={s} value={s} />)}</datalist></div>}
          {labor && batches && <div className="field"><label>{t('Batch')}</label><Select value={x.batch_id ?? ''} onChange={e => { const b = batches.find(v => v.id === Number(e.target.value)); set({ batch_id: b?.id ?? null, ...(b && !x.strain ? { strain: b.strain } : {}) }) }}>
            <option value="">—</option>{batches.filter(b => !x.strain || b.strain.toLowerCase() === x.strain.toLowerCase()).map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</Select></div>}
          {labor && !field && <div className="field"><label>{t('How many (clones, plants)')}</label>{inp('qty', 'number')}</div>}
          {labor && <div className="field"><label>{t('People')}</label>{inp('crew', 'number')}</div>}
          {labor && <div className="field"><label>{t('Hours (each)')}</label>{inp('hours', 'number')}</div>}
          {labor && field && <div className="field"><label>{t('Equipment / tools')}</label>{inp('equipment', 'text', '6130M JD / cultivator')}</div>}
        </div>
        {!labor && <>
          <h3>{t('Products')} <span className="muted small">{t(basis === 'acre' ? 'rate per acre' : 'rate per gallon of water')}</span></h3>
          <datalist id="ops-products">{products.filter(p => p.active).map(p => <option key={p.id} value={p.name}>{p.manufacturer ?? ''}</option>)}</datalist>
          {(x.products ?? []).map((l, i) => <div key={i} className="row prodline">
            <ListInput list="ops-products" value={l.product} placeholder={t('Product')} onChange={e => setLine(i, { product: e.target.value })} />
            <input type="number" value={l.rate ?? ''} placeholder={t('Rate')} onChange={e => setLine(i, { rate: n(e.target.value) })} />
            <input value={l.unit ?? ''} placeholder={field ? 'gal, lb, fl oz' : 'mL'} onChange={e => setLine(i, { unit: e.target.value })} />
            <span className="muted small">{l.total != null ? `= ${num(l.total, 1)} ${l.total_unit ?? ''}` : ''}{(() => { const c = lineCost(l, pmap.get(l.product.toLowerCase())); return c ? ` · ${money(c)}` : '' })()}</span>
            <button className="ghost small" onClick={() => setX(s => ({ ...s, products: (s.products ?? []).filter((_, j) => j !== i) }))}>✕</button>
            {(() => { const w = certified ? ccofWarn(l.product, pmap, x.log_on) : null; return w ? <div className="warn-t small prodwarn">{w}</div> : null })()}
          </div>)}
          <div className="row"><button className="ghost small" onClick={() => setX(s => ({ ...s, products: [...(s.products ?? []), blank()] }))}>{t('+ Product')}</button>
            {cost > 0 && <span className="muted small">{t('Cost')} {money(cost)}{x.acres ? ` · ${money(cost / x.acres)}/${t('acre')}` : ''}</span>}</div>
          {pest.length > 0 && <p className="warn-t small-note">{t('Pesticide')}: {pest.map(l => l.product).join(', ')}. {t('Record the applicator and times for the use report.')}</p>}
        </>}
        <div className="field"><label>{t('Notes')}</label>{inp('notes')}</div>
        <div className="row between csave">
          {x.id ? (sure ? <span className="row"><button className="ghost danger" disabled={busy} onClick={del}>{t('Yes, delete')}</button><button className="ghost small" onClick={() => setSure(false)}>{t('Keep')}</button></span>
            : <button className="ghost" onClick={() => setSure(true)}>{t('Delete')}</button>) : <span />}
          <div className="row"><button className="ghost" onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={busy || !x.log_on} onClick={save}>{busy ? t('Saving…') : t('Save')}</button></div>
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
    if (error) flash(error.message, true); else { setEd(null); onChanged(); flash(t('Recipe saved')) }
  }
  return <>
    <div className="row toolbar between"><span className="muted">{t('Pick a recipe on a log to fill its products and rates.')}</span>
      {canEdit && <button className="primary" onClick={() => setEd({ kind: 'feed', products: [{ product: '', rate: null, unit: null, basis: 'acre', total: null, total_unit: null }] })}>{t('+ Recipe')}</button>}</div>
    {!recipes.length && <p className="muted">{t('No recipes yet.')}</p>}
    <div className="dlist">{recipes.map(r => <button key={r.id} className={`drow click ${r.active ? '' : 'off'}`} onClick={() => canEdit && setEd(r)}>
      <span className="grow"><b>{r.name}</b><span className="muted"> · {t(r.kind === 'spray' ? 'Spray' : 'Feed')}{r.method ? ` · ${t(r.method)}` : ''}{r.water_per_acre ? ` · ${t('{n} gal water/acre', { n: r.water_per_acre })}` : ''}</span>
        <div className="small muted">{r.products.map(l => `${l.product} ${num(l.rate, 2)} ${l.unit ?? ''}`).join(', ')}</div></span>
      {perAcre(r) > 0 && <b>{money(perAcre(r))}/{t('acre')}</b>}</button>)}</div>
    {ed && <div className="scrim" onClick={() => setEd(null)}><div className="sheet form csheet wide" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2>{ed.id ? ed.name : t('New recipe')}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
      <div className="grid3">
        <div className="field"><label>{t('Name')}</label><input value={ed.name ?? ''} onChange={e => setEd({ ...ed, name: e.target.value })} /></div>
        <div className="field"><label>{t('For')}</label><Select value={ed.kind} onChange={e => setEd({ ...ed, kind: e.target.value as 'spray' | 'feed' })}><option value="feed">{t('Feed')}</option><option value="spray">{t('Spray')}</option></Select></div>
        <div className="field"><label>{t('Method')}</label><ListInput list="r-methods" value={ed.method ?? ''} onChange={e => setEd({ ...ed, method: e.target.value })} /><datalist id="r-methods">{[...FEED_METHODS, 'Foliar'].map(m => <option key={m} value={m} />)}</datalist></div>
        <div className="field"><label>{t('Stage')}</label><input value={ed.stage ?? ''} onChange={e => setEd({ ...ed, stage: e.target.value })} placeholder={t('Vegetative, Flower…')} /></div>
        <div className="field"><label>{t('Water gal / acre')}</label><input type="number" value={ed.water_per_acre ?? ''} onChange={e => setEd({ ...ed, water_per_acre: n(e.target.value) })} /></div>
      </div>
      <datalist id="ops-products">{products.map(p => <option key={p.id} value={p.name} />)}</datalist>
      {(ed.products ?? []).map((l, i) => <div key={i} className="row prodline">
        <ListInput list="ops-products" value={l.product} placeholder={t('Product')} onChange={e => setEd({ ...ed, products: ed.products!.map((z, j) => j === i ? { ...z, product: e.target.value } : z) })} />
        <input type="number" value={l.rate ?? ''} placeholder={t('Rate')} onChange={e => setEd({ ...ed, products: ed.products!.map((z, j) => j === i ? { ...z, rate: n(e.target.value) } : z) })} />
        <input value={l.unit ?? ''} placeholder={t('unit')} onChange={e => setEd({ ...ed, products: ed.products!.map((z, j) => j === i ? { ...z, unit: e.target.value } : z) })} />
        <button className="ghost small" onClick={() => setEd({ ...ed, products: ed.products!.filter((_, j) => j !== i) })}>✕</button></div>)}
      <button className="ghost small" onClick={() => setEd({ ...ed, products: [...(ed.products ?? []), { product: '', rate: null, unit: null, basis: module === 'nursery' ? 'gal' : 'acre', total: null, total_unit: null }] })}>{t('+ Product')}</button>
      <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> <span>{t('In use')}</span></label>
      <div className="row between csave"><span />{<div className="row"><button className="ghost" onClick={() => setEd(null)}>{t('Cancel')}</button><button className="primary" disabled={busy || !ed.name?.trim()} onClick={save}>{t('Save')}</button></div>}</div>
    </div></div>}
  </>
}

/** Logs > Products: this module's own product list (rates, prices, pesticide details) and how much each was used */
function Products({ sb, module, products, logs, canEdit, field, flash, onChanged }: {
  sb: SupabaseClient; module: string; products: Product[]; logs: OpsLog[]; canEdit: boolean; field: boolean; flash: Flash; onChanged: () => void
}) {
  const [ed, setEd] = useState<Partial<Product> | null>(null)
  const [q, setQ] = useState('')
  const [f, setF] = useState<'all' | 'pest' | 'off'>('all')
  const [busy, setBusy] = useState(false)
  const yr = new Date().getFullYear()
  const use = useMemo(() => {
    const m = new Map<string, { n: number; last: string; total: number; unit: string; cost: number }>()
    for (const r of logs) for (const l of r.products) {
      if (!l.product) continue
      const k = l.product.toLowerCase(), g = m.get(k) ?? { n: 0, last: '', total: 0, unit: l.total_unit ?? '', cost: 0 }
      g.n++; if (r.log_on > g.last) g.last = r.log_on
      if (r.log_on.startsWith(String(yr)) && l.total != null && unitKey(l.total_unit) === unitKey(g.unit)) g.total += l.total
      m.set(k, g)
    }
    return m
  }, [logs, yr])
  const ql = q.trim().toLowerCase()
  const shown = products.filter(p => (f === 'all' ? p.active : f === 'pest' ? p.pesticide && p.active : !p.active) &&
    (!ql || `${p.name} ${p.manufacturer ?? ''} ${p.full_name ?? ''} ${p.form ?? p.kind ?? ''} ${p.npk ?? ''}`.toLowerCase().includes(ql)))
    .sort((a, b) => (use.get(b.name.toLowerCase())?.n ?? 0) - (use.get(a.name.toLowerCase())?.n ?? 0) || a.name.localeCompare(b.name))
  const per = field ? 'acre' : 'gal'
  async function save() {
    if (!ed?.name?.trim()) return
    setBusy(true)
    const row = { module, name: ed.name.trim(), manufacturer: ed.manufacturer || null, full_name: ed.full_name || null, form: ed.form || null, kind: ed.form || ed.kind || null,
      npk: ed.npk || null, nutrients: ed.nutrients || null, rate: ed.rate ?? null, rate_unit: ed.rate_unit || null, price: ed.price ?? null, price_unit: ed.price_unit || null,
      pesticide: !!ed.pesticide, epa_reg: ed.epa_reg || null, rei_hours: ed.rei_hours ?? null, phi_days: ed.phi_days ?? null, active_ingredient: ed.active_ingredient || null,
      label_url: ed.label_url || null, notes: ed.notes || null, active: ed.active !== false }
    const { error } = ed.id ? await sb.from('input_products').update(row).eq('id', ed.id) : await sb.from('input_products').insert(row)
    setBusy(false)
    if (error) flash(/duplicate|unique/.test(error.message) ? t('There\'s already a product with that name') : /module|column/.test(error.message) ? t('Run 037_products.sql in Supabase first') : error.message, true)
    else { setEd(null); onChanged(); flash(t('Product saved')) }
  }
  const txt = (k: keyof Product, label: string, ph = '') => <div className="field"><label>{t(label)}</label>
    <input value={(ed?.[k] as string | null) ?? ''} placeholder={ph} disabled={!canEdit} onChange={e => setEd({ ...ed, [k]: e.target.value })} /></div>
  const nm = (k: keyof Product, label: string) => <div className="field"><label>{t(label)}</label>
    <input type="number" value={(ed?.[k] as number | null) ?? ''} disabled={!canEdit} onChange={e => setEd({ ...ed, [k]: n(e.target.value) })} /></div>
  return <>
    <div className="row toolbar between">
      <div className="row wrap">
        <div className="seg">{([['all', t('In use')], ['pest', t('Pesticides')], ['off', t('Not used anymore')]] as const).map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
        <input className="search" type="search" placeholder={t('Product, maker, N-P-K')} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {canEdit && <button className="primary" onClick={() => setEd({ active: true, rate_unit: field ? 'fl oz/acre' : 'mL/gal' })}>{t('+ Product')}</button>}
    </div>
    <p className="muted small-note">{t(field ? 'Production\'s products. Rates are per acre. Used = times on a log; the total is this year.' : 'The Nursery\'s products. Rates are per gallon of water. Used = times on a log; the total is this year.')}</p>
    {!shown.length ? <p className="muted">{t('No products here.')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>{t('Product')}</th><th className="hide-s">{t('Maker')}</th><th className="hide-s">{t('Type')}</th><th>{t('N-P-K')}</th><th className="num">{t('Rate')}</th>
        <th className="num hide-s">{t('Price')}</th><th className="num">{t('Used')}</th><th className="hide-s">{t('Last used')}</th><th className="num hide-s">{t('{y} total', { y: yr })}</th></tr></thead>
      <tbody>{shown.map(p => { const u = use.get(p.name.toLowerCase()); return (
        <tr key={p.id} className="tap" onClick={() => setEd(p)}>
          <td><b>{p.name}</b>{p.pesticide && <span className="pill warnp"> {t('pesticide')}</span>}</td><td className="hide-s small">{p.manufacturer}</td>
          <td className="hide-s small">{p.form ?? p.kind}</td><td className="small">{p.npk}</td>
          <td className="num nowrap">{p.rate != null ? `${num(p.rate, 2)} ${p.rate_unit ?? ''}` : ''}</td>
          <td className="num hide-s nowrap">{p.price != null ? `$${num(p.price, 2)}/${p.price_unit ?? ''}` : ''}</td>
          <td className="num">{u?.n ?? ''}</td><td className="hide-s nowrap">{u?.last ? md(u.last) + (u.last.startsWith(String(yr)) ? '' : ` ${u.last.slice(0, 4)}`) : ''}</td>
          <td className="num hide-s nowrap">{u?.total ? `${num(u.total, 1)} ${u.unit}` : ''}</td></tr>) })}</tbody>
    </table></div>}
    {ed && <div className="scrim" onClick={() => setEd(null)}><div className="sheet form csheet wide" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2>{ed.id ? ed.name : t('New product')}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
      {!canEdit && <p className="muted">{t('Only an Admin of this module can change products.')}</p>}
      <div className="grid3">
        {txt('name', 'Name')}{txt('manufacturer', 'Maker')}{txt('full_name', 'Full product name')}
        {txt('form', 'Type / form', 'Liquid, WDG…')}{txt('npk', 'N-P-K', '2-7-0.3')}{txt('nutrients', 'Other nutrients', 'Calcium 5%, Boron…')}
        {nm('rate', 'Typical rate')}{txt('rate_unit', 'Rate unit', `mL/${per}`)}<div />
        {nm('price', 'Price ($)')}{txt('price_unit', 'Price per', 'gal, lb, fl oz')}<div />
      </div>
      <label className="check"><input type="checkbox" disabled={!canEdit} checked={!!ed.pesticide} onChange={e => setEd({ ...ed, pesticide: e.target.checked })} /> <span><b>{t('Pesticide')}</b> <span className="muted">{t('flags it on logs for the use report')}</span></span></label>
      {ed.pesticide && <div className="grid3">{txt('epa_reg', 'EPA reg #')}{txt('active_ingredient', 'Active ingredient')}<div />{nm('rei_hours', 'REI (hours)')}{nm('phi_days', 'PHI (days)')}</div>}
      {txt('label_url', 'Label / SDS link', 'https://…')}
      {ed.label_url && /^https?:/.test(ed.label_url) && <p className="small-note"><a href={ed.label_url} target="_blank" rel="noreferrer">{t('Open the label')} ↗</a></p>}
      {txt('notes', 'Notes')}
      {(() => { const u = ed.name ? use.get(ed.name.toLowerCase()) : undefined; return u ? <p className="muted small-note">{t('On {n} logs, last {date}.', { n: u.n, date: md(u.last) })}</p> : null })()}
      <label className="check"><input type="checkbox" disabled={!canEdit} checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> <span>{t('In use')}</span></label>
      <div className="row between csave"><span />{canEdit ? <div className="row"><button className="ghost" onClick={() => setEd(null)}>{t('Cancel')}</button><button className="primary" disabled={busy || !ed.name?.trim()} onClick={save}>{busy ? t('Saving…') : t('Save')}</button></div>
        : <button className="ghost" onClick={() => setEd(null)}>{t('Close')}</button>}</div>
    </div></div>}
  </>
}
