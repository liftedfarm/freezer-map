import type { SupabaseClient } from '@supabase/supabase-js'

// Compliance module: documents (private storage bucket "compliance"), deadlines, CCOF materials, METRC queue / reconcile / errors.

function fail(error: { message: string } | null) {
  if (!error) return
  if (/comp_|pallet_trace|test_files|customer_license_status|does not exist|schema cache/i.test(error.message) && /function|relation|column/i.test(error.message))
    throw new Error(`${error.message} (run 055_compliance.sql in Supabase)`)
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
export type RefKind = 'test' | 'pallet' | 'lot' | 'harvest' | 'material' | 'license' | 'customer' | 'metrc_error' | 'obligation' | 'processor'
export interface Link { doc_id: number; ref_kind: RefKind; ref_id: string }
export interface FileRef { id: number; title: string; file_name: string | null; file_path: string | null; link_url: string | null; mime: string | null }

export interface Deadline {
  kind: 'obligation' | 'doc' | 'license' | 'material' | 'customer'; ref: string; title: string; category: string; site: string | null
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
  restrictions: string | null; ccof_notes: string | null; ccof_by: string | null; ccof_at: string | null
}
export interface Issue { log_id: number; module: string; log_on: string; site: string | null; area: string | null; product: string; issue: string; product_id: number | null }
export interface ProductLine { product: string; manufacturer?: string | null; rate?: number | null; unit?: string | null; basis?: string | null; total?: number | null; total_unit?: string | null }
export interface AppLog {
  id: number; module: string; kind: 'feed' | 'spray'; site: string | null; area: string | null; log_on: string; method: string | null; spray_type: string | null
  water_gal: number | null; acres: number | null; sqft: number | null; run_min: number | null; applicator: string | null; products: ProductLine[]; notes: string | null; strain: string | null
}

export interface MAction {
  id: number; at: string; license: string | null; action: string; pallet_id: number | null; code: string | null; tag: string | null; lbs: number | null
  summary: string | null; details: Record<string, unknown> | null; status: 'todo' | 'done' | 'error' | 'skipped'; note: string | null; done_by: string | null; done_at: string | null
}
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
  backup: BackupRun | null; backup_waiting: number; sp_site: string | null; sp_root: string | null; weight_tol: string | null; stale_days: string | null
}
export interface Trace {
  harvest: { id: number; kind: string; site: string; field: string | null; strain: string; harvested_on: string | null; crop_year: number; metrc_name: string | null } | null
  test: { id: number; kind: 'area' | 'strain'; lab: string | null; test_ref: string | null; sampled_on: string | null; results_on: string | null; result: string | null
    total_thc: number | null; total_cannabinoids: number | null; moisture: number | null; files: FileRef[] } | null
  docs: FileRef[]
}

export const STATUS_LABEL: Record<Material['ccof_status'], string> = { approved: 'Approved', pending: 'Pending', not_allowed: 'Not allowed', unknown: 'Not reviewed' }
export const CATEGORY_LABEL: Record<string, string> = { license: 'License', ccof: 'CCOF', metrc: 'METRC', testing: 'Testing', report: 'Report', sop: 'SOP', tax: 'Tax', insurance: 'Insurance', other: 'Other' }

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
  /** start the SharePoint backup now (server function) */
  async runBackup() {
    const { data } = await this.sb.auth.getSession()
    const r = await fetch('/api/compliance/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: '{}' })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    return j as { copied?: number; archived?: number; failed?: number; left_over?: number; skipped?: string; error?: string }
  }
}
