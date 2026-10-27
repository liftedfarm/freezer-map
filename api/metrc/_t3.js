// METRC through T3 (Track & Trace Tools API, https://api.trackandtrace.tools/v2/docs/).
// Needs in Vercel: T3_SECRET_KEY (made on T3's secret-key page while logged in as the app's own METRC user),
// SUPABASE_SERVICE_ROLE_KEY and the VITE_SUPABASE_URL / _ANON_KEY the app already has.
// Every write goes with applyDynamicValidation=true. Dry run (Compliance > Settings) leaves submit off, so T3 checks the
// request against METRC without sending it. Live adds submit=true.

const T3 = 'https://api.trackandtrace.tools'
const SB = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

export function send(res, status, body) { res.status(status).setHeader('Cache-Control', 'no-store'); return res.json(body) }
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
export async function setting(key, dflt = null) {
  const r = await db(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`)
  return r?.[0]?.value ?? dflt
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
export async function t3(method, path, { query, body } = {}) {
  const q = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : ''
  const r = await fetch(`${T3}${path}${q}`, {
    method, headers: { 'X-T3-API-Key': process.env.T3_SECRET_KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let j = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  if (!r.ok) throw new T3Error(t3msg(j, r.status), r.status, j)
  return j
}
const list = j => (Array.isArray(j) ? j : j?.data ?? [])
const unhtml = s => String(s ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

/** one active package by tag, or null */
export async function packageByTag(license, tag) {
  const j = await t3('GET', '/v2/packages/active', { query: { licenseNumber: license, filter: `label__eq:${tag}`, pageSize: 5 } })
  return list(j).find(p => p.label === tag) ?? null
}

/** package adjustment reasons for a license (from the adjust form's inputs; the packages it also returns are dropped) */
export async function adjustReasons(license) {
  const j = await t3('GET', '/v2/packages/adjust/inputs', { query: { licenseNumber: license } })
  return (j?.actionReasons ?? []).filter(r => r.forPackageAdjustments !== false).map(r => ({ id: r.id, name: unhtml(r.name), requiresNote: !!r.requiresNote }))
}

// ---------- connection test ----------
export async function testConnection(by) {
  const out = { ok: false, tested_at: new Date().toISOString(), tested_by: by, who: null, licenses: [], reasons: {}, error: null }
  try {
    out.who = await t3('GET', '/v2/auth/whoami').catch(e => ({ error: e.message }))
    const t3lics = list(await t3('GET', '/v2/licenses'))
    const ours = await db('licenses?select=license_no,kind,site,active&active=eq.true')
    const want = ours.filter(l => l.kind !== 'transport' && l.site)
    const nums = new Set([...t3lics.map(l => l.licenseNumber), ...want.map(l => l.license_no)])
    for (const n of nums) {
      const t = t3lics.find(l => l.licenseNumber === n)
      const app = ours.find(l => l.license_no === n)
      const row = { license: n, name: t?.licenseName ?? null, in_t3: !!t, in_app: !!app, site: app?.site ?? null, permissions: [] }
      if (t) {
        try { out.reasons[n] = await adjustReasons(n) } catch (e) { row.reasons_error = e.message }
      }
      out.licenses.push(row)
    }
    const miss = out.licenses.filter(l => l.in_app && !l.in_t3)
    out.ok = t3lics.length > 0 && miss.length === 0
    if (!t3lics.length) out.error = 'T3 answered, but the METRC user behind the key sees no licenses'
    else if (miss.length) out.error = `The METRC user can't see ${miss.map(l => `${l.site} ${l.license}`).join(', ')}. Add it to those licenses in METRC, then make a new T3 secret key.`
  } catch (e) {
    out.error = e.status === 401 || e.status === 403 ? `T3 refused the key (${e.status}). Make a new secret key on T3's secret-key page and update T3_SECRET_KEY in Vercel. ${e.message}` : e.message
  }
  await db('metrc_connection?id=eq.1', { method: 'PATCH', body: JSON.stringify(out), headers: { Prefer: 'return=minimal' } })
  return out
}

// ---------- senders, one per kind ----------
const ymd = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const r4 = x => Math.round(Number(x) * 10000) / 10000
const LB = /^(lb|lbs|pound|pounds)$/i
const REASON_LABEL = { drying: 'Drying', scale: 'Scale variance', waste: 'Waste', entry: 'Entry error' }

class Wait extends Error {}   // not an error: try again later (an earlier to-do for this package is still open)
class Skip extends Error {}   // nothing to send: METRC already matches

