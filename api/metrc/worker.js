// METRC through T3, every 5 minutes (vercel.json cron): sends to-dos whose kind is on Auto, oldest first.
// Only when Compliance > Settings > METRC through T3 is Live. Needs CRON_SECRET (refuses to run without it).
import { isLive, missing, rpc, runJob, send } from './_t3.js'

export const config = { maxDuration: 60 }
const BUDGET_MS = 45000

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  if (missing().length) return send(res, 200, { skipped: `missing ${missing().join(', ')}` })
  const t0 = Date.now()
  try {
    if (!(await isLive())) return send(res, 200, { skipped: 'dry run (not live)' })
    const jobs = await rpc('metrc_claim', { p_ids: null, p_limit: 40 })
    const ctx = { live: true, by: 'auto', deadline: t0 + BUDGET_MS }
    const out = []
    for (const j of jobs.sort((a, b) => a.id - b.id)) {
      if (Date.now() - t0 > BUDGET_MS) {   // out of time: hand the rest back for the next run
        await rpc('metrc_result', { p_id: j.id, p_state: 'waiting', p_by: 'auto', p_request: null, p_response: null, p_error: 'Next run' }).catch(() => {})
        continue
      }
      out.push(await runJob(j, ctx))
    }
    return send(res, 200, { sent: out.filter(x => x.state === 'sent').length, failed: out.filter(x => x.state === 'failed').length, waiting: out.filter(x => x.state === 'waiting').length, results: out })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
