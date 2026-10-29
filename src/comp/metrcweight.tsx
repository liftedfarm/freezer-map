import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

// TEMPORARY (114): METRC's weight next to the app's on the pallet card, while the app and METRC get in sync.
// Remove with "App only" / "METRC only" weight adjustments once they are (see Remove before full production).

export type MetrcWeight = {
  tag: string | null; license?: string; found?: boolean; lbs?: number | null; qty?: number | null; uom?: string | null
  state?: string | null; item?: string | null; seen_at?: string | null; open_todos?: number
}
type Live = { found: boolean; state?: string; qty?: number | null; uom?: string | null; last_modified?: string | null } | { error: string }

const r2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number | null | undefined) => (n == null ? '?' : `${r2(Number(n)).toLocaleString()} lbs`)
const when = (s: string | null | undefined) => {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const STATE: Record<string, string> = { active: '', intransit: 'in transit', transferred: 'transferred out', inactive: 'finished', gone: 'gone from METRC' }

/** what METRC had for this pallet's tag at the last pull (null = 114 not run, or no access) */
export async function metrcWeight(sb: SupabaseClient, palletId: number): Promise<MetrcWeight | null> {
  const { data, error } = await sb.rpc('pallet_metrc_weight', { p_pallet_id: palletId })
  return error ? null : (data as MetrcWeight)
}

async function liveWeight(sb: SupabaseClient, palletId: number): Promise<Live> {
  const { data } = await sb.auth.getSession()
  const r = await fetch('/api/metrc/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ action: 'package_weight', pallet_id: palletId }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error || `METRC check failed (${r.status})` }
  return j as Live
}

/** <dl> row: METRC weight, with how far it is from the app's */
export function MetrcWeightRow({ sb, palletId, appLbs, tag }: { sb: SupabaseClient | null; palletId: number; appLbs: number | null; tag: string | null }) {
  const [w, setW] = useState<MetrcWeight | null | undefined>(undefined)
  const [live, setLive] = useState<Live | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => { if (!sb) return; setW(undefined); setLive(null); metrcWeight(sb, palletId).then(setW).catch(() => setW(null)) }, [sb, palletId, appLbs, tag])
  if (!sb || w === null) return null   // 114 not run yet
  if (!tag) return null                // no tag, nothing to compare
  const diffNote = (m: number | null | undefined) => {
    if (m == null || appLbs == null) return null
    const d = r2(Number(m) - appLbs)
    return d === 0 ? <span className="pill okp">same as app</span> : <span className="pill warnp">{d > 0 ? '+' : ''}{d.toLocaleString()} lbs vs app</span>
  }
  const check = async () => {
    setChecking(true)
    try { setLive(await liveWeight(sb, palletId)) } catch (e) { setLive({ error: e instanceof Error ? e.message : String(e) }) } finally { setChecking(false) }
  }
  return <>
    <dt>METRC weight</dt>
    <dd>
      {w === undefined ? <span className="muted">…</span>
        : !w.found ? <span className="muted">not in METRC's last pull</span>
        : <>{fmt(w.lbs ?? w.qty)} {STATE[w.state ?? ''] ? <span className="muted">({STATE[w.state ?? '']})</span> : null} {diffNote(w.lbs ?? w.qty)}
            <div className="muted small">as of the last METRC pull{w.seen_at ? `, ${when(w.seen_at)}` : ''}</div></>}
      {live && ('error' in live ? <div className="small neg">{live.error}</div>
        : !live.found ? <div className="small"><b>Right now:</b> not on this license in METRC</div>
        : <div className="small"><b>Right now:</b> {fmt(live.qty)}{live.uom && !/^lb/i.test(live.uom) ? ` (${live.uom})` : ''}
            {STATE[live.state ?? ''] ? <span className="muted"> ({STATE[live.state ?? '']})</span> : null} {diffNote(live.qty)}</div>)}
      {w?.open_todos ? <div className="muted small">{w.open_todos} METRC to-do{w.open_todos === 1 ? '' : 's'} still waiting on this tag, so a difference can be expected</div> : null}
      <div><a className="small" onClick={() => !checking && check()}>{checking ? 'Checking METRC…' : 'Check METRC now'}</a></div>
    </dd>
  </>
}
