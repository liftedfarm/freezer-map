import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ScanButton } from './scan'
import { useTagCtx } from './tagSuggest'
import type { TagPool, TagWhere } from './tagSuggest'

// One METRC tag box for every screen that picks a tag (splits, combines, mixed pallets, fulfillment, harvest, processing,
// nursery). Suggestions come from METRC's available list for the license of the pallet / slot / site (tag_search):
//  * autofill: an empty box starts with the next available tag (Compliance > Settings > METRC tags), where the screen asks for it
//  * type the last digits (e.g. 477) and the matching tags come up, ones ending in those digits first; when only one tag ends
//    in them, Enter or leaving the box fills in the whole tag
//  * a full tag that isn't available says why: already on a pallet in the app, on another license's list, or not on the list

const clean = (v: string) => v.toUpperCase().replace(/\s/g, '')

// every tag box on the screen shares what it holds, so a tag picked on one line isn't offered on another
const held = new Map<string, string>()
let heldVer = 0
const subs = new Set<() => void>()
const setHeld = (id: string, v: string | null) => {
  const prev = held.get(id) ?? null
  if (prev === v) return
  if (v) held.set(id, v); else held.delete(id)
  heldVer++; subs.forEach(f => f())
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const useHeldVersion = () => useSyncExternalStore(subscribe, () => heldVer)
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

export function TagInput({ value, onChange, where = {}, keep, disabled, placeholder, autofill, compact, autoFocus }: {
  value: string; onChange: (v: string) => void; where?: TagWhere; keep?: string | null; disabled?: boolean; placeholder?: string
  /** start an empty box with the next available tag */
  autofill?: boolean; compact?: boolean; autoFocus?: boolean
}) {
  const c = useTagCtx()
  const lid = useId()
  const [pool, setPool] = useState<TagPool | null>(null)
  const [hits, setHits] = useState<{ q: string; tags: string[] } | null>(null)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [why, setWhy] = useState<{ tag: string; text: string } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const listEl = useRef<HTMLDivElement>(null)
  const ver = useHeldVersion()
  // this box's tag, for the other boxes on the screen
  useEffect(() => { setHeld(lid, clean(value).length === 24 ? clean(value) : null) }, [lid, value])
  useEffect(() => () => setHeld(lid, null), [lid])
  const others = useMemo(() => new Set([...held.entries()].filter(([k]) => k !== lid).map(([, v]) => v)), [ver, lid])
  const key = `${where.pallet ?? ''}|${where.slot ?? ''}|${where.purpose ?? ''}|${where.type ?? ''}|${where.site ?? ''}`

  useEffect(() => { let on = true; c?.search(where, null, 40).then(p => { if (on) setPool(p) }); return () => { on = false } }, [c, key])
  useEffect(() => { const t = pool?.tags.find(x => !others.has(x)); if (autofill && pool?.autofill && t && !value && !disabled) onChange(t) }, [pool, autofill])

  const q = clean(value)
  const digits = /^\d+$/.test(q)
  useEffect(() => {
    if (!c || q.length < 2 || !pool?.from_metrc || (keep && q === clean(keep))) { setHits(null); return }
    let on = true
    const t = setTimeout(() => c.search(where, q, digits ? 500 : 200).then(p => { if (on && p) setHits({ q, tags: p.tags }) }), 200)
    return () => { on = false; clearTimeout(t) }
  }, [c, key, q, pool?.from_metrc])

  // ones ending in what was typed first (last digits), then the rest that contain it
  const list = useMemo(() => {
    if (q.length < 2 || hits?.q !== q) return (pool?.tags ?? []).filter(t => !others.has(t)).slice(0, 40)
    const end = hits.tags.filter(t => t.endsWith(q) && !others.has(t)), rest = hits.tags.filter(t => !t.endsWith(q) && !others.has(t))
    return [...end, ...rest].slice(0, 60)
  }, [q, hits, pool, others])
  const ends = hits?.q === q && q.length < 24 ? hits.tags.filter(t => t.endsWith(q) && !others.has(t)) : []
  const only = ends.length === 1 ? ends[0] : null
  const full = q.length === 24
  const off = !!pool?.from_metrc && full && hits?.q === q && !hits.tags.includes(q) && !(keep && clean(keep) === q)

  // why a full tag isn't available
  useEffect(() => {
    if (!off || !c?.sb) { setWhy(null); return }
    let on = true
    ;(async () => {
      const sb = c.sb!
      const [{ data: pal }, { data: lists }] = await Promise.all([
        sb.from('pallets').select('id,code,status').eq('package_tag', q).limit(1),
        sb.from('metrc_tags').select('license').eq('label', q).limit(3)])
      if (!on) return
      const p = (pal ?? [])[0] as { id: number; code: string; status: string } | undefined
      // just saved on this same pallet: nothing wrong
      if (p && where.pallet != null && p.id === where.pallet) { setWhy({ tag: q, text: '' }); return }
      const other = ((lists ?? []) as { license: string }[]).map(x => x.license).filter(l => l !== pool?.license)
      const text = p ? `Already on ${p.code} in the app (${p.status.replace('_', ' ')}). A tag can only be on one pallet.`
        : other.length ? `That tag is on ${other.join(', ')}'s list, not ${pool?.license}'s (the license this pallet is on).`
        : `Not on METRC's available list for ${pool?.license}${pool?.pulled ? ` (pulled ${when(pool.pulled)})` : ''}: used, voided or never issued. If it was freed up since, pull tags again in Admin › Settings › Licenses.`
      setWhy({ tag: q, text })
    })().catch(() => {})
    return () => { on = false }
  }, [off, q])

  // close when tapping outside
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent | TouchEvent) => { const n = e.target as Node; if (box.current && !box.current.contains(n) && !listEl.current?.contains(n)) setOpen(false) }
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h) }
  }, [open])

  const pick = (t: string) => { onChange(t); setOpen(false); setHi(0) }
  const mark = (t: string) => {
    if (q.length < 2) return <>{t}</>
    const i = t.endsWith(q) ? t.length - q.length : t.indexOf(q)
    if (i < 0) return <>{t}</>
    return <>{t.slice(0, i)}<b>{t.slice(i, i + q.length)}</b>{t.slice(i + q.length)}</>
  }
  const showList = open && !disabled && list.length > 0 && !(full && list.length === 1 && list[0] === q)
  const dup = full && others.has(q)

  // the list floats over the page (not inside a table or sheet that would cut it off), under the box or above it near the bottom
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null)
  useLayoutEffect(() => {
    if (!showList) { setPos(null); return }
    const place = () => {
      const r = box.current?.querySelector('.tagbox-in')?.getBoundingClientRect() ?? box.current?.getBoundingClientRect()
      if (!r) return
      const vw = window.innerWidth, vh = window.innerHeight
      const width = Math.min(Math.max(r.width, 300), vw - 16)
      const left = Math.max(8, Math.min(r.left, vw - width - 8))
      const below = vh - r.bottom - 8, above = r.top - 8
      if (below >= 180 || below >= above) setPos({ left, top: r.bottom + 2, width, maxH: Math.min(264, below) })
      else setPos({ left, bottom: vh - r.top + 2, width, maxH: Math.min(264, above) })
    }
    place()
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [showList])

  return <div className={`tagbox ${compact ? 'compact' : ''}`} ref={box}>
    <div className="row tagrow">
      <input className="mono-in tagbox-in" value={value} disabled={disabled} autoFocus={autoFocus} spellCheck={false} autoComplete="off"
        placeholder={placeholder ?? 'Type the last digits or scan'} aria-controls={`tl${lid}`}
        onFocus={e => { setOpen(true); if (e.target.value.length === 24) e.target.select() }}
        onChange={e => { onChange(clean(e.target.value)); setOpen(true); setHi(0) }}
        onBlur={() => { if (only && digits) onChange(only) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, list.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter' && showList && (only || list[hi])) { e.preventDefault(); pick(only && hi === 0 ? only : list[hi]) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      <ScanButton compact={compact} disabled={disabled} onScan={t => pick(clean(t))} />
    </div>
    {showList && pos && createPortal(<div className="tagbox-list floating" id={`tl${lid}`} role="listbox" ref={listEl}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxH }}>
      {list.map((t, i) => <button type="button" key={t} role="option" aria-selected={i === hi} className={`mono-in ${i === hi ? 'on' : ''}`}
        onMouseDown={e => e.preventDefault()} onClick={() => pick(t)}>{mark(t)}</button>)}
    </div>, document.body)}
    {!compact && pool?.from_metrc && <div className="muted small-note">{pool.license}{pool.free != null ? ` · ${pool.free.toLocaleString()} available` : ''}
      {only && digits ? <> · <b>Enter</b> for …{only.slice(-9)}</> : q.length >= 2 && !full && hits?.q === q ? ` · ${hits.tags.length >= 200 ? '200+' : hits.tags.length} match` : ''}</div>}
    {compact && only && digits && <div className="muted small-note">Enter for …{only.slice(-9)}</div>}
    {dup && <div className="warn-t small-note">Already picked on another line here.</div>}
    {off && why?.tag === q && why.text && <div className="warn-t small-note">{why.text}</div>}
  </div>
}
