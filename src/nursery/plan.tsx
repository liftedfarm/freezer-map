import { Fragment, useMemo, useState } from 'react'
import type { NurseryApi } from './api'
import type { GenRow, NCtx, PlanRow } from './calc'
import { fmtD, n0, planSeason, sum, today } from './calc'
import type { NData } from './types'
import { F, NumIn, SaveBar, Sheet, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'

/** Nursery > Plan: from the farm orders back to G4 trays, G3 field moms, G2 greenhouse moms, G1, with cut-by dates */
export function PlanTab({ d, c, api, flash, onSaved }: { d: NData; c: NCtx; api: NurseryApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const years = [...new Set([...d.orders.map(o => o.crop_year), ...d.mothers.map(m => m.season).filter((y): y is number => !!y), new Date().getFullYear() + 1])].sort((a, b) => b - a)
  const [year, setYear] = useState(() => { const y = new Date().getFullYear(); return d.orders.some(o => o.crop_year === y + 1) || new Date().getMonth() >= 6 ? y + 1 : y })
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<PlanRow | null>(null)
  const rows = useMemo(() => planSeason(d, c, year), [d, c, year])
  const ql = q.trim().toLowerCase()
  const shown = rows.filter(r => !ql || r.strain.toLowerCase().includes(ql))
  const S = d.settings, now = today()
  const T = (f: (r: PlanRow) => number) => sum(shown.map(f))
  const short = (g: GenRow) => Math.max(0, g.need - g.have - g.rooting)
  const cell = (g: GenRow, label: string) => {
    const s = short(g), due = g.cutBy && g.cutBy < now && s > 0
    return <>
      <td className="num">{n0(g.need)}</td>
      <td className="num">{g.have ? n0(g.have) : <span className="muted">0</span>}{g.rooting ? <span className="muted"> +{n0(g.rooting)}</span> : ''}</td>
      <td className={`num ${s ? (due ? 'bad-t' : 'warn-t') : 'ok-t'}`} title={s ? `${label}: cut ${n0(g.cut)} (${g.trays} trays) by ${fmtD(g.cutBy)}` : 'covered'}>{s ? `−${n0(s)}` : '✓'}</td>
      <td className="nowrap small">{fmtD(g.cutBy)}</td>
    </>
  }
  return <>
    <div className="row toolbar between">
      <div className="row">
        <select value={year} onChange={e => setYear(Number(e.target.value))}>{years.map(y => <option key={y} value={y}>{y} season</option>)}</select>
        <input className="search" type="search" placeholder="Strain" value={q} onChange={e => setQ(e.target.value)} />
      </div>
    </div>
    <details className="muted small-note howto"><summary>How the plan works</summary>
      Works back from the clone orders for {year} (Production's nursery deliveries and outside orders): G4 cuttings = order + {S.buffer}% in trays of {S.tray}.
      G3 field moms = G4 cuttings ÷ {S.cutsG3} cuts per mom. Each generation above is cut with +{S.buffer}% and G2 at {S.cutsG2} cuts per mom.
      Cut-by dates: G4 = first delivery − {S.rootDays} days, G3 planted {S.g3VegDays} days before that and cut {S.g3RootDays} days before planting, G2 {S.g2Lead} days before G3, G1 {S.g1Lead} days before G2.
      "Have" counts live mother lots for the season; +N is rooting now. Each generation only needs to cover what the one below is still short. Tap a strain to change its cuts per mom.
    </details>
    {!rows.length ? <p className="muted">No clone orders for {year} yet. They come from Production → Plan → Nursery deliveries (nursery 1PN), or add them under Orders.</p> : (
      <div className="cwrap"><table className="ctable plantable">
        <thead>
          <tr className="grp"><th colSpan={3} /><th colSpan={3} className="g4">G4 production clones</th><th colSpan={4} className="g3">G3 field moms</th><th colSpan={4} className="g2">G2 greenhouse moms</th><th colSpan={4} className="g1">G1</th></tr>
          <tr><th>Strain</th><th className="num">Ordered</th><th>1st delivery</th>
            <th className="num">Cuttings</th><th className="num">Trays</th><th>Cut by</th>
            <th className="num">Need</th><th className="num">Have</th><th className="num">Short</th><th>Cut by</th>
            <th className="num">Need</th><th className="num">Have</th><th className="num">Short</th><th>Cut by</th>
            <th className="num">Need</th><th className="num">Have</th><th className="num">Short</th><th>Cut by</th></tr>
        </thead>
        <tbody>{shown.map(r => (
          <tr key={r.strain} className="tap" onClick={() => setOpen(r)}>
            <td>{r.strain}{r.custom && <span className="muted" title="Custom cuts per mom"> *</span>}</td><td className="num">{r.orders ? n0(r.orders) : <span className="muted">—</span>}</td>
            <td className="nowrap">{fmtD(r.firstDeliver)}</td>
            <td className="num">{n0(r.g4.cuttings)}{r.g4.cut ? <span className="muted"> ({n0(r.g4.cut)} cut)</span> : ''}</td><td className="num">{n0(r.g4.trays)}</td>
            <td className={`nowrap small ${r.g4.cutBy && r.g4.cutBy < now && r.g4.cut < r.g4.cuttings ? 'bad-t' : ''}`}>{fmtD(r.g4.cutBy)}</td>
            {cell(r.g3, 'G3')}{cell(r.g2, 'G2')}{cell(r.g1, 'G1')}
          </tr>
        ))}
          <tr className="tot"><td>Total</td><td className="num">{n0(T(r => r.orders))}</td><td />
            <td className="num">{n0(T(r => r.g4.cuttings))}</td><td className="num">{n0(T(r => r.g4.trays))}</td><td />
            <td className="num">{n0(T(r => r.g3.need))}</td><td className="num">{n0(T(r => r.g3.have))}</td><td className="num">{n0(T(r => short(r.g3)))}</td><td />
            <td className="num">{n0(T(r => r.g2.need))}</td><td className="num">{n0(T(r => r.g2.have))}</td><td className="num">{n0(T(r => short(r.g2)))}</td><td />
            <td className="num">{n0(T(r => r.g1.need))}</td><td className="num">{n0(T(r => r.g1.have))}</td><td className="num">{n0(T(r => short(r.g1)))}</td><td /></tr>
        </tbody>
      </table></div>
    )}
    {rows.length > 0 && <SpaceCheck d={d} rows={shown} />}
    {open && <StrainPlanSheet d={d} r={open} api={api} flash={flash} onClose={() => setOpen(null)} onSaved={onSaved} />}
  </>
}

/** does the plan fit: G3 field moms vs hoop space, G2 moms vs bench count */
function SpaceCheck({ d, rows }: { d: NData; rows: PlanRow[] }) {
  const hoops = d.rooms.filter(r => r.active && r.kind === 'hoop')
  const cap = (place: string) => sum(hoops.filter(h => h.place === place).map(h => h.capacity ?? sum(h.beds.map(b => b.cap))))
  const places = [...new Set(hoops.map(h => h.place))]
  const need = sum(rows.map(r => r.g3.need))
  const total = sum(places.map(cap))
  return (
    <div className="calcbox spacebox">
      <span>G3 field moms needed</span><b>{n0(need)}</b>
      {places.map(p => <Fragment key={p}><span>Hoop space at {p}{hoops.some(h => h.place === p && h.rented) ? ' (rented)' : ''}</span><b>{n0(cap(p))}</b></Fragment>)}
      <span>{need > total ? 'Over by' : 'Room left'}</span><b className={need > total ? 'bad-t' : 'ok-t'}>{n0(Math.abs(total - need))}</b>
      <span>G4 trays to root</span><b>{n0(sum(rows.map(r => r.g4.trays)))} (trailers hold {n0(sum(d.rooms.filter(r => r.kind === 'trailer' && r.active).map(r => r.trays ?? 0)))} at a time)</b>
    </div>
  )
}

function StrainPlanSheet({ d, r, api, flash, onClose, onSaved }: { d: NData; r: PlanRow; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const p = d.strainPlan.find(x => x.strain.toLowerCase() === r.strain.toLowerCase())
  const [g3, setG3] = useState<number | null>(p?.cuts_g3 ?? null)
  const [g2, setG2] = useState<number | null>(p?.cuts_g2 ?? null)
  const [g1, setG1] = useState<number | null>(p?.cuts_g1 ?? null)
  const [notes, setNotes] = useState<string | null>(p?.notes ?? null)
  const [busy, setBusy] = useState(false)
  const S = d.settings
  const save = async () => {
    setBusy(true)
    try { await api.saveStrainPlan({ strain: r.strain, cuts_g3: g3, cuts_g2: g2, cuts_g1: g1, notes }); onClose(); await onSaved(`${r.strain} plan saved`) }
    catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const line = (g: GenRow, n: string) => <><span>{n}</span><b>need {n0(g.need)} · have {n0(g.have)}{g.rooting ? ` + ${n0(g.rooting)} rooting` : ''} · cut {n0(g.cut)} ({g.trays} {g.trays === 1 ? 'tray' : 'trays'}) by {fmtD(g.cutBy, true) || '—'}</b></>
  return (
    <Sheet title={r.strain} sub={`${n0(r.orders)} plants ordered in ${r.nOrders} ${r.nOrders === 1 ? 'order' : 'orders'} · first delivery ${fmtD(r.firstDeliver, true) || '—'}`} onClose={onClose}>
      <div className="calcbox">
        <span>G4 production clones</span><b>{n0(r.g4.cuttings)} cuttings · {r.g4.trays} {r.g4.trays === 1 ? 'tray' : 'trays'} · cut by {fmtD(r.g4.cutBy, true) || '—'}</b>
        {line(r.g3, 'G3 field moms')}<span>Plant G3 by</span><b>{fmtD(r.plantBy, true) || '—'}</b>
        {line(r.g2, 'G2 greenhouse moms')}{line(r.g1, 'G1')}
      </div>
      <h3>Cuts per mom for {r.strain}</h3>
      <div className="grid3">
        <F label="G3 field mom" hint={`(default ${S.cutsG3})`}><NumIn value={g3} onChange={setG3} /></F>
        <F label="G2 greenhouse mom" hint={`(default ${S.cutsG2})`}><NumIn value={g2} onChange={setG2} /></F>
        <F label="G1" hint={`(default ${S.cutsG1})`}><NumIn value={g1} onChange={setG1} /></F>
      </div>
      <F label="Notes"><TextIn value={notes} onChange={setNotes} placeholder="e.g. slow rooter, cut twice" /></F>
      <SaveBar busy={busy} onCancel={onClose} onSave={save} />
    </Sheet>
  )
}
