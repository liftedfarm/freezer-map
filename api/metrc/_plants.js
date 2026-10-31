// Phase 2 senders: nursery (clone packages from mother lots, mother lots from clone packages, losses), farm plantings,
// losses, the flip to flowering (overnight, plant tags), and the harvest chain (harvest plants, packages from harvest, waste, finish).
// Every one of these waits for its site's cutover date (Compliance > METRC > Mapping); before that they're done by hand.
import {
  WRITE_MAX, Held, Skip, Wait, all, db, enc, first, inputs, list, lc, mappedLocation, one, packageByTag, r4, reasonFrom, rpc, setting, strainFor,
  t3, tagIdFor, uomFrom, up, write, ymd, adjustReasons,
} from './_core.js'
import { heldRun } from './_tagrange.js'

const day = (v, job) => (v ? String(v).slice(0, 10) : ymd(job.at))
const progressOf = job => ({ ...(job.push_response?.progress ?? {}) })
const saveProgress = (job, p) => rpc('metrc_progress', { p_id: job.id, p_progress: p })
/** Stop pressed on this to-do (checked between batches of a long send) */
const stopAsked = async job => !!(await one(`comp_metrc_actions?id=eq.${job.id}&select=stop_requested`).catch(() => null))?.stop_requested

async function plantBatch(license, name, path = '/v2/plantbatches/active') {
  for (const f of [`name__eq:${name}`, `label__eq:${up(name)}`]) {
    const b = await first(path, { licenseNumber: license, filter: f }).catch(() => null)
    if (b && (lc(b.name) === lc(name) || up(b.label) === up(name))) return b
  }
  return null
}
async function harvestByName(license, name, path = '/v2/harvests/active') {
  const h = await first(path, { licenseNumber: license, filter: `name__eq:${name}` }).catch(() => null)
  return h && lc(h.name) === lc(name) ? h : null
}
const isCount = p => /count/i.test(p.unitOfMeasureQuantityType ?? '') || /^(ea|each)$/i.test(p.unitOfMeasureAbbreviation ?? '')
const strainMatch = (txt, strain) => lc(txt).includes(lc(strain))

// ---------- nursery ----------
/** a cutting event: one clone package per strain, cut from the strain's mother lot (doesn't lower the lot's count) */
export async function sendNurseryClones(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const b = await one(`nursery_batches?id=eq.${Number(d.batch_id)}&select=*`)
  if (!b) throw new Error('The cutting batch is gone from the app')
  const tag = up(b.package_tag)
  if (!tag) throw new Wait('Give the cutting batch its clone package tag (Nursery > Batches), then send')
  if (await packageByTag(lic, tag)) throw new Skip(`METRC already has ${tag}`)
  let lots = []
  if (b.mother_id) lots = (await db(`nursery_mothers?id=eq.${b.mother_id}&select=plant_tag`)).map(m => m.plant_tag)
  if (!lots.filter(Boolean).length) lots = (await db(`nursery_mothers?site=eq.${enc(b.site)}&strain=eq.${enc(b.strain)}&status=eq.active&plant_tag=not.is.null&select=plant_tag&order=started_on.desc`)).map(m => m.plant_tag)
  let lot = null
  for (const t of lots.filter(Boolean)) { lot = await plantBatch(lic, t, '/v2/plantbatches/create/packages/source-plantbatches'); if (lot) break }
  if (!lot) throw new Error(`No ${b.strain} mother lot in METRC on ${lic} to cut from (looked for ${lots.filter(Boolean).join(', ') || 'mothers with a plant tag'})`)
  const items = await all('/v2/plantbatches/create/packages/source-items', { licenseNumber: lic }, 5)
  // the strain's own clone item the app made (132: 1PN (FL27WB) - Strain - Clone, or the code when coded), else any clone item for the strain
  const mine = await rpc('nursery_metrc_item', { p_strain: b.strain, p_license: lic, p_on: day(b.cut_on, job), p_finish: 'CL' }).catch(() => null)
  const item = (mine?.id ? items.find(i => i.id === mine.id) : null)
    ?? items.find(i => lc(i.strainName) === lc(b.strain) && /clone/i.test(i.name)) ?? items.find(i => strainMatch(i.name, b.strain) && /clone/i.test(i.name))
  if (!item) throw new Error(`No METRC clone item for ${b.strain} on ${lic}. Make "${b.strain} - Clone" (or similar) in METRC.`)
  const tagId = await tagIdFor(ctx, lic, '/v2/plantbatches/create/packages/source-tags', tag)
  const body = [{ plantBatchId: lot.id, count: Number(b.cuttings), itemId: item.id, tagId, actualDate: day(b.cut_on, job), isFromMotherPlant: true,
                  note: `Lifted app cutting batch ${b.name ?? b.id}`.slice(0, 250) }]
  const resp = await write(ctx, '/v2/plantbatches/create/packages', lic, body)
  const what = `${tag}: ${b.cuttings} ${b.strain} clones from mother lot ${lot.name ?? lot.label} (${item.name})`
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${what}` }
  if (!await packageByTag(lic, tag)) throw new Error(`Sent, but METRC doesn't show ${tag} yet. Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC: ${what}` }
}

