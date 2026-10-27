import { Select } from './combo'
import { ScanButton } from './scan'
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
export interface Range { id: number; site: string; purpose: string; prefix: string; first_n: number; last_n: number; digits: number; active: boolean; notes: string | null; license: string | null; reserved?: boolean }
type Flash = (t: string, bad?: boolean) => void

export const KIND_LABEL: Record<string, string> = {
  cultivation: 'Cultivation', processor: 'Processor', nursery: 'Nursery', distributor: 'Distributor (Type 11)', transport: 'Distributor, transport only (Type 13)',
  manufacturer: 'Manufacturer', retail: 'Retail', other: 'Other',
}
export const PURPOSE_LABEL: Record<string, string> = { mixed: 'Mixed pallets', harvest: 'Harvest pallets (fresh frozen)', plant: 'Plant tags (mothers, batches)', package: 'Packages', processing: 'Processing packages (wet, bucked, trimmed)' }
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
  const [reserve, setReserve] = useState(true)
  const [busy, setBusy] = useState(false)
  const mine = ranges.filter(r => r.license === license)
  const go = async (p: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try { await rpc(sb, 'save_tag_range', { p: { license, ...p } }); flash(ok); setFirst(''); setLast(''); onChanged() } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="tagranges">
      <p className="muted small">Ranges marked "blocked off" keep tags for one purpose (the pallet-number tags are blocked off for harvest pallets). Once METRC's available tags are pulled, a purpose with its own blocked-off range takes tags only from it, and everything else skips blocked-off ranges. Other ranges are the old lists of issued tags, used only until METRC's list is pulled.</p>
      {!mine.length && <p className="muted small">No tag ranges blocked off for this license.</p>}
      {[...new Set(mine.map(r => r.purpose))].map(pu => {
        const rs = mine.filter(r => r.purpose === pu), on = rs.filter(r => r.active)
        const n = (xs: Range[]) => xs.reduce((a, r) => a + r.last_n - r.first_n + 1, 0)
        const row = (r: Range) => (
          <div key={r.id} className={`drow ${r.active ? '' : 'off'}`}>
            <span className="grow"><span className="mono">{tag(r, r.first_n).slice(-10)}{r.last_n > r.first_n ? ` to ${tag(r, r.last_n).slice(-10)}` : ''}</span><span className="muted"> · {(r.last_n - r.first_n + 1).toLocaleString()} {r.last_n > r.first_n ? 'tags' : 'tag'}
              {used ? ` · ${used(r).toLocaleString()} used` : ''}{r.active ? '' : ' · off'}</span>{r.reserved && <span className="pill m-warn">blocked off</span>}{r.notes && <span className="muted small"> {r.notes}</span>}</span>
            {canEdit && <button className="ghost small" disabled={busy} onClick={() => go({ id: r.id, reserved: !r.reserved }, r.reserved ? 'Range released' : 'Range blocked off')}>{r.reserved ? 'Release' : 'Block off'}</button>}
            {canEdit && <button className="ghost small" disabled={busy} onClick={() => go({ id: r.id, active: !r.active }, r.active ? 'Range off' : 'Range on')}>{r.active ? 'Turn off' : 'Turn on'}</button>}
          </div>)
        return rs.length === 1 ? <div key={pu}><b className="small">{PURPOSE_LABEL[pu] ?? pu}</b>{row(rs[0])}</div> : (
          <details key={pu} className="tagset"><summary><b>{PURPOSE_LABEL[pu] ?? pu}</b><span className="muted"> · {n(on).toLocaleString()} tags in {on.length} ranges{on.length < rs.length ? ` (${rs.length - on.length} off)` : ''}</span></summary>
            {rs.map(row)}</details>)
      })}
      {canEdit && <div className="row wrap tagadd">
        <Select value={purpose} onChange={e => setPurpose(e.target.value)}>{Object.entries(PURPOSE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <input value={first} onChange={e => setFirst(e.target.value.toUpperCase())} placeholder="First tag" /><ScanButton compact onScan={setFirst} />
        <input value={last} onChange={e => setLast(e.target.value.toUpperCase())} placeholder="Last tag" /><ScanButton compact onScan={setLast} />
        <label className="check"><input type="checkbox" checked={reserve} onChange={e => setReserve(e.target.checked)} /> <span>Block off for this purpose</span></label>
        <button className="ghost small" disabled={busy || !first.trim() || !last.trim()} onClick={() => go({ first: first.trim(), last: last.trim(), purpose, reserved: reserve }, 'Tag range added')}>+ Add range</button>
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
  const [counts, setCounts] = useState<{ license: string; tag_type: string; available: number; free: number; pulled: string | null }[]>([])
  const [pulling, setPulling] = useState<string | null>(null)
  const load = async () => {
    if (!sb) return
    sb.rpc('metrc_tag_counts').then(({ data }) => setCounts((data ?? []) as typeof counts))
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
  const pullTags = async (lic: string) => {
    setPulling(lic)
    try {
      const { data } = await sb.auth.getSession()
      const r = await fetch('/api/metrc/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify({ licenses: [lic], only: 'tags' }) })
      const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
      if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
      const res = j.results?.[0]
      if (res?.error) throw new Error(res.error)
      flash(`${lic}: ${(res?.tags ?? 0).toLocaleString()} available tags from METRC`); load()
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setPulling(null) }
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
            {l.kind !== 'transport' && <div className="row wrap small" style={{ alignItems: 'center', gap: 8, margin: '6px 0' }}>
              <span><b>METRC available tags:</b> {(() => { const cs = counts.filter(x => x.license === l.license_no)
                return cs.length ? cs.map(x => `${x.free.toLocaleString()} ${x.tag_type} free (${x.available.toLocaleString()} available)`).join(' · ') + ` · pulled ${new Date(cs[0].pulled ?? '').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'not pulled yet' })()}</span>
              <button className="ghost small" disabled={!!pulling} onClick={() => pullTags(l.license_no)}>{pulling === l.license_no ? 'Pulling…' : 'Pull tags from METRC'}</button></div>}
            <TagRanges sb={sb} license={l.license_no} kind={l.kind} ranges={ranges} canEdit flash={flash} onChanged={load} />
          </section>
        )
      })}
      {real.length > 0 && <details className="licfz"><summary>Which license each freezer is under</summary>
        <div className="dlist">{real.map(f => <div key={f.id} className="drow"><span className="grow">{f.site} freezer {f.number}</span>
          <Select value={f.license ?? ''} onChange={e => moveFreezer(f.id, e.target.value)}>{lics.filter(l => l.site === f.site || l.license_no === f.license).map(l => <option key={l.license_no} value={l.license_no}>{l.license_no} · {KIND_LABEL[l.kind]}</option>)}</Select></div>)}</div>
      </details>}
      {ed && (
        <div className="scrim" onClick={() => setEd(null)}>
          <div className="sheet form" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><h2>{lics.some(l => l.license_no === ed.license_no) ? ed.license_no : 'New license'}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
            <div className="grid2">
              <div className="field"><label>License #</label><input value={ed.license_no ?? ''} disabled={lics.some(l => l.license_no === ed.license_no)} onChange={e => set({ license_no: e.target.value.toUpperCase() })} /></div>
              <div className="field"><label>Type</label><Select value={ed.kind} onChange={e => set({ kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
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
