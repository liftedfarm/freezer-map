import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Backend } from './api'
import './nursery/nursery.css'

// Licenses: every state license (premises), what sits under it, and the METRC tag ranges issued to it.
// Admin > Settings > Licenses. The Nursery's settings show the same tag ranges for its own license.

export interface Lic {
  license_no: string; kind: string; tier: string | null; entity: string; dba: string | null; site: string | null; premises: string | null; address: string | null
  email: string | null; phone: string | null; remit: string | null; hub: boolean; expires: string | null; active: boolean; notes: string | null; sort: number
}
export interface Range { id: number; site: string; purpose: string; prefix: string; first_n: number; last_n: number; digits: number; active: boolean; notes: string | null; license: string | null }
type Flash = (t: string, bad?: boolean) => void

export const KIND_LABEL: Record<string, string> = {
  cultivation: 'Cultivation', processor: 'Processor', nursery: 'Nursery', distributor: 'Distributor (Type 11)', transport: 'Distributor, transport only (Type 13)',
  manufacturer: 'Manufacturer', retail: 'Retail', other: 'Other',
}
export const PURPOSE_LABEL: Record<string, string> = { mixed: 'Mixed pallets', harvest: 'Harvest pallets (fresh frozen)', plant: 'Plant tags (mothers, batches)', package: 'Packages' }
const tag = (r: Range, n: number) => r.prefix + String(n).padStart(r.digits, '0')

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args)
  if (error && /schema cache|does not exist/.test(error.message)) throw new Error('Run 028_licenses_nursery.sql in Supabase first')
  if (error) throw new Error(error.message)
  return data as T
}

