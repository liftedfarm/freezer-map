import { useState } from 'react'
import type { CultApi } from './api'
import { DAY_LONG, fieldName, fmtD, testRows, today } from './calc'
import type { Ctx, TestRow } from './calc'
import type { CTest, CultData, Protocol } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, TextIn, errText } from './ui'
import type { Flash } from './ui'

const stCls = (s: string) => `tstat t-${s.split(/[\s-]/)[0]}`

export function TestingTab({ d, c, site, api, flash, onSaved }: { d: CultData; c: Ctx; site: string | null; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [edit, setEdit] = useState<TestRow | null>(null)
  const [proto, setProto] = useState<Protocol | null>(null)
  const { area, strain } = testRows(d, c)
  const A = area.filter(r => !site || r.site === site), S = strain.filter(r => !site || r.site === site)
  const now = today()
  // upcoming sampling trips
  const trips = new Map<string, { area: number; strain: number }>()
  for (const r of [...A, ...S]) {
    if (!r.suggested || r.test?.submitted_on || r.test?.result || ['Results received', 'Harvest started', 'No harvest scheduled'].includes(r.status)) continue
    const day = r.suggested < now ? now : r.suggested
    const t = trips.get(day) ?? trips.set(day, { area: 0, strain: 0 }).get(day)!
    t[r.kind]++
  }
  const urgent = [...A, ...S].filter(r => r.status === 'ORDER NOW' || r.status === 'Window passed - sample ASAP')

  async function setDay(v: number) {
    try { await api.setSetting('cult.sample_weekday', String(v)); await onSaved(`Sampling day: ${DAY_LONG[v]}`) } catch (e) { flash(errText(e), true) }
  }

  const row = (r: TestRow) => (
    <tr key={r.key} className="tap" onClick={() => setEdit(r)}>
      <td><span className="fpill">{r.site} {fieldName(c, r.field_id)}</span>{r.kind === 'strain' && <div>{r.strain}</div>}</td>
      {r.kind === 'area' && <td className="small">{r.composite}</td>}
      <td className="nowrap">{fmtD(r.first, true)}</td>
      <td className="nowrap hide-s">{fmtD(r.opens)} – {fmtD(r.closes)}</td>
      <td className="nowrap"><b>{fmtD(r.suggested, true)}</b></td>
      <td><span className={stCls(r.status)}>{r.status}</span></td>
      <td className="small hide-s">{r.test?.lab ?? ''}{r.test?.test_ref ? <div className="muted">{r.test.test_ref}</div> : null}</td>
      <td className="nowrap small">{r.test?.submitted_on ? `sent ${fmtD(r.test.submitted_on)}` : ''}{r.test?.results_on ? <div>back {fmtD(r.test.results_on)}</div> : null}</td>
      <td><b className={/fail/i.test(r.test?.result ?? '') ? 'neg' : /pass/i.test(r.test?.result ?? '') ? 'pos' : ''}>{r.test?.result ?? ''}</b></td>
    </tr>
  )

  return (
    <>
      <div className="row toolbar">
        <span className="muted">Sampling day</span>
        <Pick value={d.settings.sampleWeekday} onChange={v => v && setDay(v)} options={[1, 2, 3, 4, 5, 6, 7].map(i => ({ v: i, l: DAY_LONG[i] }))} />
        <span className="muted">Suggested sample date = the last {DAY_LONG[d.settings.sampleWeekday]} inside each window, so everything due that week goes on one trip.</span>
      </div>
      {urgent.length > 0 && <div className="warnbox">{urgent.length} test{urgent.length === 1 ? '' : 's'} to sample now: {urgent.map(r => r.kind === 'area' ? `${r.site} ${fieldName(c, r.field_id)}` : `${r.strain} (${r.site} ${fieldName(c, r.field_id)})`).join(', ')}</div>}

      <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>Protocol</th><th>Per</th><th className="num">Window</th><th>Tests to order</th></tr></thead>
        <tbody>{[...d.protocols].sort((a, b) => a.kind.localeCompare(b.kind)).map(p => (
          <tr key={p.kind} className="tap" onClick={() => setProto(p)}><td><b>{p.label}</b></td><td>{p.per} · {p.sample}</td>
            <td className="num">{p.opens_days}–{p.closes_days} days before</td><td className="small">{p.tests}</td></tr>))}
        </tbody>
      </table></div>

      {trips.size > 0 && <>
        <h3 className="csec">Sampling trips coming up</h3>
        <div className="cwrap tight"><table className="ctable">
          <thead><tr><th>Day</th><th className="num">Area composites</th><th className="num">Dry flower strains</th><th className="num">Total samples</th></tr></thead>
          <tbody>{[...trips.entries()].sort().map(([day, t]) => <tr key={day}><td>{fmtD(day, true)}{day === now ? ' (today)' : ''}</td><td className="num">{t.area}</td><td className="num">{t.strain}</td><td className="num"><b>{t.area + t.strain}</b></td></tr>)}</tbody>
        </table></div>
      </>}

      <h3 className="csec">A. Area composites <span className="muted">one per field, timed off its first harvest (fresh frozen or biomass)</span></h3>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Field</th><th>Type</th><th>First harvest</th><th className="hide-s">Window</th><th>Sample on</th><th>Status</th><th className="hide-s">Lab</th><th>Sent / back</th><th>Result</th></tr></thead>
        <tbody>{A.length ? A.map(row) : <tr><td colSpan={9} className="muted">No fields with harvests yet.</td></tr>}</tbody>
      </table></div>

      <h3 className="csec">B. Dry flower strain tests <span className="muted">one per dry harvest</span></h3>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Strain</th><th>Dry harvest</th><th className="hide-s">Window</th><th>Sample on</th><th>Status</th><th className="hide-s">Lab</th><th>Sent / back</th><th>Result</th></tr></thead>
        <tbody>{S.length ? S.map(row) : <tr><td colSpan={8} className="muted">No dry harvests on the schedule.</td></tr>}</tbody>
      </table></div>
      <p className="cnote">Test entries are tied to the field or the harvest, so they stay put when the schedule changes. All samples are dried by the lab; composites also get a micro extraction.</p>

      {edit && <TestSheet d={d} r={edit} api={api} flash={flash} onClose={() => setEdit(null)} onSaved={async m => { setEdit(null); await onSaved(m) }} />}
      {proto && <ProtoSheet p={proto} api={api} flash={flash} onClose={() => setProto(null)} onSaved={async m => { setProto(null); await onSaved(m) }} />}
    </>
  )
}

function TestSheet({ d, r, api, flash, onClose, onSaved }: { d: CultData; r: TestRow; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [t, setT] = useState<Partial<CTest>>(r.test ?? { crop_year: d.year, site: r.site, kind: r.kind, field_id: r.kind === 'area' ? r.field_id : null, harvest_id: r.harvest?.id ?? null, lab: d.settings.labs[0] ?? null })
  const [busy, setBusy] = useState(false)
  const set = (x: Partial<CTest>) => setT(v => ({ ...v, ...x }))
  async function save() {
    setBusy(true)
    try { await api.save<CTest>('cult_tests', t); await onSaved('Test saved') } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  async function del() {
    setBusy(true)
    try { await api.remove('cult_tests', t.id!); await onSaved('Test entries cleared') } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={r.ref} sub={<>First harvest {fmtD(r.first, true)} · window {fmtD(r.opens)} – {fmtD(r.closes)} · sample {fmtD(r.suggested, true)}</>} onClose={onClose}>
      <p className="muted">Tests: {r.protocol?.tests}</p>
      <div className="grid2">
        <F label="Lab"><TextIn value={t.lab} list="cult-labs" onChange={v => set({ lab: v })} /></F>
        <F label="Test ID / COC #"><TextIn value={t.test_ref} onChange={v => set({ test_ref: v })} placeholder={r.ref} /></F>
        <F label="Sampled on"><DateIn value={t.sampled_on} onChange={v => set({ sampled_on: v })} /></F>
        <F label="Submitted"><DateIn value={t.submitted_on} onChange={v => set({ submitted_on: v })} /></F>
        <F label="Results received"><DateIn value={t.results_on} onChange={v => set({ results_on: v })} /></F>
        <F label="Result"><TextIn value={t.result} list="cult-results" onChange={v => set({ result: v })} placeholder="Pass / Fail" /></F>
      </div>
      <datalist id="cult-labs">{d.settings.labs.map(l => <option key={l} value={l} />)}</datalist>
      <datalist id="cult-results"><option value="Pass" /><option value="Fail" /><option value="Retest" /></datalist>
      <F label="Notes"><textarea value={t.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
      <SaveBar busy={busy} onSave={save} onCancel={onClose} onDelete={t.id ? del : undefined} />
    </Sheet>
  )
}

function ProtoSheet({ p, api, flash, onClose, onSaved }: { p: Protocol; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(p)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { await api.save<Protocol>('cult_test_protocols', x); await onSaved('Protocol saved') } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={`${p.label} testing`} onClose={onClose}>
      <div className="grid2">
        <F label="Window opens" hint="days before"><NumIn value={x.opens_days} onChange={v => setX({ ...x, opens_days: v ?? 0 })} /></F>
        <F label="Window closes" hint="days before"><NumIn value={x.closes_days} onChange={v => setX({ ...x, closes_days: v ?? 0 })} /></F>
      </div>
      <F label="Tests to order"><textarea value={x.tests} onChange={e => setX({ ...x, tests: e.target.value })} /></F>
      <SaveBar busy={busy} onSave={save} onCancel={onClose} />
    </Sheet>
  )
}
