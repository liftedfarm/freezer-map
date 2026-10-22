// Nursery module: mother plants, cutting batches, clone orders and deliveries
export interface NSite { code: string; name: string; license: string | null; address: string | null; active: boolean; sort: number }
export interface NRoom { id: number; site: string; name: string; kind: 'mother' | 'clone' | 'veg' | 'other'; active: boolean; notes: string | null; sort: number }
export interface Mother {
  id: number; site: string; room_id: number | null; strain: string; plant_tag: string | null; started_on: string | null
  status: 'active' | 'retired' | 'destroyed'; ended_on: string | null; notes: string | null; created_at: string
}
export type Stage = 'rooting' | 'ready' | 'done' | 'cancelled'
export interface Batch {
  id: number; site: string; room_id: number | null; strain: string; name: string | null; order_id: number | null; cut_on: string
  cuttings: number; lost: number; ready_on: string | null; stage: Stage; tags: string[]; notes: string | null; created_at: string
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
export interface NSettings { price: number; terms: string; rootDays: number; readyWarn: number }
export interface NData {
  sites: NSite[]; rooms: NRoom[]; mothers: Mother[]; batches: Batch[]; orders: NOrder[]; deliveries: Delivery[]
  licenses: License[]; ranges: TagRange[]; strains: string[]; settings: NSettings
}
export type NTab = 'dashboard' | 'orders' | 'batches' | 'mothers' | 'invoices' | 'review' | 'activity' | 'settings'
