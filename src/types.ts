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

export type PalletStatus = 'in_freezer' | 'unslotted' | 'shipped' | 'depleted' | 'archived' | 'merged'

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
}

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

export interface Snapshot {
  freezers: Freezer[]
  slots: Slot[]
  pallets: Pallet[]
}
