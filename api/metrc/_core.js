// METRC through T3 (Track & Trace Tools API, https://api.trackandtrace.tools/v2/docs/): the shared plumbing.
// Needs in Vercel: T3_SECRET_KEY (made on T3's secret-key page while logged in as the app's own METRC user),
// SUPABASE_SERVICE_ROLE_KEY and the VITE_SUPABASE_URL / _ANON_KEY the app already has.
// Every write goes with applyDynamicValidation=true. Dry run (Compliance > Settings) leaves submit off, so T3 checks the
// request against METRC without sending it. Live adds submit=true.

import { AsyncLocalStorage } from 'node:async_hooks'

const T3 = process.env.T3_BASE_URL || 'https://api.trackandtrace.tools'
const SB = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

/** answer the request (and save the call counts first: every handler answers through here) */
export async function send(res, status, body) { await flushUsage(); res.status(status).setHeader('Cache-Control', 'no-store'); return res.json(body) }

// ---------- usage meters (138): every call to T3 or the METRC API is counted, per day and source ----------
// Source = what started the calls: worker (every minute), overnight, nightly (the METRC pull), app (someone in the app).
const usageSource = new AsyncLocalStorage()
/** call at the top of a handler */
export function useSource(source) { usageSource.enterWith({ source }) }
let pending = {}
let pendingN = 0
/** count one call; flushes on its own every 25 calls */
export async function tally(service, method, ok) {
  const source = usageSource.getStore()?.source ?? 'app'
  const k = `${service}|${source}`
  const p = (pending[k] ??= { service, source, reads: 0, writes: 0, errors: 0 })
  if (String(method).toUpperCase() === 'GET') p.reads++; else p.writes++
  if (!ok) p.errors++
  if (++pendingN >= 25) await flushUsage()
}
export async function flushUsage() {
  if (!pendingN) return
  const rows = Object.values(pending)
  pending = {}; pendingN = 0
  try { await rpc('metrc_count_calls', { p_rows: rows }) } catch { /* 138 not run yet: counts are dropped, sending goes on */ }
}
export const missing = () => ['T3_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter(k => !process.env[k]).concat(SB && ANON ? [] : ['VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY'])

// ---------- Supabase as the server ----------
const svc = () => SERVICE.startsWith('sb_') ? { apikey: SERVICE } : { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
export async function db(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...svc(), 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!r.ok) throw new Error((body && (body.message || body.error || body.hint)) || `Database error ${r.status}`)
  return body
}
export const rpc = (fn, args) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) })
export const one = async path => (await db(path))?.[0] ?? null
export const enc = encodeURIComponent
export async function setting(key, dflt = null) {
  const r = await db(`app_settings?key=eq.${enc(key)}&select=value`)
  const v = r?.[0]?.value
  return v == null || v === '' ? dflt : v
}
export const isLive = async () => (await setting('comp.metrc_live', 'false')) === 'true'

