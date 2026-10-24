import { useEffect, useState } from 'react'
import type { Deadline, Doc, ObLog, Obligation } from './api'
import { CATEGORY_LABEL } from './api'
import type { Ctx } from './ctx'
import { DocList, SITES, fmtD, today } from './files'
import { DocSheet } from './library'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, TextIn, errText } from '../cult/ui'

const KIND_LABEL: Record<Deadline['kind'], string> = { obligation: 'Deadline', doc: 'Document', license: 'License', material: 'Material listing', customer: 'Customer license', fleet: 'Vehicle' }
const REPEAT: { v: number; l: string }[] = [{ v: 1, l: 'Every month' }, { v: 3, l: 'Every 3 months' }, { v: 6, l: 'Every 6 months' }, { v: 12, l: 'Every year' }, { v: 24, l: 'Every 2 years' }]
export const dueText = (d: Deadline) => d.due_on == null ? 'needs a date' : d.days_left! < 0 ? `${-d.days_left!} day${d.days_left === -1 ? '' : 's'} late` : d.days_left === 0 ? 'today' : `in ${d.days_left} day${d.days_left === 1 ? '' : 's'}`
export const dueTone = (d: Deadline) => d.due_on == null ? 'cp-warn' : d.days_left! < 0 ? 'cp-bad' : d.days_left! <= d.remind_days ? 'cp-warn' : 'cp-mute'

