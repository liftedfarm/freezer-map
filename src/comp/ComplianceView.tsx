import '../cult/cult.css'
import './comp.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Backend } from '../api'
import { CompApi } from './api'
import type { BackupRun, Deadline, DocType, Issue, MError, Material, Overview, TestNoFile } from './api'
import type { CTab } from './tabs'
import type { Ctx } from './ctx'
import { Card, Cards, DashHead, Empty, Tile, Tiles } from '../dash'
import { F, NumIn, SaveBar, Sheet, TextIn, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { ModulePeople } from '../users'
import { Fold } from '../fold'
import { Library } from './library'
import { Deadlines, dueText, dueTone } from './deadlines'
import { Ccof } from './ccof'
import { Metrc } from './metrc'
import { fmtD } from './files'

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const ago = (iso: string | null | undefined) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 86400000) : null)

export default function ComplianceView({ backend, flash, tab, go, isAdmin, canEdit, me }: {
  backend: Backend; flash: Flash; tab: CTab; go: (t: CTab) => void; isAdmin: boolean; canEdit: boolean; me: string | null
}) {
  const sb = useMemo(() => backend.client(), [backend])
  const api = useMemo(() => (sb ? new CompApi(sb) : null), [sb])
  const [ov, setOv] = useState<Overview | null>(null)
  const [types, setTypes] = useState<DocType[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [sub, setSub] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!api) return
    try { const [o, t] = await Promise.all([api.overview(), api.docTypes()]); setOv(o); setTypes(t); setErr(null) } catch (e) { setErr(errText(e)) }
  }, [api])
  useEffect(() => { load() }, [load])
  useEffect(() => { setSub(null) }, [tab])

  if (!api) return <div className="list"><h2>Compliance</h2><p className="muted">Compliance needs the database (not available in the demo).</p></div>
  if (err) return <div className="list"><h2>Compliance</h2><div className="warnbox">Couldn't load Compliance. If this is the first time, run 055_compliance.sql in Supabase. ({err})</div></div>
  if (!ov) return <div className="list"><h2>Compliance</h2><p className="muted">Loading…</p></div>

  const c: Ctx = {
    api, flash, canEdit, isAdmin, types, ov, me, reload: load, sub,
    go: (t, s) => { if (t !== tab) go(t); setSub(s ?? null); window.scrollTo(0, 0) },
    typeLabel: k => types.find(t => t.key === k)?.label ?? k ?? '',
  }
  return (
    <div className="comp">
      {tab === 'dashboard' && <Dashboard c={c} />}
      {tab === 'deadlines' && <Deadlines c={c} />}
      {tab === 'library' && <Library c={c} />}
      {tab === 'ccof' && <Ccof c={c} />}
      {tab === 'metrc' && <Metrc c={c} />}
      {tab === 'review' && <Review c={c} />}
      {tab === 'settings' && (isAdmin ? <SettingsTab c={c} /> : <div className="list"><h2>Settings</h2><p className="muted">Only Compliance Admins can change Compliance settings.</p></div>)}
    </div>
  )
}

