import type { SupabaseClient } from '@supabase/supabase-js'

// Compliance module: documents (private storage bucket "compliance"), deadlines, CCOF materials, METRC queue / reconcile / errors.

function fail(error: { message: string } | null) {
  if (!error) return
  if (/comp_reconcile_nursery/i.test(error.message)) throw new Error(`${error.message} (run 076_nursery_reconcile.sql in Supabase)`)
  if (/metrc_locations|metrc_strains|metrc_location_map|metrc_strain_map|metrc_plant|metrc_map_|metrc_app_transfers|metrc_stop_checks|touch_tags/i.test(error.message)) throw new Error(`${error.message} (run 075_metrc_phase12.sql in Supabase)`)
  if (/metrc_push|metrc_connection|metrc_set_mode|metrc_me|push_state/i.test(error.message)) throw new Error(`${error.message} (run 070_metrc_push.sql in Supabase)`)
  if (/reconcile_view|recon_apply|recon_ignores/i.test(error.message)) throw new Error(`${error.message} (run 074_recon_apply.sql in Supabase)`)
  if (/reconcile_live|metrc_sync|metrc_packages|metrc_trail/i.test(error.message)) throw new Error(`${error.message} (run 071_metrc_sync.sql in Supabase)`)
  if (/comp_|pallet_trace|test_files|customer_license_status|does not exist|schema cache/i.test(error.message) && /function|relation|column/i.test(error.message))
    throw new Error(`${error.message} (run 055_compliance.sql and 056_ccof_list.sql in Supabase)`)
  throw new Error(error.message)
}

export const BUCKET = 'compliance'

export interface DocType { key: string; label: string; folder: string; sort: number; expires: boolean; active: boolean; notes: string | null }
export interface Doc {
  id: number; doc_type: string; title: string; site: string | null; license_no: string | null; crop_year: number | null
  effective_on: string | null; expires_on: string | null; notes: string | null; owner_email: string | null
  file_path: string | null; file_name: string | null; mime: string | null; size_bytes: number | null; link_url: string | null
  version: number; replaces_id: number | null; current: boolean; deleted_at: string | null; deleted_by: string | null
  backed_up_at: string | null; sp_path: string | null; sp_archived: boolean; backup_error: string | null
  created_by: string | null; created_at: string; updated_at: string
  links?: Link[]
}
export type RefKind = 'test' | 'pallet' | 'lot' | 'harvest' | 'material' | 'license' | 'customer' | 'metrc_error' | 'obligation' | 'processor' | 'asset' | 'fleet_log' | 'carrier' | 'driver'
export interface Link { doc_id: number; ref_kind: RefKind; ref_id: string }
export interface FileRef { id: number; title: string; file_name: string | null; file_path: string | null; link_url: string | null; mime: string | null }

export interface Deadline {
  kind: 'obligation' | 'doc' | 'license' | 'material' | 'customer' | 'fleet'; ref: string; title: string; category: string; site: string | null
  due_on: string | null; days_left: number | null; remind_days: number; owner_email: string | null; repeat_months: number | null; notes: string | null; doc_type: string | null
}
export interface Obligation {
  id?: number; title: string; category: string; site: string | null; owner_email: string | null; due_on: string | null; repeat_months: number | null
  remind_days: number; doc_type: string | null; notes: string | null; active: boolean
}
export interface ObLog { id: number; obligation_id: number; due_on: string | null; done_on: string; done_by: string | null; note: string | null; doc_id: number | null }

export interface Material {
  id: number; module: string; name: string; manufacturer: string | null; kind: string | null; npk: string | null; pesticide: boolean; active: boolean
  epa_reg: string | null; active_ingredient: string | null; rei_hours: number | null; phi_days: number | null; label_url: string | null
  ccof_status: 'approved' | 'pending' | 'not_allowed' | 'unknown'; listing: string | null; listing_no: string | null; listing_expires: string | null
  restrictions: string | null; ccof_notes: string | null; ccof_by: string | null; ccof_at: string | null; ccof_code?: string | null
}
export interface CcofEntry { id: number; code: string; name: string; manufacturer: string | null; category: string | null; approved_on: string | null; status: string | null; listing: string | null
  restriction: string | null; comment: string | null; action_required: boolean; active: boolean; list_date: string | null }