/** mothers planted from a clone package: an immature plant batch (a mother lot, up to 100) named by its plant tag */
export async function sendNurseryMothers(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const qty = Number(d.qty)
  if (qty > 100) throw new Error(`A mother lot holds up to 100 plants (this one is ${qty}). Split it into lots in the app.`)
  const m = await one(`nursery_mothers?id=eq.${Number(d.mother_id)}&select=plant_tag,room_id,started_on,qty`)
  const lotTag = up(m?.plant_tag ?? d.lot_tag)
  if (!lotTag) throw new Wait('Give the mother lot its plant tag (Nursery > Mothers), then send')
  if (await plantBatch(lic, lotTag)) throw new Skip(`METRC already has mother lot ${lotTag}`)
  const b = await one(`nursery_batches?id=eq.${Number(d.batch_id)}&select=package_tag`)
  const src = up(b?.package_tag ?? d.source_tag)
  if (!src) throw new Wait('The cutting batch has no clone package tag yet')
  const p = await packageByTag(lic, src)
  if (!p) throw new Wait(`Clone package ${src} isn't active on ${lic} yet (its own to-do goes first)`)
  const inp = await inputs(ctx, lic, '/v2/plantbatches/create/from-packages/inputs')
  const type = (inp.plantBatchTypes ?? []).find(t => /clone/i.test(t.name))
  if (!type) throw new Error('METRC has no Clone plant batch type here')
  const strain = await strainFor(d.strain, lic)
  const loc = await mappedLocation('room', m?.room_id ?? d.room_id, lic)
  if (!loc) throw new Error(`Map nursery room "${d.room ?? m?.room_id ?? '?'}" to a METRC location (Compliance > METRC > Mapping)`)
  const on = day(m?.started_on ?? d.on, job)
  const body = [{ actualDate: on, plantedDate: on, locationId: loc.location_id, packageId: p.id, plantBatchName: lotTag, plantBatchTypeId: type.id,
                  plantsCount: qty, strainId: strain.id, ...(isCount(p) ? {} : { quantity: qty, unitOfMeasureId: p.unitOfMeasureId }) }]
  const resp = await write(ctx, '/v2/plantbatches/create/from-packages', lic, body)
  const what = `mother lot ${lotTag}: ${qty} ${strain.name} from ${src} in ${loc.location}`
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${what}` }
  if (!await plantBatch(lic, lotTag)) throw new Error(`Sent, but METRC doesn't show plant batch ${lotTag} yet. Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC: ${what}` }
}

async function destroyFromBatch(ctx, lic, batch, count, note, date) {
  const inp = await inputs(ctx, lic, '/v2/plantbatches/destroy/inputs')
  const reason = reasonFrom(inp.actionReasons, await setting('comp.metrc_plant_waste_reason', ''), 'destroying plants', 'Plant loss reason')
  if (reason.requiresWasteWeight || reason.requiresImmatureWasteWeight) throw new Error(`METRC's reason "${reason.name}" needs a waste weight. Pick a reason without one, or do it by hand.`)
  return { id: batch.id, countToDestroy: count, wasteReasonId: reason.id, reasonNote: note.slice(0, 250), actualDate: date }
}