/** who is calling from the app (their Supabase session) */
export async function caller(req) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/metrc_me`, { method: 'POST', body: '{}', headers: { apikey: ANON, Authorization: auth, 'Content-Type': 'application/json' } })
    const me = await r.json()
    return r.ok && me && me.email ? me : null
  } catch { return null }
}
/** run an app RPC as the caller (their own permissions) */
export async function asUser(req, fn, args) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}), headers: { apikey: ANON, Authorization: req.headers.authorization, 'Content-Type': 'application/json' } })
  const t = await r.text(); let j = null
  try { j = t ? JSON.parse(t) : null } catch { j = t }
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || `Database error ${r.status}`)
  return j
}

// ---------- T3 ----------
export class T3Error extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body } }
function t3msg(body, status) {
  if (!body) return `T3 answered ${status}`
  if (typeof body === 'string') return body.slice(0, 500)
  const e = body.error ?? body
  const parts = [e.message, e.detail, e.details, body.message].filter(x => typeof x === 'string')
  const list = Array.isArray(body.errors) ? body.errors : Array.isArray(e.errors) ? e.errors : null
  if (list) parts.push(list.map(x => (typeof x === 'string' ? x : x.message || JSON.stringify(x))).join('; '))
  return (parts.join(' ') || JSON.stringify(body)).slice(0, 800)
}
/** query values can be arrays (filter=a&filter=b) */
export async function t3(method, path, { query, body } = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '') continue
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x))
  }
  const q = qs.toString() ? `?${qs}` : ''
  let r
  try {
    r = await fetch(`${T3}${path}${q}`, {
      method, headers: { 'X-T3-API-Key': process.env.T3_SECRET_KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) { await tally('t3', method, false); throw e }
  await tally('t3', method, r.ok)
  const text = await r.text()
  let j = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  if (!r.ok) throw new T3Error(t3msg(j, r.status), r.status, j)
  return j
}
export const list = j => (Array.isArray(j) ? j : j?.data ?? [])
export const unhtml = s => String(s ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
/** a METRC write: dry run unless live */
export const WRITE_MAX = 25   // METRC (through T3) takes at most 25 entries in one write
export async function write(ctx, path, license, body) {
  const one = b => t3('POST', path, { query: { licenseNumber: license, submit: ctx.live ? 'true' : undefined, applyDynamicValidation: 'true' }, body: b })
    .then(x => { if (ctx.live) ctx.wrote = (ctx.wrote ?? 0) + 1; return x })
    .catch(e => explain(e, path, license, b, ctx))
  if (!Array.isArray(body) || body.length <= WRITE_MAX) return one(body)
  const out = []
  for (let i = 0; i < body.length; i += WRITE_MAX) out.push(await one(body.slice(i, i + WRITE_MAX)))
  return out
}

// METRC refused a live write and T3 only passed on "Metrc responded with status code 400" (137). Ask again as a check
// (no submit, T3's own validation against METRC's data), which often names the field; then add what's usually behind it.
async function explain(e, path, license, b, ctx) {
  if (!(e instanceof T3Error) || !ctx.live || !/status code 4\d\d/i.test(e.message)) throw e
  let why = null
  try {
    await t3('POST', path, { query: { licenseNumber: license, applyDynamicValidation: 'true' }, body: b })
  } catch (v) { why = v instanceof T3Error ? v.message : String(v?.message ?? v) }
  const hint = /packages\/create/.test(path)
    ? 'METRC often refuses a new package when the item moves to another category (Fresh Cannabis Plant to Flower, say), the item or strain isn\'t on this license, the tag isn\'t one of this license\'s, or the source package doesn\'t have that much.'
    : /packages\/adjust/.test(path) ? 'METRC often refuses an adjustment when the reason needs a note, or the new weight is below 0.'
    : /transfers/.test(path) ? 'METRC often refuses a manifest when a package isn\'t active here, the driver or vehicle is missing, or the destination license is wrong.'
    : 'METRC didn\'t say why.'
  const msg = why
    ? `METRC refused it. Checking the same request says: ${why}`
    : `METRC refused it (${e.message}) and didn't say why; the check run passes. ${hint} Try the same thing on the METRC website to see METRC's own message.`
  throw new T3Error(msg.slice(0, 900), e.status, e.body)
}

/** every row of a T3 collection (stops after maxPages) */
export async function all(path, query, maxPages = 20, pageSize = 500) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const j = await t3('GET', path, { query: { ...query, page, pageSize } })
    const rows = list(j)
    out.push(...rows)
    const total = j?.totalPages ?? (rows.length < pageSize ? page : page + 1)
    if (page >= total || !rows.length) break
  }
  return out
}
/** first row matching filter, or null */
export async function first(path, query) { return list(await t3('GET', path, { query: { ...query, pageSize: 5 } }))[0] ?? null }

// ---------- small helpers ----------
const TZ = 'America/Los_Angeles'
export const ymd = iso => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(iso ? new Date(iso) : new Date())
/** YYYY-MM-DDTHH:MM:SS in California time (METRC reads it in the license's local time) */
export function localDT(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}
export const r4 = x => Math.round(Number(x) * 10000) / 10000
export const LB = /^(lb|lbs|pound|pounds)$/i
export const up = s => String(s ?? '').trim().toUpperCase()
export const lc = s => String(s ?? '').trim().toLowerCase()
export async function tol() { return Number(await setting('comp.weight_tol', '0.5')) || 0.5 }

/** not an error: try again later */
export class Wait extends Error {}
/** nothing to send: METRC already matches (or a check passed) */
export class Skip extends Error {}
/** someone pressed Stop on the to-do: stop after the step it's on, keep what's in METRC, hold the rest */
export class Held extends Error {}

// ---------- METRC lookups (cached per run in ctx.cache) ----------
export function cached(ctx, key, fn) {
  ctx.cache ??= {}
  if (!(key in ctx.cache)) ctx.cache[key] = fn().catch(e => { delete ctx.cache[key]; throw e })
  return ctx.cache[key]
}
/** one active package by tag, or null */
export async function packageByTag(license, tag) {
  const j = await t3('GET', '/v2/packages/active', { query: { licenseNumber: license, filter: `label__eq:${up(tag)}`, pageSize: 5 } })
  return list(j).find(p => up(p.label) === up(tag)) ?? null
}
/** where a tag is in METRC on this license: active / intransit / transferred / inactive, or null */
export async function packageAnywhere(license, tag) {
  for (const state of ['active', 'intransit', 'transferred', 'inactive']) {
    const j = await t3('GET', `/v2/packages/${state}`, { query: { licenseNumber: license, filter: `label__eq:${up(tag)}`, pageSize: 5 } }).catch(() => null)
    const p = list(j).find(x => up(x.label ?? x.packageLabel) === up(tag))
    if (p) return { state, p }
  }
  return null
}
export const itemId = p => p?.item?.id ?? p?.itemId ?? null
/** a tag's id from a write's own source-tags list (that list only has tags the write can use) */
export async function tagIdFor(ctx, license, path, label) {
  return cached(ctx, `tag:${path}:${license}:${up(label)}`, async () => {
    const j = await t3('GET', path, { query: { licenseNumber: license, filter: `label__eq:${up(label)}`, pageSize: 5 } })
    const t = list(j).find(x => up(x.label) === up(label))
    if (!t) throw new Error(`Tag ${up(label)} isn't available on ${license} in METRC (already used, voided, or not on this license)`)
    return t.id
  })
}
export const inputs = (ctx, license, path, query = {}) => cached(ctx, `in:${path}:${license}:${JSON.stringify(query)}`, () => t3('GET', path, { query: { licenseNumber: license, ...query } }))
export function uomFrom(inp, abbrev) {
  const u = (inp?.unitsOfMeasure ?? inp?.unitsOfWeight ?? []).find(x => lc(x.abbreviation) === lc(abbrev) || lc(x.name) === lc(abbrev))
    ?? (LB.test(abbrev) ? (inp?.unitsOfMeasure ?? inp?.unitsOfWeight ?? []).find(x => /^(lb|pound)/i.test(x.abbreviation ?? x.name ?? '')) : null)
  return u?.id ?? null
}
/** the reason id for a named reason (from a write's inputs), or a clear error */
export function reasonFrom(rs, want, what, settingLabel) {
  const all = (rs ?? []).filter(r => !r.isArchived)
  if (!want) throw new Error(`Pick the METRC reason for ${what} in Compliance > Settings > METRC through T3 (${settingLabel}). METRC's reasons: ${all.map(r => unhtml(r.name)).join(', ')}`)
  const r = all.find(x => lc(unhtml(x.name)) === lc(want)) ?? all.find(x => lc(unhtml(x.name)).includes(lc(want)))
  if (!r) throw new Error(`METRC has no reason "${want}" for ${what}. METRC's reasons: ${all.map(x => unhtml(x.name)).join(', ')}`)
  return r
}
/** a location id by name from a write's inputs (CA leaves some lists empty: then null and the field is left out) */
export function locationFrom(inp, name) {
  const ls = inp?.locations ?? []
  if (!ls.length || !name) return null
  return ls.find(l => lc(l.name) === lc(name))?.id ?? null
}

