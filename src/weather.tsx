// Weather in the top bar: blended forecast for OHR (Paicines) and Watsonville (GVR + 1PN), risk flags, VPD.
// Data comes from the hourly /api/weather/refresh job (see supabase/067_weather.sql). Computer: 5 days; phone: today.
// Click / tap opens the 10-day panel with hourly detail for today and tomorrow, NWS alerts and the flag settings.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { t } from './i18n'

type WSite = { id: string; name: string; address: string | null; rules: Rules; obs_station: string | null }
type Day = { day: string; hi_f: number | null; lo_f: number | null; pop: number | null; precip_in: number | null; wind_mph: number | null; gust_mph: number | null
  rh_max: number | null; rh_min: number | null; vpd_max: number | null; vpd_min: number | null; aqi_max: number | null; icon: string | null; confidence: number | null; n_models: number | null; issued_at: string }
type Hour = { t: string; temp_f: number | null; rh: number | null; dew_f: number | null; vpd: number | null; pop: number | null; precip_in: number | null
  wind_mph: number | null; gust_mph: number | null; wind_dir: number | null; aqi: number | null; inversion: boolean | null; icon: string | null; spread_f: number | null }
type Flag = { id: number; day: string; kind: string; level: 'watch' | 'warning' | 'good'; starts: string | null; ends: string | null; why: string | null }
type Alert = { id: string; event: string | null; severity: string | null; headline: string | null; description: string | null; instruction: string | null; starts: string | null; ends: string | null }
type Rules = Record<string, Record<string, number | boolean>>

const TZ = 'America/Los_Angeles'
const KEY = 'fm.wx.site'
const stored = () => { try { return localStorage.getItem(KEY) } catch { return null } }
const store = (v: string) => { try { localStorage.setItem(KEY, v) } catch { /* private mode */ } }

// keep in step with DEFAULT_RULES in api/weather/_wx.js
export const DEFAULT_RULES: Rules = {
  botrytis: { on: true, rh: 90, dewgap: 2, tmin: 59, tmax: 77, watch_hrs: 6, warn_hrs: 10 },
  mildew: { on: true, day_tmin: 68, day_tmax: 80, rh_min: 40, rh_max: 70, day_hrs: 3, night_rh: 85, warn_days: 3 },
  rain: { on: true, watch_pop: 40, watch_in: 0.1, warn_pop: 70, warn_in: 0.25, harvest: true },
  frost: { on: true, watch: 36, warn: 32 },
  heat_crew: { on: true, watch: 80, warn: 95 },
  heat_plant: { on: true, watch: 95, warn: 100, vpd: 2.0 },
  wind: { on: true, watch: 25, warn: 35 },
  spray: { on: true, wind_min: 2, wind_max: 10, tmax: 85, dry_hrs: 24, pop_max: 30 },
  smoke: { on: true, watch: 101, warn: 151 },
  vpd: { low: 0.4, lowish: 0.8, good: 1.6, high: 2.0 },
}
const merge = (r: Rules | null | undefined): Rules => Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, v]) => [k, { ...v, ...(r?.[k] ?? {}) }]))

const FLAG_LABEL: Record<string, string> = { botrytis: 'Botrytis', mildew: 'Mildew', rain: 'Rain', frost: 'Frost', heat_crew: 'Crew heat', heat_plant: 'Plant heat',
  wind: 'Wind', smoke: 'Smoke', fire: 'Fire weather', spray: 'Spray window' }
const FLAG_ICON: Record<string, string> = { botrytis: '🍄', mildew: '🍂', rain: '🌧', frost: '❄️', heat_crew: '🥵', heat_plant: '🌡', wind: '💨', smoke: '🌫', fire: '🔥', spray: '✅' }

// ---------- formatting ----------
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'numeric', day: 'numeric' })
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const localHour = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(d)) % 24
const addDays = (day: string, n: number) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const dn = (day: string, today: string) => day === today ? t('Today') : day === addDays(today, 1) ? t('Tmrw') : t(dayFmt.format(new Date(day + 'T12:00:00Z')))
const r0 = (v: number | null | undefined) => (v == null ? '–' : Math.round(v).toString())
const ago = (iso: string | null | undefined) => {
  if (!iso) return ''
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? t('just now') : m < 60 ? t('{n} min ago', { n: m }) : t('{n} hr ago', { n: Math.round(m / 60) })
}
const compass = (d: number | null) => d == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8]

