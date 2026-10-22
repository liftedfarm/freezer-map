export type Site = 'OHR' | 'GVR'
export type FreezerStatus = 'On' | 'Off' | 'Needs Attention' | 'Not Working'
export const FREEZER_STATUSES: FreezerStatus[] = ['On', 'Off', 'Needs Attention', 'Not Working']

export interface Freezer {
  id: number
  site: Site
  number: number
  kind?: 'freezer' | 'staging'
  status: FreezerStatus
  notes?: string | null
}

export interface Slot {
  id: number
  freezer_id: number
  code: string
  col: 1 | 2
  row: number
  front_rank: number
}

export type PalletStatus = 'in_freezer' | 'unslotted' | 'in_transit' | 'shipped' | 'depleted' | 'archived' | 'merged'

export interface Pallet {
  id: number
  code: string
  label: string | null
  strain: string | null
  zone: string | null
  harvest_date: string | null
  planting_date: string | null
  og_weight: number | null
  current_weight: number | null
  package_tag: string | null
  status: PalletStatus
  slot_id: number | null
  needs_review: string | null
  notes: string | null
  parent_id?: number | null
  harvest_id?: number | null
  boxes?: number | null
  partial?: boolean
  merged_into?: number | null
  tag_pending?: boolean
  kind?: 'package' | 'mixed'
  container_id?: number | null
  received_site?: string | null
}

/** one line when building or adding to a mixed pallet: whole package (lbs null) or lbs split off with a new tag */
export interface MixLine { pallet_id: number; lbs: number | null; tag?: string | null; tag_pending?: boolean }
export interface SingleInput { code: string; strain: string; lbs: number; tag: string | null; tag_pending: boolean; harvest_date: string | null; note: string }

export interface InvEvent {
  id: number
  at: string
  user_email: string | null
  type: string
  pallet_id: number | null
  freezer_id: number | null
  from_slot_id: number | null
  to_slot_id: number | null
  lbs: number | null
  note: string | null
  details: Record<string, unknown> | null
}

export interface Vehicle { id: number; name: string; plate: string | null; kind: string | null; notes: string | null; active: boolean; spaces: number; across: number; owner: string | null }
export interface Customer { id: number; name: string; kind: 'internal' | 'external'; license: string | null; address: string | null; contact: string | null; notes: string | null; active: boolean; price_per_lb?: number | null; contract_lbs?: number | null; monthly_min_lbs?: number | null; deposit_usd?: number | null; storage_fee?: number | null; reserves_enabled?: boolean; legal_name?: string | null; payment_terms?: string | null; billing_address?: string | null; billing_contact?: string | null; billing_email?: string | null; billing_phone?: string | null; ship_to_name?: string | null; ship_to_address?: string | null; receiving_contact?: string | null }
export interface Strain { id: number; name: string; aliases: string[]; color: string | null; notes: string | null; active: boolean; show_on_menu?: boolean }
export type ListName = 'vehicles' | 'customers' | 'strains'
export type ListRow = Vehicle | Customer | Strain
export interface Settings { vehicles: Vehicle[]; customers: Customer[]; strains: Strain[] }

export type LoadStatus = 'planning' | 'loading' | 'in_transit' | 'delivered' | 'cancelled'
export interface Load { id: number; code: string; load_date: string; vehicle_id: number; status: LoadStatus; driver: string | null; notes: string | null; created_by: string | null; created_at: string; departed_at: string | null; closed_at: string | null }
export interface LoadStop { id: number; load_id: number; seq: number; customer_id: number; manifest: string | null; status: 'pending' | 'delivered'; delivered_at: string | null; delivered_by: string | null }
export interface LoadItem { id: number; load_id: number; stop_id: number; pallet_id: number; position: number; loaded: boolean; from_slot: number | null }
export interface StopInput { id?: number; customer_id: number; manifest: string }