export interface Cert { site: string; label: string | null; ccof: boolean; notes: string | null; updated_by: string | null; updated_at: string }
export interface Issue { log_id: number; module: string; log_on: string; site: string | null; area: string | null; product: string; issue: string; product_id: number | null }
export interface ProductLine { product: string; manufacturer?: string | null; rate?: number | null; unit?: string | null; basis?: string | null; total?: number | null; total_unit?: string | null }
export interface AppLog {
  id: number; module: string; kind: 'feed' | 'spray'; site: string | null; area: string | null; log_on: string; method: string | null; spray_type: string | null
  water_gal: number | null; acres: number | null; sqft: number | null; run_min: number | null; applicator: string | null; products: ProductLine[]; notes: string | null; strain: string | null
}

export interface MAction {
  id: number; at: string; due_at?: string | null; harvest_id?: number | null; license: string | null; action: string; pallet_id: number | null; code: string | null; tag: string | null; lbs: number | null
  summary: string | null; details: Record<string, unknown> | null; status: 'todo' | 'done' | 'error' | 'skipped'; note: string | null; done_by: string | null; done_at: string | null
  kind?: string | null; push_state?: 'checked' | 'sending' | 'sent' | 'failed' | 'waiting' | null; push_attempts?: number; push_at?: string | null
  push_by?: string | null; push_error?: string | null; push_request?: unknown; push_response?: unknown
}
export interface PushKind { kind: string; label: string; phase: number; sort: number; ready: boolean; mode: 'off' | 'approve' | 'auto'; updated_by: string | null; updated_at: string }
export interface T3Conn {
  ok: boolean | null; tested_at: string | null; tested_by: string | null; error: string | null; who: Record<string, unknown> | null
  licenses: { license: string; name: string | null; in_t3: boolean; in_app: boolean; site: string | null; permissions: string[]; permissions_error?: string; reasons_error?: string }[] | null
  reasons: Record<string, { id: number; name: string; requiresNote: boolean }[]> | null
  transfer?: Record<string, { types: { id: number; name: string; wholesale: boolean }[]; drivers: string[]; vehicles: string[]; phone: string | null }> | null
}
export interface MLoc { license: string; id: number; name: string; type_name: string | null; for_plants: boolean | null; for_plant_batches: boolean | null; for_harvests: boolean | null; for_packages: boolean | null; archived: boolean }
export interface MStrain { license: string; id: number; name: string; archived: boolean }
export interface MBatch { license: string; id: number; name: string | null; type: string | null; strain: string | null; location: string | null; location_id: number | null; untracked: number | null; planted_on: string | null; state: string }
export interface MCount { license: string; phase: string; location_id: number; location: string | null; strain: string; plants: number; oldest: string | null; newest: string | null }
export interface LocMap { app_kind: 'field' | 'room' | 'drying' | 'packages'; app_ref: string; license: string; location_id: number; location: string | null }
export interface StrainMap { app_strain: string; license: string; strain_id: number; strain: string | null }
export interface NurseryRecon { kind: 'clones' | 'mothers'; issue: 'count' | 'not_in_metrc' | 'no_tag' | 'not_in_app' | 'closed_in_app'; tag: string | null; strain: string | null; name: string | null
  app_n: number | null; metrc_n: number | null; metrc_item: string | null; metrc_location: string | null; metrc_state: string | null; ref_id: number | null; note: string | null }
