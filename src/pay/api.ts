import type { SupabaseClient } from '@supabase/supabase-js'

// Piece rate pay (048): Processing logs each person's day, Accounting pays it per bi-weekly period.
function fail(error: { message: string } | null) { if (error) throw new Error(error.message) }
const num = (x: unknown) => (x == null ? null : Number(x))

export type Task = 'buck' | 'trim'
export interface Employee { id: number; name: string; payroll_id: string | null; active: boolean; notes: string | null }
export interface Rate { id: number; task: Task; rate: number; target: number; effective_from: string; notes: string | null }
export interface Entry {
  id: number; work_date: string; employee_id: number; employee: string; payroll_id: string | null; task: Task; run_id: number | null; strain: string | null
  crop_year: number | null; farm: 'OHR' | 'GVR' | null; lbs: number; mold: number; smalls: number; trim: number; hours: number; note: string | null; source: string
  rate: number | null; target: number | null; lbs_hr: number | null; hit: boolean; pay: number; period_start: string
  /** the day's own rate (053); null = the standing rate */
  day_rate: number | null; day_target: number | null
}
export interface Period { id: number; starts: string; ends: string; status: 'open' | 'closed'; closed_by: string | null; closed_at: string | null; exported_by: string | null; exported_at: string | null; notes: string | null }
export interface PayLine { employee_id: number; name: string; payroll_id: string | null; task: Task; farm: string | null; entries: number; hours: number; lbs: number; paid_lbs: number; amount: number }
export interface Adjustment { id: number; employee_id: number; name: string; amount: number; reason: string; by: string | null; at: string }
export interface Summary { starts: string; ends: string; status: 'open' | 'closed'; closed_by: string | null; closed_at: string | null; exported_by: string | null; exported_at: string | null; notes: string | null; lines: PayLine[]; adjustments: Adjustment[]; days: number }
export interface DayRow { id?: number | null; employee_id: number | null; lbs: number | null; mold: number | null; smalls: number | null; trim: number | null; hours: number | null; note?: string | null; delete?: boolean }

export const TASK_LABEL: Record<Task, string> = { buck: 'Bucking', trim: 'Trimming' }
/** the workbook rule: pay every flower lb when lbs/hr reaches the target, else nothing */
export function payOf(lbs: number, hours: number, r: Rate | undefined) {
  if (!r || !(hours > 0)) return { lph: null as number | null, hit: false, pay: 0 }
  const lph = lbs / hours, hit = lph >= r.target
  return { lph, hit, pay: hit ? Math.round(lbs * r.rate * 100) / 100 : 0 }
}
export const rateOn = (rates: Rate[], task: Task, date: string) => rates.filter(r => r.task === task && r.effective_from <= date).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
/** bi-weekly periods from the anchor (12/22/2025 unless changed in app settings) */
export function periodStart(date: string, anchor = '2025-12-22') {
  const a = new Date(anchor + 'T12:00:00').getTime(), d = new Date(date + 'T12:00:00').getTime()
  const k = Math.floor(Math.round((d - a) / 86400000) / 14)
  return new Date(a + k * 14 * 86400000).toISOString().slice(0, 10)
}
export const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export class PayApi {
  constructor(private sb: SupabaseClient) {}
  private async rpc<T>(fn: string, args?: object): Promise<T> { const { data, error } = await this.sb.rpc(fn, args ?? {}); fail(error); return data as T }
  async employees() { const { data, error } = await this.sb.from('employees').select('*').order('name'); fail(error); return (data ?? []) as Employee[] }
  async rates() { const { data, error } = await this.sb.from('piece_rates').select('*').order('task').order('effective_from', { ascending: false }); fail(error); return ((data ?? []) as Rate[]).map(r => ({ ...r, rate: Number(r.rate), target: Number(r.target) })) }
  async periods() { const { data, error } = await this.sb.from('pay_periods').select('*').order('starts', { ascending: false }); fail(error); return (data ?? []) as Period[] }
  entries(from: string, to: string) { return this.pay(q => q.gte('work_date', from).lte('work_date', to)) }
  /** every day logged on one run */
  runEntries(run: number) { return this.pay(q => q.eq('run_id', run)) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async pay(f: (q: any) => any) {
    const out: Entry[] = []
    for (let a = 0; ; a += 1000) {
      const { data, error } = await f(this.sb.from('piece_pay').select('*')).order('work_date').order('id').range(a, a + 999)
      fail(error)
      const rows = (data ?? []) as Record<string, unknown>[]
      out.push(...rows.map(r => ({ ...r, lbs: Number(r.lbs), mold: Number(r.mold), smalls: Number(r.smalls), trim: Number(r.trim), hours: Number(r.hours), rate: num(r.rate), target: num(r.target), lbs_hr: num(r.lbs_hr), pay: Number(r.pay), day_rate: num(r.day_rate), day_target: num(r.day_target) }) as unknown as Entry))
      if (rows.length < 1000) break
    }
    return out
  }
  saveEmployee(e: Partial<Employee>) { return this.rpc<Employee>('employee_save', { p: e }) }
  saveRate(task: Task, rate: number, target: number, from: string, notes: string) { return this.rpc<Rate>('piece_rate_save', { p_task: task, p_rate: rate, p_target: target, p_from: from, p_notes: notes }) }
  /** rate / target: this day's own piece rate, or null for the standing rate */
  saveDay(date: string, task: Task, run: number | null, strain: string | null, farm: string | null, rows: DayRow[], rate: number | null = null, target: number | null = null) {
    return this.rpc<number>('piece_save_day', { p_date: date, p_task: task, p_run: run, p_strain: strain, p_farm: farm, p_rows: rows, p_rate: rate, p_target: target })
  }
  summary(start: string) {
    return this.rpc<Summary>('pay_summary', { p_start: start }).then(s => ({
      ...s, lines: (s.lines ?? []).map(l => ({ ...l, hours: Number(l.hours), lbs: Number(l.lbs), paid_lbs: Number(l.paid_lbs), amount: Number(l.amount) })),
      adjustments: (s.adjustments ?? []).map(a => ({ ...a, amount: Number(a.amount) })) }))
  }
  close(start: string, notes: string) { return this.rpc<void>('pay_close', { p_start: start, p_notes: notes }) }
  reopen(start: string) { return this.rpc<void>('pay_reopen', { p_start: start }) }
  adjust(start: string, employee: number, amount: number, reason: string) { return this.rpc<unknown>('pay_adjust', { p_start: start, p_employee: employee, p_amount: amount, p_reason: reason }) }
  removeAdjust(id: number) { return this.rpc<void>('pay_adjust_remove', { p_id: id }) }
  exported(start: string) { return this.rpc<void>('pay_mark_exported', { p_start: start }) }
}
