// Tag runs for plantings: batch tags (one per 100 plants) and flowering tags (one per plant).
// A run is an unbroken stretch of plant tag numbers on the farm license. checkRun says which tags in it are missing from
// METRC's available list, blocked off, held for another planting, or already on something in the app; suggestRun finds the
// next clean run of the size needed. Licenses whose plant tags are kept in the app (Pull tags) are checked in the database;
// the rest (OHR has 400k+) are checked live against T3 by counting tags under label prefixes.
import { list, one, rpc, t3, up } from './_core.js'

const PRE = 15, DIG = 9
export const label = (prefix, n) => prefix + String(n).padStart(DIG, '0')
export const num = l => (/^[0-9]{9}$/.test(String(l).slice(-DIG)) && String(l).length === PRE + DIG ? Number(String(l).slice(-DIG)) : null)

// ---------- live counts from T3 ----------
const PLANT = 'tagInventoryTypeName__eq:CannabisPlant'
async function t3Tags(lic, starts, pageSize = 1, sort) {
  return t3('GET', '/v2/tags/available', { query: { licenseNumber: lic, filter: [PLANT, `label__startswith:${starts}`], filterLogic: 'and', page: 1, pageSize, sort } })
}
/** aligned blocks covering lo..hi: [start, size] with size a power of 10 and start a multiple of it */
function blocks(lo, hi) {
  const out = []
  let n = lo
  while (n <= hi) {
    let size = 1
    while (n % (size * 10) === 0 && n + size * 10 - 1 <= hi) size *= 10
    out.push([n, size]); n += size
  }
  return out
}
const blockPrefix = (prefix, n, size) => label(prefix, n).slice(0, PRE + DIG - Math.round(Math.log10(size)))
async function pool(items, k, fn) {
  const out = []; let i = 0
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]) } }))
  return out
}
function merge(iv) {
  const s = [...iv].sort((a, b) => a.lo - b.lo), out = []
  for (const x of s) { const l = out[out.length - 1]; if (l && x.lo <= l.hi + 1) l.hi = Math.max(l.hi, x.hi); else out.push({ ...x }) }
  return out
}
/** gaps in METRC's available plant tags between lo and hi, from T3 */
async function t3Missing(lic, prefix, lo, hi, budget = { calls: 0, max: 250 }) {
  const out = []
  const walk = async bl => {
    const res = await pool(bl, 6, async ([n, size]) => {
      if (++budget.calls > budget.max) throw new Error('Too many gaps in the tags to check this run. Try a different start tag.')
      const p = blockPrefix(prefix, n, size)
      if (size <= 100) {
        const j = await t3Tags(lic, p, 100)
        const have = new Set(list(j).filter(t => !t.isUsed && !t.isArchived).map(t => num(up(t.label))))
        let gap = null
        for (let x = n; x < n + size; x++) {
          if (!have.has(x)) { if (gap && gap.hi === x - 1) gap.hi = x; else { gap = { lo: x, hi: x }; out.push(gap) } }
        }
        return null
      }
      const j = await t3Tags(lic, p, 1)
      const c = Number(j?.total ?? list(j).length)
      if (c >= size) return null
      if (c === 0) { out.push({ lo: n, hi: n + size - 1 }); return null }
      return Array.from({ length: 10 }, (_, i) => [n + i * (size / 10), size / 10])
    })
    const next = res.filter(Boolean).flat()
    if (next.length) await walk(next)
  }
  await walk(blocks(lo, hi))
  return merge(out)
}

