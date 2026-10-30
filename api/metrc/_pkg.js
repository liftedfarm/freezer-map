// Package senders: weight adjustments, splits, combines, finish (used up), tag and hand-made package checks, ship checks.
import {
  LB, Skip, Wait, all, cached, db, enc, inputs, itemId, lc, locationFrom, one, packageAnywhere, packageByTag, pallet, r4, reasonFrom, setting,
  tagIdFor, tol, up, write, ymd, adjustReasons,
} from './_core.js'

const REASON_LABEL = { drying: 'Drying', scale: 'Scale variance', waste: 'Waste', entry: 'Entry error', used: 'Used up' }

export async function reasonFor(ctx, license, appReason) {
  const key = appReason in REASON_LABEL ? appReason : 'entry'
  const dflt = { drying: 'Drying', scale: 'Scale Variance', waste: 'Waste', entry: 'Entry Error', used: 'Scale Variance' }[key]
  const want = await setting(`comp.metrc_reason_${key}`, dflt)
  ctx.reasons ??= {}
  ctx.reasons[license] ??= await adjustReasons(license)
  return reasonFrom(ctx.reasons[license], want, `"${REASON_LABEL[key]}" adjustments`, REASON_LABEL[key])
}

const lbsOnly = (p, tag) => { if (!LB.test(p.unitOfMeasureAbbreviation || '')) throw new Error(`METRC has ${tag} in ${p.unitOfMeasureAbbreviation || '?'}, not pounds. Do this one by hand.`) }

// ---------- weight adjustment (aims at the app's weight now) ----------
export async function sendAdjust(job, ctx) {
  const d = job.details || {}
  if (!job.license) throw new Error('No license on this to-do')
  if (!job.tag) throw new Error('This package has no METRC tag yet')
  const p = await packageByTag(job.license, job.tag)
  if (!p) throw new Error(`Tag ${job.tag} isn't an active package under ${job.license} in METRC`)
  lbsOnly(p, job.tag)
  const cur = r4(p.quantity)
  // The app's weight now, not the weight written on this to-do: later splits, picks and adjustments change it.
  const pal = job.pallet_id ? await one(`pallets?id=eq.${job.pallet_id}&select=current_weight,status`) : null
  // "METRC only" (114, temporary catch-up): METRC goes to exactly the number on the to-do; the app's weight is left alone
  const metrcOnly = !!d.metrc_only
  const now = !metrcOnly && pal?.current_weight != null ? r4(pal.current_weight) : null
  // Later to-dos on this package still waiting (a split not sent yet, say): replay just this step so they still line up.
  const later = await db(`comp_metrc_actions?select=id&touch_tags=ov.{${enc(up(job.tag))}}&status=in.(todo,error)&id=gt.${job.id}&limit=1`)
  if (!later?.length && now != null && Math.abs(now - cur) < 0.0001) throw new Skip(`METRC already shows ${cur} lb, same as the app`)
  const step = r4(d.to ?? job.lbs)
  const target = later?.length || now == null ? step : now
  if (!(target >= 0)) throw new Error('No new weight on this to-do')
  const delta = r4(target - cur)
  if (Math.abs(delta) < 0.0001) throw new Skip(`METRC already shows ${target} lb`)
  const reason = await reasonFor(ctx, job.license, d.reason)
  const note = [`Lifted app ${job.code ?? ''}: ${cur} > ${target} lb${metrcOnly ? ' (METRC only)' : ''}`, d.reason ? REASON_LABEL[d.reason] : null, job.details?.note].filter(Boolean).join('. ').slice(0, 250)
  const body = [{
    id: p.id, isFinishedGood: false, currentQuantity: cur, currentQuantityUom: p.unitOfMeasureAbbreviation,
    adjustmentQuantity: delta, adjustmentUnitOfMeasureId: p.unitOfMeasureId,
    newQuantity: target, newQuantityUom: p.unitOfMeasureAbbreviation,
    adjustmentReasonId: reason.id, reasonNote: note, adjustmentDate: ymd(job.at),
  }]
  const resp = await write(ctx, '/v2/packages/adjust', job.license, body)
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${cur} > ${target} lb (${delta > 0 ? '+' : ''}${delta}), reason ${reason.name}` }
  const after = await packageByTag(job.license, job.tag)
  if (!after || Math.abs(r4(after.quantity) - target) > 0.001) throw new Error(`Sent, but METRC now shows ${after ? after.quantity : 'no active package'} (wanted ${target}). Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC ${cur} > ${target} lb, reason ${reason.name}` }
}

// ---------- new package from packages (split / combine) ----------
async function createFromPackages(ctx, job, { tag, qty, sources, item, note }) {
  const license = job.license
  const inp = await inputs(ctx, license, '/v2/packages/create/inputs').catch(() => ({}))
  const tagId = await tagIdFor(ctx, license, '/v2/packages/create/source-tags', tag)
  const locationId = locationFrom(inp, sources[0].p.locationName)
  const actualDate = ymd(job.at)
  const body = [{
    actualDate,
    ingredients: sources.map(s => ({ packageId: s.p.id, quantity: s.take, unitOfMeasureId: s.p.unitOfMeasureId, ...(s.finish ? { finishDate: actualDate } : {}) })),
    // same item as the source package(s): METRC's "Use same item". Without it, a package received from another license (the
    // GVR hub's stock from OHR) fails T3's CREATE_PACKAGES_ITEM_IDS_EXIST check, because that item isn't one of the hub's own.
    itemId: item, useSameItem: sources.every(s => itemId(s.p) === item), quantity: qty, tagId, unitOfMeasureId: sources[0].p.unitOfMeasureId,
    ...(locationId ? { locationId } : {}),
    note: note.slice(0, 250),
  }]
  const resp = await write(ctx, '/v2/packages/create', license, body)
  const what = `${up(tag)} ${qty} lb from ${sources.map(s => `${up(s.tag)} (${s.take}${s.finish ? ', finished' : ''})`).join(', ')}`
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${what}` }
  const made = await packageByTag(license, tag)
  if (!made) throw new Error(`Sent, but METRC doesn't show ${up(tag)} as active yet. Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC made ${what}` }
}

