// Transfers and manifests (OHR <> GVR, out to processors, to customers), the per-stop checklist, receiving.
// Decisions: no prices on manifests; our C13 is the transporter on every manifest (outside carriers included).
import {
  LB, Skip, Wait, all, db, enc, first, inputs, list, localDT, lc, one, packageByTag, r4, rpc, setting, t3, tol, up, write, ymd,
} from './_core.js'

const TYPE_SETTING = { internal: 'comp.metrc_ttype_internal', customer: 'comp.metrc_ttype_customer', processor: 'comp.metrc_ttype_processor', nursery: 'comp.metrc_ttype_nursery' }
const TYPE_LABEL = { internal: 'between our licenses', customer: 'customer manifests', processor: 'processor runs', nursery: 'nursery clones out' }

async function facility(ctx, path, license, lic) {
  const key = `fac:${path}:${license}:${lic}`
  ctx.cache ??= {}
  if (!(key in ctx.cache)) {
    ctx.cache[key] = (async () => {
      const f = await first(path, { licenseNumber: license, filter: `licenseNumber__eq:${lic}` }).catch(() => null)
      if (f && up(f.licenseNumber) === up(lic)) return f
      const rows = await all(path, { licenseNumber: license }, 10).catch(() => [])
      return rows.find(x => up(x.licenseNumber) === up(lic)) ?? null
    })()
  }
  return ctx.cache[key]
}
const transportLicense = async () => (await one('licenses?active=eq.true&kind=in.(transport,distributor)&select=license_no,kind&order=sort'))?.license_no ?? null

/**
 * Everything a METRC transfer needs, checked. spec: { kind, typeKey, license, toLicense, toName, fromAddress, toAddress, driver, driverLicense,
 * make, model, plate, packages: [{ tag, lbs, code, tag_pending }], invoice, selfIds }
 * Returns { checks: [{ key, label, ok, detail }], body, ids } (body null when a check failed).
 */