export function wxIcon(icon: string | null | undefined, night = false) {
  switch (icon) {
    case 'rain': return '🌧'
    case 'chance': return '🌦'
    case 'fog': return '🌫'
    case 'cloud': return '☁️'
    case 'partly': return night ? '☁️' : '⛅'
    default: return night ? '🌙' : '☀️'
  }
}
function vpdClass(v: number | null | undefined, b: Record<string, number | boolean>) {
  if (v == null) return ''
  if (v < (b.low as number)) return 'vpd-wet'
  if (v < (b.lowish as number)) return 'vpd-low'
  if (v <= (b.good as number)) return 'vpd-good'
  if (v <= (b.high as number)) return 'vpd-high'
  return 'vpd-stress'
}
const worst = (fs: Flag[]) => fs.some(f => f.level === 'warning') ? 'warning' : fs.some(f => f.level === 'watch') ? 'watch' : null

// ---------- data ----------
function useWeather(sb: SupabaseClient | null, siteId: string) {
  const [sites, setSites] = useState<WSite[]>([])
  const [days, setDays] = useState<Day[]>([])
  const [flags, setFlags] = useState<Flag[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [now, setNow] = useState<Hour | null>(null)
  const [lastRun, setLastRun] = useState<{ ran_at: string; ok: boolean } | null>(null)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    if (!sb) return
    const today = localDay(new Date())
    const h0 = new Date(Date.now() - 3600 * 1000).toISOString(), h1 = new Date(Date.now() + 3600 * 1000).toISOString()
    const [s, d, f, a, n, r] = await Promise.all([
      sb.from('weather_sites').select('id,name,address,rules,obs_station').eq('active', true).order('sort'),
      sb.from('weather_daily').select('*').eq('site_id', siteId).gte('day', today).order('day').limit(10),
      sb.from('weather_flags').select('id,day,kind,level,starts,ends,why').eq('site_id', siteId).gte('day', today).order('day'),
      sb.from('weather_alerts').select('*').eq('site_id', siteId),
      sb.from('weather_hourly').select('*').eq('site_id', siteId).gte('t', h0).lte('t', h1).order('t'),
      sb.from('weather_runs').select('ran_at,ok').order('ran_at', { ascending: false }).limit(1),
    ])
    if (s.error) { setMissing(true); return }
    setMissing(false)
    setSites((s.data ?? []) as WSite[])
    setDays((d.data ?? []) as Day[])
    setFlags((f.data ?? []) as Flag[])
    setAlerts(((a.data ?? []) as Alert[]).filter(x => !x.ends || Date.parse(x.ends) > Date.now()))
    const hs = (n.data ?? []) as Hour[]
    const cur = hs.filter(x => Date.parse(x.t) <= Date.now()).pop() ?? hs[0] ?? null
    setNow(cur)
    const last = (r.data?.[0] ?? null) as { ran_at: string; ok: boolean } | null
    setLastRun(last)
    return last
  }, [sb, siteId])

  useEffect(() => {
    let alive = true
    let kicked = false
    const tick = async () => {
      const last = await load()
      if (!alive) return
      // forecast more than 90 minutes old (or never run): ask the server to refresh, then reload
      const stale = !last || Date.now() - Date.parse(last.ran_at) > 90 * 60 * 1000
      if (stale && !kicked) {
        kicked = true
        try { await fetch('/api/weather/refresh') } catch { /* offline */ }
        if (alive) await load()
      }
    }
    tick()
    const iv = setInterval(tick, 15 * 60 * 1000)
    return () => { alive = false; clearInterval(iv) }
  }, [load])

  return { sites, days, flags, alerts, now, lastRun, missing, reload: load }
}