export async function sendNurseryLoss(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const lost = Number(d.lost)
  if (!(lost > 0)) throw new Skip('Nothing lost')
  if (d.what === 'mothers') {
    const m = await one(`nursery_mothers?id=eq.${Number(d.mother_id)}&select=plant_tag`)
    const lot = await plantBatch(lic, up(m?.plant_tag ?? d.lot_tag), '/v2/plantbatches/destroy/source-plantbatches')
    if (!lot) throw new Error(`Mother lot ${m?.plant_tag ?? d.lot_tag ?? '?'} isn't in METRC on ${lic}`)
    if (Number(lot.untrackedCount) < lost) throw new Error(`METRC has ${lot.untrackedCount} in ${lot.name}, can't destroy ${lost}`)
    const body = [await destroyFromBatch(ctx, lic, lot, lost, `Lifted app: ${lost} ${d.strain ?? ''} mothers lost`, ymd(job.at))]
    const resp = await write(ctx, '/v2/plantbatches/destroy', lic, body)
    return { state: ctx.live ? 'sent' : 'checked', request: body, response: resp, info: `${ctx.live ? 'METRC' : 'Dry run OK'}: destroy ${lost} from mother lot ${lot.name}` }
  }
  const b = await one(`nursery_batches?id=eq.${Number(d.batch_id)}&select=package_tag`)
  const tag = up(b?.package_tag ?? d.tag)
  if (!tag) throw new Error('The cutting batch has no clone package tag')
  const p = await packageByTag(lic, tag)
  if (!p) throw new Error(`Clone package ${tag} isn't active on ${lic}`)
  const cur = Number(p.quantity), next = Math.max(cur - lost, 0)
  const rs = await adjustReasons(lic)
  const reason = reasonFrom(rs, await setting('comp.metrc_plant_adjust_reason', ''), 'lost clones', 'Lost clones reason')
  const date = ymd(job.at)
  const body = [{ id: p.id, adjustmentQuantity: next - cur, adjustmentUnitOfMeasureId: p.unitOfMeasureId, newQuantity: next, adjustmentReasonId: reason.id,
                  reasonNote: `Lifted app: ${lost} clones lost`, adjustmentDate: date, ...(next === 0 ? { finishDate: date } : {}) }]
  const resp = await write(ctx, '/v2/packages/adjust', lic, body)
  return { state: ctx.live ? 'sent' : 'checked', request: body, response: resp, info: `${ctx.live ? 'METRC' : 'Dry run OK'}: ${tag} ${cur} > ${next} (${reason.name})` }
}

// ---------- farm plantings ----------
/** the METRC plant batches that hold a planting: the ones the app made, else every batch of that strain in the field's location */
async function plantingBatches(lic, pl) {
  const made = await db(`metrc_planting_batches?planting_id=eq.${pl.id}&license=eq.${enc(lic)}&select=batch_name,plants`)
  const out = []
  for (const m of made) { const b = await plantBatch(lic, m.batch_name); if (b) out.push(b) }
  if (out.length) return out
  const loc = await mappedLocation('field', pl.field_id, lic)
  if (!loc) throw new Error(`Map field ${pl.field_id} to a METRC location (Compliance > METRC > Mapping)`)
  const strain = await strainFor(pl.strain, lic)
  const rows = await all('/v2/plantbatches/active', { licenseNumber: lic, filter: [`locationName__eq:${loc.location}`, `strainName__eq:${strain.name}`], filterLogic: 'and' }, 10)
  return rows.filter(b => lc(b.locationName) === lc(loc.location) && lc(b.strainName) === lc(strain.name))
}

const BATCH_MAX = 100   // California: plants per immature plant batch tag