export async function sendSplit(job, ctx) {
  const d = job.details || {}
  const child = await pallet(job.pallet_id)
  if (!child) throw new Error('The new piece is gone from the app')
  if (!child.package_tag) throw new Wait(`${child.code} has no METRC tag yet (tag pending). Set the tag, then send.`)
  const tag = up(child.package_tag)
  if (await packageByTag(job.license, tag)) throw new Skip(`METRC already has ${tag}`)
  const parent = await pallet(d.parent_id)
  if (!parent?.package_tag) throw new Error(`The package it was split from (${d.parent ?? '?'}) has no METRC tag in the app`)
  const src = await packageByTag(job.license, parent.package_tag)
  if (!src) throw new Error(`${up(parent.package_tag)} (${parent.code}) isn't an active package on ${job.license} in METRC`)
  lbsOnly(src, parent.package_tag)
  const qty = r4(job.lbs)
  const t = await tol()
  if (r4(src.quantity) + t < qty) throw new Error(`METRC has only ${src.quantity} lb in ${up(parent.package_tag)}; the split takes ${qty}. Fix the parent's weight first.`)
  // the parent used up in the app (and METRC has about what's taken): take it all and finish it
  const finish = Number(parent.current_weight ?? 1) <= 0.0001 && Math.abs(r4(src.quantity) - qty) <= t
  return createFromPackages(ctx, job, {
    tag, qty, item: itemId(src),
    sources: [{ tag: parent.package_tag, p: src, take: finish ? r4(src.quantity) : qty, finish }],
    note: `Lifted app split: ${child.code} from ${parent.code}`,
  })
}