// ---------- top bar ----------
export function WeatherBar({ sb, canEdit, flash }: { sb: SupabaseClient | null; canEdit: boolean; flash: (m: string, bad?: boolean) => void }) {
  const [siteId, setSiteIdS] = useState(() => stored() ?? 'ohr')
  const setSiteId = (v: string) => { setSiteIdS(v); store(v) }
  const w = useWeather(sb, siteId)
  const [open, setOpen] = useState(false)
  if (!sb || w.missing) return null
  const today = localDay(new Date())
  const site = w.sites.find(s => s.id === siteId)
  const d0 = w.days.find(d => d.day === today) ?? w.days[0]
  if (!site || !d0) return null
  const flagsOn = (day: string) => w.flags.filter(f => f.day === day && f.level !== 'good')
  const night = (() => { const h = localHour(new Date()); return h < 7 || h >= 19 })()
  const alertN = w.alerts.length
  const label = site.id === 'wat' ? 'WAT' : site.name

  return (
    <>
      <button type="button" className="wxbar" title={t('{s} weather. Click for 10 days, flags and alerts.', { s: site.name })} onClick={() => setOpen(true)}>
        <span className="wx-site">{label}</span>
        {alertN > 0 && <span className="wx-alert" title={w.alerts.map(a => a.event).join(', ')}>⚠{alertN > 1 ? alertN : ''}</span>}
        {/* phone: today */}
        <span className="wx-today">
          <span className="wx-ic">{wxIcon(w.now?.icon ?? d0.icon, night)}</span>
          <b>{r0(w.now?.temp_f ?? d0.hi_f)}°</b>
          <span className="wx-hl">{r0(d0.hi_f)}/{r0(d0.lo_f)}</span>
          {(d0.pop ?? 0) >= 10 && <span className="wx-pop">{r0(d0.pop)}%</span>}
          {worst(flagsOn(d0.day)) && <i className={`wx-dot ${worst(flagsOn(d0.day))}`} />}
        </span>
        {/* computer: 5 days (3 on narrower screens) */}
        <span className="wx-days">
          {w.days.slice(0, 5).map((d, i) => {
            const lv = worst(flagsOn(d.day))
            return (
              <span key={d.day} className={`wx-day i${i}`}>
                <span className="wx-dn">{dn(d.day, today)}</span>
                <span className="wx-ic">{wxIcon(d.icon)}</span>
                <span className="wx-t"><b>{r0(d.hi_f)}°</b><span className="wx-lo">{r0(d.lo_f)}°</span></span>
                <span className={`wx-pop ${(d.pop ?? 0) < 10 ? 'none' : ''}`}>{(d.pop ?? 0) >= 10 ? `${r0(d.pop)}%` : '·'}</span>
                {lv && <i className={`wx-dot ${lv}`} />}
              </span>
            )
          })}
        </span>
      </button>
      {open && <WeatherPanel sb={sb} w={w} siteId={siteId} setSiteId={setSiteId} canEdit={canEdit} flash={flash} onClose={() => setOpen(false)} />}
    </>
  )
}

