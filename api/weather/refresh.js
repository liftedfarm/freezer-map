// Hourly weather refresh (vercel.json cron). Pulls NWS + Open-Meteo models for each weather site, blends them,
// works out VPD + risk flags, and saves everything for the app's top bar. Needs SUPABASE_SERVICE_ROLE_KEY (already set
// for QuickBooks). The cron sends CRON_SECRET when that's set; anyone else can only trigger a refresh when the last one
// is more than 20 minutes old (the app does this itself if the forecast is stale). It only reads public weather data.
import { OM_MODELS, OM_VARS, TZ, addDays, blendDaily, blendHourly, computeFlags, hourlyRow, local, mergeRules,
  parseAlerts, parseAqi, parseNwsHourly, parseObs, parseOpenMeteo, snapshotOf } from './_wx.js'

export const config = { maxDuration: 60 }

const SB = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const UA = 'LiftedFarmsOps/1.0 (freezer-map-8i3h.vercel.app)'
const headers = () => SERVICE.startsWith('sb_')
  ? { apikey: SERVICE, 'Content-Type': 'application/json' }
  : { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }

async function db(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
const upsert = (table, rows, onConflict) => rows.length
  ? db(`${table}?on_conflict=${onConflict}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) })
  : null
const insert = (table, rows) => rows.length ? db(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) }) : null
const del = path => db(path, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })

async function getJson(url, nws = false) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20000)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: nws ? { 'User-Agent': UA, Accept: 'application/geo+json' } : { 'User-Agent': UA } })
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
    return await r.json()
  } finally { clearTimeout(timer) }
}

const send = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)) }

async function refreshSite(site, nowSec, harvests, snapDue) {
  const status = {}
  const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lon}&hourly=${OM_VARS.join(',')}` +
    `&models=${Object.values(OM_MODELS).join(',')}&forecast_days=11&past_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timeformat=unixtime`
  const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${site.lat}&longitude=${site.lon}&hourly=us_aqi&timeformat=unixtime&forecast_days=5`

  // NWS grid point (looked up once, then kept)
  let grid = site.nws_office && site.nws_x != null ? { office: site.nws_office, x: site.nws_x, y: site.nws_y } : null
  if (!grid) {
    try {
      const p = await getJson(`https://api.weather.gov/points/${site.lat},${site.lon}`, true)
      grid = { office: p.properties.gridId, x: p.properties.gridX, y: p.properties.gridY }
      await db(`weather_sites?id=eq.${site.id}`, { method: 'PATCH', body: JSON.stringify({ nws_office: grid.office, nws_x: grid.x, nws_y: grid.y }) })
    } catch (e) { status.nws_points = String(e.message || e) }
  }

  const [om, aq, nws, alerts, obs] = await Promise.allSettled([
    getJson(omUrl),
    getJson(aqUrl),
    grid ? getJson(`https://api.weather.gov/gridpoints/${grid.office}/${grid.x},${grid.y}/forecast/hourly`, true) : Promise.reject(new Error('no grid')),
    getJson(`https://api.weather.gov/alerts/active?point=${site.lat},${site.lon}`, true),
    site.obs_station ? getJson(`https://api.weather.gov/stations/${site.obs_station}/observations?limit=12`, true) : Promise.resolve(null),
  ])

  const sources = {}
  if (om.status === 'fulfilled') {
    try { Object.assign(sources, parseOpenMeteo(om.value)); for (const k of Object.keys(OM_MODELS)) status[k] = sources[k] ? 'ok' : 'missing' }
    catch (e) { status.open_meteo = String(e.message || e) }
  } else status.open_meteo = String(om.reason?.message || om.reason)
  if (nws.status === 'fulfilled') { try { sources.nws = parseNwsHourly(nws.value); status.nws = 'ok' } catch (e) { status.nws = String(e.message || e) } }
  else status.nws = String(nws.reason?.message || nws.reason)
  const aqi = aq.status === 'fulfilled' ? parseAqi(aq.value) : new Map()
  status.aqi = aq.status === 'fulfilled' ? 'ok' : String(aq.reason?.message || aq.reason)
  const al = alerts.status === 'fulfilled' ? parseAlerts(alerts.value) : null
  status.alerts = al ? 'ok' : String(alerts.reason?.message || alerts.reason)

  if (!Object.keys(sources).length) throw new Error(`${site.name}: no forecast sources answered`)

  const issued = new Date(nowSec * 1000).toISOString()
  const hourly = blendHourly(sources, aqi, nowSec)
  const daily = blendDaily(sources, hourly, nowSec, 10)
  const rules = mergeRules(site.rules)
  const myHarvests = harvests.filter(h => (site.app_sites ?? []).includes(h.site))
  const flags = computeFlags(hourly, daily, rules, myHarvests, al ?? [], nowSec)

  // save: hourly from the start of today, daily for 10 days, then alerts and flags (replaced)
  await upsert('weather_hourly', hourly.map(h => hourlyRow(site.id, h, issued)), 'site_id,t')
  await upsert('weather_daily', daily.map(d => ({ site_id: site.id, ...d, issued_at: issued })), 'site_id,day')
  const today = local(nowSec).day
  await del(`weather_hourly?site_id=eq.${site.id}&t=lt.${encodeURIComponent(new Date((nowSec - 8 * 86400) * 1000).toISOString())}`)
  await del(`weather_daily?site_id=eq.${site.id}&day=lt.${addDays(today, -8)}`)
  if (al) {
    await del(`weather_alerts?site_id=eq.${site.id}`)
    await insert('weather_alerts', al.map(a => ({ site_id: site.id, ...a })))
  }
  await del(`weather_flags?site_id=eq.${site.id}`)
  await insert('weather_flags', flags.map(f => ({ site_id: site.id, starts: null, ends: null, detail: null, ...f })))

  // scoring history: raw sources about every 6 hours, observed weather every run
  if (snapDue) {
    const rows = Object.entries(sources).map(([src, s]) => ({ site_id: site.id, source: src, issued_at: issued, data: snapshotOf(s, nowSec - 3600) })).filter(r => r.data)
    await upsert('weather_snapshots', rows, 'site_id,source,issued_at')
  }
  if (obs.status === 'fulfilled' && obs.value) {
    await upsert('weather_obs', parseObs(obs.value, site.obs_station, site.id), 'station,t')
    status.obs = 'ok'
  } else if (obs.status === 'rejected') status.obs = String(obs.reason?.message || obs.reason)

  return { status, hours: hourly.length, days: daily.length, flags: flags.length, models: Object.keys(sources) }
}

