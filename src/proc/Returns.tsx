import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Pallet } from '../types'
import type { ProcApi, PData } from './api'
import { metrcRun } from '../metrcCall'
import { TagInput } from '../taginput'
import { NumIn, Sheet, errText } from '../cult/ui'
import type { Flash } from '../cult/ui'

// Processor returns (117, 118).
//  Processing > Inbound: the only place they're received in METRC. Whoever unloads opens the manifest; every package gets a
//  spot (required), our tag and a reweigh if they want. The wet lot is linked only when METRC's source package is our wet tag.
//  Needs our tag: packages still on the processor's tag; label on > METRC new package on ours.
//  Processing > Drying (lot accounting, never METRC): per wet lot, Receive back (link / unlink what came back) and Close lot.

interface Line { id: number; tag: string; item: string | null; strain: string | null; qty: number; uom: string; wet_lot_id: number | null; wet_lot: string | null }
interface Delivery { license: string; site: string; delivery_id?: number; manifest?: string; from?: string; from_license?: string; departed?: string; arrival?: string; driver?: string; items?: Line[]; error?: string }
interface Spot { id: number; code: string; kind: string; label: string; cap: number; used: number; holds: string | null }
interface Edit { slot_id: number | null; our_tag: string; reweigh: number | null }

const n0 = (x: number | null | undefined) => (x == null || !isFinite(Number(x)) ? '' : Math.round(Number(x)).toLocaleString())
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const ageDays = (iso?: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0)
export const OVERDUE_DAYS = 2

