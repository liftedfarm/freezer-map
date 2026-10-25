import type { ReactNode } from 'react'

// Shared dashboard pieces: big-number tiles, cards, meters, trend lines. Every module's Dashboard is built from these.

/** urgency, quietest to loudest:
 *  ok/undefined = normal · info = FYI (blue) · heads = Heads up (gold) · warn = Needs action (rose) · bad = Urgent (solid oxblood) */
export type Tone = 'ok' | 'info' | 'heads' | 'warn' | 'bad' | undefined

export function DashHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="dhead">
      <div><h2>{title}</h2>{sub && <div className="muted">{sub}</div>}</div>
      {right && <div className="row">{right}</div>}
    </div>
  )
}

export function Tiles({ children }: { children: ReactNode }) { return <div className="dtiles">{children}</div> }

/** "539,707 lbs" -> big number + small unit */
function bigValue(v: ReactNode) {
  if (typeof v !== 'string') return v
  const m = /^(.+?) (lbs|clones|days)$/.exec(v)
  return m ? <>{m[1]}<span className="dt-u">{m[2]}</span></> : v
}

/** one number that matters, with what it means and where to go about it.
 *  wide: spans two columns (headline numbers) · range: chart window label · chart: <Spark>/<Bars> · kv: side figures on wide tiles · foot: the next move */
export function Tile({ value, label, sub, tone, onClick, foot, wide, range, chart, kv }: {
  value: ReactNode; label: ReactNode; sub?: ReactNode; tone?: Tone; onClick?: () => void
  foot?: ReactNode; wide?: boolean; range?: ReactNode; chart?: ReactNode; kv?: [ReactNode, ReactNode][]
}) {
  const cls = `dtile ${tone && tone !== 'ok' ? 't-' + tone : ''} ${wide ? 'w2' : ''} ${onClick ? 'click' : ''}`
  const big = <b className="dt-v">{bigValue(value)}</b>
  const body = <>
    <div className="dt-b">
      <div className="dt-h"><span className="dt-l"><i className="dt-dot" aria-hidden="true" />{label}</span>
        {range != null && <span className="dt-r">{range}</span>}
        {onClick && foot == null && range == null && <span className="dt-go" aria-hidden="true">›</span>}</div>
      {kv?.length ? <div className="dt-row">{big}<div className="dt-kv">{kv.map(([v, l], i) => <span key={i}><b>{v}</b>{l}</span>)}</div></div> : big}
      {sub != null && sub !== '' && <span className="dt-s">{sub}</span>}
      {chart && <div className="dt-c">{chart}</div>}
    </div>
    {foot != null && foot !== '' && <div className="dt-f"><span>{foot}</span>{onClick && <span aria-hidden="true">›</span>}</div>}
  </>
  return onClick ? <button className={cls} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>
}

type Pt = number | null | undefined
type P2 = readonly [number, number]
const pts = (a?: Pt[]): P2[] => (a ?? []).map((v, i) => [i, v] as const).filter((p): p is P2 => p[1] != null && isFinite(p[1]))

/** a small trend line. All arrays share one x axis (index = day/step).
 *  data: the real line (nulls where there's nothing yet) · ghost: comparison (last year / last month), dashed ·
 *  project: where it's heading, dotted, from the last real point on · goal: a flat target line · labels: under the axis */
