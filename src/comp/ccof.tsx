import { useEffect, useMemo, useState } from 'react'
import type { AppLog, CcofEntry, Doc, Issue, Material } from './api'
import { STATUS_LABEL } from './api'
import type { Ctx } from './ctx'
import { AddDocsSheet, DocList, DropZone, Expiry, SITES, fmtD, today } from './files'
import { DocRow, DocSheet } from './library'
import { LOG_HEAD, appLogPdf, logRows } from './applog'
import { download, toCsv } from './csv'
import { readCcofPdf } from './ccoflist'
import type { CcofRow } from './ccoflist'
import { DateIn, F, Pick, SaveBar, Sheet, TextIn, errText } from '../cult/ui'

const ST_CLS: Record<Material['ccof_status'], string> = { approved: 'cp-ok', pending: 'cp-warn', not_allowed: 'cp-bad', unknown: 'cp-mute' }
const LISTINGS = ['OMRI', 'CDFA OIM', 'WSDA', 'CCOF approved', 'Not listed']
const MOD = (m: string) => (m === 'nursery' ? 'Nursery' : 'Production')

export function Ccof({ c }: { c: Ctx }) {
  const view = (['materials', 'list', 'log', 'certs', 'records'] as const).find(v => v === c.sub) ?? 'materials'
  return <div className="list">
    <div className="row between wrap toolbar"><h2>CCOF</h2>
      <div className="seg">{([['materials', 'Approved materials'], ['list', 'CCOF list'], ['log', 'Application log'], ['certs', 'Certificates'], ['records', 'Records']] as const).map(([k, l]) =>
        <button key={k} className={view === k ? 'on' : ''} onClick={() => c.go('ccof', k)}>{l}</button>)}</div></div>
    {c.ov.certs && Object.values(c.ov.certs).some(v => !v) && <p className="muted small">Not CCOF certified: {Object.entries(c.ov.certs).filter(([, v]) => !v).map(([k]) => k).join(', ')}. Their logs and products are left out of the CCOF checks (Settings › Sites).</p>}
    {view === 'materials' && <Materials c={c} />}
    {view === 'list' && <CcofListView c={c} />}
    {view === 'log' && <AppLogView c={c} />}
    {view === 'certs' && <TypeDocs c={c} types={['ccof_cert']} note="OCal certificates, the OSP, inspection reports and CCOF letters. Put an expiry date on the certificate so the renewal shows on Deadlines." />}
    {view === 'records' && <TypeDocs c={c} types={['ccof_records', 'receipts']} note="Soil affidavits, cover crop records, labeling approvals, post harvest handling, and receipts for inputs (inspectors ask for these)." />}
  </div>
}

