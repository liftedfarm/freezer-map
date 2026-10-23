import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CompApi, Doc, DocType, FileRef, License, RefKind } from './api'
import { DateIn, F, Pick, SaveBar, Sheet, TextIn, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'
import './comp.css'

// Shared file pieces: drag and drop / Upload file / Take photo, a list of files on any record, the add-documents form.

export const SITES = ['OHR', 'GVR', '1PN']
const touch = () => { try { return matchMedia('(pointer: coarse)').matches } catch { return false } }
export const fmtD = (iso: string | null | undefined) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '')
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export const daysTo = (iso: string | null | undefined) => (iso ? Math.round((new Date(iso.slice(0, 10) + 'T12:00:00').getTime() - new Date(today() + 'T12:00:00').getTime()) / 86400000) : null)
const baseName = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
const kb = (n: number | null | undefined) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const icon = (m: string | null | undefined, name?: string | null) => /pdf/i.test(m ?? '') || /\.pdf$/i.test(name ?? '') ? 'PDF' : /image/i.test(m ?? '') ? 'IMG' : /sheet|excel|csv/i.test(m ?? '') || /\.(xlsx?|csv)$/i.test(name ?? '') ? 'XLS' : /word/i.test(m ?? '') || /\.docx?$/i.test(name ?? '') ? 'DOC' : 'FILE'

/** expiry pill: red when past, amber inside the warning window */
export function Expiry({ d, warn = 60 }: { d: string | null | undefined; warn?: number }) {
  if (!d) return null
  const n = daysTo(d)!
  return <span className={`pill ${n < 0 ? 'cp-bad' : n <= warn ? 'cp-warn' : 'cp-ok'}`}>{n < 0 ? `expired ${fmtD(d)}` : `expires ${fmtD(d)}`}</span>
}

