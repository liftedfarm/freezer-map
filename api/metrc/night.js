// METRC through T3, overnight (vercel.json cron, ~2am California): the big jobs. Flips to flowering promote thousands of
// immature plants with plant tags, a piece at a time; what's left continues the next night. Live only. Needs CRON_SECRET.
import { isLive, missing, rpc, runJob, send } from './_t3.js'

export const config = { maxDuration: 300 }
const BUDGET_MS = 270000

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  if (missing().length) return send(res, 200, { skipped: `missing ${missing().join(', ')}` })
  const t0 = Date.now()
  try {
    if (!(await isLive())) return send(res, 200, { skipped: 'dry run (not live)' })
    const out = []
    for (;;) {
      if (Date.now() - t0 > BUDGET_MS - 20000) break
      const jobs = await rpc('metrc_claim_night', { p_limit: 1 })
      if (!jobs.length) break
      out.push(await runJob(jobs[0], { live: true, by: 'overnight', deadline: t0 + BUDGET_MS - 15000 }))
      if (out[out.length - 1].state === 'waiting') break   // out of time (or tags): the rest goes tomorrow night
    }
    return send(res, 200, { results: out })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
