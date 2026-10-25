// Weather: parse sources, blend them into one "most likely" forecast, VPD, daily summary and risk flags.
// Pure functions only (no network) so they can be tested. The refresh job (refresh.js) does the fetching and saving.

export const TZ = 'America/Los_Angeles'
export const OM_MODELS = { ecmwf: 'ecmwf_ifs', gfs: 'gfs_seamless', hrrr: 'ncep_hrrr_conus', nbm: 'ncep_nbm_conus', gem: 'gem_seamless', icon: 'icon_seamless' }
export const OM_VARS = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation_probability', 'precipitation',
  'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'cloud_cover', 'temperature_925hPa']
const OM_KEY = { temperature_2m: 'temp_f', relative_humidity_2m: 'rh', dew_point_2m: 'dew_f', precipitation_probability: 'pop', precipitation: 'precip_in',
  wind_speed_10m: 'wind_mph', wind_gusts_10m: 'gust_mph', wind_direction_10m: 'wind_dir', cloud_cover: 'cloud', temperature_925hPa: 't925_f' }
export const FIELDS = ['temp_f', 'rh', 'dew_f', 'pop', 'precip_in', 'wind_mph', 'gust_mph', 'wind_dir', 'cloud', 't925_f']

// ---------- default flag rules (a site's rules override these key by key) ----------
export const DEFAULT_RULES = {
  botrytis:   { on: true, rh: 90, dewgap: 2, tmin: 59, tmax: 77, watch_hrs: 6, warn_hrs: 10 },
  mildew:     { on: true, day_tmin: 68, day_tmax: 80, rh_min: 40, rh_max: 70, day_hrs: 3, night_rh: 85, warn_days: 3 },
  rain:       { on: true, watch_pop: 40, watch_in: 0.1, warn_pop: 70, warn_in: 0.25, harvest: true },
  frost:      { on: true, watch: 36, warn: 32 },
  heat_crew:  { on: true, watch: 80, warn: 95 },
  heat_plant: { on: true, watch: 95, warn: 100, vpd: 2.0 },
  wind:       { on: true, watch: 25, warn: 35 },
  spray:      { on: true, wind_min: 2, wind_max: 10, tmax: 85, dry_hrs: 24, pop_max: 30 },
  smoke:      { on: true, watch: 101, warn: 151 },
  vpd:        { low: 0.4, lowish: 0.8, good: 1.6, high: 2.0 },
}
export function mergeRules(r) {
  const out = {}
  for (const k of Object.keys(DEFAULT_RULES)) out[k] = { ...DEFAULT_RULES[k], ...((r && typeof r[k] === 'object') ? r[k] : {}) }
  return out
}

// ---------- time helpers (Pacific local day / hour) ----------
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
export function local(tSec) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(tSec * 1000)).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }
}
export const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// ---------- parsing ----------
/** Open-Meteo multi-model response -> { ecmwf: {t:[sec], temp_f:[], ...}, gfs: ... } */
export function parseOpenMeteo(d) {
  const h = d?.hourly
  if (!h?.time) throw new Error('Open-Meteo: no hourly data')
  const out = {}
  for (const [src, model] of Object.entries(OM_MODELS)) {
    const s = { t: h.time }
    let any = false
    for (const v of OM_VARS) {
      const arr = h[`${v}_${model}`] ?? (Object.keys(OM_MODELS).length === 1 ? h[v] : undefined)
      s[OM_KEY[v]] = arr ? arr.map(x => (x == null ? null : Number(x))) : h.time.map(() => null)
      if (v === 'temperature_2m' && arr && arr.some(x => x != null)) any = true
    }
    if (!any) continue
    // HRRR's rain chance on Open-Meteo is borrowed from another model; don't count it twice
    if (src === 'hrrr') s.pop = s.pop.map(() => null)
    // a model's values only count where it has a temperature (Open-Meteo pads short-range models)
    for (const f of FIELDS) if (f !== 'temp_f') s[f] = s[f].map((x, i) => (s.temp_f[i] == null ? null : x))
    out[src] = s
  }
  return out
}

