import { Select } from '../combo'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { pageAll } from '../pageAll'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NData } from './types'
import { fmtD, today } from './calc'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { canEditMod } from '../fold'
import { t } from '../i18n'

interface Leach {
  id: number; site: string; room_id: number | null; bed: string | null; taken_on: string; minutes: number | null; leach_vol: number | null; leach_ec: number | null; leach_ph: number | null
  front_ml: number | null; front_ec: number | null; front_ph: number | null; back_ml: number | null; back_ec: number | null; back_ph: number | null
  water_ml_plant: number | null; expect_pct: number | null; leach_pct: number | null; notes: string | null; source: string
}
const NUMS: (keyof Leach)[] = ['minutes', 'leach_vol', 'leach_ec', 'leach_ph', 'front_ml', 'front_ec', 'front_ph', 'back_ml', 'back_ec', 'back_ph', 'water_ml_plant', 'expect_pct', 'leach_pct']
const f = (x: number | null | undefined, d = 1) => (x == null ? '' : String(Math.round(Number(x) * 10 ** d) / 10 ** d))
const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null && Number(x) > 0).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const inEc = (r: Leach) => avg([r.front_ec, r.back_ec]), inPh = (r: Leach) => avg([r.front_ph, r.back_ph])

// Leach % = leachate volume out ÷ front emitter mL (the catch sits at the front). Expected % = average emitter mL ÷ water per plant.
// Same math as the 2026 Field Leachate sheet; the database (060) recalculates on every save too.
const r1 = (v: number) => Math.round(v * 10) / 10
export function leachPct(r: Partial<Leach>): number | null {
  return r.leach_vol != null && r.front_ml != null && r.front_ml > 0 ? r1(r.leach_vol / r.front_ml * 100) : null
}
export function expectPct(r: Partial<Leach>): number | null {
  const ins = [r.front_ml, r.back_ml].filter((v): v is number => v != null)
  return ins.length && r.water_ml_plant != null && r.water_ml_plant > 0 ? r1(ins.reduce((a, b) => a + b, 0) / ins.length / r.water_ml_plant * 100) : null
}

