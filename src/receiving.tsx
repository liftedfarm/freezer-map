import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { metrcRun } from './metrcCall'
import { rpc } from './ship'
import type { AppAlert } from './types'

// 090: Production > Receiving and Nursery > Receiving. Each module takes in its own deliveries.
//  - From 1PN (made in the app): Production counts each line. Match = received (planting receipt, METRC receive to-do).
//    Off = held, and every Nursery Admin gets an alert to fix the manifest in METRC; Nursery presses "Manifest fixed"; Production recounts.
//  - From outside (METRC deliveries to our licenses): count each package; match = Receive in METRC; off = alert + email to them.
//  - Dead or damaged on arrival: received in full, then logged as a loss.

type Flash = (m: string, bad?: boolean) => void
type Mod = 'cultivation' | 'nursery'
interface Line { id: number; plants: number; batch_id: number | null; batch: string; tag: string | null; strain: string }
interface Check { ref: string; site: string; status: 'in_transit' | 'counts_off' | 'recount' | 'received'; counted: { id: number; plants: number; counted: number; name: string; strain: string }[] | null
  dead: number; note: string | null; fix_note: string | null; checked_by: string | null; checked_at: string | null; fixed_at: string | null; received_at: string | null
  order_id: number; so: string | null; strain: string; nursery: string | null; manifest: string | null; shipped_on: string | null; lines: Line[] }
interface Item { id: number; tag: string; item: string | null; strain: string | null; qty: number; uom: string }
interface Delivery { license: string; site: string; delivery_id?: number; manifest?: string; from_license?: string; from?: string; departed?: string; driver?: string; vehicle?: string
  items?: Item[]; error?: string; plants?: boolean }

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const STATUS: Record<string, string> = { in_transit: 'On the way', counts_off: 'Counts off: nursery fixing the manifest', recount: 'Manifest fixed: count again', received: 'Received' }

export function ReceivingView({ sb, module, flash, nurseryLicenses = [] }: { sb: SupabaseClient | null; module: Mod; flash: Flash; nurseryLicenses?: string[] }) {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [alerts, setAlerts] = useState<AppAlert[]>([])
  const [inc, setInc] = useState<Delivery[] | null>(null)
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const load = async () => {
    if (!sb) return
    rpc<Check[]>(sb, 'receiving_list', { p_module: module }, '090_receiving').then(setChecks).catch(e => { flash((e as Error).message, true); setChecks([]) })
    rpc<AppAlert[]>(sb, 'my_alerts', { p_module: module }, '090_receiving').then(setAlerts).catch(() => setAlerts([]))
  }
  const loadMetrc = async () => {
    if (!sb) return
    setBusy('Asking METRC…')
    try { const r = await metrcRun<{ live: boolean; deliveries: Delivery[] }>(sb, { action: 'incoming', module }); setInc(r.deliveries); setLive(r.live) }
    catch (e) { flash((e as Error).message, true); setInc([]) } finally { setBusy(null) }
  }
  useEffect(() => { load(); loadMetrc() }, [module])
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy('Saving…')
    try { await f(); flash(ok); await load() } catch (e) { flash((e as Error).message, true) } finally { setBusy(null) }
  }
  // deliveries the app made from 1PN show under "From 1PN"; METRC's copy of them is left out below
  const appManifests = new Set((checks ?? []).map(c => c.manifest).filter(Boolean))
  const outside = (inc ?? []).filter(d => !d.error && !(d.manifest && appManifests.has(d.manifest)) && !(module === 'cultivation' && nurseryLicenses.includes(d.from_license ?? '')))
  const mine = (checks ?? []).filter(c => module === 'cultivation' ? true : c.status === 'counts_off' || c.status === 'recount' || c.status === 'in_transit')
  return <div className="list receiving">
    <div className="row between wrap toolbar"><h2>Receiving</h2>
      <div className="row">{inc && <span className={`pill ${live ? 'm-bad' : 'm-warn'}`}>{live ? 'METRC Live' : 'Dry run'}</span>}
        <button className="ghost small" disabled={!!busy} onClick={() => { load(); loadMetrc() }}>{busy ?? 'Refresh'}</button></div></div>
    <p className="muted">{module === 'cultivation'
      ? 'Clones and plants coming to OHR and GVR. Count what came off the truck against the manifest. If it matches, receive it. If not, the nursery is told to fix the manifest first. Dead or damaged plants: receive the full count, then they\'re logged as a loss.'
      : 'Deliveries to 1PN, and nursery deliveries Production counted short or over: fix the manifest in METRC, then press Manifest fixed.'}</p>

    {alerts.length > 0 && <section className="dcard alerts">
      {alerts.map(a => <div key={a.id} className="alertrow">
        <div className="row between"><b>{a.title}</b><button className="linkbtn" onClick={() => run(() => rpc(sb, 'alert_done', { p_id: a.id }, '090_receiving'), 'Done')}>Done</button></div>
        {a.body && <div className="small pre">{a.body}</div>}
        <div className="muted small">{when(a.created_at)}{a.created_by ? ` · ${a.created_by}` : ''}</div>
      </div>)}
    </section>}

    <h3>From 1PN {mine.length > 0 && <span className="muted">{mine.filter(c => c.status !== 'received').length}</span>}</h3>
    {checks && !mine.length && <p className="muted">Nothing on the way.</p>}
    {mine.map(c => module === 'cultivation'
      ? <CountCard key={c.ref} c={c} busy={!!busy} onCount={async (counts, dead, note) => {
          setBusy('Saving…')
          try {
            const r = await rpc<{ status: string; off?: string }>(sb, 'delivery_count', { p_ref: c.ref, p_counts: counts, p_dead: dead, p_note: note || null }, '090_receiving')
            flash(r.status === 'counts_off' ? `Counts off. The nursery has been told to fix the manifest (${(r.off ?? '').trim()}). It stays here until they do.` : `Received ${c.strain} at ${c.site}`)
            await load()
          } catch (e) { flash((e as Error).message, true) } finally { setBusy(null) }
        }} />
      : <FixCard key={c.ref} c={c} busy={!!busy} onFixed={(note, counts) => run(() => rpc(sb, 'delivery_fixed', { p_ref: c.ref, p_note: note || null, p_counts: counts }, '090_receiving'), 'Production has been told to recount')} />)}

    <h3>From outside {outside.length > 0 && <span className="muted">{outside.length}</span>}</h3>
    {inc && !outside.length && !busy && <p className="muted">Nothing incoming from outside.</p>}
    {(inc ?? []).filter(d => d.error).map(d => <p key={d.license} className="neg small">{d.site} {d.license}: {d.error}</p>)}
    {outside.map(d => <OutsideCard key={`${d.license}${d.delivery_id}`} d={d} live={live} busy={!!busy} module={module}
      onReceive={(dead) => run(async () => {
        const r = await metrcRun<{ ok: boolean; info: string }>(sb!, { action: 'inbound_receive', license: d.license, delivery_id: d.delivery_id, module })
        if (!r.ok) throw new Error(r.info)
        if (live && module === 'cultivation') await rpc(sb, 'outside_plants_received', { p_site: d.site, p_manifest: d.manifest, p_from: d.from, p_lines: (d.items ?? []).map(i => ({ strain: i.strain, tag: i.tag, qty: i.qty })), p_dead: dead }, '090_receiving')
        await loadMetrc()
      }, live ? `Received manifest ${d.manifest}` : 'Dry run OK (nothing received until Compliance goes Live)')}
      onOff={(lines, email, note) => run(async () => {
        const r = await rpc<{ emailed: boolean }>(sb, 'outside_counts_off', { p_module: module, p_license: d.license, p_manifest: d.manifest ?? null, p_from: d.from ?? null,
          p_from_license: d.from_license ?? null, p_email: email || null, p_lines: lines, p_note: note || null }, '090_receiving')
        if (!r.emailed) flash('No email for them: call them to fix the manifest.', true)
      }, email ? `Counts off: ${d.from} will get an email once email sending is set up` : 'Counts off: noted')} />)}
  </div>
}

