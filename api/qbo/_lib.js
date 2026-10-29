// QuickBooks Online helpers for the server functions in api/qbo/. (Files starting with _ are not routes.)
// Needs in Vercel: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV (sandbox | production), SUPABASE_SERVICE_ROLE_KEY,
// plus the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app already has. Optional: QBO_REDIRECT_URI, STAFF_APP_URL.
// The QuickBooks tokens live in qbo_connection, which only the service role can read.

export const ENV = (process.env.QBO_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox'
export const API = process.env.QBO_API_BASE || (ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com')
export const APP_URL = process.env.STAFF_APP_URL || 'https://freezer-map-8i3h.vercel.app'
export const REDIRECT = process.env.QBO_REDIRECT_URI || `${APP_URL}/api/qbo/callback`
const TOKEN_URL = process.env.QBO_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
const MINOR = 'minorversion=75'

const SB = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

export function missingSetup() {
  const miss = []
  if (!process.env.QBO_CLIENT_ID) miss.push('QBO_CLIENT_ID')
  if (!process.env.QBO_CLIENT_SECRET) miss.push('QBO_CLIENT_SECRET')
  if (!SERVICE) miss.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!SB || !ANON) miss.push('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  return miss
}

// ---------- Supabase ----------
const serviceHeaders = () => SERVICE.startsWith('sb_')
  ? { apikey: SERVICE, 'Content-Type': 'application/json' }            // new-style secret key
  : { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }

async function sbFetch(path, opts, headers) {
  const r = await fetch(`${SB}${path}`, { ...opts, headers: { ...headers, ...(opts && opts.headers) } })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!r.ok) throw new Error((body && (body.message || body.hint)) || `Database error ${r.status}`)
  return body
}
/** call a database function as the server (service role) */
export const rpc = (fn, args) => sbFetch(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) }, serviceHeaders())
/** read / write a table as the server */
export const table = (path, opts) => sbFetch(`/rest/v1/${path}`, opts || {}, serviceHeaders())
export const upsert = (tbl, rows, onConflict) => table(`${tbl}${onConflict ? `?on_conflict=${onConflict}` : ''}`, {
  method: 'POST', body: JSON.stringify(rows), headers: { Prefer: 'resolution=merge-duplicates,return=representation' } })

/** who is calling (their own login), and what they can do in Accounting */
export async function caller(req) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  try {
    const me = await sbFetch('/rest/v1/rpc/acct_me', { method: 'POST', body: '{}' }, { apikey: ANON, Authorization: auth, 'Content-Type': 'application/json' })
    return me && me.level ? me : null
  } catch { return null }
}

// ---------- QuickBooks login ----------
const basic = () => 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64')

export function authorizeUrl(state) {
  const q = new URLSearchParams({ client_id: process.env.QBO_CLIENT_ID, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: REDIRECT, state })
  return `https://appcenter.intuit.com/connect/oauth2?${q}`
}

