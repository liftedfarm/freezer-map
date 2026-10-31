// METRC through T3, every minute (vercel.json cron): sends to-dos whose kind is on Auto, oldest first.
// Only when Compliance > Settings > METRC through T3 is Live. Needs CRON_SECRET (refuses to run without it).
import { isLive, missing, send, sendQueue, useSource } from './_t3.js'

export const config = { maxDuration: 300 }
const BUDGET_MS = 45000

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  if (missing().length) return send(res, 200, { skipped: `missing ${missing().join(', ')}` })
  useSource('worker')
  const t0 = Date.now()
  try {
    if (!(await isLive())) return send(res, 200, { skipped: 'dry run (not live)' })
    const ctx = { live: true, by: 'auto', deadline: t0 + BUDGET_MS }
    const { out } = await sendQueue(ctx, null, t0, BUDGET_MS)
    return send(res, 200, { sent: out.filter(x => x.state === 'sent').length, failed: out.filter(x => x.state === 'failed').length, waiting: out.filter(x => x.state === 'waiting').length, results: out })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
