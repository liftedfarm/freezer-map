// Intuit sends the browser back here after someone approves the connection.
import { APP_URL, ENV, companyName, exchangeCode, table, upsert } from './_lib.js'

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `${APP_URL}/?go=accounting&${new URLSearchParams(q)}`); res.setHeader('Cache-Control', 'no-store'); res.end() }

export default async function handler(req, res) {
  const { code, state, realmId, error } = req.query || {}
  if (error) return back(res, { qbo: 'error', msg: String(error) })
  if (!code || !state || !realmId) return back(res, { qbo: 'error', msg: 'QuickBooks didn\'t send everything back. Try Connect again.' })
  try {
    const rows = await table(`qbo_oauth_states?state=eq.${encodeURIComponent(state)}&select=*`)
    const st = rows && rows[0]
    await table(`qbo_oauth_states?state=eq.${encodeURIComponent(state)}`, { method: 'DELETE' })
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60000) return back(res, { qbo: 'error', msg: 'That sign-in link expired. Try Connect again.' })
    if (st.env !== ENV) return back(res, { qbo: 'error', msg: `The app switched to ${ENV} during sign-in. Try Connect again.` })
    const t = await exchangeCode(String(code))
    const c = { env: ENV, realm_id: String(realmId), ...t }
    let name = null
    try { name = await companyName(c) } catch { /* the connection still works */ }
    // a different company than before: forget the matches from the old one
    const old = await table(`qbo_connection?env=eq.${ENV}&select=realm_id`)
    if (old && old[0] && old[0].realm_id !== String(realmId)) await table(`qbo_refs?env=eq.${ENV}`, { method: 'DELETE' })
    await table('qbo_connection?active=eq.true', { method: 'PATCH', body: JSON.stringify({ active: false }) })
    await upsert('qbo_connection', [{ ...c, active: true, company_name: name, connected_by: st.email, connected_at: new Date().toISOString(), last_error: null }], 'env')
    await table('events', { method: 'POST', body: JSON.stringify({ user_email: st.email, type: 'acct_connected', note: name, details: { env: ENV, realm: String(realmId), company: name } }) }).catch(() => {})
    return back(res, { qbo: 'connected' })
  } catch (e) {
    return back(res, { qbo: 'error', msg: String(e.message || e).slice(0, 300) })
  }
}