export function Spark({ data, ghost, project, goal, labels, empty = 'Trend starts building today' }: {
  data: Pt[]; ghost?: Pt[]; project?: Pt[]; goal?: number; labels?: ReactNode[]; empty?: ReactNode
}) {
  const real = pts(data)
  if (real.length < 2) return <div className="dt-empty">{empty}</div>
  const n = Math.max(data.length, ghost?.length ?? 0, project?.length ?? 0)
  const g = pts(ghost), pr = pts(project)
  const vals = [...real, ...g, ...pr].map(p => p[1]).concat(goal != null ? [goal] : [])
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi === lo) { hi += 1; lo -= 1 }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0)
  const Y = (v: number) => 40 - ((v - lo) / (hi - lo)) * 40
  const line = (ps: P2[]) => ps.map(([i, v]) => `${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join(' ')
  const last = real[real.length - 1]
  const area = `M${X(real[0][0]).toFixed(2)},40 L${line(real).split(' ').join(' L')} L${X(last[0]).toFixed(2)},40 Z`
  const proj = pr.filter(p => p[0] > last[0])
  return (
    <div className="spark">
      <div className="spark-p">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
          {goal != null && <line x1="0" x2="100" y1={Y(goal)} y2={Y(goal)} className="sp-goal" vectorEffect="non-scaling-stroke" />}
          {g.length > 1 && <polyline points={line(g)} className="sp-ghost" vectorEffect="non-scaling-stroke" />}
          <path d={area} className="sp-area" />
          {proj.length > 0 && <polyline points={line([last, ...proj])} className="sp-proj" vectorEffect="non-scaling-stroke" />}
          <polyline points={line(real)} className="sp-line" vectorEffect="non-scaling-stroke" />
        </svg>
        <i className="sp-dot" style={{ left: `${X(last[0])}%`, top: `${(Y(last[1]) / 40) * 100}%` }} />
      </div>
      {labels && <div className="sp-ax">{labels.map((l, i) => <span key={i}>{l}</span>)}</div>}
    </div>
  )
}

/** a row of day bars (next 7 days and the like); the biggest bar is solid */
export function Bars({ items }: { items: { label: ReactNode; value: number; title?: string }[] }) {
  const max = Math.max(1, ...items.map(x => x.value))
  const top = items.reduce((a, x, i) => (x.value > items[a].value ? i : a), 0)
  return (
    <div className="dbars">
      {items.map((x, i) => (
        <div key={i} title={x.title}><i className={i === top && x.value > 0 ? 'pk' : ''} style={{ height: `${x.value > 0 ? Math.max(4, (x.value / max) * 100) : 0}%` }} /><span>{x.label}</span></div>
      ))}
    </div>
  )
}

/** legend for a Spark: solid line = now, dashed = the comparison */
export function Legend({ now, then }: { now: ReactNode; then?: ReactNode }) {
  return <span className="dt-lg"><span><i />{now}</span>{then && <span><i className="g" />{then}</span>}</span>
}

export function Cards({ children }: { children: ReactNode }) { return <div className="dcards">{children}</div> }

export function Card({ title, badge, action, onAction, wide, children }: {
  title: ReactNode; badge?: ReactNode; action?: string; onAction?: () => void; wide?: boolean; children: ReactNode
}) {
  return (
    <section className={`dcard ${wide ? 'wide' : ''}`}>
      <div className="dcard-h"><h3>{title}{badge != null && badge !== 0 && badge !== '' && <span className="side-badge">{badge}</span>}</h3>
        {action && onAction && <button className="linkbtn" onClick={onAction}>{action} ›</button>}</div>
      <div className="dcard-b">{children}</div>
    </section>
  )
}

/** a horizontal bar: how full / how far along */
export function Meter({ value, max, tone, label, right }: { value: number; max: number; tone?: Tone; label?: ReactNode; right?: ReactNode }) {
  const p = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <div className="dmeter">
      {(label || right) && <div className="dmeter-l"><span>{label}</span><span>{right}</span></div>}
      <div className="dmeter-bar" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}><i className={tone ? 't-' + tone : ''} style={{ width: `${p * 100}%` }} /></div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) { return <div className="muted dempty">{children}</div> }

// ---------- trend helpers ----------

/** yyyy-mm-dd in local time */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** the last `days` days ending today, as yyyy-mm-dd */
export function lastDays(days: number, end = new Date()): string[] {
  return Array.from({ length: days }, (_, i) => { const d = new Date(end); d.setDate(d.getDate() - (days - 1 - i)); return ymd(d) })
}

/** short date for axis labels */
export const axisDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** straight line through the last `fit` points: how many more steps until it reaches `target` (null if it isn't heading there) */
export function projectTo(series: Pt[], target: number, fit = 14): { slope: number; hitsIn: number | null } {
  const ps = pts(series).slice(-fit)
  if (ps.length < 5) return { slope: 0, hitsIn: null }
  const mx = ps.reduce((a, p) => a + p[0], 0) / ps.length, my = ps.reduce((a, p) => a + p[1], 0) / ps.length
  const num = ps.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0), den = ps.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
  const slope = den ? num / den : 0
  const last = ps[ps.length - 1][1]
  if (!slope || (target - last) / slope <= 0) return { slope, hitsIn: null }
  return { slope, hitsIn: Math.ceil((target - last) / slope) }
}
