import { Select } from '../combo'
import './pay.css'
import '../cult/cult.css'
import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PayApi, TASK_LABEL, addDays, periodStart } from './api'
import type { Employee, Entry, Period, Summary, Task } from './api'
import { F, NumIn, Pick, Sheet, SaveBar, TextIn, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { CrewList, RatesPanel } from './CrewView'

// Accounting > Payroll: piece pay per bi-weekly period, the way the FL25 Payroll Summary tab laid it out.
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const n2 = (x: number) => (Math.round(x * 100) / 100).toLocaleString()
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const fmt = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString([], { month: '2-digit', day: '2-digit', year: '2-digit' })
const label = (s: string) => `${fmt(s)} - ${fmt(addDays(s, 13))}`
const FARMS = ['GVR', 'OHR'] as const

interface Person { id: number; name: string; payroll_id: string | null; hours: number; cells: Record<string, { pieces: number; amount: number }>; adj: number; total: number }
function people(s: Summary) {
  const m = new Map<number, Person>()
  const get = (id: number, name: string, pid: string | null) => { let p = m.get(id); if (!p) { p = { id, name, payroll_id: pid, hours: 0, cells: {}, adj: 0, total: 0 }; m.set(id, p) } return p }
  for (const l of s.lines) {
    const p = get(l.employee_id, l.name, l.payroll_id), k = `${l.task}|${l.farm ?? '?'}`
    const c = p.cells[k] ?? { pieces: 0, amount: 0 }; c.pieces += l.paid_lbs; c.amount += l.amount; p.cells[k] = c
    p.hours += l.hours; p.total += l.amount
  }
  for (const a of s.adjustments) { const p = get(a.employee_id, a.name, null); p.adj += a.amount; p.total += a.amount }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function PayrollTab({ sb, flash, canEdit, isAdmin }: { sb: SupabaseClient; flash: Flash; canEdit: boolean; isAdmin: boolean }) {
  const api = useMemo(() => new PayApi(sb), [sb])
  const [periods, setPeriods] = useState<Period[] | null>(null)
  const [start, setStart] = useState(() => addDays(periodStart(today()), -14))
  const [s, setS] = useState<Summary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [adj, setAdj] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState<string | null>(null)
  const load = async () => {
    try { const [p, x] = await Promise.all([api.periods(), api.summary(start)]); setPeriods(p); setS(x); setErr(null) } catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { setS(null); load() }, [start])
  const act = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); try { await f(); flash(ok); setSure(null); await load() } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  if (err) return <div className="list"><h2>Payroll</h2><div className="warnbox">Couldn't load payroll. If this is the first time, run 048_piece_rate.sql in Supabase. ({err})</div></div>
  const cur = periodStart(today())
  const opts = [...new Set([cur, addDays(cur, -14), ...(periods ?? []).map(p => p.starts)])].sort().reverse()
  const ps = s ? people(s) : []
  const cols: [Task, string][] = (['buck', 'trim'] as Task[]).flatMap(tk => FARMS.map(f => [tk, f] as [Task, string]))
  const used = cols.filter(([tk, f]) => ps.some(p => p.cells[`${tk}|${f}`]))
  const extra = ps.some(p => Object.keys(p.cells).some(k => k.endsWith('|?')))
  const show: [Task, string][] = [...used, ...(extra ? (['buck', 'trim'] as Task[]).filter(tk => ps.some(p => p.cells[`${tk}|?`])).map(tk => [tk, '?'] as [Task, string]) : [])]
  const total = sum(ps.map(p => p.total))
  const over = addDays(start, 13) < today()
  function csv() {
    const head = ['Name', 'Payroll ID', 'Hours', ...show.flatMap(([tk, f]) => [`${TASK_LABEL[tk]} ${f} pieces (lbs)`, `${TASK_LABEL[tk]} ${f} amount`]), 'Adjustments', 'Total piece pay']
    const lines = ps.map(p => [p.name, p.payroll_id ?? '', n2(p.hours), ...show.flatMap(([tk, f]) => { const c = p.cells[`${tk}|${f}`]; return [c ? c.pieces.toFixed(2) : '', c ? c.amount.toFixed(2) : ''] }), p.adj ? p.adj.toFixed(2) : '', p.total.toFixed(2)])
    const txt = [head, ...lines].map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv' })); a.download = `piece-pay-${start}.csv`; a.click()
  }
  return (
    <div className="list payroll">
      <div className="row between wrap toolbar"><h2>Payroll</h2>
        <Select value={start} onChange={e => setStart(e.target.value)}>{opts.map(o => { const p = periods?.find(x => x.starts === o)
          return <option key={o} value={o}>{label(o)}{o === cur ? ' (now)' : ''}{p?.status === 'closed' ? (p.exported_at ? ' · paid' : ' · closed') : ''}</option> })}</Select></div>
      <p className="muted">Piece pay for bucking and trimming, from what the crew lead logs in Processing › Crew. It goes through regular bi-weekly payroll. Close the period when it's over: the lines lock and that's what goes to payroll.</p>
      {!s ? <p className="muted">Loading…</p> : <>
        <div className="row wrap pay-status">
          {s.status === 'closed'
            ? <span className="pill okp">{s.exported_at ? `Sent to payroll ${new Date(s.exported_at).toLocaleDateString()}` : `Closed ${s.closed_at ? new Date(s.closed_at).toLocaleDateString() : ''}`}{s.closed_by ? ` · ${s.closed_by}` : ''}</span>
            : <span className={`pill ${over ? 'warnp' : ''}`}>{over ? 'Over, not closed yet' : 'Open (still being logged)'}</span>}
          {s.notes && <span className="muted small">{s.notes}</span>}
          <span className="grow" />
          <b>{money(total)}</b><span className="muted">{ps.length} people · {s.days} days logged</span>
        </div>
        {!ps.length ? <p className="muted">No piece work logged in this period.</p> : <div className="cwrap"><table className="ctable paytable">
          <thead>
            <tr><th rowSpan={2}>Name</th><th rowSpan={2} className="num hide-s">Hours</th>{show.map(([tk, f]) => <th key={tk + f} className="num" colSpan={2}>{TASK_LABEL[tk]} {f}</th>)}<th rowSpan={2} className="num">Adj.</th><th rowSpan={2} className="num">Total</th></tr>
            <tr>{show.flatMap(([tk, f]) => [<th key={tk + f + 'p'} className="num">Pieces</th>, <th key={tk + f + 'a'} className="num">Amount</th>])}</tr>
          </thead>
          <tbody>{ps.map(p => <tr key={p.id}><td>{p.name}{!p.payroll_id && <span className="warn-t small"> · no payroll ID</span>}</td><td className="num hide-s">{n2(p.hours)}</td>
            {show.flatMap(([tk, f]) => { const c = p.cells[`${tk}|${f}`]; return [<td key={tk + f + 'p'} className="num">{c ? n2(c.pieces) : ''}</td>, <td key={tk + f + 'a'} className="num">{c ? money(c.amount) : ''}</td>] })}
            <td className="num">{p.adj ? money(p.adj) : ''}</td><td className="num"><b>{money(p.total)}</b></td></tr>)}
            <tr className="total"><td><b>Total</b></td><td className="num hide-s">{n2(sum(ps.map(p => p.hours)))}</td>
              {show.flatMap(([tk, f]) => [<td key={tk + f + 'p'} className="num">{n2(sum(ps.map(p => p.cells[`${tk}|${f}`]?.pieces ?? 0)))}</td>, <td key={tk + f + 'a'} className="num">{money(sum(ps.map(p => p.cells[`${tk}|${f}`]?.amount ?? 0)))}</td>])}
              <td className="num">{money(sum(ps.map(p => p.adj)))}</td><td className="num"><b>{money(total)}</b></td></tr></tbody>
        </table></div>}
        <p className="muted small-note">Pieces = flower lbs on days the person reached the target. GVR / OHR = where the product was grown (cost center).</p>
        {s.adjustments.length > 0 && <><h3 className="csec">Adjustments</h3>
          <div className="dlist">{s.adjustments.map(a => <div key={a.id} className="drow"><span className="grow"><b>{a.name}</b> <span className="muted">{a.reason} · {a.by}</span></span><b>{money(a.amount)}</b>
            {canEdit && !s.exported_at && <button className="ghost small" disabled={busy} onClick={() => act(() => api.removeAdjust(a.id), 'Adjustment removed')}>✕</button>}</div>)}</div></>}
        {canEdit && <div className="row wrap csave">
          {!s.exported_at && <button className="ghost" onClick={() => setAdj(true)}>+ Adjustment</button>}
          <span className="grow" />
          {ps.length > 0 && <button className="ghost" onClick={csv}>Download CSV</button>}
          {s.status === 'open' && over && (sure === 'close'
            ? <><button className="primary" disabled={busy} onClick={() => act(() => api.close(start, ''), 'Period closed')}>Yes, close {label(start)}</button><button className="ghost small" onClick={() => setSure(null)}>Keep open</button></>
            : <button className="primary" onClick={() => setSure('close')}>Close period</button>)}
          {s.status === 'closed' && !s.exported_at && <button className="primary" disabled={busy} onClick={() => act(() => api.exported(start), 'Marked sent to payroll')}>Mark sent to payroll</button>}
          {s.status === 'closed' && isAdmin && (sure === 'reopen'
            ? <><button className="ghost danger" disabled={busy} onClick={() => act(() => api.reopen(start), 'Period reopened')}>Yes, reopen</button><button className="ghost small" onClick={() => setSure(null)}>No</button></>
            : <button className="ghost" onClick={() => setSure('reopen')}>Reopen</button>)}
        </div>}
        <DetailFold api={api} start={start} flash={flash} />
      </>}
      {adj && <AdjSheet api={api} start={start} flash={flash} onClose={() => setAdj(false)} onDone={load} />}
    </div>
  )
}

function DetailFold({ api, start, flash }: { api: PayApi; start: string; flash: Flash }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Entry[] | null>(null)
  useEffect(() => { if (open) { setRows(null); api.entries(start, addDays(start, 13)).then(setRows).catch(e => flash(errText(e), true)) } }, [open, start])
  return <>
    <button className="linkbtn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} every day logged</button>
    {open && (!rows ? <p className="muted">Loading…</p> : <div className="cwrap"><table className="ctable small-t">
      <thead><tr><th>Day</th><th>Name</th><th>Work</th><th>Strain</th><th className="num">Hours</th><th className="num">Lbs</th><th className="num">lbs/hr</th><th className="num">Pay</th></tr></thead>
      <tbody>{rows.map(e => <tr key={e.id}><td className="nowrap">{fmt(e.work_date)}</td><td>{e.employee}</td><td>{TASK_LABEL[e.task]}</td><td>{e.strain} <span className="muted">{e.farm ?? ''}</span></td>
        <td className="num">{n2(e.hours)}</td><td className="num">{n2(e.lbs)}</td><td className={`num ${e.hit ? 'ok-t' : 'muted'}`}>{e.lbs_hr != null ? n2(e.lbs_hr) : ''}</td><td className="num">{money(e.pay)}</td></tr>)}</tbody>
    </table></div>)}
  </>
}

function AdjSheet({ api, start, flash, onClose, onDone }: { api: PayApi; start: string; flash: Flash; onClose: () => void; onDone: () => Promise<void> }) {
  const [emps, setEmps] = useState<Employee[]>([])
  const [emp, setEmp] = useState<number | null>(null)
  const [amt, setAmt] = useState<number | null>(null)
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.employees().then(setEmps).catch(() => {}) }, [])
  async function save() {
    setBusy(true)
    try { await api.adjust(start, emp!, amt!, why); flash('Adjustment added'); await onDone(); onClose() } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  return <Sheet title="Pay adjustment" sub={label(start)} onClose={onClose}>
    <F label="Person"><Pick value={emp} blank="Pick…" options={emps.map(e => ({ v: e.id, l: e.name }))} onChange={setEmp} /></F>
    <F label="Amount" hint="($, negative to take off)"><NumIn value={amt} onChange={setAmt} /></F>
    <F label="Reason"><TextIn value={why} onChange={v => setWhy(v ?? '')} /></F>
    <SaveBar busy={busy} onCancel={onClose} onSave={save} disabled={!emp || !amt || !why.trim()} />
  </Sheet>
}

/** Accounting > Settings > Crew and piece rates */
export function PaySettings({ sb, flash, canEdit, isAdmin }: { sb: SupabaseClient; flash: Flash; canEdit: boolean; isAdmin: boolean }) {
  const api = useMemo(() => new PayApi(sb), [sb])
  const [emps, setEmps] = useState<Employee[] | null>(null)
  const load = async () => { try { setEmps(await api.employees()) } catch (e) { flash(errText(e), true) } }
  useEffect(() => { load() }, [api])
  return <>
    <h3 className="csec">Crew and payroll IDs</h3>
    {emps ? <CrewList api={api} emps={emps} flash={flash} canEdit={canEdit} onChanged={load} payroll /> : <p className="muted">Loading…</p>}
    <h3 className="csec">Piece rates</h3>
    <RatesPanel sb={sb} flash={flash} canEdit={isAdmin} />
  </>
}
