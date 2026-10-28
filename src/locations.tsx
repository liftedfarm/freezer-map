import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { can } from './fold'

// Distribution > Settings > Locations: the freezers and reefer trailers at OHR and GVR.
// Each is 2 columns x N spots deep. Add, change, retire (hidden from the map, history kept), or delete one that never held anything.

type Loc = { id: number; site: 'OHR' | 'GVR'; number: number; kind: 'freezer' | 'trailer' | 'staging'; status: string; notes: string | null; license: string | null; active?: boolean; rows: number }
type Ed = { id: number | null; site: 'OHR' | 'GVR'; kind: 'freezer' | 'trailer'; number: string; rows: string; status: string; notes: string }
const STATUS = ['On', 'Off', 'Needs Attention', 'Not Working']
const label = (l: { kind: string; number: number }) => (l.kind === 'trailer' ? `Reefer ${l.number - 100}` : `Freezer ${l.number}`)

export function DistLocations({ sb, flash, onChanged }: { sb: SupabaseClient | null; flash: (t: string, bad?: boolean) => void; onChanged: () => void }) {
  const [site, setSite] = useState<'OHR' | 'GVR'>('GVR')
  const [locs, setLocs] = useState<Loc[] | null>(null)
  const [ed, setEd] = useState<Ed | null>(null)
  const [busy, setBusy] = useState(false)
  const [showRetired, setShowRetired] = useState(false)
  const edit = can('distribution', 'locations')
  const load = async () => {
    if (!sb) return
    const [f, s] = await Promise.all([sb.from('freezers').select('*').order('number'), sb.from('slots').select('freezer_id,row').range(0, 9999)])
    if (f.error) { flash(f.error.message, true); return }
    const deep = new Map<number, number>()
    for (const x of (s.data ?? []) as { freezer_id: number; row: number }[]) deep.set(x.freezer_id, Math.max(deep.get(x.freezer_id) ?? 0, x.row))
    setLocs(((f.data ?? []) as Omit<Loc, 'rows'>[]).filter(l => l.kind !== 'staging').map(l => ({ ...l, rows: deep.get(l.id) ?? 0 })))
  }
  useEffect(() => { load() }, [sb])
  if (!sb) return <p className="muted">Locations need the database.</p>
  if (!locs) return <p className="muted">Loading…</p>
  const run = async (fn: string, args: object, ok: string) => {
    setBusy(true)
    try {
      const { error } = await sb.rpc(fn, args)
      if (error) throw new Error(/Could not find the function/.test(error.message) ? 'Run 086_dist_locations.sql in Supabase first' : error.message)
      flash(ok); setEd(null); await load(); onChanged()
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const here = locs.filter(l => l.site === site && (showRetired || l.active !== false))
  const retired = locs.filter(l => l.site === site && l.active === false).length
  const next = (kind: 'freezer' | 'trailer') => {
    const nums = locs.filter(l => l.site === site && l.kind === kind).map(l => (kind === 'trailer' ? l.number - 100 : l.number))
    return String(nums.length ? Math.max(...nums) + 1 : 1)
  }
  const startAdd = (kind: 'freezer' | 'trailer') => setEd({ id: null, site, kind, number: next(kind), rows: kind === 'trailer' ? '13' : '9', status: 'On', notes: '' })
  const save = () => ed && run('loc_freezer_save', { p: { id: ed.id, site: ed.site, kind: ed.kind, number: Number(ed.number), rows: Number(ed.rows), status: ed.status, notes: ed.notes } },
    `${ed.kind === 'trailer' ? 'Reefer' : 'Freezer'} ${ed.number} saved`)
  const group = (kind: 'freezer' | 'trailer', title: string) => {
    const rows = here.filter(l => l.kind === kind)
    return (
      <section className="dcard">
        <div className="dcard-h"><h3>{title} <span className="muted">{rows.length}</span></h3>
          {edit && <button className="ghost small" disabled={busy} onClick={() => startAdd(kind)}>+ Add {kind === 'trailer' ? 'reefer' : 'freezer'}</button>}</div>
        {rows.length ? <div className="dlist">{rows.map(l => (
          <div key={l.id} className={`drow${l.active === false ? ' locoff' : ''}`}>
            <span className="grow"><b>{label(l)}</b> <span className="muted">{l.rows ? `2 × ${l.rows} spots` : 'no spots'}{l.status !== 'On' ? ` · ${l.status}` : ''}{l.notes ? ` · ${l.notes}` : ''}{l.active === false ? ' · retired' : ''}</span></span>
            {edit && l.active !== false && <button className="ghost small" disabled={busy} onClick={() => setEd({ id: l.id, site: l.site, kind: l.kind as 'freezer' | 'trailer', number: String(l.kind === 'trailer' ? l.number - 100 : l.number), rows: String(l.rows || 9), status: l.status, notes: l.notes ?? '' })}>Edit</button>}
            {edit && (l.active === false
              ? <button className="ghost small" disabled={busy} onClick={() => run('loc_freezer_active', { p_id: l.id, p_active: true }, `${label(l)} is back on the map`)}>Bring back</button>
              : <button className="ghost small" disabled={busy} onClick={() => window.confirm(`Retire ${label(l)}? It comes off the map; its history stays.`) && run('loc_freezer_active', { p_id: l.id, p_active: false }, `${label(l)} retired`)}>Retire</button>)}
            {edit && <button className="ghost small" disabled={busy} title="Only if nothing was ever in it" onClick={() => window.confirm(`Delete ${label(l)} for good? Only works if nothing was ever in it.`) && run('loc_freezer_delete', { p_id: l.id }, `${label(l)} deleted`)}>✕</button>}
          </div>))}</div> : <p className="muted">None at {site}.</p>}
      </section>
    )
  }
  return (
    <div className="locset">
      <div className="row wrap between">
        <div className="seg">{(['OHR', 'GVR'] as const).map(s => <button key={s} className={site === s ? 'on' : ''} onClick={() => { setSite(s); setEd(null) }}>{s}</button>)}</div>
        {retired > 0 && <label className="check small-check"><input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} /> Show retired ({retired})</label>}
      </div>
      {!edit && <p className="muted small">Only a Distribution Admin can change these.</p>}
      {ed && <section className="dcard">
        <div className="dcard-h"><h3>{ed.id ? 'Change' : 'Add'} {ed.kind === 'trailer' ? 'reefer' : 'freezer'} at {ed.site}</h3><button className="linkbtn" onClick={() => setEd(null)}>Cancel</button></div>
        <div className="locform">
          <label><span>Type</span><select value={ed.kind} onChange={e => setEd({ ...ed, kind: e.target.value as 'freezer' | 'trailer' })}><option value="freezer">Freezer</option><option value="trailer">Reefer trailer</option></select></label>
          <label><span>Number</span><input inputMode="numeric" value={ed.number} onChange={e => setEd({ ...ed, number: e.target.value.replace(/\D/g, '') })} /></label>
          <label><span>Spots deep (each column)</span><input inputMode="numeric" value={ed.rows} onChange={e => setEd({ ...ed, rows: e.target.value.replace(/\D/g, '') })} /></label>
          <label><span>Site</span><select value={ed.site} onChange={e => setEd({ ...ed, site: e.target.value as 'OHR' | 'GVR' })}><option>OHR</option><option>GVR</option></select></label>
          <label><span>Status</span><select value={ed.status} onChange={e => setEd({ ...ed, status: e.target.value })}>{STATUS.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="wide"><span>Notes</span><input value={ed.notes} onChange={e => setEd({ ...ed, notes: e.target.value })} placeholder="Optional" /></label>
        </div>
        <p className="muted small">Two columns, {Number(ed.rows) || 0} spots deep = {2 * (Number(ed.rows) || 0)} spots (up to 13 deep). Spot names follow the number, like {ed.kind === 'trailer' ? `R${ed.number || 1}A` : `${ed.number || 1}A`}.</p>
        <div className="row"><button className="primary" disabled={busy || !Number(ed.number) || !Number(ed.rows)} onClick={save}>Save</button></div>
      </section>}
      {group('freezer', 'Freezers')}
      {group('trailer', 'Reefer trailers')}
      <p className="muted small">Retired ones come off the freezer map but keep their history. Delete only works on one added by mistake (nothing was ever in it).</p>
    </div>
  )
}