async function reasonFor(ctx, license, appReason) {
  const key = appReason in REASON_LABEL ? appReason : 'entry'
  const want = (await setting(`comp.metrc_reason_${key}`, REASON_LABEL[key])) || REASON_LABEL[key]
  ctx.reasons[license] ??= await adjustReasons(license)
  const rs = ctx.reasons[license]
  const r = rs.find(x => x.name.toLowerCase() === want.toLowerCase()) ?? rs.find(x => x.name.toLowerCase().includes(want.toLowerCase()))
  if (!r) throw new Error(`METRC has no adjustment reason "${want}" for ${license}. Pick the reason for "${REASON_LABEL[key]}" in Compliance > Settings > METRC through T3. METRC's reasons: ${rs.map(x => x.name).join(', ')}`)
  return r
}

async function sendAdjust(job, ctx) {
  const d = job.details || {}
  if (!job.license) throw new Error('No license on this to-do')
  if (!job.tag) throw new Error('This package has no METRC tag yet')
  const target = r4(d.to ?? job.lbs)
  if (!(target >= 0)) throw new Error('No new weight on this to-do')
  const p = await packageByTag(job.license, job.tag)
  if (!p) throw new Error(`Tag ${job.tag} isn't an active package under ${job.license} in METRC`)
  if (!LB.test(p.unitOfMeasureAbbreviation || '')) throw new Error(`METRC has this package in ${p.unitOfMeasureAbbreviation || '?'}, not pounds. Adjust it by hand.`)
  const cur = r4(p.quantity)
  const delta = r4(target - cur)
  if (Math.abs(delta) < 0.0001) throw new Skip(`METRC already shows ${target} lb`)
  const reason = await reasonFor(ctx, job.license, d.reason)
  const note = [`Lifted app ${job.code ?? ''}: ${cur} > ${target} lb`, d.reason ? REASON_LABEL[d.reason] : null, job.details?.note].filter(Boolean).join('. ').slice(0, 250)
  const body = [{
    id: p.id, isFinishedGood: false, currentQuantity: cur, currentQuantityUom: p.unitOfMeasureAbbreviation,
    adjustmentQuantity: delta, adjustmentUnitOfMeasureId: p.unitOfMeasureId,
    newQuantity: target, newQuantityUom: p.unitOfMeasureAbbreviation,
    adjustmentReasonId: reason.id, reasonNote: note, adjustmentDate: ymd(job.at),
  }]
  const resp = await t3('POST', '/v2/packages/adjust', { query: { licenseNumber: job.license, submit: ctx.live ? 'true' : undefined, applyDynamicValidation: 'true' }, body })
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${cur} > ${target} lb (${delta > 0 ? '+' : ''}${delta}), reason ${reason.name}` }
  const after = await packageByTag(job.license, job.tag)
  if (!after || Math.abs(r4(after.quantity) - target) > 0.001) throw new Error(`Sent, but METRC now shows ${after ? after.quantity : 'no active package'} (wanted ${target}). Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC ${cur} > ${target} lb, reason ${reason.name}` }
}

const SENDERS = { adjust: sendAdjust }
export const canSend = kind => !!SENDERS[kind]

/** run one claimed job; never throws */
export async function runJob(job, ctx) {
  const by = ctx.by
  try {
    if (!SENDERS[job.kind]) throw new Error(`The app can't send "${job.kind}" yet`)
    // earlier open to-dos for the same package go first
    if (job.tag) {
      const earlier = await db(`comp_metrc_actions?select=id,action&tag=eq.${encodeURIComponent(job.tag)}&status=in.(todo,error)&id=lt.${job.id}&order=id&limit=1`)
      if (earlier?.length) throw new Wait(`Waiting on an earlier to-do for this package: #${earlier[0].id} ${earlier[0].action}`)
    }
    const r = await SENDERS[job.kind](job, ctx)
    await rpc('metrc_result', { p_id: job.id, p_state: r.state, p_by: by, p_request: r.request ?? null, p_response: r.response ?? null, p_error: r.info ?? null })
    return { id: job.id, state: r.state, info: r.info }
  } catch (e) {
    if (e instanceof Skip) {
      await rpc('metrc_result', { p_id: job.id, p_state: ctx.live ? 'sent' : 'checked', p_by: by, p_request: null, p_response: null, p_error: e.message })
      return { id: job.id, state: ctx.live ? 'sent' : 'checked', info: e.message }
    }
    const state = e instanceof Wait ? 'waiting' : 'failed'
    await rpc('metrc_result', { p_id: job.id, p_state: state, p_by: by, p_request: null, p_response: e.body ?? null, p_error: e.message }).catch(() => {})
    return { id: job.id, state, error: e.message }
  }
}