/** the last tag number missing between lo and hi (null when none): the suggester only needs to jump past it */
async function t3LastMissing(lic, prefix, lo, hi, budget) {
  const look = async bl => {
    const counts = await pool(bl, 6, async ([n, size]) => {
      if (++budget.calls > budget.max) throw new Error('Too many gaps in the tags to look through. Pick a start tag by hand.')
      return Number((await t3Tags(lic, blockPrefix(prefix, n, size), 1))?.total ?? 0)
    })
    for (let i = bl.length - 1; i >= 0; i--) {
      const [n, size] = bl[i]
      if (counts[i] >= size) continue
      if (counts[i] === 0) return n + size - 1
      if (size <= 100) {
        if (++budget.calls > budget.max) throw new Error('Too many gaps in the tags to look through. Pick a start tag by hand.')
        const have = new Set(list(await t3Tags(lic, blockPrefix(prefix, n, size), 100)).filter(t => !t.isUsed && !t.isArchived).map(t => num(up(t.label))))
        for (let x = n + size - 1; x >= n; x--) if (!have.has(x)) return x
        continue
      }
      const r = await look(Array.from({ length: 10 }, (_, k) => [n + k * (size / 10), size / 10]))
      if (r != null) return r
    }
    return null
  }
  return look(blocks(lo, hi))
}

// ---------- one license's plant tags ----------
async function source(lic) {
  const meta = await rpc('tag_range_meta', { p_license: lic, p_type: 'plant' })
  if (meta.stored) {
    const missing = async (prefix, lo, hi) => (await rpc('tag_range_missing', { p_license: lic, p_type: 'plant', p_prefix: prefix, p_lo: lo, p_hi: hi })).map(r => ({ lo: Number(r.lo), hi: Number(r.hi) }))
    return { meta, stored: true, prefixes: meta.prefixes, missing,
      lastMissing: async (prefix, lo, hi) => { const m = await missing(prefix, lo, hi); return m.length ? Math.max(...m.map(x => x.hi)) : null } }
  }
  const budget = { calls: 0, max: 400 }
  const ends = async sort => list(await t3('GET', '/v2/tags/available', { query: { licenseNumber: lic, filter: PLANT, page: 1, pageSize: 1, sort } }))[0]
  const [a, z] = await Promise.all([ends('label:asc'), ends('label:desc')])
  if (!a) return { meta, stored: false, prefixes: [], missing: async (_p, lo, hi) => [{ lo, hi }], lastMissing: async (_p, _lo, hi) => hi }
  const A = up(a.label), Z = up(z?.label ?? a.label)
  const prefixes = A.slice(0, PRE) === Z.slice(0, PRE) ? [{ prefix: A.slice(0, PRE), lo: num(A), hi: num(Z) }]
    : [{ prefix: A.slice(0, PRE), lo: num(A), hi: 999999999 }, { prefix: Z.slice(0, PRE), lo: 1, hi: num(Z) }]
  return { meta, stored: false, prefixes, missing: (prefix, lo, hi) => t3Missing(lic, prefix, lo, hi, budget),
    lastMissing: (prefix, lo, hi) => t3LastMissing(lic, prefix, lo, hi, budget) }
}

async function problems(src, lic, prefix, lo, hi, purpose, plantingId) {
  const [miss, conf] = await Promise.all([
    src.missing(prefix, lo, hi),
    rpc('tag_range_conflicts', { p_license: lic, p_prefix: prefix, p_lo: lo, p_hi: hi, p_purpose: purpose, p_planting: plantingId }),
  ])
  return [...miss.map(m => ({ lo: m.lo, hi: m.hi, why: 'not on METRC\'s available list (used, voided, or never issued)' })),
          ...conf.map(c => ({ lo: Number(c.lo), hi: Number(c.hi), why: c.why }))].sort((a, b) => a.lo - b.lo)
}
const show = (prefix, p) => ({ from: label(prefix, p.lo), to: label(prefix, p.hi), tags: p.hi - p.lo + 1, why: p.why })

