// Pull METRC into the app through T3, per license: active + in transit packages (full), inactive and transferred packages,
// outgoing transfers and the packages on each delivery (since the last pull). Then close to-dos METRC already shows.
// GET = nightly cron (vercel.json, needs CRON_SECRET). POST { licenses?: [...] } = "Pull from METRC" in Compliance > METRC > Reconcile.
// Runs out of time gracefully: what's left is picked up by the next call (the app calls again until done).
import { caller, db, missing, rpc, send, t3 } from './_t3.js'
import { list } from './_core.js'

export const config = { maxDuration: 300 }
const BUDGET_MS = 240000
const SEASON_START = '2026-01-01T00:00:00Z'
const PAGE = 500

const up = s => String(s ?? '').trim().toUpperCase()
const labels = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map(up).filter(x => x.length > 10)
const real = v => (v && !String(v).startsWith('0001') ? v : null)   // METRC uses 0001-01-01 for "not set"
const day = v => (real(v) ? String(v).slice(0, 10) : null)
const toLbs = (q, u) => {
  if (q == null || q === '') return null
  const n = Number(q), unit = String(u ?? '').toLowerCase()
  if (/^(lb|lbs|pound)/.test(unit)) return n
  if (/^(g|gram)/.test(unit)) return n / 453.59237
  if (/^(kg|kilo)/.test(unit)) return n * 2.20462262
  if (/^(oz|ounce)/.test(unit)) return n / 16
  return null
}

function pkgRow(license, p, state, now) {
  return {
    license, label: up(p.label ?? p.packageLabel), metrc_id: p.id ?? p.packageId ?? null, state,
    item: p.item?.name ?? p.productName ?? null, category: p.item?.productCategoryName ?? null,
    qty: p.quantity ?? p.shippedQuantity ?? null, uom: p.unitOfMeasureAbbreviation ?? p.shippedUnitOfMeasureAbbreviation ?? null,
    lbs: toLbs(p.quantity ?? p.shippedQuantity, p.unitOfMeasureAbbreviation ?? p.shippedUnitOfMeasureAbbreviation),
    location: p.locationName ?? null, source_labels: labels(p.sourcePackageLabels), source_harvests: p.sourceHarvestNames ?? null,
    packaged_on: day(p.packagedDate), finished_on: day(p.finishedDate), last_modified: p.lastModified ?? null,
    on_hold: !!(p.isOnHold || p.isOnInvestigationHold), lab_state: p.labTestingStateName ?? null,
    received_manifest: p.receivedFromManifestNumber ?? null, received_from: p.receivedFromFacilityName ?? null, out_manifest: p.transferManifestNumber || null, seen_at: now,
  }
}
function transferRow(license, t, now) {
  return {
    delivery_id: t.deliveryId ?? t.id, transfer_id: t.id ?? null, license, manifest: t.manifestNumber ?? null,
    recipient_license: t.recipientFacilityLicenseNumber ?? null, recipient_name: t.recipientFacilityName ?? null,
    shipment_type: t.shipmentTypeName ?? null, created_at: t.createdDateTime ?? null,
    departed_at: t.actualDepartureDateTime ?? t.estimatedDepartureDateTime ?? null, arrived_at: t.actualArrivalDateTime ?? null,
    received_at: t.receivedDateTime ?? null, voided: !!t.isVoided, driver: t.driverName ?? null,
    vehicle: [t.vehicleMake, t.vehicleModel, t.vehicleLicensePlateNumber].filter(Boolean).join(' ') || null,
    package_count: t.deliveryPackageCount ?? t.packageCount ?? null, last_modified: t.lastModified ?? null, seen_at: now,
  }
}

async function upsert(table, rows, conflict) {
  // one row per key in a batch (a package shipped, returned and shipped again shows up twice): the last one wins
  const keys = conflict.split(',')
  rows = [...new Map(rows.map(r => [keys.map(k => r[k]).join('|'), r])).values()]
  for (let i = 0; i < rows.length; i += 500) {
    await db(`${table}?on_conflict=${conflict}`, { method: 'POST', body: JSON.stringify(rows.slice(i, i + 500)), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })
  }
}
async function cursor(license, step) { return (await db(`metrc_sync_state?license=eq.${license}&step=eq.${step}&select=cursor`))?.[0]?.cursor ?? null }
async function setCursor(license, step, value) {
  await upsert('metrc_sync_state', [{ license, step, cursor: value, updated_at: new Date().toISOString() }], 'license,step')
}

