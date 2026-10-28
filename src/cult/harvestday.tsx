import { useEffect, useState } from 'react'
import type { CultApi } from './api'
import type { HarvestDay } from './types'
import { NumIn, errText } from './ui'
import type { Flash } from './ui'
import { can } from '../fold'
import { clock, computeBonus, hm } from './bonuscalc'
import type { BonusView } from './bonuscalc'

// Production > Harvest: the day's card for a site. Entered once (first variety of the day) and used by every
// harvest at that site that day: room start, first box tagged, labor, La Meta, breaks. Feeds the Live Bonus screen.

const money = (n: number) => `$${n.toFixed(2)}`
const hhmm = (s: string | null | undefined) => (s ? s.slice(0, 5) : '')
const nowHHMM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const fmtT = (s: string | null | undefined) => { const m = hm(s); return m == null ? '' : clock(m) }

type Form = { room_start: string; box_start: string; people: number | null; buckers: number | null; cutters: number | null; est_hours: number | null; hurdle: number | null; hourly: number | null; per_lb: number | null }
const toForm = (d: HarvestDay): Form => ({ room_start: hhmm(d.room_start), box_start: hhmm(d.box_start), people: d.people, buckers: d.buckers, cutters: d.cutters,
  est_hours: d.est_hours, hurdle: d.hurdle, hourly: d.hourly, per_lb: d.per_lb })

