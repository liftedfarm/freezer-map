import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { accessFromRole } from './types'
import type { SalesDoc } from './docs'
import type { Item, HarvestLot, LotImpact, Invoice, NewOrderLine, PaymentTerm, FOrder, Prefs, ModKey, Level, ReserveYears, CustomerTerms, UnmatchedTag, ShippedCheck, StopManifest, OrderInput, Terms, Statement, SampleHold, MenuNumbers, MenuRow, ReserveRequest, Balance, ImportResult, Order, RoshiRow, Reserve, LinkInfo, AppUser, Customer, Me, Role, Freezer, FreezerStatus, InvEvent, ListName, ListRow, Load, LoadItem, LoadStop, MixLine, Pallet, Settings, SingleInput, Slot, Snapshot, StopInput, Strain, Vehicle } from './types'

export interface SaveUser { email: string; name: string; kind: 'staff' | 'customer' | 'none'; customerId: number | null; access: Partial<Record<ModKey, Level>>; owner?: boolean; login?: 'microsoft' | 'email' | null }
export interface Overview {
  crop_year: number
  freezers: { lbs: number; pallets: number }; open_spaces: number; needs_spot: number
  loads: { active: number; in_transit: number }
  season: { harvests: number; done: number; est: number; done_est: number; actual: number; unlogged: number }
  reserves: { reserved: number; shipped: number; pending: number; remaining: number; customers: number }
  next: { year: number; deadline: string | null; reserved: number; customers: number; requested: number }
  sales: { requests: number; to_confirm: number; orders_month: number; lbs_ordered_month: number; lbs_shipped_month: number; value_month: number }
  people: { staff: number; staff_week: number; customers: number; customers_month: number; owners: number; by_module: Record<string, number> | null; view_only?: number }
  // 038 and later (missing before it's run)
  open_orders?: number
  nursery?: { moms: number; mom_lots: number; rooting_batches: number; rooting: number; ready: number; open_orders: number; owed: number; late: number; delivered_month: number
    delivered_year: number; positive_tests: number; no_tag: number; runs: number; hunts: number; phenos: number; scored: number; keepers: number }
  billing?: { open: number; open_amt: number; overdue: number; overdue_amt: number; billed_month: number; paid_month: number; not_sent: number; nursery_open_amt: number }
  logs?: { month: number; by: Record<string, number>; pesticide_month: number; labor_hours_month: number; last: string | null }
  licenses?: { active: number; expiring: { license: string; kind: string; expires: string }[] }
}

export interface Backend {
  demo: boolean
  getUser(): Promise<string | null>
  signIn(): Promise<void>
  /** staff without a Lifted email (058): a 6-digit code by email */
  sendCode(email: string): Promise<void>
  verifyCode(email: string, code: string): Promise<void>
  signOut(): Promise<void>
  me(): Promise<Me>
  listUsers(): Promise<AppUser[]>
  setUser(email: string, role: Role, customerId: number | null, name: string): Promise<void>
  removeUser(email: string): Promise<void>
  userLogins(): Promise<Map<string, { claimed: boolean; invited_at: string | null }>>
  makeLoginLink(email: string, kind: 'invite' | 'reset'): Promise<string>
  checkLink(code: string): Promise<LinkInfo | null>
  claimInvite(code: string, email: string, password: string): Promise<void>
  resetPassword(code: string, password: string): Promise<string>
  passwordSignIn(email: string, password: string): Promise<void>
  changePassword(password: string): Promise<void>
  listReserves(): Promise<Reserve[]>
  listBalances(): Promise<Balance[]>
  openMenu(): Promise<MenuRow[]>
  menuNumbers(): Promise<MenuNumbers[]>
  listRequests(): Promise<ReserveRequest[]>
  requestReserve(strain: string, lbs: number, note: string, year?: number): Promise<void>
  reserveYears(): Promise<ReserveYears>
  requestReserveBatch(year: number, lines: { strain: string; lbs: number }[], note: string): Promise<number>
  decideRequests(items: { id: number; approve: boolean; lbs: number | null }[], note: string): Promise<{ approved: number; declined: number }>
  reserveStrains(): Promise<string[]>
  setReserveDeadline(year: number, date: string | null): Promise<void>
  listTerms(): Promise<CustomerTerms[]>
  setTerms(t: CustomerTerms, clear?: boolean): Promise<void>
  myTermsFor(year: number): Promise<{ price_per_lb: number | null; contract_lbs: number | null } | null>
  cancelRequest(id: number): Promise<void>
  decideRequest(id: number, approve: boolean, note: string): Promise<void>
  listOrders(): Promise<Order[]>
  salesCounts(): Promise<{ orders: number; requests: number }>
  placeOrder(lines: OrderInput[], note: string, po: string, wanted: string | null, sample?: boolean): Promise<number>
  /** sample holds (061) */
  sampleHolds(customerId?: number | null, all?: boolean): Promise<SampleHold[]>
  setOrderSample(orderId: number, sample: boolean, holds: { line_id?: number; strain?: string; hold_lbs: number | null }[]): Promise<void>
  setSampleHold(lineId: number, release: boolean, until?: string | null): Promise<void>
  mySampleHoldDays(): Promise<number | null>
  cancelMyOrder(id: number): Promise<void>
  setOrderStatus(id: number, status: string, so: string, note: string, date?: string | null): Promise<void>
  setSpan(palletId: number, toSlot: number | null): Promise<void>
  setOrderLine(orderId: number, lineId: number | null, strain: string, lbs: number, price: number | null): Promise<void>
  myTerms(): Promise<Terms | null>
  /** customer dashboard + statement (060): customers get their own; Sales / Accounting pass a customer */
  statement(customerId?: number | null): Promise<Statement | null>
  startViewAs(email: string): Promise<void>
  stopViewAs(): Promise<void>
  importRoshi(rows: RoshiRow[]): Promise<ImportResult>
  setReserve(customerId: number, strain: string, lbs: number, note?: string, year?: number): Promise<void>
  load(): Promise<Snapshot>
  movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string): Promise<void>
  setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string): Promise<void>
  clearReview(palletId: number, note?: string): Promise<void>
  splitPallet(palletId: number, lbs: number, tag: string | null, tagPending: boolean, destSlot: number | null, note?: string): Promise<Pallet>
  createMixed(slotId: number, lines: MixLine[], note?: string): Promise<Pallet>
  addToMixed(mixedId: number, lines: MixLine[], note?: string): Promise<void>
  takeOffMixed(palletId: number, slotId: number, note?: string): Promise<void>
  breakMixed(mixedId: number, note?: string): Promise<void>
  createSingle(slotId: number, input: SingleInput): Promise<Pallet>
  createLoad(vehicleId: number, date: string, stops: StopInput[], driver: string, notes: string): Promise<Load>
  updateLoad(loadId: number, vehicleId: number, date: string, driver: string, notes: string): Promise<void>
  setStops(loadId: number, stops: StopInput[]): Promise<void>
  planPallet(loadId: number, stopId: number, palletId: number, position: number | null, share: boolean): Promise<void>
  moveItem(itemId: number, position: number | null, stopId: number | null, share: boolean): Promise<void>
  arrangeLoad(loadId: number): Promise<void>
  removeItem(itemId: number): Promise<void>
  loadPallet(itemId: number): Promise<void>
  unloadPallet(itemId: number, slotId: number): Promise<void>
  departLoad(loadId: number): Promise<void>
  deliverStop(stopId: number): Promise<void>
  cancelLoad(loadId: number): Promise<void>
  mergePallets(ids: number[], tag: string | null, tagPending: boolean, destSlot: number | null, note?: string): Promise<Pallet>
  setTag(palletId: number, tag: string, note?: string): Promise<void>
  adjustWeight(palletId: number, weight: number, note?: string, reason?: string): Promise<void>
  applyMoves(moves: { pallet_id: number; from_slot: number | null; to_slot: number; kind: string }[], note?: string): Promise<string>
  undoBatch(batch: string): Promise<number>
  removePallet(id: number, reason: string, note: string): Promise<void>
  markShipped(palletId: number, note?: string): Promise<void>
  ackShipped(tag: string): Promise<void>
  dismissTag(tag: string): Promise<void>
  nextTags(site: string, purpose: string, n: number): Promise<string[]>
  lineage(p: Pallet): Promise<Pallet[]>
  byIds(ids: number[]): Promise<Pallet[]>
  loadSettings(): Promise<Settings>
  saveRow(list: ListName, row: Partial<ListRow>): Promise<void>
  palletEvents(palletId: number): Promise<InvEvent[]>
  recentEvents(limit: number): Promise<InvEvent[]>
  search(q: string): Promise<Pallet[]>
  subscribe(onChange: () => void): () => void
  /** Admin module > Users: save a person (kind, customer, level per module, Owner) */
  saveUser(u: SaveUser): Promise<void>
  /** top bar ⚙: your own settings */
  setMyPrefs(p: Prefs): Promise<Prefs>
  setUserLang(email: string, lang: 'en' | 'es'): Promise<void>
  setMyName(name: string): Promise<void>
  /** Fulfillment: open orders with their assigned pallets (no prices) */
  fulfillmentOrders(): Promise<FOrder[]>
  pickPallet(lineId: number, palletId: number): Promise<void>
  pickPart(lineId: number, palletId: number, lbs: number, tag: string | null): Promise<void>
  unpick(pickId: number): Promise<void>
  cantFill(lineId: number, on: boolean): Promise<void>
  approveFill(orderId: number, note?: string): Promise<number>
  orderToLoad(orderId: number, loadId: number): Promise<void>
  orderOffLoad(orderId: number): Promise<void>
  orderTransfer(orderId: number, loadId: number, site: string): Promise<number>
  orderTransferNew(orderId: number, vehicleId: number, date: string, site: string): Promise<number>
  stopManifest(stopId: number): Promise<StopManifest>
  setPalletOrigin(palletId: number, site: string): Promise<void>
  /** SHO / BHO: a whole harvest lot (null = strain default) or one pallet (null = follow the lot). Lot change returns what it touched. */
  setLotGrade(lotId: number, grade: string | null, reason?: string): Promise<LotImpact>
  setPalletGrade(palletId: number, grade: string | null, reason?: string): Promise<void>
  /** Sales orders and invoices (027) */
  getDoc(kind: 'invoice' | 'so' | 'nso', id: number): Promise<SalesDoc>
  sharedDoc(token: string): Promise<SalesDoc | null>
  paymentTerms(): Promise<PaymentTerm[]>
  setPaymentTerm(t: { code: string; label: string; schedule: { pct: number; days: number }[]; cod: boolean; active: boolean }): Promise<void>
  createOrder(customerId: number, lines: NewOrderLine[], po: string, wanted: string | null, notes: string, terms: string | null): Promise<{ id: number; so_number: string }>
  setOrderTerms(orderId: number, terms: string | null): Promise<void>
  makeInvoice(orderId: number): Promise<Invoice>
  listInvoices(scope?: 'sales' | 'nursery'): Promise<Invoice[]>
  setInvoiceTerms(id: number, terms: string): Promise<void>
  setInvoiceInfo(id: number, date: string | null, po: string, notes: string): Promise<void>
  setInvoiceLine(id: number, lineId: number | null, description: string, qty: number | null, price: number | null, uom?: string): Promise<void>
  removeInvoiceLine(id: number, lineId: number): Promise<void>
  setInvoiceStatus(id: number, status: 'open' | 'paid' | 'void', note?: string): Promise<void>
  markInvoiceSent(id: number, to: string): Promise<void>
  /** Admin module */
  adminOverview(): Promise<Overview>
  /** dashboard trend lines (066): save today's numbers / read saved days. Both quietly do nothing before 066 is run. */
  dashRecord(p: Record<string, number>): Promise<void>
  dashSeries(keys: string[], from: string): Promise<{ day: string; key: string; value: number }[]>
  appSettings(): Promise<Record<string, string>>
  setAppSetting(key: string, value: string): Promise<void>
  /** the database client, for modules that talk to their own tables (null in the demo) */
  client(): SupabaseClient | null
}

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// the customer portal's address (a second domain on the same Vercel project)
export const PORTAL_ORIGIN = (import.meta.env.VITE_PORTAL_URL as string | undefined) ?? 'https://www.lifted-orders.app'
export const portalUrl = (rest = '') => (import.meta.env.DEV ? location.origin + '/' : PORTAL_ORIGIN.replace(/\/$/, '') + '/') + rest
export const IS_PORTAL = /order/i.test(location.hostname) || new URLSearchParams(location.search).has('portal')

