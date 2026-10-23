import './pay.css'
import '../cult/cult.css'
import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PayApi, TASK_LABEL, addDays, payOf, periodStart, rateOn } from './api'
import type { DayRow, Employee, Entry, Rate, Task } from './api'
import { t } from '../i18n'
import { DateIn, F, NumIn, Pick, Sheet, SaveBar, StrainList, TextIn, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'

// Processing > Crew: the crew lead logs each person's day (phone first, English / Español), productivity, the crew list.

export interface RunLite { id: number; code: string; kind: Task; strain: string | null; status: string; started_on: string; finished_on: string | null; output_lbs: number | null }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const n0 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : Math.round(x).toLocaleString())
const n2 = (x: number | null | undefined) => (x == null || !isFinite(x) ? '' : (Math.round(x * 100) / 100).toLocaleString())
const money = (x: number) => `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const fmtD = (iso: string | null | undefined) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '')
const flowerLabel = (task: Task) => (task === 'buck' ? t('Bucked lbs') : t('Flower lbs'))

export function CrewTab({ sb, runs, flash, canEdit, strainNames }: { sb: SupabaseClient; runs: RunLite[]; flash: Flash; canEdit: boolean; strainNames: string[] }) {
  const api = useMemo(() => new PayApi(sb), [sb])
  const [sec, setSec] = useState<'day' | 'prod' | 'crew'>('day')
  const [emps, setEmps] = useState<Employee[] | null>(null)
  const [rates, setRates] = useState<Rate[]>([])
  const [err, setErr] = useState<string | null>(null)
  const load = async () => { try { const [e, r] = await Promise.all([api.employees(), api.rates()]); setEmps(e); setRates(r); setErr(null) } catch (e) { setErr(errText(e)) } }
  useEffect(() => { load() }, [api])
  if (err) return <div className="list"><h2>{t('Crew')}</h2><div className="warnbox">{t("Couldn't load the crew.")} {t('If this is the first time, run 048_piece_rate.sql in Supabase.')} ({err})</div></div>
  if (!emps) return <div className="list"><h2>{t('Crew')}</h2><p className="muted">{t('Loading…')}</p></div>
  return (
    <div className="list crew">
      <h2>{t('Crew')}</h2>
      <div className="seg">{([['day', t('Log a day')], ['prod', t('Productivity')], ['crew', t('Crew list')]] as const).map(([k, l]) => <button key={k} className={sec === k ? 'on' : ''} onClick={() => setSec(k)}>{l}</button>)}</div>
      {sec === 'day' && <DayLog api={api} emps={emps} rates={rates} runs={runs} flash={flash} canEdit={canEdit} strainNames={strainNames} onCrew={load} />}
      {sec === 'prod' && <Productivity api={api} flash={flash} />}
      {sec === 'crew' && <CrewList api={api} emps={emps} flash={flash} canEdit={canEdit} onChanged={load} />}
    </div>
  )
}

// ---------- log a day ----------
interface Row extends DayRow { key: number; fresh?: boolean }
let K = 1

function DayLog({ api, emps, rates, runs, flash, canEdit, strainNames, onCrew }: {
  api: PayApi; emps: Employee[]; rates: Rate[]; runs: RunLite[]; flash: Flash; canEdit: boolean; strainNames: string[]; onCrew: () => Promise<void>
}) {
  const [date, setDate] = useState(today())
  const [task, setTask] = useState<Task>('trim')
  const [run, setRun] = useState<number | null>(null)
  const [strain, setStrain] = useState<string | null>(null)
  const [farm, setFarm] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [day, setDay] = useState<Entry[]>([])
  const [recent, setRecent] = useState<Entry[]>([])
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const live = runs.filter(r => r.kind === task && (r.status === 'open' || (r.finished_on && r.finished_on >= addDays(date, -10))))
  const rate = rateOn(rates, task, date)
  const sameLot = (e: Entry) => e.task === task && (run ? e.run_id === run : !e.run_id && (e.strain ?? '').toLowerCase() === (strain ?? '').toLowerCase())
  const loadDay = async () => {
    try {
      const [d, rc] = await Promise.all([api.entries(date, date), api.entries(addDays(today(), -14), today())])
      setDay(d); setRecent(rc)
    } catch (e) { flash(errText(e), true) }
  }
  useEffect(() => { loadDay() }, [date])
  useEffect(() => { if (!run && live.length === 1 && live[0].status === 'open') setRun(live[0].id) }, [task, runs.length])
  // the rows already saved for this day and lot
  useEffect(() => {
    const mine = day.filter(sameLot)
    setRows(mine.map(e => ({ key: K++, id: e.id, employee_id: e.employee_id, lbs: e.lbs, mold: e.mold, smalls: e.smalls, trim: e.trim, hours: e.hours, note: e.note })))
    if (!run && mine[0]) setFarm(mine[0].farm)
  }, [day, task, run])  // not on strain: typing it shouldn't wipe the rows
  const set = (k: number, p: Partial<Row>) => setRows(rs => rs.map(r => (r.key === k ? { ...r, ...p } : r)))
  const used = new Set(rows.filter(r => !r.delete).map(r => r.employee_id))
  const addWorker = (id: number | null) => { if (id) setRows(rs => [...rs, { key: K++, employee_id: id, lbs: null, mold: null, smalls: null, trim: null, hours: rs.find(r => !r.delete && r.hours)?.hours ?? null, fresh: true }]) }
  async function addNew() {
    if (!newName.trim()) return
    try { const e = await api.saveEmployee({ name: newName }); await onCrew(); addWorker(e.id); setNewName('') } catch (e) { flash(errText(e), true) }
  }
  const shown = rows.filter(r => !r.delete)
  const calc = (r: Row) => payOf(r.lbs ?? 0, r.hours ?? 0, rate)
  const tot = { lbs: sum(shown.map(r => r.lbs ?? 0)), mold: sum(shown.map(r => r.mold ?? 0)), smalls: sum(shown.map(r => r.smalls ?? 0)), trim: sum(shown.map(r => r.trim ?? 0)),
    hours: sum(shown.map(r => r.hours ?? 0)), pay: sum(shown.map(r => calc(r).pay)) }
  const runRow = runs.find(r => r.id === run)
  async function save() {
    if (shown.some(r => !(r.hours! > 0))) { flash(t('Everyone needs hours'), true); return }
    setBusy(true)
    try {
      const n = await api.saveDay(date, task, run, run ? null : strain, run ? null : farm, rows.map(r => ({ id: r.id ?? null, employee_id: r.employee_id, lbs: r.lbs, mold: r.mold, smalls: r.smalls, trim: r.trim, hours: r.hours, note: r.note ?? null, delete: r.delete })))
      flash(t('{n} saved', { n })); await loadDay()
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  // recent days, one line per day + lot
  const lots = new Map<string, { date: string; task: Task; run: number | null; strain: string | null; people: Set<number>; lbs: number; pay: number }>()
  for (const e of recent) {
    const k = `${e.work_date}|${e.task}|${e.run_id ?? e.strain}`
    const x = lots.get(k) ?? { date: e.work_date, task: e.task, run: e.run_id, strain: e.strain, people: new Set(), lbs: 0, pay: 0 }
    x.people.add(e.employee_id); x.lbs += e.lbs; x.pay += e.pay; lots.set(k, x)
  }
  return <>
    <div className="crew-top">
      <F label={t('Day')}><DateIn value={date} onChange={v => v && setDate(v)} /></F>
      <div className="seg">{(['buck', 'trim'] as Task[]).map(k => <button key={k} className={task === k ? 'on' : ''} onClick={() => { setTask(k); setRun(null) }}>{t(TASK_LABEL[k])}</button>)}</div>
    </div>
    <F label={t('Processing run')} hint={live.length ? '' : t('(none open: pick the strain)')}>
      <Pick value={run} blank={t('No run (pick the strain)')} options={live.map(r => ({ v: r.id, l: `${r.code} · ${r.strain ?? ''}${r.status === 'done' ? ` · ${t('done')}` : ''}` }))} onChange={setRun} />
    </F>
    {!run && <div className="grid2">
      <F label={t('Strain')}><StrainList id="crew-strains" names={strainNames} /><TextIn list="crew-strains" value={strain} onChange={setStrain} /></F>
      <F label={t('Grown at')}><Pick value={farm} blank="?" options={[{ v: 'OHR', l: 'OHR' }, { v: 'GVR', l: 'GVR' }]} onChange={setFarm} /></F>
    </div>}
    {rate ? <p className="muted small-note">{t('{task}: ${rate}/lb when someone does {target} lbs/hr or more that day. Under that, no piece pay.', { task: t(TASK_LABEL[task]), rate: rate.rate.toFixed(2), target: rate.target })}</p>
      : <p className="warn-t small-note">{t('No piece rate set for this day.')}</p>}

    <div className="crew-rows">
      {shown.map(r => { const c = calc(r)
        return <div key={r.key} className={`crew-row ${c.hit ? 'crew-ok' : r.hours && r.lbs ? 'crew-under' : ''}`}>
          <div className="row between">
            <select value={r.employee_id ?? ''} onChange={e => set(r.key, { employee_id: Number(e.target.value) })}>
              {emps.filter(e => e.active || e.id === r.employee_id).map(e => <option key={e.id} value={e.id} disabled={e.id !== r.employee_id && used.has(e.id)}>{e.name}</option>)}</select>
            <span className="crew-pay">{r.hours && r.lbs != null ? <>{n2(c.lph)} {t('lbs/hr')} {c.hit ? '✓' : '✗'} · <b>{money(c.pay)}</b></> : ''}</span>
            {canEdit && <button className="ghost small" aria-label={t('Remove')} onClick={() => r.id ? set(r.key, { delete: true }) : setRows(rs => rs.filter(x => x.key !== r.key))}>✕</button>}
          </div>
          <div className={`crew-nums ${task}`}>
            <label>{t('Hours')}<NumIn value={r.hours} onChange={v => set(r.key, { hours: v })} /></label>
            <label>{flowerLabel(task)}<NumIn value={r.lbs} onChange={v => set(r.key, { lbs: v })} /></label>
            <label>{t('Mold')}<NumIn value={r.mold} onChange={v => set(r.key, { mold: v })} /></label>
            {task === 'trim' && <label>{t('Smalls')}<NumIn value={r.smalls} onChange={v => set(r.key, { smalls: v })} /></label>}
            <label>{t('Trim')}<NumIn value={r.trim} onChange={v => set(r.key, { trim: v })} /></label>
          </div>
        </div> })}
      {!shown.length && <p className="muted">{t('Nobody logged yet for this day. Add the people who worked.')}</p>}
    </div>
    {canEdit && <div className="row wrap crew-add">
      <Pick value={null} blank={t('+ Add a person…')} options={emps.filter(e => e.active && !used.has(e.id)).map(e => ({ v: e.id, l: e.name }))} onChange={addWorker} />
      <input value={newName} placeholder={t('New person (name)')} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addNew() }} />
      <button className="ghost small" disabled={!newName.trim()} onClick={addNew}>{t('Add')}</button>
      {shown.length > 1 && shown[0].hours ? <button className="ghost small" onClick={() => setRows(rs => rs.map(r => ({ ...r, hours: shown[0].hours })))}>{t('Same hours for everyone')}</button> : null}
    </div>}
    {shown.length > 0 && <div className="ckpis">
      <div><b>{n2(tot.lbs)}</b><span>{flowerLabel(task)}</span></div><div><b>{n2(tot.mold)}</b><span>{t('Mold')}</span></div>
      {task === 'trim' && <div><b>{n2(tot.smalls)}</b><span>{t('Smalls')}</span></div>}<div><b>{n2(tot.trim)}</b><span>{t('Trim')}</span></div>
      <div><b>{n2(tot.hours)}</b><span>{t('Hours')}</span></div><div><b>{money(tot.pay)}</b><span>{t('Piece pay')}</span></div>
    </div>}
    {runRow?.status === 'done' && runRow.output_lbs != null && <p className="muted small-note">{t('{run} came out at {out} lbs. The crew logged {crew} lbs (with mold, smalls and trim) on this day.', { run: runRow.code, out: n0(runRow.output_lbs), crew: n2(tot.lbs + tot.mold + tot.smalls + tot.trim) })}</p>}
    {canEdit && <div className="row between csave"><span className="muted small">{fmtD(date)}</span><button className="primary" disabled={busy || (!run && !strain) || (!shown.length && !rows.some(r => r.delete))} onClick={save}>{busy ? t('Saving…') : t('Save the day')}</button></div>}

    <h3 className="csec">{t('Last 2 weeks')}</h3>
    {lots.size ? <div className="dlist">{[...lots.values()].sort((a, b) => b.date.localeCompare(a.date)).map(x =>
      <button key={`${x.date}${x.task}${x.run ?? x.strain}`} className="drow linkrow" onClick={() => { setDate(x.date); setTask(x.task); setRun(x.run); setStrain(x.run ? null : x.strain) }}>
        <span className="grow"><b>{fmtD(x.date)}</b> {t(TASK_LABEL[x.task])} · {x.run ? runs.find(r => r.id === x.run)?.code ?? '' : ''} {x.strain}</span>
        <span className="muted">{x.people.size} {t('people')}</span><b>{n2(x.lbs)} lbs</b><span>{money(x.pay)}</span></button>)}</div>
      : <p className="muted">{t('Nothing logged in the last 2 weeks.')}</p>}
  </>
}

// ---------- productivity ----------
function Productivity({ api, flash }: { api: PayApi; flash: Flash }) {
  const per = periodStart(today())
  const RANGES: [string, string, string][] = [
    [t('This pay period'), per, addDays(per, 13)], [t('Last pay period'), addDays(per, -14), addDays(per, -1)],
    [t('Last 90 days'), addDays(today(), -90), today()], [t('FL25 season'), '2025-08-01', '2026-07-31'], [t('FL26 season'), '2026-08-01', '2027-07-31']]
  const [rg, setRg] = useState(0)
  const [task, setTask] = useState<Task>('trim')
  const [rows, setRows] = useState<Entry[] | null>(null)
  useEffect(() => { setRows(null); api.entries(RANGES[rg][1], RANGES[rg][2]).then(setRows).catch(e => flash(errText(e), true)) }, [rg])
  const es = (rows ?? []).filter(e => e.task === task)
  const by = <K,>(key: (e: Entry) => K) => { const m = new Map<K, Entry[]>(); for (const e of es) m.set(key(e), [...(m.get(key(e)) ?? []), e]); return m }
  const people = [...by(e => e.employee).entries()].map(([name, xs]) => ({ name, days: new Set(xs.map(x => x.work_date)).size, n: xs.length, hit: xs.filter(x => x.hit).length,
    hours: sum(xs.map(x => x.hours)), lbs: sum(xs.map(x => x.lbs)), mold: sum(xs.map(x => x.mold)), pay: sum(xs.map(x => x.pay)) })).sort((a, b) => b.lbs / (b.hours || 1) - a.lbs / (a.hours || 1))
  const strains = [...by(e => `${e.strain ?? '?'}|${e.crop_year ?? ''}`).entries()].map(([k, xs]) => ({ k, strain: k.split('|')[0], year: k.split('|')[1], hours: sum(xs.map(x => x.hours)),
    lbs: sum(xs.map(x => x.lbs)), mold: sum(xs.map(x => x.mold)), smalls: sum(xs.map(x => x.smalls)), trim: sum(xs.map(x => x.trim)), pay: sum(xs.map(x => x.pay)) })).sort((a, b) => b.lbs - a.lbs)
  const T = { hours: sum(es.map(x => x.hours)), lbs: sum(es.map(x => x.lbs)), pay: sum(es.map(x => x.pay)), hit: es.filter(x => x.hit).length }
  return <>
    <div className="row wrap toolbar">
      <div className="seg wrap">{RANGES.map(([l], i) => <button key={l} className={rg === i ? 'on' : ''} onClick={() => setRg(i)}>{l}</button>)}</div>
      <div className="seg">{(['buck', 'trim'] as Task[]).map(k => <button key={k} className={task === k ? 'on' : ''} onClick={() => setTask(k)}>{t(TASK_LABEL[k])}</button>)}</div>
    </div>
    {!rows ? <p className="muted">{t('Loading…')}</p> : !es.length ? <p className="muted">{t('Nothing logged in this range.')}</p> : <>
      <div className="ckpis">
        <div><b>{n0(T.lbs)}</b><span>{flowerLabel(task)}</span></div><div><b>{n0(T.hours)}</b><span>{t('Hours')}</span></div>
        <div><b>{n2(T.lbs / (T.hours || 1))}</b><span>{t('lbs/hr')}</span></div><div><b>{Math.round((T.hit / es.length) * 100)}%</b><span>{t('days at target')}</span></div>
        <div><b>{money(T.pay)}</b><span>{t('Piece pay')}</span></div><div><b>{T.lbs ? money(T.pay / T.lbs) : ''}</b><span>{t('per lb')}</span></div>
      </div>
      <h3 className="csec">{t('By person')}</h3>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>{t('Name')}</th><th className="num">{t('Days')}</th><th className="num">{t('Hours')}</th><th className="num">{t('Lbs')}</th><th className="num">{t('lbs/hr')}</th><th className="num">{t('At target')}</th><th className="num hide-s">{t('Mold')}</th><th className="num">{t('Pay')}</th></tr></thead>
        <tbody>{people.map(p => <tr key={p.name}><td>{p.name}</td><td className="num">{p.days}</td><td className="num">{n2(p.hours)}</td><td className="num">{n2(p.lbs)}</td>
          <td className="num"><b>{n2(p.lbs / (p.hours || 1))}</b></td><td className="num">{Math.round((p.hit / p.n) * 100)}%</td><td className="num hide-s">{n2(p.mold)}</td><td className="num">{money(p.pay)}</td></tr>)}</tbody>
      </table></div>
      <h3 className="csec">{t('By strain')} <span className="muted">{t('labor cost per lb')}</span></h3>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>{t('Strain')}</th><th className="num">{t('Hours')}</th><th className="num">{flowerLabel(task)}</th><th className="num">{t('Mold')}</th>{task === 'trim' && <th className="num">{t('Smalls')}</th>}<th className="num">{t('Trim')}</th><th className="num">{t('Pay')}</th><th className="num">{t('$/lb')}</th></tr></thead>
        <tbody>{strains.map(s => <tr key={s.k}><td>{s.strain} <span className="muted">{s.year}</span></td><td className="num">{n0(s.hours)}</td><td className="num">{n2(s.lbs)}</td><td className="num">{n2(s.mold)}</td>
          {task === 'trim' && <td className="num">{n2(s.smalls)}</td>}<td className="num">{n2(s.trim)}</td><td className="num">{money(s.pay)}</td><td className="num"><b>{s.lbs ? money(s.pay / s.lbs) : ''}</b></td></tr>)}</tbody>
      </table></div>
    </>}
  </>
}

// ---------- crew list (also in Accounting > Settings, with payroll IDs) ----------
export function CrewList({ api, emps, flash, canEdit, onChanged, payroll }: { api: PayApi; emps: Employee[]; flash: Flash; canEdit: boolean; onChanged: () => Promise<void>; payroll?: boolean }) {
  const [ed, setEd] = useState<Partial<Employee> | null>(null)
  const [busy, setBusy] = useState(false)
  const [all, setAll] = useState(false)
  async function save() {
    setBusy(true)
    try { await api.saveEmployee(ed!); flash(t('Saved')); await onChanged(); setEd(null) } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const list = emps.filter(e => all || e.active)
  return <>
    <div className="row between toolbar">
      <label className="check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> {t('Show people who left')}</label>
      {canEdit && <button className="primary small" onClick={() => setEd({ active: true })}>{t('+ Person')}</button>}
    </div>
    <div className="dlist">{list.map(e => <button key={e.id} className="drow linkrow" disabled={!canEdit} onClick={() => setEd(e)}>
      <span className="grow">{e.name}{!e.active && <span className="muted"> · {t('left')}</span>}</span>{payroll && <span className={e.payroll_id ? 'muted mono' : 'warn-t small'}>{e.payroll_id ?? t('no payroll ID')}</span>}</button>)}</div>
    {ed && <Sheet title={ed.id ? ed.name : t('New person')} onClose={() => setEd(null)}>
      <F label={t('Name')}><TextIn value={ed.name} onChange={v => setEd({ ...ed, name: v ?? '' })} /></F>
      {payroll && <F label={t('Payroll ID')} hint={t('(as in the payroll system)')}><TextIn value={ed.payroll_id} onChange={v => setEd({ ...ed, payroll_id: v })} /></F>}
      <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> {t('Still on the crew')}</label>
      <SaveBar busy={busy} onCancel={() => setEd(null)} onSave={save} disabled={!ed.name?.trim()} />
    </Sheet>}
  </>
}

/** piece rates with start dates (Accounting / Processing Admins) */
export function RatesPanel({ sb, flash, canEdit }: { sb: SupabaseClient; flash: Flash; canEdit: boolean }) {
  const api = useMemo(() => new PayApi(sb), [sb])
  const [rates, setRates] = useState<Rate[] | null>(null)
  const [ed, setEd] = useState<{ task: Task; rate: number | null; target: number | null; from: string | null; notes: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.rates().then(setRates).catch(e => flash(errText(e), true))
  useEffect(() => { load() }, [api])
  async function save() {
    setBusy(true)
    try { await api.saveRate(ed!.task, ed!.rate!, ed!.target!, ed!.from!, ed!.notes); flash(t('Saved')); await load(); setEd(null) } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  return <>
    <p className="muted">{t('Piece pay = every flower lb x the rate, on days someone reaches the target lbs per hour. A new rate starts on its date; older days keep the old rate.')}</p>
    <div className="dlist">{(rates ?? []).map(r => <div key={r.id} className="drow"><span className="grow"><b>{t(TASK_LABEL[r.task])}</b> {money(r.rate)}/lb · {t('target')} {r.target} lbs/hr</span><span className="muted">{t('from')} {r.effective_from}</span></div>)}</div>
    {canEdit && <button className="ghost small" onClick={() => setEd({ task: 'trim', rate: null, target: null, from: today(), notes: '' })}>{t('+ New rate')}</button>}
    {ed && <Sheet title={t('New piece rate')} onClose={() => setEd(null)}>
      <F label={t('Work')}><Pick value={ed.task} options={(['buck', 'trim'] as Task[]).map(k => ({ v: k, l: t(TASK_LABEL[k]) }))} onChange={v => setEd({ ...ed, task: v ?? 'trim' })} /></F>
      <div className="grid2"><F label={t('$ per lb')}><NumIn value={ed.rate} onChange={v => setEd({ ...ed, rate: v })} /></F><F label={t('Target lbs/hr')}><NumIn value={ed.target} onChange={v => setEd({ ...ed, target: v })} /></F></div>
      <F label={t('Starts')}><DateIn value={ed.from} onChange={v => setEd({ ...ed, from: v })} /></F>
      <F label={t('Note')}><TextIn value={ed.notes} onChange={v => setEd({ ...ed, notes: v ?? '' })} /></F>
      <SaveBar busy={busy} onCancel={() => setEd(null)} onSave={save} disabled={ed.rate == null || ed.target == null || !ed.from} />
    </Sheet>}
  </>
}
