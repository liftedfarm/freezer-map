// METRC through T3, from the app:
//   { action: 'test' }                      Compliance Admin: connection test
//   { action: 'probe', path, query }        Compliance Admin: read-only look at a T3 collection
//   { action: 'send', ids: [...] }          send (Live) or dry-run check to-dos
//   { action: 'checklist', load_id }        the METRC checklist for every pending stop of a load (Depart needs it green)
//   { action: 'depart', load_id }           after Depart: send the load's manifests now if those kinds are on Auto
//   { action: 'manifest_pdf', license, manifest } the METRC manifest PDF (base64)
//   { action: 'incoming', license? }        incoming METRC deliveries for our licenses (Distribution > Inbound)
//   { action: 'inbound_receive', license, delivery_id }  receive a delivery in METRC (Live) and bring it into the app
//   { action: 'tag_range', planting_id, purpose, count, first?, after?, save? }  plant tag runs for a planting:
//        suggest the next clean run (no first), check a run (first), or check and hold it for the planting (save)
import { asUser, caller, db, isLive, missing, rpc, runJob, send, t3, testConnection } from './_t3.js'
import { incoming, loadChecklist, receiveDelivery } from './_xfer.js'
import { enc, t3file, up } from './_core.js'
import { checkRun, suggestRun } from './_tagrange.js'

export const config = { maxDuration: 60 }

