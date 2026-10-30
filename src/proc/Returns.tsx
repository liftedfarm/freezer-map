import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Pallet } from '../types'
import type { ProcApi, PData } from './api'
import { metrcRun } from '../metrcCall'
import { TagInput } from '../taginput'
import { NumIn, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'

// Processor returns (117). Receive the processor's METRC delivery, not the lot: every package on the manifest becomes a dry
// package at the manifest (dry) weight, linked to the wet lot it came from (METRC source package = our wet tag). The wet lot
// closes with its yield unless "More coming". Every return goes onto our own tag: once the label is on, the tag is
// confirmed and METRC makes the new package from theirs.

interface Line { id: number; tag: string; item: string | null; strain: string | null; qty: number; uom: string; wet_lot_id: number | null; match: 'source' | 'strain' | null; source_labels?: string[] }
interface Delivery { license: string; site: string; delivery_id?: number; manifest?: string; from?: string; from_license?: string; departed?: string; arrival?: string; driver?: string; items?: Line[]; error?: string }
interface Lot { id: number; code: string; strain: string | null; lbs: number | null; tag: string | null; processor: string | null; sent_on: string | null }
interface Edit { wet_lot_id: number | null; our_tag: string; reweigh: number | null; more_coming: boolean }

const n0 = (x: number | null | undefined) => (x == null || !isFinite(Number(x)) ? '' : Math.round(Number(x)).toLocaleString())
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const ageDays = (iso?: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0)
export const OVERDUE_DAYS = 2

/** Deliveries from processors waiting in METRC, with Receive */
export function ComingBack({ sb, api, flash, reload, isAdmin }: { sb: SupabaseClient; api: ProcApi; flash: Flash; reload: () => Promise<void>; isAdmin: boolean }) {
  const [rows, setRows] = useState<Delivery[] | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [ed, setEd] = useState<Record<string, Edit>>({})
  const load = async () => {
    setBusy('Asking METRC…')
    try {
      const r = await metrcRun<{ live: boolean; deliveries: Delivery[]; lots: Lot[] }>(sb, { action: 'proc_returns' })
      setRows(r.deliveries); setLots(r.lots ?? []); setLive(r.live)
      const e: Record<string, Edit> = {}
      for (const d of r.deliveries) for (const i of d.items ?? []) e[i.tag] = { wet_lot_id: i.wet_lot_id, our_tag: '', reweigh: null, more_coming: false }
      setEd(e)
    } catch (err) { flash(errText(err), true); setRows([]) } finally { setBusy(null) }
  }
  useEffect(() => { load() }, [])
  const set = (tag: string, p: Partial<Edit>) => setEd(x => ({ ...x, [tag]: { ...x[tag], ...p } }))
  async function suggest(d: Delivery) {
    const items = d.items ?? []
    const empty = items.filter(i => !ed[i.tag]?.our_tag)
    if (!empty.length) return
    const tags = await api.nextTags(d.site, empty.length).catch(() => [] as string[])
    empty.forEach((i, k) => { if (tags[k]) set(i.tag, { our_tag: tags[k] }) })
  }
  async function receive(d: Delivery) {
    const items = d.items ?? []
    const noLot = items.filter(i => !ed[i.tag]?.wet_lot_id)
    const tags = items.map(i => ed[i.tag]?.our_tag.trim()).filter(Boolean)
    if (new Set(tags).size !== tags.length) { flash('The same tag is on two packages', true); return }
    const msg = [
      live ? `Receive manifest ${d.manifest} from ${d.from} in METRC (${items.length} packages, ${n0(items.reduce((a, i) => a + Number(i.qty), 0))} lb)?` : `Dry run: check that METRC would take manifest ${d.manifest}? Nothing changes until Compliance goes Live.`,
      noLot.length ? `${noLot.length} package${noLot.length === 1 ? ' has' : 's have'} no wet lot (flagged to check).` : '',
      tags.length ? `${tags.length} go${tags.length === 1 ? 'es' : ''} straight onto our tag in METRC (labels on).` : '',
      tags.length < items.length ? `${items.length - tags.length} wait${items.length - tags.length === 1 ? 's' : ''} for our tag (Needs our tag).` : '',
    ].filter(Boolean).join('\n')
    if (!confirm(msg)) return
    setBusy(`Receiving ${d.manifest}…`)
    try {
      const r = await metrcRun<{ ok: boolean; info: string; live: boolean; app?: { closed?: { code: string; wet: number; dry: number; yield_pct: number | null }[] }; sent?: { id: number; state: string; error?: string; info?: string }[] }>(sb, {
        action: 'proc_return_receive', license: d.license, delivery_id: d.delivery_id,
        lines: items.map(i => ({ tag: i.tag, wet_lot_id: ed[i.tag]?.wet_lot_id ?? null, our_tag: ed[i.tag]?.our_tag.trim() || null, reweigh: ed[i.tag]?.reweigh ?? null, more_coming: !!ed[i.tag]?.more_coming })),
      })
      const closed = (r.app?.closed ?? []).map(c => `${c.code} ${c.yield_pct ?? '?'}%`).join(', ')
      const bad = (r.sent ?? []).filter(x => x.state !== 'sent' && x.state !== 'checked' && x.state !== 'skipped')
      flash([r.info, closed ? `Yield: ${closed}` : '', bad.length ? `METRC retag problem: ${bad.map(b => `#${b.id} ${b.error ?? b.info ?? b.state}`).join('; ')}` : ''].filter(Boolean).join(' · '), !r.ok || bad.length > 0)
      if (r.live && r.ok) { await reload(); await load() }
    } catch (err) { flash(errText(err), true) } finally { setBusy(null) }
  }
  const ok = (rows ?? []).filter(d => !d.error)
  const errs = (rows ?? []).filter(d => d.error)
  return <>
    <h3 className="csec row between"><span>Coming back from processors <span className="muted">{ok.length || ''}</span></span>
      <span className="row"><span className={`pill ${live ? 'm-bad' : 'm-warn'}`}>{live ? 'METRC Live' : 'Dry run'}</span><button className="ghost small" disabled={!!busy} onClick={load}>{busy ?? 'Refresh'}</button></span></h3>
    {errs.map(d => <p key={d.license} className="neg small">{d.site} {d.license}: {d.error}</p>)}
    {rows && !ok.length && !busy && <p className="muted">No processor deliveries waiting in METRC.</p>}
    {ok.map(d => { const key = `${d.license}${d.delivery_id}`, items = d.items ?? [], isOpen = open === key
      return <div key={key} className="card">
        <div className="row between wrap">
          <div><b>{d.from}</b> <span className="muted">manifest</span> <b>{d.manifest}</b>
            <div className="muted small">to {d.site} · left {when(d.departed)}{d.driver ? ` · ${d.driver}` : ''}</div>
            <div className="small">{items.length} package{items.length === 1 ? '' : 's'} · {n0(items.reduce((a, i) => a + Number(i.qty), 0))} lb</div></div>
          <div className="row">
            <button className={isOpen ? 'ghost small' : 'primary small'} onClick={() => { setOpen(isOpen ? null : key); if (!isOpen) suggest(d) }}>{isOpen ? 'Hide' : 'Open'}</button>
          </div>
        </div>
        {isOpen && <>
          <div className="cwrap fit"><table className="ctable">
            <thead><tr><th>Their tag</th><th>METRC item</th><th className="num">Lbs</th><th>Wet lot</th><th>Our tag (label on)</th><th className="num">Reweigh</th><th>More coming</th></tr></thead>
            <tbody>{items.map(i => { const e = ed[i.tag] ?? { wet_lot_id: null, our_tag: '', reweigh: null, more_coming: false }
              const lot = lots.find(l => l.id === e.wet_lot_id)
              const off = e.reweigh != null && Math.abs(e.reweigh - Number(i.qty)) > 0.5
              return <tr key={i.tag}>
                <td className="mono small">…{i.tag.slice(-6)}</td>
                <td className="small">{i.item}{lot && i.strain && lot.strain && !i.item?.toLowerCase().includes(lot.strain.toLowerCase()) ? <div className="warn-t small">Their item doesn't say {lot.strain}</div> : null}</td>
                <td className="num">{n0(i.qty)}</td>
                <td><select value={e.wet_lot_id ?? ''} onChange={x => set(i.tag, { wet_lot_id: x.target.value ? Number(x.target.value) : null })}>
                  <option value="">No wet lot</option>
                  {lots.map(l => <option key={l.id} value={l.id}>{l.code} {l.strain} · {n0(l.lbs)} wet · {l.processor ?? ''}</option>)}</select>
                  {e.wet_lot_id ? <div className="muted small">{i.match === 'source' && e.wet_lot_id === i.wet_lot_id ? 'METRC: came from this lot' : i.match === 'strain' && e.wet_lot_id === i.wet_lot_id ? 'Same strain (check)' : 'Picked'}</div> : <div className="warn-t small">Pick the wet lot</div>}</td>
                <td><TagInput compact value={e.our_tag} onChange={v => set(i.tag, { our_tag: v })} where={{ site: d.site, purpose: 'processing' }} placeholder="Blank = label later" /></td>
                <td className="num"><NumIn value={e.reweigh} onChange={v => set(i.tag, { reweigh: v })} placeholder="optional" />{off ? <div className="warn-t small">Off by {n0((e.reweigh ?? 0) - Number(i.qty))}</div> : null}</td>
                <td><input type="checkbox" checked={e.more_coming} onChange={x => set(i.tag, { more_coming: x.target.checked })} /></td>
              </tr> })}</tbody>
          </table></div>
          <p className="muted small">Lands at the manifest weight. Wet lots close with their yield unless More coming is ticked. A tag here means the label is on: METRC moves it onto our tag right away. Leave it blank to label later (Needs our tag).</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {isAdmin ? <button className="primary" disabled={!!busy} onClick={() => receive(d)}>{busy ?? (live ? 'Receive' : 'Check (dry run)')}</button>
              : <span className="muted small">A Processing Admin receives these.</span>}
          </div>
        </>}
      </div> })}
  </>
}

/** Back on the processor's tag: put our label on, confirm the tag, METRC makes the new package */
export function NeedsOurTag({ d, api, sb, flash, reload, isAdmin, openPkg }: { d: PData; api: ProcApi; sb: SupabaseClient; flash: Flash; reload: () => Promise<void>; isAdmin: boolean; openPkg: (p: Pallet) => void }) {
  const rows = useMemo(() => d.pallets.filter(p => p.their_tag && (p.status === 'in_freezer' || p.status === 'unslotted')), [d])
  const [tags, setTags] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const lot = (id?: number | null) => d.pallets.find(p => p.id === id)
  async function confirmTag(p: Pallet) {
    const t = (tags[p.id] ?? '').trim()
    if (!t) { flash('Enter our tag (the label you put on)', true); return }
    if (!confirm(`${p.code}: our label ${t} is on the package?\nMETRC makes a new package on ${t} from ${p.package_tag} (${n0(p.current_weight)} lb) and finishes theirs.`)) return
    setBusy(p.id)
    try {
      await api.retag(p.id, t)
      const k = await metrcRun<{ results?: { id: number; state: string; error?: string; info?: string }[] }>(sb, { action: 'kick' }).catch(() => null)
      const bad = (k?.results ?? []).filter(x => x.state === 'error')
      flash(bad.length ? `On our tag in the app. METRC: ${bad.map(b => `#${b.id} ${b.error ?? b.info}`).join('; ')}` : `${p.code} is on ${t}.`, bad.length > 0)
      await reload()
    } catch (e) { flash(errText(e), true) } finally { setBusy(null) }
  }
  if (!rows.length) return null
  return <>
    <h3 className="csec">Needs our tag <span className="muted">{rows.length}</span></h3>
    <div className="cwrap fit"><table className="ctable">
      <thead><tr><th>Package</th><th>Strain</th><th className="num">Lbs</th><th className="hide-s">Their tag</th><th className="hide-s">Wet lot</th><th>Back</th><th>Our tag</th><th /></tr></thead>
      <tbody>{rows.map(p => { const age = ageDays(p.returned_at), late = age > OVERDUE_DAYS, w = lot(p.wet_lot_id)
        return <tr key={p.id}>
          <td className="tap" onClick={() => openPkg(p)}><b>{p.code}</b></td><td>{p.strain}</td><td className="num">{n0(p.current_weight)}</td>
          <td className="hide-s mono small">…{(p.package_tag ?? '').slice(-6)}</td>
          <td className="hide-s small">{w ? `${w.code}${w.status === 'at_processor' ? ' (open)' : ''}` : <span className="warn-t">none</span>}</td>
          <td className={late ? 'neg small' : 'muted small'}>{Math.floor(age)}d{late ? ' · overdue' : ''}</td>
          <td>{isAdmin ? <TagInput compact value={tags[p.id] ?? ''} onChange={v => setTags(x => ({ ...x, [p.id]: v }))} where={{ pallet: p.id, purpose: 'processing' }} placeholder="Label you put on" /> : null}</td>
          <td>{isAdmin ? <button className="primary small" disabled={busy != null} onClick={() => confirmTag(p)}>{busy === p.id ? '…' : 'Label is on'}</button> : null}</td>
        </tr> })}</tbody>
    </table></div>
    <p className="muted small">More than {OVERDUE_DAYS} days on the processor's tag is overdue.</p>
  </>
}

/** close a wet lot out at a processor (everything came back): yield = dry back / wet sent */
export function CloseLotButton({ p, d, api, flash, reload }: { p: Pallet; d: PData; api: ProcApi; flash: Flash; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const back = d.pallets.filter(x => x.wet_lot_id === p.id)
  const dry = back.reduce((a, x) => a + Number(x.og_weight ?? x.current_weight ?? 0), 0)
  async function go(e: React.MouseEvent) {
    e.stopPropagation()
    const wet = Number(p.og_weight ?? p.current_weight ?? 0)
    if (!confirm(back.length ? `Close ${p.code}? ${n0(dry)} lb dry came back from ${n0(wet)} lb wet (${wet ? Math.round(dry / wet * 1000) / 10 : '?'}%).`
      : `Close ${p.code} with nothing back? Its yield will be 0%.`)) return
    setBusy(true)
    try { const r = await api.closeLot(p.id); flash(`${r.code} closed: ${n0(r.dry)} lb from ${n0(r.wet)} lb wet (${r.yield_pct ?? '?'}%)`); await reload() }
    catch (err) { flash(errText(err), true) } finally { setBusy(false) }
  }
  return <button className={back.length ? 'primary small' : 'ghost small'} disabled={busy} onClick={go}>{busy ? '…' : back.length ? `Close lot (${n0(dry)} lb back)` : 'Close lot'}</button>
}
