import { useEffect, useMemo, useState } from 'react'
import type { CustLic, Doc, License, RefKind } from './api'
import type { Ctx } from './ctx'
import { AddDocsSheet, DocList, DropZone, Expiry, FileChip, SITES, daysTo, fmtD } from './files'
import { DateIn, F, Pick, SaveBar, Sheet, TextIn, errText } from '../cult/ui'

const REF_LABEL: Record<RefKind, string> = { test: 'Pre-harvest test', pallet: 'Package', lot: 'Harvest lot', harvest: 'Harvest', material: 'Material', license: 'License',
  customer: 'Customer', metrc_error: 'METRC error', obligation: 'Deadline', processor: 'Processor' }
const who = (e: string | null | undefined) => (e ?? '').split('@')[0]

export function Library({ c }: { c: Ctx }) {
  const view = c.sub === 'licenses' || c.sub === 'customers' ? c.sub : 'docs'
  return <div className="list">
    <div className="row between wrap toolbar"><h2>Library</h2>
      <div className="seg">{([['docs', 'Documents'], ['licenses', 'Our licenses'], ['customers', 'Customer licenses']] as const).map(([k, l]) =>
        <button key={k} className={view === k ? 'on' : ''} onClick={() => c.go('library', k)}>{l}</button>)}</div></div>
    {view === 'docs' && <Docs c={c} />}
    {view === 'licenses' && <Licenses c={c} />}
    {view === 'customers' && <Customers c={c} />}
  </div>
}

// ---------- documents ----------
function Docs({ c }: { c: Ctx }) {
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [site, setSite] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [expiring, setExpiring] = useState(false)
  const [removed, setRemoved] = useState(false)
  const [adding, setAdding] = useState<File[] | null>(null)
  const [open, setOpen] = useState<Doc | null>(null)
  const load = async () => { try { setDocs(await c.api.docs({ deleted: removed })) } catch (e) { c.flash(errText(e), true); setDocs([]) } }
  useEffect(() => { load() }, [removed])
  const all = docs ?? []
  const shownBase = all.filter(d => (removed || d.current) && (!site || (site === '-' ? !d.site : d.site === site)) &&
    (!q || `${d.title} ${d.file_name ?? ''} ${d.notes ?? ''} ${d.license_no ?? ''} ${c.typeLabel(d.doc_type)}`.toLowerCase().includes(q.toLowerCase())) &&
    (!expiring || (d.expires_on != null && (daysTo(d.expires_on) ?? 999) <= 60)))
  const counts = new Map<string, number>()
  for (const d of shownBase) counts.set(d.doc_type, (counts.get(d.doc_type) ?? 0) + 1)
  const shown = shownBase.filter(d => !type || d.doc_type === type)
  return <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const fs = [...e.dataTransfer.files]; if (fs.length && c.canEdit) setAdding(fs) }}>
    <p className="muted">Every compliance document in one place. Drop files anywhere on this page to add them. They're stored privately in the app and copied to SharePoint every night.</p>
    {c.canEdit && <div className="row wrap" style={{ gap: 8 }}>
      <div style={{ flex: 1, minWidth: 260 }}><DropZone onFiles={setAdding} label="Drag documents here" /></div>
      <button className="ghost" onClick={() => setAdding([])}>+ SharePoint link</button></div>}
    <div className="row wrap toolbar" style={{ marginTop: 10 }}>
      <input className="search" placeholder="Search title, file, license, notes" value={q} onChange={e => setQ(e.target.value)} />
      <select value={site ?? ''} onChange={e => setSite(e.target.value || null)} aria-label="Site"><option value="">All sites</option><option value="-">Company</option>{SITES.map(s => <option key={s}>{s}</option>)}</select>
      <label className="check"><input type="checkbox" checked={expiring} onChange={e => setExpiring(e.target.checked)} /> Expiring in 60 days</label>
      {c.isAdmin && <label className="check"><input type="checkbox" checked={removed} onChange={e => setRemoved(e.target.checked)} /> Removed</label>}
    </div>
    <div className="chips"><button className={!type ? 'on' : ''} onClick={() => setType(null)}>All<span className="n">{shownBase.length}</span></button>
      {c.types.filter(t => t.active || counts.get(t.key)).map(t => <button key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(type === t.key ? null : t.key)}>
        {t.label}<span className="n">{counts.get(t.key) ?? 0}</span></button>)}</div>
    {docs == null ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">{all.length ? 'Nothing matches.' : 'No documents yet. Drop some files above to start.'}</p>
      : <div className="clist">{shown.map(d => <DocRow key={d.id} c={c} d={d} onOpen={() => setOpen(d)} />)}</div>}
    {adding && <AddDocsSheet api={c.api} files={adding} types={c.types} flash={c.flash} preset={type ? { doc_type: type, site: site && site !== '-' ? site : null } : undefined}
      onClose={() => setAdding(null)} onDone={async () => { setAdding(null); await load(); await c.reload() }} />}
    {open && <DocSheet c={c} d={open} onClose={() => setOpen(null)} onChanged={async () => { await load(); await c.reload() }} />}
  </div>
}