// ---------- 10-day panel ----------
function WeatherPanel({ sb, w, siteId, setSiteId, canEdit, flash, onClose }: {
  sb: SupabaseClient; w: ReturnType<typeof useWeather>; siteId: string; setSiteId: (v: string) => void; canEdit: boolean
  flash: (m: string, bad?: boolean) => void; onClose: () => void
}) {
  const today = localDay(new Date())
  const [hours, setHours] = useState<Hour[]>([])
  const [hDay, setHDay] = useState(0)
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [openAlert, setOpenAlert] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const site = w.sites.find(s => s.id === siteId)
  const rules = useMemo(() => merge(site?.rules), [site])

  useEffect(() => {
    let alive = true
    const from = new Date(Date.now() - 3600 * 1000).toISOString()
    const to = new Date(Date.parse(addDays(today, 2) + 'T12:00:00Z')).toISOString()
    sb.from('weather_hourly').select('*').eq('site_id', siteId).gte('t', from).lt('t', to).order('t')
      .then(({ data }) => { if (alive) setHours((data ?? []) as Hour[]) })
    return () => { alive = false }
  }, [sb, siteId, w.lastRun?.ran_at, today])

  // first tab: the next 24 hours from now; second: tomorrow (midnight to midnight)
  const hShown = hDay === 0
    ? hours.filter(h => Date.parse(h.t) + 3600 * 1000 > Date.now() && Date.parse(h.t) < Date.now() + 24 * 3600 * 1000)
    : hours.filter(h => localDay(new Date(h.t)) === addDays(today, 1))
  const spray = w.flags.filter(f => f.kind === 'spray' && f.starts && f.ends)
  const inSpray = (h: Hour) => spray.some(f => Date.parse(h.t) >= Date.parse(f.starts!) && Date.parse(h.t) < Date.parse(f.ends!))
  const issued = w.days[0]?.issued_at

  return (
    <div className="scrim wxscrim" onClick={onClose}>
      <div className="sheet wxpanel" onClick={e => e.stopPropagation()} role="dialog" aria-label={t('Weather')}>
        <div className="sheet-h">
          <div>
            <h2 style={{ margin: 0 }}>{t('Weather')}</h2>
            <div className="muted">{t('Blend of NWS, ECMWF, GFS, HRRR, NBM, Canada and Germany models')}{issued ? ` · ${t('updated {a}', { a: ago(w.lastRun?.ran_at ?? issued) })}` : ''}</div>
          </div>
          <button className="ghost" aria-label={t('Close')} onClick={onClose}>✕</button>
        </div>

        <div className="wx-top">
          <div className="seg">
            {w.sites.map(s => <button key={s.id} className={s.id === siteId ? 'on' : ''} onClick={() => setSiteId(s.id)}>{s.name}</button>)}
          </div>
          {site?.address && <span className="muted wx-addr">{site.address}</span>}
        </div>

        {w.alerts.length > 0 && <div className="wx-alerts">
          {w.alerts.map(a => (
            <div key={a.id} className={`warnbox wx-alertbox ${/warning/i.test(a.event ?? '') ? 'bad' : ''}`} onClick={() => setOpenAlert(openAlert === a.id ? null : a.id)}>
              <b>⚠ {a.event}</b>{a.ends && <span className="muted"> · {t('until {d}', { d: `${t(dayFmt.format(new Date(a.ends)))} ${timeFmt.format(new Date(a.ends))}` })}</span>}
              {openAlert === a.id ? <div className="wx-alerttext">{a.headline && <p><b>{a.headline}</b></p>}<p>{a.description}</p>{a.instruction && <p>{a.instruction}</p>}</div>
                : <div className="muted">{t('Tap for details')}</div>}
            </div>
          ))}
        </div>}

        {/* hourly: today / tomorrow */}
        <div className="wx-hhead">
          <div className="seg small-seg">
            <button className={hDay === 0 ? 'on' : ''} onClick={() => setHDay(0)}>{t('Next 24 hrs')}</button>
            <button className={hDay === 1 ? 'on' : ''} onClick={() => setHDay(1)}>{t('Tomorrow')}</button>
          </div>
          <span className="muted">{t('Green = spray window')}</span>
        </div>
        <div className="wx-hours">
          {hShown.length === 0 && <div className="muted">{t('No hourly data yet.')}</div>}
          {hShown.map(h => {
            const d = new Date(h.t), hr = localHour(d)
            return (
              <div key={h.t} className={`wx-h ${inSpray(h) ? 'spray' : ''}`}>
                <div className="wx-hh">{hourFmt.format(d).replace(' ', '').toLowerCase()}</div>
                <div className="wx-ic">{wxIcon(h.icon, hr < 7 || hr >= 19)}</div>
                <div className="wx-ht">{r0(h.temp_f)}°</div>
                <div className="wx-hp">{(h.pop ?? 0) >= 10 ? `${r0(h.pop)}%` : ''}</div>
                <div className="wx-hw" title={`${t('Wind / gusts, mph')} ${compass(h.wind_dir)}`}>{r0(h.wind_mph)}{h.gust_mph != null && h.gust_mph > (h.wind_mph ?? 0) + 4 ? `g${r0(h.gust_mph)}` : ''}</div>
                <div className="wx-hr">{r0(h.rh)}%</div>
                <div className={`wx-hv ${vpdClass(h.vpd, rules.vpd)}`} title="VPD kPa">{h.vpd == null ? '–' : h.vpd.toFixed(1)}</div>
              </div>
            )
          })}
        </div>
        <div className="wx-hlegend muted">{t('Rows: rain chance · wind (g = gusts, mph) · humidity · VPD kPa')}</div>

        {/* 10 days */}
        <div className="wx-list">
          {w.days.map((d, i) => {
            const fs = w.flags.filter(f => f.day === d.day)
            const isOpen = openDay === d.day
            return (
              <div key={d.day} className={`wx-row ${i >= 7 ? 'far' : ''} ${isOpen ? 'open' : ''}`} onClick={() => setOpenDay(isOpen ? null : d.day)}>
                <div className="wx-r1">
                  <div className="wx-rd"><b>{dn(d.day, today)}</b><span className="muted"> {dateFmt.format(new Date(d.day + 'T12:00:00Z'))}</span></div>
                  <div className="wx-ic big">{wxIcon(d.icon)}</div>
                  <div className="wx-rt"><b>{r0(d.hi_f)}°</b> <span className="muted">{r0(d.lo_f)}°</span></div>
                  <div className="wx-rp">{(d.pop ?? 0) >= 10 ? <>{r0(d.pop)}%{(d.precip_in ?? 0) >= 0.01 && <span className="muted"> {d.precip_in!.toFixed(2)}"</span>}</> : <span className="muted">–</span>}</div>
                  <div className="wx-rw">💨 {r0(d.wind_mph)}{d.gust_mph != null ? <span className="muted">/{r0(d.gust_mph)}</span> : null}</div>
                  <div className="wx-rv">
                    <span className={`vpdchip ${vpdClass(d.vpd_max, rules.vpd)}`} title={t('Peak VPD (afternoon), kPa')}>{d.vpd_max?.toFixed(1) ?? '–'}</span>
                    <span className={`vpdchip ${vpdClass(d.vpd_min, rules.vpd)}`} title={t('Lowest VPD (overnight), kPa')}>{d.vpd_min?.toFixed(1) ?? '–'}</span>
                  </div>
                  <div className="wx-rc" title={t('Confidence: how much the models agree ({n} models)', { n: d.n_models ?? 0 })}>
                    <span className="wx-conf"><span style={{ width: `${d.confidence ?? 0}%` }} className={(d.confidence ?? 0) >= 70 ? 'hi' : (d.confidence ?? 0) >= 45 ? 'mid' : 'lo'} /></span>
                  </div>
                </div>
                {fs.length > 0 && <div className="wx-flags">
                  {fs.map(f => <span key={f.id} className={`wx-flag ${f.level}`}>{FLAG_ICON[f.kind] ?? '•'} {t(FLAG_LABEL[f.kind] ?? f.kind)}{f.level === 'warning' ? '!' : ''}</span>)}
                </div>}
                {isOpen && <div className="wx-more">
                  <div className="muted">{t('Humidity {a}-{b}%', { a: r0(d.rh_min), b: r0(d.rh_max) })} · VPD {d.vpd_min?.toFixed(2)}-{d.vpd_max?.toFixed(2)} kPa{d.aqi_max != null ? ` · AQI ${r0(d.aqi_max)}` : ''} · {t('Confidence {c}%', { c: d.confidence ?? 0 })}</div>
                  {fs.map(f => <div key={f.id} className={`wx-why ${f.level}`}>{FLAG_ICON[f.kind]} <b>{t(FLAG_LABEL[f.kind] ?? f.kind)}</b> {f.level === 'good' ? '' : `(${t(f.level)})`}: {f.why}</div>)}
                  {fs.length === 0 && <div className="muted">{t('No flags this day.')}</div>}
                </div>}
              </div>
            )
          })}
        </div>
        <div className="wx-foot muted">
          <span>{t('VPD')}: <span className="vpdchip vpd-wet">&lt;{String(rules.vpd.low)}</span> <span className="vpdchip vpd-low">{t('low')}</span> <span className="vpdchip vpd-good">{t('good')}</span> <span className="vpdchip vpd-high">{t('high')}</span> <span className="vpdchip vpd-stress">&gt;{String(rules.vpd.high)}</span></span>
          <span>{t('Days 8-10 are faded: treat them as a rough guess.')}</span>
          {canEdit && <button className="ghost small" onClick={() => setEditing(true)}>{t('Flag settings')}</button>}
        </div>
        {editing && site && <RulesEditor sb={sb} site={site} flash={flash} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); w.reload() }} />}
      </div>
    </div>
  )
}

