import { useEffect, useState } from 'react'
import type { Usage, UsageService } from './api'
import type { Ctx } from './ctx'
import { errText } from '../cult/ui'

// Usage meters for T3 and the METRC API (138). Both have 50,000 calls a month. Warnings at 70% and 90% (Compliance > Settings).
// Nothing is paused at any level yet: we're measuring first.

const n0 = (x: number) => Math.round(x).toLocaleString()
const SRC: Record<string, string> = { worker: 'Auto sends (every minute)', overnight: 'Overnight jobs', nightly: 'Nightly METRC pull', app: 'People in the app' }
const month = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleString([], { month: 'long' })
const tone = (pct: number, warn: number[]) => (pct >= (warn[1] ?? 90) ? 'bad' : pct >= (warn[0] ?? 70) ? 'warn' : 'ok')
export const warnLevels = (u: Usage | null) => (u?.warn ?? '70,90').split(',').map(Number).filter(Boolean).sort((a, b) => a - b)

export function useUsage(c: Ctx) {
  const [u, setU] = useState<Usage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = () => c.api.usage().then(x => { setU(x); setErr(null) }).catch(e => setErr(errText(e)))
  useEffect(() => { load() }, [])
  return { u, err, load }
}

function Bar({ pct, cls }: { pct: number; cls: string }) {
  const color = cls === 'bad' ? 'var(--bad)' : cls === 'warn' ? 'var(--warn)' : 'var(--brand)'
  return <div className="mbar-track" style={{ height: 10, borderRadius: 5 }}><div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, borderRadius: 5 }} /></div>
}

function Meter({ s, warn }: { s: UsageService; warn: number[] }) {
  const t = tone(s.pct, warn)
  const pt = tone(s.projected_pct, warn)
  const days = s.days.slice(-14)
  const max = Math.max(1, ...days.map(d => d.calls))
  const partial = s.counting_since > s.period
  return <div className="infobox" style={{ marginBottom: 10 }}>
    <div className="row between wrap" style={{ alignItems: 'baseline', gap: 8 }}>
      <b>{s.label}</b>
      <span className="small"><b>{n0(s.calls)}</b> of {n0(s.limit)} calls in {month(s.period)} <span className={`pill cp-${t}`}>{s.pct}%</span></span>
    </div>
    <div style={{ margin: '6px 0' }}><Bar pct={s.pct} cls={t} /></div>
    <div className="row wrap small muted" style={{ gap: 14 }}>
      <span>Today <b>{n0(s.today)}</b></span>
      <span>Average <b>{n0(s.avg_per_day)}</b>/day</span>
      <span>Month end at this pace <b style={{ color: pt === 'ok' ? undefined : pt === 'warn' ? 'var(--warn)' : 'var(--bad)' }}>{n0(s.projected)}</b> ({s.projected_pct}%)</span>
      <span>{n0(s.reads)} reads · {n0(s.writes)} writes{s.errors ? ` · ${n0(s.errors)} errors` : ''}</span>
    </div>
    {partial && <div className="muted small">Counting started {new Date(`${s.counting_since}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}, so this month is partial. The pace uses only the days counted.</div>}
    {!!Object.keys(s.by_source).length && <div className="dlist" style={{ marginTop: 6 }}>{Object.entries(s.by_source).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      <div key={k} className="drow small"><span className="grow">{SRC[k] ?? k}</span><b>{n0(v)}</b><span className="muted" style={{ width: 44, textAlign: 'right' }}>{s.calls ? Math.round(v * 100 / s.calls) : 0}%</span></div>)}</div>}
    {days.length > 1 && <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 40, marginTop: 8 }} title="Calls per day, last 14 days">
      {days.map(d => <div key={d.day} title={`${d.day}: ${n0(d.calls)} calls`} style={{ flex: 1, height: `${Math.max(4, d.calls * 100 / max)}%`, background: 'var(--line)', borderRadius: 2 }} />)}
    </div>}
    {!s.calls && <div className="muted small">No calls counted yet this month.</div>}
  </div>
}

/** Compliance > Settings: both meters, limits and warning levels */
export function UsageMeters({ c }: { c: Ctx }) {
  const { u, err, load } = useUsage(c)
  const warn = warnLevels(u)
  const [edit, setEdit] = useState(false)
  const [lim, setLim] = useState<Record<string, string>>({})
  const [w, setW] = useState('')
  useEffect(() => { if (u) { setLim(Object.fromEntries(u.services.map(s => [s.service, String(s.limit)]))); setW(u.warn ?? '70,90') } }, [u])
  async function save() {
    try {
      for (const s of u?.services ?? []) if (Number(lim[s.service]) !== s.limit) await c.api.setUsage(s.service, Number(lim[s.service]), null)
      if (w !== (u?.warn ?? '')) await c.api.setUsage(null, null, w)
      setEdit(false); await load(); c.flash('Saved')
    } catch (e) { c.flash(errText(e), true) }
  }
  return <>
    <div className="row between wrap" style={{ alignItems: 'center' }}>
      <h3 style={{ margin: '4px 0' }}>Usage this month</h3>
      <span className="row" style={{ gap: 6 }}><button className="ghost small" onClick={load}>Refresh</button>
        {c.isAdmin && <button className="ghost small" onClick={() => setEdit(!edit)}>{edit ? 'Close' : 'Limits'}</button>}</span>
    </div>
    <p className="muted small">Every call the app makes to T3 and the METRC API is counted here. Warnings at {warn.join('% and ')}%. Nothing is paused yet: we're measuring first.</p>
    {err && <p className="neg small">{/metrc_usage_now|function|schema cache/i.test(err) ? 'Run 138_metrc_route_usage.sql to turn the meters on.' : err}</p>}
    {edit && u && <div className="infobox" style={{ marginBottom: 10 }}>
      <div className="row wrap" style={{ gap: 10 }}>{u.services.map(s => <label key={s.service} className="small">{s.label} calls a month<br />
        <input type="number" min={0} value={lim[s.service] ?? ''} onChange={e => setLim({ ...lim, [s.service]: e.target.value })} style={{ width: 110 }} /></label>)}
        <label className="small">Warn at (%)<br /><input value={w} onChange={e => setW(e.target.value)} style={{ width: 90 }} /></label></div>
      <div style={{ marginTop: 8 }}><button className="primary small" onClick={save}>Save</button></div>
    </div>}
    {u?.services.map(s => <Meter key={s.service} s={s} warn={warn} />)}
  </>
}

/** a warning line for the Compliance dashboard and Review once a meter passes the first warning level */
export function UsageWarning({ c }: { c: Ctx }) {
  const { u } = useUsage(c)
  const warn = warnLevels(u)
  const hot = (u?.services ?? []).filter(s => s.pct >= (warn[0] ?? 70))
  if (!hot.length) return null
  return <div className="infobox" style={{ borderColor: 'var(--warn)', marginBottom: 12 }}>
    {hot.map(s => <div key={s.service}><span className={`pill cp-${tone(s.pct, warn)}`}>{s.pct}%</span> <b>{s.label}</b> has used {n0(s.calls)} of its {n0(s.limit)} calls this month
      <span className="muted small"> · at this pace {n0(s.projected)} by month end</span></div>)}
    {c.isAdmin && <button className="linkbtn small" onClick={() => c.go('settings')}>See usage in Settings ›</button>}
  </div>
}