// ---------- approved materials (the Production and Nursery product lists) ----------
function Materials({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<Material[] | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [st, setSt] = useState<string | null>(null)
  const nurseryCert = c.ov.certs?.['1PN'] ?? true
  const [mod, setMod] = useState<string | null>(nurseryCert ? null : 'cultivation')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Material | null>(null)
  const [list, setList] = useState<CcofEntry[]>([])
  const load = async () => { try { const [m, i, l] = await Promise.all([c.api.materials(), c.api.issues(), c.api.ccofList().catch(() => [] as CcofEntry[])]); setRows(m); setIssues(i); setList(l) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load() }, [])
  const used = useMemo(() => { const m = new Map<string, number>(); for (const i of issues) m.set(`${i.module}|${i.product.toLowerCase()}`, (m.get(`${i.module}|${i.product.toLowerCase()}`) ?? 0) + 1); return m }, [issues])
  const all = (rows ?? []).filter(m => m.active || st === 'inactive')
  const shown = all.filter(m => (!st || (st === 'inactive' ? !m.active : m.ccof_status === st)) && (!mod || m.module === mod) &&
    (!q || `${m.name} ${m.manufacturer ?? ''} ${m.kind ?? ''} ${m.listing ?? ''}`.toLowerCase().includes(q.toLowerCase())))
  const n = (s: string) => all.filter(m => m.ccof_status === s).length
  const orphan = [...new Map(issues.filter(i => i.product_id == null).map(i => [`${i.module}|${i.product.toLowerCase()}`, i])).values()]
  return <>
    <p className="muted">The Production and Nursery product lists, with CCOF approval. Feed and Spray logs warn when someone uses a product that isn't approved here, and those show in Review.</p>
    <div className="row wrap toolbar">
      <input className="search" placeholder="Search products" value={q} onChange={e => setQ(e.target.value)} />
      <select value={mod ?? ''} onChange={e => setMod(e.target.value || null)} aria-label="List"><option value="">Production + Nursery</option><option value="cultivation">Production</option><option value="nursery">Nursery{nurseryCert ? '' : ' (not certified)'}</option></select>
    </div>
    <div className="chips"><button className={!st ? 'on' : ''} onClick={() => setSt(null)}>All<span className="n">{all.length}</span></button>
      {(Object.keys(STATUS_LABEL) as Material['ccof_status'][]).map(s => <button key={s} className={st === s ? 'on' : ''} onClick={() => setSt(st === s ? null : s)}>{STATUS_LABEL[s]}<span className="n">{n(s)}</span></button>)}
      <button className={st === 'inactive' ? 'on' : ''} onClick={() => setSt(st === 'inactive' ? null : 'inactive')}>Inactive</button></div>
    {orphan.length > 0 && <div className="warnbox">Used in logs this year but not on a product list: {orphan.map(i => `${i.product} (${MOD(i.module)})`).join(', ')}. Add them in {MOD(orphan[0].module)} › Logs › Products.</div>}
    {rows == null ? <p className="muted">Loading…</p> : <div className="tablewrap"><table className="ct">
      <thead><tr><th>Product</th><th className="hide-s">Maker</th><th className="hide-s">List</th><th>CCOF</th><th className="hide-s">CCOF #</th><th className="hide-s">Listing</th><th>Expires</th><th className="num hide-s">Log lines this year</th></tr></thead>
      <tbody>{shown.map(m => { const u = used.get(`${m.module}|${m.name.toLowerCase()}`)
        return <tr key={m.id} className={`tap ${u && m.ccof_status !== 'approved' ? 'flag' : ''}`} onClick={() => setOpen(m)}>
          <td><b>{m.name}</b>{m.pesticide && <span className="pill warnp" style={{ marginLeft: 6 }}>pesticide</span>}<div className="muted small">{m.kind ?? ''}</div></td>
          <td className="hide-s">{m.manufacturer ?? ''}</td><td className="hide-s">{MOD(m.module)}</td>
          <td><span className={`pill ${ST_CLS[m.ccof_status]}`}>{STATUS_LABEL[m.ccof_status]}</span></td>
          <td className="mono small hide-s">{m.ccof_code ?? <span className="muted">not on list</span>}</td>
          <td className="hide-s">{m.listing ?? ''}</td>
          <td>{m.listing_expires ? <Expiry d={m.listing_expires} warn={30} /> : ''}</td>
          <td className="num hide-s">{u ? <span className="neg">{u} not approved</span> : ''}</td></tr> })}</tbody></table></div>}
    {open && <MaterialSheet c={c} m={open} list={list} uses={used.get(`${open.module}|${open.name.toLowerCase()}`) ?? 0} onClose={() => setOpen(null)} onSaved={async () => { setOpen(null); await load(); await c.reload() }} />}
  </>
}

function MaterialSheet({ c, m, list, uses, onClose, onSaved }: { c: Ctx; m: Material; list: CcofEntry[]; uses: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const [lq, setLq] = useState('')
  const [linking, setLinking] = useState(false)
  const entry = list.find(e => e.code === m.ccof_code)
  const guesses = useMemo(() => {
    const w = (lq || m.name).toLowerCase().split(/[^a-z0-9.]+/).filter(x => x.length > 1)
    return list.map(e => ({ e, n: w.filter(x => `${e.name} ${e.manufacturer ?? ''} ${e.code}`.toLowerCase().includes(x)).length })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 8).map(x => x.e)
  }, [lq, list, m.name])
  async function link(code: string | null) {
    setBusy(true)
    try { await c.api.linkCcof(m.id, code); c.flash(code ? `Linked to CCOF ${code}` : 'Unlinked'); await onSaved() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const [x, setX] = useState<Partial<Material>>(m)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Material>) => setX(s => ({ ...s, ...v }))
  async function save() {
    setBusy(true)
    try { await c.api.setMaterial(m.id, { ccof_status: x.ccof_status, listing: x.listing ?? '', listing_no: x.listing_no ?? '', listing_expires: x.listing_expires ?? '',
      restrictions: x.restrictions ?? '', ccof_notes: x.ccof_notes ?? '', epa_reg: x.epa_reg ?? '' }); c.flash('Saved'); await onSaved() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title={m.name} sub={<>{m.manufacturer ?? ''} · {MOD(m.module)} list{m.pesticide ? ' · pesticide' : ''}</>} onClose={onClose}>
    {uses > 0 && m.ccof_status !== 'approved' && <div className="warnbox">Used on {uses} log line{uses === 1 ? '' : 's'} this year without approval.</div>}
    <div className="infobox">{entry ? <><b>CCOF {entry.code}</b> · {entry.name} <span className="muted">({entry.manufacturer})</span>
        <div className="small">{entry.status}{entry.listing ? ` · ${entry.listing}` : ''}{entry.approved_on ? ` · approved ${fmtD(entry.approved_on)}` : ''}</div>
        {entry.restriction && <div className="small"><b>Restriction:</b> {entry.restriction}</div>}
        {entry.action_required && <div className="small neg">CCOF action required</div>}
        {c.canEdit && <div className="row" style={{ marginTop: 6 }}><button className="ghost small" disabled={busy} onClick={() => setLinking(v => !v)}>Change</button><button className="ghost small" disabled={busy} onClick={() => link(null)}>Unlink</button></div>}</>
      : <><b>Not linked to the CCOF list.</b> {c.canEdit && !linking && <button className="linkbtn" onClick={() => setLinking(true)}>Find it on the list ›</button>}</>}
      {linking && c.canEdit && <div style={{ marginTop: 8 }}><input className="search" placeholder="Search the CCOF list (name, maker or code)" value={lq} onChange={e => setLq(e.target.value)} autoFocus />
        <div className="dlist" style={{ marginTop: 6 }}>{guesses.map(e => <button key={e.id} className="drow linkrow" disabled={busy} onClick={() => link(e.code)}>
          <span className="grow"><span className="mono small">{e.code}</span> {e.name} <span className="muted small">{e.manufacturer}</span></span><span className="small">{e.status}</span></button>)}
          {!guesses.length && <p className="muted small">Nothing matches. If it isn't on the list, add it in MyCCOF before using it.</p>}</div></div>}
    </div>
    <div className="grid2">
      <F label="CCOF status"><Pick value={x.ccof_status ?? 'unknown'} options={(Object.keys(STATUS_LABEL) as Material['ccof_status'][]).map(s => ({ v: s, l: STATUS_LABEL[s] }))} onChange={v => set({ ccof_status: v ?? 'unknown' })} /></F>
      <F label="Listed by"><Pick value={x.listing ?? null} blank="—" options={LISTINGS.map(l => ({ v: l, l }))} onChange={v => set({ listing: v })} /></F>
      <F label="Listing / cert #"><TextIn value={x.listing_no} onChange={v => set({ listing_no: v })} /></F>
      <F label="Listing expires"><DateIn value={x.listing_expires} onChange={v => set({ listing_expires: v })} /></F>
      {m.pesticide && <F label="EPA / CA reg #"><TextIn value={x.epa_reg} onChange={v => set({ epa_reg: v })} /></F>}
    </div>
    <F label="Restrictions / annotations" hint="e.g. 'allowed only for…'"><textarea value={x.restrictions ?? ''} onChange={e => set({ restrictions: e.target.value || null })} /></F>
    <F label="Notes"><textarea value={x.ccof_notes ?? ''} onChange={e => set({ ccof_notes: e.target.value || null })} /></F>
    {m.ccof_by && <p className="muted small">Last set by {m.ccof_by.split('@')[0]} {fmtD(m.ccof_at)}</p>}
    <DocList api={c.api} kind="material" refId={m.id} docType={m.pesticide ? 'pesticides' : 'fertilizers'} flash={c.flash} canAdd={c.canEdit} title="Label, SDS, listing certificate"
      defaults={{ expires_on: x.listing_expires ?? null }} empty="Drop the label, SDS and OMRI / OIM listing here." />
    {c.canEdit && <SaveBar busy={busy} onSave={save} onCancel={onClose} />}
  </Sheet>
}

// ---------- application log ----------
function AppLogView({ c }: { c: Ctx }) {
  const y = new Date().getFullYear()
  const [from, setFrom] = useState<string | null>(`${y}-01-01`)
  const [to, setTo] = useState<string | null>(today())
  const [site, setSite] = useState<string | null>(null)
  const [mod, setMod] = useState<string | null>('cultivation')
  const [kind, setKind] = useState<'both' | 'feed' | 'spray'>('both')
  const [rows, setRows] = useState<AppLog[] | null>(null)
  const [mats, setMats] = useState<Material[]>([])
  useEffect(() => { c.api.materials().then(setMats).catch(() => {}) }, [])
  useEffect(() => { if (!from || !to) return; setRows(null); c.api.appLog(from, to, site, mod).then(setRows).catch(e => { c.flash(errText(e), true); setRows([]) }) }, [from, to, site, mod])
  const logs = (rows ?? []).filter(l => kind === 'both' || l.kind === kind)
  const ok = (module: string, product: string) => { const m = mats.find(x => x.module === module && x.name.toLowerCase() === product.toLowerCase()); return !!m && m.ccof_status === 'approved' }
  const lines = logRows(logs)
  const flags = logs.flatMap(l => (l.products.length ? l.products : [{ product: '' }]).map(p => !!p.product && !ok(l.module, p.product)))
  const name = `Application log ${site ?? 'all sites'} ${from} to ${to}`
  async function pdf() {
    try { const b = await appLogPdf(logs, { from: from!, to: to!, site, who: c.me?.split('@')[0] ?? '', entity: 'Lifted Farms (DNA Organics, Inc.)' })
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${name}.pdf`; a.click() } catch (e) { c.flash(errText(e), true) }
  }
  return <>
    <p className="muted">Built from the Feed and Spray logs in Production and Nursery, in the Farm Data layout. Nothing to enter here. Highlighted lines use a product that isn't approved in Approved materials.</p>
    <div className="row wrap toolbar">
      <F label="From"><DateIn value={from} onChange={setFrom} /></F><F label="To"><DateIn value={to} onChange={setTo} /></F>
      <F label="Site"><Pick value={site} blank="All sites" options={SITES.map(s => ({ v: s, l: s }))} onChange={setSite} /></F>
      <F label="Logs"><Pick value={mod} blank="Production + Nursery" options={[{ v: 'cultivation', l: 'Production' }, { v: 'nursery', l: 'Nursery' }]} onChange={setMod} /></F>
      <F label="Kind"><Pick value={kind} options={[{ v: 'both', l: 'Feed + Spray' }, { v: 'feed', l: 'Feed only' }, { v: 'spray', l: 'Spray only' }]} onChange={v => setKind(v ?? 'both')} /></F>
    </div>
    <div className="row"><button className="primary" disabled={!logs.length} onClick={pdf}>Download PDF</button>
      <button className="ghost" disabled={!logs.length} onClick={() => download(`${name}.csv`, toCsv(LOG_HEAD.slice(0, 11).concat('Total unit'), lines))}>CSV</button>
      <span className="muted">{logs.length} application{logs.length === 1 ? '' : 's'}{flags.some(Boolean) ? ` · ${flags.filter(Boolean).length} line(s) not approved` : ''}</span></div>
    {rows == null ? <p className="muted">Loading…</p> : !logs.length ? <p className="muted">No Feed or Spray logs in these dates.</p> : <div className="tablewrap" style={{ marginTop: 10 }}><table className="ct">
      <thead><tr>{LOG_HEAD.map((h, i) => <th key={i} className={[4, 5, 8, 10].includes(i) ? 'num' : ''}>{h}</th>)}</tr></thead>
      <tbody>{lines.map((r, i) => <tr key={i} className={`${r[0] ? 'grp' : ''} ${flags[i] ? 'flag' : ''}`}>{r.map((v, j) => <td key={j} className={[4, 5, 8, 10].includes(j) ? 'num' : ''}>{j < 2 ? <b>{v}</b> : v}</td>)}</tr>)}</tbody>
    </table></div>}
  </>
}

// ---------- documents of one or two types (Certificates, Records) ----------
export function TypeDocs({ c, types, note }: { c: Ctx; types: string[]; note: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [adding, setAdding] = useState<File[] | null>(null)
  const [open, setOpen] = useState<Doc | null>(null)
  const load = async () => { try { setDocs((await c.api.docs()).filter(d => types.includes(d.doc_type) && d.current)) } catch (e) { c.flash(errText(e), true); setDocs([]) } }
  useEffect(() => { load() }, [types.join()])
  return <>
    <p className="muted">{note}</p>
    {c.canEdit && <DropZone onFiles={setAdding} label={`Drag ${types.map(c.typeLabel).join(' or ').toLowerCase()} here`} />}
    {docs == null ? <p className="muted">Loading…</p> : !docs.length ? <p className="muted">Nothing here yet.</p> : <div className="clist" style={{ marginTop: 10 }}>{docs.map(d => <DocRow key={d.id} c={c} d={d} onOpen={() => setOpen(d)} />)}</div>}
    {adding && <AddDocsSheet api={c.api} files={adding} types={c.types} flash={c.flash} preset={{ doc_type: types[0] }} onClose={() => setAdding(null)} onDone={async () => { setAdding(null); await load(); await c.reload() }} />}
    {open && <DocSheet c={c} d={open} onClose={() => setOpen(null)} onChanged={async () => { await load(); await c.reload() }} />}
  </>
}

// ---------- the CCOF OSP materials list (from MyCCOF) ----------
function CcofListView({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<CcofEntry[] | null>(null)
  const [mats, setMats] = useState<Material[]>([])
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ file: File; rows: CcofRow[]; date: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => { try { const [l, m] = await Promise.all([c.api.ccofList(), c.api.materials()]); setRows(l); setMats(m) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load() }, [])
  async function read(fs: File[]) {
    const f = fs.find(x => /\.pdf$/i.test(x.name)) ?? fs[0]
    setBusy(true)
    try { const r = await readCcofPdf(f); if (r.rows.length < 5) throw new Error('No materials found in that PDF. Use the OSP Materials List from MyCCOF.'); setPreview({ file: f, rows: r.rows, date: r.listDate }) }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function doImport() {
    if (!preview) return
    setBusy(true)
    try {
      const r = await c.api.importCcof(preview.date, preview.rows, preview.file.name)
      // keep the PDF itself in the Library too
      try { const path = await c.api.upload(preview.file, 'ccof_cert')
        await c.api.addDoc({ doc_type: 'ccof_cert', title: `CCOF OSP Materials List${preview.date ? ` ${preview.date}` : ''}`, file_path: path, file_name: preview.file.name,
          mime: preview.file.type || 'application/pdf', size_bytes: preview.file.size, effective_on: preview.date }) } catch { /* list is in; the file copy is a bonus */ }
      c.flash(`CCOF list loaded: ${r.active} entries (${r.new} new), ${r.linked} product${r.linked === 1 ? '' : 's'} linked by name${r.off_list ? `, ${r.off_list} no longer on the list` : ''}`)
      setPreview(null); await load(); await c.reload()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const byCode = useMemo(() => { const m = new Map<string, Material[]>(); for (const x of mats) if (x.ccof_code) m.set(x.ccof_code, [...(m.get(x.ccof_code) ?? []), x]); return m }, [mats])
  const cats = [...new Set((rows ?? []).map(r => r.category ?? 'Other'))]
  const shown = (rows ?? []).filter(r => (!cat || (r.category ?? 'Other') === cat) && (!q || `${r.code} ${r.name} ${r.manufacturer ?? ''} ${r.restriction ?? ''}`.toLowerCase().includes(q.toLowerCase())))
  const date = rows?.[0]?.list_date
  return <>
    <p className="muted">Lifted's approved materials as CCOF has them (MyCCOF › OSP Materials List){date ? `, list from ${fmtD(date)}` : ''}. To update it, download a fresh list from MyCCOF and drop the PDF here. Products are matched by name; link the rest from Approved materials.</p>
    {c.canEdit && (busy && !preview ? <p className="muted">Reading the PDF…</p> : <DropZone onFiles={read} accept=".pdf" label="Drop the CCOF OSP Materials List PDF" />)}
    {preview && <div className="infobox" style={{ marginTop: 10 }}>
      <b>{preview.file.name}</b>: {preview.rows.length} materials{preview.date ? `, generated ${fmtD(preview.date)}` : ''}. {preview.rows.filter(r => r.action_required).length} need action.
      <div className="row" style={{ marginTop: 6 }}><button className="primary" disabled={busy} onClick={doImport}>Load this list</button><button className="ghost" onClick={() => setPreview(null)}>Cancel</button></div></div>}
    <div className="row wrap toolbar" style={{ marginTop: 10 }}><input className="search" placeholder="Search the CCOF list" value={q} onChange={e => setQ(e.target.value)} /></div>
    <div className="chips"><button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>All<span className="n">{rows?.length ?? 0}</span></button>
      {cats.map(k => <button key={k} className={cat === k ? 'on' : ''} onClick={() => setCat(cat === k ? null : k)}>{k}</button>)}</div>
    {rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No CCOF list loaded yet.</p> : <div className="tablewrap"><table className="ct">
      <thead><tr><th>Code</th><th>Material</th><th className="hide-s">Maker</th><th>Status</th><th className="hide-s">Restriction / comment</th><th>In the app as</th></tr></thead>
      <tbody>{shown.map(r => { const ms = byCode.get(r.code) ?? []
        return <tr key={r.id} className={r.action_required ? 'flag' : ''}>
          <td className="mono small nowrap">{r.code}</td><td><b>{r.name}</b><div className="muted small">{r.approved_on ? `approved ${fmtD(r.approved_on)}` : ''}</div></td>
          <td className="hide-s small">{r.manufacturer}</td>
          <td><span className={`pill ${r.action_required ? 'cp-bad' : /restricted/i.test(r.status ?? '') ? 'cp-warn' : 'cp-ok'}`}>{r.action_required ? 'Action required' : r.status}</span><div className="muted small">{r.listing}</div></td>
          <td className="hide-s small">{r.restriction}{r.comment && <div className="muted">{r.comment}</div>}</td>
          <td className="small">{ms.map(m => `${m.name}${m.module === 'nursery' ? ' (nursery)' : ''}`).join(', ')}</td></tr> })}</tbody></table></div>}
  </>
}