const mph = s => { const n = String(s ?? '').match(/\d+(\.\d+)?/g); return n ? Math.max(...n.map(Number)) : null }
const cToF = c => (c == null ? null : c * 9 / 5 + 32)
/** NWS gridpoint hourly forecast -> a source */
export function parseNwsHourly(d) {
  const ps = d?.properties?.periods
  if (!ps?.length) throw new Error('NWS: no periods')
  const s = { t: [] }
  for (const f of FIELDS) s[f] = []
  for (const p of ps) {
    s.t.push(Math.round(Date.parse(p.startTime) / 1000))
    const tf = p.temperatureUnit === 'C' ? cToF(p.temperature) : p.temperature
    s.temp_f.push(tf ?? null)
    s.rh.push(p.relativeHumidity?.value ?? null)
    s.dew_f.push(cToF(p.dewpoint?.value ?? null))
    s.pop.push(p.probabilityOfPrecipitation?.value ?? 0)
    s.precip_in.push(null)
    s.wind_mph.push(mph(p.windSpeed))
    s.gust_mph.push(null)
    s.wind_dir.push(null)
    s.cloud.push(null)
    s.t925_f.push(null)
  }
  return s
}

export function parseAlerts(d) {
  return (d?.features ?? []).map(f => {
    const p = f.properties ?? {}
    return { id: String(p.id ?? f.id), event: p.event ?? null, severity: p.severity ?? null, headline: p.headline ?? null,
      description: (p.description ?? '').slice(0, 4000) || null, instruction: (p.instruction ?? '').slice(0, 2000) || null,
      starts: p.onset ?? p.effective ?? null, ends: p.ends ?? p.expires ?? null }
  })
}

export function parseObs(d, station, siteId) {
  const out = []
  for (const f of d?.features ?? []) {
    const p = f.properties ?? {}
    if (!p.timestamp) continue
    const kmh = v => (v == null ? null : Math.round(v * 0.621371 * 10) / 10)
    out.push({ station, site_id: siteId, t: p.timestamp,
      temp_f: r1(cToF(p.temperature?.value ?? null)), rh: r1(p.relativeHumidity?.value ?? null), dew_f: r1(cToF(p.dewpoint?.value ?? null)),
      precip_in: p.precipitationLastHour?.value == null ? null : Math.round(p.precipitationLastHour.value / 25.4 * 100) / 100,
      wind_mph: kmh(p.windSpeed?.value ?? null), gust_mph: kmh(p.windGust?.value ?? null) })
  }
  return out
}

/** Open-Meteo air quality -> Map(sec -> us_aqi) */
export function parseAqi(d) {
  const m = new Map()
  const h = d?.hourly
  if (h?.time) h.time.forEach((t, i) => { if (h.us_aqi?.[i] != null) m.set(t, h.us_aqi[i]) })
  return m
}

// ---------- blend ----------
/** how much each source counts, by how far ahead (hours) */
export function weight(src, leadH) {
  const L = Math.max(0, leadH)
  switch (src) {
    case 'hrrr': return L <= 18 ? 4 : L <= 48 ? 2.5 : 0
    case 'nbm': return 2.5
    case 'nws': return L <= 48 ? 2.5 : 2
    case 'ecmwf': return L <= 48 ? 2 : 3
    case 'gfs': return 1
    case 'gem': return L <= 48 ? 0.5 : 1
    case 'icon': return L <= 48 ? 0.5 : 0.8
    default: return 1
  }
}

export const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10)
const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100)

/** VPD in kPa from air temp (F) and RH (%) */
export function vpd(tempF, rh) {
  if (tempF == null || rh == null) return null
  const c = (tempF - 32) * 5 / 9
  const es = 0.6108 * Math.exp(17.27 * c / (c + 237.3))
  return Math.max(0, es * (1 - Math.min(100, rh) / 100))
}
function dewF(tempF, rh) {
  if (tempF == null || rh == null || rh <= 0) return null
  const c = (tempF - 32) * 5 / 9, a = 17.27, b = 237.3
  const g = Math.log(rh / 100) + a * c / (b + c)
  return (b * g / (a - g)) * 9 / 5 + 32
}

function wmean(pairs) {
  let s = 0, w = 0
  for (const [v, k] of pairs) if (v != null && k > 0) { s += v * k; w += k }
  return w > 0 ? s / w : null
}
function sd(vals) {
  const v = vals.filter(x => x != null)
  if (v.length < 2) return 0
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
}

export function hourIcon(h) {
  if ((h.precip_in ?? 0) >= 0.02 && (h.pop ?? 0) >= 40) return 'rain'
  if ((h.pop ?? 0) >= 60) return 'rain'
  if ((h.rh ?? 0) >= 96 && (h.wind_mph ?? 99) < 7) return 'fog'
  const c = h.cloud
  if (c == null) return (h.pop ?? 0) >= 30 ? 'cloud' : 'clear'
  return c >= 75 ? 'cloud' : c >= 35 ? 'partly' : 'clear'
}