export async function planTransfer(ctx, spec) {
  const checks = []
  const add = (key, label, ok, detail = null) => { checks.push({ key, label, ok: !!ok, detail }); return !!ok }
  const lic = spec.license
  const inp = await inputs(ctx, lic, '/v2/transfers/create/inputs').catch(e => ({ error: e.message }))
  if (inp.error) { add('inputs', 'METRC transfer form', false, inp.error); return { checks, body: null } }

  // transfer type: set in Settings, and one that doesn't need prices
  const types = inp.transferTypes ?? []
  // not set yet: between our own licenses defaults to METRC's plain "Transfer" type
  const typeName = (await setting(TYPE_SETTING[spec.typeKey], '')) ||
    (spec.typeKey === 'internal' ? types.find(t => lc(t.name) === 'transfer')?.name ?? '' : '')
  const type = typeName ? types.find(t => lc(t.name) === lc(typeName)) : null
  const wholesale = type && /wholesale/i.test(`${type.transactionType ?? ''} ${type.transactionTypeName ?? ''}`)
  add('type', 'Transfer type', type && !wholesale,
    !typeName ? `Pick the METRC transfer type for ${TYPE_LABEL[spec.typeKey]} in Compliance > Settings > METRC through T3. METRC's types: ${types.map(t => t.name).join(', ')}`
      : !type ? `"${typeName}" isn't one of ${lic}'s transfer types in METRC (${types.map(t => t.name).join(', ')})`
        : wholesale ? `"${type.name}" is a wholesale type (needs prices). We don't put prices on manifests: pick another type.` : type.name)

  // the driver's phone (Compliance > Vehicles > Drivers), else the one in Settings, else METRC's default for the license
  const drv = spec.driver ? await one(`fleet_drivers?name=ilike.${enc(spec.driver)}&active=eq.true&select=phone`).catch(() => null) : null
  const phone = (drv?.phone ?? '').trim() || (await setting('comp.metrc_phone', '')) || inp.defaultPhoneNumberForQuestions || ''
  add('phone', 'Phone for questions', phone, phone ? `${phone}${drv?.phone ? ` (${spec.driver})` : ''}`
    : spec.driver ? `Add ${spec.driver}'s phone in Compliance > Vehicles > Drivers` : 'Pick the driver on the load (their phone goes on the manifest)')

  const dest = spec.toLicense ? await facility(ctx, '/v2/transfers/create/destinations', lic, spec.toLicense) : null
  add('destination', 'Destination license', dest, !spec.toLicense ? `${spec.toName ?? 'The destination'} has no license number in the app`
    : dest ? `${dest.facilityName ?? ''} ${spec.toLicense}` : `${spec.toLicense} isn't a destination ${lic} can ship to in METRC`)

  const tl = spec.transporter ?? await transportLicense()
  const tr = tl ? await facility(ctx, '/v2/transfers/create/transporters', lic, tl) : null
  add('transporter', 'Transporter (our C13)', tr, !tl ? 'No transport license in the app (Compliance > Licenses)' : tr ? `${tr.facilityName ?? ''} ${tl}` : `${tl} isn't a transporter ${lic} can use in METRC`)

  // driver: METRC's registered driver for this license if the name matches, else what the app has
  const md = (inp.drivers ?? []).find(x => !x.isArchived && lc(x.name) === lc(spec.driver))
  const dl = md?.driversLicenseNumber || spec.driverLicense || ''
  const occ = md?.employeeId || dl
  add('driver', 'Driver', spec.driver && dl, !spec.driver ? 'Pick the driver on the load' : !dl ? `${spec.driver} has no driver's license number (Compliance > Vehicles > Drivers)` : `${spec.driver} · DL ${dl}${md ? ' (METRC driver)' : ''}`)
  const mv = (inp.vehicles ?? []).find(x => !x.isArchived && up(x.licensePlateNumber) === up(spec.plate))
  const make = mv?.make || spec.make, model = mv?.model || spec.model, plate = mv?.licensePlateNumber || spec.plate
  add('vehicle', 'Vehicle', make && model && plate, make && model && plate ? `${make} ${model} · ${plate}` : `The truck needs make, model and plate (Compliance > Vehicles). Has: ${[make, model, plate].filter(Boolean).join(' ') || 'nothing'}`)

  // packages: tagged, active on this license in METRC, weights match, nothing earlier still waiting on them
  const pk = spec.packages ?? []
  const noTag = pk.filter(p => !p.tag || p.tag_pending)
  add('tags', 'Every package has a METRC tag', pk.length && !noTag.length, !pk.length ? 'No packages' : noTag.length ? `No tag: ${noTag.map(p => p.code).join(', ')}` : `${pk.length} packages`)
  const t = await tol()
  const found = [], missing = [], held = [], off = []
  await Promise.all(pk.filter(p => p.tag).map(async p => {
    const m = await packageByTag(lic, p.tag).catch(() => null)
    if (!m) { missing.push(`${p.code} ${up(p.tag)}`); return }
    if (m.isOnHold || m.isOnInvestigationHold || m.isInTransit) held.push(`${p.code} (${m.isInTransit ? 'in transit' : 'on hold'})`)
    if (p.lbs != null && LB.test(m.unitOfMeasureAbbreviation || '') && Math.abs(r4(m.quantity) - r4(p.lbs)) > t) off.push(`${p.code}: METRC ${m.quantity}, app ${r4(p.lbs)}`)
    found.push({ ...p, m })
  }))
  add('metrc', `Active on ${lic} in METRC`, !missing.length && !held.length && found.length,
    missing.length ? `Not active on ${lic}: ${missing.join(', ')}` : held.length ? held.join(', ') : `${found.length} packages`)
  add('weights', 'Weights match METRC', !off.length, off.length ? `${off.join('; ')} (more than ${t} lb apart: adjust first)` : 'All within tolerance')
  const tags = pk.map(p => up(p.tag)).filter(Boolean)
  const open = tags.length ? await db(`comp_metrc_actions?select=id,action,tag&touch_tags=ov.{${tags.map(enc).join(',')}}&status=in.(todo,error)&kind=not.in.(transfer,manifest,ship_check,receive,tag,new_package)` +
    `${spec.beforeId ? `&id=lt.${spec.beforeId}` : ''}&order=id&limit=5`) : []
  add('open', 'METRC to-dos done first', !open.length, open.length ? `Still to do in METRC: ${open.map(o => `#${o.id} ${o.action}${o.tag ? ` ${o.tag}` : ''}`).join('; ')}` : 'Nothing waiting')

  if (checks.some(c => !c.ok)) return { checks, body: null, type }
  const unitLb = (inp.unitsOfMeasure ?? []).find(u => /^(lb|pound)/i.test(u.abbreviation ?? u.name ?? ''))?.id
  const dep = new Date(Date.now() + 5 * 60000)
  const arr = new Date(dep.getTime() + (Number(await setting('comp.metrc_transit_hours', '3')) || 3) * 3600000)
  const gross = !!type.requiresPackagesGrossWeight, destGross = !!type.requiresDestinationGrossWeight
  const total = r4(found.reduce((s, p) => s + Number(p.m.quantity || 0), 0))
  const body = [{
    destinations: [{
      recipientId: dest.id, transferTypeId: type.id,
      plannedRoute: `Direct: ${spec.fromAddress || lic} to ${spec.toAddress || spec.toName || spec.toLicense}`.slice(0, 250),
      estimatedDepartureDateTime: localDT(dep), estimatedArrivalDateTime: localDT(arr),
      ...(type.requiresInvoiceNumber && spec.invoice ? { invoiceNumber: spec.invoice } : {}),
      ...(destGross && unitLb ? { grossWeight: total, grossUnitOfWeightId: unitLb } : {}),
      transporters: [{
        transporterId: tr.id, phoneNumberForQuestions: phone,
        transporterDetails: [{ driverName: spec.driver, driverOccupationalLicenseNumber: occ, driverLicenseNumber: dl,
          vehicleMake: make, vehicleModel: model, vehicleLicensePlateNumber: plate,
          ...(type.requiresVehicleRegistrationNumber ? { vehicleRegistrationNumber: plate } : {}) }],
      }],
      packages: found.map(p => ({ id: p.m.id, ...(gross && unitLb ? { grossWeight: r4(p.m.quantity), grossUnitOfWeightId: unitLb } : {}) })),
    }],
  }]
  return { checks, body, type, found }
}

/** send (or dry-run) a planned transfer; on Live, find the new manifest and remember it */
async function sendTransfer(ctx, spec, plan, job) {
  const lic = spec.license
  if (!plan.body) {
    const bad = plan.checks.filter(c => !c.ok)
    if (bad.length === 1 && bad[0].key === 'open') throw new Wait(bad[0].detail)
    throw new Error(bad.map(c => `${c.label}: ${c.detail}`).join(' | '))
  }
  if (!ctx.live) {
    const resp = await write(ctx, '/v2/transfers/create', lic, plan.body)
    return { state: 'checked', request: plan.body, response: resp, info: `Dry run OK: ${plan.found.length} packages to ${spec.toName ?? spec.toLicense} (${plan.type.name})` }
  }
  const before = new Set(list(await t3('GET', '/v2/transfers/outgoing/active', { query: { licenseNumber: lic, pageSize: 500, sort: 'createdDateTime:desc' } })).map(x => `${x.id}:${x.deliveryId}`))
  const resp = await write(ctx, '/v2/transfers/create', lic, plan.body)
  const after = list(await t3('GET', '/v2/transfers/outgoing/active', { query: { licenseNumber: lic, pageSize: 500, sort: 'createdDateTime:desc' } }))
  const made = after.find(x => !before.has(`${x.id}:${x.deliveryId}`) && up(x.recipientFacilityLicenseNumber) === up(spec.toLicense))
    ?? after.find(x => !before.has(`${x.id}:${x.deliveryId}`))
  await db('metrc_app_transfers?on_conflict=key', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: spec.key, kind: job.kind, license: lic, recipient_license: spec.toLicense, recipient_name: spec.toName, stop_id: spec.stopId ?? null,
      load_id: spec.loadId ?? null, transfer_type: plan.type.name, transfer_id: made?.id ?? null, delivery_id: made?.deliveryId ?? null, manifest: made?.manifestNumber ?? null,
      state: 'created', packages: plan.found.map(p => ({ tag: up(p.tag), lbs: p.lbs, code: p.code, pallet_id: p.pallet_id ?? null, metrc_id: p.m.id })),
      request: plan.body, created_by: ctx.by }),
  })
  if (spec.stopId && made?.manifestNumber) {
    await db(`load_stops?id=eq.${spec.stopId}&manifest=is.null`, { method: 'PATCH', body: JSON.stringify({ manifest: made.manifestNumber }), headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
  if (!made) return { state: 'sent', request: plan.body, response: resp, info: 'Sent, but the new manifest didn\'t show in METRC\'s outgoing list yet. Check METRC.' }
  return { state: 'sent', request: plan.body, response: resp, info: `METRC manifest ${made.manifestNumber} to ${spec.toName ?? spec.toLicense}` }
}

// ---------- a load stop ----------
export async function stopSpec(stopId, license) {
  const s = await rpc('metrc_stop_info', { p_stop: stopId })
  if (!s) throw new Error('Stop not found')
  const packages = (s.packages ?? []).filter(p => !license || p.from_license === license)
  const fromLic = license ?? packages[0]?.from_license
  const from = fromLic ? await one(`licenses?license_no=eq.${enc(fromLic)}&select=address`) : null
  return {
    s, spec: {
      key: `stop:${stopId}:${fromLic}`, stopId, loadId: s.load_id, kind: s.internal ? 'transfer' : 'manifest', typeKey: s.internal ? 'internal' : 'customer',
      license: fromLic, toLicense: s.to_license, toName: s.to_name, toAddress: s.to_address, fromAddress: from?.address,
      driver: s.driver, driverLicense: s.driver_license, make: s.make, model: s.model, plate: s.plate, transporter: s.transporter,
      packages: packages.map(p => ({ tag: p.tag, lbs: p.lbs, code: p.code, pallet_id: p.pallet_id, tag_pending: p.tag_pending })),
      invoice: (s.orders ?? []).join(', ').slice(0, 50) || null,
    },
  }
}

/** the checklist for every pending stop of a load (and each license it ships from); saved for Depart */
export async function loadChecklist(ctx, loadId) {
  const stops = await db(`load_stops?load_id=eq.${loadId}&status=eq.pending&select=id,seq&order=seq`)
  const out = []
  for (const st of stops) {
    const info = await rpc('metrc_stop_info', { p_stop: st.id })
    const lics = [...new Set((info?.packages ?? []).map(p => p.from_license).filter(Boolean))]
    if (!lics.length) { out.push({ stop_id: st.id, seq: st.seq, license: null, ok: false, checks: [{ key: 'packages', label: 'Packages', ok: false, detail: 'Nothing on this stop, or no license for where it ships from' }] }); continue }
    for (const lic of lics) {
      const { spec, s } = await stopSpec(st.id, lic)
      const plan = await planTransfer(ctx, spec)
      const already = await one(`metrc_app_transfers?key=eq.${enc(spec.key)}&state=neq.voided&select=manifest`)
      if (already) plan.checks.unshift({ key: 'made', label: 'Manifest', ok: true, detail: `Already made: ${already.manifest ?? '(number pending)'}` })
      if (plan.body && !already) {
        try { await t3('POST', '/v2/transfers/create', { query: { licenseNumber: lic, applyDynamicValidation: 'true' }, body: plan.body }); plan.checks.push({ key: 'dry', label: 'METRC dry run', ok: true, detail: 'METRC would accept it' }) }
        catch (e) { plan.checks.push({ key: 'dry', label: 'METRC dry run', ok: false, detail: e.message }) }
      }
      const ok = plan.checks.every(c => c.ok)
      const on = (await one(`metrc_push_kinds?kind=eq.${s.internal ? 'transfer' : 'manifest'}&select=mode`))?.mode ?? 'off'
      await db('metrc_stop_checks?on_conflict=stop_id,license', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ stop_id: st.id, license: lic, ok, checks: plan.checks, checked_at: new Date().toISOString(), checked_by: ctx.by }) })
      out.push({ stop_id: st.id, seq: st.seq, license: lic, to: s.to_name, internal: s.internal, mode: on, ok, checks: plan.checks })
    }
  }
  return out
}

