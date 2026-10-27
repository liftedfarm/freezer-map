// METRC through T3, from the app: { action: 'test' } (Compliance Admin) or { action: 'send', ids: [...] }.
// Send = Dry run check while Compliance > Settings has Dry run on; a real send once it's Live.
import { caller, isLive, missing, rpc, runJob, send, testConnection } from './_t3.js'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const miss = missing()
  if (miss.length) return send(res, 500, { error: `METRC sending isn't set up in Vercel yet. Missing: ${miss.join(', ')}` })
  const me = await caller(req)
  if (!me) return send(res, 403, { error: 'Sign in again' })
  const body = req.body || {}
  try {
    if (body.action === 'test') {
      if (!me.admin) return send(res, 403, { error: 'Only a Compliance Admin can test the METRC connection' })
      return send(res, 200, await testConnection(me.email))
    }
    if (body.action === 'send') {
      if (!me.can_send) return send(res, 403, { error: 'Only Compliance (or a Distribution / Processing Admin) can send to METRC' })
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 50)
      if (!ids.length) return send(res, 400, { error: 'Which to-dos?' })
      const live = await isLive()
      const jobs = await rpc('metrc_claim', { p_ids: ids, p_limit: ids.length })
      const ctx = { live, by: me.email, reasons: {} }
      const out = []
      for (const j of jobs.sort((a, b) => a.id - b.id)) out.push(await runJob(j, ctx))
      const skipped = ids.filter(id => !jobs.some(j => j.id === id))
      return send(res, 200, { live, results: out, not_sent: skipped })
    }
    return send(res, 400, { error: 'Unknown action' })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