/**
 * sources: { ecmwf: {t,temp_f,...}, nws: {...}, ... }, aqi: Map, nowSec
 * -> hourly rows (from the start of today, Pacific), each with the blended values
 */
export function blendHourly(sources, aqi, nowSec) {
  const today = local(nowSec).day
  const idx = {}
  for (const [k, s] of Object.entries(sources)) idx[k] = new Map(s.t.map((t, i) => [t - (t % 3600), i]))
  const allT = new Set()
  for (const s of Object.values(sources)) for (const t of s.t) allT.add(t - (t % 3600))
  const rows = []
  for (const t of [...allT].sort((a, b) => a - b)) {
    const L = local(t)
    if (L.day < today) continue
    const lead = (t - nowSec) / 3600
    const get = f => Object.keys(sources).map(k => { const i = idx[k].get(t); return [i == null ? null : sources[k][f][i], weight(k, lead), k] })
    const temps = get('temp_f')
    const n = temps.filter(([v, w]) => v != null && w > 0).length
    if (!n) continue
    const temp = wmean(temps)
    const rh = wmean(get('rh'))
    const row = {
      t, day: L.day, hour: L.hour,
      temp_f: temp, rh, pop: wmean(get('pop')), precip_in: wmean(get('precip_in')),
      wind_mph: wmean(get('wind_mph')), gust_mph: wmean(get('gust_mph')), cloud: wmean(get('cloud')),
      n_models: n, spread_f: sd(temps.filter(([, w]) => w > 0).map(([v]) => v)),
    }
    // wind direction: the most trusted model that has one
    const dirs = get('wind_dir').filter(([v, w]) => v != null && w > 0).sort((a, b) => b[1] - a[1])
    row.wind_dir = dirs[0]?.[0] ?? null
    // inversion: the air ~2,500 ft up is warmer than at the ground (GFS / ECMWF)
    const t925 = get('t925_f').filter(([v]) => v != null)
    row.inversion = t925.length && temp != null ? wmean(t925.map(([v]) => [v, 1])) > temp + 1 : null
    row.dew_f = dewF(temp, rh)
    row.vpd = vpd(temp, rh)
    row.aqi = aqi?.get(t) ?? null
    row.icon = hourIcon(row)
    rows.push(row)
  }
  return rows
}

/** daily summary, 10 days from today. Highs/lows come from each model's own daily high/low, then blended. */
export function blendDaily(sources, hourly, nowSec, days = 10) {
  const today = local(nowSec).day
  const perModel = {}
  for (const [k, s] of Object.entries(sources)) {
    const m = new Map()
    s.t.forEach((t, i) => {
      const v = s.temp_f[i]; if (v == null) return
      const d = local(t).day
      const e = m.get(d) ?? { hi: -999, lo: 999, n: 0, pop: null }
      e.hi = Math.max(e.hi, v); e.lo = Math.min(e.lo, v); e.n++
      if (s.pop[i] != null) e.pop = Math.max(e.pop ?? 0, s.pop[i])
      m.set(d, e)
    })
    perModel[k] = m
  }
  const out = []
  for (let i = 0; i < days; i++) {
    const day = addDays(today, i)
    const hs = hourly.filter(h => h.day === day)
    if (!hs.length) continue
    const lead = i * 24 + 12 - (local(nowSec).hour)
    // only models covering most of the day count for highs/lows (today: whatever is left of it)
    const need = i === 0 ? Math.min(hs.length, 6) : 20
    const full = Object.keys(perModel).filter(k => (perModel[k].get(day)?.n ?? 0) >= need && weight(k, lead) > 0)
    const use = full.length ? full : Object.keys(perModel).filter(k => perModel[k].get(day))
    const hi = wmean(use.map(k => [perModel[k].get(day)?.hi, weight(k, lead)]))
    const lo = wmean(use.map(k => [perModel[k].get(day)?.lo, weight(k, lead)]))
    const max = f => { const v = hs.map(h => h[f]).filter(x => x != null); return v.length ? Math.max(...v) : null }
    const min = f => { const v = hs.map(h => h[f]).filter(x => x != null); return v.length ? Math.min(...v) : null }
    const precip = hs.reduce((a, h) => a + (h.precip_in ?? 0), 0)
    const pop = max('pop')
    const sdHi = sd(use.map(k => perModel[k].get(day)?.hi))
    const sdPop = sd(use.map(k => perModel[k].get(day)?.pop))
    const confidence = Math.round(Math.max(5, Math.min(98, 100 - 9 * sdHi - 0.35 * sdPop - 2.2 * i)))
    // icon for the daytime (8am-6pm)
    const dayHs = hs.filter(h => h.hour >= 8 && h.hour <= 18)
    const dh = dayHs.length ? dayHs : hs
    const dPrecip = dh.reduce((a, h) => a + (h.precip_in ?? 0), 0)
    const dPop = Math.max(0, ...dh.map(h => h.pop ?? 0))
    const fogAm = hs.filter(h => h.hour >= 5 && h.hour <= 10 && h.icon === 'fog').length
    const cl = dh.map(h => h.cloud).filter(x => x != null)
    const avgCloud = cl.length ? cl.reduce((a, b) => a + b, 0) / cl.length : null
    const icon = (dPrecip >= 0.05 && dPop >= 40) || dPop >= 60 ? 'rain' : dPop >= 30 ? 'chance' : fogAm >= 3 ? 'fog'
      : avgCloud == null ? 'clear' : avgCloud >= 70 ? 'cloud' : avgCloud >= 30 ? 'partly' : 'clear'
    out.push({
      day, hi_f: r1(hi), lo_f: r1(lo), pop: pop == null ? null : Math.round(pop), precip_in: r2(precip),
      wind_mph: r1(max('wind_mph')), gust_mph: r1(max('gust_mph')), rh_max: r1(max('rh')), rh_min: r1(min('rh')),
      vpd_max: r2(max('vpd')), vpd_min: r2(min('vpd')), aqi_max: max('aqi'), icon, confidence, n_models: use.length,
    })
  }
  return out
}

