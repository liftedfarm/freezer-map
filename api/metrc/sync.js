// Pull METRC into the app through T3, per license: active + in transit packages (full), inactive and transferred packages,
// outgoing transfers and the packages on each delivery (since the last pull). Then close to-dos METRC already shows.
// GET = nightly cron (vercel.json, needs CRON_SECRET). POST { licenses?: [...] } = "Pull from METRC" in Compliance > METRC > Reconcile.
// Runs out of time gracefully: what's left is picked up by the next call (the app calls again until done).
import { caller, db, missing, rpc, send, t3 } from './_t3.js'

export const config = { maxDuration: 300 }
const BUDGET_MS = 240000
const SEASON_START = '2026-01-01T00:00:00Z'
const PAGE = 500

const up = s => String(s ?? '').trim().toUpperCase()
const labels = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map(up).filter(x => x.length > 10)
const day = v => (v ? String(v).slice(0, 10) : null)
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
    received_manifest: p.receivedFromManifestNumber ?? null, received_from: p.receivedFromFacilityName ?? null, seen_at: now,
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

async function syncLicense(license, by, t0) {
  const run = (await db('metrc_sync_runs', { method: 'POST', body: JSON.stringify({ license, started_by: by }), headers: { Prefer: 'return=representation' } }))[0]
  const out = { calls: 0, active: 0, intransit: 0, inactive: 0, transferred: 0, transfers: 0, delivery_packages: 0, timeUp: () => Date.now() - t0 > BUDGET_MS }
  const now = new Date().toISOString()
  let complete = false, error = null
  try {
    // 1) everything live (full pull, so anything not seen is no longer active)
    let full = await pages('/v2/packages/active', { licenseNumber: license }, async rows => {
      await upsert('metrc_packages', rows.map(p => pkgRow(license, p, 'active', now)), 'license,label'); out.active += rows.length
    }, out)
    full = full && await pages('/v2/packages/intransit', { licenseNumber: license }, async rows => {
      await upsert('metrc_packages', rows.map(p => pkgRow(license, p, 'intransit', now)), 'license,label'); out.intransit += rows.length
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
          pk.push(pkgRow(license, p, 'transferred', now))
          if (!tid) continue
          if (!tr.has(tid)) tr.set(tid, { delivery_id: tid, transfer_id: tid, license, manifest: p.manifestNumber ?? null,
            recipient_license: p.recipientFacilityLicenseNumber ?? null, recipient_name: p.recipientFacilityName ?? null,
            departed_at: p.actualDepartureDateTime ?? null, received_at: p.receivedDateTime ?? null, packages_loaded: true, seen_at: now })
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
          const tr = rows.map(t => ({ ...transferRow(license, t, now), delivery_id: Number(String(t.manifestNumber ?? '').replace(/\D/g, '')) || Number(t.id) || null, packages_loaded: true }))
            .filter(r => r.delivery_id)
          if (tr.length) await upsert('metrc_transfers', tr, 'delivery_id')
          out.transfers += tr.length
        }, out)
      }
      if (ok) await setCursor(license, 'transfers', new Date(Date.parse(now) - 2 * 86400000).toISOString())
      full = full && ok
    }
    complete = full
  } catch (e) { error = String(e.message || e).slice(0, 800) }
  const { timeUp, ...counts } = out
  await db(`metrc_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ finished_at: new Date().toISOString(), counts, complete, error }), headers: { Prefer: 'return=minimal' } })
  return { license, complete, error, ...counts }
}

export default async function handler(req, res) {
  const t0 = Date.now()
  let by = 'nightly'
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
    const busy = await db(`metrc_sync_runs?finished_at=is.null&started_at=gt.${encodeURIComponent(new Date(Date.now() - 6 * 60000).toISOString())}&select=id&limit=1`)
    if (busy.length) return send(res, 409, { error: 'A METRC pull is already running. Try again in a few minutes.' })
    const conn = (await db('metrc_connection?id=eq.1&select=licenses'))?.[0]
    const reach = (conn?.licenses ?? []).filter(l => l.in_t3).map(l => l.license)
    const want = Array.isArray(req.body?.licenses) && req.body.licenses.length ? req.body.licenses.filter(l => reach.includes(l)) : reach
    if (!want.length) return send(res, 400, { error: 'No licenses to pull. Test the METRC connection in Compliance > Settings first.' })
    const results = []
    for (const lic of want) {
      if (Date.now() - t0 > BUDGET_MS) { results.push({ license: lic, complete: false, left: true }); continue }
      results.push(await syncLicense(lic, by, t0))
    }
    let closed = 0
    try { closed = await rpc('metrc_autoclose', {}) } catch { /* 071 missing */ }
    return send(res, 200, { done: results.every(r => r.complete), closed, results, ms: Date.now() - t0 })
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
}