export interface MapData {
  locs: MLoc[]; strains: MStrain[]; batches: MBatch[]; counts: MCount[]; locMap: LocMap[]; strainMap: StrainMap[]
  fields: { id: number; site: string; code: string | null; name: string; active: boolean }[]
  rooms: { id: number; site: string; name: string; active: boolean }[]
  appStrains: string[]
  licenses: { license_no: string; kind: string; site: string | null; active: boolean }[]
  nurserySites: { code: string; license: string | null }[]
}
export interface LiveRecon {
  issue: 'weight' | 'not_in_metrc' | 'not_in_app' | 'closed_in_app' | 'other_license' | 'item' | 'on_hold' | 'tag_pending' | 'stale'
  tag: string | null; pallet_id: number | null; code: string | null; strain: string | null; app_lbs: number | null; metrc_lbs: number | null
  app_item: string | null; metrc_item: string | null; app_license: string | null; metrc_location: string | null; app_spot: string | null
  metrc_changed: string | null; explain: string | null; trail: unknown; note: string | null
}
export interface SyncStatus { license: string; site: string | null; last_pull: string | null; complete: boolean; active: number; error: string | null }
export interface SyncResult { done: boolean; closed: number; results: { license: string; complete: boolean; error?: string | null; active?: number; transfers?: number; left?: boolean }[]; error?: string }
export interface PushResult { id: number; state: 'checked' | 'sent' | 'failed' | 'waiting'; info?: string; error?: string }
export interface Upload { id: number; license: string; file_name: string | null; rows: number; uploaded_by: string | null; uploaded_at: string }
export interface Recon {
  issue: 'not_in_app' | 'closed_in_app' | 'not_in_metrc' | 'other_license' | 'weight' | 'item' | 'on_hold' | 'tag_pending' | 'stale'
  tag: string | null; pallet_id: number | null; code: string | null; strain: string | null; app_lbs: number | null; metrc_lbs: number | null
  app_item: string | null; metrc_item: string | null; app_license: string | null; note: string | null
}
export interface MError {
  id: number; happened_on: string; license: string | null; tag: string | null; action: string | null; what: string; error_text: string | null
  status: 'open' | 'fixed'; assigned_to: string | null; fix: string | null; playbook_id: number | null; created_by: string | null; created_at: string
  fixed_by: string | null; fixed_at: string | null
}
export interface Play { id?: number; title: string; symptom: string | null; fix: string; tags: string[]; created_by?: string | null; updated_by?: string | null; updated_at?: string }
export interface License { license_no: string; kind: string; tier: string | null; entity: string | null; dba: string | null; site: string | null; premises: string | null; address: string | null; expires: string | null; active: boolean; sort: number }
export interface CustLic { id: number; name: string; license: string | null; license_expires: string | null; docs: number; last_order: string | null; status: 'missing' | 'no_expiry' | 'expired' | 'expiring' | 'ok' }
export interface BackupRun { id: number; started_at: string; finished_at: string | null; started_by: string | null; copied: number; archived: number; failed: number; left_over: number; error: string | null }
export interface TestNoFile { id: number; kind: string; site: string; ref: string; results_on: string; result: string | null; lab: string | null }
export interface Overview {
  overdue: number; due_soon: number; due_30: number; no_date: number; docs: number; docs_by_type: Record<string, number>
  metrc_todo: number; metrc_error: number; errors_open: number; playbook: number
  materials: number; materials_approved: number; materials_unreviewed: number; materials_no_docs: number; material_issues: number
  last_recon: Record<string, string>; licenses: string[]; customers_missing: number; tests_no_file: number
  not_on_list?: number; ccof_list?: { entries: number; date: string | null; action: number }; certs?: Record<string, boolean>
  backup: BackupRun | null; backup_waiting: number; sp_site: string | null; sp_root: string | null; weight_tol: string | null; stale_days: string | null
}
export interface Trace {
  harvest: { id: number; kind: string; site: string; field: string | null; strain: string; harvested_on: string | null; crop_year: number; metrc_name: string | null } | null
  test: { id: number; kind: 'area' | 'strain'; lab: string | null; test_ref: string | null; sampled_on: string | null; results_on: string | null; result: string | null
    total_thc: number | null; total_cannabinoids: number | null; moisture: number | null; files: FileRef[] } | null
  docs: FileRef[]
}

