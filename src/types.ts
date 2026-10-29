export type Site = 'OHR' | 'GVR'
export type FreezerStatus = 'On' | 'Off' | 'Needs Attention' | 'Not Working'
export const FREEZER_STATUSES: FreezerStatus[] = ['On', 'Off', 'Needs Attention', 'Not Working']

export interface Freezer {
  id: number
  site: Site
  number: number
  kind?: 'freezer' | 'staging' | 'trailer'
  active?: boolean
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

export type PalletStatus = 'in_freezer' | 'unslotted' | 'in_transit' | 'at_processor' | 'shipped' | 'depleted' | 'archived' | 'merged'
/** what's in the package: fresh frozen, or a dry flower stage (047) */
export type Product = 'fresh_frozen' | 'wet' | 'unbucked' | 'bucked' | 'bucked_standards' | 'standards' | 'smalls' | 'trim'
export const PRODUCT_LABEL: Record<Product, string> = { fresh_frozen: 'Fresh Frozen', wet: 'Wet (raw)', unbucked: 'Unbucked', bucked: 'Bucked', bucked_standards: 'Bucked Standards', standards: 'Standards', smalls: 'Smalls', trim: 'Trim' }
export const PRODUCT_SHORT: Record<Product, string> = { fresh_frozen: 'FF', wet: 'Wet', unbucked: 'Unbk', bucked: 'Bkd', bucked_standards: 'BkStd', standards: 'Std', smalls: 'Sml', trim: 'Trim' }
/** products Sales can put on an order line */
export const SALE_PRODUCTS: Product[] = ['fresh_frozen', 'standards', 'smalls', 'trim', 'bucked', 'unbucked']

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
  pushed?: boolean                   // 057: false = logged at harvest, not a METRC package yet
  span_to_slot?: number | null       // 057: trailers, takes the spots from slot_id to here
  machine_trimmed?: boolean          // 057: internal only
  kind?: 'package' | 'mixed'
  container_id?: number | null
  received_site?: string | null
  origin_site?: string | null        // farm it was grown at: OHR, GVR, or GVR+OHR
  product?: Product
  crop_year?: number | null
  from_harvest?: number | null
  processor_id?: number | null
  sent_on?: string | null
  run_id?: number | null
  item_id?: number | null            // item (SKU) it belongs to (054)
  lot_id?: number | null             // harvest lot (054)
  grade?: Grade | null               // set on this pallet only; null = follow the lot / strain
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

export interface Vehicle { id: number; name: string; plate: string | null; kind: string | null; notes: string | null; active: boolean; spaces: number; across: number; owner: string | null; department?: string | null; carrier_id?: number | null }
export interface Customer { id: number; name: string; kind: 'internal' | 'external'; license: string | null; address: string | null; contact: string | null; notes: string | null; active: boolean; price_per_lb?: number | null; contract_lbs?: number | null; monthly_min_lbs?: number | null; deposit_usd?: number | null; storage_fee?: number | null; reserves_enabled?: boolean; legal_name?: string | null; qbo_name?: string | null; payment_terms?: string | null; billing_address?: string | null; billing_contact?: string | null; billing_email?: string | null; billing_phone?: string | null; ship_to_name?: string | null; ship_to_address?: string | null; receiving_contact?: string | null; license_expires?: string | null; sample_hold_days?: number | null }
export interface Strain { id: number; name: string; aliases: string[]; color: string | null; notes: string | null; active: boolean; show_on_menu?: boolean; strain_no?: number | null; default_grade?: Grade; trial?: boolean }
export type Grade = 'SHO' | 'BHO'
/** what a lot grade change touched: still on hand, held for orders, already shipped (by invoice) */
export interface LotImpact { on_hand: { pallets: number; lbs: number }; held: { pallet: string; order: string; customer: string; line_grade: Grade | null; lbs: number }[]; shipped: { invoice: string; customer: string; date: string; lbs: number; grade: Grade | null }[] }
/** an item (SKU): crop year + farm + cert + finish + strain. People see the simple name; the SKU and METRC name sit behind it. */
export interface Item { id: number; sku: string; crop_year: number; site: string; cert: string; finish: string; strain_id: number; metrc_name: string; license: string | null; metrc_status: 'to_create' | 'in_metrc' | 'retired' }
/** a harvest lot = one METRC harvest batch (code FL26-OH-047-01) */
export interface HarvestLot { id: number; code: string; crop_year: number; site: string; strain_id: number; kind: string; metrc_name: string | null; grade: Grade | null; grade_reason: string | null; first_harvest: string | null; last_harvest: string | null }
export const FINISH_LABEL: Record<string, string> = { FF: 'Fresh Frozen', DH: 'Wet', UF: 'Unbucked', BF: 'Bucked', ST: 'Standards', SM: 'Smalls', TR: 'Trim', BT: 'Bucking trim', DB: 'Dry biomass', DS: 'Dry sift biomass', CL: 'Clone', UR: 'Unrooted cutting', IP: 'Immature plant', MS: 'Mother stock', SD: 'Seed' }
export type ListName = 'vehicles' | 'customers' | 'strains'
export type ListRow = Vehicle | Customer | Strain
export interface Settings { vehicles: Vehicle[]; customers: Customer[]; strains: Strain[] }

export type LoadStatus = 'planning' | 'loading' | 'departing' | 'in_transit' | 'delivered' | 'cancelled'
export interface Load { id: number; code: string; load_date: string; vehicle_id: number; status: LoadStatus; driver: string | null; notes: string | null; created_by: string | null; created_at: string; departed_at: string | null; closed_at: string | null
  /** 089: customer pickups, Depart in two steps, carrier cost */
  kind?: 'delivery' | 'pickup'; departing_at?: string | null; depart_error?: string | null; carrier_cost?: number | null
  pickup_driver?: string | null; pickup_dl?: string | null; pickup_make?: string | null; pickup_model?: string | null; pickup_plate?: string | null; pickup_license?: string | null }
export interface LoadStop { id: number; load_id: number; seq: number; customer_id: number; manifest: string | null; status: 'pending' | 'delivered'; delivered_at: string | null; delivered_by: string | null
  ship_override?: number | null; ship_override_reason?: string | null; ship_charge?: number | null; ship_value?: number | null; ship_rule?: string | null; ship_desc?: string | null; ship_saved_at?: string | null }
export interface LoadItem { id: number; load_id: number; stop_id: number; pallet_id: number; position: number; loaded: boolean; from_slot: number | null; from_site?: string | null; layer?: number }
export interface StopInput { id?: number; customer_id: number; manifest: string }

export interface Snapshot {
  freezers: Freezer[]
  slots: Slot[]
  pallets: Pallet[]
  strains?: Strain[]
  vehicles?: Vehicle[]
  /** drivers (063): ours and carriers', with the vehicles they drive */
  drivers?: LoadDriver[]
  customers?: Customer[]
  loads?: Load[]
  stops?: LoadStop[]
  items?: LoadItem[]
  shipped?: ShippedCheck[]
  unmatched?: UnmatchedTag[]
  /** pallet id -> open processing run code (set aside until the run is finished) */
  inRun?: Record<number, string>
  /** items (SKUs) and harvest lots (054) */
  skus?: Item[]
  lots?: HarvestLot[]
}

export type Role = 'admin' | 'sales' | 'crew' | 'customer' | 'none'
export interface Me { email: string; role: Role; display_name: string | null; customer_id: number | null; customer_name: string | null; viewing_as?: boolean; real_email?: string; access: Access }
export interface AppUser { login_kind?: 'microsoft' | 'email'; email: string; role: Role; customer_id: number | null; display_name: string | null; added_by: string | null; created_at: string; last_seen: string | null; modules?: string[]; owner?: boolean; access?: Partial<Record<ModKey, Level>>; prefs?: Prefs }
/** the parts of the app. Levels per person: off (missing), user, admin. Owners are admin everywhere. */
export type ModKey = 'distribution' | 'sales' | 'cultivation' | 'nursery' | 'processing' | 'accounting' | 'compliance' | 'admin'
export type Level = 'view' | 'user' | 'admin'
export const MODULES: { key: ModKey; label: string; what: string; user: string; admin: string }[] = [
  { key: 'distribution', label: 'Distribution', what: 'Freezer map, transit, review', user: 'Move, split, load and ship pallets', admin: '+ Distribution settings (vehicles, strains)' },
  { key: 'sales', label: 'Sales', what: 'Reserves, open menu, orders, prices', user: 'See prices, reserves and orders; confirm orders', admin: '+ approve reserve requests, deadlines, customers and terms' },
  { key: 'cultivation', label: 'Production', what: 'Harvest schedule, testing, fields, planning', user: 'Schedule and log harvests, fields, plan', admin: '+ Production settings (sites, fields, labs, equipment)' },
  { key: 'nursery', label: 'Nursery', what: 'Mother plants, cuttings, clone orders and deliveries', user: 'Mothers, batches, deliver clones, invoices', admin: '+ Nursery settings (rooms, prices, tag ranges); void invoices' },
  { key: 'processing', label: 'Processing', what: 'Dry flower: drying, bucking, trimming, crew pay', user: 'Wet packages, send out / receive, bucking and trimming runs, commit to orders', admin: '+ Processing settings (processors)' },
  { key: 'accounting', label: 'Accounting', what: 'Invoices to QuickBooks, payments, classes', user: 'Check and send invoices to QuickBooks', admin: '+ connect QuickBooks, products, classes and class rules' },
  { key: 'compliance', label: 'Compliance', what: 'METRC, CCOF, document library, deadlines', user: 'Add documents, check off METRC work, deadlines, CCOF materials, reconcile', admin: '+ Compliance settings (document types, SharePoint backup)' },
  { key: 'admin', label: 'Admin', what: 'Company dashboard, users and access, app settings', user: 'Everything in Admin', admin: 'Everything in Admin' },
]
export interface Prefs { theme?: 'light' | 'dark' | 'system'; lang?: 'en' | 'es'; start_module?: ModKey; start_site?: Site; notify?: { requests?: boolean; orders?: boolean } }
export interface Access { owner: boolean; modules: Partial<Record<ModKey, Level>>; prefs: Prefs; perms?: Record<string, Record<string, boolean>>; login?: 'microsoft' | 'email' | null }
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
export interface OrderLine { id: number; order_id: number; strain: string; product?: Product; lbs: number; price_per_lb: number | null; price_override: boolean; farm: string | null; package_tag: string | null; crop_year?: number; is_sample?: boolean; hold_lbs?: number | null }
export interface Order { id: number; so_number: string | null; customer_id: number; status: 'draft' | 'submitted' | 'pending' | 'shipped' | 'cancelled'; roshi_status: string | null; order_date: string | null; shipped_date: string | null; source: string; notes: string | null; po_number?: string | null; wanted_date?: string | null; placed_by?: string | null; confirmed_by?: string | null; is_sample?: boolean; order_lines: OrderLine[] }
export interface RoshiRow { line_id: string; so_number: string; customer: string; sku_name: string; sku_id: string | null; status: string; gross: number | null; units: number | null; order_date: string | null; shipped_date: string | null; package_tag: string | null }
export interface ImportResult { orders_added: number; orders_updated: number; lines_added: number; lines_updated: number; skipped: number; new_customers: string[]; new_strains: string[] }
export interface MenuRow { strain: string; crop_year: number; available: number; my_reserved: number | null; my_shipped: number | null; my_pending: number | null; my_left: number | null; request_id: number | null; requested_lbs: number | null; my_hold?: number | null; my_hold_until?: string | null }
export interface MenuNumbers { strain: string; crop_year: number; on_menu: boolean; on_hand: number; pending: number; reserved_left: number; held: number; free: number }
export interface ReserveRequest { id: number; customer_id: number; strain: string; current_lbs: number; requested_lbs: number; note: string | null; status: 'pending' | 'approved' | 'declined' | 'cancelled'; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; crop_year?: number; batch_id?: string | null; approved_lbs?: number | null }
export interface OrderInput { strain: string; lbs: number; crop_year?: number; sample?: boolean; hold_lbs?: number | null }
export interface UnmatchedTag { package_tag: string; strain: string; lbs: number; tags_on_line: number; sos: string; last_shipped: string | null }
export interface ShippedCheck { pallet_id: number; package_tag: string; shipped_lbs: number; new_lbs: number; sos: string; last_shipped: string | null }
export interface Terms { name: string; price_per_lb: number | null; contract_lbs: number | null; reserves_enabled?: boolean }

/** Fulfillment (025): an order as Distribution sees it (no prices) */
export type FState = 'open' | 'needs_ok' | 'ready' | 'loaded' | 'shipped' | 'cancelled' | 'submitted' | 'draft'
export interface FPick { id: number; pallet_id: number; lbs: number; code: string; tag: string | null; tag_pending: boolean; slot_id: number | null }
export interface FLine { id: number; strain: string; product?: Product; lbs: number; ordered_lbs: number | null; crop_year: number; cant_fill?: boolean; picks: FPick[] }
export interface FOrder {
  id: number; so: string | null; po: string | null; customer_id: number; customer: string; status: string; state: FState; source: string
  order_date: string | null; wanted_date: string | null; shipped_date: string | null; notes: string | null
  stop: { id: number; load_id: number; load: string; load_status: string; load_date: string; stop_status: string; load_kind?: string; manifest?: string | null } | null
  lines: FLine[]
  /** 089: how complete it is even while on a load (open / needs_ok / ready); shipping on the order */
  fill?: 'open' | 'needs_ok' | 'ready'; shipping?: number | null; shipping_quoted?: boolean
}

/** Sales documents (027) */
export interface PaymentTerm { code: string; label: string; schedule: { pct: number; days: number }[]; cod: boolean; sort: number; active: boolean }
export interface Invoice {
  id: number; inv_number: string; order_id: number | null; customer_id: number; invoice_date: string; terms_code: string | null; terms_label: string | null
  schedule: { pct: number; amount: number; due: string }[]; due_date: string | null; total: number; status: 'open' | 'paid' | 'void'; po_number: string | null
  notes: string | null; share_token: string; sent_at: string | null; acct_status: 'pending' | 'sent' | 'error' | 'skip'; acct_ref: string | null; acct_error: string | null
  paid_at: string | null; created_at: string; seller_license?: string | null; nursery_order_id?: number | null
  manifest?: string | null; acct_push_after?: string | null; acct_flags?: string[]
}
export interface NewOrderLine { strain: string; lbs: number; price?: number | null; crop_year?: number; product?: Product }

// what someone needs to complete the METRC manifest for one stop (045 stop_manifest)
export interface ManifestLicense { license: string; kind?: string; entity?: string; dba?: string | null; site?: string | null; premises?: string | null; address?: string | null; phone?: string | null; from_site?: string; name?: string; contact?: string | null }
export interface ManifestPackage { pallet: string; code: string; tag: string | null; tag_pending: boolean; strain: string | null; origin: string | null; from: string | null; lbs: number | null; crop_year: number; harvested: string | null; batch: string }
export interface StopManifest {
  load: string; load_date: string; status: string; driver: string | null; vehicle: string | null; plate: string | null; stop: number; stop_status: string; manifest: string | null
  transfer: boolean; from: ManifestLicense[]; to: ManifestLicense; transporter: ManifestLicense | null; orders: string[]; packages: ManifestPackage[]
}
/** customer dashboard + statement (060 customer_statement) */
export interface StatementInvoice { id: number; inv_number: string; invoice_date: string; due_date: string | null; total: number; status: 'open' | 'paid' | 'void'; terms_label: string | null; po_number: string | null; share_token: string; so_number: string | null; balance: number; past_due: boolean }
export interface StatementItem { type: 'Invoice' | 'Credit' | 'Payment'; doc: string | null; date: string; due: string | null; total: number; balance: number }
export interface Statement {
  customer: { id: number; name: string; terms: string | null }
  balance: { amount: number; past_due: number; source: 'quickbooks' | 'app'; synced_at: string | null }
  open_items: StatementItem[]; invoices: StatementInvoice[]
  month: { start: string; shipped: number; min: number | null; left: number | null }
  pending_lbs: number; reserves: { year: number; reserved: number; shipped: number; pending: number; remaining: number; strains: number }
  contract_lbs: number | null; price_per_lb: number | null; from: string
}
/** sample holds (061): what a sample order holds for the customer, and for how long */
export interface SampleHold { line_id: number; order_id: number; so_number: string | null; customer_id: number; customer: string; strain: string; crop_year: number
  hold_lbs: number; used_lbs: number; remaining: number; placed_on: string | null; shipped_on: string | null; until: string | null
  state: 'submitted' | 'waiting' | 'active' | 'expired' | 'used' | 'released' | 'cancelled' }
export interface LoadDriver { id: number; name: string; carrier_id: number | null; active: boolean; asset_ids: number[] }

/** 089 shipping */
export interface StopShipping { billed: boolean; saved?: boolean; class?: string; zone?: string | null; share?: number | null; rule?: string; pct?: number | null; stops?: number
  calc_charge?: number | null; charge?: number | null; value?: number | null; descr?: string | null; problem?: string | null; quoted?: number | null; override?: number | null; reason?: string | null }
export interface LoadBlocker { stop_id?: number; seq?: number; order_id?: number; text: string }
export interface ShipZone { id: number; name: string; miles_rt: number | null; rate_van: number | null; rate_box: number | null; price_van: number | null; price_box: number | null; active: boolean; sort: number }
export interface ShipSettings { fee: number; zones: ShipZone[]
  customers: { id: number; name: string; zone_id: number | null; rule: string | null; pct: number | null; auto_rule: string; contract: boolean }[]
  vehicles: { id: number; name: string; class: string | null; auto_class: string; carrier: boolean }[] }
export interface ShipQuoteRow { customer_id: number; customer: string; zone: string | null; share: number | null; rule: string; pct: number | null; charge: number | null; value: number | null; descr: string | null; problem: string | null; address: string | null }
/** 090 alerts */
export interface AppAlert { id: number; module: string; admins: boolean; kind: string; title: string; body: string | null; ref: Record<string, unknown>; created_by: string | null; created_at: string }
