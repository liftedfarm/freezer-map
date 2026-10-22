import type { SupabaseClient } from '@supabase/supabase-js'
import type { Batch, Delivery, License, Mother, NData, NOrder, NRoom, NSite, OStatus, TagRange } from './types'

function fail(error: { message: string } | null) { if (error) throw new Error(error.message) }
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    fail(error)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < 1000) return out
  }
}
const num = (v: unknown) => (v == null || v === '' ? null : Number(v))

export interface OrderInput {
  id?: number; nursery_site?: string; site?: string | null; customer_id?: number | null; strain: string; plants: number
  cut_on?: string | null; deliver_on?: string | null; price_each?: number | null; po_number?: string | null; payment_terms?: string | null; notes?: string | null
}

export class NurseryApi {
  constructor(private sb: SupabaseClient) {}

  async load(): Promise<NData> {
    const [sites, rooms, mothers, batches, orders, deliveries, licenses, ranges, strains, st] = await Promise.all([
      all<NSite>((a, b) => this.sb.from('nursery_sites').select('*').order('sort').range(a, b)),
      all<NRoom>((a, b) => this.sb.from('nursery_rooms').select('*').order('sort').order('name').range(a, b)),
      all<Mother>((a, b) => this.sb.from('nursery_mothers').select('*').order('strain').order('id').range(a, b)),
      all<Batch>((a, b) => this.sb.from('nursery_batches').select('*').order('cut_on', { ascending: false }).order('id', { ascending: false }).range(a, b)),
      all<NOrder>((a, b) => this.sb.from('cult_nursery_orders').select('*').not('nursery_site', 'is', null).order('deliver_on', { ascending: true, nullsFirst: false }).range(a, b)),
      all<Delivery>((a, b) => this.sb.from('nursery_deliveries').select('*').order('delivered_on', { ascending: false }).range(a, b)),
      all<License>((a, b) => this.sb.from('licenses').select('*').order('sort').range(a, b)),
      all<TagRange>((a, b) => this.sb.from('tag_ranges').select('*').order('id').range(a, b)),
      all<{ name: string; active: boolean }>((a, b) => this.sb.from('strains').select('name,active').order('name').range(a, b)),
      all<{ key: string; value: string }>((a, b) => this.sb.from('app_settings').select('key,value').like('key', 'nursery.%').range(a, b)),
    ])
    const s = new Map(st.map(r => [r.key, r.value]))
    return {
      sites, rooms, mothers, licenses, ranges, deliveries,
      batches: batches.map(b => ({ ...b, tags: b.tags ?? [] })),
      orders: orders.map(o => ({ ...o, price_each: num(o.price_each) })),
      strains: strains.filter(x => x.active !== false).map(x => x.name),
      settings: {
        price: Number(s.get('nursery.clone_price') ?? 5), terms: s.get('nursery.terms') ?? 'COD',
        rootDays: Number(s.get('nursery.root_days') ?? 14), readyWarn: Number(s.get('nursery.ready_warn_days') ?? 14),
      },
    }
  }

  private async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args)
    if (error && /schema cache|does not exist/.test(error.message)) throw new Error('Run 028_licenses_nursery.sql in Supabase first')
    fail(error); return data as T
  }
  saveOrder(o: OrderInput) { return this.rpc<NOrder>('nursery_save_order', { p: o }) }
  setStatus(id: number, status: OStatus, note?: string) { return this.rpc<NOrder>('nursery_order_status', { p_order: id, p_status: status, p_note: note ?? null }) }
  deliver(orderId: number, lines: { batch: number | null; plants: number }[], date: string | null, manifest: string | null, notes: string | null) {
    return this.rpc<{ ref: string; plants: number; invoice_id: number | null; invoice: string | null; so: string }>('nursery_deliver',
      { p_order: orderId, p_lines: lines, p_date: date, p_manifest: manifest, p_notes: notes })
  }
  undoDelivery(ref: string) { return this.rpc('nursery_undo_delivery', { p_ref: ref }) }
  async nextTags(site: string, n: number) { try { return await this.rpc<string[]>('nursery_next_tags', { p_site: site, p_count: n }) ?? [] } catch { return [] } }
  setSetting(key: string, value: string) { return this.rpc('set_nursery_setting', { p_key: key, p_value: value }) }
  saveRange(p: { license: string; first?: string; last?: string; id?: number; active?: boolean; purpose?: string; notes?: string | null }) { return this.rpc<TagRange>('save_tag_range', { p }) }

  // mothers, batches, rooms, sites: plain table writes (the database checks who can)
  async save<T extends { id?: number }>(table: 'nursery_mothers' | 'nursery_batches' | 'nursery_rooms', row: Partial<T>) {
    const { id, ...rest } = row as Record<string, unknown>
    for (const k of ['created_at', 'updated_at', 'created_by']) delete rest[k]
    const q = id ? this.sb.from(table).update(rest).eq('id', id) : this.sb.from(table).insert(rest)
    const { error } = await q; fail(error)
  }
  async insertMany(table: 'nursery_mothers', rows: Partial<Mother>[]) { const { error } = await this.sb.from(table).insert(rows); fail(error) }
  async updateMany(table: 'nursery_mothers' | 'nursery_batches', ids: number[], v: Record<string, unknown>) { const { error } = await this.sb.from(table).update(v).in('id', ids); fail(error) }
  async remove(table: 'nursery_mothers' | 'nursery_batches', id: number) { const { error } = await this.sb.from(table).delete().eq('id', id); fail(error) }
  async saveSite(code: string, v: Partial<NSite>) { const { error } = await this.sb.from('nursery_sites').update(v).eq('code', code); fail(error) }

  async activity(limit = 300) {
    const { data, error } = await this.sb.from('events').select('id,at,user_email,type,note,details').like('type', 'nursery%').order('at', { ascending: false }).limit(limit)
    fail(error); return (data ?? []) as { id: number; at: string; user_email: string | null; type: string; note: string | null; details: Record<string, unknown> | null }[]
  }
}
