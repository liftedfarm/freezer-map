// Emails the admins when a customer asks to change a reserve.
// Needs RESEND_API_KEY in Vercel (Settings > Environment Variables). Without it, nothing is sent.
// Optional: NOTIFY_FROM (default "Lifted Orders <orders@lifted-orders.app>"), STAFF_APP_URL.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const lbs = n => Number(n ?? 0).toLocaleString('en-US')

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const key = process.env.RESEND_API_KEY
  if (!key) return res.status(200).json({ sent: false, reason: 'email not set up' })
  const url = process.env.VITE_SUPABASE_URL, anon = process.env.VITE_SUPABASE_ANON_KEY
  const auth = req.headers.authorization || ''
  const id = Number((req.body || {}).id)
  if (!url || !anon || !auth.startsWith('Bearer ') || !id) return res.status(400).json({ error: 'bad request' })

  // the database only answers for the person who made the request, once
  const r = await fetch(`${url}/rest/v1/rpc/request_notification`, {
    method: 'POST', headers: { apikey: anon, Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id }),
  })
  if (!r.ok) return res.status(400).json({ error: 'not allowed' })
  const q = await r.json()
  if (!q || !q.admins || !q.admins.length) return res.status(200).json({ sent: false })

  const up = Number(q.to) > Number(q.from)
  const what = Number(q.from) === 0 ? `add ${lbs(q.to)} lbs of ${q.strain}` : Number(q.to) === 0 ? `drop their ${lbs(q.from)} lbs of ${q.strain}`
    : `${up ? 'raise' : 'lower'} ${q.strain} from ${lbs(q.from)} to ${lbs(q.to)} lbs`
  const app = process.env.STAFF_APP_URL || 'https://freezer-map-8i3h.vercel.app'
  const who = q.by_name ? `${q.by_name} (${q.by})` : q.by
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">
    <p><b>${esc(q.customer)}</b> wants to ${esc(what)}.</p>
    <p>Requested by ${esc(who)}${q.note ? `<br>Note: "${esc(q.note)}"` : ''}</p>
    <p><a href="${esc(app)}/?go=requests">Approve or decline in the Freezer Map</a> (Reserves &gt; Requests). Only an Admin can approve.</p></div>`
  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || 'Lifted Orders <orders@lifted-orders.app>',
      to: q.admins, subject: `Reserve request: ${q.customer} · ${q.strain} ${lbs(q.from)} → ${lbs(q.to)} lbs`, html,
    }),
  })
  return res.status(200).json({ sent: send.ok })
}
