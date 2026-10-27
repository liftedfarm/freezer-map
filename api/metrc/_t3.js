// METRC through T3: the connection test and runJob (one to-do, sent or dry-run checked). Plumbing is in _core.js,
// the senders in _pkg.js (packages), _xfer.js (transfers, manifests, receiving) and _plants.js (nursery, plantings, harvests).
import { Skip, Wait, adjustReasons, all, db, enc, list, rpc, t3 } from './_core.js'
import { sendAdjust, sendCombine, sendFinish, sendNewPackageCheck, sendShipCheck, sendSplit, sendTagCheck } from './_pkg.js'
import { sendReceive, sendTransfer_ } from './_xfer.js'
import {
  sendFlower, sendHarvestFinish, sendHarvestPackage, sendHarvestPlants, sendHarvestWaste, sendNurseryClones, sendNurseryLoss,
  sendNurseryMothers, sendPlantLoss, sendPlanting,
} from './_plants.js'

export { asUser, caller, db, isLive, missing, rpc, send, setting, t3 } from './_core.js'

// ---------- connection test ----------
export async function testConnection(by) {
  const out = { ok: false, tested_at: new Date().toISOString(), tested_by: by, who: null, licenses: [], reasons: {}, transfer: {}, error: null }
  try {
    out.who = await t3('GET', '/v2/auth/whoami').catch(e => ({ error: e.message }))
    const t3lics = list(await t3('GET', '/v2/licenses'))
    const ours = await db('licenses?select=license_no,kind,site,active&active=eq.true')
    const nurs = await db('nursery_sites?select=code,license&active=eq.true').catch(() => [])
    const want = ours.filter(l => l.kind !== 'transport' && l.site)
    const nums = new Set([...t3lics.map(l => l.licenseNumber), ...want.map(l => l.license_no)])
    for (const n of nums) {
      const t = t3lics.find(l => l.licenseNumber === n)
      const app = ours.find(l => l.license_no === n)
      const row = { license: n, name: t?.licenseName ?? null, in_t3: !!t, in_app: !!app, site: app?.site ?? nurs.find(x => x.license === n)?.code ?? null, permissions: [] }
      if (t) {
        try { out.reasons[n] = await adjustReasons(n) } catch (e) { row.reasons_error = e.message }
        try {
          const ti = await t3('GET', '/v2/transfers/create/inputs', { query: { licenseNumber: n } })
          out.transfer[n] = {
            types: (ti?.transferTypes ?? []).map(x => ({ id: x.id, name: x.name, wholesale: /wholesale/i.test(`${x.transactionType ?? ''} ${x.transactionTypeName ?? ''}`) })),
            drivers: (ti?.drivers ?? []).filter(x => !x.isArchived).map(x => x.name),
            vehicles: (ti?.vehicles ?? []).filter(x => !x.isArchived).map(x => [x.make, x.model, x.licensePlateNumber].filter(Boolean).join(' ')),
            phone: ti?.defaultPhoneNumberForQuestions ?? null,
          }
        } catch (e) { row.transfer_error = e.message }
      }
      out.licenses.push(row)
    }
    const miss = out.licenses.filter(l => l.in_app && !l.in_t3)
    out.ok = t3lics.length > 0 && miss.length === 0
    if (!t3lics.length) out.error = 'T3 answered, but the METRC user behind the key sees no licenses'
    else if (miss.length) out.error = `The METRC user can't see ${miss.map(l => `${l.site} ${l.license}`).join(', ')}. Add it to those licenses in METRC, then make a new T3 secret key.`
  } catch (e) {
    out.error = e.status === 401 || e.status === 403 ? `T3 refused the key (${e.status}). Make a new secret key on T3's secret-key page and update T3_SECRET_KEY in Vercel. ${e.message}` : e.message
  }
  const { transfer, ...rest } = out
  await db('metrc_connection?id=eq.1', { method: 'PATCH', body: JSON.stringify({ ...rest, transfer }), headers: { Prefer: 'return=minimal' } })
  return out
}