/** Nursery > Logs > Leachate: EC and pH going in vs coming out, per hoop per day */
export function Leachate({ sb, d, flash }: { sb: SupabaseClient; d: NData; flash: Flash }) {
  const [rows, setRows] = useState<Leach[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [place, setPlace] = useState<string>('')
  const [year, setYear] = useState<number | null>(null)
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [ed, setEd] = useState<Partial<Leach> | null>(null)
  const load = async () => {
    const { data, error } = await pageAll((a, b) => sb.from('nursery_leachate').select('*').order('taken_on', { ascending: false }).order('id').range(a, b))
    if (error) { setErr(/nursery_leachate/.test(error.message) ? t('Leachate needs 041_leachate.sql run in Supabase.') : error.message); return }
    setRows((data ?? []) as Leach[]); setErr(null)
  }
  useEffect(() => { load() }, [sb])
  const rooms = useMemo(() => new Map(d.rooms.map(r => [r.id, r])), [d.rooms])
  if (err) return <div className="warnbox">{err}</div>
  if (!rows) return <p className="muted">{t('Loading…')}</p>
  const years = [...new Set(rows.map(r => Number(r.taken_on.slice(0, 4))))].sort((a, b) => b - a)
  const yr = year ?? years[0] ?? new Date().getFullYear()
  const places = [...new Set(rows.map(r => rooms.get(r.room_id ?? -1)?.place).filter((p): p is string => !!p))]
  const shown = rows.filter(r => r.taken_on.startsWith(String(yr)) && (!place || rooms.get(r.room_id ?? -1)?.place === place))
  const days = new Map<string, Leach[]>()
  for (const r of shown) (days.get(r.taken_on) ?? days.set(r.taken_on, []).get(r.taken_on)!).push(r)
  const first = [...days.keys()][0]
  const isOpen = (k: string) => (open ?? new Set([first])).has(k)
  const toggle = (k: string) => setOpen(s => { const x = new Set(s ?? [first]); if (x.has(k)) x.delete(k); else x.add(k); return x })
  const where = (r: Leach) => [rooms.get(r.room_id ?? -1)?.name, r.bed].filter(Boolean).join(' ')
  const sortKey = (r: Leach) => { const n = rooms.get(r.room_id ?? -1); return `${n?.place ?? ''}|${String(n?.sort ?? 999).padStart(4, '0')}|${n?.name ?? ''}` }
  const can = canEditMod('nursery')
  return <div className="leach">
    <div className="row toolbar between">
      <div className="row wrap">
        <Select value={yr} onChange={e => setYear(Number(e.target.value))}>{(years.length ? years : [yr]).map(y => <option key={y} value={y}>{y}</option>)}</Select>
        {places.length > 1 && <div className="seg">{['', ...places].map(p => <button key={p || 'all'} className={place === p ? 'on' : ''} onClick={() => setPlace(p)}>{p || t('All')}</button>)}</div>}
      </div>
      {can && <button className="primary" onClick={() => setEd({ taken_on: today(), site: d.sites[0]?.code ?? '1PN' })}>{t('+ Leachate reading')}</button>}
    </div>
    <p className="muted small-note">{t('One line per hoop per day: what went in (front and back) and what came out.')}</p>
    {!days.size ? <p className="muted">{t('No leachate readings in {yr}.', { yr })}</p> : <div className="cwrap"><table className="ctable logtable">
      <thead><tr><th>{t('Location')}</th><th className="num">{t('Out')}</th><th className="num">{t('EC out')}</th><th className="num">{t('pH out')}</th>
        <th className="num">{t('EC in')}</th><th className="num">{t('pH in')}</th><th className="num hide-s">{t('Front mL')}</th><th className="num hide-s">{t('Back mL')}</th><th className="num hide-s">{t('Leach %')}</th><th className="hide-s">{t('Notes')}</th></tr></thead>
      <tbody>{[...days.entries()].map(([day, rs]) => <Fragment key={day}>
        <tr className="mhead" onClick={() => toggle(day)}><td colSpan={10}><b>{isOpen(day) ? '▾' : '▸'} {fmtD(day, true)}</b>
          <span className="muted"> · {rs.length} {t('readings')} · {t('EC')} {f(avg(rs.map(inEc)))} → {f(avg(rs.map(r => r.leach_ec)))} · {t('pH')} {f(avg(rs.map(inPh)))} → {f(avg(rs.map(r => r.leach_ph)))}</span></td></tr>
        {isOpen(day) && [...rs].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map(r => {
          return <tr key={r.id} className="tap" onClick={() => setEd(r)}>
            <td>{where(r) || '—'}</td><td className="num">{f(r.leach_vol, 0)}</td><td className="num">{f(r.leach_ec)}</td><td className="num">{f(r.leach_ph)}</td>
            <td className="num">{f(inEc(r))}</td><td className="num">{f(inPh(r))}</td><td className="num hide-s">{f(r.front_ml, 0)}</td><td className="num hide-s">{f(r.back_ml, 0)}</td>
            <td className="num hide-s">{(r.leach_pct ?? leachPct(r)) != null ? `${f(r.leach_pct ?? leachPct(r))}%` : ''}</td><td className="hide-s small">{r.notes}</td></tr>
        })}
      </Fragment>)}</tbody>
    </table></div>}
    {ed && <LeachSheet sb={sb} d={d} x0={ed} can={can} flash={flash} onClose={() => setEd(null)} onSaved={async m => { setEd(null); await load(); flash(m) }} />}
  </div>
}

function LeachSheet({ sb, d, x0, can, flash, onClose, onSaved }: { sb: SupabaseClient; d: NData; x0: Partial<Leach>; can: boolean; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState<Partial<Leach>>(x0)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Leach>) => setX(s => ({ ...s, ...v }))
  const room = d.rooms.find(r => r.id === x.room_id)
  const n = (k: keyof Leach, l: string) => <F label={t(l)}><NumIn value={x[k] as number | null} onChange={v => set({ [k]: v } as Partial<Leach>)} /></F>
  async function save() {
    setBusy(true)
    const row: Record<string, unknown> = { site: x.site ?? '1PN', room_id: x.room_id ?? null, bed: x.bed || null, taken_on: x.taken_on, notes: x.notes || null }
    for (const k of NUMS) row[k] = x[k] ?? null
    row.leach_pct = leachPct(x); row.expect_pct = expectPct(x)
    const { error } = x.id ? await sb.from('nursery_leachate').update(row).eq('id', x.id) : await sb.from('nursery_leachate').insert(row)
    setBusy(false)
    if (error) flash(error.message, true); else await onSaved(t('Leachate saved'))
  }
  async function del() {
    setBusy(true)
    const { error } = await sb.from('nursery_leachate').delete().eq('id', x.id!)
    setBusy(false)
    if (error) flash(error.message, true); else await onSaved(t('Reading deleted'))
  }
  return <Sheet title={x.id ? `${room?.name ?? t('Leachate')} · ${fmtD(x.taken_on)}` : t('New leachate reading')} onClose={onClose} wide>
    <div className="grid3">
      <F label={t('Date')}><DateIn value={x.taken_on} onChange={v => set({ taken_on: v ?? today() })} /></F>
      <F label={t('Location')}><Pick value={x.room_id} blank="—" options={d.rooms.filter(r => r.active || r.id === x.room_id).map(r => ({ v: r.id, l: `${r.name}${r.place !== 'Webb' && !r.name.startsWith(r.place) ? ` (${r.place})` : ''}` }))} onChange={v => set({ room_id: v })} /></F>
      <F label={t('Bed')}><TextIn value={x.bed} onChange={v => set({ bed: v })} /></F>
    </div>
    <h3>{t('Coming out')}</h3>
    <div className="grid3">{n('leach_vol', 'Leachate volume')}{n('leach_ec', 'EC out')}{n('leach_ph', 'pH out')}</div>
    <h3>{t('Going in')}</h3>
    <div className="grid3">{n('front_ml', 'Front mL')}{n('front_ec', 'Front EC')}{n('front_ph', 'Front pH')}{n('back_ml', 'Back mL')}{n('back_ec', 'Back EC')}{n('back_ph', 'Back pH')}</div>
    <div className="grid3">{n('minutes', 'Run time (min)')}{n('water_ml_plant', 'Water per plant (mL)')}
      <F label={t('Leach %')} hint={t('(auto)')}><div className="calcval">{leachPct(x) != null ? `${f(leachPct(x))}%` : '—'}</div></F></div>
    <div className="grid3"><F label={t('Expected %')} hint={t('(auto)')}><div className="calcval">{expectPct(x) != null ? `${f(expectPct(x))}%` : '—'}</div></F></div>
    <p className="muted small">{t('Leach % = leachate volume ÷ front mL. Expected % = average of front and back mL ÷ water per plant.')}</p>
    <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
    {x.source && x.source !== 'app' && <p className="muted small">{t('From the 2026 Field Leachate sheet.')}</p>}
    {can ? <SaveBar busy={busy} disabled={!x.taken_on} onCancel={onClose} onSave={save} onDelete={x.id ? del : undefined} />
      : <div className="row"><button className="ghost" onClick={onClose}>{t('Close')}</button></div>}
  </Sheet>
}