export async function sendCombine(job, ctx) {
  const m = await pallet(job.pallet_id)
  if (!m) throw new Error('The combined pallet is gone from the app')
  if (!m.package_tag) throw new Wait(`${m.code} has no METRC tag yet (tag pending). Set the tag, then send.`)
  const tag = up(m.package_tag)
  if (await packageByTag(job.license, tag)) throw new Skip(`METRC already has ${tag}`)
  // whole pallets merged in (emptied and finished), and pieces taken off pallets that stay (Fulfillment's combine for an order)
  const whole = await db(`pallets?merged_into=eq.${m.id}&select=id,code,package_tag,current_weight&order=code`) ?? []
  const cut = await db(`events?type=eq.combine_part&details->>into_id=eq.${m.id}&select=pallet_id,lbs&order=id`) ?? []
  const cutPallets = cut.length ? await db(`pallets?id=in.(${[...new Set(cut.map(e => e.pallet_id))].join(',')})&select=id,code,package_tag,current_weight`) ?? [] : []
  if (!whole.length && !cut.length) throw new Error('No source packages found for this combine')
  const t = await tol()
  const sources = [], names = []
  for (const s of whole) {
    if (!s.package_tag) throw new Error(`${s.code} has no METRC tag in the app`)
    const p = await packageByTag(job.license, s.package_tag)
    if (!p) throw new Error(`${up(s.package_tag)} (${s.code}) isn't an active package on ${job.license} in METRC`)
    lbsOnly(p, s.package_tag)
    const app = r4(s.current_weight ?? 0)
    if (Math.abs(r4(p.quantity) - app) > t) {
      throw new Error(`${s.code}: METRC has ${p.quantity} lb, the app had ${app} lb when combined (more than the ${t} lb tolerance). Adjust ${up(s.package_tag)} in METRC first, or fix it with Reconcile.`)
    }
    sources.push({ tag: s.package_tag, p, take: r4(p.quantity), finish: true })   // every whole source is emptied, so finish it
    names.push(s.code)
  }
  for (const e of cut) {
    const s = cutPallets.find(x => x.id === e.pallet_id)
    if (!s) throw new Error(`A pallet this combine took from (#${e.pallet_id}) is gone from the app`)
    if (!s.package_tag) throw new Error(`${s.code} has no METRC tag in the app`)
    const p = await packageByTag(job.license, s.package_tag)
    if (!p) throw new Error(`${up(s.package_tag)} (${s.code}) isn't an active package on ${job.license} in METRC`)
    lbsOnly(p, s.package_tag)
    const take = r4(e.lbs)
    if (r4(p.quantity) + t < take) throw new Error(`METRC has only ${p.quantity} lb in ${up(s.package_tag)} (${s.code}); the combine takes ${take}. Fix ${s.code}'s weight first.`)
    // the pallet is used up in the app and METRC has about what's taken: take it all and finish it
    const finish = Number(s.current_weight ?? 1) <= 0.0001 && Math.abs(r4(p.quantity) - take) <= t
    sources.push({ tag: s.package_tag, p, take: finish ? r4(p.quantity) : take, finish })
    names.push(`${s.code} (${take} lb)`)
  }
  const items = [...new Set(sources.map(s => itemId(s.p)))]
  if (items.length > 1) throw new Error(`The sources are different METRC items (${[...new Set(sources.map(s => s.p.item?.name))].join(' / ')}). Combine them by hand.`)
  const units = [...new Set(sources.map(s => s.p.unitOfMeasureId))]
  if (units.length > 1) throw new Error('The sources are in different units in METRC. Combine them by hand.')
  return createFromPackages(ctx, job, {
    tag, qty: r4(m.og_weight ?? m.current_weight), item: items[0], sources,
    note: `Lifted app combine: ${m.code} from ${names.join(', ')}`,
  })
}

