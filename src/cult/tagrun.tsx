import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { metrcRun } from '../metrcCall'
import { n0 } from './calc'
import { errText } from './ui'

// The physical plant tags a planting uses, picked as one unbroken run:
//   batch tags     one per immature plant batch (California: up to 100 plants each), used when METRC makes the batches
//   flowering tags one per plant, used at the flip
// The app suggests the next clean run, checks any run against METRC (missing, blocked off, held for another planting,
// already on something), and holds it for the planting so nothing else hands those tags out.

export type RunPurpose = 'batch' | 'flower'
export interface HeldRun { id: number; purpose: RunPurpose; first_label: string; last_label: string; tags: number; license: string; created_by: string | null; created_at: string }
interface Problem { from: string; to: string; tags: number; why: string }
interface Check { ok: boolean; first?: string; last?: string; count?: number; license?: string; live?: boolean; problems?: Problem[]; bad_tags?: number; error?: string; saved?: boolean }

const WHAT: Record<RunPurpose, string> = { batch: 'Batch tags', flower: 'Flowering tags' }
const tail = (l: string) => l.slice(-9)
const span = (a: string, b: string) => (a === b ? a : `${a} – ${tail(b)}`)

export function useHeldRuns(sb: SupabaseClient, plantingId: number | undefined) {
  const [runs, setRuns] = useState<HeldRun[]>([])
  const load = async () => {
    if (!plantingId) return
    const { data } = await sb.from('tag_assignments').select('id,purpose,first_label,last_label,tags,license,created_by,created_at').eq('planting_id', plantingId).eq('active', true)
    setRuns((data ?? []) as HeldRun[])
  }
  useEffect(() => { load() }, [plantingId])
  return { runs, reload: load, get: (p: RunPurpose) => runs.find(r => r.purpose === p) ?? null }
}

/** pick / check / hold one run for a planting */
export function TagRunBox({ sb, plantingId, purpose, need, held, locked, onChange }: {
  sb: SupabaseClient; plantingId: number; purpose: RunPurpose; need: number; held: HeldRun | null; locked?: boolean; onChange: () => void
}) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState(need)
  const [first, setFirst] = useState('')
  const [chk, setChk] = useState<Check | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const call = (b: object) => metrcRun<Check>(sb, { action: 'tag_range', planting_id: plantingId, purpose, ...b })

  const suggest = async (after?: string) => {
    setBusy('Finding the next unbroken run…'); setErr(null)
    try {
      const r = await call({ count, after })
      if (!r.ok) { setErr(r.error ?? 'No run found'); setChk(null) }
      else { setFirst(r.first!); setChk(r) }
    } catch (e) { setErr(errText(e)) } finally { setBusy(null) }
  }
  const check = async (f: string) => {
    setBusy('Checking the run against METRC…'); setErr(null)
    try { setChk(await call({ first: f, count })) } catch (e) { setErr(errText(e)); setChk(null) } finally { setBusy(null) }
  }
  const hold = async () => {
    setBusy('Holding the run…'); setErr(null)
    try {
      const r = await call({ first, count, save: true })
      setChk(r)
      if (r.saved) { setOpen(false); onChange() }
    } catch (e) { setErr(errText(e)) } finally { setBusy(null) }
  }
  const release = async () => {
    if (!confirm(`Let go of the ${WHAT[purpose].toLowerCase()} held for this planting?`)) return
    const { error } = await sb.rpc('tag_unassign', { p_planting: plantingId, p_purpose: purpose })
    if (error) setErr(error.message); else onChange()
  }

  // opening the picker suggests a run straight away
  useEffect(() => { if (open && !first && need > 0) suggest() }, [open])
  // a typed (or scanned) start tag is checked once it's a whole tag
  useEffect(() => {
    if (!open) return
    const f = first.trim().toUpperCase()
    if (f.length !== 24 || (chk?.first === f && chk?.count === count)) return
    const t = setTimeout(() => check(f), 500)
    return () => clearTimeout(t)
  }, [first, count, open])

  const short = held && held.tags !== need
  return (
    <div className="tagrun">
      <div className="row wrap" style={{ alignItems: 'center', gap: 8 }}>
        <b>{WHAT[purpose]}</b>
        <span className="muted">{purpose === 'batch' ? `one per 100 plants: ${n0(need)} needed` : `one per plant: ${n0(need)} needed`}</span>
        {held
          ? <span className="mono">{span(held.first_label, held.last_label)} <span className="muted">({n0(held.tags)})</span></span>
          : <span className="warn-t">none picked</span>}
        {!locked && !open && <button className="ghost small" onClick={() => { setCount(need); setFirst(''); setChk(null); setOpen(true) }}>{held ? 'Change' : 'Pick run'}</button>}
        {!locked && held && !open && <button className="ghost small" onClick={release}>Release</button>}
      </div>
      {short && !open && <div className="warn-t small-note">The run has {n0(held!.tags)} tags; the planting needs {n0(need)}. {purpose === 'flower' ? 'Pick it again before the flip.' : 'Pick it again if the batches need more.'}</div>}
      {locked && held && <div className="muted small-note">In METRC already: the run can't change.</div>}
      {open && <div className="tagrun-pick">
        <div className="tagrun-row">
          <div className="field"><label>Tags</label>
            <input type="number" min={1} value={count} onChange={e => { setCount(Math.max(1, Math.floor(Number(e.target.value) || 1))); setChk(null) }} /></div>
          <div className="field grow"><label>First tag <span className="muted">(type it, or Suggest)</span></label>
            <input className="mono-in" value={first} placeholder="1A40603000…" onChange={e => { setFirst(e.target.value.toUpperCase().replace(/\s/g, '')); setChk(null) }} /></div>
          <button className="ghost small" disabled={!!busy} onClick={() => suggest()}>Suggest</button>
          {chk?.last && <button className="ghost small" disabled={!!busy} onClick={() => suggest(chk.last)}>Next run</button>}
        </div>
        {busy && <div className="muted small-note">{busy}</div>}
        {err && <div className="tr-bad small-note">{err}</div>}
        {chk && !busy && (chk.ok
          ? <div className="tr-ok small-note">✓ {span(chk.first!, chk.last!)}: all {n0(chk.count!)} tags are available on {chk.license} and free in the app.</div>
          : <div className="tr-bad small-note">
              {span(chk.first!, chk.last!)}: {n0(chk.bad_tags ?? 0)} of {n0(chk.count!)} tags can't be used.
              <ul className="mlist">{(chk.problems ?? []).map((p, i) => <li key={i}><span className="mono">{span(p.from, p.to)}</span>{p.tags > 1 ? ` (${n0(p.tags)})` : ''}: {p.why}</li>)}</ul>
            </div>)}
        <div className="row end" style={{ gap: 8 }}>
          <button className="ghost small" onClick={() => setOpen(false)}>Cancel</button>
          <button className="primary small" disabled={!!busy || !chk?.ok || chk.first !== first.trim().toUpperCase() || chk.count !== count} onClick={hold}>Hold these {n0(count)} tags</button>
        </div>
      </div>}
    </div>
  )
}