export async function sendPlanting(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const pl = await one(`cult_plantings?id=eq.${Number(d.planting_id)}&select=*`)
  if (!pl) throw new Error('The planting is gone from the app')
  const want = Number(d.plants)
  const prog = progressOf(job); prog.done ??= 0; prog.batches ??= []
  if (prog.done >= want) throw new Skip(`All ${want} plants are in METRC batches: ${prog.batches.map(b => b.name).join(', ')}`)
  const loc = await mappedLocation('field', pl.field_id, lic)
  if (!loc) throw new Error(`Map field "${d.field ?? pl.field_id}" to a METRC location (Compliance > METRC > Mapping)`)
  const strain = await strainFor(pl.strain, lic)
  const inp = await inputs(ctx, lic, '/v2/plantbatches/create/from-packages/inputs')
  // clone (or seed) packages of this strain on the farm license, oldest first
  const pk = (await all('/v2/plantbatches/create/from-packages/source-packages', { licenseNumber: lic }, 10))
    .filter(p => isCount(p) && Number(p.quantity) > 0 && (lc(p.item?.strainName) === lc(strain.name) || lc(p.item?.strainName) === lc(pl.strain) || strainMatch(p.item?.name, pl.strain)))
    .sort((a, b) => String(a.packagedDate ?? '').localeCompare(String(b.packagedDate ?? '')))
  // batch tags: the run picked on the planting, in order (CA: up to 100 plants per batch, the batch named by its tag)
  const run = await heldRun(pl.id, 'batch')
  if (!run) throw new Wait(`Pick the batch tag run on the planting first (Cultivation > Plantings > ${pl.strain}: one tag per 100 plants)`)
  let next = prog.batches.length
  let left = want - prog.done
  const body = []
  for (const p of pk) {
    if (left <= 0) break
    let n = Math.min(left, Math.floor(Number(p.quantity)))
    if (n <= 0) continue
    const type = (inp.plantBatchTypes ?? []).find(x => (/seed/i.test(p.item?.name ?? '') ? /seed/i : /clone/i).test(x.name))
    if (!type) throw new Error('METRC has no Clone / Seed plant batch type here')
    while (n > 0) {
      const k = Math.min(n, BATCH_MAX)
      body.push({ actualDate: day(pl.planted_on, job), plantedDate: day(pl.planted_on, job), locationId: loc.location_id, packageId: p.id,
                  plantBatchName: next < run.size ? run.at(next) : null, plantBatchTypeId: type.id, plantsCount: k, strainId: strain.id, _pkg: up(p.label) })
      next++; n -= k; left -= k
    }
  }
  if (!body.length) throw new Error(`No ${pl.strain} clone or seed packages on ${lic} in METRC to plant from (receive the nursery's manifest first)`)
  if (left > 0) throw new Error(`METRC only has ${want - prog.done - left} ${pl.strain} plants in packages on ${lic}; the planting is ${want - prog.done}. Receive the rest first, or fix the planting count.`)
  if (body.some(b => !b.plantBatchName)) throw new Error(`This planting needs ${prog.batches.length + body.length} batch tags (up to ${BATCH_MAX} plants each, split by clone package); the run picked has ${run.size}. Pick a longer run on the planting.`)
  const send = body.map(({ _pkg, ...x }) => x)
  const resp = await write(ctx, '/v2/plantbatches/create/from-packages', lic, send)
  const what = body.map(b => `${b.plantBatchName}: ${b.plantsCount} from ${b._pkg}`).join('; ')
  if (!ctx.live) return { state: 'checked', request: send, response: resp, info: `Dry run OK: ${what} in ${loc.location}` }
  for (const b of body) {
    prog.done += b.plantsCount; prog.batches.push({ name: b.plantBatchName, plants: b.plantsCount, from: b._pkg })
    await db('metrc_planting_batches', { method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ planting_id: pl.id, license: lic, batch_name: b.plantBatchName, plants: b.plantsCount, source_package: b._pkg }) }).catch(() => {})
  }
  await saveProgress(job, prog)
  return { state: 'sent', request: send, response: { ...(resp ?? {}), progress: prog }, info: `METRC: ${what} in ${loc.location}` }
}

export async function sendPlantLoss(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const pl = await one(`cult_plantings?id=eq.${Number(d.planting_id)}&select=*`)
  if (!pl) throw new Error('The planting is gone from the app')
  let left = Number(d.lost)
  const bs = (await plantingBatches(lic, pl)).filter(b => Number(b.untrackedCount) > 0).sort((a, b) => b.untrackedCount - a.untrackedCount)
  const body = []
  for (const b of bs) {
    if (left <= 0) break
    const n = Math.min(left, Number(b.untrackedCount))
    body.push(await destroyFromBatch(ctx, lic, b, n, `Lifted app: ${n} ${pl.strain} plants lost in ${d.field ?? 'the field'}`, ymd(job.at)))
    left -= n
  }
  if (!body.length) throw new Error(`No immature ${pl.strain} plants in METRC for this planting (already flipped? destroy flowering plants by hand)`)
  if (left > 0) throw new Error(`METRC has only ${Number(d.lost) - left} immature plants left in this planting's batches`)
  const resp = await write(ctx, '/v2/plantbatches/destroy', lic, body)
  return { state: ctx.live ? 'sent' : 'checked', request: body, response: resp, info: `${ctx.live ? 'METRC' : 'Dry run OK'}: destroy ${d.lost} from ${body.length} batch(es)` }
}

