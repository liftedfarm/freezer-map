// Cultivation module: rows as they come from the database

export type SiteCode = 'OHR' | 'GVR' | string
export type HarvestKind = 'ff' | 'dry' | 'combine' | 'strip'
export type HarvestStatus = 'planned' | 'done' | 'cancelled'
export type Source = 'clone' | 'seed' | 'auto'

export interface CSite {
  code: SiteCode; name: string; license: string | null; row_feet_per_acre: number; dry_ice_per_10lb: number; truck_raw_lbs: number
  workday_hours: number; deleaf_rate: number | null; buck_rate: number | null; dry_conversion: number; sort: number; pallet_prefix: string | null
}
export interface CField {
  id: number; site: SiteCode; code: string; name: string; aliases: string[]; acres: number | null
  kind: 'flower' | 'biomass' | 'both' | 'trials' | 'nursery'; active: boolean; notes: string | null; sort: number
}
export interface Planting {
  id: number; crop_year: number; site: SiteCode; field_id: number | null; strain: string; batch: number | null; source: Source
  nursery: string | null; planted_on: string | null; plants: number | null; plant_loss: number | null; spacing_in: number | null
  beds: number | null; acres: number | null; license: string | null; first_flower: string | null; est_lbs_per_plant: number | null
  seed_lbs: number | null; notes: string | null; updated_by?: string | null; updated_at?: string
}
export interface Harvest {
  id: number; crop_year: number; site: SiteCode; field_id: number | null; strain: string; planting_id: number | null
  kind: HarvestKind; status: HarvestStatus; planned_on: string | null; plants: number | null
  est_lbs_per_plant: number | null; est_raw_per_plant: number | null; deleaf_rate: number | null; buck_rate: number | null
  dry_conversion: number | null; acres: number | null; est_yield_per_acre: number | null; days_to_merge: number | null; days_to_harvest: number | null
  harvested_on: string | null; plants_harvested: number | null; raw_bins: number[]; raw_lbs: number | null; ff_lbs: number | null
  bucked_lbs: number | null; trim_lbs: number | null; mold_lbs: number | null; metrc_name: string | null; notes: string | null
  updated_by?: string | null; updated_at?: string
}
export interface CTest {
  id: number; crop_year: number; site: SiteCode; kind: 'area' | 'strain'; field_id: number | null; harvest_id: number | null
  lab: string | null; test_ref: string | null; sampled_on: string | null; submitted_on: string | null; results_on: string | null
  result: string | null; notes: string | null
}
export interface Protocol { kind: 'ff' | 'biomass' | 'dry'; label: string; per: string; sample: string; opens_days: number; closes_days: number; tests: string }
export interface Pick { id: number; crop_year: number; strain: string; dry_lbs: number; notes: string | null }
export interface CPallet {
  id: number; code: string; harvest_id: number; og_weight: number | null; current_weight: number | null; status: string
  package_tag: string | null; harvest_date: string | null; slot_id: number | null; parent_id: number | null
}
export interface Demand { id: number; crop_year: number; strain: string; lbs: number; notes: string | null }
export interface PlanRow {
  id: number; crop_year: number; site: SiteCode; field_id: number | null; strain: string; nursery: string | null; source: Source
  plants: number; overage_pct: number; spacing_in: number | null; est_lbs_per_plant: number | null; trial: boolean; notes: string | null
}
export interface NurseryOrder {
  id: number; crop_year: number; plan_id: number | null; site: SiteCode; strain: string; nursery: string | null; plants: number
  cut_on: string | null; deliver_on: string | null; plant_on: string | null
  status: 'planned' | 'ordered' | 'confirmed' | 'received' | 'cancelled'; notes: string | null
}
export interface Receipt {
  id: number; crop_year: number; site: SiteCode; strain: string; batch: number; nursery: string | null; source: Source
  order_id: number | null; received_on: string | null; received: number; rejected: number; notes: string | null
}
export interface YieldHist { id: number; crop_year: number; site: string; strain: string; field: string | null; plants: number | null; ff_lbs: number | null; planted_on: string | null; harvested_on: string | null }
export interface LogRow { id: number; at: string; user_email: string | null; tbl: string; row_id: number | null; op: string; data: Record<string, unknown> | null; was: Record<string, unknown> | null }
export interface StrainLite { name: string; aliases: string[] | null; roshi_name?: string | null; active?: boolean }

export interface CultSettings { sampleWeekday: number; labs: string[]; equipment: string[]; readyDays: number }

export interface CultData {
  year: number
  currentYear: number
  sites: CSite[]
  fields: CField[]
  plantings: Planting[]
  harvests: Harvest[]
  tests: CTest[]
  protocols: Protocol[]
  picks: Pick[]
  pallets: CPallet[]
  receipts: Receipt[]
  strains: StrainLite[]
  settings: CultSettings
  years: number[]
}

export interface PlanData {
  year: number
  demand: Demand[]
  plan: PlanRow[]
  orders: NurseryOrder[]
  receipts: Receipt[]
  history: YieldHist[]
  /** this year's actuals per strain, for the averages */
  actuals: { strain: string; crop_year: number; plants: number; ff_lbs: number }[]
  /** current reserves by strain (null when this user can't see reserves) */
  reserves: Map<string, number> | null
}

export type CultTable = 'cult_plantings' | 'cult_harvests' | 'cult_tests' | 'cult_flower_picks' | 'cult_demand' | 'cult_plan'
  | 'cult_nursery_orders' | 'cult_receipts' | 'fields' | 'sites' | 'cult_test_protocols'