// ---------- senders, one per kind ----------
const SENDERS = {
  adjust: sendAdjust, split: sendSplit, combine: sendCombine, finish: sendFinish, tag: sendTagCheck, new_package: sendNewPackageCheck,
  transfer: sendTransfer_, manifest: sendTransfer_, ship_check: sendShipCheck, receive: sendReceive,
  nursery_clones: sendNurseryClones, nursery_mothers: sendNurseryMothers, nursery_loss: sendNurseryLoss,
  planting: sendPlanting, plant_loss: sendPlantLoss, flower: sendFlower,
  harvest_plants: sendHarvestPlants, harvest_package: sendHarvestPackage, harvest_waste: sendHarvestWaste, harvest_finish: sendHarvestFinish,
}
export const canSend = kind => !!SENDERS[kind]
const VERIFY = new Set(['tag', 'new_package', 'ship_check'])   // checks: they never change METRC

/** what has to be done in METRC before this one */
async function earlier(job) {
  const tags = (job.touch_tags ?? []).filter(Boolean)
  // a stop's transfer waits for the package steps (its planner says which); receiving and ship checks don't hold anything up
  if (tags.length && !['transfer', 'manifest', 'receive', 'ship_check'].includes(job.kind)) {
    const e = await db(`comp_metrc_actions?select=id,action&touch_tags=ov.{${tags.map(enc).join(',')}}&status=in.(todo,error)&id=lt.${job.id}` +
      `&kind=not.in.(ship_check,receive)&order=id&limit=1`)
    if (e?.length) return e[0]
  }
  const hid = job.details?.harvest_id
  if (hid && /^harvest_/.test(job.kind)) {
    const e = await db(`comp_metrc_actions?select=id,action&details->>harvest_id=eq.${enc(String(hid))}&kind=like.harvest_*&status=in.(todo,error)&id=lt.${job.id}&order=id&limit=1`)
    if (e?.length) return e[0]
  }
  const pid = job.details?.planting_id
  if (pid && ['plant_loss', 'flower'].includes(job.kind)) {
    const e = await db(`comp_metrc_actions?select=id,action&details->>planting_id=eq.${enc(String(pid))}&kind=in.(planting,plant_loss,flower)&status=in.(todo,error)&id=lt.${job.id}&order=id&limit=1`)
    if (e?.length) return e[0]
  }
  if (job.kind === 'nursery_mothers' && job.details?.batch_id) {
    const e = await db(`comp_metrc_actions?select=id,action&details->>batch_id=eq.${enc(String(job.details.batch_id))}&kind=eq.nursery_clones&status=in.(todo,error)&id=lt.${job.id}&limit=1`)
    if (e?.length) return e[0]
  }
  return null
}

/** run one claimed job; never throws */
export async function runJob(job, ctx) {
  const by = ctx.by
  try {
    if (!SENDERS[job.kind]) throw new Error(`The app can't send "${job.kind}" yet`)
    const e = await earlier(job)
    if (e) throw new Wait(`Waiting on an earlier to-do: #${e.id} ${e.action}`)
    const r = await SENDERS[job.kind](job, ctx)
    await rpc('metrc_result', { p_id: job.id, p_state: r.state, p_by: by, p_request: r.request ?? null, p_response: r.response ?? null, p_error: r.info ?? null })
    if (r.state === 'sent' && r.siblings?.length) await rpc('metrc_close_siblings', { p_ids: r.siblings, p_by: by, p_note: `With #${job.id}: ${r.info ?? ''}` })
    return { id: job.id, state: r.state, info: r.info }
  } catch (e) {
    if (e instanceof Skip) {
      // a check that passed, or METRC already shows it: done when Live (a dry run only notes it)
      const st = ctx.live || VERIFY.has(job.kind) ? 'sent' : 'checked'
      await rpc('metrc_result', { p_id: job.id, p_state: st, p_by: by, p_request: null, p_response: null, p_error: e.message })
      return { id: job.id, state: st, info: e.message }
    }
    const state = e instanceof Wait ? 'waiting' : 'failed'
    await rpc('metrc_result', { p_id: job.id, p_state: state, p_by: by, p_request: null, p_response: e.body ?? null, p_error: e.message }).catch(() => {})
    return { id: job.id, state, error: e.message }
  }
}