export const CONFIG_MISSING = !(URL_ && KEY) && !import.meta.env.DEV

export function makeBackend(): Backend {
  const wantDemo = new URLSearchParams(location.search).has('demo')
  if (!wantDemo && URL_ && KEY) return new SupaBackend(createClient(URL_, KEY))
  return new DemoBackend()
}

// ---------------- Supabase ----------------

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const { data, error } = await fetchPage(from, from + size - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < size) return out
  }
}

function fail(error: { message: string } | null, sql?: string) {
  if (error && sql && /Could not find the function|does not exist|schema cache/i.test(error.message)) throw new Error(`Run ${sql}.sql in Supabase first`)
  if (error) throw new Error(error.message)
}

class SupaBackend implements Backend {
  demo = false
  constructor(private sb: SupabaseClient) {}

  async getUser() {
    const { data } = await this.sb.auth.getSession()
    return data.session?.user.email ?? null
  }
  async sendCode(email: string) {
    const { error } = await this.sb.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } })
    if (error) throw new Error(/rate limit/i.test(error.message) ? 'Too many codes asked for. Wait a minute and try again.' : error.message)
  }
  async verifyCode(email: string, code: string) {
    const { error } = await this.sb.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' })
    if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'That code is wrong or has expired. Ask for a new one.' : error.message)
    location.reload()
  }
  async signIn() {
    await this.sb.auth.signInWithOAuth({
      provider: 'azure',
      options: { scopes: 'email', redirectTo: location.origin },
    })
  }
  async signOut() {
    await this.sb.auth.signOut()
  }
  private role: Role = 'crew'
  async me(): Promise<Me> {
    const email = (await this.getUser()) ?? ''
    const { data, error } = await this.sb.rpc('whoami')
    // before the roles update (007) is run, everyone keeps full access
    if (error && /whoami/.test(error.message)) return { email, role: (this.role = 'admin'), display_name: null, customer_id: null, customer_name: null, access: accessFromRole('admin') }
    fail(error)
    const me = data as Me
    this.role = me.role
    if (!me.access) {   // before 023 is run: work it out from the old role
      const { data: mods } = await this.sb.rpc('my_modules')
      me.access = accessFromRole(me.role, (mods ?? []) as string[])
    }
    return me
  }
  async listUsers() {
    const [{ data, error }, acc] = await Promise.all([this.sb.from('app_users').select('*').order('email'), this.sb.from('module_access').select('*')])
    fail(error)
    const users = (data ?? []) as AppUser[]
    if (acc.error) return users.map(u => ({ ...u, access: accessFromRole(u.role, u.modules ?? []).modules }))   // before 023
    for (const u of users) u.access = Object.fromEntries((acc.data as { email: string; module: ModKey; level: Level }[]).filter(a => a.email === u.email).map(a => [a.module, a.level]))
    return users
  }
  async saveUser(u: SaveUser) {
    const { error } = await this.sb.rpc('save_user', { p_email: u.email, p_name: u.name || null, p_kind: u.kind, p_customer: u.customerId,
      p_access: u.access, p_owner: u.owner ?? null, ...(u.login ? { p_login: u.login } : {}) })
    if (error && /save_user/.test(error.message)) throw new Error('Run 024_module_roles.sql in Supabase first')
    fail(error)
  }
  async setUserLang(email: string, lang: 'en' | 'es') {
    const { error } = await this.sb.rpc('set_user_lang', { p_email: email, p_lang: lang })
    if (error && /set_user_lang/.test(error.message)) throw new Error('Run 036_language.sql in Supabase first')
    fail(error)
  }
  async setMyPrefs(p: Prefs) {
    const { data, error } = await this.sb.rpc('set_my_prefs', { p })
    if (error && /set_my_prefs/.test(error.message)) throw new Error('Run 024_module_roles.sql in Supabase first')
    fail(error); return (data ?? {}) as Prefs
  }
  async fulfillmentOrders() {
    const { data, error } = await this.sb.rpc('fulfillment_orders')
    if (error && /fulfillment_orders/.test(error.message)) throw new Error('Fulfillment isn\'t set up in the database yet. Run 025_fulfillment.sql in Supabase, then refresh.')
    fail(error); return (data ?? []) as FOrder[]
  }
  async pickPallet(lineId: number, palletId: number) { const { error } = await this.sb.rpc('pick_pallet', { p_line: lineId, p_pallet: palletId }); fail(error) }
  async pickPart(lineId: number, palletId: number, lbs: number, tag: string | null) {
    const { error } = await this.sb.rpc('pick_part', { p_line: lineId, p_pallet: palletId, p_lbs: lbs, p_tag: tag, p_tag_pending: !tag }); fail(error)
  }
  async unpick(pickId: number) { const { error } = await this.sb.rpc('unpick', { p_pick: pickId }); fail(error) }
  async cantFill(lineId: number, on: boolean) { const { error } = await this.sb.rpc('cant_fill', { p_line: lineId, p_on: on }); fail(error) }
  async approveFill(orderId: number, note?: string) { const { data, error } = await this.sb.rpc('approve_fill', { p_order: orderId, p_note: note ?? null }); fail(error); return Number(data ?? 0) }
  async orderToLoad(orderId: number, loadId: number) { const { error } = await this.sb.rpc('order_to_load', { p_order: orderId, p_load: loadId }); fail(error) }
  async orderOffLoad(orderId: number) { const { error } = await this.sb.rpc('order_off_load', { p_order: orderId }); fail(error) }
  async orderTransfer(orderId: number, loadId: number, site: string) { const { data, error } = await this.sb.rpc('order_transfer', { p_order: orderId, p_load: loadId, p_site: site }); fail(error, '045_transfers'); return data as number }
  async orderTransferNew(orderId: number, vehicleId: number, date: string, site: string) { const { data, error } = await this.sb.rpc('order_transfer_new', { p_order: orderId, p_vehicle: vehicleId, p_date: date, p_site: site }); fail(error, '045_transfers'); return data as number }
  async stopManifest(stopId: number) { const { data, error } = await this.sb.rpc('stop_manifest', { p_stop: stopId }); fail(error, '045_transfers'); return data as StopManifest }
  async setPalletOrigin(palletId: number, site: string) { const { error } = await this.sb.rpc('set_pallet_origin', { p_pallet: palletId, p_site: site }); fail(error, '045_transfers') }
  async setLotGrade(lotId: number, grade: string | null, reason?: string) {
    const { data, error } = await this.sb.rpc('set_lot_grade', { p_lot: lotId, p_grade: grade ?? '', p_reason: reason || null }); fail(error, '054_item_model')
    return data as LotImpact
  }
  async setPalletGrade(palletId: number, grade: string | null, reason?: string) {
    const { error } = await this.sb.rpc('set_pallet_grade', { p_pallet: palletId, p_grade: grade ?? '', p_reason: reason || null }); fail(error, '054_item_model')
  }
  async getDoc(kind: 'invoice' | 'so' | 'nso', id: number) {
    const { data, error } = await this.sb.rpc('get_doc', { p_kind: kind, p_id: id })
    if (error && /get_doc/.test(error.message)) throw new Error('Run 027_sales_docs.sql in Supabase first')
    fail(error); return data as SalesDoc
  }
  async sharedDoc(token: string) { const { data, error } = await this.sb.rpc('get_shared_doc', { p_token: token }); fail(error); return (data ?? null) as SalesDoc | null }
  async paymentTerms() {
    const { data, error } = await this.sb.from('payment_terms').select('*').order('sort')
    if (error) return [] as PaymentTerm[]   // before 027
    return (data ?? []) as PaymentTerm[]
  }
  async setPaymentTerm(t: { code: string; label: string; schedule: { pct: number; days: number }[]; cod: boolean; active: boolean }) {
    const { error } = await this.sb.rpc('set_payment_term', { p_code: t.code, p_label: t.label, p_schedule: t.schedule, p_cod: t.cod, p_active: t.active }); fail(error)
  }
  async createOrder(customerId: number, lines: NewOrderLine[], po: string, wanted: string | null, notes: string, terms: string | null) {
    const { data, error } = await this.sb.rpc('create_order', { p_customer: customerId, p_lines: lines, p_po: po || null, p_wanted: wanted, p_notes: notes || null, p_terms: terms, p_confirm: true })
    if (error && /create_order/.test(error.message)) throw new Error('Run 027_sales_docs.sql in Supabase first')
    fail(error); return data as { id: number; so_number: string }
  }
  async setOrderTerms(orderId: number, terms: string | null) { const { error } = await this.sb.rpc('set_order_terms', { p_order: orderId, p_terms: terms }); fail(error) }
  async makeInvoice(orderId: number) { const { data, error } = await this.sb.rpc('make_invoice', { p_order: orderId }); fail(error); return data as Invoice }
  async listInvoices(scope: 'sales' | 'nursery' = 'sales') {
    let q = this.sb.from('invoices').select('*').order('invoice_date', { ascending: false }).order('id', { ascending: false }).limit(500)
    q = scope === 'nursery' ? q.not('nursery_order_id', 'is', null) : q.is('nursery_order_id', null)
    let { data, error } = await q
    // before 028 there's no nursery_order_id column: Sales sees every invoice
    if (error && /nursery_order_id/.test(error.message) && scope === 'sales') ({ data, error } = await this.sb.from('invoices').select('*').order('invoice_date', { ascending: false }).order('id', { ascending: false }).limit(500))
    if (error && /invoices/.test(error.message)) throw new Error('Invoices aren\'t set up in the database yet. Run 027_sales_docs.sql in Supabase, then refresh.')
    fail(error); return ((data ?? []) as Invoice[]).map(i => ({ ...i, total: Number(i.total) }))
  }
  async setInvoiceTerms(id: number, terms: string) { const { error } = await this.sb.rpc('set_invoice_terms', { p_inv: id, p_terms: terms }); fail(error) }
  async setInvoiceInfo(id: number, date: string | null, po: string, notes: string) { const { error } = await this.sb.rpc('set_invoice_info', { p_inv: id, p_date: date, p_po: po, p_notes: notes }); fail(error) }
  async setInvoiceLine(id: number, lineId: number | null, description: string, qty: number | null, price: number | null, uom = 'ea') {
    const { error } = await this.sb.rpc('set_invoice_line', { p_inv: id, p_line: lineId, p_description: description, p_qty: qty, p_price: price, p_uom: uom }); fail(error)
  }
  async removeInvoiceLine(id: number, lineId: number) { const { error } = await this.sb.rpc('remove_invoice_line', { p_inv: id, p_line: lineId }); fail(error) }
  async setInvoiceStatus(id: number, status: 'open' | 'paid' | 'void', note?: string) { const { error } = await this.sb.rpc('set_invoice_status', { p_inv: id, p_status: status, p_note: note ?? null }); fail(error) }
  async markInvoiceSent(id: number, to: string) { const { error } = await this.sb.rpc('mark_invoice_sent', { p_inv: id, p_to: to }); fail(error) }
  async setMyName(name: string) { const { error } = await this.sb.rpc('set_my_name', { p_name: name }); fail(error) }
  async dashRecord(p: Record<string, number>) { await this.sb.rpc('dash_record', { p }) }
  async dashSeries(keys: string[], from: string) {
    const { data, error } = await this.sb.rpc('dash_series', { p_keys: keys, p_from: from })
    if (error) return []
    return ((data ?? []) as { day: string; key: string; value: number | string }[]).map(r => ({ ...r, value: Number(r.value) }))
  }
  async adminOverview() {
    const { data, error } = await this.sb.rpc('admin_overview')
    if (error && /admin_overview/.test(error.message)) throw new Error('Run 024_module_roles.sql in Supabase first')
    fail(error); return data as Overview
  }
  async appSettings() {
    const { data, error } = await this.sb.from('app_settings').select('*'); fail(error)
    return Object.fromEntries(((data ?? []) as { key: string; value: string }[]).map(r => [r.key, r.value]))
  }
  async setAppSetting(key: string, value: string) { const { error } = await this.sb.rpc('set_app_setting', { p_key: key, p_value: value }); fail(error) }
  async setUser(email: string, role: Role, customerId: number | null, name: string) {
    const { error } = await this.sb.rpc('set_user', { p_email: email, p_role: role, p_customer: customerId, p_name: name || null })
    fail(error)
  }
  async removeUser(email: string) {
    const { error } = await this.sb.rpc('remove_user', { p_email: email })
    fail(error)
  }
  async userLogins() {
    const { data, error } = await this.sb.from('user_logins').select('*')
    if (error) return new Map()
    return new Map((data ?? []).map((r: { email: string; claimed: boolean; invited_at: string | null }) => [r.email, r]))
  }
  async makeLoginLink(email: string, kind: 'invite' | 'reset') {
    const { data, error } = await this.sb.rpc('make_login_link', { p_email: email, p_kind: kind })
    fail(error)
    return portalUrl(`?${kind}=${data as string}`)
  }
  async checkLink(code: string) {
    const { data, error } = await this.sb.rpc('check_login_link', { p_code: code })
    fail(error)
    return (data as LinkInfo | null) ?? null
  }
  async claimInvite(code: string, email: string, password: string) {
    const up = await this.sb.auth.signUp({ email, password })
    if (up.error) {
      // already has a login (e.g. tried before): sign in with the password they typed
      if (!/already|registered|exists/i.test(up.error.message)) throw new Error(up.error.message)
      const inn = await this.sb.auth.signInWithPassword({ email, password })
      if (inn.error) throw new Error('This email already has a login and that password didn\'t match. Ask Lifted for a reset link.')
    } else if (!up.data.session) {
      const inn = await this.sb.auth.signInWithPassword({ email, password })
      if (inn.error) throw new Error(inn.error.message)
    }
    const { error } = await this.sb.rpc('claim_invite', { p_code: code })
    fail(error)
  }
  async resetPassword(code: string, password: string) {
    const { data, error } = await this.sb.rpc('reset_password', { p_code: code, p_password: password })
    fail(error)
    return data as string
  }
  async passwordSignIn(email: string, password: string) {
    const { error } = await this.sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
    if (error) throw new Error(/invalid/i.test(error.message) ? 'Wrong email or password' : error.message)
  }
  async changePassword(password: string) {
    const { error } = await this.sb.auth.updateUser({ password })
    fail(error)
  }
  async listReserves() {
    return pageAll<Reserve>((a, b) => this.sb.from('reserves').select('*').order('strain').range(a, b))
  }
  async listBalances() {
    return pageAll<Balance>((a, b) => this.sb.from('reserve_balances').select('*').order('strain').range(a, b))
  }
  async salesCounts() {
    const [o, r] = await Promise.all([
      this.sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
      this.sb.from('reserve_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ])
    return { orders: o.count ?? 0, requests: r.count ?? 0 }
  }
  async openMenu() {
    const { data, error } = await this.sb.rpc('open_menu'); fail(error); return (data ?? []) as MenuRow[]
  }
  async menuNumbers() {
    const { data, error } = await this.sb.rpc('menu_numbers'); fail(error); return (data ?? []) as MenuNumbers[]
  }
  async listRequests() {
    const { data, error } = await this.sb.from('reserve_requests').select('*').order('requested_at', { ascending: false }).limit(500)
    fail(error); return (data ?? []) as ReserveRequest[]
  }
  async requestReserveBatch(year: number, lines: { strain: string; lbs: number }[], note: string) {
    const { data, error } = await this.sb.rpc('request_reserve_batch', { p_lines: lines, p_note: note || null, p_year: year })
    fail(error)
    const r = data as { ids: number[]; count: number }
    if (r.ids?.length) this.notify('reserve', r.ids[0])
    return r.count
  }
  async decideRequests(items: { id: number; approve: boolean; lbs: number | null }[], note: string) {
    const { data, error } = await this.sb.rpc('decide_reserve_requests', { p_items: items, p_note: note || null })
    fail(error)
    return data as { approved: number; declined: number }
  }
  async reserveYears(): Promise<ReserveYears> {
    const { data, error } = await this.sb.rpc('reserve_years')
    if (error) return { current: new Date().getFullYear(), years: [] }   // before 020 is run
    return data as ReserveYears
  }
  async reserveStrains() { const { data, error } = await this.sb.rpc('reserve_strains'); fail(error); return (data ?? []) as string[] }
  async setReserveDeadline(year: number, date: string | null) {
    const { error } = await this.sb.rpc('set_reserve_deadline', { p_year: year, p_date: date }); fail(error)
  }
  async listTerms() {
    const { data, error } = await this.sb.from('customer_terms').select('*').order('crop_year')
    if (error) return []
    return (data ?? []) as CustomerTerms[]
  }
  async setTerms(t: CustomerTerms, clear = false) {
    const { error } = await this.sb.rpc('set_customer_terms', { p_customer: t.customer_id, p_year: t.crop_year, p_price: t.price_per_lb,
      p_contract: t.contract_lbs, p_min: t.monthly_min_lbs, p_deposit: t.deposit_usd, p_storage: t.storage_fee, p_clear: clear })
    fail(error)
  }
  async myTermsFor(year: number) {
    const { data, error } = await this.sb.rpc('my_terms_for', { p_year: year }); if (error) return null
    return data as { price_per_lb: number | null; contract_lbs: number | null } | null
  }
  async requestReserve(strain: string, lbs: number, note: string, year?: number) {
    const { data, error } = await this.sb.rpc('request_reserve_change', { p_strain: strain, p_lbs: lbs, p_note: note || null, ...(year ? { p_year: year } : {}) })
    fail(error)
    this.notify('reserve', data as number)
  }
  // email staff (best effort; the request or order is saved either way)
  private async notify(kind: 'reserve' | 'order', id: number) {
    const { data: s } = await this.sb.auth.getSession()
    fetch('/api/notify-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session?.access_token ?? ''}` }, body: JSON.stringify({ kind, id }) }).catch(() => {})
  }
  async placeOrder(lines: OrderInput[], note: string, po: string, wanted: string | null, sample = false) {
    const { data, error } = await this.sb.rpc('place_order', { p_lines: lines, p_note: note || null, p_po: po || null, p_wanted: wanted || null, ...(sample ? { p_sample: true } : {}) })
    fail(error)
    this.notify('order', data as number)
    return data as number
  }
  async sampleHolds(customerId?: number | null, all = false) {
    const { data, error } = await this.sb.rpc('sample_holds', { p_customer: customerId ?? null, p_all: all })
    if (error) { if (/sample_holds/.test(error.message)) return []; fail(error) }
    return (data ?? []) as SampleHold[]
  }
  async setOrderSample(orderId: number, sample: boolean, holds: { line_id?: number; strain?: string; hold_lbs: number | null }[]) {
    const { error } = await this.sb.rpc('set_order_sample', { p_order: orderId, p_sample: sample, p_holds: holds })
    if (error && /set_order_sample/.test(error.message)) throw new Error('Sample orders need 061_sample_holds.sql run in Supabase.')
    fail(error)
  }
  async setSampleHold(lineId: number, release: boolean, until?: string | null) { const { error } = await this.sb.rpc('set_sample_hold', { p_line: lineId, p_release: release, p_until: until ?? null }); fail(error) }
  async mySampleHoldDays() { const { data, error } = await this.sb.rpc('my_sample_hold_days'); if (error) return null; return data as number | null }
  async cancelMyOrder(id: number) { const { error } = await this.sb.rpc('cancel_my_order', { p_id: id }); fail(error) }
  async setOrderStatus(id: number, status: string, so: string, note: string, date?: string | null) {
    const { error } = await this.sb.rpc('set_order_status', { p_id: id, p_status: status, p_so: so || null, p_note: note || null, ...(date ? { p_date: date } : {}) }); fail(error)
  }
  async setSpan(palletId: number, toSlot: number | null) {
    const { error } = await this.sb.rpc('set_pallet_span', { p_pallet: palletId, p_to_slot: toSlot })
    if (error && /set_pallet_span/.test(error.message)) throw new Error('Run 057_harvest_push.sql in Supabase first')
    fail(error)
  }
  async setOrderLine(orderId: number, lineId: number | null, strain: string, lbs: number, price: number | null) {
    const { error } = await this.sb.rpc('set_order_line', { p_order: orderId, p_line: lineId, p_strain: strain, p_lbs: lbs, p_price: price }); fail(error)
  }
  async myTerms() { const { data, error } = await this.sb.rpc('my_terms'); if (error) return null; return data as Terms | null }
  async statement(customerId?: number | null) {
    const { data, error } = await this.sb.rpc('customer_statement', customerId ? { p_customer: customerId } : {})
    if (error) throw new Error(/customer_statement/.test(error.message) ? 'Statements need 060_feedback_1024.sql run in Supabase.' : error.message)
    return data as Statement | null
  }
  async startViewAs(email: string) { const { error } = await this.sb.rpc('start_view_as', { p_email: email }); fail(error) }
  async stopViewAs() { const { error } = await this.sb.rpc('stop_view_as'); fail(error) }
  async cancelRequest(id: number) {
    const { error } = await this.sb.rpc('cancel_reserve_request', { p_id: id }); fail(error)
  }
  async decideRequest(id: number, approve: boolean, note: string) {
    const { error } = await this.sb.rpc('decide_reserve_request', { p_id: id, p_approve: approve, p_note: note || null }); fail(error)
  }
  async listOrders() {
    return pageAll<Order>((a, b) => this.sb.from('orders').select('*, order_lines(*)').order('order_date', { ascending: false }).order('id', { ascending: false }).range(a, b))
  }
  async importRoshi(rows: RoshiRow[]) {
    const { data, error } = await this.sb.rpc('import_roshi_orders', { p_rows: rows })
    fail(error)
    return data as ImportResult
  }
  async setReserve(customerId: number, strain: string, lbs: number, note?: string, year?: number) {
    const { error } = await this.sb.rpc('set_reserve', { p_customer: customerId, p_strain: strain, p_lbs: lbs, p_note: note || null, ...(year ? { p_year: year } : {}) })
    fail(error)
  }
  // Crew only gets customer names (no contacts or licenses)
  private customers() {
    if (this.role === 'admin' || this.role === 'sales')
      return pageAll<Customer>((a, b) => this.sb.from('customers').select('*').order('name').range(a, b))
    return pageAll<Pick<Customer, 'id' | 'name' | 'kind' | 'active'>>((a, b) => this.sb.from('customer_names').select('*').order('name').range(a, b))
      .then(rows => rows.map(r => ({ ...r, license: null, address: null, contact: null, notes: null }) as Customer))
  }
  async load(): Promise<Snapshot> {
    const since = new Date(Date.now() - 14 * 864e5).toISOString()
    const loadsQ = this.sb.from('loads').select('*').or(`status.in.(planning,loading,in_transit),closed_at.gte.${since}`).order('load_date', { ascending: false }).limit(300)
    const [freezers, slots, pallets, strains, vehicles, customers, loadsRes] = await Promise.all([
      pageAll<Freezer>((a, b) => this.sb.from('freezers').select('*').order('id').range(a, b)),
      pageAll<Slot>((a, b) => this.sb.from('slots').select('*').order('id').range(a, b)),
      pageAll<Pallet>((a, b) =>
        this.sb.from('pallets').select('*').in('status', ['in_freezer', 'unslotted', 'in_transit']).order('id').range(a, b)),
      // later tables arrive with migrations; tolerate them missing
      pageAll<Strain>((a, b) => this.sb.from('strains').select('*').order('name').range(a, b)).catch(() => [] as Strain[]),
      pageAll<Vehicle>((a, b) => this.sb.from('vehicles').select('*').order('name').range(a, b)).catch(() => [] as Vehicle[]),
      this.customers().catch(() => [] as Customer[]),
      loadsQ.then(r => r, () => ({ data: null, error: null })),
    ])
    const loads = ((loadsRes as { data: Load[] | null }).data ?? []) as Load[]
    let stops: LoadStop[] = [], items: LoadItem[] = []
    if (loads.length) {
      const ids = loads.map(l => l.id)
      const [st, it] = await Promise.all([
        this.sb.from('load_stops').select('*').in('load_id', ids).order('seq'),
        this.sb.from('load_items').select('*').in('load_id', ids).order('position'),
      ])
      stops = (st.data ?? []) as LoadStop[]; items = (it.data ?? []) as LoadItem[]
    }
    // pallets on these loads that have already left inventory (shipped) still need names on the truck view
    const missing = items.map(i => i.pallet_id).filter(id => !pallets.some(p => p.id === id))
    if (missing.length) {
      const { data } = await this.sb.from('pallets').select('*').in('id', missing.slice(0, 500))
      pallets.push(...((data ?? []) as Pallet[]))
    }
    const shipped = await this.sb.rpc('shipped_in_freezer').then(r => (r.error ? [] : r.data) as ShippedCheck[], () => [] as ShippedCheck[])
    const unmatched = await this.sb.rpc('unmatched_shipped_tags').then(r => (r.error ? [] : r.data) as UnmatchedTag[], () => [] as UnmatchedTag[])
    const inRun: Record<number, string> = {}
    try {
      const { data: runs } = await this.sb.from('proc_runs').select('id,code').eq('status', 'open')
      const code = new Map(((runs ?? []) as { id: number; code: string }[]).map(r => [r.id, r.code]))
      if (code.size) {
        const { data: ins } = await this.sb.from('proc_run_inputs').select('run_id,pallet_id').in('run_id', [...code.keys()])
        for (const i of (ins ?? []) as { run_id: number; pallet_id: number }[]) inRun[i.pallet_id] = code.get(i.run_id)!
      }
    } catch { /* no Processing yet */ }
    // items (SKUs) and harvest lots, only the ones these pallets use (054; tolerate it missing)
    const ids = (k: 'item_id' | 'lot_id') => [...new Set(pallets.map(p => p[k]).filter((x): x is number => x != null))]
    const byIds = async <T,>(table: string, list: number[]) => {
      const out: T[] = []
      for (let i = 0; i < list.length; i += 300) {
        const { data, error } = await this.sb.from(table).select('*').in('id', list.slice(i, i + 300))
        if (error) return [] as T[]
        out.push(...((data ?? []) as T[]))
      }
      return out
    }
    const [skus, lots] = await Promise.all([byIds<Item>('items', ids('item_id')), byIds<HarvestLot>('harvest_lots', ids('lot_id'))]).catch(() => [[], []] as [Item[], HarvestLot[]])
    const { data: drv } = await this.sb.from('fleet_drivers').select('id, name, carrier_id, active, fleet_driver_assets(asset_id)').order('name')
    const drivers = ((drv ?? []) as { id: number; name: string; carrier_id: number | null; active: boolean; fleet_driver_assets: { asset_id: number }[] }[])
      .map(x => ({ id: x.id, name: x.name, carrier_id: x.carrier_id, active: x.active, asset_ids: (x.fleet_driver_assets ?? []).map(y => y.asset_id) }))
    return { freezers, slots, pallets, strains, vehicles, drivers, customers, loads, stops, items, shipped, unmatched, inRun, skus, lots }
  }
  async movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string) {
    const { error } = await this.sb.rpc('move_pallet', {
      p_pallet_id: palletId, p_to_slot: toSlot, p_combine: combine, p_note: note || null,
    })
    fail(error)
  }
  async setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string) {
    const { error } = await this.sb.rpc('set_freezer_status', {
      p_freezer_id: freezerId, p_status: status, p_note: note || null,
    })
    fail(error)
  }
  async clearReview(palletId: number, note?: string) {
    const { error } = await this.sb.rpc('clear_review', { p_pallet_id: palletId, p_note: note || null })
    fail(error)
  }
  async splitPallet(palletId: number, lbs: number, tag: string | null, tagPending: boolean, destSlot: number | null, note?: string) {
    const { data, error } = await this.sb.rpc('split_pallet', {
      p_pallet_id: palletId, p_lbs: lbs, p_new_tag: tag, p_tag_pending: tagPending, p_dest_slot: destSlot, p_note: note || null,
    })
    fail(error)
    return data as Pallet
  }
  private async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.sb.rpc(fn, args)
    fail(error)
    return data
  }
  async createLoad(vehicleId: number, date: string, stops: StopInput[], driver: string, notes: string) {
    return await this.rpc('create_load', { p_vehicle: vehicleId, p_date: date, p_stops: stops, p_driver: driver, p_notes: notes }) as Load
  }
  async updateLoad(loadId: number, vehicleId: number, date: string, driver: string, notes: string) {
    await this.rpc('update_load', { p_load: loadId, p_vehicle: vehicleId, p_date: date, p_driver: driver, p_notes: notes })
  }
  async setStops(loadId: number, stops: StopInput[]) { await this.rpc('set_stops', { p_load: loadId, p_stops: stops }) }
  async planPallet(loadId: number, stopId: number, palletId: number, position: number | null, share: boolean) {
    await this.rpc('plan_pallet', { p_load: loadId, p_stop: stopId, p_pallet: palletId, p_position: position, p_share: share })
  }
  async moveItem(itemId: number, position: number | null, stopId: number | null, share: boolean) {
    await this.rpc('move_item', { p_item: itemId, p_position: position, p_stop: stopId, p_share: share })
  }
  async arrangeLoad(loadId: number) { await this.rpc('arrange_load', { p_load: loadId }) }
  async removeItem(itemId: number) { await this.rpc('remove_item', { p_item: itemId }) }
  async loadPallet(itemId: number) { await this.rpc('load_pallet', { p_item: itemId }) }
  async unloadPallet(itemId: number, slotId: number) { await this.rpc('unload_pallet', { p_item: itemId, p_slot: slotId, p_share: true }) }
  async departLoad(loadId: number) { await this.rpc('depart_load', { p_load: loadId }) }
  async deliverStop(stopId: number) { await this.rpc('deliver_stop', { p_stop: stopId }) }
  async cancelLoad(loadId: number) { await this.rpc('cancel_load', { p_load: loadId }) }
  async createMixed(slotId: number, lines: MixLine[], note?: string) {
    const { data, error } = await this.sb.rpc('create_mixed_pallet', { p_slot: slotId, p_lines: lines, p_note: note || null })
    fail(error)
    return data as Pallet
  }
  async addToMixed(mixedId: number, lines: MixLine[], note?: string) {
    const { error } = await this.sb.rpc('add_to_mixed', { p_mixed_id: mixedId, p_lines: lines, p_note: note || null })
    fail(error)
  }
  async takeOffMixed(palletId: number, slotId: number, note?: string) {
    const { error } = await this.sb.rpc('take_off_mixed', { p_pallet_id: palletId, p_slot: slotId, p_share: true, p_note: note || null })
    fail(error)
  }
  async breakMixed(mixedId: number, note?: string) {
    const { error } = await this.sb.rpc('break_mixed', { p_mixed_id: mixedId, p_note: note || null })
    fail(error)
  }
  async createSingle(slotId: number, i: SingleInput) {
    const { data, error } = await this.sb.rpc('create_single_pallet', {
      p_slot: slotId, p_code: i.code, p_strain: i.strain, p_lbs: i.lbs, p_tag: i.tag, p_tag_pending: i.tag_pending,
      p_harvest_date: i.harvest_date, p_note: i.note || null, p_share: false,
    })
    fail(error)
    return data as Pallet
  }
  async mergePallets(ids: number[], tag: string | null, tagPending: boolean, destSlot: number | null, note?: string) {
    const { data, error } = await this.sb.rpc('merge_pallets', {
      p_ids: ids, p_new_tag: tag, p_tag_pending: tagPending, p_dest: destSlot, p_note: note || null,
    })
    fail(error)
    return data as Pallet
  }
  async setTag(palletId: number, tag: string, note?: string) {
    const { error } = await this.sb.rpc('set_tag', { p_pallet_id: palletId, p_tag: tag, p_note: note || null })
    fail(error)
  }
  async applyMoves(moves: { pallet_id: number; from_slot: number | null; to_slot: number; kind: string }[], note?: string) {
    const { data, error } = await this.sb.rpc('apply_moves', { p_moves: moves, p_note: note || null }); fail(error); return data as string
  }
  async undoBatch(batch: string) { const { data, error } = await this.sb.rpc('undo_batch', { p_batch: batch }); fail(error); return data as number }
  async removePallet(id: number, reason: string, note: string) { const { error } = await this.sb.rpc('remove_pallet', { p_pallet_id: id, p_reason: reason, p_note: note || null }); fail(error) }
  async markShipped(palletId: number, note?: string) { const { error } = await this.sb.rpc('mark_pallet_shipped', { p_pallet_id: palletId, p_note: note || null }); fail(error) }
  async nextTags(site: string, purpose: string, n: number) { const { data, error } = await this.sb.rpc('next_tags', { p_site: site, p_purpose: purpose, p_count: n }); return error ? [] : (data as string[]) }
  async dismissTag(tag: string) { const { error } = await this.sb.rpc('dismiss_unmatched_tag', { p_tag: tag }); fail(error) }
  async ackShipped(tag: string) { const { error } = await this.sb.rpc('ack_shipped_tag', { p_tag: tag }); fail(error) }
  async adjustWeight(palletId: number, weight: number, note?: string, reason?: string) {
    const base = { p_pallet_id: palletId, p_weight: weight, p_note: note || null }
    let { error } = await this.sb.rpc('adjust_weight', reason ? { ...base, p_reason: reason } : base)
    // 059 not run yet: save without the METRC reason, keep it in the note
    if (error && reason && /p_reason|function .*adjust_weight|schema cache/i.test(error.message)) ({ error } = await this.sb.rpc('adjust_weight', { ...base, p_note: [reason, note].filter(Boolean).join(': ') }))
    fail(error)
  }
  async lineage(p: Pallet) {
    const ors = [`parent_id.eq.${p.id}`, `merged_into.eq.${p.id}`]
    if (p.parent_id) ors.push(`id.eq.${p.parent_id}`)
    if (p.merged_into) ors.push(`id.eq.${p.merged_into}`)
    const { data, error } = await this.sb.from('pallets').select('*').or(ors.join(',')).limit(200)
    fail(error)
    return (data ?? []) as Pallet[]
  }
  async loadSettings(): Promise<Settings> {
    const [vehicles, customers, strains] = await Promise.all((['vehicles', 'customers', 'strains'] as const).map(t =>
      t === 'customers' ? this.customers() as Promise<ListRow[]> : pageAll<ListRow>((a, b) => this.sb.from(t).select('*').order('name').range(a, b))))
    return { vehicles, customers, strains } as Settings
  }
  async saveRow(list: ListName, row: Partial<ListRow>) {
    const { id, ...rest } = row as ListRow
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'updated_at'))
    const { error } = id ? await this.sb.from(list).update(clean).eq('id', id) : await this.sb.from(list).insert(clean)
    if (error) throw new Error(error.code === '23505' ? `"${(row as ListRow).name}" is already in the list` : error.message)
  }
  async byIds(ids: number[]) {
    const { data, error } = await this.sb.from('pallets').select('*').in('id', ids.slice(0, 300))
    fail(error)
    return (data ?? []) as Pallet[]
  }
  async palletEvents(palletId: number) {
    const { data, error } = await this.sb.from('events').select('*').eq('pallet_id', palletId).order('at', { ascending: false })
    fail(error)
    return (data ?? []) as InvEvent[]
  }
  async recentEvents(limit: number) {
    const { data, error } = await this.sb.from('events').select('*').neq('type', 'import')
      .order('at', { ascending: false }).limit(limit)
    fail(error)
    return (data ?? []) as InvEvent[]
  }
  async search(q: string) {
    const s = q.replace(/[%,()]/g, '').trim()
    const { data, error } = await this.sb.from('pallets').select('*')
      .or(`code.ilike.%${s}%,strain.ilike.%${s}%,package_tag.ilike.%${s}%,label.ilike.%${s}%`)
      .limit(200)
    fail(error)
    return (data ?? []) as Pallet[]
  }
  client() { return this.sb }
  subscribe(onChange: () => void) {
    let t: number | undefined
    const bump = () => { clearTimeout(t); t = window.setTimeout(onChange, 400) }
    const ch = this.sb.channel('inv')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pallets' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'freezers' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'loads' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'load_items' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'load_stops' }, bump)
      .subscribe()
    return () => { this.sb.removeChannel(ch) }
  }
}

