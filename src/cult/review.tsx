import { useEffect, useMemo, useState } from 'react'
import type { CultApi } from './api'
import { calcHarvest, fieldName, fmtD, KIND_SHORT, n0, testRows, today } from './calc'
import type { Ctx } from './calc'
import type { CultData, Harvest, LogRow } from './types'
import type { CultTab } from './tabs'
import { describeLog } from './setup'

/** Production > Review: things that need someone's attention */
export function ReviewTab({ d, c, site, onOpen, go }: { d: CultData; c: Ctx; site: string | null; onOpen: (h: Harvest) => void; go: (t: CultTab) => void }) {
  const now = today()
  const live = d.harvests.filter(h => h.status !== 'cancelled' && (!site || h.site === site))
  const unlogged = live.filter(h => h.status === 'planned' && !h.stage && h.planned_on && h.planned_on < now).sort((a, b) => a.planned_on!.localeCompare(b.planned_on!))
  const noWeight = live.filter(h => h.status === 'done' && h.kind === 'ff' && calcHarvest(c, h).actFF == null)
  const tests = useMemo(() => { const t = testRows(d, c, now); return [...t.area, ...t.strain].filter(r => (!site || r.site === site) && r.status === 'Window passed - sample ASAP') }, [d, c, site, now])
  // a planting is on the schedule if a harvest points at it, or one is planned for the same field and strain, or the whole field is (biomass)
  const hs = d.harvests.filter(h => h.status !== 'cancelled')
  const planted = new Set(hs.filter(h => h.planting_id != null).map(h => h.planting_id))
  const fs = new Set(hs.flatMap(h => [`${h.crop_year}|${h.field_id}|${h.strain.toLowerCase()}`, ...(h.kind === 'combine' || h.kind === 'strip' ? [`${h.crop_year}|${h.field_id}|*`] : [])]))
  const noHarvest = d.plantings.filter(p => (!site || p.site === site) && (p.plants ?? 0) > 0 && !planted.has(p.id) && !fs.has(`${p.crop_year}|${p.field_id}|${p.strain.toLowerCase()}`) && !fs.has(`${p.crop_year}|${p.field_id}|*`))
  const total = unlogged.length + noWeight.length + tests.length + noHarvest.length
  const hRow = (h: Harvest, tag: string) => (
    <button key={h.id} className="drow click" onClick={() => onOpen(h)}>
      <span><b>{h.strain}</b><span className="muted"> · {h.site} {fieldName(c, h.field_id)} · {KIND_SHORT[h.kind]}</span></span><span className="pill badp">{tag}</span></button>
  )
  return (
    <div className="dash">
      {total === 0 && <p className="muted">Nothing needs attention in the {d.year} season{site ? ` at ${site}` : ''}.</p>}
      {unlogged.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Harvests not logged <span className="side-badge">{unlogged.length}</span></h3></div>
        <p className="muted">The day has passed but nobody logged the harvest. Log it on the Harvest screen, or tap one to edit or cancel it.</p>
        <div className="dlist">{unlogged.map(h => hRow(h, fmtD(h.planned_on, true)))}</div></section>}
      {noWeight.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Harvested, no weight <span className="side-badge">{noWeight.length}</span></h3></div>
        <p className="muted">Marked done with no fresh frozen lbs and no pallets. Add the weight so yields and the season total are right.</p>
        <div className="dlist">{noWeight.map(h => hRow(h, fmtD(h.harvested_on ?? h.planned_on, true)))}</div></section>}
      {tests.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Tests past their window <span className="side-badge">{tests.length}</span></h3><button className="linkbtn" onClick={() => go('testing')}>Testing ›</button></div>
        <div className="dlist">{tests.map(r => <div key={r.key} className="drow"><span><b>{r.ref}</b><span className="muted"> · first harvest {fmtD(r.first, true)}</span></span><span className="pill badp">sample ASAP</span></div>)}</div></section>}
      {noHarvest.length > 0 && <section className="dcard"><div className="dcard-h"><h3>Plantings with no harvest <span className="side-badge">{noHarvest.length}</span></h3><button className="linkbtn" onClick={() => go('plantings')}>Fields ›</button></div>
        <p className="muted">In the ground but not on the harvest schedule yet.</p>
        <div className="dlist">{noHarvest.slice(0, 30).map(p => <div key={p.id} className="drow"><span><b>{p.strain}</b><span className="muted"> · {p.site} {fieldName(c, p.field_id)}{p.planted_on ? ` · planted ${fmtD(p.planted_on)}` : ''}</span></span><span>{n0(p.plants)} plants</span></div>)}
          {noHarvest.length > 30 && <div className="muted small-note">+{noHarvest.length - 30} more</div>}</div></section>}
    </div>
  )
}

/** Production > Activity: every change made in Production */
export function ActivityTab({ api }: { api: CultApi }) {
  const [log, setLog] = useState<LogRow[] | null>(null)
  useEffect(() => { api.log(300).then(setLog).catch(() => setLog([])) }, [api])
  if (!log) return <p className="muted">Loading…</p>
  if (!log.length) return <p className="muted">No changes yet.</p>
  return (
    <div className="list">
      {log.map(r => (
        <div key={r.id} className="li static">
          <div>{describeLog(r)}</div>
          <div className="muted">{new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {(r.user_email ?? '').split('@')[0]}</div>
        </div>
      ))}
    </div>
  )
}
