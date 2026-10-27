import { createContext, useContext, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// Tag suggestions for tag boxes on the freezer map: the next available METRC tags for the site (from METRC's available list,
// pulled through T3), skipping tags blocked off for other purposes (tag ranges) and tags already on something in the app.
// With autofill on (Compliance > Settings > METRC tags), an empty tag box starts with the next one filled in.

export interface TagPool { license: string | null; tags: string[]; from_metrc: boolean; autofill: boolean; pulled: string | null }
type Fetch = (purpose?: string, type?: 'package' | 'plant') => Promise<TagPool | null>
const Ctx = createContext<{ fetch: Fetch } | null>(null)

export function TagSuggestProvider({ sb, site, children }: { sb: SupabaseClient | null; site: string; children: ReactNode }) {
  const fetch: Fetch = async (purpose = 'mixed', type = 'package') => {
    if (!sb) return null
    const { data, error } = await sb.rpc('tag_suggest', { p_site: site, p_purpose: purpose, p_count: 40, p_type: type })
    return error ? null : (data as TagPool)
  }
  return <Ctx.Provider value={{ fetch }}>{children}</Ctx.Provider>
}

/** next available tags for a tag box (fetched when it opens), and whether to fill the first one in */
export function useTagPool(purpose = 'mixed', type: 'package' | 'plant' = 'package') {
  const c = useContext(Ctx)
  const [pool, setPool] = useState<TagPool | null>(null)
  useEffect(() => { let on = true; c?.fetch(purpose, type).then(p => { if (on) setPool(p) }); return () => { on = false } }, [c, purpose, type])
  return pool
}

/** a datalist of suggestions; returns its id for <input list=…> */
export function TagList({ tags }: { tags: string[] }) {
  const id = useId()
  return <datalist id={`tags${id}`}>{tags.map(t => <option key={t} value={t} />)}</datalist>
}
export const tagListId = (id: string) => `tags${id}`