// ---------- senders ----------
export async function sendTransfer_(job, ctx) {
  const d = job.details || {}
  if (d.type === 'stop_departed') {
    const { spec } = await stopSpec(Number(d.stop_id), job.license)
    spec.beforeId = job.id
    const made = await one(`metrc_app_transfers?key=eq.${enc(spec.key)}&state=neq.voided&select=manifest`)
    if (made) throw new Skip(`Already on METRC manifest ${made.manifest ?? '(number pending)'}`)
    const plan = await planTransfer(ctx, spec)
    const r = await sendTransfer(ctx, spec, plan, job)
    if (r.state === 'sent') r.siblings = await shipSiblings(spec.packages.map(p => p.tag), job.id)
    return r
  }
  if (d.type === 'proc_sent') return sendProcessorRun(job, ctx)
  if (d.type === 'nursery_shipped') return sendNurseryRun(job, ctx)
  throw new Error(`This to-do (${d.type}) isn't a transfer the app makes. Check it by hand.`)
}

/** ship-check to-dos on the same packages are covered once the manifest exists */
async function shipSiblings(tags, selfId) {
  const t = tags.filter(Boolean).map(up)
  if (!t.length) return []
  const r = await db(`comp_metrc_actions?select=id&kind=eq.ship_check&status=in.(todo,error)&tag=in.(${t.map(enc).join(',')})&id=neq.${selfId}`)
  return r.map(x => x.id)
}

