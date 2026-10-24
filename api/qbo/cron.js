// Hourly 7am-7pm Pacific, Mon-Sat (vercel.json crons, in UTC): pull paid / balance for invoices in QuickBooks.
// If CRON_SECRET is set in Vercel, Vercel sends it and anything else is turned away.
import { ENV, connection, missingSetup, send, syncBalances, syncCustomers, table } from './_lib.js'

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  if (missingSetup().length) return send(res, 200, { skipped: 'not set up' })
  let c
  try { c = await connection() } catch (e) { return send(res, 200, { skipped: e.message }) }
  try {
    const inv = await syncBalances(c)
    // customer balances for the dashboards; never let it stop the invoice check (needs 060)
    let cust
    try { cust = await syncCustomers(c) } catch (e) { cust = { customers_error: String(e.message || e).slice(0, 300) } }
    return send(res, 200, { env: ENV, ...inv, ...cust })
  }
  catch (e) {
    await table(`qbo_connection?env=eq.${ENV}`, { method: 'PATCH', body: JSON.stringify({ last_error: String(e.message || e).slice(0, 500) }) }).catch(() => {})
    return send(res, 500, { error: String(e.message || e) })
  }
}