export function DocRow({ c, d, onOpen }: { c: Ctx; d: Doc; onOpen: () => void }) {
  return <button className="crow" onClick={onOpen}>
    <span className="grow"><span className="t">{d.title}</span>{d.version > 1 && <span className="muted"> v{d.version}</span>}
      <div className="muted small">{c.typeLabel(d.doc_type)}{d.site ? ` · ${d.site}` : ''}{d.license_no ? ` · ${d.license_no}` : ''}{d.crop_year ? ` · ${d.crop_year}` : ''} · added {fmtD(d.created_at)}{d.created_by ? ` by ${who(d.created_by)}` : ''}
        {(d.links ?? []).length > 0 && ` · ${[...new Set((d.links ?? []).map(l => REF_LABEL[l.ref_kind]))].join(', ')}`}</div></span>
    {d.deleted_at ? <span className="pill cp-mute">removed</span> : <Expiry d={d.expires_on} />}
    {!d.file_path && <span className="pill cp-info">link</span>}
  </button>
}

export function DocSheet({ c, d, onClose, onChanged }: { c: Ctx; d: Doc; onClose: () => void; onChanged: () => Promise<void> }) {
  const [ed, setEd] = useState<Partial<Doc> | null>(null)
  const [busy, setBusy] = useState(false)
  const [vers, setVers] = useState<Doc[]>([])
  const [newVer, setNewVer] = useState<File[] | null>(null)
  useEffect(() => { if (d.replaces_id) c.api.versions(d.replaces_id).then(setVers).catch(() => {}) }, [d.id])
  const mine = d.created_by === c.me
  const canEd = (c.canEdit || mine) && !d.deleted_at
  async function save() {
    setBusy(true)
    try { await c.api.updateDoc(d.id, { doc_type: ed!.doc_type, title: ed!.title, site: ed!.site ?? '', license_no: ed!.license_no ?? '', crop_year: ed!.crop_year ?? '',
      effective_on: ed!.effective_on ?? '', expires_on: ed!.expires_on ?? '', owner_email: ed!.owner_email ?? '', notes: ed!.notes ?? '', link_url: ed!.link_url ?? '' })
      c.flash('Saved'); await onChanged(); onClose() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function del() {
    if (!confirm(`Remove "${d.title}"? It disappears here; the SharePoint copy moves to _Archived.`)) return
    setBusy(true)
    try { await c.api.deleteDoc(d.id); c.flash('Removed'); await onChanged(); onClose() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  if (newVer) return <AddDocsSheet api={c.api} files={newVer} types={c.types} flash={c.flash} lockType
    preset={{ ...d, links: (d.links ?? []).map(l => ({ kind: l.ref_kind, id: l.ref_id })), replaces: d.id }}
    onClose={() => setNewVer(null)} onDone={async () => { setNewVer(null); await onChanged(); onClose() }} />
  return <Sheet title={d.title} sub={<>{c.typeLabel(d.doc_type)}{d.version > 1 ? ` · version ${d.version}` : ''}</>} onClose={onClose}>
    {d.deleted_at && <div className="warnbox">Removed {fmtD(d.deleted_at)} by {who(d.deleted_by)}.</div>}
    {!d.current && !d.deleted_at && <div className="infobox">An older version. A newer one replaced it.</div>}
    <FileChip api={c.api} f={d} flash={c.flash} sub={d.file_name ?? d.link_url ?? ''} />
    {d.file_path && d.link_url && <p className="small"><a href={d.link_url} target="_blank" rel="noopener">Original in SharePoint ›</a></p>}
    {!ed ? <>
      <dl>
        <dt>Site</dt><dd>{d.site ?? 'Company'}</dd>
        {d.license_no && <><dt>License</dt><dd className="mono">{d.license_no}</dd></>}
        {d.crop_year && <><dt>Crop year</dt><dd>{d.crop_year}</dd></>}
        {d.effective_on && <><dt>Effective</dt><dd>{fmtD(d.effective_on)}</dd></>}
        <dt>Expires</dt><dd>{d.expires_on ? <Expiry d={d.expires_on} /> : <span className="muted">no date</span>}</dd>
        {d.owner_email && <><dt>Owner</dt><dd>{d.owner_email}</dd></>}
        <dt>Added</dt><dd>{fmtD(d.created_at)} by {who(d.created_by)}</dd>
        {(d.links ?? []).length > 0 && <><dt>Linked to</dt><dd>{(d.links ?? []).map(l => `${REF_LABEL[l.ref_kind]} ${l.ref_id}`).join(', ')}</dd></>}
        {d.notes && <><dt>Notes</dt><dd>{d.notes}</dd></>}
        <dt>Backup</dt><dd className="small">{d.backed_up_at ? <>In SharePoint {fmtD(d.backed_up_at)}{d.sp_path ? <div className="muted mono">{d.sp_path}</div> : null}</>
          : d.backup_error ? <span className="neg">{d.backup_error}</span> : d.file_path ? <span className="muted">waiting for tonight's copy</span> : <span className="muted">link only</span>}</dd>
      </dl>
      {vers.length > 0 && <><h3>Earlier versions</h3><div className="trace-files">{vers.map(v => <FileChip key={v.id} api={c.api} f={v} flash={c.flash} sub={`v${v.version} · ${fmtD(v.created_at)}`} />)}</div></>}
      {canEd && <div className="actions" style={{ marginTop: 12 }}>
        <button className="ghost" onClick={() => setEd({ ...d })}>Edit details</button>
        {d.current && <DropZone compact onFiles={fs => setNewVer(fs.slice(0, 1))} label="drop a new version" />}
        <button className="ghost danger" disabled={busy} onClick={del}>Remove</button>
      </div>}
    </> : <>
      <F label="Title"><TextIn value={ed.title} onChange={v => setEd({ ...ed, title: v ?? '' })} /></F>
      <div className="grid2">
        <F label="Type"><Pick value={ed.doc_type ?? null} options={c.types.map(t => ({ v: t.key, l: t.label }))} onChange={v => setEd({ ...ed, doc_type: v ?? 'other' })} /></F>
        <F label="Site"><Pick value={ed.site ?? null} blank="Company (all sites)" options={SITES.map(s => ({ v: s, l: s }))} onChange={v => setEd({ ...ed, site: v })} /></F>
        <F label="License"><TextIn value={ed.license_no} onChange={v => setEd({ ...ed, license_no: v })} /></F>
        <F label="Crop year"><TextIn value={ed.crop_year != null ? String(ed.crop_year) : ''} onChange={v => setEd({ ...ed, crop_year: v ? Number(v) : null })} /></F>
        <F label="Effective"><DateIn value={ed.effective_on} onChange={v => setEd({ ...ed, effective_on: v })} /></F>
        <F label="Expires"><DateIn value={ed.expires_on} onChange={v => setEd({ ...ed, expires_on: v })} /></F>
      </div>
      <F label="Owner"><TextIn value={ed.owner_email} onChange={v => setEd({ ...ed, owner_email: v })} /></F>
      <F label="SharePoint link"><TextIn value={ed.link_url} onChange={v => setEd({ ...ed, link_url: v })} /></F>
      <F label="Notes"><textarea value={ed.notes ?? ''} onChange={e => setEd({ ...ed, notes: e.target.value || null })} /></F>
      <SaveBar busy={busy} onSave={save} onCancel={() => setEd(null)} disabled={!ed.title?.trim()} />
    </>}
  </Sheet>
}

// ---------- our licenses ----------
function Licenses({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<License[] | null>(null)
  const [open, setOpen] = useState<License | null>(null)
  const load = async () => { try { setRows(await c.api.licenses()) } catch (e) { c.flash(errText(e), true) } }
  useEffect(() => { load() }, [])
  return <>
    <p className="muted">Lifted's licenses (the list itself is in Admin › Settings › Licenses). Set each expiry date here so renewals show on Deadlines, and keep the license PDFs with them.</p>
    {!rows ? <p className="muted">Loading…</p> : <div className="clist">{rows.filter(l => l.active).map(l => <button key={l.license_no} className="crow" onClick={() => setOpen(l)}>
      <span className="grow"><span className="t mono">{l.license_no}</span><div className="muted small">{[l.site, l.kind, l.tier, l.entity].filter(Boolean).join(' · ')}</div></span>
      {l.expires ? <Expiry d={l.expires} /> : <span className="pill cp-warn">no expiry date</span>}</button>)}</div>}
    {open && <LicenseSheet c={c} l={open} onClose={() => setOpen(null)} onChanged={async () => { await load(); await c.reload() }} />}
  </>
}
function LicenseSheet({ c, l, onClose, onChanged }: { c: Ctx; l: License; onClose: () => void; onChanged: () => Promise<void> }) {
  const [exp, setExp] = useState<string | null>(l.expires)
  const [busy, setBusy] = useState(false)
  const save = async () => { setBusy(true); try { await c.api.setLicenseExpiry(l.license_no, exp); c.flash('Saved'); await onChanged() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) } }
  return <Sheet title={l.license_no} sub={[l.site, l.kind, l.entity].filter(Boolean).join(' · ')} onClose={onClose}>
    {l.premises && <p className="muted">{l.premises}</p>}
    <div className="row"><F label="Expires"><DateIn value={exp} onChange={setExp} /></F>
      {c.canEdit && <button className="primary" disabled={busy || exp === l.expires} onClick={save}>Save</button>}</div>
    <DocList api={c.api} kind="license" refId={l.license_no} docType="licenses" flash={c.flash} canAdd={c.canEdit} title="License documents"
      defaults={{ site: l.site, license_no: l.license_no, expires_on: exp }} empty="No license PDF here yet. Drop it below." />
  </Sheet>
}

// ---------- customer licenses ----------
const CUST_STATUS: Record<CustLic['status'], [string, string]> = { missing: ['No license', 'cp-bad'], expired: ['Expired', 'cp-bad'], expiring: ['Expiring', 'cp-warn'], no_expiry: ['No expiry date', 'cp-warn'], ok: ['OK', 'cp-ok'] }
function Customers({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<CustLic[] | null>(null)
  const [open, setOpen] = useState<CustLic | null>(null)
  const [onlyBad, setOnlyBad] = useState(false)
  const load = async () => { try { setRows(await c.api.customers()) } catch (e) { c.flash(errText(e), true) } }
  useEffect(() => { load() }, [])
  const shown = useMemo(() => (rows ?? []).filter(r => !onlyBad || r.status !== 'ok'), [rows, onlyBad])
  return <>
    <p className="muted">Outside customers' state licenses. Sales sees a warning on a new order when the license is missing or expired.</p>
    <label className="check"><input type="checkbox" checked={onlyBad} onChange={e => setOnlyBad(e.target.checked)} /> Only the ones that need something</label>
    {!rows ? <p className="muted">Loading…</p> : <div className="clist">{shown.map(r => <button key={r.id} className="crow" onClick={() => setOpen(r)}>
      <span className="grow"><span className="t">{r.name}</span><div className="muted small"><span className="mono">{r.license ?? 'no license on file'}</span>{r.last_order ? ` · last order ${fmtD(r.last_order)}` : ''}{r.docs ? ` · ${r.docs} file${r.docs === 1 ? '' : 's'}` : ''}</div></span>
      {r.license_expires && r.status !== 'missing' ? <Expiry d={r.license_expires} warn={30} /> : <span className={`pill ${CUST_STATUS[r.status][1]}`}>{CUST_STATUS[r.status][0]}</span>}</button>)}</div>}
    {open && <CustomerSheet c={c} r={open} onClose={() => setOpen(null)} onChanged={async () => { await load(); await c.reload() }} />}
  </>
}
function CustomerSheet({ c, r, onClose, onChanged }: { c: Ctx; r: CustLic; onClose: () => void; onChanged: () => Promise<void> }) {
  const [lic, setLic] = useState<string | null>(r.license)
  const [exp, setExp] = useState<string | null>(r.license_expires)
  const [busy, setBusy] = useState(false)
  const save = async () => { setBusy(true); try { await c.api.setCustomerLicense(r.id, lic, exp); c.flash('Saved'); await onChanged() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) } }
  return <Sheet title={r.name} sub="Customer license" onClose={onClose}>
    <div className="grid2"><F label="State license #"><TextIn value={lic} onChange={setLic} placeholder="C11-0000000-LIC" /></F><F label="Expires"><DateIn value={exp} onChange={setExp} /></F></div>
    {c.canEdit && <div className="row"><button className="primary" disabled={busy || (lic === r.license && exp === r.license_expires)} onClick={save}>Save</button></div>}
    <DocList api={c.api} kind="customer" refId={r.id} docType="customers" flash={c.flash} canAdd={c.canEdit} title="Their license"
      defaults={{ license_no: lic, expires_on: exp }} empty="No copy of their license yet. Drop it below." />
  </Sheet>
}
