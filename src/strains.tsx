import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Fold, isAdminOf } from './fold'
import { STRAIN_PHOTOS } from './strainPhotos'

// Strain profile: what the app's own data says (auto) and what an Admin set by hand (overrides).
export interface StrainAuto {
  rooting_pct: number | null; rooting_n: number | null; cuts_per_plant: number | null; cuts_src: string | null
  yield_lbs_plant: number | null; yield_n: number | null; harvest_mmdd: string | null; harvest_n: number | null
}
export interface StrainSet {
  rooting_pct?: number | null; cuts_per_plant?: number | null; yield_lbs_plant?: number | null; harvest_mmdd?: string | null
  solventless_pct?: number | null; hydrocarbon_pct?: number | null; spot_price?: number | null; photo_url?: string | null; menu_note?: string | null; updated_by?: string | null; updated_at?: string | null
}
export interface StrainProfile { id: number; name: string; auto: StrainAuto; set: StrainSet }
export interface MenuInfo { name: string; solventless_pct: number | null; hydrocarbon_pct: number | null; spot_price: number | null; photo_url: string | null; menu_note: string | null; lineage: string | null }

export async function loadProfiles(sb: SupabaseClient | null): Promise<Map<number, StrainProfile>> {
  if (!sb) return new Map()
  const { data, error } = await sb.rpc('strain_profiles')
  if (error) return new Map()
  return new Map(((data ?? []) as StrainProfile[]).map(p => [p.id, p]))
}
/** menu facts by lower-case strain name (anyone signed in, customers too) */
export async function loadMenuInfo(sb: SupabaseClient | null): Promise<Map<string, MenuInfo>> {
  if (!sb) return new Map()
  const { data, error } = await sb.rpc('strain_menu_info')
  if (error) return new Map()
  return new Map(((data ?? []) as MenuInfo[]).map(m => [m.name.toLowerCase(), m]))
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const mmdd = (s: string | null | undefined) => { if (!s) return ''; const [m, d] = s.split('-').map(Number); return m ? `${MON[m - 1]} ${d}` : s }
const f1 = (x: number | null | undefined, d = 1) => (x == null ? '' : String(Math.round(Number(x) * 10 ** d) / 10 ** d))
/** effective value: override, else auto */
export const eff = <K extends keyof StrainAuto & keyof StrainSet>(p: StrainProfile | undefined, k: K) => (p?.set?.[k] ?? p?.auto?.[k] ?? null) as StrainAuto[K] | null
export function profileLine(p: StrainProfile | undefined) {
  if (!p) return ''
  const s = p.set, bits = [
    s.solventless_pct != null ? `${f1(s.solventless_pct)}% solventless` : '',
    s.hydrocarbon_pct != null ? `${f1(s.hydrocarbon_pct)}% hydrocarbon` : '',
    eff(p, 'yield_lbs_plant') != null ? `${f1(eff(p, 'yield_lbs_plant'), 2)} lbs/plant` : '',
    eff(p, 'rooting_pct') != null ? `${f1(eff(p, 'rooting_pct'), 0)}% rooting` : '',
    eff(p, 'harvest_mmdd') ? `harvest ~${mmdd(eff(p, 'harvest_mmdd') as string)}` : '',
  ]
  return bits.filter(Boolean).join(' · ')
}

type Field = { k: keyof StrainSet; l: string; unit?: string; auto?: (a: StrainAuto) => string; text?: boolean; hint?: string }
const GROUPS: { m: 'nursery' | 'cultivation' | 'sales'; l: string; fields: Field[] }[] = [
  { m: 'nursery', l: 'Nursery', fields: [
    { k: 'rooting_pct', l: 'Rooting rate', unit: '%', auto: a => a.rooting_pct != null ? `${f1(a.rooting_pct)}% from ${a.rooting_n} sorted batch${a.rooting_n === 1 ? '' : 'es'}` : '' },
    { k: 'cuts_per_plant', l: 'Cuts per plant', auto: a => a.cuts_per_plant != null ? `${f1(a.cuts_per_plant)} from ${a.cuts_src}` : '' },
  ] },
  { m: 'cultivation', l: 'Production', fields: [
    { k: 'yield_lbs_plant', l: 'Fresh frozen per plant', unit: 'lbs', auto: a => a.yield_lbs_plant != null ? `${f1(a.yield_lbs_plant, 2)} lbs from ${a.yield_n} harvest${a.yield_n === 1 ? '' : 's'}` : '' },
    { k: 'harvest_mmdd', l: 'Typical harvest date', text: true, hint: 'MM-DD', auto: a => a.harvest_mmdd ? `${mmdd(a.harvest_mmdd)} (average of ${a.harvest_n})` : '' },
  ] },
  { m: 'sales', l: 'Sales and extraction', fields: [
    { k: 'solventless_pct', l: 'Yield to solventless', unit: '%', hint: 'shows on menus' },
    { k: 'hydrocarbon_pct', l: 'Yield to hydrocarbon', unit: '%', hint: 'shows on the catalog' },
    { k: 'spot_price', l: 'Spot price', unit: '$/lb', hint: 'blank = the catalog\'s price' },
    { k: 'photo_url', l: 'Photo', text: true, hint: 'pick one of ours, or paste a link' },
    { k: 'menu_note', l: 'Menu note', text: true, hint: 'a line for the menu and catalog' },
  ] },
]

/** the strain sheet's profile: one fold per module; only that module's Admins can override */
export function StrainProfileEdit({ sb, p, flash, onSaved }: { sb: SupabaseClient | null; p: StrainProfile; flash: (t: string, bad?: boolean) => void; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(p.set ?? {}).map(([k, x]) => [k, x == null ? '' : String(x)])))
  const [busy, setBusy] = useState(false)
  async function save(m: string, fields: Field[]) {
    if (!sb) return
    const vals: Record<string, string | number | null> = {}
    for (const f of fields) {
      const s = (v[f.k] ?? '').trim()
      if (s === String(p.set?.[f.k] ?? '')) continue
      if (f.k === 'harvest_mmdd' && s && !/^\d{2}-\d{2}$/.test(s)) { flash('Harvest date looks like 10-08 (month-day)', true); return }
      vals[f.k] = s === '' ? null : f.text ? s : Number(s)
    }
    if (!Object.keys(vals).length) return
    setBusy(true)
    const { error } = await sb.rpc('set_strain_info', { p_strain: p.id, p_vals: vals })
    setBusy(false)
    if (error) flash(/set_strain_info/.test(error.message) ? 'Run 040_strains_access_pallets.sql in Supabase first' : error.message, true)
    else { flash(`${p.name}: ${m} saved`); onSaved() }
  }
  return <div className="sprofile">
    {GROUPS.map(g => {
      const can = isAdminOf(g.m), dirty = g.fields.some(f => (v[f.k] ?? '') !== String(p.set?.[f.k] ?? ''))
      return <Fold key={g.m} id={`strain.${g.m}`} title={g.l} open={g.m === 'sales'} count={can ? '' : '· view only'}>
        {g.fields.map(f => {
          const a = f.auto?.(p.auto) ?? '', over = p.set?.[f.k] != null
          return <div key={f.k} className="field sfield">
            <label>{f.l}{f.unit ? ` (${f.unit})` : ''}{f.hint && <span className="muted"> · {f.hint}</span>}</label>
            <div className="row">
              <input value={v[f.k] ?? ''} disabled={!can} list={f.k === 'photo_url' ? 'strain-photos' : undefined} inputMode={f.text ? undefined : 'decimal'} placeholder={f.auto ? (a ? 'auto' : 'no data yet') : ''}
                onChange={e => setV(s => ({ ...s, [f.k]: e.target.value }))} />
              {can && over && f.auto && <button className="ghost small" onClick={() => setV(s => ({ ...s, [f.k]: '' }))}>Use auto</button>}
            </div>
            {f.auto && <div className="muted small">{a ? `Auto: ${a}` : 'Auto: not enough data yet'}{over ? ' · overridden' : ''}</div>}
            {f.k === 'photo_url' && <datalist id="strain-photos">{STRAIN_PHOTOS.map(u => <option key={u} value={u} />)}</datalist>}
            {f.k === 'photo_url' && v.photo_url && /^(https?:|\/)/.test(v.photo_url) && <img className="sphoto" src={v.photo_url} alt={p.name} />}
          </div>
        })}
        {can ? <div className="row"><button className="primary small" disabled={busy || !dirty} onClick={() => save(g.l, g.fields)}>Save {g.l.toLowerCase()}</button></div>
          : <p className="muted small">Only a {g.l === 'Sales and extraction' ? 'Sales' : g.l} Admin can change these.</p>}
      </Fold>
    })}
    {p.set?.updated_by && <p className="muted small">Last change {p.set.updated_by.split('@')[0]}{p.set.updated_at ? ` · ${new Date(p.set.updated_at).toLocaleDateString()}` : ''}</p>}
  </div>
}