// ---------- Remove: used up (adjust to 0 and finish) ----------
export async function sendFinish(job, ctx) {
  if (!job.tag) throw new Error('This package has no METRC tag')
  const p = await packageByTag(job.license, job.tag)
  if (!p) {
    const where = await packageAnywhere(job.license, job.tag)
    if (where && where.state !== 'active') throw new Skip(`Already ${where.state === 'inactive' ? 'finished' : where.state} in METRC`)
    throw new Error(`Tag ${up(job.tag)} isn't in METRC on ${job.license}`)
  }
  const cur = r4(p.quantity), date = ymd(job.at)
  let body, path
  if (Math.abs(cur) < 0.0001) {
    path = '/v2/packages/finish'; body = [{ id: p.id, actualDate: date }]
  } else {
    const reason = await reasonFor(ctx, job.license, 'used')
    path = '/v2/packages/adjust'
    body = [{ id: p.id, adjustmentQuantity: -cur, adjustmentUnitOfMeasureId: p.unitOfMeasureId, newQuantity: 0,
              adjustmentReasonId: reason.id, reasonNote: `Lifted app ${job.code ?? ''}: used up${job.details?.note ? `. ${job.details.note}` : ''}`.slice(0, 250),
              adjustmentDate: date, finishDate: date }]
  }
  const resp = await write(ctx, path, job.license, body)
  const what = cur ? `adjust ${cur} > 0 ${p.unitOfMeasureAbbreviation} and finish` : 'finish (already 0)'
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: ${what}` }
  if (await packageByTag(job.license, job.tag)) throw new Error(`Sent, but ${up(job.tag)} is still active in METRC. Check it in METRC.`)
  return { state: 'sent', request: body, response: resp, info: `METRC: ${what}` }
}

// ---------- checks (METRC can't retag a package; hand-made packages need a source) ----------
export async function sendTagCheck(job, ctx) {
  const d = job.details || {}
  const tag = up(job.tag ?? d.to)
  if (!tag) throw new Error('No tag on this to-do')
  if (!d.from) {
    // a pending tag filled in: the split / combine / package to-do for this pallet makes it
    const open = await db(`comp_metrc_actions?select=id,action&pallet_id=eq.${job.pallet_id}&kind=in.(split,combine,new_package,harvest_package,proc_output)&status=in.(todo,error)&id=lt.${job.id}&limit=1`)
    if (open?.length) throw new Skip(`Covered by #${open[0].id} (${open[0].action}), which uses ${tag}`)
  }
  const p = await packageByTag(job.license, tag)
  if (p) throw new Skip(`METRC has ${tag} (${p.quantity} ${p.unitOfMeasureAbbreviation}, ${p.item?.name ?? ''})`)
  if (d.from) throw new Error(`METRC can't change a package's tag. Repackage ${up(d.from)} into ${tag} in METRC (new package from package), or put the old tag back in the app.`)
  throw new Error(`${tag} isn't an active package on ${job.license} in METRC yet`)
}

export async function sendNewPackageCheck(job, ctx) {
  const tag = up(job.tag)
  if (!tag) throw new Wait('No tag yet (tag pending). Set the tag, then check.')
  const p = await packageByTag(job.license, tag)
  if (!p) throw new Error(`${tag} isn't in METRC on ${job.license}. A package entered by hand has to be made in METRC from its source (harvest or package), or removed from the app if it was a mistake.`)
  const pal = await pallet(job.pallet_id)
  const app = pal?.current_weight != null ? r4(pal.current_weight) : null
  if (app != null && LB.test(p.unitOfMeasureAbbreviation || '') && Math.abs(r4(p.quantity) - app) > await tol()) {
    throw new Error(`METRC has ${tag} at ${p.quantity} lb, the app has ${app} lb. Fix one of them (Reconcile can take METRC's).`)
  }
  throw new Skip(`METRC has ${tag}: ${p.quantity} ${p.unitOfMeasureAbbreviation}, ${p.item?.name ?? ''}`)
}

