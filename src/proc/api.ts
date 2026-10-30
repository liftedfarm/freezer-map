import type { SupabaseClient } from '@supabase/supabase-js'
import type { Pallet, Product } from '../types'

function fail(error: { message: string } | null) { if (error) throw new Error(error.message) }
const num = (x: unknown) => (x == null ? null : Number(x))

export interface Processor { id: number; name: string; short: string | null; in_house: boolean; license: string | null; active: boolean; sort: number; notes: string | null; address?: string | null; contact?: string | null; phone?: string | null }
export interface DryHarvest { id: number; crop_year: number; site: string; field: string | null; strain: string; status: string; planned_on: string | null; harvested_on: string | null; raw_lbs: number | null; plants: number | null; dry_conversion?: number | null }
export interface OLine { id: number; order_id: number; so: string | null; customer_id: number; customer: string; strain: string; product: Product; lbs: number; crop_year: number; wanted: string | null; on_load: boolean; picked: number; promised: number }
export interface Run {
  id: number; code: string; kind: 'buck' | 'sort' | 'trim' | 'machine'; site: string; strain: string | null; crop_year: number | null; request_id: number | null; status: 'open' | 'done' | 'cancelled'
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
/** forecast shares (049): dry = bucked / wet, bt = buck trim / bucked, std / sml / trm / mold = share of bucked lbs going into trimming */
export interface Shares { dry?: number | null; bt?: number | null; std?: number | null; sml?: number | null; trm?: number | null; mold?: number | null; buck_runs?: number; trim_runs?: number; history?: boolean }
export interface Rates { default_dry: number; all: Shares; strains: Record<string, Shares> }
export interface Promise_ { id: number; pallet_id: number; line_id: number; product: 'standards' | 'smalls' | 'trim'; lbs: number; so: string | null; customer: string }
export interface History { strain: string; crop_year: number; source: string; wet_lbs: number | null; bucked: number; buck_mold: number; buck_trim: number; standards: number; trim_mold: number; smalls: number; trim_lbs: number; notes: string | null }
export interface Labor { strain: string; crop_year: number | null; task: 'buck' | 'trim'; lbs: number; hours: number; pay: number }
export interface Spot { id: number; code: string; row: number; freezer_id: number }
export interface Box { id: number; site: string; number: number; kind: string }
export interface PData {
  pallets: Pallet[]; runs: Run[]; inputs: RunInput[]; requests: Req[]; processors: Processor[]
  harvests: DryHarvest[]; lines: OLine[]; customers: { id: number; name: string }[]; held: { pallet_id: number; so: string | null; customer: string }[]
  promises: Promise_[]; rates: Rates
  slots: Map<number, Spot>; freezers: Map<number, Box>
}
export interface OutRow { product: Product; lbs: number | null; tag: string }

const PAL_NUM = ['og_weight', 'current_weight'] as const

export class ProcApi {
  constructor(private sb: SupabaseClient) {}
  /** the database hands back at most 1,000 rows per request: keep asking until it's all here (there are 1,100+ freezer spots) */
  private async all(q: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
    const out: unknown[] = []
    for (let a = 0; ; a += 1000) {
      const { data, error } = await q(a, a + 999)
      if (error) return { data: null, error }
      out.push(...(data ?? []))
      if ((data ?? []).length < 1000) return { data: out, error: null }
    }
  }
  private async rpc<T>(fn: string, args?: object): Promise<T> { const { data, error } = await this.sb.rpc(fn, args ?? {}); fail(error); return data as T }