// ---------- Dashboard ----------
function Dashboard({ c }: { c: Ctx }) {
  const { ov } = c
  const [dl, setDl] = useState<Deadline[] | null>(null)
  useEffect(() => { c.api.deadlines().then(setDl).catch(() => setDl([])) }, [])
  const soon = (dl ?? []).filter(d => d.due_on && d.days_left! <= Math.max(d.remind_days, 30)).slice(0, 8)
  const b = ov.backup
  const backupTone = !ov.sp_site ? 'warn' : b?.error || (b?.failed ?? 0) > 0 ? 'bad' : b && (ago(b.started_at) ?? 9) <= 2 ? 'ok' : 'warn'
  return <div className="list">
    <DashHead title="Compliance" sub="METRC, CCOF, licenses and the paper that proves it" />
    <Tiles>
      <Tile value={ov.overdue} label="Late" sub="deadlines past due" tone={ov.overdue ? 'bad' : 'ok'} onClick={() => c.go('deadlines')} />
      <Tile value={ov.due_soon} label="Due soon" sub={`${ov.due_30} in the next 30 days`} tone={ov.due_soon ? 'warn' : undefined} onClick={() => c.go('deadlines')} />
      <Tile value={ov.metrc_todo} label="METRC to do" sub={ov.metrc_error ? `${ov.metrc_error} with a problem` : 'app actions to enter in METRC'} tone={ov.metrc_error ? 'bad' : ov.metrc_todo ? 'warn' : 'ok'} onClick={() => c.go('metrc', 'todo')} />
      <Tile value={ov.errors_open} label="METRC errors" sub={`${ov.playbook} fixes in the playbook`} tone={ov.errors_open ? 'bad' : undefined} onClick={() => c.go('metrc', 'errors')} />
      <Tile value={`${ov.materials_approved}/${ov.materials}`} label="Materials approved" sub={ov.materials_unreviewed ? `${ov.materials_unreviewed} not reviewed yet` : 'all reviewed'} tone={ov.materials_unreviewed ? 'warn' : 'ok'} onClick={() => c.go('ccof', 'materials')} />
      <Tile value={ov.material_issues} label="Log lines not approved" sub="this year, Feed and Spray" tone={ov.material_issues ? 'warn' : 'ok'} onClick={() => c.go('review')} />
      <Tile value={ov.tests_no_file} label="Test results, no file" sub="Production › Testing" tone={ov.tests_no_file ? 'warn' : 'ok'} onClick={() => c.go('review')} />
      <Tile value={ov.customers_missing} label="Customer licenses" sub="missing or expired" tone={ov.customers_missing ? 'warn' : 'ok'} onClick={() => c.go('library', 'customers')} />
      <Tile value={ov.docs} label="Documents" sub={ov.backup_waiting ? `${ov.backup_waiting} waiting for SharePoint` : 'all copied to SharePoint'} onClick={() => c.go('library')} />
      <Tile value={!ov.sp_site ? 'Off' : b ? fmtD(b.started_at) : 'Never'} label="SharePoint backup" sub={!ov.sp_site ? 'not set up yet' : b?.error ?? (b ? `${b.copied} copied, ${b.failed} failed` : 'runs nightly')} tone={backupTone} onClick={c.isAdmin ? () => c.go('settings') : undefined} />
    </Tiles>
    <Cards>
      <Card title="Coming due" badge={soon.length} action="Deadlines" onAction={() => c.go('deadlines')}>
        {dl == null ? <p className="muted">Loading…</p> : !soon.length ? <Empty>Nothing due in the next 30 days.</Empty>
          : <div className="dlist">{soon.map(d => <div key={d.kind + d.ref} className="drow"><span className="grow">{d.title}<div className="muted small">{d.site ?? ''}</div></span>
            <span className="nowrap">{fmtD(d.due_on)} <span className={`pill ${dueTone(d)}`}>{dueText(d)}</span></span></div>)}</div>}
      </Card>
      <Card title="METRC reconciliation" action="Reconcile" onAction={() => c.go('metrc', 'reconcile')}>
        <div className="dlist">{ov.licenses.map(l => { const at = ov.last_recon[l]; const d = ago(at)
          return <div key={l} className="drow"><span className="grow mono">{l}</span><span className={`pill ${d == null ? 'cp-warn' : d > 35 ? 'cp-warn' : 'cp-ok'}`}>{at ? `${fmtD(at)}` : 'never'}</span></div> })}</div>
        <p className="muted small">Upload each license's METRC Active Packages export at least monthly.</p>
      </Card>
      <Card title="Library" action="Open" onAction={() => c.go('library')}>
        <div className="dlist">{c.types.filter(t => (ov.docs_by_type[t.key] ?? 0) > 0).map(t => <div key={t.key} className="drow"><span className="grow">{t.label}</span><b>{ov.docs_by_type[t.key]}</b></div>)}</div>
        {!ov.docs && <Empty>No documents yet. Open the Library and drop files in.</Empty>}
      </Card>
    </Cards>
  </div>
}

