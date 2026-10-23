import type { SupabaseClient } from '@supabase/supabase-js'
import type { Pallet, Product } from '../types'

function fail(error: { message: string } | null) { if (error) throw new Error(error.message) }
const num = (x: unknown) => (x == null ? null : Number(x))

export interface Processor { id: number; name: string; short: string | null; in_house: boolean; license: string | null; active: boolean; sort: number; notes: string | null }
export interface DryHarvest { id: number; crop_year: number; site: string; field: string | null; strain: string; status: string; planned_on: string | null; harvested_on: string | null; raw_lbs: number | null; plants: number | null }
export interface OLine { id: number; order_id: number; so: string | null; customer_id: number; customer: string; strain: string; product: Product; lbs: number; crop_year: number; wanted: string | null; on_load: boolean; picked: number }
export interface Run {
  id: number; code: string; kind: 'buck' | 'trim'; site: string; strain: string | null; crop_year: number | null; request_id: number | null; status: 'open' | 'done' | 'cancelled'
  started_on: string; finished_on: string | null; input_lbs: number | null; output_lbs: number | null; mold_lbs: number | null; loss_lbs: number | null; notes: string | null
  created_by: string | null; finished_by: string | null
}
export interface RunInput { id: number; run_id: number; pallet_id: number; lbs: number; whole: boolean }
export interface Req {
  id: number; strain: string; crop_year: number | null; product: 'standards' | 'smalls' | 'trim' | 'any'; lbs: number; due_on: string | null; customer_id: number | null
  order_line_id: number | null; note: string | null; status: 'open' | 'done' | 'cancelled'; created_by: string | null; created_at: string
}
export interface Yield {
  strain: string; crop_year: number | null; wet_lbs: number; bucked_in: number; bucked: number; buck_trim: number; buck_mold: number; moisture: number
  trim_in: number; standards: number; smalls: number; trim_lbs: number; trim_mold: number; trim_loss: number; buck_runs: number; trim_runs: number
}
export interface Spot { id: number; code: string; row: number; freezer_id: number }
export interface Box { id: number; site: string; number: number; kind: string }
export interface PData {
  pallets: Pallet[]; runs: Run[]; inputs: RunInput[]; requests: Req[]; processors: Processor[]
  harvests: DryHarvest[]; lines: OLine[]; customers: { id: number; name: string }[]; held: { pallet_id: number; so: string | null; customer: string }[]
  slots: Map<number, Spot>; freezers: Map<number, Box>
}
export interface OutRow { product: Product; lbs: number | null; tag: string }

const PAL_NUM = ['og_weight', 'current_weight'] as const

export class ProcApi {
  constructor(private sb: SupabaseClient) {}
  private async rpc<T>(fn: string, args?: object): Promise<T> { const { data, error } = await this.sb.rpc(fn, args ?? {}); fail(error); return data as T }

  async load(): Promise<PData> {
    const [pal, runs, inputs, reqs, procs, extra, slots, fz] = await Promise.all([
      this.sb.from('pallets').select('*').neq('product', 'fresh_frozen').not('status', 'in', '(archived,merged)').order('id', { ascending: false }).limit(5000),
      this.sb.from('proc_runs').select('*').order('id', { ascending: false }).limit(1000),
      this.sb.from('proc_run_inputs').select('*').limit(5000),
      this.sb.from('proc_requests').select('*').order('due_on', { ascending: true, nullsFirst: false }).limit(1000),
      this.sb.from('proc_processors').select('*').order('sort').order('name'),
      this.rpc<{ harvests: DryHarvest[]; lines: OLine[]; customers: { id: number; name: string }[]; held: PData['held'] }>('proc_data'),
      this.sb.from('slots').select('id,code,row,freezer_id').limit(5000),
      this.sb.from('freezers').select('id,site,number,kind'),
    ])
    for (const r of [pal, runs, inputs, reqs, procs, slots, fz]) fail(r.error)
    const pallets = ((pal.data ?? []) as Pallet[]).map(p => { const x = { ...p } as Record<string, unknown>; for (const k of PAL_NUM) x[k] = num(x[k]); return x as unknown as Pallet })
    const nums = <T,>(rows: unknown[], keys: string[]) => rows.map(r => { const x = { ...(r as Record<string, unknown>) }; for (const k of keys) x[k] = num(x[k]); return x as T })
    return {
      pallets,
      runs: nums<Run>(runs.data ?? [], ['input_lbs', 'output_lbs', 'mold_lbs', 'loss_lbs']),
      inputs: nums<RunInput>(inputs.data ?? [], ['lbs']),
      requests: nums<Req>(reqs.data ?? [], ['lbs']),
      processors: (procs.data ?? []) as Processor[],
      harvests: nums<DryHarvest>(extra.harvests ?? [], ['raw_lbs']),
      lines: nums<OLine>(extra.lines ?? [], ['lbs', 'picked']),
      customers: extra.customers ?? [], held: extra.held ?? [],
      slots: new Map(((slots.data ?? []) as Spot[]).map(s => [s.id, s])),
      freezers: new Map(((fz.data ?? []) as Box[]).map(f => [f.id, f])),
    }
  }
  yields(year: number | null) { return this.rpc<Yield[]>('proc_yields', { p_year: year }).then(r => (r ?? []).map(y => Object.fromEntries(Object.entries(y).map(([k, v]) => [k, k === 'strain' ? v : num(v)])) as unknown as Yield)) }
  nextTags(site: string, n: number) { return this.rpc<string[]>('next_tags', { p_site: site, p_purpose: 'processing', p_count: n }) }

