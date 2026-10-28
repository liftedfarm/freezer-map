// Every 10 minutes (vercel.json cron): send invoices to QuickBooks 30 minutes after they were made (editing restarts the clock).
// If CRON_SECRET is set in Vercel, Vercel sends it and anything else is turned away.
import { ENV, autoPush, connection, missingSetup, send, table } from './_lib.js'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  if (missingSetup().length) return send(res, 200, { skipped: 'not set up' })
  let c
  try { c = await connection() } catch (e) { return send(res, 200, { skipped: e.message }) }
  try { return send(res, 200, { env: ENV, ...(await autoPush(c)) }) }
  catch (e) {
    await table(`qbo_connection?env=eq.${ENV}`, { method: 'PATCH', body: JSON.stringify({ last_error: String(e.message || e).slice(0, 500) }) }).catch(() => {})
    return send(res, 500, { error: String(e.message || e) })
  }
}