// ---------- flag settings (Owners + Production Admins) ----------
const FIELDS: Record<string, [string, string][]> = {
  botrytis: [['rh', 'Humidity % at or above'], ['dewgap', 'or dew point within °F'], ['tmin', 'Temp from °F'], ['tmax', 'Temp to °F'], ['watch_hrs', 'Watch: hours in a row'], ['warn_hrs', 'Warning: hours in a row']],
  mildew: [['day_tmin', 'Day temp from °F'], ['day_tmax', 'Day temp to °F'], ['rh_min', 'Day humidity from %'], ['rh_max', 'Day humidity to %'], ['day_hrs', 'Warm hours needed'], ['night_rh', 'Night humidity % at or above'], ['warn_days', 'Warning: days in a row']],
  rain: [['watch_pop', 'Watch: chance %'], ['watch_in', 'Watch: inches'], ['warn_pop', 'Warning: chance %'], ['warn_in', 'Warning: inches']],
  frost: [['watch', 'Watch: low °F or below'], ['warn', 'Warning: low °F or below']],
  heat_crew: [['watch', 'Watch: high °F (shade)'], ['warn', 'Warning: high °F (high heat)']],
  heat_plant: [['watch', 'Watch: high °F'], ['warn', 'Warning: high °F'], ['vpd', 'Watch: VPD kPa or above']],
  wind: [['watch', 'Watch: gusts mph'], ['warn', 'Warning: gusts mph']],
  spray: [['wind_min', 'Wind from mph'], ['wind_max', 'Wind to mph'], ['tmax', 'Below °F'], ['dry_hrs', 'Dry for hours after'], ['pop_max', 'Max rain chance %']],
  smoke: [['watch', 'Watch: AQI'], ['warn', 'Warning: AQI']],
  vpd: [['low', 'Too wet below kPa'], ['lowish', 'Low below kPa'], ['good', 'Good up to kPa'], ['high', 'High up to kPa (above = stress)']],
}

