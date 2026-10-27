import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// Tag suggestions for tag boxes: METRC's available tags (pulled through T3) on the license of the pallet or slot being worked on,
// skipping tags blocked off for other purposes, tags held for a planting, and tags already on something in the app.
// Typing searches every available tag on that license (any part of the tag). With autofill on (Compliance > Settings > METRC tags),
// an empty tag box starts with the next one filled in.

export interface TagPool { license: string | null; tags: string[]; from_metrc: boolean; autofill: boolean; pulled: string | null; free?: number | null; q?: string | null }
export interface TagWhere { pallet?: number | null; slot?: number | null; purpose?: string; type?: 'package' | 'plant' }
type Search = (w: TagWhere, q?: string | null, count?: number) => Promise<TagPool | null>
const Ctx = createContext<{ search: Search } | null>(null)

export function TagSuggestProvider({ sb, site, children }: { sb: SupabaseClient | null; site: string; children: ReactNode }) {
  const search: Search = async (w, q = null, count = 200) => {
    if (!sb) return null
    const { data, error } = await sb.rpc('tag_search', { p_pallet: w.pallet ?? null, p_slot: w.slot ?? null, p_site: site, p_q: q || null,
      p_purpose: w.purpose ?? 'mixed', p_type: w.type ?? 'package', p_count: count })
    return error ? null : (data as TagPool)
  }
  return <Ctx.Provider value={{ search }}>{children}</Ctx.Provider>
}

/** suggestions for one tag box: the next available tags, and as the user types, every available tag that matches */
export function useTagSearch(w: TagWhere, typed: string) {
  const c = useContext(Ctx)
  const [pool, setPool] = useState<TagPool | null>(null)
  const [hits, setHits] = useState<{ q: string; tags: string[] } | null>(null)
  const key = `${w.pallet ?? ''}|${w.slot ?? ''}|${w.purpose ?? ''}|${w.type ?? ''}`
  useEffect(() => { let on = true; c?.search(w).then(p => { if (on) setPool(p) }); return () => { on = false } }, [c, key])
  const q = typed.trim().toUpperCase()
  useEffect(() => {
    if (!c || q.length < 3 || !pool?.from_metrc) { setHits(null); return }
    let on = true
    const t = setTimeout(() => c.search(w, q, 200).then(p => { if (on && p) setHits({ q, tags: p.tags }) }), 250)
    return () => { on = false; clearTimeout(t) }
  }, [c, key, q, pool?.from_metrc])
  const tags = q.length >= 3 && hits?.q === q ? hits.tags : pool?.tags ?? []
  // a full tag that isn't on the list: warn (it may be used, voided, on another license, or held for something else)
  const off = !!pool?.from_metrc && q.length === 24 && hits?.q === q && !hits.tags.includes(q)
  return { pool, tags, off }
}
