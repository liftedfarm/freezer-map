import type { SupabaseClient } from '@supabase/supabase-js'

function fail(error: { message: string } | null) { if (error) throw new Error(error.message) }

export type Env = 'sandbox' | 'production'
export interface Push { status: 'sent' | 'error'; qbo_id: string | null; doc_number: string | null; balance: number | null; total: number | null; error: string | null; sent_by: string | null; sent_at: string; synced_at: string | null }
export interface AInvoice {
  id: number; inv: string; date: string; due: string | null; total: number; status: 'open' | 'paid' | 'void'; terms: string | null
  customer_id: number; customer: string; outside: boolean; nursery: boolean; acct_status: string; acct_ref: string | null; paid_at: string | null; so: string | null; push: Push | null
}
export interface QLine { line_id: number; product: string | null; item: string | null; grp: string | null; site: string | null; year: number | null; class: string | null; description: string; qty: number; price: number; amount: number; uom?: string; split?: boolean; applies_to?: number | null; class_set?: string | null; kind?: 'product' | 'charge' }
export interface Payload {
  env: Env; invoice_id: number; doc_number: string; date: string; due: string | null; terms: string | null; total: number; status: string; memo: string | null
  so: string | null; nursery: boolean; seller_license: string | null
  customer: { id: number; name: string; legal_name: string; kind: string; email: string | null; qbo_id: string | null }
  lines: QLine[]; problems: string[]; push: Push | null
}
export interface Product { code: string; name: string; grp: 'flower' | 'bio' | 'clones' | 'shipping' | 'adjust' | 'other'; sort: number; active: boolean }
export interface AClass { name: string; sort: number; active: boolean; notes: string | null }
export interface Rule { id?: number; sort?: number; site: string | null; grp: string | null; year_from: number | null; year_to: number | null; class_name: string; notes: string | null }
export interface Conn { env: Env; active: boolean; company: string | null; realm: string; connected_by: string | null; connected_at: string; last_sync_at: string | null; last_error: string | null; expired: boolean }
export interface Overview { env: Env; to_send: number; to_send_amt: number; errors: number; sent_month: number; sent_month_amt: number; unpaid: number; unpaid_amt: number; overdue: number; overdue_amt: number; missing_product: number; last_sync: string | null }
export interface Ref { env: string; kind: string; key: string; qbo_id: string; name: string | null; updated_at: string }

export const GRP_LABEL: Record<Product['grp'], string> = { flower: 'Flower (fresh frozen, standards, smalls, trim)', bio: 'Biomass', clones: 'Clones', shipping: 'Shipping', adjust: 'Discount / return / refund', other: 'Other' }

export class AcctApi {
  constructor(private sb: SupabaseClient) {}
  private async rpc<T>(fn: string, args?: object): Promise<T> { const { data, error } = await this.sb.rpc(fn, args ?? {}); fail(error); return data as T }
  /** the server functions (QuickBooks) */
  async server<T = Record<string, unknown>>(path: 'run' | 'connect', body: object): Promise<T> {
    const { data } = await this.sb.auth.getSession()
    const r = await fetch(`/api/qbo/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    return j as T
  }
  overview() { return this.rpc<Overview>('acct_overview') }
  invoices() { return this.rpc<AInvoice[]>('acct_invoices').then(r => (r ?? []).map(i => ({ ...i, total: Number(i.total) }))) }
  payload(id: number) { return this.rpc<Payload>('acct_invoice_payload', { p_inv: id }) }
  connection() { return this.rpc<{ env: Env; connections: Conn[] }>('acct_connection') }
  async products() { const { data, error } = await this.sb.from('acct_products').select('*').order('sort'); fail(error); return (data ?? []) as Product[] }
  async classes() { const { data, error } = await this.sb.from('acct_classes').select('*').order('sort'); fail(error); return (data ?? []) as AClass[] }
  async rules() { const { data, error } = await this.sb.from('acct_class_rules').select('*').order('sort').order('id'); fail(error); return (data ?? []) as Rule[] }
  async refs() { const { data, error } = await this.sb.from('qbo_refs').select('*').order('kind').order('key'); fail(error); return (data ?? []) as Ref[] }
  async linesWithoutProduct() { const { data, error } = await this.sb.from('invoice_lines').select('invoice_id').is('acct_product', null).limit(1000); fail(error); return new Set(((data ?? []) as { invoice_id: number }[]).map(x => x.invoice_id)) }
  setLine(inv: number, line: number, product: string | null, cls: string | null, appliesTo: number | null = null) { return this.rpc<void>('acct_set_line', { p_inv: inv, p_line: line, p_product: product ?? '', p_class: cls ?? '', p_applies_to: appliesTo }) }
  addLine(inv: number, product: string, description: string, qty: number, price: number, appliesTo: number | null) { return this.rpc<void>('acct_add_line', { p_inv: inv, p_product: product, p_description: description, p_qty: qty, p_price: price, p_applies_to: appliesTo }) }
  removeLine(inv: number, line: number) { return this.rpc<unknown>('remove_invoice_line', { p_inv: inv, p_line: line }) }
  saveProduct(p: { code: string; name: string; grp: string; active: boolean }) { return this.rpc<void>('acct_save_product', { p_code: p.code, p_name: p.name, p_grp: p.grp, p_active: p.active }) }
  saveClass(name: string, old: string | null, active: boolean) { return this.rpc<void>('acct_save_class', { p_name: name, p_old: old, p_active: active }) }
  saveRules(rules: Rule[]) { return this.rpc<void>('acct_save_rules', { p_rules: rules }) }
  forgetRef(kind: string, key: string) { return this.rpc<void>('acct_forget_ref', { p_kind: kind, p_key: key }) }
}
