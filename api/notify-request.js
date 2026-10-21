// Emails staff when a customer asks to change a reserve (to Admins) or places an order (to Sales and Admins).
// Needs RESEND_API_KEY in Vercel (Settings > Environment Variables). Without it, nothing is sent.
// Optional: NOTIFY_FROM (default "Lifted Orders <orders@lifted-orders.app>"), STAFF_APP_URL.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const lbs = n => Number(n ?? 0).toLocaleString('en-US')
const wrap = body => `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${body}</div>`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const key = process.env.RESEND_API_KEY
  if (!key) return res.status(200).json({ sent: false, reason: 'email not set up' })
  const url = process.env.VITE_SUPABASE_URL, anon = process.env.VITE_SUPABASE_ANON_KEY
  const auth = req.headers.authorization || ''
  const body = req.body || {}
  const id = Number(body.id), kind = body.kind === 'order' ? 'order' : 'reserve'
  if (!url || !anon || !auth.startsWith('Bearer ') || !id) return res.status(400).json({ error: 'bad request' })

  // the database only answers for the person who made the request or order, once
  const r = await fetch(`${url}/rest/v1/rpc/${kind === 'order' ? 'order_notification' : 'request_notification'}`, {
    method: 'POST', headers: { apikey: anon, Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id }),
  })
  if (!r.ok) return res.status(400).json({ error: 'not allowed' })
  const q = await r.json()
  const to = kind === 'order' ? q && q.to : q && q.admins
  if (!q || !to || !to.length) return res.status(200).json({ sent: false })

  const app = process.env.STAFF_APP_URL || 'https://freezer-map-8i3h.vercel.app'
  const who = q.by_name ? `${q.by_name} (${q.by})` : q.by
  let subject, html
  if (kind === 'order') {
    const total = (q.lines || []).reduce((a, l) => a + Number(l.lbs), 0)
    const rows = (q.lines || []).map(l => `<tr><td style="padding:2px 12px 2px 0">${esc(l.strain)}</td><td style="text-align:right">${lbs(l.lbs)} lbs</td><td style="text-align:right;padding-left:12px">${l.price != null ? '$' + Number(l.price).toFixed(2) + '/lb' : ''}</td></tr>`).join('')
    subject = `New order: ${q.customer} · ${lbs(total)} lbs`
    html = wrap(`<p><b>${esc(q.customer)}</b> placed an order for ${lbs(total)} lbs.</p>
      <table style="border-collapse:collapse">${rows}</table>
      <p>Placed by ${esc(who)}${q.po ? `<br>PO: ${esc(q.po)}` : ''}${q.wanted ? `<br>Wanted by: ${esc(q.wanted)}` : ''}${q.note ? `<br>Note: "${esc(q.note)}"` : ''}</p>
      <p><a href="${esc(app)}/?go=orders">Review and confirm in the Freezer Map</a> (Reserves &gt; Orders).</p>`)
  } else {
    const up = Number(q.to) > Number(q.from)
    const what = Number(q.from) === 0 ? `add ${lbs(q.to)} lbs of ${q.strain}` : Number(q.to) === 0 ? `drop their ${lbs(q.from)} lbs of ${q.strain}`
      : `${up ? 'raise' : 'lower'} ${q.strain} from ${lbs(q.from)} to ${lbs(q.to)} lbs`
    subject = `Reserve request: ${q.customer} · ${q.strain} ${lbs(q.from)} → ${lbs(q.to)} lbs`
    html = wrap(`<p><b>${esc(q.customer)}</b> wants to ${esc(what)}.</p>
      <p>Requested by ${esc(who)}${q.note ? `<br>Note: "${esc(q.note)}"` : ''}</p>
      <p><a href="${esc(app)}/?go=requests">Approve or decline in the Freezer Map</a> (Reserves &gt; Requests). Only an Admin can approve.</p>`)
  }
  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM || 'Lifted Orders <orders@lifted-orders.app>', to, subject, html }),
  })
  return res.status(200).json({ sent: send.ok })
}