/** contiguous runs of available plant tag ids, read a page at a time */
function tagRuns(lic) {
  let page = 0, done = false, buf = []
  const more = async () => {
    if (done) return false
    page++
    const j = await t3('GET', '/v2/plantbatches/promote/source-tags', { query: { licenseNumber: lic, page, pageSize: 500, sort: 'label:asc' } })
    const rows = list(j).filter(t => !t.isUsed && !t.isArchived).sort((a, b) => a.id - b.id)
    if (!rows.length || page >= (j?.totalPages ?? page)) done = true
    buf.push(...rows)
    return rows.length > 0
  }
  return async function next(max) {
    if (!buf.length && !(await more())) return null
    let n = 1
    while (n < max) {
      if (n >= buf.length && !(await more())) break
      if (n >= buf.length || buf[n].id !== buf[n - 1].id + 1) break
      n++
    }
    const run = buf.splice(0, n)
    return { start: run[0].id, end: run[run.length - 1].id, count: run.length, from: run[0].label, to: run[run.length - 1].label }
  }
}

/** pieces of the planting's held run, in order from where the flip got to (METRC promotes by tag id, start..end) */
function heldRuns(ctx, lic, held, prog) {
  let used = prog.done
  return async function next(max) {
    if (used >= held.size) return null
    const n = Math.min(max, held.size - used)
    const from = held.at(used), to = held.at(used + n - 1)
    const path = '/v2/plantbatches/promote/source-tags'
    const [a, b] = await Promise.all([tagIdFor(ctx, lic, path, from), tagIdFor(ctx, lic, path, to)])
    if (Number(b) - Number(a) !== n - 1) throw new Error(`METRC's tag ids for ${from}..${to} aren't in sequence, so they can't go in one promote. Pick a different run.`)
    used += n
    return { start: a, end: b, count: n, from, to }
  }
}

/** the flip: promote the planting's immature plants to Flowering, each with a plant tag (runs overnight in pieces) */
export async function sendFlower(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const pl = await one(`cult_plantings?id=eq.${Number(d.planting_id)}&select=*`)
  if (!pl) throw new Error('The planting is gone from the app')
  const loc = await mappedLocation('field', pl.field_id, lic)
  if (!loc) throw new Error(`Map field "${d.field ?? pl.field_id}" to a METRC location (Compliance > METRC > Mapping)`)
  const prog = progressOf(job); prog.done ??= 0; prog.runs ??= []
  const want = Number(d.plants)
  const bs = (await plantingBatches(lic, pl)).filter(b => Number(b.untrackedCount) > 0)
  if (!bs.length) {
    if (prog.done > 0) throw new Skip(`Flipped ${prog.done} plants to flowering`)
    throw new Error(`No immature ${pl.strain} plants in METRC for this planting (in ${loc.location})`)
  }
  // the flowering tag run picked on the planting (flips queued before runs existed take the next available tags)
  const held = await heldRun(pl.id, 'flower')
  if (held && held.size < want) throw new Error(`The flowering tag run has ${held.size} tags for ${want} plants. Pick the run again on the planting.`)
  const next = held ? heldRuns(ctx, lic, held, prog) : tagRuns(lic)
  const deadline = ctx.deadline ?? Date.now() + 40000
  const date = day(d.on, job)
  let sentNow = 0, lastBody = null, lastResp = null
  for (const b of bs) {
    let left = Number(b.untrackedCount)
    while (left > 0 && prog.done + sentNow < want) {
      if (Date.now() > deadline) break
      if (await stopAsked(job)) throw new Held(`Stopped: ${prog.done + sentNow} of ${want} plants flipped. Release to carry on.`)
      const run = await next(Math.min(left, want - prog.done - sentNow, 2000))
      if (!run) throw new Error(`Out of plant tags on ${lic} (${prog.done + sentNow} of ${want} flipped). Order more tags, then it continues.`)
      const body = [{ growthDate: date, growthPhase: 'Flowering', id: b.id, newLocationId: loc.location_id, plantsCount: run.count, startingTagId: run.start, endingTagId: run.end }]
      lastResp = await write(ctx, '/v2/plantbatches/promote', lic, body); lastBody = body
      if (!ctx.live) return { state: 'checked', request: body, response: lastResp, info: `Dry run OK: first ${run.count} of ${want} plants from ${b.name}, tags ${run.from}..${run.to}` }
      sentNow += run.count; left -= run.count
      prog.runs.push({ batch: b.name, n: run.count, from: run.from, to: run.to })
      await saveProgress(job, { ...prog, done: prog.done + sentNow })
    }
  }
  prog.done += sentNow
  if (prog.done < want) {
    const more = bs.reduce((s, b) => s + Number(b.untrackedCount), 0) - sentNow
    if (more <= 0) throw new Skip(`Flipped ${prog.done} plants (METRC had no more immature plants in this planting; the app says ${want})`)
    throw new Wait(`Flipped ${prog.done} of ${want} plants so far; the rest continue on the next overnight run`)
  }
  return { state: 'sent', request: lastBody, response: { ...(lastResp ?? {}), progress: prog }, info: `METRC: ${prog.done} plants to Flowering in ${loc.location}` }
}