/** everything sent to the same processor the same day from the same license goes on one manifest */
async function sendProcessorRun(job, ctx) {
  const d = job.details || {}
  const day = ymd(job.at)
  const proc = await one(`proc_processors?name=eq.${enc(d.processor ?? '')}&select=id,name,license,address`)
  if (!proc) throw new Error(`Processor "${d.processor}" not found in the app`)
  const sibs = (await db(`comp_metrc_actions?select=id,at,tag,lbs,code,pallet_id,details&kind=eq.transfer&status=in.(todo,error)&license=eq.${enc(job.license)}` +
    `&details->>type=eq.proc_sent&details->>processor=eq.${enc(d.processor)}&order=id`)).filter(x => ymd(x.at) === day)
  const vehicleId = await setting('comp.metrc_proc_vehicle', '')
  const v = vehicleId ? await one(`fleet_assets?id=eq.${Number(vehicleId)}&select=make,model,plate`) : null
  const driver = await setting('comp.metrc_proc_driver', '')
  const dr = driver ? await one(`fleet_drivers?name=ilike.${enc(driver)}&active=eq.true&select=license_no`) : null
  const from = await one(`licenses?license_no=eq.${enc(job.license)}&select=address`)
  const spec = {
    key: `proc:${proc.id}:${day}:${job.license}`, kind: 'transfer', typeKey: 'processor', license: job.license, toLicense: proc.license, toName: proc.name,
    toAddress: proc.address, fromAddress: from?.address, driver, driverLicense: dr?.license_no, make: v?.make, model: v?.model, plate: v?.plate,
    packages: sibs.map(x => ({ tag: x.tag, lbs: x.lbs, code: x.code, pallet_id: x.pallet_id })), beforeId: Math.min(...sibs.map(x => x.id)),
  }
  const made = await one(`metrc_app_transfers?key=eq.${enc(spec.key)}&state=neq.voided&select=manifest,packages`)
  if (made && (made.packages ?? []).some(p => up(p.tag) === up(job.tag))) throw new Skip(`Already on METRC manifest ${made.manifest ?? '(number pending)'}`)
  if (made) spec.key += `:${job.id}`     // more sent the same day after the first manifest: a second manifest
  if (!driver || !vehicleId) {
    throw new Error('Processor runs have no load in the app: set the driver and truck for processor runs in Compliance > Settings > METRC through T3')
  }
  const plan = await planTransfer(ctx, spec)
  const r = await sendTransfer(ctx, spec, plan, job)
  if (r.state === 'sent') r.siblings = sibs.map(x => x.id).filter(id => id !== job.id)
  return r
}

