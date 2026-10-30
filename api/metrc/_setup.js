// New strain > METRC (132): create the strain on a license, then its items. Queued by metrc_strain_queue from the strain's
// METRC sheet; each to-do carries the name exactly as it should be in METRC. Anything METRC already has is linked, not made again.
import { Skip, Wait, all, cached, inputs, lc, rpc, unhtml, write } from './_core.js'

const strainsOn = (ctx, lic, fresh) => {
  if (fresh) { ctx.cache ??= {}; delete ctx.cache[`strains:${lic}`] }
  return cached(ctx, `strains:${lic}`, () => all('/v2/strains', { licenseNumber: lic }, 20))
}
const itemsOn = (ctx, lic, fresh) => {
  if (fresh) { ctx.cache ??= {}; delete ctx.cache[`items:all:${lic}`] }
  return cached(ctx, `items:all:${lic}`, () => all('/v2/items', { licenseNumber: lic }, 20))
}
const byName = (rows, name) => rows.find(x => !x.isArchived && lc(unhtml(x.name)) === lc(name)) ?? null
const pct = v => Math.round(Number(v ?? 0) * 100) / 100

// ---------- strain ----------
export async function sendStrainCreate(job, ctx) {
  const d = job.details || {}, lic = job.license
  if (!lic || !d.name) throw new Error('No license or strain name on this to-do')
  const have = byName(await strainsOn(ctx, lic), d.name)
  if (have) {
    await rpc('metrc_setup_done', { p_setup: d.setup_id, p_metrc_id: have.id, p_metrc_name: unhtml(have.name) })
    throw new Skip(`METRC already has the strain "${unhtml(have.name)}" on ${lic}`)
  }
  const indica = pct(d.indica ?? 50), sativa = pct(d.sativa ?? 50)
  const body = [{ name: d.name, testingStatus: d.testing || 'None', thcLevel: pct(d.thc), cbdLevel: pct(d.cbd), indicaPercentage: indica, sativaPercentage: sativa }]
  const resp = await write(ctx, '/v2/strains/create', lic, body)
  const what = `${d.name}${d.strain && d.strain !== d.name ? ` (${d.strain})` : ''}, ${indica}/${sativa} indica/sativa`
  if (!ctx.live) return { state: 'checked', request: body, response: resp, info: `Dry run OK: METRC would make the strain ${what} on ${lic}` }
  const made = byName(await strainsOn(ctx, lic, true), d.name)
  if (!made) throw new Error(`Sent, but METRC doesn't show the strain "${d.name}" on ${lic} yet. Check it in METRC (Admin > Strains).`)
  await rpc('metrc_setup_done', { p_setup: d.setup_id, p_metrc_id: made.id, p_metrc_name: unhtml(made.name) })
  return { state: 'sent', request: body, response: resp, info: `Made the strain ${what} on ${lic}` }
}

// ---------- item ----------
export async function sendItemCreate(job, ctx) {
  const d = job.details || {}, lic = job.license
  if (!lic || !d.name) throw new Error('No license or item name on this to-do')
  const items = await itemsOn(ctx, lic)
  const have = byName(items, d.name)
  if (have) {
    await rpc('metrc_setup_done', { p_setup: d.setup_id, p_metrc_id: have.id, p_metrc_name: unhtml(have.name), p_category: have.productCategoryName ?? null, p_uom: have.unitOfMeasureName ?? null })
    throw new Skip(`METRC already has the item "${unhtml(have.name)}" on ${lic}`)
  }
  const inp = await inputs(ctx, lic, '/v2/items/create/inputs')
  const cats = (inp?.itemCategories ?? []).filter(c => !c.isArchived)
  const uoms = (inp?.unitsOfMeasure ?? []).filter(u => !u.isArchived)

  // category + unit: the rule's (Compliance > Settings > METRC items), else copied from an item of the same kind on this license
  let cat = d.category ? cats.find(c => lc(c.name) === lc(d.category)) : null
  let uom = d.uom ? uoms.find(u => lc(u.name) === lc(d.uom) || lc(u.abbreviation) === lc(d.uom)) : null
  if (!cat || !uom) {
    const ending = lc(d.name.split(' - ').pop())
    const like = items.filter(x => !x.isArchived && x.productCategoryId && lc(unhtml(x.name)).endsWith(` - ${ending}`)).sort((a, b) => b.id - a.id)[0]
    if (like) {
      cat ??= cats.find(c => c.id === like.productCategoryId) ?? null
      uom ??= uoms.find(u => u.id === like.unitOfMeasureId) ?? null
    }
  }
  if (!cat) throw new Error(`No METRC category for "${d.name}" (${d.category ? `"${d.category}" isn't one of METRC's` : 'none set'}). METRC's: ${cats.map(c => c.name).join(', ')}. Set it in Compliance > Settings > METRC items.`)
  if (!uom) throw new Error(`No METRC unit for "${d.name}" (${d.uom ?? 'none set'}). METRC's: ${uoms.map(u => u.name).join(', ')}. Set it in Compliance > Settings > METRC items.`)

  const body = { name: d.name, productCategoryId: cat.id, unitOfMeasureId: uom.id }
  if (cat.requiresStrain) {
    // the strain has to be in METRC first (its own to-do comes before this one)
    const s = byName(await strainsOn(ctx, lic), d.strain_name || d.strain)
    if (!s) {
      if (!ctx.live) throw new Wait(`Dry run: the strain "${d.strain_name || d.strain}" isn't in METRC on ${lic} yet, so the item can't be checked until the strain is made (Live)`)
      throw new Wait(`Waiting for the strain "${d.strain_name || d.strain}" to be in METRC on ${lic}`)
    }
    body.strainId = s.id
  }
  const resp = await write(ctx, '/v2/items/create', lic, [body])
  const what = `${d.name} (${cat.name}, ${uom.name})`
  if (!ctx.live) return { state: 'checked', request: [body], response: resp, info: `Dry run OK: METRC would make the item ${what} on ${lic}` }
  const made = byName(await itemsOn(ctx, lic, true), d.name)
  if (!made) throw new Error(`Sent, but METRC doesn't show the item "${d.name}" on ${lic} yet. Check it in METRC (Admin > Items).`)
  await rpc('metrc_setup_done', { p_setup: d.setup_id, p_metrc_id: made.id, p_metrc_name: unhtml(made.name), p_category: cat.name, p_uom: uom.name })
  return { state: 'sent', request: [body], response: resp, info: `Made the item ${what} on ${lic}` }
}