export default async function handler(req, res) {
  if (!SB || !SERVICE) return send(res, 200, { skipped: 'SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_URL not set' })
  const started = Date.now()
  const secret = process.env.CRON_SECRET
  const isCron = !!secret && req.headers.authorization === `Bearer ${secret}`
  try {
    const last = await db('weather_runs?select=ran_at,ok&order=ran_at.desc&limit=1')
    const lastAt = last?.[0] ? Date.parse(last[0].ran_at) : 0
    // flag settings saved since the last run: recompute right away (the app calls this after a save)
    const edited = await db('weather_sites?select=updated_at&order=updated_at.desc&limit=1').catch(() => [])
    const rulesChanged = edited?.[0] && Date.parse(edited[0].updated_at) > lastAt
    if (!isCron && !rulesChanged && Date.now() - lastAt < 20 * 60 * 1000) return send(res, 200, { skipped: 'fresh', last: last[0]?.ran_at })
    if (isCron && Date.now() - lastAt < 4 * 60 * 1000) return send(res, 200, { skipped: 'just ran', last: last[0]?.ran_at })

    const nowSec = Math.floor(Date.now() / 1000)
    const sites = await db('weather_sites?active=eq.true&select=*&order=sort')
    const today = local(nowSec).day
    const harvests = await db(`cult_harvests?select=id,site,strain,kind,planned_on&status=eq.planned&planned_on=gte.${today}&planned_on=lte.${addDays(today, 10)}`).catch(() => [])
    const snaps = await db('weather_snapshots?select=issued_at&order=issued_at.desc&limit=1').catch(() => [])
    const snapDue = !snaps?.[0] || Date.now() - Date.parse(snaps[0].issued_at) > 5.75 * 3600 * 1000

    const results = {}, errors = []
    for (const s of sites) {
      try { results[s.id] = await refreshSite(s, nowSec, harvests ?? [], snapDue) }
      catch (e) { errors.push(String(e.message || e)); results[s.id] = { error: String(e.message || e) } }
    }
    const ok = errors.length === 0
    await insert('weather_runs', [{ ok, sources: results, error: errors.join(' | ') || null, ms: Date.now() - started }])
    await del(`weather_runs?ran_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 86400 * 1000).toISOString())}`).catch(() => {})
    return send(res, ok ? 200 : 500, { ok, tz: TZ, results, ms: Date.now() - started })
  } catch (e) {
    try { await insert('weather_runs', [{ ok: false, error: String(e.message || e).slice(0, 500), ms: Date.now() - started }]) } catch { /* table missing */ }
    return send(res, 500, { error: String(e.message || e) })
  }
}