/** a nursery delivery: its clone packages go to the farm (or customer) on one METRC transfer. METRC sends whole packages. */
async function sendNurseryRun(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  const key = `nurs:${d.ref}`
  const made = await one(`metrc_app_transfers?key=eq.${enc(key)}&state=neq.voided&select=manifest`)
  if (made) throw new Skip(`Already on METRC manifest ${made.manifest ?? '(number pending)'}`)
  const batches = await db(`nursery_batches?id=in.(${Object.keys(d.per_batch ?? {}).filter(k => k !== '0').map(Number).join(',') || 0})&select=id,name,package_tag`)
  const pk = []
  for (const b of batches) {
    const tag = up(b.package_tag)
    if (!tag) throw new Error(`Cutting batch ${b.name ?? b.id} has no clone package tag`)
    const m = await packageByTag(lic, tag)
    const sent = Number(d.per_batch?.[String(b.id)] ?? 0)
    if (m && Number(m.quantity) > sent) throw new Error(`${tag} holds ${m.quantity} clones in METRC but ${sent} went out. METRC sends whole packages: split off the ${sent} into a new package first (or deliver the rest too).`)
    pk.push({ tag, lbs: null, code: b.name ?? `batch ${b.id}` })
  }
  if (!pk.length) throw new Error('No cutting batches on this delivery')
  const vehicleId = await setting('comp.metrc_proc_vehicle', '')
  const v = vehicleId ? await one(`fleet_assets?id=eq.${Number(vehicleId)}&select=make,model,plate`) : null
  const driver = await setting('comp.metrc_proc_driver', '')
  const dr = driver ? await one(`fleet_drivers?name=ilike.${enc(driver)}&active=eq.true&select=license_no`) : null
  if (!driver || !vehicleId) throw new Error('Nursery deliveries have no load in the app: set the driver and truck for runs without a load in Compliance > Settings > METRC through T3')
  const from = await one(`nursery_sites?license=eq.${enc(lic)}&select=address`)
  const spec = { key, kind: 'transfer', typeKey: 'nursery', license: lic, toLicense: d.to_license, toName: d.to, fromAddress: from?.address,
    driver, driverLicense: dr?.license_no, make: v?.make, model: v?.model, plate: v?.plate, packages: pk, beforeId: job.id }
  const plan = await planTransfer(ctx, spec)
  return sendTransfer(ctx, spec, plan, job)
}