export const STATUS_LABEL: Record<Material['ccof_status'], string> = { approved: 'Approved', pending: 'Pending', not_allowed: 'Not allowed', unknown: 'Not reviewed' }
export const CATEGORY_LABEL: Record<string, string> = { license: 'License', ccof: 'CCOF', metrc: 'METRC', testing: 'Testing', report: 'Report', sop: 'SOP', tax: 'Tax', insurance: 'Insurance', vehicles: 'Vehicles', other: 'Other' }

const safeName = (n: string) => n.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-80) || 'file'
const uuid = () => (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export class CompApi {
  constructor(public sb: SupabaseClient) {}
  private async rpc<T>(fn: string, args?: object): Promise<T> { const { data, error } = await this.sb.rpc(fn, args ?? {}); fail(error); return data as T }

  // ----- files -----
  /** put a file in the private bucket; returns its path */
  async upload(file: File, docType: string): Promise<string> {
    const path = `${docType}/${new Date().getFullYear()}/${uuid()}-${safeName(file.name)}`
    const { error } = await this.sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
    if (error) throw new Error(/bucket|not found/i.test(error.message) ? `${error.message} (run 055_compliance.sql in Supabase)` : error.message)
    return path
  }
  async signedUrl(path: string, download?: string): Promise<string> {
    const { data, error } = await this.sb.storage.from(BUCKET).createSignedUrl(path, 300, download ? { download } : undefined)
    if (error) throw new Error(error.message)
    return data.signedUrl
  }
  /** open a stored file in a new tab (the tab opens first so phones don't block it) */
  async open(f: { file_path: string | null; link_url: string | null; file_name?: string | null }) {
    if (!f.file_path && f.link_url) { window.open(f.link_url, '_blank', 'noopener'); return }
    if (!f.file_path) return
    const w = window.open('', '_blank')
    try { const u = await this.signedUrl(f.file_path); if (w) w.location.href = u; else window.location.href = u }
    catch (e) { w?.close(); throw e }
  }
  async addDoc(p: Record<string, unknown>) { return this.rpc<number>('comp_add_doc', { p }) }
  async updateDoc(id: number, p: Record<string, unknown>) { return this.rpc<void>('comp_update_doc', { p_id: id, p }) }
  async deleteDoc(id: number) { return this.rpc<void>('comp_delete_doc', { p_id: id }) }
  async link(doc: number, kind: RefKind, ref: string, on = true) { return this.rpc<void>('comp_link_doc', { p_doc: doc, p_kind: kind, p_ref: ref, p_on: on }) }

  async docTypes() { const { data, error } = await this.sb.from('comp_doc_types').select('*').order('sort').order('label'); fail(error); return (data ?? []) as DocType[] }
  async saveDocType(t: Partial<DocType>) { return this.rpc<void>('comp_save_doc_type', { p: t }) }
  async docs(opts: { deleted?: boolean } = {}) {
    let q = this.sb.from('comp_docs').select('*, links:comp_doc_links(doc_id, ref_kind, ref_id)').order('created_at', { ascending: false }).limit(5000)
    q = opts.deleted ? q.not('deleted_at', 'is', null) : q.is('deleted_at', null)
    const { data, error } = await q; fail(error); return (data ?? []) as Doc[]
  }
  async docsFor(kind: RefKind, ref: string | number) {
    const { data, error } = await this.sb.from('comp_doc_links').select('doc:comp_docs(*)').eq('ref_kind', kind).eq('ref_id', String(ref))
    fail(error)
    return ((data ?? []) as unknown as { doc: Doc | null }[]).map(x => x.doc).filter((d): d is Doc => !!d && !d.deleted_at && d.current)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }
  async versions(id: number) {
    // walk back through replaces_id
    const out: Doc[] = []
    let cur: number | null = id
    for (let i = 0; cur != null && i < 30; i++) {
      const r: { data: unknown; error: { message: string } | null } = await this.sb.from('comp_docs').select('*').eq('id', cur).maybeSingle(); fail(r.error)
      const d = r.data as Doc | null
      if (!d) break
      out.push(d); cur = d.replaces_id
    }
    return out
  }

  // ----- deadlines -----
  deadlines() { return this.rpc<Deadline[]>('comp_deadlines') }
  async obligations() { const { data, error } = await this.sb.from('comp_obligations').select('*').order('due_on', { nullsFirst: true }); fail(error); return (data ?? []) as (Obligation & { id: number })[] }
  async obLog(id: number) { const { data, error } = await this.sb.from('comp_obligation_log').select('*').eq('obligation_id', id).order('done_on', { ascending: false }).limit(50); fail(error); return (data ?? []) as ObLog[] }
  saveObligation(o: Partial<Obligation>) { return this.rpc<number>('comp_save_obligation', { p: o }) }
  doneObligation(id: number, done: string, note: string | null, doc: number | null) { return this.rpc<string | null>('comp_done_obligation', { p_id: id, p_done: done, p_note: note, p_doc: doc }) }
  deleteObligation(id: number) { return this.rpc<void>('comp_delete_obligation', { p_id: id }) }

  // ----- CCOF -----
  async materials() { const { data, error } = await this.sb.from('input_products').select('*').order('name'); fail(error); return (data ?? []) as Material[] }
  setMaterial(id: number, p: Record<string, unknown>) { return this.rpc<void>('comp_set_material', { p_id: id, p }) }
  issues(since?: string) { return this.rpc<Issue[]>('comp_material_issues', { p_since: since ?? null }) }
  appLog(from: string, to: string, site: string | null, module: string | null) {
    return this.rpc<AppLog[]>('comp_app_log', { p_from: from, p_to: to, p_site: site, p_module: module }).then(r => (r ?? []).map(x => ({ ...x, products: x.products ?? [] })))
  }

  async ccofList() { const { data, error } = await this.sb.from('comp_ccof_list').select('*').eq('active', true).order('category').order('name'); fail(error); return (data ?? []) as CcofEntry[] }
  importCcof(date: string | null, rows: object[], file: string) { return this.rpc<{ new: number; updated: number; off_list: number; linked: number; active: number }>('comp_import_ccof', { p_date: date, p_rows: rows, p_file: file }) }
  linkCcof(product: number, code: string | null) { return this.rpc<void>('comp_link_ccof', { p_product: product, p_code: code ?? '' }) }
  async certs() { const { data, error } = await this.sb.from('comp_certs').select('*').order('site'); fail(error); return (data ?? []) as Cert[] }
  setCert(site: string, on: boolean, notes?: string) { return this.rpc<void>('comp_set_cert', { p_site: site, p_ccof: on, p_notes: notes ?? null }) }

  // ----- METRC -----
  async actions(status: string | null, limit = 2000) {
    let q = this.sb.from('comp_metrc_actions').select('*').order('at', { ascending: false }).limit(limit)
    if (status) q = q.eq('status', status)
    const { data, error } = await q; fail(error); return (data ?? []) as MAction[]
  }
  setActions(ids: number[], status: MAction['status'], note?: string) { return this.rpc<number>('comp_metrc_set', { p_ids: ids, p_status: status, p_note: note ?? null }) }
  async uploads() { const { data, error } = await this.sb.from('comp_metrc_uploads').select('*').order('uploaded_at', { ascending: false }).limit(60); fail(error); return (data ?? []) as Upload[] }
  uploadMetrc(license: string, file: string, rows: object[]) { return this.rpc<number>('comp_metrc_upload', { p_license: license, p_file: file, p_rows: rows }) }
  reconcile(id: number) { return this.rpc<Recon[]>('comp_reconcile', { p_upload: id }) }
  async errors() { const { data, error } = await this.sb.from('comp_metrc_errors').select('*').order('happened_on', { ascending: false }).order('id', { ascending: false }).limit(500); fail(error); return (data ?? []) as MError[] }
  saveError(e: Partial<MError>) { return this.rpc<number>('comp_save_error', { p: e }) }
  fixError(id: number, fix: string, playbook: boolean, title: string | null, reopen = false) { return this.rpc<number | null>('comp_fix_error', { p_id: id, p_fix: fix, p_playbook: playbook, p_title: title, p_reopen: reopen }) }
  async playbook() { const { data, error } = await this.sb.from('comp_playbook').select('*').order('title'); fail(error); return (data ?? []) as Play[] }
  savePlay(p: Partial<Play> & { delete?: boolean }) { return this.rpc<number>('comp_save_playbook', { p }) }

  // ----- licenses, customers, testing -----
  async licenses() { const { data, error } = await this.sb.from('licenses').select('*').order('sort').order('license_no'); fail(error); return (data ?? []) as License[] }
  setLicenseExpiry(no: string, d: string | null) { return this.rpc<void>('comp_set_license_expiry', { p_license: no, p_expires: d }) }
  customers() { return this.rpc<CustLic[]>('comp_customers') }
  setCustomerLicense(id: number, license: string | null, expires: string | null) { return this.rpc<void>('comp_set_customer_license', { p_customer: id, p_license: license, p_expires: expires }) }
  testsNoFile() { return this.rpc<TestNoFile[]>('comp_tests_no_file') }
  trace(palletId: number) { return this.rpc<Trace | null>('pallet_trace', { p_pallet: palletId }) }

  // ----- dashboard, settings -----
  overview() { return this.rpc<Overview>('comp_overview') }
  setSetting(key: string, value: string) { return this.rpc<void>('comp_set_setting', { p_key: key, p_value: value }) }
  async backupRuns() { const { data, error } = await this.sb.from('comp_backup_runs').select('*').order('id', { ascending: false }).limit(10); fail(error); return (data ?? []) as BackupRun[] }
  // ----- METRC through T3 -----
  async pushKinds() { const { data, error } = await this.sb.from('metrc_push_kinds').select('*').order('sort'); fail(error); return (data ?? []) as PushKind[] }
  setPushMode(kind: string, mode: PushKind['mode']) { return this.rpc<void>('metrc_set_mode', { p_kind: kind, p_mode: mode }) }
  async t3Conn() { const { data, error } = await this.sb.from('metrc_connection').select('*').eq('id', 1).maybeSingle(); fail(error); return data as T3Conn | null }
  async metrc<T>(body: object): Promise<T> {
    const { data } = await this.sb.auth.getSession()
    const r = await fetch('/api/metrc/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    return j as T
  }
  reconcileNursery() { return this.rpc<NurseryRecon[]>('comp_reconcile_nursery', {}) }
  farmLicenses() { return this.rpc<{ license: string; site: string }[]>('comp_farm_licenses', {}) }
  reconcilePlants(license: string) { return this.rpc<PlantRecon[]>('comp_reconcile_plants', { p_license: license }) }
  reconcileFarmHarvests(license: string) { return this.rpc<HarvestRecon[]>('comp_reconcile_farm_harvests', { p_license: license }) }
  async countPlants(license: string) {
    const { data } = await this.sb.auth.getSession()
    const r = await fetch('/api/metrc/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify({ licenses: [license], only: 'plants' }) })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    return j as { done: boolean; results: { license: string; complete: boolean; error: string | null; plants: number; calls: number; notes: string[] }[] }
  }
  reconcileLive(license: string) { return this.rpc<LiveRecon[]>('comp_reconcile_view', { p_license: license }) }
  reconApply(rows: { key: string; action: string; reason: string }[], dry: boolean) {
    return this.rpc<{ dry: boolean; done: number; skipped: number; rows: { key: string; action: string; ok: boolean; msg: string | null; code: string | null; issue: string }[] }>('comp_recon_apply', { p_rows: rows, p_dry: dry })
  }
  syncStatus() { return this.rpc<SyncStatus[]>('metrc_sync_status') }
  async pullMetrc(licenses?: string[]) {
    const { data } = await this.sb.auth.getSession()
    const r = await fetch('/api/metrc/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify({ licenses }) })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    return j as SyncResult
  }
  testT3() { return this.metrc<T3Conn>({ action: 'test' }) }
  // ----- Phase 2 mapping -----
  async mapData(): Promise<MapData> {
    const all = async <T,>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
      const out: T[] = []
      for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); fail(error); const d = (data ?? []) as T[]; out.push(...d); if (d.length < 1000) break }
      return out
    }
    const sb = this.sb
    const [locs, strains, batches, counts, locMap, strainMap, fields, rooms, st, licenses, nurserySites] = await Promise.all([
      all<MLoc>((a, b) => sb.from('metrc_locations').select('*').eq('archived', false).order('name').range(a, b)),
      all<MStrain>((a, b) => sb.from('metrc_strains').select('*').eq('archived', false).order('name').range(a, b)),
      all<MBatch>((a, b) => sb.from('metrc_plant_batches').select('license,id,name,type,strain,location,location_id,untracked,planted_on,state').eq('state', 'active').order('name').range(a, b)),
      all<MCount>((a, b) => sb.from('metrc_plant_counts').select('*').eq('run', 'live').range(a, b)),
      all<LocMap>((a, b) => sb.from('metrc_location_map').select('*').range(a, b)),
      all<StrainMap>((a, b) => sb.from('metrc_strain_map').select('*').range(a, b)),
      all<MapData['fields'][number]>((a, b) => sb.from('fields').select('id,site,code,name,active').order('site').order('sort').range(a, b)),
      all<MapData['rooms'][number]>((a, b) => sb.from('nursery_rooms').select('id,site,name,active').order('site').order('sort').range(a, b)),
      all<{ name: string }>((a, b) => sb.from('strains').select('name').eq('active', true).order('name').range(a, b)),
      all<MapData['licenses'][number]>((a, b) => sb.from('licenses').select('license_no,kind,site,active').range(a, b)),
      all<MapData['nurserySites'][number]>((a, b) => sb.from('nursery_sites').select('code,license').range(a, b)),
    ])
    return { locs, strains, batches, counts, locMap, strainMap, fields, rooms, appStrains: st.map(x => x.name), licenses, nurserySites }
  }
  mapLocation(kind: LocMap['app_kind'], ref: string, license: string, locationId: number | null) { return this.rpc<void>('metrc_map_location', { p_kind: kind, p_ref: ref, p_license: license, p_location_id: locationId }) }
  mapStrain(strain: string, license: string, strainId: number | null) { return this.rpc<void>('metrc_map_strain', { p_strain: strain, p_license: license, p_strain_id: strainId }) }
  sendMetrc(ids: number[]) { return this.metrc<{ live: boolean; results: PushResult[]; not_sent: number[]; out_of_time?: number[] }>({ action: 'send', ids }) }
  /** start the SharePoint backup now (server function) */
  async runBackup() {
    const { data } = await this.sb.auth.getSession()
    const r = await fetch('/api/compliance/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: '{}' })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    return j as { copied?: number; archived?: number; failed?: number; left_over?: number; skipped?: string; error?: string }
  }
}

export interface PlantRecon { strain: string; metrc_strain: string | null; fields: string | null; metrc_locations: string | null; plantings: number
  planted: number; app_harvested: number; app_live: number; metrc_immature: number; metrc_flowering: number | null; metrc_live: number; metrc_harvested: number
  metrc_counted: string | null; diff: number; issue: 'ok' | 'not_counted' | 'not_in_app' | 'not_in_metrc' | 'harvest_count' | 'harvest_behind' | 'not_flipped' | 'short' | 'over'; note: string | null }
export interface HarvestRecon { harvest_id: number | null; metrc_id: number | null; name: string | null; strain: string | null; field: string | null; harvested_on: string | null; kind: string | null
  app_plants: number | null; metrc_plants: number | null; app_wet: number | null; metrc_wet: number | null; metrc_left: number | null; metrc_packaged: number | null; metrc_finished: boolean | null
  issue: 'ok' | 'not_in_app' | 'no_name' | 'not_in_metrc' | 'plants' | 'weight' | 'open'; note: string | null }