async function ours() {
  const conn = (await db('metrc_connection?id=eq.1&select=licenses'))?.[0]
  return (conn?.licenses ?? []).filter(l => l.in_t3 && l.site)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const miss = missing()
  if (miss.length) return send(res, 500, { error: `METRC sending isn't set up in Vercel yet. Missing: ${miss.join(', ')}` })
  const me = await caller(req)
  if (!me) return send(res, 403, { error: 'Sign in again' })
  const body = req.body || {}
  const t0 = Date.now()
  try {
    if (body.action === 'test') {
      if (!me.admin) return send(res, 403, { error: 'Only a Compliance Admin can test the METRC connection' })
      return send(res, 200, await testConnection(me.email))
    }
    if (body.action === 'probe') {
      if (!me.admin) return send(res, 403, { error: 'Only a Compliance Admin' })
      const path = String(body.path || '')
      if (!/^\/v2\/(packages|transfers|harvests|plants|plantbatches|items|licenses|locations|strains|tags)[a-z/-]*$/.test(path)) return send(res, 400, { error: 'Read paths only' })
      const j = await t3('GET', path, { query: body.query || {} })
      const rows = Array.isArray(j) ? j : j?.data ?? []
      return send(res, 200, { total: j?.total ?? rows.length, totalPages: j?.totalPages ?? null, keys: rows[0] ? Object.keys(rows[0]) : Object.keys(j ?? {}), first: rows[0] ?? (Array.isArray(j) ? null : j) })
    }
    if (body.action === 'send') {
      if (!me.can_send) return send(res, 403, { error: 'Only Compliance (or a Distribution / Processing Admin) can send to METRC' })
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 50)
      if (!ids.length) return send(res, 400, { error: 'Which to-dos?' })
      const live = await isLive()
      // flips to flowering are big: they go on the overnight run
      const night = (await db(`comp_metrc_actions?select=id&id=in.(${ids.join(',')})&kind=eq.flower`)).map(x => x.id)
      if (night.length) await asUser(req, 'metrc_queue_night', { p_ids: night })
      const jobs = await rpc('metrc_claim', { p_ids: ids.filter(i => !night.includes(i)), p_limit: ids.length })
      const ctx = { live, by: me.email, deadline: t0 + 45000 }
      const out = []
      for (const j of jobs.sort((a, b) => a.id - b.id)) {
        if (Date.now() - t0 > 50000) { await rpc('metrc_result', { p_id: j.id, p_state: 'waiting', p_by: me.email, p_request: null, p_response: null, p_error: 'Out of time: send again' }); out.push({ id: j.id, state: 'waiting', error: 'Out of time: send again' }); continue }
        out.push(await runJob(j, ctx))
      }
      for (const id of night) out.push({ id, state: 'waiting', info: 'Queued for tonight\'s run' })
      const skipped = ids.filter(id => !jobs.some(j => j.id === id) && !night.includes(id))
      return send(res, 200, { live, results: out, not_sent: skipped })
    }
    if (body.action === 'checklist') {
      const loadId = Number(body.load_id)
      if (!loadId) return send(res, 400, { error: 'Which load?' })
      return send(res, 200, { stops: await loadChecklist({ live: false, by: me.email }, loadId) })
    }
    if (body.action === 'depart') {
      const live = await isLive()
      const load = (await db(`loads?id=eq.${Number(body.load_id)}&select=code`))?.[0]?.code
      if (!live || !load) return send(res, 200, { live, results: [] })
      const auto = (await db('metrc_push_kinds?kind=in.(transfer,manifest)&mode=eq.auto&select=kind')).map(k => k.kind)
      if (!auto.length) return send(res, 200, { live, results: [] })
      const todo = await db(`comp_metrc_actions?select=id&details->>type=eq.stop_departed&details->>load=eq.${enc(load)}&kind=in.(${auto.join(',')})&status=in.(todo,error)`)
      const jobs = todo.length ? await rpc('metrc_claim', { p_ids: todo.map(x => x.id), p_limit: todo.length }) : []
      const ctx = { live, by: me.email, deadline: t0 + 45000 }
      const out = []
      for (const j of jobs.sort((a, b) => a.id - b.id)) out.push(await runJob(j, ctx))
      return send(res, 200, { live, results: out })
    }
    if (body.action === 'manifest_pdf') {
      // the manifest PDF straight from METRC, for any manifest one of our licenses shipped or received
      const lic = String(body.license || ''), man = String(body.manifest || '').replace(/\D/g, '')
      if (!lic || !man) return send(res, 400, { error: 'Which manifest?' })
      const ok = (await db('metrc_connection?id=eq.1&select=licenses'))?.[0]?.licenses?.some(l => l.license === lic && l.in_t3)
      if (!ok) return send(res, 400, { error: `${lic} isn't one of the licenses the app's METRC user can reach` })
      const f = await t3file('/v2/transfers/manifest', { licenseNumber: lic, manifestNumber: man })
      return send(res, 200, { manifest: man, license: lic, ...f })
    }
    if (body.action === 'incoming') {
      const lics = (await ours()).filter(l => !body.license || l.license === body.license)
      const out = []
      for (const l of lics) {
        if (Date.now() - t0 > 45000) break
        try { out.push(...(await incoming({}, l.license, true)).map(d => ({ ...d, site: l.site }))) }
        catch (e) { out.push({ license: l.license, site: l.site, error: e.message }) }
      }
      // what the app knows about each tag
      const tags = [...new Set(out.flatMap(d => (d.items ?? []).map(p => p.tag)))]
      const pal = tags.length ? await db(`pallets?select=id,code,status,package_tag,current_weight,received_site&package_tag=in.(${tags.map(enc).join(',')})`) : []
      for (const d of out) for (const p of d.items ?? []) {
        const m = pal.find(x => up(x.package_tag) === up(p.tag))
        if (m) p.app = { id: m.id, code: m.code, status: m.status, lbs: m.current_weight, site: m.received_site }
      }
      return send(res, 200, { live: await isLive(), deliveries: out })
    }
    if (body.action === 'inbound_receive') {
      if (!me.can_send) return send(res, 403, { error: 'Only Compliance (or a Distribution / Processing Admin) can receive in METRC' })
      const live = await isLive()
      const lic = String(body.license || '')
      const l = (await ours()).find(x => x.license === lic)
      if (!l) return send(res, 400, { error: 'Not one of our licenses' })
      const ds = await incoming({}, lic, true)
      const d = ds.find(x => Number(x.delivery_id) === Number(body.delivery_id))
      if (!d) return send(res, 404, { error: 'That delivery isn\'t waiting on this license any more (received already?)' })
      const ctx = { live, by: me.email }
      const { body: request } = await receiveDelivery(ctx, lic, d)
      if (!live) return send(res, 200, { live, ok: true, info: `Dry run OK: METRC would take manifest ${d.manifest} (${d.items.length} packages). Go Live to receive for real.` })
      const left = (await incoming({}, lic, false)).some(x => Number(x.delivery_id) === Number(d.delivery_id))
      if (left) return send(res, 200, { live, ok: false, info: 'Sent, but METRC still shows the delivery as incoming. Check it in METRC.' })
      const LBS = /^(lb|lbs|pound)/i
      const rows = d.items.map(p => ({ tag: p.tag, item: p.item, strain: p.strain, lbs: LBS.test(p.uom ?? '') ? Number(p.qty) : null }))
      const app = await rpc('inbound_apply', { p_site: l.site, p_license: lic, p_manifest: d.manifest, p_from: d.from, p_rows: rows, p_by: me.email })
      await db(`metrc_app_transfers?delivery_id=eq.${Number(d.delivery_id)}`, { method: 'PATCH', body: JSON.stringify({ state: 'received', received_at: new Date().toISOString(), received_by: me.email }), headers: { Prefer: 'return=minimal' } }).catch(() => {})
      const sibs = await db(`comp_metrc_actions?select=id&kind=eq.receive&status=in.(todo,error)&tag=in.(${d.items.map(p => enc(p.tag)).join(',')})`)
      if (sibs.length) await rpc('metrc_close_siblings', { p_ids: sibs.map(x => x.id), p_by: me.email, p_note: `Received manifest ${d.manifest} (Inbound)` })
      await db('events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_email: me.email, type: 'inbound_delivery',
        note: `Manifest ${d.manifest} from ${d.from}`, details: { license: lic, site: l.site, manifest: d.manifest, from: d.from, packages: d.items.length, request, app } }) }).catch(() => {})
      return send(res, 200, { live, ok: true, info: `Received manifest ${d.manifest} in METRC. App: ${app.in} back in, ${app.new} new, ${app.skipped} not pallets.`, app })
    }
    if (body.action === 'tag_range') {
      const purpose = body.purpose === 'flower' ? 'flower' : 'batch'
      const a = { plantingId: Number(body.planting_id), purpose, count: Number(body.count), first: body.first, after: body.after }
      if (!a.plantingId) return send(res, 400, { error: 'Which planting?' })
      if (!body.first) return send(res, 200, await suggestRun(a))
      const chk = await checkRun(a)
      if (!body.save || !chk.ok) return send(res, 200, chk)
      const held = await asUser(req, 'tag_assign', { p_planting: a.plantingId, p_purpose: purpose, p_first: chk.first, p_count: chk.count })
      return send(res, 200, { ...chk, saved: true, held })
    }
    return send(res, 400, { error: 'Unknown action' })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