// ---------- receiving ----------
/** incoming deliveries on a license, each with its packages */
export async function incoming(ctx, license, withPackages = true) {
  const ts = await all('/v2/transfers/incoming/active', { licenseNumber: license }, 5)
  const out = []
  for (const t of ts) {
    const row = {
      license, transfer_id: t.id, delivery_id: t.deliveryId, manifest: t.manifestNumber, from_license: t.shipperFacilityLicenseNumber, from: t.shipperFacilityName,
      type: t.shipmentTypeName, created: t.createdDateTime, departed: t.actualDepartureDateTime ?? t.estimatedDepartureDateTime, arrival: t.estimatedArrivalDateTime,
      driver: t.driverName, vehicle: [t.vehicleMake, t.vehicleModel, t.vehicleLicensePlateNumber].filter(Boolean).join(' '), packages: t.deliveryPackageCount ?? t.packageCount,
      received: !!t.receivedDateTime,
    }
    if (withPackages && t.deliveryId) {
      row.items = (await all('/v2/transfers/packages', { licenseNumber: license, deliveryId: t.deliveryId }, 5)).map(p => ({
        id: p.packageId ?? p.id, tag: up(p.packageLabel ?? p.label), item: p.productName ?? p.item?.name, strain: p.itemStrainName ?? null,
        qty: p.shippedQuantity, uom: p.shippedUnitOfMeasureAbbreviation, state: p.shipmentPackageState,
      }))
    }
    out.push(row)
  }
  return out
}

