import type { SupabaseClient } from '@supabase/supabase-js'
import type { CPallet, CWeight, CSite, CField, CTest, CultData, CultSettings, CultTable, Demand, Harvest, LogRow, NurseryOrder, Pick, PlanData, PlanRow, Planting, Protocol, Receipt, StrainLite, YieldHist } from './types'

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
  constructor(public sb: SupabaseClient) {}

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
        .select('*').in('harvest_id', chunk).range(a, b)))
    }
    const settings: CultSettings = {
      sampleWeekday: Number(st.get('cult.sample_weekday') ?? 4),
      labs: (st.get('cult.labs') ?? '').split('|').map(s => s.trim()).filter(Boolean),
      equipment: (st.get('cult.equipment') ?? 'Swather|Merger|Combine|Stripper Header').split('|'),
      readyDays: Number(st.get('cult.ready_days') ?? 2),
      bufferPct: Number(st.get('cult.buffer_pct') ?? 0),
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
      all<NurseryOrder>((a, b) => this.sb.from('cult_nursery_orders').select('*').eq('crop_year', year).not('site', 'is', null).order('deliver_on').range(a, b)),
      all<Receipt>((a, b) => this.sb.from('cult_receipts').select('*').eq('crop_year', year).order('received_on').range(a, b)),
      all<YieldHist>((a, b) => this.sb.from('cult_yield_history').select('*').range(a, b)),
      all<{ strain: string; crop_year: number; kind: string; plants: number | null; ff_lbs: number | null }>((a, b) =>
        this.sb.from('cult_harvest_actuals').select('strain,crop_year,kind,plants,ff_lbs').eq('kind', 'ff').range(a, b)),
    ])
    // that crop's reserves (Admin and Sales can read them; others get null)
    let reserves: Map<string, number> | null = null
    const requested = new Map<string, number>()
    const { data, error } = await this.sb.from('reserves').select('strain,lbs').eq('crop_year', year)
    if (!error && data) {
      reserves = new Map()
      for (const r of data as { strain: string; lbs: number }[]) reserves.set(r.strain, (reserves.get(r.strain) ?? 0) + Number(r.lbs))
      const q = await this.sb.from('reserve_requests').select('strain,requested_lbs,current_lbs').eq('crop_year', year).eq('status', 'pending')
      for (const r of (q.data ?? []) as { strain: string; requested_lbs: number; current_lbs: number }[])
        requested.set(r.strain, (requested.get(r.strain) ?? 0) + Number(r.requested_lbs) - Number(r.current_lbs))
    }
    return {
      year, reserves, requested,
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

  async removeMany(table: CultTable, ids: number[]) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await this.sb.from(table).delete().in('id', ids.slice(i, i + 200))
      fail(error)
    }
  }

  async updateMany(table: CultTable, ids: number[], patch: object) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await this.sb.from(table).update(patch).in('id', ids.slice(i, i + 200))
      fail(error)
    }
  }

  async remove(table: CultTable, id: number) {
    const { error } = await this.sb.from(table).delete().eq('id', id)
    fail(error)
  }

  async addPallets(harvestId: number, rows: { lbs: number; tag: string; code?: string; boxes?: number | null; partial?: boolean }[]): Promise<string[]> {
    const { data, error } = await this.sb.rpc('cult_add_pallets', { p_harvest: harvestId, p_rows: rows })
    fail(error)
    return (data ?? []) as string[]
  }

  async setSetting(key: string, value: string) {
    const { error } = await this.sb.rpc('set_cult_setting', { p_key: key, p_value: value })
    fail(error)
  }

  // ---------- Harvest screen (026) ----------
  async weights(harvestId: number): Promise<CWeight[]> {
    const { data, error } = await this.sb.from('cult_weights').select('*').eq('harvest_id', harvestId).order('id')
    if (error && /cult_weights/.test(error.message)) throw new Error('Run 026_harvest_logging.sql in Supabase first')
    fail(error); return ((data ?? []) as CWeight[]).map(w => ({ ...w, lbs: Number(w.lbs) }))
  }
  async logWeight(harvestId: number, kind: 'raw' | 'tote' | 'dry', lbs: number, tag?: string | null) {
    const { error } = await this.sb.rpc('cult_log_weight', { p_harvest: harvestId, p_kind: kind, p_lbs: lbs, p_tag: tag ?? null, p_note: null }); fail(error)
  }
  async removeWeight(id: number) { const { error } = await this.sb.rpc('cult_remove_weight', { p_id: id }); fail(error) }
  async startHarvest(harvestId: number) { const { error } = await this.sb.rpc('cult_start', { p_harvest: harvestId }); fail(error) }
  async startDrying(harvestId: number, date: string | null, acres: number | null) {
    const { error } = await this.sb.rpc('cult_start_drying', { p_harvest: harvestId, p_date: date, p_acres: acres }); fail(error)
  }
  async reopen(harvestId: number) { const { error } = await this.sb.rpc('cult_reopen', { p_harvest: harvestId }); if (error) throw new Error(/cult_reopen/.test(error.message) ? 'Run 042_finished_harvests.sql in Supabase first' : error.message) }
  async finish(harvestId: number, plants: number | null, notes: string | null) {
    const { error } = await this.sb.rpc('cult_finish', { p_harvest: harvestId, p_plants: plants, p_notes: notes }); fail(error)
  }
  async removePallet(palletId: number) { const { error } = await this.sb.rpc('cult_remove_pallet', { p_pallet: palletId }); fail(error) }
  async nextTags(site: string, n = 6): Promise<string[]> {
    const { data, error } = await this.sb.rpc('next_tags', { p_site: site, p_purpose: 'harvest', p_count: n }); return error ? [] : (data ?? []) as string[]
  }

  async log(limit = 150): Promise<LogRow[]> {
    const { data, error } = await this.sb.from('cult_log').select('*').order('at', { ascending: false }).limit(limit)
    fail(error)
    return (data ?? []) as LogRow[]
  }
}