/** the planting, its license, and how many tags each purpose needs */
export async function plantingNeeds(id) {
  const pl = await one(`cult_plantings?id=eq.${Number(id)}&select=id,site,strain,plants,plant_loss,flipped_on,field_id`)
  if (!pl) throw new Error('Planting not found')
  const lic = await rpc('planting_license', { p_planting: pl.id })
  if (!lic) throw new Error(`No cultivation license for ${pl.site}`)
  const left = Math.max(0, Number(pl.plants ?? 0) - Number(pl.plant_loss ?? 0))
  return { pl, lic, need: { batch: Math.ceil(Number(pl.plants ?? 0) / 100), flower: left } }
}

/** check a run starting at `first` for `count` tags */
export async function checkRun({ plantingId, purpose, first, count }) {
  const { lic } = await plantingNeeds(plantingId)
  const f = up(first), lo = num(f)
  if (lo == null) throw new Error(`A METRC tag is 24 characters ending in 9 digits: ${f}`)
  const n = Math.floor(Number(count))
  if (!(n >= 1 && n <= 100000)) throw new Error('How many tags?')
  const prefix = f.slice(0, PRE), hi = lo + n - 1
  const src = await source(lic)
  const bad = await problems(src, lic, prefix, lo, hi, purpose, plantingId)
  return { license: lic, live: !src.stored, first: label(prefix, lo), last: label(prefix, hi), count: n, ok: bad.length === 0,
    problems: bad.slice(0, 30).map(p => show(prefix, p)), bad_tags: bad.reduce((s, p) => s + p.hi - p.lo + 1, 0) }
}

/** the next clean run of `count` tags (after `after` when given, else after the last run handed out) */
export async function suggestRun({ plantingId, purpose, count, after }) {
  const { lic } = await plantingNeeds(plantingId)
  const n = Math.floor(Number(count))
  if (!(n >= 1 && n <= 100000)) throw new Error('How many tags?')
  const src = await source(lic)
  if (!src.prefixes.length) return { license: lic, live: !src.stored, ok: false, error: `No plant tags available on ${lic} in METRC` }
  const aft = after ? up(after) : null
  const starts = []
  for (const p of src.prefixes) {
    if (aft && aft.slice(0, PRE) === p.prefix) starts.push({ ...p, s: Math.max(p.lo, num(aft) + 1) })
    else if (!aft && src.meta.last?.prefix === p.prefix && Number(src.meta.last.n) + 1 <= p.hi) starts.push({ ...p, s: Math.max(p.lo, Number(src.meta.last.n) + 1) })
    starts.push({ ...p, s: p.lo })
  }
  const t0 = Date.now()
  for (const st of starts) {
    let s = st.s
    for (let tries = 0; tries < 200 && s + n - 1 <= st.hi && Date.now() - t0 < 40000; tries++) {
      // blocked off / held / on something first (one database call), then METRC's gaps (only the last one matters)
      const conf = await rpc('tag_range_conflicts', { p_license: lic, p_prefix: st.prefix, p_lo: s, p_hi: s + n - 1, p_purpose: purpose, p_planting: plantingId })
      if (conf.length) { s = Math.max(...conf.map(c => Number(c.hi))) + 1; continue }
      const gap = await src.lastMissing(st.prefix, s, s + n - 1)
      if (gap == null) return { license: lic, live: !src.stored, ok: true, first: label(st.prefix, s), last: label(st.prefix, s + n - 1), count: n, problems: [] }
      s = gap + 1
    }
  }
  return { license: lic, live: !src.stored, ok: false, error: `No unbroken run of ${n} plant tags found on ${lic}${aft ? ` after ${aft}` : ''}. Pick a start tag by hand, or pull tags again.` }
}

/** the run held for a planting, as labels in order (null when none) */
export async function heldRun(plantingId, purpose) {
  const a = await one(`tag_assignments?planting_id=eq.${Number(plantingId)}&purpose=eq.${purpose}&active=is.true&select=*`)
  if (!a) return null
  return { ...a, at: i => label(a.prefix, Number(a.first_n) + i), size: Number(a.last_n) - Number(a.first_n) + 1 }
}
