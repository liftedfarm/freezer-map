import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Dialog, lbs } from './forms'

// Distribution > Archived: pallets that are out of inventory as "archived" (sheet import leftovers, removed as a mistake,
// closed by Reconcile). Shows which ones METRC still has as active packages, and brings them back (a spot picked on the
// map, the site's Staging, or Needs a spot) or deletes them for good. Database: 093_archived.sql.

export interface ArchRow {
  id: number; code: string; strain: string | null; label: string | null; product: string | null; crop_year: number | null
  harvest_date: string | null; lbs: number | null; og_lbs: number | null; tag: string | null; kind: string | null
  notes: string | null; needs_review: string | null; updated_at: string; harvest_id: number | null; site: string | null
  metrc_license: string | null; metrc_state: string | null; metrc_lbs: number | null; metrc_item: string | null; tag_on: string | null
  last: { at: string; by: string | null; type: string; note: string | null; reason: string | null } | null
}
interface Overview { rows: ArchRow[]; pulled: string | null; can_restore: boolean; can_delete: boolean }
export type RestoreTo = { slot?: number; site?: string; staging?: boolean }

const SITES = ['OHR', 'GVR']
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : '')
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const who = (e?: string | null) => (e ? e.split('@')[0] : '')
const errText = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e))
const LAST: Record<string, string> = { removed: 'Removed', harvest_undone: 'Harvest ✕', metrc_match: 'Reconcile', restored: 'Restored', strain_renamed: 'Strain renamed' }

function lastText(r: ArchRow) {
  if (!r.last) return 'Sheet import (10/20)'
  const t = r.last.type === 'removed' && r.last.reason === 'mistake' ? 'Removed as a mistake' : LAST[r.last.type] ?? r.last.type.replace(/_/g, ' ')
  return `${t} · ${who(r.last.by)} ${day(r.last.at)}`
}

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb.rpc(fn, args)
  if (error) {
    if (/archived_overview|restore_pallets|delete_archived_pallet|function restore_pallet/i.test(error.message)) throw new Error(`${error.message} (run 093_archived.sql in Supabase)`)
    throw new Error(error.message)
  }
  return data as T
}

export const restoreOne = (sb: SupabaseClient, id: number, note: string, to: RestoreTo, weight: number | null) =>
  rpc(sb, 'restore_pallet', { p_pallet_id: id, p_note: note || null, p_slot: to.slot ?? null, p_site: to.site ?? null, p_staging: !!to.staging, p_weight: weight })
export const deleteOne = (sb: SupabaseClient, id: number, note: string) => rpc(sb, 'delete_archived_pallet', { p_pallet_id: id, p_note: note })

/** fetch one archived pallet's row (pallet card buttons) */
export async function archivedRow(sb: SupabaseClient, id: number): Promise<{ row: ArchRow | null; can_restore: boolean; can_delete: boolean }> {
  const o = await rpc<Overview>(sb, 'archived_overview')
  return { row: o.rows.find(r => r.id === id) ?? null, can_restore: o.can_restore, can_delete: o.can_delete }
}