// ---------- the harvest chain ----------
export async function sendHarvestPlants(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const h = await one(`cult_harvests?id=eq.${Number(d.harvest_id)}&select=*`)
  if (!h) throw new Error('The harvest is gone from the app')
  const name = d.batch
  const plants = Number(d.plants || 0), wet = r4(job.lbs ?? d.wet_lbs ?? 0)
  const prog = progressOf(job); prog.done ??= 0; prog.wet ??= 0
  if (prog.done >= plants && plants > 0) throw new Skip(`All ${plants} plants harvested into ${name}`)
  if (plants <= 0) {
    if (wet > 0) throw new Error(`METRC adds wet weight only by harvesting plants. This step has ${wet} lb and no plants: harvest more plants into ${name} by hand, or add the plants in the app.`)
    throw new Skip('Nothing to harvest')
  }
  if (!(wet > 0)) throw new Error('METRC needs the wet weight with the plants. Log the raw bins first.')
  const loc = await mappedLocation('field', h.field_id, lic)
  if (!loc) throw new Error(`Map field ${d.field ?? h.field_id} to a METRC location (Compliance > METRC > Mapping)`)
  const dry = await mappedLocation('drying', h.site, lic)
  if (!dry) throw new Error(`Pick ${h.site}'s drying / harvest location in Compliance > METRC > Mapping`)
  const strain = await strainFor(h.planted_strain ?? h.strain, lic)
  const inp = await inputs(ctx, lic, '/v2/harvests/create/inputs')
  const lb = uomFrom(inp, 'lb')
  if (!lb) throw new Error('METRC has no pound unit for harvests here')
  const per = Math.floor((wet / plants) * 10000) / 10000
  if (!(per > 0)) throw new Error('Wet weight per plant rounds to 0')
  const deadline = ctx.deadline ?? Date.now() + 40000
  // METRC is the truth for how many plants are in: if a run was cut off right after a write (before the app saved its
  // progress), the count still comes out right and no plant gets harvested twice
  if (ctx.live) {
    const ex = await harvestByName(lic, name)
    if (prog.base == null) { prog.base = Number(ex?.plantCount ?? 0); prog.baseWet = Number(ex?.totalWetWeight ?? 0); await saveProgress(job, prog) }
    else if (ex) {
      const real = Number(ex.plantCount ?? 0) - prog.base
      if (real > prog.done) { prog.done = Math.min(real, plants); prog.wet = r4(Number(ex.totalWetWeight ?? 0) - prog.baseWet); await saveProgress(job, prog) }
    }
    if (prog.done >= plants) return { state: 'sent', request: null, response: { progress: prog }, info: `METRC: ${plants} plants, ${wet} lb wet into ${name}` }
  }
  let lastBody = null, lastResp = null
  // plants come from the field; once the field has none left, from the drying location (plants already moved in from the field)
  // details.metrc_location: harvest from this METRC location instead (the plants sit somewhere else in METRC than the app's field)
  const places = d.metrc_location ? [String(d.metrc_location)] : [...new Set([loc.location, dry.location].filter(Boolean))]
  let at = 0
  while (prog.done < plants) {
    if (Date.now() > deadline) break
    if (await stopAsked(job)) throw new Held(`Stopped: ${prog.done} of ${plants} plants harvested into ${name}. Release to carry on.`)
    const n = Math.min(WRITE_MAX, plants - prog.done)   // METRC takes 25 entries per call
    const where = places[at]
    const src = list(await t3('GET', '/v2/harvests/create/source-plants', { query: { licenseNumber: lic, pageSize: n, filter: [`locationName__eq:${where}`, `strainName__eq:${strain.name}`], filterLogic: 'and', sort: 'label:asc' } }))
      .filter(p => Number(p.harvestCount ?? 0) === 0 && lc(p.locationName) === lc(where))
    if (!src.length) {
      if (++at < places.length) continue
      // catch-up clean-up: METRC has this strain somewhere else (e.g. a trial entered in the wrong field). If every flowering plant
      // of the strain left on the license is in one other location, harvest from there; otherwise say where they are.
      if (!d.metrc_location && !places.found) {
        const any = list(await t3('GET', '/v2/harvests/create/source-plants', { query: { licenseNumber: lic, pageSize: 200, filter: [`strainName__eq:${strain.name}`] } }))
          .filter(p => Number(p.harvestCount ?? 0) === 0 && !places.some(x => lc(x) === lc(p.locationName)))
        const locs = [...new Set(any.map(p => p.locationName).filter(Boolean))]
        if (locs.length === 1) { places.push(locs[0]); places.found = locs[0]; continue }
        if (locs.length > 1) throw new Error(`No flowering ${strain.name} plants left in ${places.join(' or ')} on ${lic}; METRC has them in ${locs.join(', ')} (${prog.done} of ${plants} harvested)`)
      }
      throw new Error(`No flowering ${strain.name} plants left in ${places.join(' or ')} on ${lic} (${prog.done} of ${plants} harvested)`)
    }
    const body = src.slice(0, n).map((p, i) => {
      const last = prog.done + i + 1 === plants
      return { actualDate: day(d.metrc_date || h.harvested_on, job), harvestName: name,   // d.metrc_date: push day while catching up (146)
        id: p.id, weight: last ? r4(wet - prog.wet - per * i) : per, dryingLocationId: dry.location_id, unitOfWeightId: lb }
    })
    lastResp = await write(ctx, '/v2/harvests/create', lic, body); lastBody = body
    if (!ctx.live) return { state: 'checked', request: body, response: lastResp, info: `Dry run OK: first ${body.length} of ${plants} plants into ${name} (${per} lb each) from ${loc.location}` }
    prog.done += body.length; prog.wet = r4(prog.wet + body.reduce((s, x) => s + x.weight, 0))
    await saveProgress(job, prog)
  }
  if (prog.done < plants) throw new Wait(`${prog.done} of ${plants} plants harvested into ${name}; the rest go on the next run`)
  return { state: 'sent', request: lastBody, response: { ...(lastResp ?? {}), progress: prog }, info: `METRC: ${plants} plants, ${wet} lb wet into ${name}${places.found ? ` (from ${places.found}, where METRC had them)` : ''}` }
}

