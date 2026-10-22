import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// Spray, feed and labor logs. Shared by the Nursery and Production modules (each sees its own).
type Flash = (t: string, bad?: boolean) => void
export type LogKind = 'spray' | 'feed' | 'labor'
interface ProductLine { product: string; rate: number | null; unit: string | null; total: number | null; total_unit: string | null }
export interface OpsLog {
  id: number; module: string; kind: LogKind; site: string; area: string | null; log_on: string; start_at: string | null; end_at: string | null
  sqft: number | null; spray_type: string | null; water_gal: number | null; applicator: string | null; products: ProductLine[]
  task: string | null; strain: string | null; batch_id: number | null; qty: number | null; crew: number | null; hours: number | null; notes: string | null; created_by: string | null
}
interface Product { id: number; name: string; manufacturer: string | null; rate: number | null; rate_unit: string | null; kind: string | null; active: boolean }

const KIND_LABEL: Record<LogKind, string> = { spray: 'Spray', feed: 'Feed', labor: 'Labor' }
const SPRAY_TYPES = ['IPM spray', 'Foliar spray', 'Sulfur spray', 'Fungicide', 'Other']
export const TASKS = ['Cut', 'Clean / manicure', 'Stick', 'Sort', 'Transplant', 'Move clones', 'Plant', 'Top', 'Other']
const n = (x: unknown) => (x == null || x === '' ? null : Number(x))
const fmt = (s: string) => { const [, m, d] = s.split('-'); return `${Number(m)}/${Number(d)}` }
const num = (x: number | null | undefined, d = 0) => (x == null || !isFinite(x) ? '' : x.toLocaleString(undefined, { maximumFractionDigits: d }))
/** rate is per gallon: mL/Gal × gallons = mL */
const totalUnit = (u: string | null) => (u ? u.split('/')[0] : null)