function RulesEditor({ sb, site, flash, onClose, onSaved }: { sb: SupabaseClient; site: WSite; flash: (m: string, bad?: boolean) => void; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<Rules>(() => merge(site.rules))
  const [busy, setBusy] = useState(false)
  const set = (k: string, f: string, v: number | boolean) => setR(x => ({ ...x, [k]: { ...x[k], [f]: v } }))
  const save = async () => {
    setBusy(true)
    const { error } = await sb.rpc('weather_save_rules', { p_site: site.id, p_rules: r })
    setBusy(false)
    if (error) { flash(error.message, true); return }
    flash(t('Saved. Flags update on the next hourly refresh.'))
    onSaved()
  }
  return (
    <div className="scrim" onClick={e => { e.stopPropagation(); onClose() }}>
      <div className="sheet form wide wxrules" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><div><h2 style={{ margin: 0 }}>{t('Flag settings: {s}', { s: site.name })}</h2><div className="muted">{t('Each site has its own. Changes apply on the next hourly refresh.')}</div></div>
          <button className="ghost" onClick={onClose}>✕</button></div>
        {Object.keys(FIELDS).map(k => (
          <fieldset key={k} className={`wx-rule ${k !== 'vpd' && !r[k].on ? 'off' : ''}`}>
            <legend>
              {k !== 'vpd' ? <label><input type="checkbox" checked={!!r[k].on} onChange={e => set(k, 'on', e.target.checked)} /> {FLAG_ICON[k]} {t(FLAG_LABEL[k])}</label> : <b>{t('VPD colors')}</b>}
            </legend>
            <div className="wx-rgrid">
              {FIELDS[k].map(([f, l]) => (
                <label key={f}><span className="muted">{t(l)}</span>
                  <input type="number" step="any" inputMode="decimal" value={String(r[k][f] ?? '')} disabled={k !== 'vpd' && !r[k].on}
                    onChange={e => set(k, f, e.target.value === '' ? (DEFAULT_RULES[k][f] as number) : Number(e.target.value))} /></label>
              ))}
              {k === 'rain' && <label className="small-check"><input type="checkbox" checked={!!r.rain.harvest} onChange={e => set('rain', 'harvest', e.target.checked)} /> {t('Any rain watch on a scheduled harvest day becomes a warning')}</label>}
            </div>
          </fieldset>
        ))}
        <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
          <button className="ghost" onClick={() => setR(merge(site.id === 'ohr' ? { botrytis: { on: false } } : {}))}>{t('Back to defaults')}</button>
          <button disabled={busy} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </div>
    </div>
  )
}
