// METRC through T3, from the app:
//   { action: 'test' }                      Compliance Admin: connection test
//   { action: 'probe', path, query }        Compliance Admin: read-only look at a T3 collection
//   { action: 'send', ids: [...] }          send (Live) or dry-run check to-dos
//   { action: 'checklist', load_id }        the METRC checklist for every pending stop of a load (Depart needs it green)
//   { action: 'depart', load_id }           Depart: checks, the METRC manifests first, then the load leaves and invoices are made
//   { action: 'nursery_ship', ref }         the nursery's Ship: the METRC transfer now (taken back if METRC refuses)
//   { action: 'manifest_pdf', license, manifest } the METRC manifest PDF (base64)
//   { action: 'incoming', license?, module? } incoming METRC deliveries for our licenses (Inbound / Receiving per module)
//   { action: 'inbound_receive', license, delivery_id }  receive a delivery in METRC (Live) and bring it into the app
//   { action: 'kick' }                      right after a save in the app: send to-dos that are ready (Auto kinds, Live only)
//   { action: 'package_weight', pallet_id }  TEMPORARY (114): what METRC shows right now for a pallet's tag (pallet card)
//   { action: 'tag_range', planting_id, purpose, count, first?, after?, save? }  plant tag runs for a planting:
//        suggest the next clean run (no first), check a run (first), or check and hold it for the planting (save)
import { sendQueue, asUser, caller, db, isLive, missing, rpc, runJob, send, t3, testConnection } from './_t3.js'
import { incoming, loadChecklist, receiveDelivery } from './_xfer.js'
import { enc, packageAnywhere, t3file, up } from './_core.js'
import { checkRun, suggestRun } from './_tagrange.js'