  async load(): Promise<PData> {
    const [pal, runs, inputs, reqs, procs, extra, slots, fz] = await Promise.all([
      this.all((a, b) => this.sb.from('pallets').select('*').neq('product', 'fresh_frozen').not('status', 'in', '(archived,merged)').order('id', { ascending: false }).range(a, b)),
      this.all((a, b) => this.sb.from('proc_runs').select('*').order('id', { ascending: false }).range(a, b)),
      this.all((a, b) => this.sb.from('proc_run_inputs').select('*').order('id').range(a, b)),
      this.sb.from('proc_requests').select('*').order('due_on', { ascending: true, nullsFirst: false }).limit(1000),
      this.sb.from('proc_processors').select('*').order('sort').order('name'),
      this.rpc<{ harvests: DryHarvest[]; lines: OLine[]; customers: { id: number; name: string }[]; held: PData['held']; promises?: Promise_[]; rates?: Rates }>('proc_data'),
      this.all((a, b) => this.sb.from('slots').select('id,code,row,freezer_id').order('id').range(a, b)),
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
      lines: nums<OLine>(extra.lines ?? [], ['lbs', 'picked', 'promised']).map(l => ({ ...l, promised: l.promised ?? 0 })),
      promises: nums<Promise_>(extra.promises ?? [], ['lbs']), rates: extra.rates ?? { default_dry: 0.075, all: {}, strains: {} },
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
  /** 117 processor returns: our label is on (METRC new package from theirs), close a wet lot, link a return to its lot */
  retag(pallet: number, tag: string) { return this.rpc<{ code: string; from: string; to: string }>('proc_retag', { p_pallet: pallet, p_tag: tag }) }
  closeLot(lot: number) { return this.rpc<{ code: string; wet: number; dry: number; yield_pct: number | null }>('proc_close_lot', { p_lot: lot }) }
  linkReturn(pallet: number, lot: number | null) { return this.rpc<void>('proc_link_return', { p_pallet: pallet, p_lot: lot }) }
  dried(ids: number[]) { return this.rpc<number>('proc_mark_dried', { p_ids: ids }) }
  startRun(kind: 'buck' | 'sort' | 'trim' | 'machine', inputs: { pallet: number; lbs: number | null }[], request: number | null, notes: string, site: string, on: string | null) {
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
  /** what the crew logged on a run (048), in total and per day */
  async crewOf(run: number) {
    const { data, error } = await this.sb.from('piece_pay').select('*').eq('run_id', run)
    fail(error)
    const r = ((data ?? []) as Record<string, unknown>[]).map(x => ({ employee_id: Number(x.employee_id), work_date: String(x.work_date), lbs: Number(x.lbs), mold: Number(x.mold),
      smalls: Number(x.smalls), trim: Number(x.trim), hours: Number(x.hours), pay: Number(x.pay), hit: !!x.hit, rate: num(x.rate), target: num(x.target), custom: x.day_rate != null || x.day_target != null }))
    type R = typeof r[number]
    const tot = (xs: R[]) => { const s = (f: (x: R) => number) => xs.reduce((a, x) => a + f(x), 0)
      return { people: new Set(xs.map(x => x.employee_id)).size, lbs: s(x => x.lbs), mold: s(x => x.mold), smalls: s(x => x.smalls), trim: s(x => x.trim),
        other: s(x => x.mold + x.smalls + x.trim), hours: s(x => x.hours), pay: s(x => x.pay), hit: xs.filter(x => x.hit).length, n: xs.length } }
    const dates = [...new Set(r.map(x => x.work_date))].sort()
    const byDay = dates.map(date => { const xs = r.filter(x => x.work_date === date); return { date, ...tot(xs), rate: xs[0]?.rate ?? null, target: xs[0]?.target ?? null, custom: xs.some(x => x.custom) } })
    return { ...tot(r), days: dates.length, byDay }
  }
  commitForecast(line: number, pallet: number, lbs: number) { return this.rpc<unknown>('proc_commit_forecast', { p_line: line, p_pallet: pallet, p_lbs: lbs }) }
  setDryDefault(pct: number) { return this.rpc<void>('proc_set_dry_default', { p_pct: pct }) }
  uncommit(id: number) { return this.rpc<void>('proc_uncommit', { p_id: id }) }
  async idsOf(codes: string[]) { const { data, error } = await this.sb.from('pallets').select('id').in('code', codes); fail(error); return ((data ?? []) as { id: number }[]).map(x => x.id) }
  manifest(ids: number[]) { return this.rpc<import('../types').StopManifest>('proc_manifest', { p_ids: ids }) }
  async history() { const { data, error } = await this.sb.from('proc_yield_history').select('*'); fail(error); return ((data ?? []) as History[]).map(h => ({ ...h, bucked: Number(h.bucked), buck_mold: Number(h.buck_mold), buck_trim: Number(h.buck_trim), standards: Number(h.standards), trim_mold: Number(h.trim_mold), smalls: Number(h.smalls), trim_lbs: Number(h.trim_lbs) })) }
  labor(year: number | null) { return this.rpc<Labor[]>('proc_labor', { p_year: year }).then(r => (r ?? []).map(x => ({ ...x, lbs: Number(x.lbs), hours: Number(x.hours), pay: Number(x.pay) }))).catch(() => [] as Labor[]) }
  saveProcessor(p: Partial<Processor>) { return this.rpc<Processor>('proc_save_processor', { p }) }
}