/** shipped (or moved to the other site): METRC should show it on a manifest */
export async function sendShipCheck(job, ctx) {
  const tag = up(job.tag)
  if (!tag) throw new Error('No tag on this to-do')
  const lic = job.license ?? job.details?.from_license
  const where = await packageAnywhere(lic, tag)
  if (where?.state === 'intransit' || where?.state === 'transferred') {
    throw new Skip(`On METRC manifest ${where.p.manifestNumber ?? where.p.transferManifestNumber ?? '(number not shown)'}${where.state === 'intransit' ? ', in transit' : ''}`)
  }
  if (where?.state === 'active') throw new Error(`${tag} is still active on ${lic} in METRC. It needs a manifest (or the move hasn't happened in METRC).`)
  if (where?.state === 'inactive') throw new Error(`${tag} is finished in METRC on ${lic}, not shipped on a manifest. Check what happened to it.`)
  throw new Error(`${tag} isn't in METRC on ${lic}`)
}

// ---------- processor return: new package from the processor's package onto our tag (117) ----------
// The whole package, finished. Our item for the strain and product when METRC has it on this license; otherwise the
// processor's item ("use same item", always allowed for a received package) and the result says so.
const FINISH = { unbucked: 'UF', bucked: 'BF', bucked_standards: 'BS', standards: 'ST', smalls: 'SM', trim: 'TR' }
const FIN_RE = { unbucked: /unbucked/i, bucked: /bucked dry flower|bucked flower/i, standards: /standards/i, smalls: /smalls/i, trim: /trim/i }
export async function sendRetag(job, ctx) {
  const d = job.details || {}
  const lic = job.license
  if (!lic) throw new Error('No license on this to-do')
  const tag = up(job.tag ?? d.to), from = up(d.from)
  if (!tag || !from) throw new Error('This to-do is missing a tag')
  const done = await packageByTag(lic, tag)
  if (done) {
    if (lc(done.sourcePackageLabels ?? '').includes(lc(from))) throw new Skip(`METRC already has ${tag} from ${from}`)
    throw new Error(`${tag} is already a different METRC package (${done.item?.name ?? '?'}, ${done.quantity} ${done.unitOfMeasureAbbreviation ?? ''}). Pick another tag.`)
  }
  const src = await packageByTag(lic, from)
  if (!src) {
    const where = await packageAnywhere(lic, from)
    throw new Error(where ? `${from} is ${where.state} on ${lic} in METRC, not active. Receive the processor's manifest first.` : `${from} isn't in METRC on ${lic}`)
  }
  lbsOnly(src, from)
  const qty = r4(src.quantity)
  const pal = job.pallet_id ? await pallet(job.pallet_id) : null
  // our item: the app's item for this strain / product / crop year, if METRC has that name on this license
  const items = await cached(ctx, `items:${lic}`, () => all('/v2/packages/create/source-items', { licenseNumber: lic }, 10).catch(() => []))
  const strain = pal?.strain ?? d.strain, product = pal?.product ?? d.product ?? 'unbucked'
  const sn = lc(strain)
  const mine = sn ? await db(`items?select=metrc_name,crop_year,strains(name)&finish=eq.${FINISH[product] ?? 'UF'}&active=is.true&order=crop_year.desc`).catch(() => []) : []
  const want = (mine ?? []).filter(i => lc(i.strains?.name) === sn).map(i => lc(i.metrc_name))
  const ours = want.map(n => items.find(i => lc(i.name) === n)).find(Boolean)
    ?? items.find(i => sn && lc(i.strainName) === sn && (FIN_RE[product] ?? /./).test(i.name) && !/fresh frozen|wet|dry harvest/i.test(i.name))
  const r = await createFromPackages(ctx, job, {
    tag, qty, item: ours?.id ?? itemId(src),
    sources: [{ tag: from, p: src, take: qty, finish: true }],
    note: `Lifted app ${pal?.code ?? job.code ?? ''}: processor return onto our tag (was ${from})`,
  })
  r.info += ours ? ` · item ${ours.name}` : ` · kept the processor's item (${src.item?.name ?? '?'}): no ${strain ?? ''} ${product} item of ours on ${lic} in METRC`
  return r
}