// ---------- risk flags ----------
const iso = s => new Date(s * 1000).toISOString()
const fmtH = h => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`)

/** longest run of consecutive hours where test() holds -> { n, start, end, hs } */
function longestRun(hs, test) {
  let best = { n: 0 }, cur = []
  for (const h of hs) {
    if (test(h)) { cur.push(h); if (cur.length > best.n) best = { n: cur.length, hs: [...cur] } }
    else cur = []
  }
  if (best.n) { best.start = best.hs[0].t; best.end = best.hs[best.hs.length - 1].t + 3600 }
  return best
}
const rng = (hs, f) => { const v = hs.map(h => h[f]).filter(x => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : [null, null] }

/**
 * hourly: blended rows; daily: summary rows; rules: merged rules; harvests: [{id, strain, kind, planned_on}];
 * alerts: parsed NWS alerts -> flag rows (without site_id)
 */
export function computeFlags(hourly, daily, rules, harvests = [], alerts = [], nowSec = Date.now() / 1000) {
  const R = rules
  const flags = []
  const byDay = new Map()
  for (const h of hourly) { const a = byDay.get(h.day) ?? []; a.push(h); byDay.set(h.day, a) }
  const days = daily.map(d => d.day)
  // night window for day D: 6pm D -> 9am D+1, so overnight humidity counts once, on the evening it starts
  const night = d => hourly.filter(h => (h.day === d && h.hour >= 18) || (h.day === addDays(d, 1) && h.hour < 9))
  const prevWatch = { botrytis: false, mildew: 0 }

  for (const d of daily) {
    const day = d.day
    const hs = byDay.get(day) ?? []
    const future = hs.filter(h => h.t + 3600 > nowSec)

    // botrytis: long wet spells at mold-friendly temps (overnight into the morning)
    if (R.botrytis.on) {
      const b = R.botrytis
      const run = longestRun(night(day), h => h.temp_f != null && h.temp_f >= b.tmin && h.temp_f <= b.tmax &&
        ((h.rh ?? 0) >= b.rh || (h.dew_f != null && h.temp_f - h.dew_f <= b.dewgap)))
      if (run.n >= b.watch_hrs) {
        const level = run.n >= b.warn_hrs || prevWatch.botrytis ? 'warning' : 'watch'
        const [t0, t1] = rng(run.hs, 'temp_f')
        flags.push({ day, kind: 'botrytis', level, starts: iso(run.start), ends: iso(run.end),
          why: `${run.n} hrs at ${b.rh}%+ humidity, ${Math.round(t0)}-${Math.round(t1)}°F (${fmtH(local(run.start).hour)} to ${fmtH(local(run.end).hour)})${level === 'warning' && run.n < b.warn_hrs ? ', second night in a row' : ''}`,
          detail: { hours: run.n } })
        prevWatch.botrytis = true
      } else prevWatch.botrytis = false
    }

    // powdery mildew: warm moderate-humidity day, then a humid night
    if (R.mildew.on && hs.length >= 12) {
      const m = R.mildew
      const warm = hs.filter(h => h.hour >= 10 && h.hour <= 18 && h.temp_f >= m.day_tmin && h.temp_f <= m.day_tmax && h.rh >= m.rh_min && h.rh <= m.rh_max).length
      const nRh = Math.max(0, ...night(day).map(h => h.rh ?? 0))
      if (warm >= m.day_hrs && nRh >= m.night_rh) {
        prevWatch.mildew++
        const level = prevWatch.mildew >= m.warn_days ? 'warning' : 'watch'
        flags.push({ day, kind: 'mildew', level, why: `${warm} warm hrs at ${m.day_tmin}-${m.day_tmax}°F, then ${Math.round(nRh)}% humidity overnight${prevWatch.mildew > 1 ? ` (${prevWatch.mildew} days in a row)` : ''}`,
          detail: { warm_hrs: warm, night_rh: nRh, streak: prevWatch.mildew } })
      } else prevWatch.mildew = 0
    }

    // rain (and rain on a scheduled harvest day)
    if (R.rain.on) {
      const r = R.rain
      const pop = d.pop ?? 0, inch = d.precip_in ?? 0
      const watch = pop >= r.watch_pop || inch >= r.watch_in
      if (watch) {
        const hv = r.harvest ? harvests.filter(x => x.planned_on === day) : []
        const level = pop >= r.warn_pop || inch >= r.warn_in || hv.length ? 'warning' : 'watch'
        const wet = hs.filter(h => (h.pop ?? 0) >= r.watch_pop || (h.precip_in ?? 0) >= 0.01)
        flags.push({ day, kind: 'rain', level, starts: wet[0] ? iso(wet[0].t) : null, ends: wet.length ? iso(wet[wet.length - 1].t + 3600) : null,
          why: `${Math.round(pop)}% chance, ${inch.toFixed(2)}"` + (hv.length ? ` on a harvest day: ${hv.map(x => `${x.strain}${x.kind && x.kind !== 'ff' ? ` (${KIND[x.kind] ?? x.kind})` : ''}`).join(', ')}` : ''),
          detail: { pop, inches: inch, harvests: hv.map(x => x.id) } })
      }
    }

    // frost
    if (R.frost.on && d.lo_f != null && d.lo_f <= R.frost.watch) {
      const cold = hs.filter(h => h.temp_f <= R.frost.watch)
      flags.push({ day, kind: 'frost', level: d.lo_f <= R.frost.warn ? 'warning' : 'watch', starts: cold[0] ? iso(cold[0].t) : null, ends: cold.length ? iso(cold[cold.length - 1].t + 3600) : null,
        why: `Low of ${Math.round(d.lo_f)}°F${d.lo_f > R.frost.warn ? ' (ground can run colder)' : ''}` })
    }

    // heat: crew (Cal/OSHA) and plants
    if (R.heat_crew.on && d.hi_f != null && d.hi_f >= R.heat_crew.watch) {
      const hot = hs.filter(h => h.temp_f >= R.heat_crew.watch)
      const level = d.hi_f >= R.heat_crew.warn ? 'warning' : 'watch'
      flags.push({ day, kind: 'heat_crew', level, starts: hot[0] ? iso(hot[0].t) : null, ends: hot.length ? iso(hot[hot.length - 1].t + 3600) : null,
        why: `High of ${Math.round(d.hi_f)}°F: ${level === 'warning' ? 'high heat procedures (95°F+)' : 'shade and water required (80°F+)'}${hot.length ? `, ${fmtH(hot[0].hour)} to ${fmtH((hot[hot.length - 1].hour + 1) % 24)}` : ''}` })
    }
    if (R.heat_plant.on && ((d.hi_f ?? 0) >= R.heat_plant.watch || (d.vpd_max ?? 0) >= R.heat_plant.vpd)) {
      flags.push({ day, kind: 'heat_plant', level: (d.hi_f ?? 0) >= R.heat_plant.warn ? 'warning' : 'watch',
        why: `High ${Math.round(d.hi_f ?? 0)}°F, VPD up to ${(d.vpd_max ?? 0).toFixed(1)} kPa` })
    }

    // wind
    const g = d.gust_mph ?? d.wind_mph
    if (R.wind.on && g != null && g >= R.wind.watch) {
      const windy = hs.filter(h => (h.gust_mph ?? h.wind_mph ?? 0) >= R.wind.watch)
      flags.push({ day, kind: 'wind', level: g >= R.wind.warn ? 'warning' : 'watch', starts: windy[0] ? iso(windy[0].t) : null, ends: windy.length ? iso(windy[windy.length - 1].t + 3600) : null,
        why: `Gusts to ${Math.round(g)} mph${g >= R.wind.warn ? ': secure hoop house plastic' : ''}` })
    }

    // smoke
    if (R.smoke.on && d.aqi_max != null && d.aqi_max >= R.smoke.watch) {
      flags.push({ day, kind: 'smoke', level: d.aqi_max >= R.smoke.warn ? 'warning' : 'watch', why: `Air quality index up to ${Math.round(d.aqi_max)}` })
    }

    // spray windows (good hours): calm-ish, cool enough, dry for the next day, no inversion. Today and tomorrow only.
    if (R.spray.on && days.indexOf(day) <= 1) {
      const s = R.spray
      const ok = h => {
        if (h.hour < 6 || h.hour > 19) return false
        if (h.wind_mph == null || h.wind_mph < s.wind_min || h.wind_mph > s.wind_max) return false
        if (h.temp_f == null || h.temp_f >= s.tmax) return false
        if (h.inversion) return false
        const ahead = hourly.filter(x => x.t >= h.t && x.t < h.t + s.dry_hrs * 3600)
        return !ahead.some(x => (x.precip_in ?? 0) >= 0.01 || (x.pop ?? 0) > s.pop_max)
      }
      let cur = []
      const push = () => { if (cur.length >= 2) flags.push({ day, kind: 'spray', level: 'good', starts: iso(cur[0].t), ends: iso(cur[cur.length - 1].t + 3600),
        why: `Spray window ${fmtH(cur[0].hour)} to ${fmtH((cur[cur.length - 1].hour + 1) % 24)}: wind ${Math.round(rng(cur, 'wind_mph')[0])}-${Math.round(rng(cur, 'wind_mph')[1])} mph, no rain for ${s.dry_hrs} hrs` }); cur = [] }
      for (const h of future) { if (ok(h)) cur.push(h); else push() }
      push()
    }
  }

  // NWS fire weather (red flag) warnings
  for (const a of alerts) {
    if (!/red flag|fire weather/i.test(a.event ?? '')) continue
    const s = a.starts ? Math.floor(Date.parse(a.starts) / 1000) : nowSec
    const day = local(Math.max(s, nowSec)).day
    if (!days.includes(day)) continue
    flags.push({ day, kind: 'fire', level: /warning/i.test(a.event) ? 'warning' : 'watch', starts: a.starts, ends: a.ends, why: a.headline ?? a.event })
  }
  return flags
}
const KIND = { ff: 'fresh frozen', dry: 'dry', combine: 'combine', strip: 'strip' }