// ---------------- Demo (in-browser, nothing saved) ----------------

class DemoBackend implements Backend {
  demo = true
  private snap: Snapshot | null = null
  private events: InvEvent[] = []
  private nextEvent = 1
  private user = 'demo@lifted-organics.com'

  async getUser() { return this.user }
  async signIn() {}
  async sendCode() {}
  async verifyCode() {}
  async signOut() {}
  private users: AppUser[] = [{ email: 'demo@lifted-organics.com', role: 'admin', customer_id: null, display_name: 'Demo', added_by: 'setup', created_at: new Date().toISOString(), last_seen: new Date().toISOString() }]
  async me(): Promise<Me> { return { email: this.user, role: 'admin', display_name: 'Demo', customer_id: null, customer_name: null, access: { ...accessFromRole('admin'), owner: true } } }
  async listUsers() { return [...this.users] }
  async setUser(email: string, role: Role, customerId: number | null, name: string) {
    const e = email.trim().toLowerCase(), u = this.users.find(x => x.email === e)
    if (u) Object.assign(u, { role, customer_id: role === 'customer' ? customerId : null, display_name: name || u.display_name })
    else this.users.push({ email: e, role, customer_id: role === 'customer' ? customerId : null, display_name: name || null, added_by: this.user, created_at: new Date().toISOString(), last_seen: null })
  }
  async removeUser(email: string) { this.users = this.users.filter(u => u.email !== email) }
  async userLogins() { return new Map() }
  async makeLoginLink(_e: string, kind: 'invite' | 'reset') { return portalUrl(`?${kind}=demo`) }
  async checkLink() { return null }
  async claimInvite() { throw new Error('Not in demo') }
  async resetPassword(): Promise<string> { throw new Error('Not in demo') }
  async passwordSignIn() { throw new Error('Not in demo') }
  async changePassword() {}
  async listBalances() { return this.reserves.map(r => ({ id: r.id, customer_id: r.customer_id, strain: r.strain, reserved: r.lbs, shipped: 0, pending: 0, remaining: r.lbs })) }
  async listOrders() { return [] }
  async salesCounts() { return { orders: 0, requests: 0 } }
  async placeOrder(): Promise<number> { throw new Error('Not in demo') }
  async sampleHolds() { return [] as SampleHold[] }
  async setOrderSample() { throw new Error('Not in demo') }
  async setSampleHold() { throw new Error('Not in demo') }
  async mySampleHoldDays() { return null }
  async cancelMyOrder() {}
  async setOrderStatus() {}
  async setSpan() { throw new Error('Not in demo') }
  async setOrderLine() {}
  async myTerms() { return null }
  async statement() { return null }
  async startViewAs() { throw new Error('Not in demo') }
  async stopViewAs() {}
  async openMenu() { return [] }
  async menuNumbers() { return [] }
  async listRequests() { return [] }
  async requestReserve() { throw new Error('Not in demo') }
  async cancelRequest() {}
  async decideRequest() {}
  async importRoshi(): Promise<ImportResult> { throw new Error('Not in demo') }
  private reserves: Reserve[] = []
  async listReserves() { return [...this.reserves] }
  async setReserve(customerId: number, strain: string, lbs: number) {
    const r = this.reserves.find(x => x.customer_id === customerId && x.strain.toLowerCase() === strain.toLowerCase())
    if (lbs === 0) this.reserves = this.reserves.filter(x => x !== r)
    else if (r) r.lbs = lbs
    else this.reserves.push({ id: this.reserves.length + 1, customer_id: customerId, strain, product: 'fresh_frozen', lbs, notes: null, updated_by: this.user, updated_at: new Date().toISOString() })
  }
  async load() {
    if (!this.snap) {
      const r = await fetch('/demo-data.json')
      this.snap = await r.json() as Snapshot
      for (const p of this.snap.pallets) {
        if (p.status === 'in_freezer') this.log({ type: 'import', pallet_id: p.id, to_slot_id: p.slot_id, lbs: p.current_weight, note: 'Imported from Freezer Map 26.xlsm' }, 'import', '2026-10-20T08:00:00Z')
      }
    }
    const snap = { ...this.snap, strains: (await this.loadSettings()).strains }
    return structuredClone({ ...snap, pallets: snap.pallets.filter(p => p.status === 'in_freezer' || p.status === 'unslotted') })
  }
  private log(e: Partial<InvEvent>, who = this.user, at = new Date().toISOString()) {
    this.events.unshift({
      id: this.nextEvent++, at, user_email: who, type: 'move', pallet_id: null, freezer_id: null,
      from_slot_id: null, to_slot_id: null, lbs: null, note: null, details: null, ...e,
    })
  }
  async movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string) {
    const s = this.snap!
    const p = s.pallets.find(x => x.id === palletId)
    if (!p) throw new Error('Pallet not found')
    this.loose(p)
    if (p.slot_id === toSlot) throw new Error(`Pallet ${p.code} is already there`)
    if (toSlot != null) {
      const slot = s.slots.find(x => x.id === toSlot)!
      const f = s.freezers.find(x => x.id === slot.freezer_id)!
      if (f.status === 'Not Working') throw new Error(`Freezer ${f.number} is marked Not Working`)
      if (!combine && s.pallets.some(x => x.slot_id === toSlot && x.id !== p.id && !x.container_id))
        throw new Error('That slot is occupied. Choose combine to share it.')
    }
    this.log({ type: toSlot == null ? 'unslot' : 'move', pallet_id: p.id, from_slot_id: p.slot_id, to_slot_id: toSlot, lbs: p.current_weight, note: note || null })
    p.slot_id = toSlot
    p.status = toSlot == null ? 'unslotted' : 'in_freezer'
    if (p.kind === 'mixed') for (const c of s.pallets) if (c.container_id === p.id) c.slot_id = toSlot
  }
  async setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string) {
    const f = this.snap!.freezers.find(x => x.id === freezerId)!
    this.log({ type: 'freezer_status', freezer_id: f.id, note: note || null, details: { from: f.status, to: status } })
    f.status = status
  }
  async clearReview(palletId: number, note?: string) {
    const p = this.snap!.pallets.find(x => x.id === palletId)!
    this.log({ type: 'review_cleared', pallet_id: p.id, note: note || null, details: { reason: p.needs_review } })
    p.needs_review = null
  }
  private nextId() { return Math.max(...this.snap!.pallets.map(p => p.id)) + 1 }
  private tagUsed(tag: string, except?: number) {
    return this.snap!.pallets.find(p => p.package_tag === tag && p.id !== except && (p.status === 'in_freezer' || p.status === 'unslotted'))?.code
  }
  async splitPallet(palletId: number, lbs: number, tag: string | null, tagPending: boolean, destSlot: number | null, note?: string) {
    const s = this.snap!, p = s.pallets.find(x => x.id === palletId)!
    this.loose(p)
    tag = tag?.trim() || null
    if (p.current_weight == null) throw new Error(`Pallet ${p.code} has no weight. Adjust its weight first.`)
    if (!(lbs > 0)) throw new Error('Enter how many lbs to split off')
    if (lbs >= p.current_weight) throw new Error(`Split must be less than the pallet weight (${p.current_weight} lbs)`)
    if (!tag && !tagPending) throw new Error('Enter the new METRC tag, or mark it pending')
    if (tag && this.tagUsed(tag)) throw new Error(`Tag ${tag} is already on pallet ${this.tagUsed(tag)}`)
    const n = 1 + Math.max(0, ...s.pallets.map(x => x.code.startsWith(p.code + '-') && /^\d+$/.test(x.code.slice(p.code.length + 1)) ? +x.code.slice(p.code.length + 1) : 0))
    const slot = destSlot ?? p.slot_id
    const child: Pallet = { ...p, id: this.nextId(), code: `${p.code}-${n}`, label: null, og_weight: lbs, current_weight: lbs,
      package_tag: tag, parent_id: p.id, merged_into: null, slot_id: slot, status: slot == null ? 'unslotted' : 'in_freezer',
      tag_pending: !tag, needs_review: null, notes: null }
    s.pallets.push(child)
    p.current_weight = Math.round((p.current_weight - lbs) * 100) / 100
    this.log({ type: 'split', pallet_id: p.id, from_slot_id: p.slot_id, lbs, note: note || null, details: { child: child.code, child_id: child.id, remaining: p.current_weight } })
    this.log({ type: 'split_from', pallet_id: child.id, to_slot_id: slot, lbs, note: note || null, details: { parent: p.code, parent_id: p.id, tag } })
    return structuredClone(child)
  }
  async mergePallets(ids: number[], tag: string | null, tagPending: boolean, destSlot: number | null, note?: string) {
    const s = this.snap!, src = s.pallets.filter(x => ids.includes(x.id))
    tag = tag?.trim() || null
    if (src.length < 2) throw new Error('Pick at least two pallets to merge')
    if (new Set(src.map(x => x.strain?.toLowerCase())).size > 1) throw new Error('Only the same strain can be merged. Use share slot for different strains.')
    if (!tag && !tagPending) throw new Error('Enter the new METRC tag, or mark it pending')
    const total = src.reduce((a, x) => a + (x.current_weight ?? 0), 0)
    const cn = 1 + Math.max(0, ...s.pallets.map(x => /^C\d+$/.test(x.code) ? +x.code.slice(1) : 0))
    const zones = new Set(src.map(x => x.zone))
    const m: Pallet = { ...src[0], id: this.nextId(), code: `C${cn}`, label: null, og_weight: total, current_weight: total, package_tag: tag,
      parent_id: null, merged_into: null, slot_id: destSlot, status: destSlot == null ? 'unslotted' : 'in_freezer', tag_pending: !tag,
      zone: zones.size === 1 ? src[0].zone : 'Mixed', needs_review: null, notes: null }
    s.pallets.push(m)
    this.log({ type: 'merge', pallet_id: m.id, to_slot_id: destSlot, lbs: total, note: note || null, details: { sources: src.map(x => x.code), tag } })
    for (const x of src) {
      this.log({ type: 'merged_into', pallet_id: x.id, from_slot_id: x.slot_id, lbs: x.current_weight, note: note || null, details: { into: m.code, into_id: m.id } })
      x.status = 'merged'; x.slot_id = null; x.merged_into = m.id
    }
    return structuredClone(m)
  }
  private loose(p: Pallet) {
    if (p.container_id) throw new Error(`${p.code} is on mixed pallet ${this.snap!.pallets.find(x => x.id === p.container_id)?.code}. Take it off first.`)
  }
  private slotOk(slotId: number, share: boolean, ignore: number[] = []) {
    const s = this.snap!
    const slot = s.slots.find(x => x.id === slotId)
    if (!slot) throw new Error('Slot not found')
    const f = s.freezers.find(x => x.id === slot.freezer_id)!
    if (f.status === 'Not Working') throw new Error(`Freezer ${f.number} is marked Not Working`)
    if (!share && s.pallets.some(x => x.slot_id === slotId && !x.container_id && !ignore.includes(x.id))) throw new Error('That slot is occupied. Choose share slot or pick an empty one.')
  }
  private mixLine(m: Pallet, l: MixLine, note?: string) {
    const s = this.snap!, p = s.pallets.find(x => x.id === l.pallet_id)!
    this.loose(p)
    if (l.lbs == null || l.lbs >= (p.current_weight ?? 0)) {
      this.log({ type: 'mixed_on', pallet_id: p.id, from_slot_id: p.slot_id, to_slot_id: m.slot_id, lbs: p.current_weight, note: note || null, details: { mixed: m.code, whole: true } })
      p.container_id = m.id; p.slot_id = m.slot_id; p.status = 'in_freezer'
      return p.code
    }
    const tag = l.tag?.trim() || null
    if (!tag && !l.tag_pending) throw new Error(`Enter the new METRC tag for the ${l.lbs} lbs from ${p.code}, or mark it pending`)
    if (tag && this.tagUsed(tag)) throw new Error(`Tag ${tag} is already on pallet ${this.tagUsed(tag)}`)
    const n = 1 + Math.max(0, ...s.pallets.map(x => x.code.startsWith(p.code + '-') && /^\d+$/.test(x.code.slice(p.code.length + 1)) ? +x.code.slice(p.code.length + 1) : 0))
    const child: Pallet = { ...p, id: this.nextId(), code: `${p.code}-${n}`, label: null, og_weight: l.lbs, current_weight: l.lbs, package_tag: tag,
      parent_id: p.id, merged_into: null, slot_id: m.slot_id, status: 'in_freezer', tag_pending: !tag, needs_review: null, notes: null, container_id: m.id }
    s.pallets.push(child)
    p.current_weight = Math.round(((p.current_weight ?? 0) - l.lbs) * 100) / 100
    this.log({ type: 'split', pallet_id: p.id, from_slot_id: p.slot_id, lbs: l.lbs, note: note || null, details: { child: child.code, remaining: p.current_weight, mixed: m.code } })
    this.log({ type: 'split_from', pallet_id: child.id, to_slot_id: m.slot_id, lbs: l.lbs, note: note || null, details: { parent: p.code, tag, mixed: m.code } })
    return child.code
  }
  async createMixed(slotId: number, lines: MixLine[], note?: string) {
    const s = this.snap!
    if (!lines.length) throw new Error('Add at least one package')
    this.slotOk(slotId, false)
    const n = 1 + Math.max(0, ...s.pallets.map(x => /^M\d+$/.test(x.code) ? +x.code.slice(1) : 0))
    const m: Pallet = { id: this.nextId(), code: `M${n}`, kind: 'mixed', label: 'Mixed pallet', strain: null, zone: null, harvest_date: null, planting_date: null,
      og_weight: null, current_weight: null, package_tag: null, status: 'in_freezer', slot_id: slotId, needs_review: null, notes: null }
    s.pallets.push(m)
    const codes = lines.map(l => this.mixLine(m, l, note))
    this.log({ type: 'mixed_created', pallet_id: m.id, to_slot_id: slotId, note: note || null, details: { packages: codes } })
    return structuredClone(m)
  }
  async addToMixed(mixedId: number, lines: MixLine[], note?: string) {
    const m = this.snap!.pallets.find(x => x.id === mixedId)!
    const codes = lines.map(l => this.mixLine(m, l, note))
    this.log({ type: 'mixed_added', pallet_id: m.id, note: note || null, details: { packages: codes } })
  }
  async takeOffMixed(palletId: number, slotId: number, note?: string) {
    const s = this.snap!, p = s.pallets.find(x => x.id === palletId)!, m = s.pallets.find(x => x.id === p.container_id)!
    this.slotOk(slotId, true)
    this.log({ type: 'mixed_off', pallet_id: p.id, from_slot_id: m.slot_id, to_slot_id: slotId, lbs: p.current_weight, note: note || null, details: { mixed: m.code } })
    p.container_id = null; p.slot_id = slotId
  }
  async breakMixed(mixedId: number, note?: string) {
    const s = this.snap!, m = s.pallets.find(x => x.id === mixedId)!
    const on = s.pallets.filter(x => x.container_id === m.id)
    for (const p of on) { this.log({ type: 'mixed_off', pallet_id: p.id, from_slot_id: m.slot_id, lbs: p.current_weight, note: note || null, details: { mixed: m.code, broken: true } }); p.container_id = null }
    this.log({ type: 'mixed_broken', pallet_id: m.id, from_slot_id: m.slot_id, note: note || null, details: { packages: on.map(x => x.code) } })
    m.status = 'depleted'; m.slot_id = null
  }
  async createSingle(slotId: number, i: SingleInput) {
    const s = this.snap!
    this.slotOk(slotId, false)
    const tag = i.tag?.trim() || null
    if (!i.strain.trim()) throw new Error('Pick a strain')
    if (!(i.lbs > 0)) throw new Error('Enter the weight')
    if (!tag && !i.tag_pending) throw new Error('Enter the METRC tag, or mark it pending')
    let code = i.code.trim().toUpperCase()
    if (!code) code = `S${1 + Math.max(0, ...s.pallets.map(x => /^S\d+$/.test(x.code) ? +x.code.slice(1) : 0))}`
    if (s.pallets.some(x => x.code === code)) throw new Error(`Pallet ${code} already exists. Search for it instead.`)
    const p: Pallet = { id: this.nextId(), code, kind: 'package', label: null, strain: i.strain.trim(), zone: null, harvest_date: i.harvest_date, planting_date: null,
      og_weight: i.lbs, current_weight: i.lbs, package_tag: tag, tag_pending: !tag, status: 'in_freezer', slot_id: slotId, needs_review: null, notes: i.note || null }
    s.pallets.push(p)
    this.log({ type: 'created', pallet_id: p.id, to_slot_id: slotId, lbs: i.lbs, note: i.note || null, details: { tag } })
    return structuredClone(p)
  }
  private noLoads(): never { throw new Error('Loads only work with the live database') }
  async createLoad(): Promise<Load> { this.noLoads() }
  async updateLoad() { this.noLoads() }
  async setStops() { this.noLoads() }
  async planPallet() { this.noLoads() }
  async moveItem() { this.noLoads() }
  async arrangeLoad() { this.noLoads() }
  async removeItem() { this.noLoads() }
  async loadPallet() { this.noLoads() }
  async unloadPallet() { this.noLoads() }
  async departLoad() { this.noLoads() }
  async deliverStop() { this.noLoads() }
  async cancelLoad() { this.noLoads() }
  async setTag(palletId: number, tag: string, note?: string) {
    const p = this.snap!.pallets.find(x => x.id === palletId)!
    tag = tag.trim()
    if (!tag) throw new Error('Enter a tag')
    if (this.tagUsed(tag, p.id)) throw new Error(`Tag ${tag} is already on pallet ${this.tagUsed(tag, p.id)}`)
    this.log({ type: 'tag_set', pallet_id: p.id, note: note || null, details: { from: p.package_tag, to: tag } })
    p.package_tag = tag; p.tag_pending = false
  }
  async applyMoves(moves: { pallet_id: number; from_slot: number | null; to_slot: number; kind: string }[]) {
    for (const m of moves) await this.movePallet(m.pallet_id, m.to_slot, true)
    return 'demo'
  }
  async undoBatch(): Promise<number> { throw new Error('Not in demo') }
  async removePallet(): Promise<void> { throw new Error('Not in demo') }
  async markShipped() {}
  async ackShipped() {}
  async dismissTag() {}
  async nextTags() { return [] as string[] }
  async adjustWeight(palletId: number, weight: number, note?: string, reason?: string) {
    const p = this.snap!.pallets.find(x => x.id === palletId)!
    if (!(weight >= 0)) throw new Error('Enter a weight of 0 or more')
    this.log({ type: 'weight_adjust', pallet_id: p.id, lbs: weight, note: note || null, details: { from: p.current_weight, to: weight, reason } })
    p.current_weight = weight
  }
  async lineage(p: Pallet) {
    return structuredClone(this.snap!.pallets.filter(x => x.parent_id === p.id || x.merged_into === p.id || x.id === p.parent_id || x.id === p.merged_into))
  }
  private settings: Settings | null = null
  async loadSettings() {
    if (!this.settings) {
      const names = new Map<string, string>()
      for (const p of this.snap?.pallets ?? []) if (p.strain && !names.has(p.strain.toLowerCase())) names.set(p.strain.toLowerCase(), p.strain)
      this.settings = {
        vehicles: [{ id: 1, name: "20' Freezer Truck", plate: null, kind: 'Freezer truck', notes: null, active: true, spaces: 8, across: 2, owner: 'Lifted' }],
        customers: [{ id: 1, name: 'OHR', kind: 'internal', license: null, address: null, contact: null, notes: 'Lifted site', active: true },
                    { id: 2, name: 'GVR', kind: 'internal', license: null, address: null, contact: null, notes: 'Lifted site', active: true }],
        strains: [...names.values()].sort().map((name, i) => ({ id: i + 1, name, aliases: [], color: null, notes: null, active: true })),
      }
    }
    return structuredClone(this.settings)
  }
  async saveRow(list: ListName, row: Partial<ListRow>) {
    await this.loadSettings()
    const rows = this.settings![list] as ListRow[]
    const name = (row.name ?? '').trim()
    if (!row.id && !name) throw new Error('Name is required')
    if (name && rows.some(r => r.name.toLowerCase() === name.toLowerCase() && r.id !== row.id)) throw new Error(`"${name}" is already in the list`)
    const ex = rows.find(r => r.id === row.id)
    if (ex) Object.assign(ex, row)
    else rows.push({ active: true, ...(list === 'strains' ? { aliases: [], color: null } : {}), ...row, id: Math.max(0, ...rows.map(r => r.id)) + 1 } as ListRow)
    this.log({ type: 'settings', note: ex ? 'updated' : 'added', details: { list, name: name || ex?.name, active: (ex ?? row).active } })
  }
  async byIds(ids: number[]) { return structuredClone(this.snap!.pallets.filter(p => ids.includes(p.id))) }
  async palletEvents(palletId: number) { return this.events.filter(e => e.pallet_id === palletId) }
  async recentEvents(limit: number) { return this.events.filter(e => e.type !== 'import').slice(0, limit) }
  async search(q: string) {
    const s = q.toLowerCase()
    return this.snap!.pallets.filter(p =>
      [p.code, p.strain, p.package_tag, p.label].some(v => v?.toLowerCase().includes(s))).slice(0, 200)
  }
  subscribe() { return () => {} }
  async reserveYears() { return { current: new Date().getFullYear(), years: [{ year: new Date().getFullYear(), deadline: null, open: true }] } }
  async reserveStrains() { return [] as string[] }
  async requestReserveBatch() { return 0 }
  async decideRequests() { return { approved: 0, declined: 0 } }
  async setReserveDeadline() {}
  async listTerms() { return [] }
  async setTerms() {}
  async myTermsFor() { return null }
  async saveUser(u: SaveUser) { const x = this.users.find(y => y.email === u.email); if (x) x.access = u.access }
  async setMyPrefs(p: Prefs) { return p }
  async setUserLang() { /* demo */ }
  async setMyName() {}
  async getDoc(): Promise<SalesDoc> { throw new Error('Not in demo') }
  async sharedDoc() { return null }
  async paymentTerms() { return [] as PaymentTerm[] }
  async setPaymentTerm() {}
  async createOrder(): Promise<{ id: number; so_number: string }> { throw new Error('Not in demo') }
  async setOrderTerms() {}
  async makeInvoice(): Promise<Invoice> { throw new Error('Not in demo') }
  async listInvoices() { return [] as Invoice[] }
  async setInvoiceTerms() {}
  async setInvoiceInfo() {}
  async setInvoiceLine() {}
  async removeInvoiceLine() {}
  async setInvoiceStatus() {}
  async markInvoiceSent() {}
  async fulfillmentOrders() { return [] as FOrder[] }
  async pickPallet() { throw new Error('Not in demo') }
  async pickPart() { throw new Error('Not in demo') }
  async unpick() {}
  async cantFill() {}
  async approveFill() { return 0 }
  async orderToLoad() { throw new Error('Not in demo') }
  async orderOffLoad() {}
  async orderTransfer(): Promise<number> { throw new Error('Not in demo') }
  async orderTransferNew(): Promise<number> { throw new Error('Not in demo') }
  async stopManifest(): Promise<StopManifest> { throw new Error('Not in demo') }
  async setPalletOrigin() { throw new Error('Not in demo') }
  async setLotGrade(): Promise<LotImpact> { throw new Error('Not in demo') }
  async setPalletGrade() { throw new Error('Not in demo') }
  async adminOverview(): Promise<Overview> { throw new Error('Not in demo') }
  async dashRecord() {}
  async dashSeries(keys: string[], from: string) {
    // made-up wobbly lines so the demo shows trends
    const out: { day: string; key: string; value: number }[] = []
    const d0 = new Date(from + 'T12:00:00'), today = new Date()
    const base: Record<string, number> = { freezer_lbs: 489000, open_spaces: 133, metrc_issues: 2, tags_pending: 0 }
    for (let d = new Date(d0); d <= today; d.setDate(d.getDate() + 1)) {
      const i = Math.round((today.getTime() - d.getTime()) / 864e5)  // days before today
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      for (const k of keys) {
        const b = base[k] ?? 10, t = -i / 30
        const v = k === 'open_spaces' ? b - t * 14 + Math.sin(i) * 3 : k === 'metrc_issues' ? b - t * 2 + Math.sin(i / 2) * 2 : b * (1 + t * 0.035) + Math.sin(i / 3) * b * 0.01
        out.push({ day, key: k, value: Math.max(0, Math.round(v)) })
      }
    }
    return out
  }
  async appSettings() { return {} as Record<string, string> }
  async setAppSetting() {}
  client() { return null }
}