/** Deliveries from processors waiting in METRC, with Receive (Processing > Inbound) */
export function ComingBack({ sb, api, flash, reload, isAdmin }: { sb: SupabaseClient; api: ProcApi; flash: Flash; reload: () => Promise<void>; isAdmin: boolean }) {
  const [rows, setRows] = useState<Delivery[] | null>(null)
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [ed, setEd] = useState<Record<string, Edit>>({})
  const [spots, setSpots] = useState<Record<string, Spot[]>>({})
  const load = async () => {
    setBusy('Asking METRC…')
    try {
      const r = await metrcRun<{ live: boolean; deliveries: Delivery[] }>(sb, { action: 'proc_returns' })
      setRows(r.deliveries); setLive(r.live)
      const e: Record<string, Edit> = {}
      for (const d of r.deliveries) for (const i of d.items ?? []) e[i.tag] = { slot_id: null, our_tag: '', reweigh: null }
      setEd(e)
    } catch (err) { flash(errText(err), true); setRows([]) } finally { setBusy(null) }
  }
  useEffect(() => { load() }, [])
  const set = (tag: string, p: Partial<Edit>) => setEd(x => ({ ...x, [tag]: { ...x[tag], ...p } }))
  const loadSpots = async (site: string) => {
    const { data, error } = await sb.rpc('proc_open_spots', { p_site: site })
    if (error) { flash(error.message, true); return }
    setSpots(x => ({ ...x, [site]: (data ?? []) as Spot[] }))
  }
  /** room left in a spot, counting what this delivery already put there */
  const left = (d: Delivery, s: Spot, except?: string) => s.cap - s.used - (d.items ?? []).filter(i => i.tag !== except && ed[i.tag]?.slot_id === s.id).length
  function fillSpots(d: Delivery) {
    const list = spots[d.site] ?? []
    const taken = new Map<number, number>()
    for (const i of d.items ?? []) { const id = ed[i.tag]?.slot_id; if (id) taken.set(id, (taken.get(id) ?? 0) + 1) }
    const next: Record<string, Edit> = { ...ed }
    for (const i of d.items ?? []) {
      if (next[i.tag]?.slot_id) continue
      // an empty spot first (no stacking unless the site is full), reefers before freezers
      const s = list.find(x => x.used === 0 && !taken.get(x.id)) ?? list.find(x => x.cap - x.used - (taken.get(x.id) ?? 0) > 0)
      if (!s) break
      taken.set(s.id, (taken.get(s.id) ?? 0) + 1)
      next[i.tag] = { ...next[i.tag], slot_id: s.id }
    }
    setEd(next)
  }
  async function suggestTags(d: Delivery) {
    const empty = (d.items ?? []).filter(i => !ed[i.tag]?.our_tag)
    if (!empty.length) return
    const tags = await api.nextTags(d.site, empty.length).catch(() => [] as string[])
    empty.forEach((i, k) => { if (tags[k]) set(i.tag, { our_tag: tags[k] }) })
  }
  async function receive(d: Delivery) {
    const items = d.items ?? []
    if (items.some(i => !ed[i.tag]?.slot_id)) { flash('Pick a spot for every package', true); return }
    const tags = items.map(i => ed[i.tag]?.our_tag.trim()).filter(Boolean)
    if (new Set(tags).size !== tags.length) { flash('The same tag is on two packages', true); return }
    const msg = [
      live ? `Receive manifest ${d.manifest} from ${d.from} in METRC (${items.length} packages, ${n0(items.reduce((a, i) => a + Number(i.qty), 0))} lb)?` : `Dry run: check that METRC would take manifest ${d.manifest}? Nothing changes until Compliance goes Live.`,
      tags.length ? `${tags.length} go${tags.length === 1 ? 'es' : ''} straight onto our tag in METRC (labels on).` : '',
      tags.length < items.length ? `${items.length - tags.length} wait${items.length - tags.length === 1 ? 's' : ''} for our tag (Needs our tag).` : '',
    ].filter(Boolean).join('\n')
    if (!confirm(msg)) return
    setBusy(`Receiving ${d.manifest}…`)
    try {
      const r = await metrcRun<{ ok: boolean; info: string; live: boolean; sent?: { id: number; state: string; error?: string; info?: string }[] }>(sb, {
        action: 'proc_return_receive', license: d.license, delivery_id: d.delivery_id,
        lines: items.map(i => ({ tag: i.tag, slot_id: ed[i.tag]?.slot_id ?? null, our_tag: ed[i.tag]?.our_tag.trim() || null, reweigh: ed[i.tag]?.reweigh ?? null })),
      })
      const bad = (r.sent ?? []).filter(x => x.state !== 'sent' && x.state !== 'checked' && x.state !== 'skipped')
      flash([r.info, bad.length ? `METRC retag problem: ${bad.map(b => `#${b.id} ${b.error ?? b.info ?? b.state}`).join('; ')}` : ''].filter(Boolean).join(' · '), !r.ok || bad.length > 0)
      if (r.live && r.ok) { setOpen(null); await reload(); await load() }
    } catch (err) { flash(errText(err), true) } finally { setBusy(null) }
  }
  const ok = (rows ?? []).filter(d => !d.error)
  const errs = (rows ?? []).filter(d => d.error)
  return <>
    <h3 className="csec row between"><span>Manifests from processors <span className="muted">{ok.length || ''}</span></span>
      <span className="row"><span className={`pill ${live ? 'm-bad' : 'm-warn'}`}>{live ? 'METRC Live' : 'Dry run'}</span><button className="ghost small" disabled={!!busy} onClick={load}>{busy ?? 'Refresh'}</button></span></h3>
    {errs.map(d => <p key={d.license} className="neg small">{d.site} {d.license}: {d.error}</p>)}
    {rows && !ok.length && !busy && <p className="muted">No processor manifests waiting in METRC.</p>}
    {ok.map(d => { const key = `${d.license}${d.delivery_id}`, items = d.items ?? [], isOpen = open === key, list = spots[d.site] ?? []
      const missing = items.filter(i => !ed[i.tag]?.slot_id).length
      return <div key={key} className="card">
        <div className="row between wrap">
          <div><b>{d.from}</b> <span className="muted">manifest</span> <b>{d.manifest}</b>
            <div className="muted small">to {d.site} · left {when(d.departed)}{d.driver ? ` · ${d.driver}` : ''}</div>
            <div className="small">{items.length} package{items.length === 1 ? '' : 's'} · {n0(items.reduce((a, i) => a + Number(i.qty), 0))} lb</div></div>
          <button className={isOpen ? 'ghost small' : 'primary small'} onClick={() => { setOpen(isOpen ? null : key); if (!isOpen) { loadSpots(d.site); suggestTags(d) } }}>{isOpen ? 'Hide' : 'Open'}</button>
        </div>
        {isOpen && <>
          <div className="cwrap fit"><table className="ctable">
            <thead><tr><th>Their tag</th><th>METRC item</th><th className="num">Lbs</th><th>Spot</th><th>Our tag <span className="muted">(label on)</span></th><th className="num">Reweigh</th><th className="hide-s">Wet lot</th></tr></thead>
            <tbody>{items.map(i => { const e = ed[i.tag] ?? { slot_id: null, our_tag: '', reweigh: null }
              const off = e.reweigh != null && Math.abs(e.reweigh - Number(i.qty)) > 0.5
              return <tr key={i.tag}>
                <td className="mono small">…{i.tag.slice(-6)}</td>
                <td className="small">{i.item}</td>
                <td className="num">{n0(i.qty)}</td>
                <td><select value={e.slot_id ?? ''} onChange={x => set(i.tag, { slot_id: x.target.value ? Number(x.target.value) : null })} className={e.slot_id ? '' : 'need'}>
                  <option value="">Pick a spot</option>
                  {list.filter(s => s.id === e.slot_id || left(d, s, i.tag) > 0).map(s => <option key={s.id} value={s.id}>{s.label}{s.used || left(d, s, i.tag) < s.cap - s.used ? ' (stack)' : ''}{s.holds ? ` · ${s.holds}` : ''}</option>)}</select></td>
                <td><TagInput compact value={e.our_tag} onChange={v => set(i.tag, { our_tag: v })} where={{ site: d.site, purpose: 'processing' }} placeholder="Optional" /></td>
                <td className="num"><NumIn value={e.reweigh} onChange={v => set(i.tag, { reweigh: v })} placeholder="Optional" />{off ? <div className="warn-t small">Off by {n0((e.reweigh ?? 0) - Number(i.qty))}</div> : null}</td>
                <td className="hide-s small">{i.wet_lot ? <>{i.wet_lot} <span className="muted">(METRC)</span></> : <span className="muted">set in Drying</span>}</td>
              </tr> })}</tbody>
          </table></div>
          <div className="row between wrap">
            <span className="muted small">Lands at the manifest weight in its spot. A tag here means our label is on: METRC moves it onto our tag right away. Blank = Needs our tag.</span>
            <span className="row">
              {missing > 0 && <button className="ghost small" disabled={!list.length} onClick={() => fillSpots(d)}>Fill open spots ({missing})</button>}
              {isAdmin ? <button className="primary" disabled={!!busy || missing > 0} onClick={() => receive(d)}>{busy ?? (missing ? `${missing} need a spot` : live ? 'Receive' : 'Check (dry run)')}</button>
                : <span className="muted small">A Processing Admin receives these.</span>}
            </span>
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
  return <button className={back.length ? 'primary small' : 'ghost small'} disabled={busy} onClick={go}>{busy ? '…' : 'Close lot'}</button>
}

/** Drying > Receive back: put packages that came back toward this wet lot (or take them off). No METRC: they're received in Inbound. */
export function ReceiveBackButton({ p, d, api, flash, reload }: { p: Pallet; d: PData; api: ProcApi; flash: Flash; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="ghost small" onClick={e => { e.stopPropagation(); setOpen(true) }}>Receive back</button>
    {open && <ReceiveBackSheet lot={p} d={d} api={api} flash={flash} reload={reload} onClose={() => setOpen(false)} />}
  </>
}

function ReceiveBackSheet({ lot, d, api, flash, reload, onClose }: { lot: Pallet; d: PData; api: ProcApi; flash: Flash; reload: () => Promise<void>; onClose: () => void }) {
  const live = (x: Pallet) => x.status === 'in_freezer' || x.status === 'unslotted'
  const linked = d.pallets.filter(x => x.wet_lot_id === lot.id)
  const same = (x: Pallet) => (x.strain ?? '').toLowerCase() === (lot.strain ?? '').toLowerCase()
  // came back from a processor (received in Inbound, or by hand) and not on a lot yet
  const cands = d.pallets.filter(x => !x.wet_lot_id && live(x) && x.id !== lot.id && x.product !== 'wet' && (x.returned_at || x.their_tag))
    .sort((a, b) => Number(same(b)) - Number(same(a)) || (b.returned_at ?? '').localeCompare(a.returned_at ?? ''))
  const [pick, setPick] = useState<Set<number>>(() => new Set(cands.filter(same).map(x => x.id)))
  const [busy, setBusy] = useState(false)
  const wet = Number(lot.og_weight ?? lot.current_weight ?? 0)
  const back = linked.reduce((a, x) => a + Number(x.og_weight ?? x.current_weight ?? 0), 0)
  const adding = cands.filter(x => pick.has(x.id)).reduce((a, x) => a + Number(x.og_weight ?? x.current_weight ?? 0), 0)
  async function save() {
    setBusy(true)
    try { for (const id of pick) await api.linkReturn(id, lot.id); flash(`${pick.size} put toward ${lot.code}`); await reload(); onClose() }
    catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  async function unlink(x: Pallet) {
    if (!confirm(`Take ${x.code} off ${lot.code}?`)) return
    setBusy(true)
    try { await api.linkReturn(x.id, null); flash(`${x.code} taken off ${lot.code}`); await reload(); onClose() }
    catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  const row = (x: Pallet) => <><b>{x.code}</b> <span className="muted">{x.strain} · {n0(x.og_weight ?? x.current_weight)} lb · …{(x.package_tag ?? '').slice(-6)}{x.their_tag ? ' (their tag)' : ''}</span></>
  return <Sheet title={`Receive back: ${lot.code} ${lot.strain ?? ''}`} sub={`${n0(wet)} lb wet · ${n0(back)} lb back so far${wet ? ` (${Math.round(back / wet * 1000) / 10}%)` : ''}`} onClose={onClose}>
    <h4 className="subh">On this lot</h4>
    {linked.length ? linked.map(x => <div key={x.id} className="row between noline"><span>{row(x)}</span><button className="ghost small" disabled={busy} onClick={() => unlink(x)}>Take off</button></div>)
      : <p className="muted">Nothing yet.</p>}
    <h4 className="subh">Came back, not on a lot</h4>
    {cands.length ? cands.map(x => <label key={x.id} className="row noline check">
      <input type="checkbox" checked={pick.has(x.id)} onChange={e => setPick(s => { const n = new Set(s); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n })} />
      <span>{row(x)}{same(x) ? '' : <span className="warn-t small"> · different strain</span>}</span></label>)
      : <p className="muted">Nothing waiting. Packages show up here once they're received in Processing › Inbound.</p>}
    <div className="row between csave">
      <span className="muted small">{pick.size ? `Adds ${n0(adding)} lb: ${n0(back + adding)} of ${n0(wet)} wet (${wet ? Math.round((back + adding) / wet * 1000) / 10 : '?'}%)` : ''}</span>
      <span className="row"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !pick.size} onClick={save}>{busy ? '…' : `Put ${pick.size || ''} toward ${lot.code}`}</button></span>
    </div>
  </Sheet>
}

/** "X lb back of Y wet (Z%)" for a wet lot */
export function lotBack(p: Pallet, d: PData) {
  const back = d.pallets.filter(x => x.wet_lot_id === p.id).reduce((a, x) => a + Number(x.og_weight ?? x.current_weight ?? 0), 0)
  const wet = Number(p.og_weight ?? p.current_weight ?? 0)
  return back ? `${n0(back)} lb back (${wet ? Math.round(back / wet * 1000) / 10 : '?'}%)` : null
}