// ---------- the app's side ----------
export const pallet = id => (id ? one(`pallets?id=eq.${id}&select=*`) : null)
export async function siteOf(license) { return (await rpc('metrc_license_site', { p_license: license }).catch(() => null)) ?? null }
export async function mappedLocation(kind, ref, license) {
  return one(`metrc_location_map?app_kind=eq.${kind}&app_ref=eq.${enc(String(ref))}&license=eq.${enc(license)}&select=location_id,location`)
}
export async function strainFor(appStrain, license) {
  const s = await rpc('metrc_strain_for', { p_strain: appStrain, p_license: license })
  if (!s?.id) throw new Error(`No METRC strain for "${appStrain}" on ${license}. Map it in Compliance > METRC > Mapping (pull from METRC first).`)
  return s
}

/** package adjustment reasons for a license (from the adjust form's inputs; the packages it also returns are dropped) */
export async function adjustReasons(license) {
  const j = await t3('GET', '/v2/packages/adjust/inputs', { query: { licenseNumber: license } })
  return (j?.actionReasons ?? []).filter(r => r.forPackageAdjustments !== false).map(r => ({ id: r.id, name: unhtml(r.name), requiresNote: !!r.requiresNote }))
}

/** a T3 file (PDF), as base64 */
export async function t3file(path, query) {
  const qs = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v != null && v !== '')).toString()
  const r = await fetch(`${T3}${path}${qs ? `?${qs}` : ''}`, { headers: { 'X-T3-API-Key': process.env.T3_SECRET_KEY, Accept: 'application/pdf' } })
    .catch(async e => { await tally('t3', 'GET', false); throw e })
  await tally('t3', 'GET', r.ok)
  const buf = Buffer.from(await r.arrayBuffer())
  if (!r.ok) { let m = buf.toString('utf8').slice(0, 400); try { const j = JSON.parse(m); m = j.message || j.error?.message || m } catch { /* text */ } throw new T3Error(m || `T3 answered ${r.status}`, r.status) }
  return { type: r.headers.get('content-type') || 'application/pdf', base64: buf.toString('base64') }
}