  makeWet(harvest: number, rows: { lbs: number; tag: string }[], processor: number | null, sent: string | null) {
    return this.rpc<string[]>('proc_make_wet', { p_harvest: harvest, p_rows: rows, p_processor: processor, p_sent: sent })
  }
  send(ids: number[], processor: number, on: string | null) { return this.rpc<number>('proc_send', { p_ids: ids, p_processor: processor, p_on: on }) }
  receive(ids: number[], site: string, tags: Record<string, string>) { return this.rpc<number>('proc_receive', { p_ids: ids, p_site: site, p_tags: tags }) }
  dried(ids: number[]) { return this.rpc<number>('proc_mark_dried', { p_ids: ids }) }
  startRun(kind: 'buck' | 'trim', inputs: { pallet: number; lbs: number | null }[], request: number | null, notes: string, site: string, on: string | null) {
    return this.rpc<Run>('proc_start_run', { p_kind: kind, p_inputs: inputs, p_request: request, p_notes: notes, p_site: site, p_on: on })
  }
  editRun(run: number, inputs: { pallet: number; lbs: number | null }[], request: number | null, notes: string) {
    return this.rpc<Run>('proc_edit_run', { p_run: run, p_inputs: inputs, p_request: request, p_notes: notes })
  }
  cancelRun(run: number) { return this.rpc<void>('proc_cancel_run', { p_run: run }) }
  finishRun(run: number, outputs: OutRow[], mold: number, notes: string, on: string | null) {
    return this.rpc<string[]>('proc_finish_run', { p_run: run, p_outputs: outputs.filter(o => o.lbs).map(o => ({ product: o.product, lbs: o.lbs, tag: o.tag })), p_mold: mold, p_notes: notes, p_on: on })
  }
  saveRequest(r: Partial<Req>) { return this.rpc<Req>('proc_save_request', { p: r }) }
  requestStatus(id: number, status: Req['status']) { return this.rpc<void>('proc_request_status', { p_id: id, p_status: status }) }
  commit(line: number, pallet: number, lbs: number | null, tag: string | null) { return this.rpc<unknown>('proc_commit', { p_line: line, p_pallet: pallet, p_lbs: lbs, p_tag: tag }) }
  /** what the crew logged on a run (048) */
  async crewOf(run: number) {
    const { data, error } = await this.sb.from('piece_pay').select('employee_id,work_date,lbs,mold,smalls,trim,hours,pay').eq('run_id', run)
    fail(error)
    const r = (data ?? []) as { employee_id: number; work_date: string; lbs: number; mold: number; smalls: number; trim: number; hours: number; pay: number }[]
    const s = (f: (x: typeof r[number]) => number) => r.reduce((a, x) => a + Number(f(x)), 0)
    return { people: new Set(r.map(x => x.employee_id)).size, days: new Set(r.map(x => x.work_date)).size, lbs: s(x => x.lbs), other: s(x => Number(x.mold) + Number(x.smalls) + Number(x.trim)), hours: s(x => x.hours), pay: s(x => x.pay) }
  }
  saveProcessor(p: Partial<Processor>) { return this.rpc<Processor>('proc_save_processor', { p }) }
}
