import { useState } from 'react'
import type { CultApi } from './api'
import { availability, fmtD, monday, n0, pct, sum, today } from './calc'
import type { Ctx } from './calc'
import type { CultData, Pick as PickRow } from './types'
import { F, NumIn, SaveBar, Sheet, StrainList, TextIn, errText } from './ui'
import type { Flash } from './ui'

export function AvailabilityTab({ d, c, site, q, api, flash, onSaved }: { d: CultData; c: Ctx; site: string | null; q: string; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const { weeks, rows } = availability(d, c, site)
  const [edit, setEdit] = useState<Partial<PickRow> | null>(null)
  const ql = q.trim().toLowerCase()
  const shown = rows.filter(([s, m]) => (!ql || s.toLowerCase().includes(ql)) && [...m.values()].some(x => x.est + x.act > 0))
  const thisWeek = monday(today())
  const tot = (w: string) => sum(shown.map(([, m]) => { const x = m.get(w); return x ? x.est + x.act : 0 }))

  // dry flower picks: when each strain is scheduled to be harvested dry (or fresh frozen only)
  const picks = d.picks.filter(p => !ql || p.strain.toLowerCase().includes(ql)).map(p => {
    const hs = d.harvests.filter(h => h.strain.toLowerCase() === p.strain.toLowerCase() && h.status !== 'cancelled' && h.planned_on && (!site || h.site === site))
    const dryH = hs.filter(h => h.kind === 'dry').sort((a, b) => a.planned_on!.localeCompare(b.planned_on!))
    const ffH = hs.filter(h => h.kind === 'ff').sort((a, b) => a.planned_on!.localeCompare(b.planned_on!))
    const first = dryH[0] ?? ffH[0]
    const convs = dryH.map(h => h.dry_conversion).filter((x): x is number => x != null)
    const conv = convs.length ? convs.reduce((a, b) => a + b, 0) / convs.length : (c.site.get(first?.site ?? 'OHR')?.dry_conversion ?? 0.075)
    return { p, first, type: dryH.length ? 'Dry' : ffH.length ? 'Fresh frozen only' : 'Not scheduled', conv, wet: conv ? p.dry_lbs / conv : null }
  })

  return (
    <>
      <h3 className="csec">Fresh frozen by week <span className="muted">lbs; estimates until harvested, then actual · ready {d.settings.readyDays} days after harvest</span></h3>
      {!weeks.length ? <p className="muted">No fresh frozen harvests this season.</p> : (
        <div className="cwrap"><table className="ctable" style={{ minWidth: Math.max(640, 180 + weeks.length * 70) }}>
          <thead><tr><th>Strain</th>{weeks.map(w => <th key={w} className={`num ${w === thisWeek ? 'on' : ''}`}>{fmtD(w)}</th>)}<th className="num">Season</th></tr></thead>
          <tbody>
            <tr className="tot"><td>All strains</td>{weeks.map(w => <td key={w} className="num">{n0(tot(w))}</td>)}<td className="num">{n0(sum(weeks.map(tot)))}</td></tr>
            {shown.map(([s, m]) => {
              const all = sum([...m.values()].map(x => x.est + x.act))
              return (
                <tr key={s}><td>{s}</td>
                  {weeks.map(w => { const x = m.get(w); const v = x ? x.est + x.act : 0
                    return <td key={w} className="num" title={x ? `${n0(x.act)} harvested, ${n0(x.est)} estimated` : ''}>{v ? (x!.act && !x!.est ? <b>{n0(v)}</b> : n0(v)) : ''}</td> })}
                  <td className="num"><b>{n0(all)}</b></td></tr>
              )
            })}
          </tbody>
        </table></div>
      )}
      <p className="cnote">Bold = already harvested. Week columns start Monday. Hover a number to see harvested vs estimated.</p>

      <div className="row between"><h3 className="csec">Dry flower picks <span className="muted">dry lbs wanted → wet lbs to harvest</span></h3>
        <button className="primary small" onClick={() => setEdit({ crop_year: d.year, strain: '', dry_lbs: 0 })}>+ Add strain</button></div>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Strain</th><th className="num">Dry lbs wanted</th><th>Scheduled</th><th>Site</th><th>Type</th><th className="num">Conversion</th><th className="num">Wet lbs to harvest</th></tr></thead>
        <tbody>
          {picks.map(x => (
            <tr key={x.p.id} className="tap" onClick={() => setEdit(x.p)}>
              <td>{x.p.strain}</td><td className="num">{n0(x.p.dry_lbs)}</td><td className="nowrap">{x.first ? fmtD(x.first.planned_on, true) : <span className="warn-t">Not scheduled</span>}</td>
              <td>{x.first?.site ?? ''}</td><td className={x.type === 'Dry' ? '' : 'warn-t'}>{x.type}</td><td className="num">{pct(x.conv)}</td><td className="num">{n0(x.wet)}</td>
            </tr>
          ))}
          {!picks.length && <tr><td colSpan={7} className="muted">No dry flower picks for {d.year} yet.</td></tr>}
        </tbody>
        {picks.length > 0 && <tfoot><tr className="tot"><td>Total</td><td className="num">{n0(sum(picks.map(x => x.p.dry_lbs)))}</td><td colSpan={4} /><td className="num">{n0(sum(picks.map(x => x.wet)))}</td></tr></tfoot>}
      </table></div>
      <p className="cnote">"Fresh frozen only" means the strain is on the schedule but has no dry harvest yet. Add one on the Schedule tab (type Dry).</p>

      {edit && <PickSheet d={d} p={edit} api={api} flash={flash} onClose={() => setEdit(null)} onSaved={async m => { setEdit(null); await onSaved(m) }} />}
    </>
  )
}

function PickSheet({ d, p, api, flash, onClose, onSaved }: { d: CultData; p: Partial<PickRow>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(p)
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<unknown>, m: string) => { setBusy(true); try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return (
    <Sheet title={p.id ? p.strain : 'Dry flower pick'} onClose={onClose}>
      <StrainList id="cult-strains" names={d.strains.map(s => s.name)} />
      <F label="Strain"><TextIn value={x.strain} list="cult-strains" autoFocus={!p.id} onChange={v => setX({ ...x, strain: v ?? '' })} /></F>
      <F label="Dry lbs wanted"><NumIn value={x.dry_lbs} onChange={v => setX({ ...x, dry_lbs: v ?? 0 })} /></F>
      <F label="Notes"><TextIn value={x.notes} onChange={v => setX({ ...x, notes: v })} /></F>
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose} onSave={() => run(() => api.save('cult_flower_picks', x), 'Saved')}
        onDelete={p.id ? () => run(() => api.remove('cult_flower_picks', p.id!), 'Removed') : undefined} />
    </Sheet>
  )
}