async function tokenCall(params) {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { Authorization: basic(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || `QuickBooks sign-in failed (${r.status})`)
  return j
}
const tokenRow = t => ({
  access_token: t.access_token, refresh_token: t.refresh_token,
  access_expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
  refresh_expires_at: new Date(Date.now() + (Number(t.x_refresh_token_expires_in) || 8640000) * 1000).toISOString(),
})
export const exchangeCode = code => tokenCall({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }).then(tokenRow)

export async function revoke(token) {
  await fetch(REVOKE_URL, { method: 'POST', headers: { Authorization: basic(), Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {})
}

/** the connection for this environment, with a fresh access token */
export async function connection() {
  const rows = await table(`qbo_connection?env=eq.${ENV}&select=*`)
  const c = rows && rows[0]
  if (!c) throw new Error(`QuickBooks (${ENV}) isn't connected yet. An Accounting Admin can connect it in Accounting > Settings.`)
  if (!c.access_token || new Date(c.access_expires_at).getTime() < Date.now() + 5 * 60000) {
    let t
    try { t = tokenRow(await tokenCall({ grant_type: 'refresh_token', refresh_token: c.refresh_token })) }
    catch (e) {
      await table(`qbo_connection?env=eq.${ENV}`, { method: 'PATCH', body: JSON.stringify({ last_error: `Sign-in expired: ${e.message}` }) }).catch(() => {})
      throw new Error(`The QuickBooks connection expired (${e.message}). An Accounting Admin needs to connect it again in Accounting > Settings.`)
    }
    await table(`qbo_connection?env=eq.${ENV}`, { method: 'PATCH', body: JSON.stringify(t) })
    Object.assign(c, t)
  }
  return c
}

// ---------- QuickBooks API ----------
function qboError(j, status) {
  const f = j && j.Fault && j.Fault.Error && j.Fault.Error[0]
  if (f) return `${f.Message}${f.Detail && f.Detail !== f.Message ? `: ${f.Detail}` : ''}${f.code ? ` (${f.code})` : ''}`
  return (j && (j.message || j.error)) || `QuickBooks error ${status}`
}
export async function qbo(c, method, path, body) {
  const sep = path.includes('?') ? '&' : '?'
  const r = await fetch(`${API}/v3/company/${c.realm_id}/${path}${sep}${MINOR}`, {
    method, headers: { Authorization: `Bearer ${c.access_token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.Fault) { const e = new Error(qboError(j, r.status)); e.status = r.status; e.tid = r.headers.get('intuit_tid'); throw e }
  return j
}
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
export async function query(c, sql) {
  const j = await qbo(c, 'GET', `query?query=${encodeURIComponent(sql)}`)
  return j.QueryResponse || {}
}
export async function findOne(c, entity, field, value) {
  const r = await query(c, `select * from ${entity} where ${field} = '${esc(value)}'`)
  return (r[entity] || [])[0] || null
}
export async function companyName(c) {
  const j = await qbo(c, 'GET', `companyinfo/${c.realm_id}`)
  return j.CompanyInfo && (j.CompanyInfo.CompanyName || j.CompanyInfo.LegalName)
}

// ---------- matching our things to QuickBooks ids ----------
async function getRef(kind, key) {
  const r = await table(`qbo_refs?env=eq.${ENV}&kind=eq.${kind}&key=eq.${encodeURIComponent(key)}&select=qbo_id`)
  return r && r[0] ? r[0].qbo_id : null
}
const setRef = (kind, key, qbo_id, name) => upsert('qbo_refs', [{ env: ENV, kind, key: String(key), qbo_id: String(qbo_id), name, updated_at: new Date().toISOString() }], 'env,kind,key')

export async function itemId(c, code, name) {
  const have = await getRef('item', code)
  if (have) return have
  const it = await findOne(c, 'Item', 'Name', name)
  if (!it) throw new Error(`The product "${name}" isn't in QuickBooks${ENV === 'sandbox' ? ' (run Set up sandbox in Accounting > Settings)' : ''}. Add it there with exactly that name, or rename it in Accounting > Settings > Products.`)
  if (it.Active === false) throw new Error(`The product "${name}" is inactive in QuickBooks.`)
  await setRef('item', code, it.Id, it.Name)
  return it.Id
}
export async function classId(c, name) {
  const have = await getRef('class', name)
  if (have) return have
  const cl = await findOne(c, 'Class', 'Name', name)
  if (!cl) throw new Error(`The class "${name}" isn't in QuickBooks${ENV === 'sandbox' ? ' (run Set up sandbox in Accounting > Settings)' : ''}. Add it there with exactly that name, or rename it in Accounting > Settings > Classes.`)
  await setRef('class', name, cl.Id, cl.Name)
  return cl.Id
}
export async function termId(c, code, label) {
  if (!label) return null
  const have = await getRef('term', code)
  if (have) return have === 'none' ? null : have
  const t = await findOne(c, 'Term', 'Name', label)
  await setRef('term', code, t ? t.Id : 'none', t ? t.Name : null)
  return t ? t.Id : null
}
const addr = text => {
  const ls = String(text || '').split(/\n|;\s*/).map(s => s.trim()).filter(Boolean)
  if (!ls.length) return undefined
  const a = {}
  ls.slice(0, 5).forEach((l, i) => { a[`Line${i + 1}`] = l.slice(0, 500) })
  return a
}
export async function customerId(c, cu) {
  const have = await getRef('customer', cu.id)
  if (have) return have
  // the QuickBooks name (from the QuickBooks import) is matched first and exactly; then the legal name, then the app name
  const qn = cu.qbo_name ? String(cu.qbo_name).trim() : ''
  let found = qn ? await findOne(c, 'Customer', 'DisplayName', qn) : null
  const name = (qn || String(cu.legal_name || cu.name).replace(/:/g, '-')).slice(0, 500)
  if (!found && !qn) found = await findOne(c, 'Customer', 'DisplayName', name)
  if (!found && cu.name && cu.name !== name) found = await findOne(c, 'Customer', 'DisplayName', cu.name)
  if (!found) {
    const body = { DisplayName: name, CompanyName: name.slice(0, 100) }
    if (cu.email) body.PrimaryEmailAddr = { Address: String(cu.email).split(/[,;\s]+/)[0] }
    if (cu.phone) body.PrimaryPhone = { FreeFormNumber: String(cu.phone).slice(0, 30) }
    if (cu.billing_address) body.BillAddr = addr(cu.billing_address)
    if (cu.ship_to_address) body.ShipAddr = addr(cu.ship_to_address)
    const notes = [cu.license ? `License ${cu.license}` : null, cu.contact ? `Billing contact ${cu.contact}` : null].filter(Boolean).join(' · ')
    if (notes) body.Notes = notes.slice(0, 2000)
    found = (await qbo(c, 'POST', 'customer', body)).Customer
  }
  await setRef('customer', cu.id, found.Id, found.DisplayName)
  return found.Id
}

// ---------- one invoice ----------
const r2 = n => Math.round(Number(n) * 100) / 100
export class Busy extends Error {}
/** send one invoice; one at a time per invoice (a click and the auto-send can't make two QuickBooks invoices) */
export async function pushInvoice(c, invoiceId, by) {
  const got = await rpc('acct_claim_push', { p_inv: invoiceId, p_env: ENV }).catch(e => (/acct_claim_push|function|schema cache|404/i.test(String(e.message)) ? true : Promise.reject(e)))
  if (got === false) throw new Busy('This invoice is being sent right now. Check again in a minute.')
  try { return await pushInvoice_(c, invoiceId, by) }
  finally { await rpc('acct_release_push', { p_inv: invoiceId, p_env: ENV }).catch(() => {}) }
}
async function pushInvoice_(c, invoiceId, by) {
  const p = await rpc('acct_invoice_payload', { p_inv: invoiceId })
  if (p.problems && p.problems.length) throw new Error(p.problems.join(' '))
  const custId = await customerId(c, p.customer)
  const lines = [], map = []
  for (const l of p.lines) {
    const amount = r2(l.amount), qty = Number(l.qty), price = Number(l.price)
    const detail = { ItemRef: { value: await itemId(c, l.product, l.item) }, ClassRef: { value: await classId(c, l.class) } }
    const asAmount = !(qty && Math.abs(r2(qty * price) - amount) < 0.005)
    if (!asAmount) { detail.Qty = qty; detail.UnitPrice = price } else { detail.Qty = 1; detail.UnitPrice = amount }
    map.push({ line_id: l.line_id, as_amount: asAmount || undefined, split: l.split || undefined })
    lines.push({ DetailType: 'SalesItemLineDetail', Amount: amount, Description: String(l.description || '').slice(0, 4000), SalesItemLineDetail: detail })
  }
  const body = {
    DocNumber: String(p.doc_number).slice(0, 21), TxnDate: p.date, DueDate: p.due || undefined,
    CustomerRef: { value: custId }, Line: lines,
    PrivateNote: [`From the Lifted Farms app`, p.so ? `order ${p.so}` : null, p.seller_license ? `seller license ${p.seller_license}` : null, p.terms ? `terms ${p.terms}` : null].filter(Boolean).join(' · ').slice(0, 4000),
  }
  if (p.memo) body.CustomerMemo = { value: String(p.memo).slice(0, 1000) }
  if (p.customer.email) body.BillEmail = { Address: String(p.customer.email).split(/[,;\s]+/)[0] }
  const term = await termId(c, p.terms_code, p.terms)
  if (term) body.SalesTermRef = { value: term }

  // already there? (sent before, or typed in by hand with the same number)
  const existing = (p.push && p.push.qbo_id) ? (await query(c, `select * from Invoice where Id = '${esc(p.push.qbo_id)}'`)).Invoice?.[0]
    : (await query(c, `select * from Invoice where DocNumber = '${esc(body.DocNumber)}'`)).Invoice?.[0]
  let inv, note = null, mode = 'created'
  if (existing && ENV === 'production') {
    // never overwrite something already in the real books: link it and say so
    inv = existing; mode = 'linked'
    note = r2(existing.TotalAmt) !== r2(p.total) ? `${body.DocNumber} was already in QuickBooks with a different total ($${existing.TotalAmt}). Linked it without changing it. Fix it in QuickBooks.`
      : `${body.DocNumber} was already in QuickBooks. Linked it.`
  } else if (existing) {
    inv = (await qbo(c, 'POST', 'invoice', { ...body, Id: existing.Id, SyncToken: existing.SyncToken, sparse: true })).Invoice; mode = 'updated'
  } else {
    inv = (await qbo(c, 'POST', 'invoice', body)).Invoice
  }
  // which QuickBooks line is which app line (prices changed there come back); only when we wrote the lines ourselves
  const ql = (inv.Line || []).filter(x => x.DetailType === 'SalesItemLineDetail')
  const lineMap = mode !== 'linked' && ql.length === map.length ? map.map((m, i) => ({ ...m, qbo_line_id: String(ql[i].Id) })) : null
  await rpc('acct_record_push', { p_inv: invoiceId, p_env: ENV, p_qbo_id: String(inv.Id), p_doc: inv.DocNumber || body.DocNumber,
    p_total: Number(inv.TotalAmt), p_balance: Number(inv.Balance), p_error: null, p_by: by, p_line_map: lineMap })
  return { qbo_id: inv.Id, doc_number: inv.DocNumber, total: inv.TotalAmt, balance: inv.Balance, mode, note }
}

// ---------- payments: balances back from QuickBooks ----------
export async function syncBalances(c) {
  const since = new Date(Date.now() - 120 * 86400000).toISOString()
  let rows
  try { rows = await table(`acct_pushes?env=eq.${ENV}&status=eq.sent&qbo_id=not.is.null&or=(balance.is.null,balance.gt.0,sent_at.gt.${since})&select=invoice_id,qbo_id,line_map,pulled_at&limit=2000`) }
  catch { rows = await table(`acct_pushes?env=eq.${ENV}&status=eq.sent&qbo_id=not.is.null&or=(balance.is.null,balance.gt.0,sent_at.gt.${since})&select=invoice_id,qbo_id&limit=2000`) }
  const out = []
  let pulled = 0, pullErr = null
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50)
    const r = await query(c, `select * from Invoice where Id in (${chunk.map(x => `'${esc(x.qbo_id)}'`).join(',')}) maxresults 100`)
    const got = new Map((r.Invoice || []).map(x => [String(x.Id), x]))
    for (const x of chunk) {
      const q = got.get(String(x.qbo_id))
      out.push(q ? { invoice_id: x.invoice_id, balance: Number(q.Balance), total: Number(q.TotalAmt) } : { invoice_id: x.invoice_id, balance: null, deleted: true })
      // prices changed in QuickBooks come back to the app (only when QuickBooks changed it since we last looked)
      if (q && x.line_map && (!x.pulled_at || new Date(q.MetaData?.LastUpdatedTime ?? 0) > new Date(x.pulled_at))) {
        const lines = (q.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail').map(l => ({
          qbo_line_id: String(l.Id), item: l.SalesItemLineDetail?.ItemRef?.value ?? null, qty: l.SalesItemLineDetail?.Qty ?? null,
          price: l.SalesItemLineDetail?.UnitPrice ?? null, amount: l.Amount, description: l.Description ?? '' }))
        try { const pr = await rpc('acct_pull_lines', { p_inv: x.invoice_id, p_env: ENV, p_lines: lines, p_updated: q.MetaData?.LastUpdatedTime ?? null }); if (pr?.changes?.length) pulled++ }
        catch (e) { pullErr = String(e.message || e).slice(0, 200) }
      }
    }
  }
  const res = await rpc('acct_record_sync', { p_env: ENV, p_rows: out, p_error: null })
  return { checked: out.length, prices_pulled: pulled, ...(pullErr ? { pull_error: pullErr } : {}), ...res }
}

// ---------- customer balances and open items, for the customer dashboard and statement (060) ----------
// The QuickBooks customer balance is the headline number (it includes Roshi-era invoices, credit memos and unapplied payments).
async function queryAll(c, sql, entity) {
  const out = []
  for (let start = 1; start < 20000; start += 500) {
    const r = await query(c, `${sql} startposition ${start} maxresults 500`)
    const xs = r[entity] || []
    out.push(...xs)
    if (xs.length < 500) break
  }
  return out
}
export async function syncCustomers(c) {
  const refs = await table(`qbo_refs?env=eq.${ENV}&kind=eq.customer&select=key,qbo_id&limit=5000`)
  if (!refs || !refs.length) return { customers: 0 }
  const ours = new Map(refs.map(r => [String(r.qbo_id), Number(r.key)]))
  const ids = [...ours.keys()]
  const bal = new Map(), items = new Map(ids.map(id => [id, []]))
  for (let i = 0; i < ids.length; i += 50) {
    const r = await query(c, `select Id, Balance from Customer where Id in (${ids.slice(i, i + 50).map(x => `'${esc(x)}'`).join(',')}) maxresults 100`)
    for (const x of r.Customer || []) bal.set(String(x.Id), Number(x.Balance))
  }
  const add = (ref, item) => { const k = String(ref && ref.value); if (items.has(k)) items.get(k).push(item) }
  for (const x of await queryAll(c, `select Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef from Invoice where Balance > '0'`, 'Invoice'))
    add(x.CustomerRef, { type: 'Invoice', doc: x.DocNumber || null, date: x.TxnDate, due: x.DueDate || null, total: Number(x.TotalAmt), balance: Number(x.Balance) })
  const since = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10)
  for (const x of await queryAll(c, `select Id, DocNumber, TxnDate, TotalAmt, RemainingCredit, CustomerRef from CreditMemo where TxnDate >= '${since}'`, 'CreditMemo'))
    if (Number(x.RemainingCredit) > 0) add(x.CustomerRef, { type: 'Credit', doc: x.DocNumber || null, date: x.TxnDate, due: null, total: -Number(x.TotalAmt), balance: -Number(x.RemainingCredit) })
  for (const x of await queryAll(c, `select Id, PaymentRefNum, TxnDate, TotalAmt, UnappliedAmt, CustomerRef from Payment where TxnDate >= '${since}'`, 'Payment'))
    if (Number(x.UnappliedAmt) > 0) add(x.CustomerRef, { type: 'Payment', doc: x.PaymentRefNum || null, date: x.TxnDate, due: null, total: -Number(x.TotalAmt), balance: -Number(x.UnappliedAmt) })
  const rows = ids.map(id => ({ customer_id: ours.get(id), qbo_customer_id: id, balance: bal.has(id) ? bal.get(id) : null,
    open_items: items.get(id).sort((a, b) => String(a.date).localeCompare(String(b.date))) }))
  const n = await rpc('acct_record_balances', { p_env: ENV, p_rows: rows })
  return { customers: n }
}

export function send(res, status, body) { res.status(status).setHeader('Cache-Control', 'no-store'); return res.json(body) }

/** auto-send: invoices whose 30 minutes are up (one QuickBooks at a time, never twice) */
export async function autoPush(c, budgetMs = 50000) {
  const t0 = Date.now()
  const on = (await table('app_settings?key=eq.acct.auto_push&select=value'))?.[0]?.value ?? 'true'
  if (on !== 'true') return { auto_push: 'off', sent: 0 }
  const due = await rpc('acct_autopush_due', { p_env: ENV })
  let sent = 0, failed = 0, busy = 0
  for (const id of due ?? []) {
    if (Date.now() - t0 > budgetMs) break
    try { await pushInvoice(c, Number(id), 'auto (30 min after it was made)'); sent++ }
    catch (e) {
      if (e instanceof Busy) { busy++; continue }
      failed++
      const msg = String(e.message || e) + (e.tid ? ` (QuickBooks ref ${e.tid})` : '')
      await rpc('acct_record_push', { p_inv: Number(id), p_env: ENV, p_qbo_id: null, p_doc: null, p_total: null, p_balance: null, p_error: msg, p_by: 'auto' }).catch(() => {})
    }
  }
  return { due: (due ?? []).length, sent, failed, busy }
}