export async function sendHarvestPackage(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const pal = await one(`pallets?id=eq.${job.pallet_id}&select=id,code,package_tag,og_weight,current_weight,strain,item_id,product,harvest_id`)
  if (!pal) throw new Error('The pallet is gone from the app')
  const tag = up(pal.package_tag ?? job.tag)
  if (!tag) throw new Wait(`${pal.code} has no METRC tag yet (tag pending)`)
  const name = d.batch
  const ex = await packageByTag(lic, tag)
  if (ex) {
    // only "already done" when that package came from this harvest; otherwise the tag is on something else
    if (lc(ex.sourceHarvestNames ?? '').split(/,\s*/).includes(lc(name))) throw new Skip(`METRC already has ${tag} from ${name}`)
    throw new Error(`${tag} is already a different METRC package (${ex.item?.name ?? '?'}, ${ex.quantity} ${ex.unitOfMeasureAbbreviation ?? ''}, from ${ex.sourceHarvestNames || 'another package'}). Give ${pal.code} a different tag, then send again.`)
  }
  const hv = await first('/v2/harvests/create/packages/source-harvests', { licenseNumber: lic, filter: `name__eq:${name}` }).catch(() => null)
  if (!hv || lc(hv.name) !== lc(name)) throw new Wait(`Harvest ${name} isn't in METRC on ${lic} yet (harvest the plants first)`)
  const want = (await one(`items?id=eq.${pal.item_id ?? 0}&select=metrc_name`))?.metrc_name
  const items = await all('/v2/harvests/create/packages/source-items', { licenseNumber: lic }, 5)
  const fin = { fresh_frozen: /fresh frozen/i, wet: /(dry harvest|wet)/i, unbucked: /unbucked/i }[pal.product] ?? /./
  // the strain as METRC knows it (the strain map, or one of the strain's other names), e.g. Violet Torque = Newport Punch #6
  const ms = (await rpc('metrc_strain_for', { p_strain: pal.strain, p_license: lic }).catch(() => null))?.name
  const names = [pal.strain, ms].filter(Boolean).map(lc)
  const item = (want && items.find(i => lc(i.name) === lc(want)))
    ?? items.find(i => (names.includes(lc(i.strainName)) || names.some(n => lc(i.name).includes(n))) && fin.test(i.name))
  if (!item) throw new Error(`No METRC item ${want ? `"${want}"` : `for ${pal.strain}${ms && lc(ms) !== lc(pal.strain) ? ` (${ms} in METRC)` : ''} ${pal.product}`} on ${lic}`)
  const inp = await inputs(ctx, lic, '/v2/harvests/create/packages/inputs')
  const lb = uomFrom(inp, 'lb')
  const qty = r4(d.type === 'proc_wet' ? job.lbs : (pal.og_weight ?? job.lbs))
  const tagId = await tagIdFor(ctx, lic, '/v2/harvests/create/packages/source-tags', tag)
  const body = [{ tagId, itemId: item.id, unitOfMeasureId: lb, actualDate: ymd(job.at), ingredients: [{ harvestId: hv.id, quantity: qty }],
                  note: `Lifted app ${pal.code}`.slice(0, 250) }]
  const resp = await write(ctx, '/v2/harvests/create/packages', lic, body)
  const what = `${tag} ${qty} lb ${item.name} from ${name}`
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${what}` }
  if (!await packageByTag(lic, tag)) throw new Error(`Sent, but METRC doesn't show ${tag} yet. Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC: ${what}` }
}

