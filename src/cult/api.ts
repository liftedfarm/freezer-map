import type { SupabaseClient } from '@supabase/supabase-js'
import type { CPallet, CSite, CField, CTest, CultData, CultSettings, CultTable, Demand, Harvest, LogRow, NurseryOrder, Pick, PlanData, PlanRow, Planting, Protocol, Receipt, StrainLite, YieldHist } from './types'

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    fail(error)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < 1000) return out
  }
}

const num = (v: unknown) => (v == null || v === '' ? null : Number(v))
const KEY: Partial<Record<CultTable, string>> = { sites: 'code', cult_test_protocols: 'kind' }

export class CultApi {
  constructor(private sb: SupabaseClient) {}

  async load(year: number | null): Promise<CultData> {
    const settingsRows = await all<{ key: string; value: string }>((a, b) => this.sb.from('app_settings').select('key,value').range(a, b))
    const st = new Map(settingsRows.map(r => [r.key, r.value]))
    const currentYear = Number(st.get('crop_year') ?? new Date().getFullYear())
    const y = year ?? currentYear
    const [sites, fields, plantings, harvests, tests, protocols, picks, strains, yearsH, receipts] = await Promise.all([
      all<CSite>((a, b) => this.sb.from('sites').select('*').order('sort').range(a, b)),
      all<CField>((a, b) => this.sb.from('fields').select('*').order('site').order('sort').range(a, b)),
      all<Planting>((a, b) => this.sb.from('cult_plantings').select('*').eq('crop_year', y).order('planted_on').range(a, b)),
      all<Harvest>((a, b) => this.sb.from('cult_harvests').select('*').eq('crop_year', y).order('planned_on').range(a, b)),
      all<CTest>((a, b) => this.sb.from('cult_tests').select('*').eq('crop_year', y).range(a, b)),
      all<Protocol>((a, b) => this.sb.from('cult_test_protocols').select('*').range(a, b)),
      all<Pick>((a, b) => this.sb.from('cult_flower_picks').select('*').eq('crop_year', y).range(a, b)),
      all<StrainLite>((a, b) => this.sb.from('strains').select('name,aliases,roshi_name,active').order('name').range(a, b)),
      all<{ crop_year: number }>((a, b) => this.sb.from('cult_harvests').select('crop_year').range(a, b)),
      all<Receipt>((a, b) => this.sb.from('cult_receipts').select('*').eq('crop_year', y).order('received_on').range(a, b)),
    ])
    const ids = harvests.map(h => h.id)
    const pallets: CPallet[] = []
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150)
      pallets.push(...await all<CPallet>((a, b) => this.sb.from('pallets')
        .select('id,code,harvest_id,og_weight,current_weight,status,package_tag,harvest_date,slot_id,parent_id').in('harvest_id', chunk).range(a, b)))
    }
    const settings: CultSettings = {
      sampleWeekday: Number(st.get('cult.sample_weekday') ?? 4),
      labs: (st.get('cult.labs') ?? '').split('|').map(s => s.trim()).filter(Boolean),
      equipment: (st.get('cult.equipment') ?? 'Swather|Merger|Combine|Stripper Header').split('|'),
      readyDays: Number(st.get('cult.ready_days') ?? 2),
    }
    const years = [...new Set([y, currentYear, ...yearsH.map(r => r.crop_year)])].sort((a, b) => b - a)
    const fix = <T extends object>(rows: T[], keys: (keyof T)[]) => rows.map(r => { const o = { ...r }; for (const k of keys) (o as Record<string, unknown>)[k as string] = num(o[k]); return o })
    return {
      year: y, currentYear, years, settings, strains, protocols,
      sites: fix(sites, ['row_feet_per_acre', 'dry_ice_per_10lb', 'truck_raw_lbs', 'workday_hours', 'deleaf_rate', 'buck_rate', 'dry_conversion']),
      fields: fix(fields, ['acres']),
      plantings: fix(plantings, ['spacing_in', 'beds', 'acres', 'est_lbs_per_plant', 'seed_lbs']),
      harvests: fix(harvests, ['est_lbs_per_plant', 'est_raw_per_plant', 'deleaf_rate', 'buck_rate', 'dry_conversion', 'acres', 'est_yield_per_acre',
        'raw_lbs', 'ff_lbs', 'bucked_lbs', 'trim_lbs', 'mold_lbs']).map(h => ({ ...h, raw_bins: (h.raw_bins ?? []).map(Number) })),
      tests, picks: fix(picks, ['dry_lbs']), receipts,
      pallets: fix(pallets, ['og_weight', 'current_weight']),
    }
  }

  async loadPlan(year: number): Promise<PlanData> {
    const [demand, plan, orders, receipts, history, actuals] = await Promise.all([
      all<Demand>((a, b) => this.sb.from('cult_demand').select('*').eq('crop_year', year).order('strain').range(a, b)),
      all<PlanRow>((a, b) => this.sb.from('cult_plan').select('*').eq('crop_year', year).order('strain').range(a, b)),
      all<NurseryOrder>((a, b) => this.sb.from('cult_nursery_orders').select('*').eq('crop_year', year).order('deliver_on').range(a, b)),
      all<Receipt>((a, b) => this.sb.from('cult_receipts').select('*').eq('crop_year', year).order('received_on').range(a, b)),
      all<YieldHist>((a, b) => this.sb.from('cult_yield_history').select('*').range(a, b)),
      all<{ strain: string; crop_year: number; kind: string; plants: number | null; ff_lbs: number | null }>((a, b) =>
        this.sb.from('cult_harvest_actuals').select('strain,crop_year,kind,plants,ff_lbs').eq('kind', 'ff').range(a, b)),
    ])
    let reserves: Map<string, number> | null = null
    const { data, error } = await this.sb.from('reserve_balances').select('strain,reserved')
    if (!error && data) {
      reserves = new Map()
      for (const r of data as { strain: string; reserved: number }[]) reserves.set(r.strain, (reserves.get(r.strain) ?? 0) + Number(r.reserved))
    }
    return {
      year, reserves,
      demand: demand.map(d => ({ ...d, lbs: Number(d.lbs) })),
      plan: plan.map(p => ({ ...p, overage_pct: Number(p.overage_pct), spacing_in: num(p.spacing_in), est_lbs_per_plant: num(p.est_lbs_per_plant) })),
      orders, receipts,
      history: history.map(h => ({ ...h, ff_lbs: num(h.ff_lbs) })),
      actuals: actuals.filter(a => a.plants && a.ff_lbs).map(a => ({ strain: a.strain, crop_year: a.crop_year, plants: Number(a.plants), ff_lbs: Number(a.ff_lbs) })),
    }
  }

  async history(): Promise<YieldHist[]> {
    const rows = await all<YieldHist>((a, b) => this.sb.from('cult_yield_history').select('*').range(a, b))
    return rows.map(h => ({ ...h, ff_lbs: num(h.ff_lbs) }))
  }

  /** insert (no id) or update (with id); returns the saved row */
  async save<T extends object>(table: CultTable, row: Partial<T>): Promise<T> {
    const key = KEY[table] ?? 'id'
    const r = { ...row } as Record<string, unknown>
    for (const k of ['updated_at', 'updated_by', 'created_at', 'created_by']) delete r[k]
    const id = r[key]
    if (id != null && (key !== 'id' || typeof id === 'number')) {
      const { data, error } = await this.sb.from(table).update(r).eq(key, id).select().single()
      fail(error)
      return data as T
    }
    delete r.id
    const { data, error } = await this.sb.from(table).insert(r).select().single()
    fail(error)
    return data as T
  }

  async insertMany(table: CultTable, rows: object[]) {
    if (!rows.length) return
    const clean = rows.map(r => { const o = { ...r } as Record<string, unknown>; for (const k of ['id', 'updated_at', 'updated_by', 'created_at', 'created_by']) delete o[k]; return o })
    const { error } = await this.sb.from(table).insert(clean)
    fail(error)
  }

  async remove(table: CultTable, id: number) {
    const { error } = await this.sb.from(table).delete().eq('id', id)
    fail(error)
  }

  async addPallets(harvestId: number, rows: { lbs: number; tag: string; code?: string }[]): Promise<string[]> {
    const { data, error } = await this.sb.rpc('cult_add_pallets', { p_harvest: harvestId, p_rows: rows })
    fail(error)
    return (data ?? []) as string[]
  }

  async setSetting(key: string, value: string) {
    const { error } = await this.sb.rpc('set_cult_setting', { p_key: key, p_value: value })
    fail(error)
  }

  async log(limit = 150): Promise<LogRow[]> {
    const { data, error } = await this.sb.from('cult_log').select('*').order('at', { ascending: false }).limit(limit)
    fail(error)
    return (data ?? []) as LogRow[]
  }
}