/** every page of a T3 collection; onPage(rows) for each */
async function pages(path, query, onPage, out) {
  let page = 1
  for (;;) {
    if (out.timeUp()) return false
    const j = await t3('GET', path, { query: { ...query, page, pageSize: PAGE } })
    const rows = Array.isArray(j) ? j : j?.data ?? []
    await onPage(rows)
    out.calls++
    const total = j?.totalPages ?? (rows.length < PAGE ? page : page + 1)
    if (page >= total || !rows.length) return true
    page++
  }
}

/** available tags only (Licenses > Pull tags from METRC) */
async function syncTagsOnly(license, t0) {
  const out = { calls: 0, tags: 0, notes: [], timeUp: () => Date.now() - t0 > BUDGET_MS }
  const now = new Date().toISOString()
  let complete = false, error = null
  try { complete = await syncTags(license, out, now) } catch (e) { error = String(e.message || e).slice(0, 500) }
  return { license, complete, error, tags: out.tags, calls: out.calls }
}

async function syncLicense(license, by, t0) {
  const run = (await db('metrc_sync_runs', { method: 'POST', body: JSON.stringify({ license, started_by: by }), headers: { Prefer: 'return=representation' } }))[0]
  const out = { calls: 0, active: 0, intransit: 0, inactive: 0, transferred: 0, transfers: 0, delivery_packages: 0, locations: 0, strains: 0, plant_batches: 0, harvests: 0, plants: 0, tags: 0, notes: [], live: new Set(), timeUp: () => Date.now() - t0 > BUDGET_MS }
  const now = new Date().toISOString()
  let complete = false, error = null
  try {
    // 1) everything live (full pull, so anything not seen is no longer active)
    let full = await pages('/v2/packages/active', { licenseNumber: license }, async rows => {
      const r = rows.map(p => pkgRow(license, p, 'active', now)); r.forEach(x => out.live.add(x.label))
      await upsert('metrc_packages', r, 'license,label'); out.active += rows.length
    }, out)
    full = full && await pages('/v2/packages/intransit', { licenseNumber: license }, async rows => {
      const r = rows.map(p => pkgRow(license, p, 'intransit', now)); r.forEach(x => out.live.add(x.label))
      await upsert('metrc_packages', r, 'license,label'); out.intransit += rows.length
    }, out)
    if (full) {
      await db(`metrc_packages?license=eq.${license}&state=in.(active,intransit)&seen_at=lt.${encodeURIComponent(now)}`,
        { method: 'PATCH', body: JSON.stringify({ state: 'gone' }), headers: { Prefer: 'return=minimal' } })
    }
    // 2) inactive packages since the last pull (2 days overlap)
    if (full) {
      const since = (await cursor(license, 'inactive')) ?? SEASON_START
      const ok = await pages('/v2/packages/inactive', { licenseNumber: license, filter: `lastModified__gte:${since}` }, async rows => {
        await upsert('metrc_packages', rows.map(p => pkgRow(license, p, 'inactive', now)).filter(r => r.label), 'license,label'); out.inactive += rows.length
      }, out)
      if (ok) await setCursor(license, 'inactive', new Date(Date.parse(now) - 2 * 86400000).toISOString())
      full = full && ok
    }
    // 3) every package this license has shipped (each row carries its manifest, recipient and dates): the manifest trail
    if (full) {
      full = await pages('/v2/packages/transferred', { licenseNumber: license }, async rows => {
        const pk = [], tr = new Map(), tp = []
        for (const p of rows) {
          const label = up(p.packageLabel ?? p.label)
          const tid = Number(String(p.manifestNumber ?? '').replace(/\D/g, '')) || Number(p.id ?? 0) || null   // keyed by manifest number
          if (!label) continue
          if (!out.live.has(label)) pk.push(pkgRow(license, p, 'transferred', now))   // shipped and came back: stays active
          if (!tid) continue
          if (!tr.has(tid)) tr.set(tid, { delivery_id: tid, transfer_id: tid, license, manifest: p.manifestNumber ?? null,
            recipient_license: p.recipientFacilityLicenseNumber ?? null, recipient_name: p.recipientFacilityName ?? null,
            departed_at: real(p.actualDepartureDateTime) ?? real(p.receivedDateTime), received_at: real(p.receivedDateTime), packages_loaded: true, seen_at: now })
          tp.push({ delivery_id: tid, label, manifest: p.manifestNumber ?? null, item: p.productName ?? null,
            shipped_lbs: toLbs(p.shippedQuantity, p.shippedUnitOfMeasureAbbreviation), received_lbs: toLbs(p.receivedQuantity, p.receivedUnitOfMeasureAbbreviation),
            uom: p.shippedUnitOfMeasureAbbreviation ?? null, state: p.shipmentPackageStateName ?? p.shipmentPackageState ?? null, source_labels: labels(p.sourcePackageLabels) })
        }
        pk.sort((a, b) => String(a.last_modified ?? '').localeCompare(String(b.last_modified ?? '')))
        await upsert('metrc_packages', pk, 'license,label')
        if (tr.size) await upsert('metrc_transfers', [...tr.values()], 'delivery_id')
        if (tp.length) await upsert('metrc_transfer_packages', tp, 'delivery_id,label')
        out.transferred += pk.length; out.delivery_packages += tp.length
      }, out) && full
    }
    // 4) transfer details (driver, vehicle, dates, voided) since the last pull, keyed the same way
    if (full) {
      const since = (await cursor(license, 'transfers')) ?? SEASON_START
      let ok = true
      for (const path of ['/v2/transfers/outgoing/active', '/v2/transfers/outgoing/inactive']) {
        ok = ok && await pages(path, { licenseNumber: license, filter: `lastModified__gte:${since}` }, async rows => {
          // only what the shipped-package rows don't have (recipient and dates come from those)
          const tr = rows.map(t => ({
            delivery_id: Number(String(t.manifestNumber ?? '').replace(/\D/g, '')) || Number(t.id) || null, license, manifest: t.manifestNumber ?? null,
            transfer_id: t.id ?? null, created_at: real(t.createdDateTime), voided: !!t.isVoided, driver: t.driverName ?? null,
            vehicle: [t.vehicleMake, t.vehicleModel, t.vehicleLicensePlateNumber].filter(Boolean).join(' ') || null,
            shipment_type: t.shipmentTypeName ?? null, last_modified: real(t.lastModified), packages_loaded: true, seen_at: now,
          })).filter(r => r.delivery_id)
          if (tr.length) await upsert('metrc_transfers', tr, 'delivery_id')
          out.transfers += tr.length
        }, out)
      }
      if (ok) await setCursor(license, 'transfers', new Date(Date.parse(now) - 2 * 86400000).toISOString())
      full = full && ok
    }
    // 5) Phase 2: locations, strains, plant batches, harvests, plant counts by location and strain
    // Phase 2 and tags: a step METRC refuses (a permission the app's METRC user doesn't have) is noted, not fatal
    if (full) {
      try { await syncTags(license, out, now) } catch (e) { out.notes.push(`tags: ${String(e.message || e).slice(0, 200)}`) }
      try { await syncPlants(license, out, now) } catch (e) { out.notes.push(`plants: ${String(e.message || e).slice(0, 200)}`) }
    }
    complete = full
  } catch (e) { error = String(e.message || e).slice(0, 800) }
  const { timeUp, live, ...counts } = out
  await db(`metrc_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ finished_at: new Date().toISOString(), counts, complete, error }), headers: { Prefer: 'return=minimal' } })
  return { license, complete, error, ...counts }
}

/** METRC's available tags for a license, replacing the last pull's list. Package tags always; plant tags only when a license
 *  has a manageable number (OHR has 400k+ plant tags for the biomass: the flip reads those from METRC as it goes). */
const PLANT_TAGS_MAX = 30000
async function syncTags(license, out, now) {
  let all = true
  for (const [type, inv] of [['package', 'CannabisPackage'], ['plant', 'CannabisPlant']]) {
    const filter = `tagInventoryTypeName__eq:${inv}`
    if (type === 'plant') {
      const head = await t3('GET', '/v2/tags/available', { query: { licenseNumber: license, filter, page: 1, pageSize: 5 } })
      const total = Number(head?.total ?? 0)
      if (total > PLANT_TAGS_MAX) { out.notes.push(`plant tags: ${total.toLocaleString()} available, too many to keep (suggestions for plant tags come from METRC live)`); continue }
    }
    const ok = await pages('/v2/tags/available', { licenseNumber: license, filter }, async rows => {
      const r = rows.filter(t => t.label && !t.isUsed && !t.isArchived).map(t => ({ license, label: up(t.label), tag_type: type, type_name: t.tagTypeName ?? null, seen_at: now }))
      if (r.length) await upsert('metrc_tags', r, 'license,label')
      out.tags += r.length
    }, out)
    if (ok) await db(`metrc_tags?license=eq.${license}&tag_type=eq.${type}&seen_at=lt.${encodeURIComponent(now)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
    all = all && ok
  }
  return all
}

const PLANT_DETAIL_MAX = 60000   // more plants than this on a license: just the total (paging 1M+ plants nightly takes too long)

async function syncPlants(license, out, now) {
  const isoDay = v => (real(v) ? String(v).slice(0, 10) : null)
  let ok = await pages('/v2/locations/active', { licenseNumber: license }, async rows => {
    await upsert('metrc_locations', rows.map(l => ({ license, id: l.id, name: l.name, type_name: l.locationTypeName ?? null, for_plants: l.forPlants ?? null,
      for_plant_batches: l.forPlantBatches ?? null, for_harvests: l.forHarvests ?? null, for_packages: l.forPackages ?? null, archived: !!l.isArchived, seen_at: now })), 'license,id')
    out.locations += rows.length
  }, out)
  ok = ok && await pages('/v2/strains', { licenseNumber: license }, async rows => {
    await upsert('metrc_strains', rows.map(x => ({ license, id: x.id, name: x.name, archived: !!x.isArchived, seen_at: now })), 'license,id')
    out.strains += rows.length
  }, out)
  if (!ok) return false
  const step = async (name, fn) => { try { return await fn() } catch (e) { out.notes.push(`${name}: ${String(e.message || e).slice(0, 160)}`); return true } }
  ok = await step('plant batches', async () => {
    const done = await pages('/v2/plantbatches/active', { licenseNumber: license }, async rows => {
      await upsert('metrc_plant_batches', rows.map(b => ({ license, id: b.id, name: b.name ?? b.label, type: b.plantBatchTypeName ?? b.typeName ?? null, strain: b.strainName ?? null,
        strain_id: b.strainId ?? null, location_id: b.locationId ?? null, location: b.locationName ?? null, untracked: b.untrackedCount ?? null, tracked: b.trackedCount ?? null,
        packaged: b.packagedCount ?? null, destroyed: b.destroyedCount ?? null, planted_on: isoDay(b.plantedDate), source_package: b.sourcePackageLabel ?? null,
        source_plant: b.sourcePlantLabel ?? null, state: 'active', last_modified: real(b.lastModified), seen_at: now })), 'license,id')
      out.plant_batches += rows.length
    }, out)
    if (done) await db(`metrc_plant_batches?license=eq.${license}&state=eq.active&seen_at=lt.${encodeURIComponent(now)}`, { method: 'PATCH', body: JSON.stringify({ state: 'gone' }), headers: { Prefer: 'return=minimal' } })
    return done
  })
  if (!ok) return false
  const hrow = (h, state) => ({ license, id: h.id, name: h.name, strains: h.sourceStrainNames ?? null, location: h.dryingLocationName ?? null, plant_count: h.plantCount ?? null,
    wet: h.totalWetWeight ?? null, current: h.currentWeight ?? null, waste: h.totalWasteWeight ?? null, packaged: h.totalPackagedWeight ?? null, uom: h.unitOfWeightAbbreviation ?? null,
    started: isoDay(h.harvestStartDate), finished: !!h.isFinished, finished_on: isoDay(h.finishedDate), state, last_modified: real(h.lastModified), seen_at: now })
  ok = await step('harvests', async () => {
    let done = await pages('/v2/harvests/active', { licenseNumber: license }, async rows => { await upsert('metrc_harvests', rows.map(h => hrow(h, 'active')), 'license,id'); out.harvests += rows.length }, out)
    if (!done) return false
    const since = (await cursor(license, 'harvests_inactive')) ?? SEASON_START
    done = await pages('/v2/harvests/inactive', { licenseNumber: license, filter: `lastModified__gte:${since}` }, async rows => {
      await upsert('metrc_harvests', rows.map(h => hrow(h, 'inactive')), 'license,id'); out.harvests += rows.length
    }, out)
    if (done) await setCursor(license, 'harvests_inactive', new Date(Date.parse(now) - 2 * 86400000).toISOString())
    return done
  })
  if (!ok) return false
  // plant counts by location and strain (vegetative, flowering)
  for (const phase of ['vegetative', 'flowering']) {
    if (out.timeUp()) return false
    ok = await step(`${phase} plants`, async () => {
      const head = await t3('GET', `/v2/plants/${phase}`, { query: { licenseNumber: license, page: 1, pageSize: 5 } })
      const total = Number(head?.total ?? list(head).length)
      const run = `r${Date.parse(now)}`
      if (total > PLANT_DETAIL_MAX) {
        // too many to page: count them by strain (one call each), then by field for each strain with plants.
        // That takes a few hundred calls, so only the plants-only pull does it (its own nightly run, or Count plants now)
        if (!out.byStrain) {
          const kept = await db(`metrc_plant_counts?license=eq.${encodeURIComponent(license)}&phase=eq.${phase}&run=eq.live&strain=neq.&select=plants`)
          if (kept.length) { out.notes.push(`${phase}: ${total.toLocaleString()} plants (kept the last count by strain)`); out.plants += total; return true }
        }
        const rows = out.byStrain ? await countByStrain(license, phase, total, out) : [{ location_id: 0, location: '(strain not counted)', strain: '', plants: total }]
        if (rows.length) await rpc('metrc_plant_counts_add', { p_license: license, p_phase: phase, p_run: run, p_rows: rows })
        await rpc('metrc_plant_counts_swap', { p_license: license, p_phase: phase, p_run: run })
        out.plants += total
        return true
      }
      const agg = new Map()
      const done = await pages(`/v2/plants/${phase}`, { licenseNumber: license }, async rows => {
        for (const p of rows) {
          const k = `${p.locationId ?? 0}|${p.strainName ?? ''}`
          const a = agg.get(k) ?? { location_id: p.locationId ?? 0, location: p.locationName ?? null, strain: p.strainName ?? '', plants: 0, oldest: null, newest: null }
          a.plants++
          const d = isoDay(p.plantedDate)
          if (d && (!a.oldest || d < a.oldest)) a.oldest = d
          if (d && (!a.newest || d > a.newest)) a.newest = d
          agg.set(k, a)
        }
      }, out)
      if (!done) return false
      if (agg.size) await rpc('metrc_plant_counts_add', { p_license: license, p_phase: phase, p_run: run, p_rows: [...agg.values()] })
      await rpc('metrc_plant_counts_swap', { p_license: license, p_phase: phase, p_run: run })
      out.plants += total
      return true
    })
    if (!ok) return false
  }
  return true
}

/** plants of a phase counted by strain and location without paging them all: T3 gives the total for any filter.
 *  Strains with up to SMALL_STRAIN plants are paged (location + planted dates); bigger ones are counted per location. */
const SMALL_STRAIN = 2500
async function pool(items, k, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}
async function countByStrain(license, phase, total, out) {
  const path = `/v2/plants/${phase}`
  const count = async filter => { out.calls++; return Number((await t3('GET', path, { query: { licenseNumber: license, filter, filterLogic: 'and', page: 1, pageSize: 1 } }))?.total ?? 0) }
  const strains = (await db(`metrc_strains?license=eq.${encodeURIComponent(license)}&archived=is.false&select=name`)).map(x => x.name)
  const locs = (await db(`metrc_locations?license=eq.${encodeURIComponent(license)}&archived=is.false&select=id,name`))
  const byStrain = new Map()
  await pool(strains, 8, async n => { if (out.timeUp()) return; const c = await count(`strainName__eq:${n}`); if (c > 0) byStrain.set(n, c) })
  const locTotals = new Map()
  await pool(locs, 8, async l => { if (out.timeUp()) return; const c = await count(`locationName__eq:${l.name}`); if (c > 0) locTotals.set(l.name, { id: l.id, n: c }) })
  const rows = []
  await pool([...byStrain], 4, async ([n, c]) => {
    if (out.timeUp()) { rows.push({ location_id: 0, location: '(field not counted)', strain: n, plants: c }); return }
    if (c <= SMALL_STRAIN) {
      const agg = new Map()
      for (let page = 1; page <= Math.ceil(c / PAGE); page++) {
        out.calls++
        const j = await t3('GET', path, { query: { licenseNumber: license, filter: `strainName__eq:${n}`, page, pageSize: PAGE } })
        for (const p of list(j)) {
          const k = p.locationId ?? 0
          const a = agg.get(k) ?? { location_id: k, location: p.locationName ?? null, strain: n, plants: 0, oldest: null, newest: null }
          a.plants++
          const d = day(p.plantedDate)
          if (d && (!a.oldest || d < a.oldest)) a.oldest = d
          if (d && (!a.newest || d > a.newest)) a.newest = d
          agg.set(k, a)
        }
      }
      rows.push(...agg.values()); return
    }
    let seen = 0
    for (const [ln, l] of locTotals) {
      const k = await count([`strainName__eq:${n}`, `locationName__eq:${ln}`])
      if (k > 0) { rows.push({ location_id: l.id, location: ln, strain: n, plants: k }); seen += k }
    }
    if (seen < c) rows.push({ location_id: 0, location: '(field not counted)', strain: n, plants: c - seen })
  })
  const counted = [...byStrain.values()].reduce((a, b) => a + b, 0)
  if (counted < total) rows.push({ location_id: 0, location: '(strain not counted)', strain: '', plants: total - counted })
  return rows
}

/** plants only: plant batches and plant counts (Reconcile > Farm plants > Count plants now) */
async function syncPlantsOnly(license, t0) {
  const out = { calls: 0, locations: 0, strains: 0, plant_batches: 0, harvests: 0, plants: 0, notes: [], byStrain: true, timeUp: () => Date.now() - t0 > BUDGET_MS }
  let complete = false, error = null
  try { complete = await syncPlants(license, out, new Date().toISOString()) } catch (e) { error = String(e.message || e).slice(0, 500) }
  return { license, complete, error, plants: out.plants, plant_batches: out.plant_batches, harvests: out.harvests, calls: out.calls, notes: out.notes }
}

export default async function handler(req, res) {
  const t0 = Date.now()
  let by = 'nightly'
  const only = req.body?.only ?? new URL(req.url ?? '/', 'http://x').searchParams.get('only')
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  } else if (req.method === 'POST') {
    const me = await caller(req)
    if (!me || !me.can_send) return send(res, 403, { error: 'Only Compliance (or a Distribution / Processing Admin) can pull from METRC' })
    by = me.email
  } else return send(res, 405, { error: 'GET (cron) or POST' })
  if (missing().length) return send(res, 200, { skipped: `missing ${missing().join(', ')}` })
  try {
    // one pull at a time
    const busy = only ? [] : await db(`metrc_sync_runs?finished_at=is.null&started_at=gt.${encodeURIComponent(new Date(Date.now() - 6 * 60000).toISOString())}&select=id&limit=1`)
    if (busy.length) return send(res, 409, { error: 'A METRC pull is already running. Try again in a few minutes.' })
    const conn = (await db('metrc_connection?id=eq.1&select=licenses'))?.[0]
    const reach = (conn?.licenses ?? []).filter(l => l.in_t3).map(l => l.license)
    let want = Array.isArray(req.body?.licenses) && req.body.licenses.length ? req.body.licenses.filter(l => reach.includes(l)) : reach
    if (only === 'plants' && !req.body?.licenses?.length) {   // farm licenses only
      const farms = (await db('licenses?select=license_no&kind=eq.cultivation&active=is.true')).map(l => l.license_no)
      want = want.filter(l => farms.includes(l))
    }
    if (!want.length) return send(res, 400, { error: 'No licenses to pull. Test the METRC connection in Compliance > Settings first.' })
    const results = []
    for (const lic of want) {
      if (Date.now() - t0 > BUDGET_MS) { results.push({ license: lic, complete: false, left: true }); continue }
      results.push(only === 'tags' ? await syncTagsOnly(lic, t0) : only === 'plants' ? await syncPlantsOnly(lic, t0) : await syncLicense(lic, by, t0))
    }
    let closed = 0
    try { closed = await rpc('metrc_autoclose', {}) } catch { /* 071 missing */ }
    return send(res, 200, { done: results.every(r => r.complete), closed, results, ms: Date.now() - t0 })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