export interface Snapshot {
  freezers: Freezer[]
  slots: Slot[]
  pallets: Pallet[]
  strains?: Strain[]
  vehicles?: Vehicle[]
  customers?: Customer[]
  loads?: Load[]
  stops?: LoadStop[]
  items?: LoadItem[]
  shipped?: ShippedCheck[]
  unmatched?: UnmatchedTag[]
}

export type Role = 'admin' | 'sales' | 'crew' | 'customer' | 'none'
export interface Me { email: string; role: Role; display_name: string | null; customer_id: number | null; customer_name: string | null; viewing_as?: boolean; real_email?: string; access: Access }
export interface AppUser { email: string; role: Role; customer_id: number | null; display_name: string | null; added_by: string | null; created_at: string; last_seen: string | null; modules?: string[]; owner?: boolean; access?: Partial<Record<ModKey, Level>>; prefs?: Prefs }
/** the parts of the app. Levels per person: off (missing), user, admin. Owners are admin everywhere. */
export type ModKey = 'distribution' | 'sales' | 'cultivation' | 'nursery' | 'admin'
export type Level = 'view' | 'user' | 'admin'
export const MODULES: { key: ModKey; label: string; what: string; user: string; admin: string }[] = [
  { key: 'distribution', label: 'Distribution', what: 'Freezer map, transit, review', user: 'Move, split, load and ship pallets', admin: '+ Distribution settings (vehicles, strains)' },
  { key: 'sales', label: 'Sales', what: 'Reserves, open menu, orders, prices', user: 'See prices, reserves and orders; confirm orders', admin: '+ approve reserve requests, deadlines, customers and terms' },
  { key: 'cultivation', label: 'Production', what: 'Harvest schedule, testing, fields, planning', user: 'Schedule and log harvests, fields, plan', admin: '+ Production settings (sites, fields, labs, equipment)' },
  { key: 'nursery', label: 'Nursery', what: 'Mother plants, cuttings, clone orders and deliveries', user: 'Mothers, batches, deliver clones, invoices', admin: '+ Nursery settings (rooms, prices, tag ranges); void invoices' },
  { key: 'admin', label: 'Admin', what: 'Company dashboard, users and access, app settings', user: 'Everything in Admin', admin: 'Everything in Admin' },
]
export interface Prefs { theme?: 'light' | 'dark' | 'system'; lang?: 'en' | 'es'; start_module?: ModKey; start_site?: Site; notify?: { requests?: boolean; orders?: boolean } }
export interface Access { owner: boolean; modules: Partial<Record<ModKey, Level>>; prefs: Prefs }
export interface UserAccess { email: string; module: ModKey; level: Level }
/** before 023 is run: work it out from the old role */
export function accessFromRole(role: Role, extra: string[] = []): Access {
  const m: Partial<Record<ModKey, Level>> = {}
  if (role === 'admin') { m.distribution = 'admin'; m.sales = 'admin'; m.admin = 'admin' }
  if (role === 'sales') { m.distribution = 'user'; m.sales = 'user' }
  if (role === 'crew') m.distribution = 'user'
  if (['admin', 'sales', 'crew'].includes(role) && extra.includes('cultivation')) m.cultivation = role === 'admin' ? 'admin' : 'user'
  return { owner: false, modules: m, prefs: {} }
}
export const canSales = (r?: Role) => r === 'admin' || r === 'sales'
export interface LinkInfo { kind: 'invite' | 'reset'; email: string; display_name: string | null; customer_name: string | null }
export interface Reserve { id: number; customer_id: number; strain: string; product: string; lbs: number; notes: string | null; updated_by: string | null; updated_at: string; crop_year?: number }
export interface Balance { id: number; customer_id: number; strain: string; reserved: number; shipped: number; pending: number; remaining: number; crop_year?: number }
/** reserve crop years: the current crop plus future crops with a request deadline */
export interface ReserveYears { current: number; years: { year: number; deadline: string | null; open: boolean }[] }
export interface CustomerTerms { customer_id: number; crop_year: number; price_per_lb: number | null; contract_lbs: number | null; monthly_min_lbs: number | null; deposit_usd: number | null; storage_fee: number | null }
export interface OrderLine { id: number; order_id: number; strain: string; lbs: number; price_per_lb: number | null; price_override: boolean; farm: string | null; package_tag: string | null; crop_year?: number }
export interface Order { id: number; so_number: string | null; customer_id: number; status: 'draft' | 'submitted' | 'pending' | 'shipped' | 'cancelled'; roshi_status: string | null; order_date: string | null; shipped_date: string | null; source: string; notes: string | null; po_number?: string | null; wanted_date?: string | null; placed_by?: string | null; confirmed_by?: string | null; order_lines: OrderLine[] }
export interface RoshiRow { line_id: string; so_number: string; customer: string; sku_name: string; sku_id: string | null; status: string; gross: number | null; units: number | null; order_date: string | null; shipped_date: string | null; package_tag: string | null }
export interface ImportResult { orders_added: number; orders_updated: number; lines_added: number; lines_updated: number; skipped: number; new_customers: string[]; new_strains: string[] }
export interface MenuRow { strain: string; crop_year: number; available: number; my_reserved: number | null; my_shipped: number | null; my_pending: number | null; my_left: number | null; request_id: number | null; requested_lbs: number | null }
export interface MenuNumbers { strain: string; crop_year: number; on_menu: boolean; on_hand: number; pending: number; reserved_left: number; held: number; free: number }
export interface ReserveRequest { id: number; customer_id: number; strain: string; current_lbs: number; requested_lbs: number; note: string | null; status: 'pending' | 'approved' | 'declined' | 'cancelled'; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; crop_year?: number; batch_id?: string | null; approved_lbs?: number | null }
export interface OrderInput { strain: string; lbs: number; crop_year?: number }
export interface UnmatchedTag { package_tag: string; strain: string; lbs: number; tags_on_line: number; sos: string; last_shipped: string | null }
export interface ShippedCheck { pallet_id: number; package_tag: string; shipped_lbs: number; new_lbs: number; sos: string; last_shipped: string | null }
export interface Terms { name: string; price_per_lb: number | null; contract_lbs: number | null; reserves_enabled?: boolean }