export function ArchivedView({ sb, flash, onChanged, pickSpot, openPallet, initialQ }: {
  initialQ?: string | null; sb: SupabaseClient | null; flash: (m: string, bad?: boolean) => void; onChanged: () => void
  pickSpot: (r: ArchRow, weight: number | null, note: string, done: () => void) => void; openPallet: (id: number) => void
}) {
  const [ov, setOv] = useState<Overview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [show, setShow] = useState<'metrc' | 'all'>(initialQ ? 'all' : 'metrc')
  const [site, setSite] = useState('')
  const [q, setQ] = useState(initialQ ?? '')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [restoring, setRestoring] = useState<ArchRow | null>(null)
  const [deleting, setDeleting] = useState<ArchRow | null>(null)
  const [useMetrc, setUseMetrc] = useState(true)

  const load = async () => {
    if (!sb) return
    setBusy('Loading…')
    try { setOv(await rpc<Overview>(sb, 'archived_overview')) } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  useEffect(() => { load() }, [])

  const rows = ov?.rows ?? []
  const activeN = rows.filter(r => r.metrc_state).length
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return rows.filter(r => (show === 'all' || r.metrc_state) && (!site || r.site === site)
      && (!s || [r.code, r.strain, r.tag, r.label, r.metrc_item].some(v => v?.toLowerCase().includes(s))))
  }, [rows, show, site, q])
  const picked = list.filter(r => sel.has(r.id))
  const allOn = list.length > 0 && list.every(r => sel.has(r.id))
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const after = async () => { setSel(new Set()); onChanged(); await load() }

  async function bulk(staging: boolean) {
    if (!sb || !picked.length) return
    const where = staging ? 'its site\'s Staging' : 'Needs a spot at its site'
    if (!confirm(`Bring back ${picked.length} pallet${picked.length === 1 ? '' : 's'} to ${where}${useMetrc ? ', with METRC\'s weight where METRC has it' : ''}?`)) return
    setBusy('Restoring…')
    try {
      const r = await rpc<{ done: number; errors: { code: string; error: string }[] }>(sb, 'restore_pallets',
        { p_ids: picked.map(p => p.id), p_note: 'Restored from Archived', p_staging: staging, p_use_metrc: useMetrc })
      flash(`${r.done} restored${r.errors.length ? `. Not restored: ${r.errors.map(e => `${e.code} (${e.error})`).join('; ')}` : ''}`, r.errors.length > 0)
      await after()
    } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }

  const canR = !!ov?.can_restore, canD = !!ov?.can_delete
  return <div className="list">
    <div className="row between wrap toolbar"><h2>Archived</h2>
      <button className="ghost small" disabled={!!busy} onClick={load}>{busy ?? 'Refresh'}</button></div>
    <p className="muted">Pallets that are out of inventory as archived: leftovers from the Freezer Map sheet import, ones removed as a mistake, ones closed by Reconcile.
      {' '}<b>Active in METRC</b> means METRC still has the package{ov?.pulled ? ` (pulled ${when(ov.pulled)})` : ''}, so it's probably real. Bring it back to a spot, Staging or Needs a spot. Nothing changes in METRC.</p>
    {ov && !canR && <p className="muted small">Restoring and deleting need a Distribution Admin.</p>}
    <div className="row wrap" style={{ gap: 8 }}>
      <div className="seg">
        <button className={show === 'metrc' ? 'on' : ''} onClick={() => setShow('metrc')}>Active in METRC ({activeN})</button>
        <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All ({rows.length})</button>
      </div>
      <div className="seg">{['', ...SITES].map(s => <button key={s} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s || 'Both'}</button>)}</div>
      <input className="search" type="search" placeholder="Pallet, strain or tag" value={q} onChange={e => setQ(e.target.value)} />
    </div>
    {canR && picked.length > 0 && <div className="card row between wrap">
      <b>{picked.length} picked</b>
      <label className="row small"><input type="checkbox" checked={useMetrc} onChange={e => setUseMetrc(e.target.checked)} /> Use METRC's weight</label>
      <div className="row">
        <button className="primary small" disabled={!!busy} onClick={() => bulk(true)}>Bring back to Staging</button>
        <button className="ghost small" disabled={!!busy} onClick={() => bulk(false)}>Bring back as Needs a spot</button>
        <button className="ghost small" onClick={() => setSel(new Set())}>Clear</button>
      </div>
    </div>}
    {ov && !list.length && <p className="muted">{show === 'metrc' ? 'No archived pallets are active in METRC.' : 'Nothing archived matches.'}</p>}
    {list.length > 0 && <div className="tablewrap"><table className="ct arch">
      <thead><tr>
        {canR && <th><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(list.map(r => r.id)))} /></th>}
        <th>Pallet</th><th>Strain</th><th>Harvested</th><th>Site</th><th className="num">App</th><th>METRC</th><th>Archived by</th><th /></tr></thead>
      <tbody>{list.map(r => {
        const diff = r.metrc_state && r.metrc_lbs != null && r.lbs != null && Math.abs(r.metrc_lbs - r.lbs) >= 1
        return <tr key={r.id}>
          {canR && <td><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>}
          <td className="nw"><a onClick={() => openPallet(r.id)}><b>{r.code}</b></a>{r.tag && <div className="mono small muted">…{r.tag.slice(-6)}</div>}</td>
          <td>{r.strain ?? r.label ?? ''}</td>
          <td className="small nw">{r.harvest_date ?? ''}</td>
          <td>{r.site ?? '?'}</td>
          <td className="num nw">{lbs(r.lbs)}</td>
          <td className="small">{r.metrc_state
            ? <><span className="pill m-bad">{r.metrc_state === 'intransit' ? 'In transit' : 'Active'}</span> <span className={`nw ${diff ? 'neg' : ''}`}>{lbs(r.metrc_lbs)}</span><div className="muted">{r.metrc_license}</div></>
            : <span className="muted">{r.tag ? 'not active' : 'no tag'}</span>}
            {r.tag_on && <div className="neg">tag also on {r.tag_on}</div>}</td>
          <td className="small muted">{lastText(r)}{r.last?.note && <div>"{r.last.note}"</div>}</td>
          <td><div className="row end">
            {canR && <button className="primary small" disabled={!!busy || !!r.tag_on} onClick={() => setRestoring(r)}>Restore</button>}
            {canD && <button className="ghost small danger" disabled={!!busy} onClick={() => setDeleting(r)}>Delete</button>}
          </div></td>
        </tr>
      })}</tbody></table></div>}
    {restoring && sb && <RestoreSheet r={restoring} onClose={() => setRestoring(null)}
      onMap={(w, note) => { const r = restoring; setRestoring(null); pickSpot(r, w, note, () => { load() }) }}
      onSubmit={async (to, w, note) => {
        setBusy('Restoring…')
        try { await restoreOne(sb, restoring.id, note, to, w); flash(`${restoring.code} is back${to.staging ? ` in ${to.site} Staging` : ` (Needs a spot at ${to.site})`}`); setRestoring(null); await after() }
        catch (e) { flash(errText(e), true) } finally { setBusy(null) }
      }} />}
    {deleting && sb && <DeleteSheet r={deleting} onClose={() => setDeleting(null)}
      onSubmit={async note => {
        setBusy('Deleting…')
        try { await deleteOne(sb, deleting.id, note); flash(`${deleting.code} deleted`); setDeleting(null); await after() }
        catch (e) { flash(errText(e), true) } finally { setBusy(null) }
      }} />}
  </div>
}

