// Live Bonus math, same as the Live Bonus BTS tab in Farm Data OHR 2026:
// - Corriente (lbs/person) = packed lbs today / people on the labor chart
// - Bono/hora = packed lbs x $/lb / people / est hours; paid only once lbs/person passes La Meta (all or nothing)
// - Velocidad (lbs/bucker/hr) = packed lbs / (hours since box start minus breaks) / buckers, at the last pallet
// All times are minutes since local midnight (America/Los_Angeles).

export interface BonusCard {
  room_start: string | null; box_start: string | null; people: number | null; buckers: number | null; cutters: number | null
  est_hours: number; hurdle: number | null; hourly: number; per_lb: number
}
export interface BonusBreak { kind: string; start_at: string; end_at: string | null }
export interface BonusPallet { code: string; strain: string; lbs: number; min: number }
export interface BonusData {
  site: string; site_name: string | null; day: string; now_min: number; is_today: boolean
  card: BonusCard | null; breaks: BonusBreak[]; pallets: BonusPallet[]
}
export type Level = 'g' | 'y' | 'r' | 'wait'

export const SPEED_RED = 70
export const SPEED_YELLOW = 77.5
export const SPEED_MAX = 115

export const hm = (s: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
export const clock = (min: number) => {
  const h = Math.floor(min / 60) % 24, m = Math.floor(min % 60)
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** minutes of break inside [a, b]; a break still going runs to nowMin */
export function breakMin(breaks: BonusBreak[], a: number, b: number, nowMin: number) {
  let out = 0
  for (const br of breaks) {
    const s = hm(br.start_at), e = hm(br.end_at) ?? nowMin
    if (s == null) continue
    out += Math.max(0, Math.min(b, e) - Math.max(a, s))
  }
  return out
}
const worked = (breaks: BonusBreak[], a: number, b: number, nowMin: number) => Math.max(0, b - a - breakMin(breaks, a, b, nowMin))

export const speedLevel = (v: number | null): Level => v == null ? 'wait' : v < SPEED_RED ? 'r' : v < SPEED_YELLOW ? 'y' : 'g'

export interface BonusView {
  ready: boolean; missing: string[]
  packed: number; pallets: number; people: number | null; buckers: number | null
  corr: number | null; hurdle: number | null; proj: number | null; won: boolean; level: Level
  bonusNow: number; bonusProj: number; bonusAtStake: number; hourly: number; payNow: number; payProj: number
  speed: number | null; need: number | null; avgPalletMin: number | null
  workedH: number; estHours: number; onBreak: BonusBreak | null; variety: string | null
  series: { strain: string; v: number; min: number; code: string }[]
}

export function computeBonus(d: BonusData, nowMin: number): BonusView {
  const c = d.card
  const ps = [...d.pallets].sort((a, b) => a.min - b.min)
  const box = hm(c?.box_start) ?? hm(c?.room_start)
  const start = hm(c?.room_start) ?? box
  const people = c?.people ?? null, buckers = c?.buckers ?? null, hurdle = c?.hurdle ?? null
  const est = Number(c?.est_hours ?? 8) || 8, perLb = Number(c?.per_lb ?? 0.25), hourly = Number(c?.hourly ?? 18)
  const missing = [!c?.box_start && 'box start', !people && 'people', !buckers && 'buckers', !hurdle && 'La Meta'].filter(Boolean) as string[]
  const now = d.is_today ? nowMin : Math.max(nowMin, ps.length ? ps[ps.length - 1].min : 0)

  const packed = ps.reduce((s, p) => s + Number(p.lbs || 0), 0)
  const series: BonusView['series'] = []
  let cum = 0
  for (const p of ps) {
    cum += Number(p.lbs || 0)
    const w = box != null ? worked(d.breaks, box, p.min, now) / 60 : 0
    if (w > 0 && buckers) series.push({ strain: p.strain, v: cum / w / buckers, min: p.min, code: p.code })
  }
  const last = ps[ps.length - 1]
  const workedToLast = box != null && last ? worked(d.breaks, box, last.min, now) / 60 : 0
  const lbsPerHr = workedToLast > 0 ? packed / workedToLast : 0
  const speed = series.length ? series[series.length - 1].v : null

  const gaps: number[] = []
  let prev = box
  if (box != null) for (const p of ps) { if (prev != null && p.min > prev) gaps.push(worked(d.breaks, prev, p.min, now)); prev = p.min }
  const avgPalletMin = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : null

  const workedH = start != null ? worked(d.breaks, start, now, now) / 60 : 0
  const remaining = d.is_today ? Math.max(0, est - workedH) : 0
  const projPacked = packed + lbsPerHr * remaining
  const corr = people ? packed / people : null
  const proj = people ? projPacked / people : null
  const won = corr != null && hurdle != null && corr > hurdle
  const ratio = proj != null && hurdle ? proj / hurdle : null
  const level: Level = !ps.length || ratio == null ? 'wait' : won ? 'g' : ratio >= 1.05 ? 'g' : ratio >= 0.9 ? 'y' : 'r'
  const per = (lbs: number) => (people ? lbs * perLb / people / est : 0)
  const bonusNow = won ? per(packed) : 0
  const bonusProj = proj != null && hurdle != null && proj > hurdle ? per(projPacked) : 0
  const bonusAtStake = people && hurdle ? per(Math.max(projPacked, hurdle * people)) : 0
  const need = !won && people && hurdle && buckers && remaining > 0 ? Math.max(0, (hurdle * people - packed) / (buckers * remaining)) : null
  const onBreak = d.is_today ? d.breaks.find(b => !b.end_at) ?? null : null

  return {
    ready: missing.length === 0, missing, packed, pallets: ps.length, people, buckers, corr, hurdle, proj, won, level,
    bonusNow, bonusProj, bonusAtStake, hourly, payNow: hourly + bonusNow, payProj: hourly + bonusProj,
    speed, need, avgPalletMin, workedH, estHours: est, onBreak, variety: last?.strain ?? null, series,
  }
}