/** receive one delivery in METRC (dry run unless live); returns the request and what was received */
export async function receiveDelivery(ctx, license, d) {
  const inp = await inputs(ctx, license, '/v2/transfers/receive/inputs').catch(() => ({}))
  const uom = abbr => (inp.unitsOfMeasure ?? []).find(u => lc(u.abbreviation) === lc(abbr))?.id
  const items = d.items ?? []
  if (!items.length) throw new Error(`Manifest ${d.manifest}: no packages on the delivery`)
  const pk = items.map(p => {
    const id = uom(p.uom)
    if (!id) throw new Error(`METRC has no unit "${p.uom}" for receiving on ${license}`)
    return { id: p.id, receivedQuantity: p.qty, receivedUnitOfMeasureId: id }
  })
  const body = [{ id: d.transfer_id, shipmentDeliveryId: d.delivery_id, packages: pk }]
  const resp = await write(ctx, '/v2/transfers/receive', license, body)
  return { body, resp }
}

/** find the incoming delivery that has this tag */
async function deliveryWith(ctx, license, tag) {
  ctx.cache ??= {}
  ctx.cache[`inc:${license}`] ??= incoming(ctx, license, true)
  const ds = await ctx.cache[`inc:${license}`]
  return ds.find(d => (d.items ?? []).some(p => up(p.tag) === up(tag))) ?? null
}

export async function sendReceive(job, ctx) {
  const d = job.details || {}
  const tag = up(job.tag ?? d.new_tag ?? d.tag)
  if (!tag) throw new Error('No tag on this to-do')
  const site = d.site ?? d.to_site
  const lic = d.to_license ?? (site ? (await rpc('site_license', { p_site: site }).catch(() => null)) : null) ?? job.license
  if (!lic) throw new Error('Which license is receiving? (no site on this to-do)')
  const del = await deliveryWith(ctx, lic, tag)
  if (!del) {
    if (await packageByTag(lic, tag)) throw new Skip(`Already received: ${tag} is active on ${lic}`)
    throw new Wait(`No incoming METRC transfer to ${lic} has ${tag} yet`)
  }
  const { body, resp } = await receiveDelivery(ctx, lic, del)
  const what = `manifest ${del.manifest} from ${del.from}, ${del.items.length} packages`
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: receive ${what}` }
  ctx.cache[`inc:${lic}`] = null
  await db(`metrc_app_transfers?delivery_id=eq.${del.delivery_id}`, { method: 'PATCH', body: JSON.stringify({ state: 'received', received_at: new Date().toISOString(), received_by: ctx.by }), headers: { Prefer: 'return=minimal' } }).catch(() => {})
  const tags = del.items.map(p => up(p.tag))
  const sibs = await db(`comp_metrc_actions?select=id&kind=eq.receive&status=in.(todo,error)&tag=in.(${tags.map(enc).join(',')})&id=neq.${job.id}`)
  return { state: 'sent', request: body, response: resp, info: `Received in METRC: ${what}`, siblings: sibs.map(x => x.id) }
}