/** where an archived pallet goes back to: a spot picked on the map, the site's Staging, or Needs a spot */
export function RestoreSheet({ r, onClose, onMap, onSubmit }: {
  r: ArchRow; onClose: () => void; onMap: (weight: number | null, note: string) => void; onSubmit: (to: RestoreTo, weight: number | null, note: string) => Promise<void> | void
}) {
  const [dest, setDest] = useState<'map' | 'staging' | 'spot'>('map')
  const [site, setSite] = useState(r.site && SITES.includes(r.site) ? r.site : 'OHR')
  const metrcW = r.metrc_state && r.metrc_lbs && r.metrc_lbs > 0 ? r.metrc_lbs : null
  const [w, setW] = useState(String(metrcW ?? r.lbs ?? ''))
  const [note, setNote] = useState(r.last ? '' : 'Was in a freezer; archived at the sheet import')
  const [busy, setBusy] = useState(false)
  const n = parseFloat(w)
  const weight = n > 0 && n !== r.lbs ? n : null
  const go = async () => { if (dest === 'map') { onMap(weight, note); return } setBusy(true); try { await onSubmit({ site, staging: dest === 'staging' }, weight, note) } finally { setBusy(false) } }
  return <Dialog title={`Bring back ${r.code}`} onClose={onClose}>
    <p className="muted">{r.strain ?? r.label ?? ''}{r.harvest_date ? ` · harvested ${r.harvest_date}` : ''}{r.tag ? ` · tag …${r.tag.slice(-6)}` : ''}</p>
    {r.metrc_state ? <p className="small">METRC: active at {r.metrc_license}, {lbs(r.metrc_lbs)}{r.metrc_item ? ` · ${r.metrc_item}` : ''}</p>
      : r.tag ? <div className="warnbox">METRC doesn't have this package active. Bring it back only if it's really in a freezer.</div> : null}
    <div className="field"><label>Where is it?</label>
      <div className="choices col">
        <button className={dest === 'map' ? 'on' : ''} onClick={() => setDest('map')}><b>Pick the spot on the map</b> <span className="muted">open a freezer and tap where it is</span></button>
        <button className={dest === 'staging' ? 'on' : ''} onClick={() => setDest('staging')}><b>Staging</b> <span className="muted">the site's staging area</span></button>
        <button className={dest === 'spot' ? 'on' : ''} onClick={() => setDest('spot')}><b>Needs a spot</b> <span className="muted">back in inventory, place it later</span></button>
      </div></div>
    {dest !== 'map' && <div className="field"><label>Site</label>
      <div className="seg">{SITES.map(s => <button key={s} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s}</button>)}</div></div>}
    <div className="field"><label>Weight (lbs)</label>
      <input type="number" inputMode="decimal" min="0" step="0.01" value={w} onChange={e => setW(e.target.value)} />
      <div className="muted small">App had {lbs(r.lbs) || 'none'}{metrcW != null ? `, METRC has ${lbs(metrcW)}` : ''}.</div></div>
    <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="Why it's coming back" /></div>
    <div className="row end">
      <button className="ghost" onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !(n > 0)} onClick={go}>{dest === 'map' ? 'Next: pick the spot' : 'Bring it back'}</button>
    </div>
  </Dialog>
}

export function DeleteSheet({ r, onClose, onSubmit }: { r: ArchRow; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState('')
  return <Dialog title={`Delete ${r.code} for good`} onClose={onClose}>
    {r.metrc_state
      ? <div className="warnbox">METRC still has this package active ({lbs(r.metrc_lbs)}). It can't be deleted until it's restored or finished in METRC.</div>
      : <p>{r.code} {r.strain ? `(${r.strain}) ` : ''}and its history are removed from the app. This can't be undone. The activity log keeps a copy of what it was.</p>}
    <div className="field"><label>Why?</label><input autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Duplicate row from the old sheet" /></div>
    <div className="row end">
      <button className="ghost" onClick={onClose}>Cancel</button>
      <button className="primary danger" disabled={!note.trim() || !!r.metrc_state} onClick={() => onSubmit(note.trim())}>Delete</button>
    </div>
  </Dialog>
}