/** Fulfillment (025): an order as Distribution sees it (no prices) */
export type FState = 'open' | 'needs_ok' | 'ready' | 'loaded' | 'shipped' | 'cancelled' | 'submitted' | 'draft'
export interface FPick { id: number; pallet_id: number; lbs: number; code: string; tag: string | null; tag_pending: boolean; slot_id: number | null }
export interface FLine { id: number; strain: string; lbs: number; ordered_lbs: number | null; crop_year: number; cant_fill?: boolean; picks: FPick[] }
export interface FOrder {
  id: number; so: string | null; po: string | null; customer_id: number; customer: string; status: string; state: FState; source: string
  order_date: string | null; wanted_date: string | null; shipped_date: string | null; notes: string | null
  stop: { id: number; load_id: number; load: string; load_status: string; load_date: string; stop_status: string } | null
  lines: FLine[]
}

/** Sales documents (027) */
export interface PaymentTerm { code: string; label: string; schedule: { pct: number; days: number }[]; cod: boolean; sort: number; active: boolean }
export interface Invoice {
  id: number; inv_number: string; order_id: number | null; customer_id: number; invoice_date: string; terms_code: string | null; terms_label: string | null
  schedule: { pct: number; amount: number; due: string }[]; due_date: string | null; total: number; status: 'open' | 'paid' | 'void'; po_number: string | null
  notes: string | null; share_token: string; sent_at: string | null; acct_status: 'pending' | 'sent' | 'error' | 'skip'; acct_ref: string | null; acct_error: string | null
  paid_at: string | null; created_at: string; seller_license?: string | null; nursery_order_id?: number | null
}
export interface NewOrderLine { strain: string; lbs: number; price?: number | null; crop_year?: number }