/** compact copy of one source for the scoring history */
export function snapshotOf(s, fromSec) {
  const keep = s.t.map((t, i) => [t, i]).filter(([t]) => t >= fromSec)
  if (!keep.length) return null
  const pick = f => keep.map(([, i]) => (s[f][i] == null ? null : Math.round(s[f][i] * 10) / 10))
  return { t0: keep[0][0], step: 3600, t: keep.map(([t]) => t), temp_f: pick('temp_f'), rh: pick('rh'), pop: pick('pop'), precip_in: keep.map(([, i]) => s.precip_in[i]), gust_mph: pick('gust_mph'), wind_mph: pick('wind_mph') }
}

/** hourly row -> database row */
export function hourlyRow(siteId, h, issued) {
  return { site_id: siteId, t: iso(h.t), temp_f: r1(h.temp_f), rh: r1(h.rh), dew_f: r1(h.dew_f), vpd: r2(h.vpd), pop: h.pop == null ? null : Math.round(h.pop),
    precip_in: r2(h.precip_in), wind_mph: r1(h.wind_mph), gust_mph: r1(h.gust_mph), wind_dir: h.wind_dir == null ? null : Math.round(h.wind_dir),
    cloud: h.cloud == null ? null : Math.round(h.cloud), aqi: h.aqi, inversion: h.inversion, icon: h.icon, spread_f: r1(h.spread_f), n_models: h.n_models, issued_at: issued }
}
