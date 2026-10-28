import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  const key = `${where.pallet ?? ''}|${where.slot ?? ''}|${where.purpose ?? ''}|${where.type ?? ''}|${where.site ?? ''}`

  useEffect(() => { let on = true; c?.search(where, null, 40).then(p => { if (on) setPool(p) }); return () => { on = false } }, [c, key])
  useEffect(() => { if (autofill && pool?.autofill && pool.tags.length && !value && !disabled) onChange(pool.tags[0]) }, [pool, autofill])

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
    if (q.length < 2 || hits?.q !== q) return (pool?.tags ?? []).slice(0, 40)
    const end = hits.tags.filter(t => t.endsWith(q)), rest = hits.tags.filter(t => !t.endsWith(q))
    return [...end, ...rest].slice(0, 60)
  }, [q, hits, pool])
  const ends = hits?.q === q && q.length < 24 ? hits.tags.filter(t => t.endsWith(q)) : []
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
    const h = (e: MouseEvent | TouchEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
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
    {showList && <div className="tagbox-list" id={`tl${lid}`} role="listbox">
      {list.map((t, i) => <button type="button" key={t} role="option" aria-selected={i === hi} className={`mono-in ${i === hi ? 'on' : ''}`}
        onMouseDown={e => e.preventDefault()} onClick={() => pick(t)}>{mark(t)}</button>)}
    </div>}
    {!compact && pool?.from_metrc && <div className="muted small-note">{pool.license}{pool.free != null ? ` · ${pool.free.toLocaleString()} available` : ''}
      {only && digits ? <> · <b>Enter</b> for …{only.slice(-9)}</> : q.length >= 2 && !full && hits?.q === q ? ` · ${hits.tags.length >= 200 ? '200+' : hits.tags.length} match` : ''}</div>}
    {compact && only && digits && <div className="muted small-note">Enter for …{only.slice(-9)}</div>}
    {off && why?.tag === q && why.text && <div className="warn-t small-note">{why.text}</div>}
  </div>
}