function CountCard({ c, busy, onCount }: { c: Check; busy: boolean; onCount: (counts: { id: number; counted: number }[], dead: number, note: string) => void }) {
  const [n, setN] = useState<Record<number, string>>({})
  const [dead, setDead] = useState('')
  const [note, setNote] = useState('')
  const open = c.status === 'in_transit' || c.status === 'recount'
  const all = c.lines.every(l => n[l.id] !== undefined && n[l.id] !== '')
  return <div className={`card rc-${c.status}`}>
    <div className="row between wrap">
      <div><b>{c.strain}</b> <span className="muted">to {c.site}{c.so ? ` · ${c.so}` : ''}{c.manifest ? ` · manifest ${c.manifest}` : ''}{c.shipped_on ? ` · shipped ${c.shipped_on}` : ''}</span></div>
      <span className={`pill ${c.status === 'received' ? 'm-ok' : c.status === 'counts_off' ? 'm-bad' : 'm-warn'}`}>{STATUS[c.status]}</span>
    </div>
    {c.status === 'recount' && c.fix_note && <div className="small">Nursery: {c.fix_note}</div>}
    {c.status === 'counts_off' && c.counted && <div className="small warn-t">{c.counted.filter(x => x.counted !== x.plants).map(x => `${x.name}: manifest ${x.plants}, counted ${x.counted}`).join(' · ')}</div>}
    {open && <>
      {c.lines.map(l => <div key={l.id} className="row between countrow">
        <span><b>{l.batch}</b> <span className="muted">{l.strain}{l.tag ? ` · ${l.tag.slice(-8)}` : ''}</span></span>
        <span className="row"><span className="muted small">manifest {l.plants}</span>
          <input type="number" min="0" inputMode="numeric" placeholder="counted" value={n[l.id] ?? ''} onChange={e => setN(x => ({ ...x, [l.id]: e.target.value }))} style={{ width: 90 }} /></span>
      </div>)}
      <div className="grid2">
        <div className="field"><label>Dead or damaged (received, logged as a loss)</label><input type="number" min="0" value={dead} onChange={e => setDead(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Note</label><input value={note} onChange={e => setNote(e.target.value)} /></div>
      </div>
      <div className="row end">
        <button className="ghost small" disabled={busy} onClick={() => setN(Object.fromEntries(c.lines.map(l => [l.id, String(l.plants)])))}>Counts match the manifest</button>
        <button className="primary" disabled={busy || !all} onClick={() => onCount(c.lines.map(l => ({ id: l.id, counted: Number(n[l.id]) })), Number(dead) || 0, note)}>Receive</button>
      </div>
    </>}
  </div>
}

function FixCard({ c, busy, onFixed }: { c: Check; busy: boolean; onFixed: (note: string, counts: { id: number; plants: number }[] | null) => void }) {
  const [note, setNote] = useState('')
  const [useCounted, setUseCounted] = useState(true)
  return <div className={`card rc-${c.status}`}>
    <div className="row between wrap">
      <div><b>{c.strain}</b> <span className="muted">to {c.site}{c.so ? ` · ${c.so}` : ''}{c.manifest ? ` · manifest ${c.manifest}` : ''}</span></div>
      <span className={`pill ${c.status === 'counts_off' ? 'm-bad' : 'm-warn'}`}>{STATUS[c.status]}</span>
    </div>
    {c.status === 'in_transit' && <div className="muted small">Waiting for Production to count it.</div>}
    {c.status === 'recount' && <div className="muted small">Production is recounting.</div>}
    {c.status === 'counts_off' && c.counted && <>
      {c.counted.map(x => <div key={x.id} className={`small ${x.counted !== x.plants ? 'warn-t' : ''}`}>{x.name} ({x.strain}): manifest {x.plants}, Production counted {x.counted}</div>)}
      {c.note && <div className="small">Production: {c.note}</div>}
      <label className="check"><input type="checkbox" checked={useCounted} onChange={e => setUseCounted(e.target.checked)} /> I changed the manifest to Production's counts (the app's delivery changes to match)</label>
      <div className="field"><label>Note for Production</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. manifest updated, 2 short" /></div>
      <div className="row end"><button className="primary" disabled={busy} onClick={() => onFixed(note, useCounted ? c.counted!.map(x => ({ id: x.id, plants: x.counted })) : null)}>Manifest fixed</button></div>
    </>}
  </div>
}

function OutsideCard({ d, live, busy, module, onReceive, onOff }: { d: Delivery; live: boolean; busy: boolean; module: Mod
  onReceive: (dead: number) => void; onOff: (lines: { item: string | null; tag: string; qty: number; counted: number }[], email: string, note: string) => void }) {
  const [n, setN] = useState<Record<string, string>>({})
  const [dead, setDead] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const items = d.items ?? []
  const all = items.every(i => n[i.tag] !== undefined && n[i.tag] !== '')
  const off = items.filter(i => n[i.tag] !== undefined && n[i.tag] !== '' && Number(n[i.tag]) !== Number(i.qty))
  return <div className="card">
    <div><b>{d.manifest}</b> <span className="muted">from</span> <b>{d.from}</b> <span className="muted small">{d.from_license}</span>
      <div className="muted small">to {d.site} {d.license} · left {when(d.departed)}{d.driver ? ` · ${d.driver}` : ''}{d.vehicle ? ` · ${d.vehicle}` : ''}</div></div>
    {items.map(i => <div key={i.tag} className="row between countrow">
      <span><b>{i.item}</b> <span className="muted mono small">{i.tag.slice(-8)}</span></span>
      <span className="row"><span className="muted small">manifest {i.qty} {i.uom}</span>
        <input type="number" min="0" placeholder="counted" value={n[i.tag] ?? ''} onChange={e => setN(x => ({ ...x, [i.tag]: e.target.value }))} style={{ width: 90 }} /></span>
    </div>)}
    {module === 'cultivation' && d.plants !== false && <div className="field"><label>Dead or damaged (received, logged as a loss)</label><input type="number" min="0" value={dead} onChange={e => setDead(e.target.value)} placeholder="0" /></div>}
    {off.length > 0 && <div className="warnbox small">
      Counts don't match: {off.map(i => `${i.item}: ${i.qty} vs ${n[i.tag]}`).join(' · ')}. Tell them to fix the manifest before receiving.
      <div className="field"><label>Their email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="sent once email is set up" /></div>
      <div className="field"><label>Note</label><input value={note} onChange={e => setNote(e.target.value)} /></div>
      <div className="row end"><button className="primary small" disabled={busy} onClick={() => onOff(items.map(i => ({ item: i.item, tag: i.tag, qty: Number(i.qty), counted: Number(n[i.tag] ?? i.qty) })), email, note)}>Counts off: tell them</button></div>
    </div>}
    <div className="row end">
      <button className="ghost small" disabled={busy} onClick={() => setN(Object.fromEntries(items.map(i => [i.tag, String(i.qty)])))}>Counts match the manifest</button>
      <button className="primary" disabled={busy || !all || off.length > 0} onClick={() => onReceive(Number(dead) || 0)}>{live ? 'Receive' : 'Check (dry run)'}</button>
    </div>
  </div>
}
