// Accounting > Settings > Connect QuickBooks: returns the Intuit sign-in page to send the browser to.
import { randomBytes } from 'node:crypto'
import { ENV, authorizeUrl, caller, missingSetup, send, table } from './_lib.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const miss = missingSetup()
  if (miss.length) return send(res, 500, { error: `QuickBooks isn't set up in Vercel yet. Missing: ${miss.join(', ')}` })
  const me = await caller(req)
  if (!me || !me.admin || me.viewing_as) return send(res, 403, { error: 'Only an Accounting Admin can connect QuickBooks' })
  const state = randomBytes(24).toString('hex')
  // old unfinished sign-ins expire after 15 minutes
  await table(`qbo_oauth_states?created_at=lt.${new Date(Date.now() - 15 * 60000).toISOString()}`, { method: 'DELETE' }).catch(() => {})
  await table('qbo_oauth_states', { method: 'POST', body: JSON.stringify({ state, email: me.email, env: ENV }) })
  return send(res, 200, { url: authorizeUrl(state), env: ENV })
}
