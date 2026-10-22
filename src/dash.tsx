import type { ReactNode } from 'react'

// Shared dashboard pieces: big-number tiles, cards, meters. Every module's Dashboard is built from these.

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | undefined

export function DashHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="dhead">
      <div><h2>{title}</h2>{sub && <div className="muted">{sub}</div>}</div>
      {right && <div className="row">{right}</div>}
    </div>
  )
}

export function Tiles({ children }: { children: ReactNode }) { return <div className="dtiles">{children}</div> }

/** one number that matters, with what it means and where to go about it */
export function Tile({ value, label, sub, tone, onClick }: { value: ReactNode; label: ReactNode; sub?: ReactNode; tone?: Tone; onClick?: () => void }) {
  const body = <><span className="dt-l">{label}</span><b className="dt-v">{value}</b>{sub != null && sub !== '' && <span className="dt-s">{sub}</span>}</>
  return onClick
    ? <button className={`dtile ${tone ? 't-' + tone : ''} click`} onClick={onClick}>{body}<span className="dt-go" aria-hidden="true">›</span></button>
    : <div className={`dtile ${tone ? 't-' + tone : ''}`}>{body}</div>
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
