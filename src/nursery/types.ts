// Nursery module: mother plants, cutting batches, clone orders and deliveries
export interface NSite { code: string; name: string; license: string | null; address: string | null; active: boolean; sort: number }
export type RoomKind = 'bench' | 'hoop' | 'trailer' | 'greenhouse' | 'veg' | 'other'
export interface NRoom {
  id: number; site: string; place: string; name: string; kind: RoomKind; active: boolean; notes: string | null; sort: number
  rented: boolean; beds: { bed: string; cap: number }[]; capacity: number | null; trays: number | null
}
export interface Mother {
  id: number; site: string; room_id: number | null; strain: string; plant_tag: string | null; started_on: string | null
  status: 'active' | 'retired' | 'destroyed'; ended_on: string | null; notes: string | null; created_at: string
  qty: number; lost: number; gen: 1 | 2 | 3; season: number | null; bed: string | null; pot: string | null; cuts_per_plant: number | null; batch_id: number | null; source?: string | null
}
export type Stage = 'rooting' | 'ready' | 'done' | 'cancelled'
export interface Batch {
  id: number; site: string; room_id: number | null; strain: string; name: string | null; order_id: number | null; cut_on: string
  cuttings: number; lost: number; ready_on: string | null; stage: Stage; tags: string[]; notes: string | null; created_at: string
  gen: 1 | 2 | 3 | 4; season: number | null; mother_id: number | null; trays: number | null; emerged_on: string | null; moved_out_on: string | null
  sort1_on: string | null; s1_vigorous: number | null; s1_minimal: number | null; s1_none: number | null; s1_dead: number | null
  sort2_on: string | null; s2_vigorous: number | null; s2_minimal: number | null; s2_none: number | null; s2_dead: number | null
}
export interface StrainPlan { strain: string; cuts_g3: number | null; cuts_g2: number | null; cuts_g1: number | null; notes: string | null }
export interface LabTest {
  id: number; site: string; strain: string; mother_id: number | null; room_id: number | null; test: string; round: number; plants: number | null; tested: number | null
  vial_from: string | null; vial_to: string | null; tested_on: string; result: 'pending' | 'negative' | 'positive' | 'inconclusive'; culled: number; action: string | null; notes: string | null
}
export type OStatus = 'planned' | 'ordered' | 'confirmed' | 'received' | 'cancelled'
export interface NOrder {
  id: number; crop_year: number; site: string | null; strain: string; nursery: string | null; nursery_site: string; customer_id: number | null; plants: number
  cut_on: string | null; deliver_on: string | null; plant_on: string | null; status: OStatus; notes: string | null; price_each: number | null
  so_number: string | null; po_number: string | null; payment_terms: string | null; plan_id: number | null; updated_at: string
}
export interface Delivery {
  id: number; ref: string; order_id: number; batch_id: number | null; delivered_on: string; plants: number; manifest: string | null; notes: string | null
  invoice_id: number | null; receipt_id: number | null; created_by: string | null; created_at: string
}
export interface License {
  license_no: string; kind: string; tier: string | null; entity: string; dba: string | null; site: string | null; premises: string | null; address: string | null
  email: string | null; phone: string | null; remit: string | null; hub: boolean; expires: string | null; active: boolean; notes: string | null; sort: number
}
export interface TagRange { id: number; site: string; purpose: string; prefix: string; first_n: number; last_n: number; digits: number; active: boolean; notes: string | null; license: string | null }
export interface NCustomer { id: number; name: string; kind: string | null; legal_name?: string | null }
export interface NSettings {
  price: number; terms: string; rootDays: number; readyWarn: number
  buffer: number; deliverPct: number; tray: number; cutsG3: number; cutsG2: number; cutsG1: number
  g3VegDays: number; g3RootDays: number; g2Lead: number; g1Lead: number; wage: number
}
export interface NData {
  sites: NSite[]; rooms: NRoom[]; mothers: Mother[]; batches: Batch[]; orders: NOrder[]; deliveries: Delivery[]
  licenses: License[]; ranges: TagRange[]; strains: string[]; settings: NSettings; strainPlan: StrainPlan[]; tests: LabTest[]
}
export type NTab = 'dashboard' | 'plan' | 'orders' | 'batches' | 'mothers' | 'logs' | 'invoices' | 'review' | 'activity' | 'settings'
