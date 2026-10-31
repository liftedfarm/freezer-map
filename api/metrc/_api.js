// The official METRC API (Metrc Connect), next to T3. Ready to plug in: nothing goes through it until a kind's API sender
// is built, tested in the sandbox, marked api_ready in metrc_push_kinds, and a Compliance Admin picks "METRC API" for it.
//
// Needs in Vercel:
//   METRC_VENDOR_KEY        the integrator (vendor) key from the Metrc Connect portal
//   METRC_USER_KEY          the user API key of the app's own METRC user (metrc.com > profile > API keys)
//   METRC_API_URL           optional, default https://api-ca.metrc.com
//   METRC_API_SANDBOX_URL   the sandbox address Metrc gives with Connect. The METRC API has no dry run (T3 does), so
//                           Dry run on the API route goes to the sandbox; without it, API Dry runs refuse.
// Contract (Connect Order Form, 10/2026): 50,000 calls a month (hard stop on the free tier), 5 calls a second,
// 30 days of lookback on reads, no webhooks. The client keeps to 4 a second.
import { db, flushUsage, list, tally } from './_core.js'

const BASE = (process.env.METRC_API_URL || 'https://api-ca.metrc.com').replace(/\/+$/, '')
const SANDBOX = (process.env.METRC_API_SANDBOX_URL || '').replace(/\/+$/, '')
const GAP_MS = 250
const TIMEOUT_MS = 60000

export const apiConfigured = () => !!(process.env.METRC_VENDOR_KEY && process.env.METRC_USER_KEY)
export const apiMissing = () => ['METRC_VENDOR_KEY', 'METRC_USER_KEY'].filter(k => !process.env[k])

export class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body } }
/** the route can't be used at all (keys missing, no sandbox for a dry run): nothing reached METRC */
export class NotReady extends Error { constructor(msg) { super(msg); this.notReady = true } }

let last = 0
async function slot() {
  const wait = last + GAP_MS - Date.now()
  last = Math.max(Date.now(), last + GAP_MS)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}

function apiMsg(body, status) {
  if (!body) return `METRC API answered ${status}`
  if (typeof body === 'string') return body.slice(0, 500)
  // METRC answers a refused write with a list: [{ row, message }]
  if (Array.isArray(body)) return body.map(x => (x?.row != null ? `row ${x.row}: ` : '') + (x?.message ?? JSON.stringify(x))).join('; ').slice(0, 800)
  return String(body.Message ?? body.message ?? JSON.stringify(body)).slice(0, 800)
}

/** one call to the METRC API. sandbox = true sends to the sandbox address. */
export async function metrcApi(method, path, { license, query, body, sandbox = false } = {}) {
  if (!apiConfigured()) throw new NotReady(`The METRC API isn't set up yet. Missing in Vercel: ${apiMissing().join(', ')}`)
  const base = sandbox ? SANDBOX : BASE
  if (!base) throw new NotReady('The METRC API has no dry run. Set METRC_API_SANDBOX_URL in Vercel to dry run through the sandbox.')
  const qs = new URLSearchParams()
  if (license) qs.append('licenseNumber', license)
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '') continue
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x))
  }
  const auth = Buffer.from(`${process.env.METRC_VENDOR_KEY}:${process.env.METRC_USER_KEY}`).toString('base64')
  await slot()
  let r
  try {
    r = await fetch(`${base}${path}${qs.toString() ? `?${qs}` : ''}`, {
      method, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) { if (!sandbox) await tally('api', method, false); throw e }
  if (!sandbox) await tally('api', method, r.ok)   // sandbox calls don't count against the 50,000
  const text = await r.text()
  let j = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  if (!r.ok) throw new ApiError(apiMsg(j, r.status), r.status, j)
  return j
}

/** a METRC write through the API: Live goes to METRC, Dry run to the sandbox */
export async function apiWrite(ctx, method, path, license, body) {
  const j = await metrcApi(method, path, { license, body, sandbox: !ctx.live })
  if (ctx.live) ctx.wrote = (ctx.wrote ?? 0) + 1
  return j
}

/** every row of a v2 collection (METRC pages: pageNumber / pageSize, at most 20 a page) */
export async function apiAll(path, license, query = {}, maxPages = 50) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const j = await metrcApi('GET', path, { license, query: { ...query, pageNumber: page, pageSize: 20 } })
    const rows = Array.isArray(j) ? j : j?.Data ?? j?.data ?? []
    out.push(...rows)
    const total = j?.TotalPages ?? j?.totalPages ?? (rows.length < 20 ? page : page + 1)
    if (page >= total || !rows.length) break
  }
  return out
}

/** Compliance > Settings: can the keys reach METRC, and which of our licenses does the user see */
export async function testApi(by) {
  const out = { api_ok: false, api_tested_at: new Date().toISOString(), api_tested_by: by, api_base: BASE, api_sandbox: SANDBOX || null, api_licenses: [], api_error: null }
  try {
    let facs
    try { facs = await metrcApi('GET', '/facilities/v2/') }
    catch (e) { if (e instanceof ApiError && e.status === 404) facs = await metrcApi('GET', '/facilities/v1/'); else throw e }
    facs = Array.isArray(facs) ? facs : list(facs)
    const ours = await db('licenses?select=license_no,kind,site,active&active=eq.true')
    const want = ours.filter(l => l.kind !== 'transport' && l.site)
    const lic = f => f?.License?.Number ?? f?.license?.number ?? f?.LicenseNumber ?? null
    const nums = new Set([...facs.map(lic).filter(Boolean), ...want.map(l => l.license_no)])
    for (const n of nums) {
      const f = facs.find(x => lic(x) === n)
      const app = ours.find(l => l.license_no === n)
      out.api_licenses.push({ license: n, name: f?.DisplayName ?? f?.Name ?? null, in_api: !!f, in_app: !!app, site: app?.site ?? null })
    }
    const miss = out.api_licenses.filter(l => l.in_app && !l.in_api)
    out.api_ok = facs.length > 0 && miss.length === 0
    if (!facs.length) out.api_error = 'The METRC API answered, but the user behind the user key sees no facilities'
    else if (miss.length) out.api_error = `The METRC user can't see ${miss.map(l => `${l.site} ${l.license}`).join(', ')}`
  } catch (e) {
    out.api_error = e instanceof ApiError && (e.status === 401 || e.status === 403)
      ? `METRC refused the keys (${e.status}). Check METRC_VENDOR_KEY (Connect portal) and METRC_USER_KEY (the app user's API key) in Vercel. ${e.message}`
      : String(e.message || e)
  }
  await db('metrc_connection?id=eq.1', { method: 'PATCH', body: JSON.stringify(out), headers: { Prefer: 'return=minimal' } })
  await flushUsage()
  return out
}

/** for the senders' notes */
export const routeLabel = r => (r === 'api' ? 'METRC API' : 'T3')
