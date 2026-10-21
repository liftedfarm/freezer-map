export type Site = 'OHR' | 'GVR'
export type FreezerStatus = 'On' | 'Off' | 'Needs Attention' | 'Not Working'
export const FREEZER_STATUSES: FreezerStatus[] = ['On', 'Off', 'Needs Attention', 'Not Working']

export interface Freezer {
  id: number
  site: Site
  number: number
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
export interface Customer { id: number; name: string; kind: 'internal' | 'external'; license: string | null; address: string | null; contact: string | null; notes: string | null; active: boolean }
export interface Strain { id: number; name: string; aliases: string[]; color: string | null; notes: string | null; active: boolean }
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
}

export type Role = 'admin' | 'sales' | 'crew' | 'customer' | 'none'
export interface Me { email: string; role: Role; display_name: string | null; customer_id: number | null; customer_name: string | null }
export interface AppUser { email: string; role: Role; customer_id: number | null; display_name: string | null; added_by: string | null; created_at: string; last_seen: string | null }
export const canSales = (r?: Role) => r === 'admin' || r === 'sales'
export interface LinkInfo { kind: 'invite' | 'reset'; email: string; display_name: string | null; customer_name: string | null }
export interface Reserve { id: number; customer_id: number; strain: string; product: string; lbs: number; notes: string | null; updated_by: string | null; updated_at: string }
