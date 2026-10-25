import type { SupabaseClient } from '@supabase/supabase-js'
import { CompApi } from '../comp/api'
import type { Doc } from '../comp/api'

// Vehicles and equipment (060, 063): one master list by department, our drivers, outside carriers, and maintenance / inspection / incident reports.
// Any crew member can file a report; Compliance manages the vehicle list and closes defects and incidents.

export type AssetKind = 'vehicle' | 'trailer' | 'equipment'
export type LogKind = 'maintenance' | 'inspection' | 'incident'
export type InspResult = 'pass' | 'defects' | 'out_of_service'

export interface AssetDoc { id: number; doc_type: string; title: string; expires_on: string | null }
export interface Asset {
  id: number; kind: AssetKind; name: string; unit_no: string | null; site: string | null; make: string | null; model: string | null; year: number | null
  vin: string | null; plate: string | null; assigned_to: string | null; status: 'active' | 'out_of_service' | 'retired'; checklist: string | null
  inspect_every_days: number | null; service_every_days: number | null; service_every_miles: number | null; service_every_hours: number | null
  odometer: number | null; hours: number | null; notes: string | null
  department: Dept; body_type: string | null; pallet_spaces: number | null; pallets_across: number | null; carrier_id: number | null
  last_inspection: string | null; last_service: string | null; open: number; docs: AssetDoc[]; driver_ids: number[]
}
export type Dept = 'distribution' | 'cultivation' | 'nursery' | 'processing' | 'company'
export interface Driver {
  id: number; name: string; email: string | null; phone: string | null; license_no: string | null; license_class: string | null; license_expires: string | null
  department: Dept | null; carrier_id: number | null; active: boolean; notes: string | null; has_login: boolean; asset_ids: number[]
}
export interface Carrier {
  id: number; name: string; license_no: string | null; license_expires: string | null; contact_name: string | null; phone: string | null; email: string | null
  address: string | null; notes: string | null; active: boolean; docs: AssetDoc[]
}
export interface Log {
  id: number; asset_id: number | null; kind: LogKind; happened_on: string; happened_at: string | null; odometer: number | null; hours: number | null
  summary: string | null; details: Record<string, unknown>; result: InspResult | null; status: 'open' | 'closed'
  closed_note: string | null; closed_by: string | null; closed_at: string | null; cost: number | null; vendor: string | null; performed_by: string | null
  next_due_on: string | null; next_due_miles: number | null; next_due_hours: number | null; created_by: string | null; created_at: string; files: number
}
export interface Checklist { key: string; label: string; items: { k: string; l: string }[] }
export interface FleetData { assets: Asset[]; logs: Log[]; checklists: Checklist[]; can_edit: boolean; me: string
  drivers: Driver[]; carriers: Carrier[]; my_depts: Dept[]; carrier_admin: boolean }
export interface Due { asset_id: number; what: 'service' | 'inspection'; title: string; site: string | null; due_on: string | null }

function fail(error: { message: string } | null) {
  if (!error) return
  if (/fleet_|does not exist|schema cache/i.test(error.message) && /function|relation|column/i.test(error.message))
    throw new Error(`${error.message} (run the latest Supabase updates: 060 and 063)`)
  throw new Error(error.message)
}

/** phone photos are big: shrink to 1600px JPEG before uploading (other files go as they are) */
export async function shrink(f: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp|heic|heif)/i.test(f.type) || f.size < 600 * 1024) return f
  try {
    const bmp = await createImageBitmap(f)
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k)
    cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height)
    const blob = await new Promise<Blob | null>(r => cv.toBlob(r, 'image/jpeg', 0.82))
    if (!blob || blob.size >= f.size) return f
    return new File([blob], f.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch { return f }
}

export class FleetApi {
  comp: CompApi
  constructor(public sb: SupabaseClient) { this.comp = new CompApi(sb) }
  private async rpc<T>(fn: string, args?: object): Promise<T> { const { data, error } = await this.sb.rpc(fn, args ?? {}); fail(error); return data as T }
  async data(): Promise<FleetData> {
    const d = await this.rpc<FleetData | null>('fleet_data')
    if (!d) throw new Error('Sign in with your Lifted account to see vehicles')
    return d
  }
  due() { return this.rpc<Due[]>('fleet_due') }
  saveAsset(p: Partial<Asset>) { return this.rpc<number>('fleet_save_asset', { p }) }
  saveDriver(p: Partial<Driver>) { return this.rpc<number>('fleet_save_driver', { p }) }
  saveCarrier(p: Partial<Carrier>) { return this.rpc<number>('fleet_save_carrier', { p }) }
  /** put a driver on the app (email-code login, or Microsoft for a Lifted address) as a User of their department */
  async addToApp(name: string, email: string, module: string) {
    const { error } = await this.sb.rpc('add_module_person', { p_email: email.trim().toLowerCase(), p_name: name, p_module: module, p_level: 'user', p_login: null })
    fail(error)
  }
  saveLog(p: Record<string, unknown>) { return this.rpc<number>('fleet_save_log', { p }) }
  closeLog(id: number, note: string, reopen = false) { return this.rpc<void>('fleet_close_log', { p_id: id, p_note: note, p_open: reopen }) }
  deleteLog(id: number) { return this.rpc<void>('fleet_delete_log', { p_id: id }) }
  async addFiles(logId: number, files: File[], onStep?: (s: string) => void) {
    for (const [i, f0] of files.entries()) {
      onStep?.(files.length > 1 ? `${i + 1} / ${files.length}…` : '…')
      const f = await shrink(f0)
      const path = await this.comp.upload(f, 'fleet')
      await this.rpc<number>('fleet_add_file', { p_log: logId, p: { file_path: path, file_name: f.name, mime: f.type || null, size_bytes: f.size } })
    }
  }
  files(logId: number): Promise<Doc[]> { return this.comp.docsFor('fleet_log', logId) }
}