export async function sendHarvestWaste(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const waste = r4(job.lbs ?? 0)
  if (!(waste > 0)) throw new Skip('No waste to record (everything wet went into packages)')
  const hv = await harvestByName(lic, d.batch)
  if (!hv) throw new Error(`Harvest ${d.batch} isn't active on ${lic} in METRC`)
  if (Number(hv.totalWasteWeight ?? 0) >= waste - 0.01) throw new Skip(`METRC already has ${hv.totalWasteWeight} ${hv.unitOfWeightAbbreviation} waste on ${d.batch}`)
  const inp = await inputs(ctx, lic, '/v2/harvests/waste/inputs')
  const types = (inp.wasteTypes ?? []).filter(t => t.forHarvests !== false)
  const want = await setting('comp.metrc_waste_type', '')
  const type = want ? types.find(t => lc(t.name) === lc(want)) : types[0]
  if (!type) throw new Error(`No METRC harvest waste type ${want ? `"${want}"` : ''} (types: ${types.map(t => t.name).join(', ')})`)
  const body = [{ id: hv.id, wasteWeight: waste, unitOfWeightId: hv.unitOfWeightId, wasteTypeId: type.id, actualDate: ymd() }]
  const resp = await write(ctx, '/v2/harvests/waste', lic, body)
  return { state: ctx.live ? 'sent' : 'checked', request: body, response: resp, info: `${ctx.live ? 'METRC' : 'Dry run OK'}: ${waste} lb ${type.name} waste on ${d.batch}` }
}

export async function sendHarvestFinish(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const hv = await harvestByName(lic, d.batch)
  if (!hv) {
    if (await harvestByName(lic, d.batch, '/v2/harvests/inactive')) throw new Skip(`${d.batch} is already finished in METRC`)
    throw new Error(`Harvest ${d.batch} isn't in METRC on ${lic}`)
  }
  if (hv.isFinished) throw new Skip(`${d.batch} is already finished in METRC`)
  if (Number(hv.currentWeight ?? 0) > 0.01) throw new Error(`${d.batch} still has ${hv.currentWeight} ${hv.unitOfWeightAbbreviation} in METRC (packages or waste missing). Finish it once that's 0.`)
  const body = [{ id: hv.id, actualDate: ymd() }]
  const resp = await write(ctx, '/v2/harvests/finish', lic, body)
  return { state: ctx.live ? 'sent' : 'checked', request: body, response: resp, info: `${ctx.live ? 'METRC' : 'Dry run OK'}: finish ${d.batch}` }
}