/** drop files here, or Upload file, or (phones) Take photo */
export function DropZone({ onFiles, label, compact, disabled, accept }: { onFiles: (fs: File[]) => void; label?: ReactNode; compact?: boolean; disabled?: boolean; accept?: string }) {
  const [over, setOver] = useState(false)
  const pick = useRef<HTMLInputElement>(null), cam = useRef<HTMLInputElement>(null)
  const take = (l: FileList | null) => { const fs = [...(l ?? [])]; if (fs.length) onFiles(fs) }
  if (disabled) return null
  return (
    <div className={`cdrop ${over ? 'over' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(false); take(e.dataTransfer.files) }}>
      {!compact && <span className="muted">{label ?? 'Drag files here'}</span>}
      <button type="button" className="ghost small" onClick={() => pick.current?.click()}>Upload file</button>
      {touch() && <button type="button" className="ghost small" onClick={() => cam.current?.click()}>Take photo</button>}
      {compact && <span className="muted small">{label ?? 'or drop files here'}</span>}
      <input ref={pick} type="file" multiple hidden accept={accept} onChange={e => { take(e.target.files); e.target.value = '' }} />
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={e => { take(e.target.files); e.target.value = '' }} />
    </div>
  )
}

/** one file: tap to open (signed link, a few minutes) */
export function FileChip({ api, f, flash, sub }: { api: CompApi; f: FileRef | Doc; flash: Flash; sub?: ReactNode }) {
  const [busy, setBusy] = useState(false)
  const open = async () => { setBusy(true); try { await api.open(f) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return <button type="button" className="cfile" disabled={busy} onClick={open} title={f.file_name ?? f.link_url ?? ''}>
    <span className="cficon">{f.file_path ? icon(f.mime, f.file_name) : 'LINK'}</span>
    <span className="grow"><span className="cft">{f.title}</span>{sub && <span className="muted small"> {sub}</span>}</span>
  </button>
}

/** the files on one record (a test, a material, a customer…) with drop-to-add. Dropped files go straight in with the defaults. */
export function DocList({ api, kind, refId, docType, flash, defaults, canAdd = true, empty, onChanged, title }: {
  api: CompApi; kind: RefKind; refId: string | number | null; docType: string; flash: Flash; canAdd?: boolean; empty?: string
  defaults?: Record<string, unknown>; onChanged?: (n: number) => void; title?: ReactNode
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = async () => {
    if (refId == null) { setDocs([]); return }
    try { const d = await api.docsFor(kind, refId); setDocs(d); onChanged?.(d.length) } catch (e) { setDocs([]); flash(errText(e), true) }
  }
  useEffect(() => { load() }, [kind, refId])
  async function add(fs: File[]) {
    if (refId == null) return
    try {
      for (const [i, f] of fs.entries()) {
        setBusy(`Uploading ${i + 1} of ${fs.length}…`)
        const path = await api.upload(f, docType)
        await api.addDoc({ doc_type: docType, title: baseName(f.name), file_path: path, file_name: f.name, mime: f.type || null, size_bytes: f.size,
          ...defaults, links: [{ kind, id: String(refId) }, ...((defaults?.links as object[]) ?? [])] })
      }
      flash(fs.length === 1 ? 'File added' : `${fs.length} files added`); await load()
    } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  async function remove(d: Doc) {
    if (!confirm(`Remove "${d.title}"? (The backup copy is kept in SharePoint.)`)) return
    try { await api.deleteDoc(d.id); await load() } catch (e) { flash(errText(e), true) }
  }
  return (
    <div className="cdoclist">
      {title && <div className="cdl-h">{title}</div>}
      {docs == null ? <p className="muted small">Loading files…</p>
        : docs.length === 0 ? <p className="muted small">{empty ?? 'No files yet.'}</p>
        : docs.map(d => <div key={d.id} className="row cdl-row"><FileChip api={api} f={d} flash={flash} sub={<>{d.version > 1 ? `v${d.version} · ` : ''}{fmtD(d.created_at)}{d.size_bytes ? ` · ${kb(d.size_bytes)}` : ''}</>} />
          {d.expires_on && <Expiry d={d.expires_on} />}
          {canAdd && <button className="ghost small" title="Remove" onClick={() => remove(d)}>✕</button>}</div>)}
      {busy ? <p className="muted small">{busy}</p> : canAdd && refId != null && <DropZone compact onFiles={add} />}
    </div>
  )
}

/** the add-documents form: one or more files with the same type / site / dates */
export function AddDocsSheet({ api, files, types, flash, preset, lockType, onClose, onDone }: {
  api: CompApi; files: File[]; types: DocType[]; flash: Flash; preset?: Partial<Omit<Doc, 'links'>> & { links?: { kind: RefKind; id: string }[]; replaces?: number }
  lockType?: boolean; onClose: () => void; onDone: (ids: number[]) => void
}) {
  const [licenses, setLicenses] = useState<License[]>([])
  useEffect(() => { api.licenses().then(setLicenses).catch(() => {}) }, [])
  const [x, setX] = useState<Partial<Doc>>({ doc_type: preset?.doc_type ?? guessType(files[0]?.name ?? '', types), site: preset?.site ?? null, license_no: preset?.license_no ?? null,
    crop_year: preset?.crop_year ?? null, effective_on: preset?.effective_on ?? null, expires_on: preset?.expires_on ?? null, notes: preset?.notes ?? null,
    owner_email: preset?.owner_email ?? null, link_url: null })
  const [titles, setTitles] = useState<string[]>(files.map(f => preset?.title && files.length === 1 ? preset.title : baseName(f.name)))
  const [busy, setBusy] = useState<string | null>(null)
  const set = (v: Partial<Doc>) => setX(s => ({ ...s, ...v }))
  const t = types.find(y => y.key === x.doc_type)
  const linkOnly = files.length === 0
  const [linkTitle, setLinkTitle] = useState(preset?.title ?? '')
  async function save() {
    const ids: number[] = []
    try {
      if (linkOnly) {
        setBusy('Saving…')
        ids.push(await api.addDoc({ ...x, title: linkTitle, links: preset?.links ?? [], replaces: preset?.replaces ?? null }))
      }
      for (const [i, f] of files.entries()) {
        setBusy(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…')
        const path = await api.upload(f, x.doc_type ?? 'other')
        ids.push(await api.addDoc({ ...x, title: titles[i] || baseName(f.name), file_path: path, file_name: f.name, mime: f.type || null, size_bytes: f.size,
          links: preset?.links ?? [], replaces: i === 0 ? preset?.replaces ?? null : null }))
      }
      flash(ids.length === 1 ? 'Saved' : `${ids.length} documents saved`); onDone(ids)
    } catch (e) { flash(errText(e), true); if (ids.length) onDone(ids) } finally { setBusy(null) }
  }
  return (
    <Sheet title={preset?.replaces ? 'New version' : linkOnly ? 'Add a link' : files.length === 1 ? 'Add document' : `Add ${files.length} documents`} onClose={onClose}>
      {linkOnly
        ? <><F label="Title"><TextIn value={linkTitle} onChange={v => setLinkTitle(v ?? '')} autoFocus /></F>
            <F label="Link" hint="SharePoint or web address"><TextIn value={x.link_url} onChange={v => set({ link_url: v })} placeholder="https://…" /></F></>
        : files.map((f, i) => <F key={i} label={files.length > 1 ? `Title ${i + 1}` : 'Title'} hint={`${f.name} · ${kb(f.size)}`}>
            <TextIn value={titles[i]} onChange={v => setTitles(ts => ts.map((y, j) => j === i ? v ?? '' : y))} /></F>)}
      <div className="grid2">
        <F label="Type">{lockType ? <b>{t?.label ?? x.doc_type}</b>
          : <Pick value={x.doc_type ?? null} options={types.filter(y => y.active || y.key === x.doc_type).map(y => ({ v: y.key, l: y.label }))} onChange={v => set({ doc_type: v ?? 'other' })} />}</F>
        <F label="Site"><Pick value={x.site ?? null} blank="Company (all sites)" options={SITES.map(s => ({ v: s, l: s }))} onChange={v => set({ site: v })} /></F>
        <F label="License"><Pick value={x.license_no ?? null} blank="None" options={licenses.map(l => ({ v: l.license_no, l: `${l.license_no} · ${l.site ?? l.entity ?? ''} ${l.kind}` }))} onChange={v => set({ license_no: v })} /></F>
        <F label="Crop year"><Pick value={x.crop_year ?? null} blank="None" options={[0, 1, 2, 3].map(k => new Date().getFullYear() + 1 - k).map(y => ({ v: y, l: String(y) }))} onChange={v => set({ crop_year: v })} /></F>
        <F label="Effective"><DateIn value={x.effective_on} onChange={v => set({ effective_on: v })} /></F>
        <F label="Expires" hint={t?.expires ? 'shows on Deadlines' : 'if it does'}><DateIn value={x.expires_on} onChange={v => set({ expires_on: v })} /></F>
      </div>
      <F label="Owner" hint="who keeps it current (email)"><TextIn value={x.owner_email} onChange={v => set({ owner_email: v })} placeholder="name@lifted-organics.com" /></F>
      {!linkOnly && <F label="SharePoint link" hint="optional, where the original lives"><TextIn value={x.link_url} onChange={v => set({ link_url: v })} placeholder="https://…" /></F>}
      <F label="Notes"><textarea value={x.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
      {busy && <p className="muted">{busy}</p>}
      <SaveBar busy={!!busy} onSave={save} onCancel={onClose} disabled={linkOnly ? !linkTitle.trim() || !x.link_url : titles.some(y => !y.trim())} saveLabel={linkOnly ? 'Save' : 'Upload'} />
    </Sheet>
  )
}

/** a reasonable first guess from the file name */
export function guessType(name: string, types: DocType[]): string {
  const n = name.toLowerCase()
  const has = (k: string) => types.some(t => t.key === k && t.active)
  const rules: [RegExp, string][] = [[/coa|pre.?harvest|composite|pesticide panel|potency|lab result|infinite|icanna/, 'testing'], [/sop|procedure/, 'sops'],
    [/ccof|ocal|osp|organic system/, 'ccof_cert'], [/affidavit|cover crop|labell?ing/, 'ccof_records'], [/sds|msds|omri|oim/, 'fertilizers'],
    [/receipt|invoice|purchase/, 'receipts'], [/license|licence|ccl\d|permit/, 'licenses'], [/inspection|notice/, 'inspections'],
    [/insurance|policy|certificate of insurance|coi/, 'insurance'], [/training|sign.?off/, 'training'], [/metrc/, 'metrc'], [/security|premises|diagram/, 'security'],
    [/waste/, 'waste'], [/water|ceqa/, 'water'], [/pur|use report/, 'reports']]
  for (const [re, k] of rules) if (re.test(n) && has(k)) return k
  return has('other') ? 'other' : types[0]?.key ?? 'other'
}