export const config = { maxDuration: 300 }

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
      const ctx = { live, by: me.email, deadline: t0 + 45000 }
      const q = await sendQueue(ctx, ids, t0, 45000)
      const left = ids.filter(id => !q.tried.includes(id))
      return send(res, 200, { live, results: q.out, not_sent: q.timedOut ? [] : left, out_of_time: q.timedOut ? left : [] })
    }
    if (body.action === 'kick') {
      if (!(await isLive())) return send(res, 200, { live: false, results: [] })
      const ctx = { live: true, by: 'auto', deadline: t0 + 45000 }
      const q = await sendQueue(ctx, null, t0, 45000)
      return send(res, 200, { live: true, results: q.out })
    }
    if (body.action === 'checklist') {
      const loadId = Number(body.load_id)
      if (!loadId) return send(res, 400, { error: 'Which load?' })
      return send(res, 200, { stops: await loadChecklist({ live: false, by: me.email }, loadId) })
    }
    if (body.action === 'depart') {
      // Depart: the checks and the Departing state (as the user), the METRC manifests, then the load leaves and invoices are made.
      // Any manifest that fails: nothing leaves; the load stays Departing until it's fixed (Depart again) or sent back to loading.
      const loadId = Number(body.load_id)
      if (!loadId) return send(res, 400, { error: 'Which load?' })
      const live = await isLive()
      const prep = await asUser(req, 'depart_prepare', { p_load: loadId })
      const ids = (prep.todo ?? []).map(Number).filter(Boolean)
      const out = []
      if (ids.length) {
        const jobs = await rpc('metrc_claim', { p_ids: ids, p_limit: ids.length })
        const ctx = { live, by: me.email, deadline: t0 + 200000 }
        for (const j of jobs.sort((a, b) => a.id - b.id)) out.push(await runJob(j, ctx))
        // any the background worker picked up first: wait for it (up to 90 s)
        const mine = new Set(jobs.map(j => j.id))
        const others = ids.filter(id => !mine.has(id))
        for (let k = 0; others.length && k < 30; k++) {
          const st = await db(`comp_metrc_actions?select=id,status,push_state&id=in.(${others.join(',')})`)
          if (!st.some(x => x.push_state === 'sending' || (x.status === 'todo' && !x.push_state))) break
          await new Promise(r => setTimeout(r, 3000))
        }
      }
      const failed = out.filter(r => r.state !== 'sent' && r.state !== 'checked').map(r => `to-do #${r.id}: ${r.error ?? r.info ?? r.state}`)
      try {
        const fin = await asUser(req, 'depart_finish', { p_load: loadId })
        if (fin?.departed === false) return send(res, 200, { live, results: out, ...fin, error: failed.length ? failed.join(' | ') : fin.error })
        return send(res, 200, { live, departed: true, results: out, ...fin })
      } catch (e) {
        return send(res, 200, { live, departed: false, results: out, error: failed.length ? failed.join(' | ') : String(e.message || e) })
      }
    }
    if (body.action === 'nursery_ship') {
      // the nursery's Ship: make the METRC transfer right away; if METRC refuses it, the delivery is taken back (nothing left)
      if (!me.can_ship_nursery) return send(res, 403, { error: 'Only the Nursery can ship' })
      const ref = String(body.ref || '')
      if (!/^[0-9a-f-]{36}$/i.test(ref)) return send(res, 400, { error: 'Which delivery?' })
      const live = await isLive()
      const mode = (await db('metrc_push_kinds?kind=eq.transfer&select=mode'))?.[0]?.mode ?? 'off'
      const todo = await db(`comp_metrc_actions?select=id&details->>type=eq.nursery_shipped&details->>ref=eq.${enc(ref)}&status=in.(todo,error)`)
      if (mode === 'off' || !todo.length) return send(res, 200, { live, sent: false, info: 'METRC transfers are Off: make the transfer in METRC by hand (it\'s on the to-do list).' })
      const jobs = await rpc('metrc_claim', { p_ids: todo.map(x => x.id), p_limit: todo.length })
      const ctx = { live, by: me.email, deadline: t0 + 200000 }
      const out = []
      for (const j of jobs) out.push(await runJob(j, ctx))
      const bad = out.find(r => r.state !== 'sent' && r.state !== 'checked')
      if (bad) {
        await rpc('nursery_ship_undo', { p_ref: ref, p_by: me.email, p_reason: bad.error ?? bad.info ?? bad.state })
        return send(res, 200, { live, sent: false, undone: true, error: bad.error ?? bad.info ?? bad.state })
      }
      return send(res, 200, { live, sent: true, results: out })
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
      // module: 'distribution' (product packages), 'cultivation' (plants to OHR / GVR farms), 'nursery' (anything to 1PN)
      const mod = ['cultivation', 'nursery', 'distribution'].includes(body.module) ? body.module : null
      const lics = (await ours()).filter(l => (!body.license || l.license === body.license) && (!mod || mod === 'distribution' || (mod === 'nursery' ? l.site === '1PN' : l.site !== '1PN')))
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
      const isPlants = d => (d.items ?? []).length > 0 && (d.items ?? []).every(p => !/^(lb|lbs|pound|g|gram|kg|oz)/i.test(p.uom ?? '') || /clone|immature|seed|plant/i.test(p.item ?? ''))
      const keep = out.filter(d => d.error || !mod || (mod === 'nursery' ? d.site === '1PN'
        : mod === 'cultivation' ? d.site !== '1PN' && isPlants(d) : d.site !== '1PN' && !isPlants(d)))
      for (const d of keep) d.plants = isPlants(d)
      return send(res, 200, { live: await isLive(), deliveries: keep })
    }
    if (body.action === 'inbound_receive') {
      const lic0 = String(body.license || '')
      const l0 = (await ours()).find(x => x.license === lic0)
      const okRecv = me.can_send || (l0?.site === '1PN' ? me.can_receive_nursery : me.can_receive_plants && body.module === 'cultivation')
      if (!okRecv) return send(res, 403, { error: 'Only Compliance, a Distribution / Processing Admin, or the module the delivery is for can receive in METRC' })
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
    if (body.action === 'package_weight') {
      // TEMPORARY (114, remove once the app and METRC are in sync): live METRC weight for the pallet card.
      // pallet_metrc_weight runs as the caller, so only staff get through; it also gives the tag and license.
      const w = await asUser(req, 'pallet_metrc_weight', { p_pallet_id: Number(body.pallet_id) })
      if (!w?.tag) return send(res, 200, { tag: null })
      const hit = await packageAnywhere(w.license, w.tag)
      if (!hit) return send(res, 200, { tag: w.tag, license: w.license, found: false })
      const p = hit.p
      return send(res, 200, { tag: w.tag, license: w.license, found: true, state: hit.state, qty: p.quantity ?? p.shippedQuantity ?? null,
                              uom: p.unitOfMeasureAbbreviation ?? p.shippedUnitOfMeasureAbbreviation ?? null, item: p.item?.name ?? p.productName ?? null,
                              last_modified: p.lastModified ?? null })
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