export function OpsLogs({ sb, module, sites, areas, strains, flash, batches, wage, extraTab }: {
  sb: SupabaseClient; module: 'nursery' | 'cultivation'; sites: string[]; areas: string[]; strains: string[]; flash: Flash
  batches?: { id: number; label: string; strain: string }[]; wage?: number; extraTab?: { k: string; l: string; node: ReactNode }
}) {
  const [kind, setKind] = useState<LogKind | 'extra'>('spray')
  const [rows, setRows] = useState<OpsLog[] | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Partial<OpsLog> | null>(null)
  const [site, setSite] = useState<string | null>(null)
  const load = useCallback(async () => {
    const [l, p] = await Promise.all([
      sb.from('ops_logs').select('*').eq('module', module).order('log_on', { ascending: false }).order('id', { ascending: false }).limit(1000),
      sb.from('input_products').select('*').order('name'),
    ])
    if (l.error) { setErr(/ops_logs/.test(l.error.message) ? 'Logs need 031_nursery_gens_logs.sql run in Supabase.' : l.error.message); return }
    setRows((l.data ?? []).map(r => ({ ...r, products: r.products ?? [], sqft: n(r.sqft), water_gal: n(r.water_gal), qty: n(r.qty), hours: n(r.hours) })) as OpsLog[])
    setProducts((p.data ?? []) as Product[]); setErr(null)
  }, [sb, module])
  useEffect(() => { load() }, [load])
  if (err) return <div className="warnbox">{err}</div>
  if (!rows) return <p className="muted">Loading…</p>
  const shown = rows.filter(r => r.kind === kind && (!site || r.site === site))
  const hrs = (r: OpsLog) => (r.crew ?? 1) * (r.hours ?? 0)
  return <div className="opslogs">
    <div className="row toolbar between">
      <div className="row wrap">
        <div className="seg">{(['spray', 'feed', 'labor'] as LogKind[]).map(k => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
          {extraTab && <button className={kind === 'extra' ? 'on' : ''} onClick={() => setKind('extra')}>{extraTab.l}</button>}</div>
        {sites.length > 1 && kind !== 'extra' && <div className="seg">{[null, ...sites].map(s => <button key={s ?? 'all'} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s ?? 'All'}</button>)}</div>}
      </div>
      {kind !== 'extra' && <button className="primary" onClick={() => setOpen({ kind, module, site: site ?? sites[0], log_on: new Date().toISOString().slice(0, 10), products: [] })}>+ {KIND_LABEL[kind]} log</button>}
    </div>
    {kind === 'extra' && extraTab?.node}
    {kind !== 'extra' && (!shown.length ? <p className="muted">No {KIND_LABEL[kind].toLowerCase()} logs yet.</p> : <div className="cwrap"><table className="ctable">
      {kind === 'labor' ? <>
        <thead><tr><th>Date</th>{sites.length > 1 && <th>Site</th>}<th>Task</th><th>Strain</th><th className="num">Qty</th><th className="num">People</th><th className="num">Hours</th><th className="num">Per person-hr</th>{wage ? <th className="num">Cost / each</th> : null}<th className="hide-s">Notes</th></tr></thead>
        <tbody>{shown.map(r => <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{fmt(r.log_on)}</td>{sites.length > 1 && <td>{r.site}</td>}<td>{r.task}</td><td>{r.strain}</td>
          <td className="num">{num(r.qty)}</td><td className="num">{r.crew ?? ''}</td><td className="num">{num(r.hours, 2)}</td><td className="num">{r.qty && hrs(r) ? num(r.qty / hrs(r)) : ''}</td>
          {wage ? <td className="num">{r.qty && hrs(r) ? `$${(hrs(r) * wage / r.qty).toFixed(3)}` : ''}</td> : null}<td className="hide-s small">{r.notes}</td></tr>)}</tbody>
      </> : <>
        <thead><tr><th>Date</th>{sites.length > 1 && <th>Site</th>}<th>Where</th>{kind === 'spray' && <th>Type</th>}<th>Products</th><th className="num">Water gal</th><th className="hide-s">By</th><th className="hide-s">Notes</th></tr></thead>
        <tbody>{shown.map(r => <tr key={r.id} className="tap" onClick={() => setOpen(r)}><td className="nowrap">{fmt(r.log_on)}{r.start_at ? <span className="muted"> {r.start_at.slice(0, 5)}</span> : ''}</td>
          {sites.length > 1 && <td>{r.site}</td>}<td>{r.area}</td>{kind === 'spray' && <td>{r.spray_type}</td>}
          <td className="small">{r.products.map(p => `${p.product}${p.rate ? ` ${p.rate} ${p.unit ?? ''}` : ''}`).join(', ')}</td><td className="num">{num(r.water_gal)}</td>
          <td className="hide-s">{r.applicator}</td><td className="hide-s small">{r.notes}</td></tr>)}</tbody>
      </>}
    </table></div>)}
    {kind === 'labor' && shown.length > 0 && <LaborTotals rows={shown} wage={wage} />}
    {open && <LogSheet sb={sb} x0={open} sites={sites} areas={areas} strains={strains} products={products} batches={batches} flash={flash}
      onClose={() => setOpen(null)} onSaved={async m => { setOpen(null); await load(); flash(m) }} />}
  </div>
}

function LaborTotals({ rows, wage }: { rows: OpsLog[]; wage?: number }) {
  const by = new Map<string, { qty: number; hrs: number }>()
  for (const r of rows) { const g = by.get(r.task ?? 'Other') ?? by.set(r.task ?? 'Other', { qty: 0, hrs: 0 }).get(r.task ?? 'Other')!; g.qty += r.qty ?? 0; g.hrs += (r.crew ?? 1) * (r.hours ?? 0) }
  return <div className="calcbox">{[...by.entries()].map(([t, g]) => <Fragment key={t}><span>{t}</span><b>{num(g.qty)} in {num(g.hrs, 1)} person-hrs{g.hrs ? ` · ${num(g.qty / g.hrs)}/hr` : ''}{wage && g.qty ? ` · $${(g.hrs * wage / g.qty).toFixed(3)} each` : ''}</b></Fragment>)}</div>
}

function LogSheet({ sb, x0, sites, areas, strains, products, batches, flash, onClose, onSaved }: {
  sb: SupabaseClient; x0: Partial<OpsLog>; sites: string[]; areas: string[]; strains: string[]; products: Product[]; batches?: { id: number; label: string; strain: string }[]
  flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void>
}) {
  const [x, setX] = useState<Partial<OpsLog>>({ ...x0, products: x0.products?.length ? x0.products : x0.kind === 'labor' ? [] : [{ product: '', rate: null, unit: null, total: null, total_unit: null }] })
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const set = (v: Partial<OpsLog>) => setX(s => ({ ...s, ...v }))
  const pmap = useMemo(() => new Map(products.map(p => [p.name.toLowerCase(), p])), [products])
  const setLine = (i: number, v: Partial<ProductLine>) => setX(s => {
    const ps = [...(s.products ?? [])]; let l = { ...ps[i], ...v }
    if (v.product !== undefined) { const p = pmap.get((v.product ?? '').toLowerCase()); if (p && l.rate == null) l = { ...l, rate: p.rate, unit: p.rate_unit } }
    if (l.rate != null && s.water_gal != null && (v.rate !== undefined || v.product !== undefined || v.unit !== undefined)) l = { ...l, total: Math.round(l.rate * s.water_gal * 100) / 100, total_unit: totalUnit(l.unit) }
    ps[i] = l; return { ...s, products: ps }
  })
  const water = (g: number | null) => setX(s => ({ ...s, water_gal: g, products: (s.products ?? []).map(l => l.rate != null && g != null ? { ...l, total: Math.round(l.rate * g * 100) / 100, total_unit: totalUnit(l.unit) } : l) }))
  const labor = x.kind === 'labor'
  async function save() {
    setBusy(true)
    try {
      const ps = (x.products ?? []).filter(l => l.product.trim())
      // new product names go on the product list
      const fresh = ps.filter(l => !pmap.has(l.product.trim().toLowerCase()))
      if (fresh.length) await sb.from('input_products').insert(fresh.map(l => ({ name: l.product.trim(), rate: l.rate, rate_unit: l.unit })))
      const row = { module: x.module, kind: x.kind, site: x.site, area: x.area || null, log_on: x.log_on, start_at: x.start_at || null, end_at: x.end_at || null, sqft: x.sqft ?? null,
        spray_type: x.spray_type || null, water_gal: x.water_gal ?? null, applicator: x.applicator || null, products: ps, task: x.task || null, strain: x.strain || null,
        batch_id: x.batch_id ?? null, qty: x.qty ?? null, crew: x.crew ?? null, hours: x.hours ?? null, notes: x.notes || null }
      const { error } = x.id ? await sb.from('ops_logs').update(row).eq('id', x.id) : await sb.from('ops_logs').insert(row)
      if (error) throw new Error(error.message)
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
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form csheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{x.id ? `${KIND_LABEL[x.kind!]} log` : `New ${KIND_LABEL[x.kind!].toLowerCase()} log`}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="grid3">
          <div className="field"><label>Date</label>{inp('log_on', 'date')}</div>
          {sites.length > 1 && <div className="field"><label>Site</label><select value={x.site} onChange={e => set({ site: e.target.value })}>{sites.map(s => <option key={s}>{s}</option>)}</select></div>}
          {!labor && <div className="field"><label>Where</label><input list="ops-areas" value={x.area ?? ''} onChange={e => set({ area: e.target.value })} placeholder="Webb, GH, Hoops 1-4…" /><datalist id="ops-areas">{areas.map(a => <option key={a} value={a} />)}</datalist></div>}
          {!labor && <div className="field"><label>Start</label>{inp('start_at', 'time')}</div>}
          {!labor && <div className="field"><label>End</label>{inp('end_at', 'time')}</div>}
          {!labor && <div className="field"><label>Area (sq ft)</label>{inp('sqft', 'number')}</div>}
          {x.kind === 'spray' && <div className="field"><label>Spray type</label><select value={x.spray_type ?? ''} onChange={e => set({ spray_type: e.target.value })}><option value="">—</option>{SPRAY_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>}
          {!labor && <div className="field"><label>Water (gal)</label><input type="number" value={x.water_gal ?? ''} onChange={e => water(n(e.target.value))} /></div>}
          {!labor && <div className="field"><label>{x.kind === 'spray' ? 'Applicator' : 'By'}</label>{inp('applicator')}</div>}
          {labor && <div className="field"><label>Task</label><select value={x.task ?? ''} onChange={e => set({ task: e.target.value })}><option value="">—</option>{TASKS.map(t => <option key={t}>{t}</option>)}</select></div>}
          {labor && <div className="field"><label>Strain</label><input list="ops-strains" value={x.strain ?? ''} onChange={e => set({ strain: e.target.value })} /><datalist id="ops-strains">{strains.map(s => <option key={s} value={s} />)}</datalist></div>}
          {labor && batches && <div className="field"><label>Batch</label><select value={x.batch_id ?? ''} onChange={e => { const b = batches.find(v => v.id === Number(e.target.value)); set({ batch_id: b?.id ?? null, ...(b && !x.strain ? { strain: b.strain } : {}) }) }}>
            <option value="">—</option>{batches.filter(b => !x.strain || b.strain.toLowerCase() === x.strain.toLowerCase()).map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select></div>}
          {labor && <div className="field"><label>How many (clones, plants)</label>{inp('qty', 'number')}</div>}
          {labor && <div className="field"><label>People</label>{inp('crew', 'number')}</div>}
          {labor && <div className="field"><label>Hours (each)</label>{inp('hours', 'number')}</div>}
        </div>
        {!labor && <>
          <h3>Products</h3>
          <datalist id="ops-products">{products.filter(p => p.active).map(p => <option key={p.id} value={p.name}>{p.manufacturer ?? ''}</option>)}</datalist>
          {(x.products ?? []).map((l, i) => <div key={i} className="row prodline">
            <input list="ops-products" value={l.product} placeholder="Product" onChange={e => setLine(i, { product: e.target.value })} />
            <input type="number" value={l.rate ?? ''} placeholder="Rate" onChange={e => setLine(i, { rate: n(e.target.value) })} />
            <input value={l.unit ?? ''} placeholder="mL/Gal" onChange={e => setLine(i, { unit: e.target.value })} />
            <span className="muted small">{l.total != null ? `= ${num(l.total, 1)} ${l.total_unit ?? ''}` : ''}</span>
            <button className="ghost small" onClick={() => setX(s => ({ ...s, products: (s.products ?? []).filter((_, j) => j !== i) }))}>✕</button>
          </div>)}
          <button className="ghost small" onClick={() => setX(s => ({ ...s, products: [...(s.products ?? []), { product: '', rate: null, unit: null, total: null, total_unit: null }] }))}>+ Product</button>
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