/** the tag ranges for one license, with a form to add one */
export function TagRanges({ sb, license, kind, ranges, used, canEdit, flash, onChanged }: {
  sb: SupabaseClient; license: string; kind: string; ranges: Range[]; used?: (r: Range) => number; canEdit: boolean; flash: Flash; onChanged: () => void
}) {
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [purpose, setPurpose] = useState(kind === 'nursery' ? 'plant' : 'harvest')
  const [busy, setBusy] = useState(false)
  const mine = ranges.filter(r => r.license === license)
  const go = async (p: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try { await rpc(sb, 'save_tag_range', { p: { license, ...p } }); flash(ok); setFirst(''); setLast(''); onChanged() } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="tagranges">
      {!mine.length && <p className="muted small">No METRC tag ranges for this license yet.</p>}
      {mine.map(r => (
        <div key={r.id} className={`drow ${r.active ? '' : 'off'}`}>
          <span className="grow"><b>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</b><span className="muted"> · {tag(r, r.first_n).slice(-10)} to {tag(r, r.last_n).slice(-10)} · {(r.last_n - r.first_n + 1).toLocaleString()} tags
            {used ? ` · ${used(r).toLocaleString()} used` : ''}{r.active ? '' : ' · off'}</span></span>
          {canEdit && <button className="ghost small" disabled={busy} onClick={() => go({ id: r.id, active: !r.active }, r.active ? 'Range off' : 'Range on')}>{r.active ? 'Turn off' : 'Turn on'}</button>}
        </div>
      ))}
      {canEdit && <div className="row wrap tagadd">
        <select value={purpose} onChange={e => setPurpose(e.target.value)}>{Object.entries(PURPOSE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={first} onChange={e => setFirst(e.target.value.toUpperCase())} placeholder="First tag" />
        <input value={last} onChange={e => setLast(e.target.value.toUpperCase())} placeholder="Last tag" />
        <button className="ghost small" disabled={busy || !first.trim() || !last.trim()} onClick={() => go({ first: first.trim(), last: last.trim(), purpose }, 'Tag range added')}>+ Add range</button>
      </div>}
    </div>
  )
}

/** Admin > Settings > Licenses */
export function LicensesPanel({ backend, flash }: { backend: Backend; flash: Flash }) {
  const sb = backend.client()
  const [lics, setLics] = useState<Lic[] | null>(null)
  const [ranges, setRanges] = useState<Range[]>([])
  const [freezers, setFreezers] = useState<{ id: number; site: string; number: number; license: string | null; kind?: string | null }[]>([])
  const [ed, setEd] = useState<Partial<Lic> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    if (!sb) return
    const [l, r, f] = await Promise.all([sb.from('licenses').select('*').order('sort'), sb.from('tag_ranges').select('*').order('id'), sb.from('freezers').select('*').order('site').order('number')])
    if (l.error) { setErr(/licenses/.test(l.error.message) ? 'Run 028_licenses_nursery.sql in Supabase first.' : l.error.message); return }
    setLics(l.data as Lic[]); setRanges((r.data ?? []) as Range[]); setFreezers((f.data ?? []) as typeof freezers); setErr(null)
  }
  useEffect(() => { load() }, [])
  if (!sb) return <p className="muted">Licenses need the database.</p>
  if (err) return <div className="warnbox">{err}</div>
  if (!lics) return <p className="muted">Loading…</p>
  const save = async () => {
    setBusy(true)
    try { await rpc(sb, 'save_license', { p: ed }); flash('License saved'); setEd(null); load() } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const moveFreezer = async (id: number, lic: string) => {
    try { await rpc(sb, 'set_freezer_license', { p_freezer: id, p_license: lic }); flash('Freezer moved'); load() } catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  const set = (v: Partial<Lic>) => setEd(s => ({ ...s, ...v }))
  const real = freezers.filter(f => f.kind !== 'staging' && f.number > 0)
  return (
    <div className="licenses">
      <p className="muted">Each state license is its own premises. Moving product between two of them is a transfer with a METRC manifest. Tags are issued per license.</p>
      <div className="row"><button className="primary small" onClick={() => setEd({ kind: 'cultivation', active: true, hub: false })}>+ Add license</button></div>
      {lics.map(l => {
        const fz = real.filter(f => f.license === l.license_no)
        return (
          <section key={l.license_no} className={`dcard lic ${l.active ? '' : 'off'}`}>
            <div className="dcard-h"><h3>{l.license_no} <span className="muted">· {KIND_LABEL[l.kind] ?? l.kind}{l.tier ? ` · ${l.tier}` : ''}</span></h3>
              <button className="linkbtn" onClick={() => setEd(l)}>Edit ›</button></div>
            <div className="muted">{l.entity}{l.dba ? ` (dba ${l.dba})` : ''}{l.site ? ` · ${l.site}` : ''}{l.premises && l.premises !== l.site ? ` ${l.premises}` : ''}{l.hub ? ' · distribution hub' : ''}{l.expires ? ` · expires ${l.expires}` : ''}{l.active ? '' : ' · inactive'}</div>
            {l.notes && <div className="small">{l.notes}</div>}
            {fz.length > 0 && <div className="small">{fz.length} {fz.length === 1 ? 'freezer' : 'freezers'}: {fz[0].site} {fz.map(f => f.number).join(', ')}</div>}
            <TagRanges sb={sb} license={l.license_no} kind={l.kind} ranges={ranges} canEdit flash={flash} onChanged={load} />
          </section>
        )
      })}
      {real.length > 0 && <details className="licfz"><summary>Which license each freezer is under</summary>
        <div className="dlist">{real.map(f => <div key={f.id} className="drow"><span className="grow">{f.site} freezer {f.number}</span>
          <select value={f.license ?? ''} onChange={e => moveFreezer(f.id, e.target.value)}>{lics.filter(l => l.site === f.site || l.license_no === f.license).map(l => <option key={l.license_no} value={l.license_no}>{l.license_no} · {KIND_LABEL[l.kind]}</option>)}</select></div>)}</div>
      </details>}
      {ed && (
        <div className="scrim" onClick={() => setEd(null)}>
          <div className="sheet form" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><h2>{lics.some(l => l.license_no === ed.license_no) ? ed.license_no : 'New license'}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
            <div className="grid2">
              <div className="field"><label>License #</label><input value={ed.license_no ?? ''} disabled={lics.some(l => l.license_no === ed.license_no)} onChange={e => set({ license_no: e.target.value.toUpperCase() })} /></div>
              <div className="field"><label>Type</label><select value={ed.kind} onChange={e => set({ kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
              <div className="field"><label>Size / tier</label><input value={ed.tier ?? ''} onChange={e => set({ tier: e.target.value })} placeholder="Large, Medium outdoor…" /></div>
              <div className="field"><label>Site code</label><input value={ed.site ?? ''} onChange={e => set({ site: e.target.value.toUpperCase() })} placeholder="OHR, GVR, 1PN (blank for none)" /></div>
              <div className="field"><label>Legal entity</label><input value={ed.entity ?? ''} onChange={e => set({ entity: e.target.value })} placeholder="DNA Organics, Inc." /></div>
              <div className="field"><label>DBA</label><input value={ed.dba ?? ''} onChange={e => set({ dba: e.target.value })} /></div>
              <div className="field"><label>Premises name</label><input value={ed.premises ?? ''} onChange={e => set({ premises: e.target.value })} /></div>
              <div className="field"><label>Expires</label><input type="date" value={ed.expires ?? ''} onChange={e => set({ expires: e.target.value || null })} /></div>
              <div className="field"><label>Email</label><input value={ed.email ?? ''} onChange={e => set({ email: e.target.value })} /></div>
              <div className="field"><label>Phone</label><input value={ed.phone ?? ''} onChange={e => set({ phone: e.target.value })} /></div>
            </div>
            <div className="field"><label>Premises address</label><textarea rows={2} value={ed.address ?? ''} onChange={e => set({ address: e.target.value })} /></div>
            <div className="field"><label>How to pay <span className="muted">(on invoices from this license; blank = "Check payable to" the entity)</span></label><textarea rows={2} value={ed.remit ?? ''} onChange={e => set({ remit: e.target.value })} /></div>
            <div className="field"><label>Notes</label><input value={ed.notes ?? ''} onChange={e => set({ notes: e.target.value })} /></div>
            <label className="check"><input type="checkbox" checked={!!ed.hub} onChange={e => set({ hub: e.target.checked })} /> <span>Distribution hub (loads from other sites go here)</span></label>
            <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => set({ active: e.target.checked })} /> <span>Active</span></label>
            <div className="row between"><span /><div className="row"><button className="ghost" onClick={() => setEd(null)}>Cancel</button>
              <button className="primary" disabled={busy || !ed.license_no?.trim() || !ed.entity?.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div></div>
          </div>
        </div>
      )}
    </div>
  )
}