export function HarvestDayCard({ site, day, api, flash, startOpen }: { site: string; day: string; api: CultApi; flash: Flash; startOpen?: boolean }) {
  const [d, setD] = useState<HarvestDay | null>(null)
  const [f, setF] = useState<Form | null>(null)
  const [open, setOpen] = useState(!!startOpen)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [live, setLive] = useState<BonusView | null>(null)
  const [edBreak, setEdBreak] = useState<{ id: number; kind: string; start: string; end: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = async () => {
    try {
      const x = await api.harvestDay(site, day); setD(x); setF(toForm(x)); setErr(null)
      if (x.is_new || x.people == null || x.box_start == null) setOpen(true)
      const tok = link ?? await api.bonusLink(site).catch(() => null)
      if (tok) {
        setLink(tok)
        const b = await api.bonusLive(tok, day).catch(() => null)
        if (b) setLive(computeBonus(b, b.now_min))
      }
    } catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { load() }, [site, day])
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t) }, [site, day, link])
  if (err) return <section className="dcard hdaycard"><div className="dcard-h"><h3>Harvest day · {site}</h3></div><p className="warn-t small">{err}</p></section>
  if (!d || !f) return null
  const edit = can('cultivation', 'edit', 'user')
  const set = (v: Partial<Form>) => setF(s => (s ? { ...s, ...v } : s))
  const changed = d.is_new || JSON.stringify(f) !== JSON.stringify(toForm(d))
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); await load(); flash(ok) } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const save = () => run(() => api.saveHarvestDay(site, day, { ...f, room_start: f.room_start || null, box_start: f.box_start || null }), `${site} harvest day saved`)
  const going = d.breaks.find(b => !b.end_at)
  const url = link ? `${location.origin}/?bonus=${link}` : null
  const isToday = day === new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const summary = [d.box_start ? `boxes from ${fmtT(d.box_start)}` : 'box start not set', d.people ? `${d.people} people` : null, d.buckers ? `${d.buckers} buckers` : null, d.hurdle ? `meta ${d.hurdle}` : null].filter(Boolean).join(' · ')
  return (
    <section className="dcard hdaycard">
      <div className="dcard-h"><h3>Harvest day · {site}</h3><button className="linkbtn" onClick={() => setOpen(o => !o)}>{open ? 'Close' : 'Labor, breaks…'}</button></div>
      {live && live.pallets > 0 && <div className="ckpis hk">
        <div><b>{live.corr != null ? live.corr.toFixed(1) : '—'}</b><span>lbs / person{live.hurdle ? ` (meta ${live.hurdle})` : ''}</span></div>
        <div><b>{live.speed != null ? Math.round(live.speed) : '—'}</b><span>lbs / bucker / hr</span></div>
        <div><b>{live.avgPalletMin != null ? live.avgPalletMin.toFixed(1) : '—'}</b><span>min / pallet</span></div>
        <div><b>{money(live.won ? live.bonusNow : live.bonusAtStake)}</b><span>{live.won ? 'bonus / hr earned' : 'bonus / hr at stake'}</span></div>
      </div>}
      {!open && <p className="muted small">{summary}{going ? ` · ${going.kind === 'lunch' ? 'lunch' : 'break'} since ${fmtT(going.start_at)}` : ''}</p>}
      {open && <>
        {d.is_new && <p className="cnote">Not started yet. The numbers are from the last harvest day at {site}; fix them and Save.</p>}
        <div className="hpal hday3">
          <label><span>Room start{edit && isToday && !f.room_start && <> · <a className="linkbtn" onClick={e => { e.preventDefault(); set({ room_start: nowHHMM() }) }}>now</a></>}</span>
            <input type="time" value={f.room_start} disabled={!edit} onChange={e => set({ room_start: e.target.value })} /></label>
          <label><span>First box tagged{edit && isToday && !f.box_start && <> · <a className="linkbtn" onClick={e => { e.preventDefault(); set({ box_start: nowHHMM() }) }}>now</a></>}</span>
            <input type="time" value={f.box_start} disabled={!edit} onChange={e => set({ box_start: e.target.value })} /></label>
          <label><span>People (labor chart)</span><NumIn value={f.people} onChange={v => set({ people: v })} /></label>
          <label><span>Buckers</span><NumIn value={f.buckers} onChange={v => set({ buckers: v })} /></label>
          <label><span>Cutters</span><NumIn value={f.cutters} onChange={v => set({ cutters: v })} /></label>
          <label><span>Est. hours</span><NumIn value={f.est_hours} onChange={v => set({ est_hours: v })} /></label>
          <label><span>La Meta (lbs / person)</span><NumIn value={f.hurdle} onChange={v => set({ hurdle: v })} /></label>
          <label><span>Base $ / hr</span><NumIn value={f.hourly} onChange={v => set({ hourly: v })} /></label>
          <label><span>Bonus $ / lb</span><NumIn value={f.per_lb} onChange={v => set({ per_lb: v })} /></label>
          {edit && <button className="primary" disabled={busy || !changed} onClick={save}>{d.is_new ? 'Start the day' : 'Save'}</button>}
        </div>

        <h4 className="csec">Breaks <span className="muted">time on a break doesn't count toward pallet times or speed</span></h4>
        {d.breaks.length > 0 && <div className="dlist">{d.breaks.map(b => edBreak?.id === b.id
          ? <div key={b.id} className="drow hbreak">
              <select value={edBreak.kind} onChange={e => setEdBreak({ ...edBreak, kind: e.target.value })}><option value="break">Break</option><option value="lunch">Lunch</option></select>
              <input type="time" value={edBreak.start} onChange={e => setEdBreak({ ...edBreak, start: e.target.value })} aria-label="Start" />
              <input type="time" value={edBreak.end} onChange={e => setEdBreak({ ...edBreak, end: e.target.value })} aria-label="End" />
              <button className="primary small" disabled={busy || !edBreak.start} onClick={() => run(() => api.breakEdit(b.id, edBreak.kind, edBreak.start, edBreak.end || null), 'Break fixed').then(() => setEdBreak(null))}>Save</button>
              <button className="ghost small" onClick={() => setEdBreak(null)}>Cancel</button>
              <button className="ghost small" disabled={busy} onClick={() => run(() => api.breakRemove(b.id), 'Break removed').then(() => setEdBreak(null))}>✕</button>
            </div>
          : <div key={b.id} className="drow">
              <span className="grow"><b>{b.kind === 'lunch' ? 'Lunch' : 'Break'}</b> <span className="muted">{fmtT(b.start_at)} to {b.end_at ? fmtT(b.end_at) : 'now'}{b.end_at ? ` · ${(hm(b.end_at)! - hm(b.start_at)!)} min` : ''}</span></span>
              {edit && !b.end_at && <button className="primary small" disabled={busy} onClick={() => run(() => api.breakEnd(b.id), `${b.kind === 'lunch' ? 'Lunch' : 'Break'} ended`)}>End now</button>}
              {edit && <button className="ghost small" disabled={busy} onClick={() => setEdBreak({ id: b.id, kind: b.kind, start: hhmm(b.start_at), end: hhmm(b.end_at) })}>Edit</button>}
            </div>)}</div>}
        {edit && !going && <div className="row wrap">
          {isToday && <><button className="ghost" disabled={busy} onClick={() => run(() => api.breakStart(site, day, 'break'), 'Break started')}>Start break now</button>
            <button className="ghost" disabled={busy} onClick={() => run(() => api.breakStart(site, day, 'lunch'), 'Lunch started')}>Start lunch now</button></>}
          <button className="linkbtn" disabled={busy} onClick={() => { const s = window.prompt('Break start (HH:MM, 24-hour)', '10:00'); if (s && /^\d{1,2}:\d{2}$/.test(s)) run(() => api.breakStart(site, day, 'break', s), 'Break added') }}>Add a past break…</button>
        </div>}
      </>}
      {url && <div className="row wrap hbonus">
        <a className="ghost small" href={url} target="_blank" rel="noreferrer">Open Live Bonus screen</a>
        <button className="ghost small" onClick={() => navigator.clipboard?.writeText(url).then(() => flash('Link copied. Open it on the TV.'), () => window.prompt('Copy this link', url))}>Copy TV link</button>
        {open && can('cultivation', 'bonus_link') && <button className="linkbtn" disabled={busy} onClick={() => { if (window.confirm(`Make a new ${site} TV link? The old one stops working.`)) run(async () => setLink(await api.bonusLinkReset(site)), 'New link made') }}>New link</button>}
      </div>}
    </section>
  )
}