// ---------- Review ----------
function Review({ c }: { c: Ctx }) {
  const [dl, setDl] = useState<Deadline[] | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [mats, setMats] = useState<Material[]>([])
  const [tests, setTests] = useState<TestNoFile[]>([])
  const [errs, setErrs] = useState<MError[]>([])
  const [bad, setBad] = useState<{ id: number; title: string; backup_error: string | null }[]>([])
  useEffect(() => {
    c.api.deadlines().then(setDl).catch(() => setDl([]))
    c.api.issues().then(setIssues).catch(() => {})
    c.api.materials().then(setMats).catch(() => {})
    c.api.testsNoFile().then(setTests).catch(() => {})
    c.api.errors().then(e => setErrs(e.filter(x => x.status === 'open'))).catch(() => {})
    c.api.docs().then(ds => setBad(ds.filter(d => d.backup_error))).catch(() => {})
  }, [])
  const late = (dl ?? []).filter(d => d.due_on && d.days_left! < 0)
  const noDate = (dl ?? []).filter(d => !d.due_on)
  // log lines grouped by product
  const byProd = new Map<string, { product: string; module: string; issue: string; n: number; last: string; id: number | null }>()
  for (const i of issues) {
    const k = `${i.module}|${i.product.toLowerCase()}`; const x = byProd.get(k)
    if (x) { x.n++; if (i.log_on > x.last) x.last = i.log_on } else byProd.set(k, { product: i.product, module: i.module, issue: i.issue, n: 1, last: i.log_on, id: i.product_id })
  }
  const prods = [...byProd.values()].sort((a, b) => b.n - a.n)
  const noPaper = mats.filter(m => m.active && m.ccof_status === 'approved' && !m.listing)
  const stale = c.ov.licenses.filter(l => { const d = ago(c.ov.last_recon[l]); return d == null || d > 35 })
  const none = dl != null && !late.length && !noDate.length && !prods.length && !noPaper.length && !tests.length && !errs.length && !stale.length && !bad.length && !c.ov.customers_missing
  return <div className="list">
    <h2>Review</h2>
    {none && <p className="muted">Nothing to look at. Everything's current.</p>}
    {late.length > 0 && <Fold id="comp.late" open title="Late" count={late.length} right={<button className="linkbtn" onClick={() => c.go('deadlines')}>Deadlines ›</button>}>
      <div className="dlist">{late.map(d => <div key={d.kind + d.ref} className="drow"><span className="grow">{d.title}</span><span className={`pill ${dueTone(d)}`}>{dueText(d)}</span></div>)}</div></Fold>}
    {prods.length > 0 && <Fold id="comp.prods" open title="Products used in logs without CCOF approval" count={prods.length} right={<button className="linkbtn" onClick={() => c.go('ccof', 'materials')}>Materials ›</button>}>
      <p className="muted">From this year's Feed and Spray logs. Approve the product (with its listing) or find out why it was used.</p>
      <div className="dlist">{prods.map(p => <div key={p.module + p.product} className="drow"><span className="grow"><b>{p.product}</b> <span className="muted">{p.module === 'nursery' ? 'Nursery' : 'Production'} · {p.issue}</span></span>
        <span className="muted small">{p.n} line{p.n === 1 ? '' : 's'} · last {fmtD(p.last)}</span></div>)}</div></Fold>}
    {tests.length > 0 && <Fold id="comp.tests" open title="Test results with no file" count={tests.length}>
      <p className="muted">Results are back but nobody attached the PDF. Production › Testing › open the test › drop the PDF.</p>
      <div className="dlist">{tests.map(t => <div key={t.id} className="drow"><span className="grow">{t.site} {t.ref} <span className="muted">{t.kind === 'area' ? 'area composite' : 'strain test'}{t.lab ? ` · ${t.lab}` : ''}</span></span>
        <span className="muted small">back {fmtD(t.results_on)}{t.result ? ` · ${t.result}` : ''}</span></div>)}</div></Fold>}
    {errs.length > 0 && <Fold id="comp.errs" open title="Open METRC errors" count={errs.length} right={<button className="linkbtn" onClick={() => c.go('metrc', 'errors')}>Errors ›</button>}>
      <div className="dlist">{errs.map(e => <div key={e.id} className="drow"><span className="grow">{e.what}</span><span className="muted small">{fmtD(e.happened_on)}</span></div>)}</div></Fold>}
    {stale.length > 0 && <Fold id="comp.recon" title="Licenses not reconciled in 35 days" count={stale.length} right={<button className="linkbtn" onClick={() => c.go('metrc', 'reconcile')}>Reconcile ›</button>}>
      <div className="dlist">{stale.map(l => <div key={l} className="drow"><span className="grow mono">{l}</span><span className="muted small">{c.ov.last_recon[l] ? `last ${fmtD(c.ov.last_recon[l])}` : 'never'}</span></div>)}</div></Fold>}
    {c.ov.customers_missing > 0 && <Fold id="comp.cust" title="Customers with no license or an expired one" count={c.ov.customers_missing} right={<button className="linkbtn" onClick={() => c.go('library', 'customers')}>Customer licenses ›</button>}>
      <p className="muted">Sales gets a warning when they start an order for these.</p></Fold>}
    {noDate.length > 0 && <Fold id="comp.nodate" title="Deadlines and licenses with no date" count={noDate.length} right={<button className="linkbtn" onClick={() => c.go('deadlines')}>Deadlines ›</button>}>
      <div className="dlist">{noDate.map(d => <div key={d.kind + d.ref} className="drow"><span className="grow">{d.title}</span></div>)}</div></Fold>}
    {noPaper.length > 0 && <Fold id="comp.nopaper" title="Approved with no listing on file" count={noPaper.length} right={<button className="linkbtn" onClick={() => c.go('ccof', 'materials')}>Materials ›</button>}>
      <div className="dlist">{noPaper.map(m => <div key={m.id} className="drow"><span className="grow">{m.name} <span className="muted">{m.manufacturer ?? ''}</span></span></div>)}</div></Fold>}
    {bad.length > 0 && <Fold id="comp.bk" title="Didn't copy to SharePoint" count={bad.length}>
      <div className="dlist">{bad.map(d => <div key={d.id} className="drow"><span className="grow">{d.title}</span><span className="small neg">{d.backup_error}</span></div>)}</div></Fold>}
  </div>
}

// ---------- Settings ----------
function SettingsTab({ c }: { c: Ctx }) {
  const [ed, setEd] = useState<Partial<DocType> | null>(null)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState<BackupRun[]>([])
  const [site, setSite] = useState(c.ov.sp_site ?? '')
  const [root, setRoot] = useState(c.ov.sp_root ?? 'Compliance Archive')
  const [tol, setTol] = useState<number | null>(Number(c.ov.weight_tol ?? 1))
  const [stale, setStale] = useState<number | null>(Number(c.ov.stale_days ?? 90))
  useEffect(() => { c.api.backupRuns().then(setRuns).catch(() => {}) }, [])
  const sb = c.api.sb
  async function saveType() {
    setBusy(true); try { await c.api.saveDocType(ed!); c.flash('Saved'); setEd(null); await c.reload() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function set(k: string, v: string) { try { await c.api.setSetting(k, v); c.flash('Saved'); await c.reload() } catch (e) { c.flash(errText(e), true) } }
  async function runNow() {
    setBusy(true)
    try { const r = await c.api.runBackup(); c.flash(r.skipped ? `Backup didn't run: ${r.skipped}` : `Backup: ${r.copied ?? 0} copied, ${r.archived ?? 0} archived, ${r.failed ?? 0} failed${r.left_over ? `, ${r.left_over} left for next time` : ''}`, !!(r.skipped || r.failed))
      setRuns(await c.api.backupRuns()); await c.reload() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <div className="list">
    <h2>Compliance settings</h2>
    <Fold id="comp.set.sp" open title="SharePoint backup" right={<button className="ghost small" disabled={busy || !c.ov.sp_site} onClick={runNow}>Run now</button>}>
      <p className="muted">Every night, new and changed files are copied to SharePoint into <b>{root || 'Compliance Archive'} / document type / site / year</b>. The folders are made automatically. Removed documents move to an _Archived folder there and are never deleted.</p>
      <div className="grid2">
        <F label="SharePoint site" hint="e.g. liftedorganicscom.sharepoint.com/sites/LiftedOrganicsCorporate"><TextIn value={site} onChange={v => setSite(v ?? '')} /></F>
        <F label="Top folder"><TextIn value={root} onChange={v => setRoot(v ?? '')} /></F>
      </div>
      <div className="row"><button className="primary" disabled={site === (c.ov.sp_site ?? '') && root === (c.ov.sp_root ?? '')} onClick={async () => { await set('comp.sp_site', site); await set('comp.sp_root', root) }}>Save</button>
        <span className="muted small">Changing these copies everything again into the new place.</span></div>
      {runs.length > 0 && <div className="dlist" style={{ marginTop: 10 }}>{runs.map(r => <div key={r.id} className="drow"><span className="grow">{when(r.started_at)} <span className="muted">{r.started_by ?? ''}</span></span>
        <span className="small">{r.error ? <span className="neg">{r.error}</span> : `${r.copied} copied · ${r.archived} archived · ${r.failed} failed${r.left_over ? ` · ${r.left_over} left` : ''}`}</span></div>)}</div>}
      <div className="setup"><p className="muted small" style={{ marginTop: 10 }}><b>One-time setup (Microsoft 365 admin):</b></p><ol className="small muted">
        <li>Entra admin center › App registrations › the "Freezer Map" app (or a new one) › API permissions › Microsoft Graph › Application permission <b>Sites.Selected</b> › Grant admin consent.</li>
        <li>Give that app <b>write</b> access to just the site above (SharePoint admin or Graph: POST /sites/&#123;site-id&#125;/permissions with role "write").</li>
        <li>Vercel › Settings › Environment Variables: <span className="mono">MS_TENANT_ID</span>, <span className="mono">MS_CLIENT_ID</span>, <span className="mono">MS_CLIENT_SECRET</span> (and <span className="mono">SUPABASE_SERVICE_ROLE_KEY</span>, already there for QuickBooks). Redeploy.</li>
        <li>Fill in the site above, then Run now.</li></ol></div>
    </Fold>
    <Fold id="comp.set.types" title="Document types" count={c.types.length} right={<button className="ghost small" onClick={() => setEd({ active: true, expires: false, sort: 50 })}>+ Add</button>}>
      <p className="muted">Each type is a folder in SharePoint. Types that expire ask for an expiry date when you add a document.</p>
      <div className="dlist">{c.types.map(t => <button key={t.key} className="drow linkrow" onClick={() => setEd(t)}><span className="grow"><b>{t.label}</b> <span className="muted">{t.folder !== t.label ? `folder "${t.folder}"` : ''}{t.expires ? ' · expires' : ''}</span>
        {t.notes && <div className="muted small">{t.notes}</div>}</span>{!t.active && <span className="muted">off</span>}<b>{c.ov.docs_by_type[t.key] ?? 0}</b></button>)}</div>
    </Fold>
    <Fold id="comp.set.recon" title="METRC reconcile">
      <div className="row wrap"><F label="Weight difference allowed (lbs)"><NumIn value={tol} onChange={setTol} /></F><button className="ghost" onClick={() => set('comp.weight_tol', String(tol ?? 1))}>Save</button>
        <F label="Flag packages unchanged for (days)"><NumIn value={stale} onChange={setStale} /></F><button className="ghost" onClick={() => set('comp.stale_days', String(stale ?? 90))}>Save</button></div>
    </Fold>
    <Fold id="comp.set.people" title="People"><ModulePeople sb={sb} module="compliance" flash={c.flash} /></Fold>
    {ed && <Sheet title={ed.key ? ed.label : 'New document type'} onClose={() => setEd(null)}>
      <F label="Name"><TextIn value={ed.label} onChange={v => setEd({ ...ed, label: v ?? '', key: ed.key ?? undefined })} /></F>
      <F label="SharePoint folder" hint="blank = same as the name"><TextIn value={ed.folder} onChange={v => setEd({ ...ed, folder: v ?? '' })} /></F>
      <F label="Order"><NumIn value={ed.sort ?? 50} onChange={v => setEd({ ...ed, sort: v ?? 50 })} /></F>
      <F label="Notes"><TextIn value={ed.notes} onChange={v => setEd({ ...ed, notes: v })} /></F>
      <label className="check"><input type="checkbox" checked={!!ed.expires} onChange={e => setEd({ ...ed, expires: e.target.checked })} /> These expire</label>
      <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> Active</label>
      <SaveBar busy={busy} onSave={() => saveType()} onCancel={() => setEd(null)} disabled={!ed.label?.trim()} />
    </Sheet>}
  </div>
}