export function Deadlines({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<Deadline[] | null>(null)
  const [obs, setObs] = useState<(Obligation & { id: number })[]>([])
  const [cat, setCat] = useState<string | null>(null)
  const [site, setSite] = useState<string | null>(null)
  const [edit, setEdit] = useState<Partial<Obligation> | null>(null)
  const [done, setDone] = useState<(Obligation & { id: number }) | null>(null)
  const [doc, setDoc] = useState<Doc | null>(null)
  const [all, setAll] = useState(false)
  const load = async () => { try { const [d, o] = await Promise.all([c.api.deadlines(), c.api.obligations()]); setRows(d); setObs(o) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load() }, [])
  const xs = (rows ?? []).filter(d => (!cat || d.category === cat) && (!site || d.site === site || (site === '-' && !d.site)))
  const groups: [string, Deadline[]][] = [
    ['Late', xs.filter(d => d.due_on && d.days_left! < 0)],
    ['Due soon', xs.filter(d => d.due_on && d.days_left! >= 0 && d.days_left! <= d.remind_days)],
    ['Needs a date', xs.filter(d => !d.due_on && d.kind === 'obligation')],
    ['Coming up', xs.filter(d => d.due_on && d.days_left! > d.remind_days && (all || d.days_left! <= 365))],
  ]
  const noDate = xs.filter(d => !d.due_on && d.kind !== 'obligation')
  async function openRow(d: Deadline) {
    if (d.kind === 'obligation') { const o = obs.find(x => String(x.id) === d.ref); if (o) setEdit(o); return }
    if (d.kind === 'doc') { try { const ds = await c.api.docs(); const x = ds.find(y => String(y.id) === d.ref); if (x) setDoc(x) } catch (e) { c.flash(errText(e), true) } return }
    if (d.kind === 'license') c.go('library', 'licenses')
    else if (d.kind === 'customer') c.go('library', 'customers')
    else if (d.kind === 'material') c.go('ccof', 'materials')
    else if (d.kind === 'fleet') c.go('fleet')
  }
  const cats = [...new Set((rows ?? []).map(d => d.category))].sort()
  return <div className="list">
    <div className="row between wrap toolbar"><h2>Deadlines</h2>{c.canEdit && <button className="primary" onClick={() => setEdit({ category: 'other', remind_days: 30, active: true })}>+ Deadline</button>}</div>
    <p className="muted">Everything that's due, in one list: recurring deadlines, plus anything with an expiry date (documents, our licenses, material listings, customer licenses).</p>
    <div className="row wrap toolbar">
      <div className="chips"><button className={!cat ? 'on' : ''} onClick={() => setCat(null)}>All</button>{cats.map(k => <button key={k} className={cat === k ? 'on' : ''} onClick={() => setCat(cat === k ? null : k)}>{CATEGORY_LABEL[k] ?? k}</button>)}</div>
      <select value={site ?? ''} onChange={e => setSite(e.target.value || null)} aria-label="Site"><option value="">All sites</option><option value="-">Company</option>{SITES.map(s => <option key={s}>{s}</option>)}</select>
    </div>
    {rows == null ? <p className="muted">Loading…</p> : groups.map(([g, ds]) => ds.length > 0 && <div key={g} className="dueg"><h3>{g} <span className="muted">{ds.length}</span></h3>
      <div className="clist">{ds.map(d => <button key={d.kind + d.ref} className="crow" onClick={() => openRow(d)}>
        <span className="grow"><span className="kind">{KIND_LABEL[d.kind]}{d.repeat_months ? ` · ${REPEAT.find(r => r.v === d.repeat_months)?.l.toLowerCase() ?? `every ${d.repeat_months} mo`}` : ''}</span>
          <div className="t">{d.title}</div><div className="muted small">{[CATEGORY_LABEL[d.category] ?? d.category, d.site, d.owner_email?.split('@')[0]].filter(Boolean).join(' · ')}</div></span>
        <span className="nowrap" style={{ textAlign: 'right' }}><div>{d.due_on ? fmtD(d.due_on) : ''}</div><span className={`pill ${dueTone(d)}`}>{dueText(d)}</span></span>
      </button>)}</div></div>)}
    {rows != null && !all && xs.some(d => d.due_on && d.days_left! > 365) && <button className="linkbtn" onClick={() => setAll(true)}>Show everything more than a year out ›</button>}
    {noDate.length > 0 && <div className="dueg"><h3>Licenses with no expiry date <span className="muted">{noDate.length}</span></h3>
      <div className="clist">{noDate.map(d => <button key={d.kind + d.ref} className="crow" onClick={() => openRow(d)}><span className="grow">{d.title}</span><span className="pill cp-warn">set a date</span></button>)}</div></div>}
    {edit && <ObSheet c={c} o={edit} onClose={() => setEdit(null)} onDone={o => { setEdit(null); setDone(o) }} onSaved={async () => { setEdit(null); await load(); await c.reload() }} />}
    {done && <DoneSheet c={c} o={done} onClose={() => setDone(null)} onSaved={async () => { setDone(null); await load(); await c.reload() }} />}
    {doc && <DocSheet c={c} d={doc} onClose={() => setDoc(null)} onChanged={async () => { await load(); await c.reload() }} />}
  </div>
}

function ObSheet({ c, o, onClose, onSaved, onDone }: { c: Ctx; o: Partial<Obligation>; onClose: () => void; onSaved: () => Promise<void>; onDone: (o: Obligation & { id: number }) => void }) {
  const [x, setX] = useState(o)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<ObLog[]>([])
  useEffect(() => { if (o.id) c.api.obLog(o.id).then(setLog).catch(() => {}) }, [o.id])
  const set = (v: Partial<Obligation>) => setX(s => ({ ...s, ...v }))
  async function save() { setBusy(true); try { await c.api.saveObligation(x); c.flash('Saved'); await onSaved() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) } }
  async function del() {
    if (!confirm('Delete this deadline and its history?')) return
    setBusy(true); try { await c.api.deleteObligation(o.id!); c.flash('Deleted'); await onSaved() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const ro = !c.canEdit
  return <Sheet title={o.id ? o.title : 'New deadline'} onClose={onClose}>
    {o.id && c.canEdit && x.active !== false && <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => onDone(o as Obligation & { id: number })}>Mark done</button>
      <span className="muted small">{o.repeat_months ? 'The next due date is set automatically.' : 'One-time: it comes off the list.'}</span></div>}
    <F label="What's due"><TextIn value={x.title} onChange={v => set({ title: v ?? '' })} autoFocus={!o.id} /></F>
    <div className="grid2">
      <F label="Due"><DateIn value={x.due_on} onChange={v => set({ due_on: v })} /></F>
      <F label="Repeats"><Pick value={x.repeat_months ?? null} blank="One time" options={REPEAT} onChange={v => set({ repeat_months: v })} /></F>
      <F label="Category"><Pick value={x.category ?? 'other'} options={Object.entries(CATEGORY_LABEL).map(([v, l]) => ({ v, l }))} onChange={v => set({ category: v ?? 'other' })} /></F>
      <F label="Site"><Pick value={x.site ?? null} blank="Company (all sites)" options={SITES.map(s => ({ v: s, l: s }))} onChange={v => set({ site: v })} /></F>
      <F label="Warn" hint="days ahead"><NumIn value={x.remind_days ?? 30} onChange={v => set({ remind_days: v ?? 30 })} /></F>
      <F label="Files go under"><Pick value={x.doc_type ?? null} blank="—" options={c.types.map(t => ({ v: t.key, l: t.label }))} onChange={v => set({ doc_type: v })} /></F>
    </div>
    <F label="Owner" hint="email"><TextIn value={x.owner_email} onChange={v => set({ owner_email: v })} placeholder="name@lifted-organics.com" /></F>
    <F label="Notes"><textarea value={x.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
    {o.id && <label className="check"><input type="checkbox" checked={x.active !== false} onChange={e => set({ active: e.target.checked })} /> On the list</label>}
    {log.length > 0 && <><h3>Done before</h3><div className="dlist">{log.map(l => <div key={l.id} className="drow"><span className="grow">{fmtD(l.done_on)} <span className="muted">by {l.done_by?.split('@')[0]}{l.due_on ? ` (was due ${fmtD(l.due_on)})` : ''}</span>{l.note && <div className="small">{l.note}</div>}</span></div>)}</div></>}
    {o.id && <DocList api={c.api} kind="obligation" refId={o.id} docType={x.doc_type ?? 'reports'} flash={c.flash} canAdd={c.canEdit} title="Files" empty="Filings, confirmations and receipts for this deadline go here." />}
    {!ro && <SaveBar busy={busy} onSave={save} onCancel={onClose} onDelete={o.id && c.isAdmin ? del : undefined} disabled={!x.title?.trim()} />}
  </Sheet>
}

function DoneSheet({ c, o, onClose, onSaved }: { c: Ctx; o: Obligation & { id: number }; onClose: () => void; onSaved: () => Promise<void> }) {
  const [when, setWhen] = useState<string | null>(today())
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { const nxt = await c.api.doneObligation(o.id, when ?? today(), note, null); c.flash(nxt ? `Done. Next due ${fmtD(nxt)}` : 'Done'); await onSaved() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title={`Done: ${o.title}`} onClose={onClose}>
    <div className="grid2"><F label="Done on"><DateIn value={when} onChange={setWhen} /></F></div>
    <F label="Note" hint="confirmation #, who you talked to…"><TextIn value={note} onChange={setNote} /></F>
    <DocList api={c.api} kind="obligation" refId={o.id} docType={o.doc_type ?? 'reports'} flash={c.flash} title="Proof (optional)" empty="Drop the filing or confirmation here." />
    <SaveBar busy={busy} onSave={save} onCancel={onClose} saveLabel="Mark done" />
  </Sheet>
}
