import { Select } from '../combo'
import { useEffect, useMemo, useState } from 'react'
import type { MAction, MError, Play, PushKind, PushResult, Recon, Upload } from './api'
import type { Ctx } from './ctx'
import { DocList, DropZone, fmtD, today } from './files'
import { LiveReconcile } from './reconlive'
import { NurseryReconcile } from './nurseryrecon'
import { FarmReconcile } from './farmrecon'
import { Mapping } from './mapping'
import { FIELD_LABEL, download, mapColumns, readTable, toCsv, toRows } from './csv'
import type { Field, MRow } from './csv'
import { DateIn, F, Pick, SaveBar, Sheet, TextIn, errText, useSel, SelBox, SelAll, SelBar } from '../cult/ui'

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const short = (t: string | null | undefined) => (t ? (t.length > 10 ? `…${t.slice(-8)}` : t) : '')
const n2 = (x: number | null | undefined) => (x == null ? '' : (Math.round(Number(x) * 100) / 100).toLocaleString())
const PS: Record<NonNullable<MAction['push_state']>, [string, string]> = { checked: ['Dry run OK', 'cp-ok'], sending: ['Sending…', 'cp-warn'], sent: ['Sent by the app', 'cp-ok'], failed: ['Send failed', 'cp-bad'], waiting: ['Waiting', 'cp-mute'], held: ['Held', 'cp-warn'] }
const ST: Record<MAction['status'], [string, string]> = { todo: ['To do', 'cp-warn'], done: ['Done', 'cp-ok'], error: ['Problem', 'cp-bad'], skipped: ['Skipped', 'cp-mute'] }

export function Metrc({ c }: { c: Ctx }) {
  const view = (['todo', 'reconcile', 'mapping', 'errors', 'playbook'] as const).find(v => v === c.sub) ?? 'todo'
  return <div className="list">
    <div className="row between wrap toolbar"><h2>METRC</h2>
      <div className="seg">{([['todo', `To do${c.ov.metrc_todo ? ` (${c.ov.metrc_todo})` : ''}`], ['reconcile', 'Reconcile'], ['mapping', 'Mapping'], ['errors', `Errors${c.ov.errors_open ? ` (${c.ov.errors_open})` : ''}`], ['playbook', 'Playbook']] as const).map(([k, l]) =>
        <button key={k} className={view === k ? 'on' : ''} onClick={() => c.go('metrc', k)}>{l}</button>)}</div></div>
    {view === 'todo' && <Todo c={c} />}
    {view === 'reconcile' && <Reconcile c={c} />}
    {view === 'mapping' && <Mapping c={c} />}
    {view === 'errors' && <Errors c={c} />}
    {view === 'playbook' && <Playbook c={c} />}
  </div>
}

// progress bar on each to-do line
//   plants (harvest, planting, flip): how many plants are in METRC so far
//   waste / finish with a wait: time until it can go
//   everything else: queued, sending, waiting on an earlier to-do, failed, sent
const STEPPED = new Set(['harvest_plants', 'planting', 'flower'])
const STOPPABLE = new Set(['harvest_plants', 'flower'])   // long sends that can stop between batches
const n0b = (x: number) => Math.round(x).toLocaleString()
function MetrcBar({ r, now }: { r: MAction; now: number }) {
  if (r.status === 'skipped') return null
  const prog = (r.push_response as { progress?: { done?: number } } | null | undefined)?.progress
  const total = Number(r.details?.plants ?? 0)
  const done = r.status === 'done' || r.push_state === 'sent'
  const err = r.status === 'error' || r.push_state === 'failed'
  const sending = r.push_state === 'sending'
  const blocked = r.push_state === 'waiting' && /earlier to-do/i.test(r.push_error ?? '')
  let pct = 0, cls = '', left = '', right = ''
  if (r.kind && STEPPED.has(r.kind) && total > 0) {
    const d = done ? total : Math.min(Number(prog?.done ?? 0), total)
    pct = (d / total) * 100
    left = `${n0b(d)} of ${n0b(total)} plants${r.push_state === 'held' ? ' · held' : sending && r.stop_requested ? ' · stopping after this batch' : ''}`
    right = `${Math.floor(pct)}%`
  } else if (done) { pct = 100; left = 'In METRC' }
  else if (r.due_at && new Date(r.due_at).getTime() > now) {
    const a = new Date(r.at).getTime(), b = new Date(r.due_at).getTime()
    pct = Math.max(0, Math.min(100, ((now - a) / Math.max(1, b - a)) * 100)); cls = 'due'
    const m = Math.max(1, Math.ceil((b - now) / 60000))
    left = 'Waiting to send'; right = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`
  } else if (r.push_state === 'held') { pct = 100; cls = 'wait'; left = 'Held: press Release to send' }
  else if (sending) { pct = 100; cls = 'wait'; left = r.stop_requested ? 'Stopping after this batch…' : 'Sending to METRC…' }
  else if (err) { pct = 100; cls = 'bad'; left = 'Stopped' }
  else if (blocked) { pct = 100; cls = 'wait'; left = 'Waiting on an earlier to-do' }
  else if (r.push_state === 'waiting') { pct = 0; left = 'Next run' }
  else left = 'Queued'
  if (STEPPED.has(r.kind ?? '') && total > 0) {
    if (done) cls = ''
    else if (sending && !r.stop_requested) cls = 'go'
    else if (sending || r.push_state === 'held') cls = 'wait'
    else if (err) cls = 'bad'
    else if (blocked) cls = 'wait'
  }
  return <div className={`mbar ${cls}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={left}>
    <div className="mbar-track"><div className="mbar-fill" style={{ width: `${pct}%` }} /></div>
    <div className="mbar-label"><span>{left}</span><span>{right}</span></div>
  </div>
}

// ---------- to do: every app action METRC needs ----------
function Todo({ c }: { c: Ctx }) {
  const [status, setStatus] = useState<string | null>('todo')
  const [lic, setLic] = useState<string | null>(null)
  const [rows, setRows] = useState<MAction[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [kinds, setKinds] = useState<Record<string, PushKind>>({})
  const [live, setLive] = useState(false)
  const sel = useSel()
  const load = async () => { try { setRows(await c.api.actions(status)) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load(); sel.stop() }, [status])
  // while anything is on its way to METRC, refresh every 5 seconds so the bars move
  const [now, setNow] = useState(Date.now())
  const moving = (rows ?? []).some(r => (r.status === 'todo' || r.status === 'error') && (r.push_state === 'sending' || r.push_state === 'waiting'))
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); if (moving && !document.hidden) load() }, moving ? 5000 : 60000)
    return () => clearInterval(t)
  }, [moving, status])
  useEffect(() => {
    c.api.pushKinds().then(k => setKinds(Object.fromEntries(k.map(x => [x.kind, x])))).catch(() => {})
    c.api.sb.from('app_settings').select('value').eq('key', 'comp.metrc_live').maybeSingle().then(r => setLive(r.data?.value === 'true'))
  }, [])
  const sendable = (r: MAction) => (r.status === 'todo' || r.status === 'error') && r.push_state !== 'sending' && r.push_state !== 'held' && !!r.kind && !!kinds[r.kind]?.ready && kinds[r.kind]?.mode !== 'off'
  async function push(ids: number[]) {
    const go = ids.filter(id => { const r = rows?.find(x => x.id === id); return r && sendable(r) })
    if (!go.length) { c.flash('None of those can be sent by the app (turn the kind on in Settings > METRC through T3)', true); return }
    if (live && !confirm(`Send ${go.length} to METRC for real?`)) return
    setBusy(true)
    try {
      const r = await c.api.sendMetrc(go)
      const n = (s: PushResult['state']) => r.results.filter(x => x.state === s).length
      const first = r.results.find(x => x.state === 'failed')
      const held = (r.not_sent?.length ? `. ${r.not_sent.length} not sent (kind off, or before the site's METRC cutover date)` : '')
        + (r.out_of_time?.length ? `. ${r.out_of_time.length} not reached yet: Auto ones go on the next run; send the others again` : '')
      c.flash((r.live ? `${n('sent')} sent, ${n('failed')} failed${n('waiting') ? `, ${n('waiting')} waiting` : ''}${first ? `: ${first.error}` : ''}`
        : `Dry run: ${n('checked')} OK, ${n('failed')} failed${n('waiting') ? `, ${n('waiting')} waiting` : ''}${first ? `: ${first.error}` : ''}`) + held, n('failed') > 0)
      sel.stop(); await load(); await c.reload()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const shown = (rows ?? []).filter(r => !lic || r.license === lic)
  const lics = [...new Set((rows ?? []).map(r => r.license ?? ''))].sort()
  async function setTo(s: MAction['status'], ids: number[]) {
    let note: string | undefined
    if (s === 'error') { note = prompt('What went wrong? (optional)') ?? undefined }
    setBusy(true)
    try { const n = await c.api.setActions(ids, s, note); c.flash(`${n} marked ${ST[s][0].toLowerCase()}`); sel.stop(); await load(); await c.reload() } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  // one Stop button; what it does depends on where the to-do is (see metrc_stop)
  const stoppable = (r: MAction) => (r.status === 'todo' || r.status === 'error') && !!r.kind && r.push_state !== 'held' && !r.stop_requested
    && (r.push_state !== 'sending' || STOPPABLE.has(r.kind))
  async function stop(r: MAction) {
    const reopen = r.kind === 'harvest_waste' || r.kind === 'harvest_finish'
    const ask = reopen ? `Stop the waste and finish for ${String(r.details?.batch ?? 'this harvest')} and reopen the harvest in the app?\n\nFix it, then press Finish again (that starts a new wait).`
      : r.push_state === 'sending' ? 'Stop after the batch it is on? What is already in METRC stays. Release carries on from there.'
      : 'Hold this one? It won\'t go to METRC (and nothing that depends on it will) until you press Release.'
    if (!confirm(ask)) return
    setBusy(true)
    try {
      const res = await c.api.stopMetrc(r.id)
      c.flash(res.startsWith('reopened') ? `Harvest reopened; its waste and finish are cancelled${res.length > 9 ? `. ${res.slice(10)}` : ''}`
        : res === 'stopping' ? 'Stopping after the batch it is on' : 'Held', res.length > 9)
      await load(); await c.reload()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function release(r: MAction) {
    setBusy(true)
    try { await c.api.releaseMetrc(r.id); c.flash(kinds[r.kind ?? '']?.mode === 'auto' ? 'Released: goes on the next run' : 'Released: press Send when ready'); await load() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const exportCsv = () => download(`METRC to do ${today()}.csv`, toCsv(['When', 'License', 'Action', 'Package', 'Tag', 'Lbs', 'Details', 'Status', 'Note'],
    shown.map(r => [when(r.at), r.license, r.action, r.code, r.tag, r.lbs, r.summary, ST[r.status][0], r.note])))
  const ids = shown.map(r => r.id)
  return <>
    <p className="muted">Everything done in the app that also has to be done in METRC (new packages, splits, combines, weight changes, runs, transfers), from when Compliance was switched on. Check them off once they're in METRC.</p>
    <div className="row wrap toolbar">
      <div className="chips">{([['todo', 'To do'], ['error', 'Problem'], ['done', 'Done'], ['skipped', 'Skipped'], [null, 'All']] as const).map(([k, l]) =>
        <button key={l} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      <Select value={lic ?? ''} onChange={e => setLic(e.target.value || null)} aria-label="License"><option value="">All licenses</option>{lics.map(l => <option key={l} value={l}>{l || 'no license'}</option>)}</Select>
      <button className="ghost small" disabled={!shown.length} onClick={exportCsv}>Export CSV</button>
      {c.canEdit && shown.length > 0 && (sel.on ? <button className="ghost small" onClick={sel.stop}>Done selecting</button> : <button className="ghost small" onClick={sel.start}>Select</button>)}
    </div>
    <SelBar sel={sel} noun="action" actions={[
      { label: live ? 'Send to METRC' : 'Dry run check', run: ids => push(ids) },
      { label: 'Done in METRC', run: ids => setTo('done', ids) }, { label: 'Problem', run: ids => setTo('error', ids) }, { label: 'Skip', run: ids => setTo('skipped', ids) },
      ...(status !== 'todo' ? [{ label: 'Back to to do', run: (ids: number[]) => setTo('todo', ids) }] : [])]} />
    {rows == null ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">{status === 'todo' ? 'Nothing waiting. Everything is checked off.' : 'Nothing here.'}</p>
      : <div className="tablewrap"><table className="ct">
        <thead><tr><SelAll sel={sel} ids={ids} /><th>When</th><th>Action</th><th>Package</th><th className="hide-s">Tag</th><th className="num">Lbs</th><th className="hide-s">License</th><th>Status</th>{c.canEdit && !sel.on && <th />}</tr></thead>
        <tbody>{shown.map(r => <tr key={r.id} onClick={() => sel.on && sel.toggle(r.id)} className={sel.on ? 'tap' : ''}>
          <SelBox sel={sel} id={r.id} />
          <td className="nowrap small">{when(r.at)}<div className="muted">{(r.details?.by as string | undefined)?.split('@')[0] ?? ''}</div></td>
          <td><b>{r.action}</b>{r.due_at && r.status === 'todo' && <div className={`small ${new Date(r.due_at) < new Date() ? 'neg' : 'muted'}`}>{new Date(r.due_at) > new Date() ? 'Not before' : 'Due'} {when(r.due_at)}</div>}{r.summary && <div className="muted small">{r.summary}</div>}{r.note && <div className={`small ${r.push_state === 'sent' ? 'muted' : 'neg'}`}>{r.note}</div>}
            {r.push_state && <div className="small" style={{ marginTop: 2 }}><span className={`pill ${PS[r.push_state][1]}`}>{PS[r.push_state][0]}</span>
              {r.push_state !== 'sent' && r.push_error && <span className={r.push_state === 'failed' ? 'neg' : 'muted'}> {r.push_error}</span>}
              {r.push_at && <span className="muted"> {when(r.push_at)}</span>}</div>}
            <MetrcBar r={r} now={now} /></td>
          <td>{r.code ?? ''}</td><td className="mono small hide-s" title={r.tag ?? ''}>{short(r.tag)}</td><td className="num">{n2(r.lbs)}</td>
          <td className="mono small hide-s">{r.license ?? ''}</td>
          <td><span className={`pill ${ST[r.status][1]}`}>{ST[r.status][0]}</span>{r.done_by && <div className="muted small">{r.done_by.split('@')[0]}</div>}</td>
          {c.canEdit && !sel.on && <td className="nowrap">{sendable(r) && <button className={live ? 'primary small' : 'ghost small'} disabled={busy} onClick={e => { e.stopPropagation(); push([r.id]) }}>{live ? 'Send' : 'Check'}</button>}
            {r.push_state === 'held' && (r.status === 'todo' || r.status === 'error') && <button className="primary small" disabled={busy} onClick={e => { e.stopPropagation(); release(r) }}>Release</button>}
            {stoppable(r) && <button className="ghost small danger" disabled={busy} onClick={e => { e.stopPropagation(); stop(r) }}>Stop</button>}
            {r.status === 'todo' ? <button className="ghost small" disabled={busy} onClick={e => { e.stopPropagation(); setTo('done', [r.id]) }}>Done</button>
            : <button className="ghost small" disabled={busy} onClick={e => { e.stopPropagation(); setTo('todo', [r.id]) }}>Undo</button>}</td>}
        </tr>)}</tbody></table></div>}
    <p className="muted small" style={{ marginTop: 8 }}>{live ? 'Send' : 'Check'} goes through T3 for kinds switched on in Settings › METRC through T3{live ? '' : ' (Dry run: checked with METRC, nothing changes)'}. Everything else is still done by hand in METRC and checked off here.</p>
  </>
}

// ---------- reconcile: METRC Active Packages export vs the app ----------
const ISSUE: Record<Recon['issue'], [string, string]> = {
  not_in_app: ['In METRC, not in the app', 'Active in METRC but no package in the app has this tag. Add it in the app, or finish it in METRC if it\'s gone.'],
  closed_in_app: ['Closed in the app, still active in METRC', 'Shipped, used up or combined in the app. Finish or adjust it in METRC.'],
  not_in_metrc: ['In the app, missing from this METRC export', 'In a freezer under this license in the app but not in the export. Check the tag, or the package may be under another license in METRC.'],
  other_license: ['Different license', 'METRC has it under this license, the app has it in a freezer under another one. A transfer may be missing.'],
  weight: ['Weight doesn\'t match', 'More than the allowed difference between the app and METRC.'],
  item: ['Item doesn\'t match', 'The app\'s item (SKU) name differs from the METRC item.'],
  on_hold: ['On hold or failed lab test in METRC', ''],
  tag_pending: ['No tag yet in the app', 'Live packages under this license with the METRC tag still pending.'],
  stale: ['Hasn\'t moved in a while', 'Nothing has happened to these in the app for a long time. Worth a look.'],
}
const ORDER: Recon['issue'][] = ['closed_in_app', 'not_in_app', 'not_in_metrc', 'other_license', 'weight', 'item', 'on_hold', 'tag_pending', 'stale']

function Reconcile({ c }: { c: Ctx }) {
  const [mode, setMode] = useState<'live' | 'farm' | 'nursery' | 'file'>('live')
  return <>
    <div className="chips" style={{ marginBottom: 8 }}>{([['live', 'From METRC (live)'], ['farm', 'Farm plants'], ['nursery', 'Nursery (1PN)'], ['file', 'Upload an export']] as const).map(([k, l]) =>
      <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}</div>
    {mode === 'live' ? <LiveReconcile c={c} /> : mode === 'farm' ? <FarmReconcile c={c} /> : mode === 'nursery' ? <NurseryReconcile c={c} /> : <UploadReconcile c={c} />}
  </>
}

function UploadReconcile({ c }: { c: Ctx }) {
  const [ups, setUps] = useState<Upload[]>([])
  const [lic, setLic] = useState<string | null>(c.ov.licenses[0] ?? null)
  const [parsed, setParsed] = useState<{ file: string; rows: MRow[]; cols: Partial<Record<Field, number>> } | null>(null)
  const [cur, setCur] = useState<Upload | null>(null)
  const [res, setRes] = useState<Recon[] | null>(null)
  const [busy, setBusy] = useState(false)
  const loadUps = async () => { try { const u = await c.api.uploads(); setUps(u); return u } catch (e) { c.flash(errText(e), true); return [] } }
  useEffect(() => { loadUps() }, [])
  useEffect(() => { if (!cur) { setRes(null); return } setRes(null); c.api.reconcile(cur.id).then(setRes).catch(e => c.flash(errText(e), true)) }, [cur?.id])
  async function read(fs: File[]) {
    const f = fs[0]
    try {
      const t = await readTable(f); const m = mapColumns(t)
      if (!m) { c.flash('Couldn\'t find a Tag column. Use METRC › Packages › Active › export (CSV or Excel).', true); return }
      const rows = toRows(t, m)
      if (!rows.length) { c.flash('No package tags found in that file', true); return }
      setParsed({ file: f.name, rows, cols: m.cols })
      const guess = c.ov.licenses.find(l => f.name.toUpperCase().includes(l.toUpperCase()))
      if (guess) setLic(guess)
    } catch (e) { c.flash(errText(e), true) }
  }
  async function compare() {
    if (!parsed || !lic) return
    setBusy(true)
    try {
      const id = await c.api.uploadMetrc(lic, parsed.file, parsed.rows)
      const u = await loadUps(); setCur(u.find(x => x.id === id) ?? null); setParsed(null); await c.reload()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  const by = useMemo(() => { const m = new Map<Recon['issue'], Recon[]>(); for (const r of res ?? []) m.set(r.issue, [...(m.get(r.issue) ?? []), r]); return m }, [res])
  const exportCsv = () => cur && download(`Reconcile ${cur.license} ${cur.uploaded_at.slice(0, 10)}.csv`, toCsv(['Issue', 'Tag', 'Package', 'Strain', 'App lbs', 'METRC lbs', 'App item', 'METRC item', 'App license', 'Note'],
    (res ?? []).map(r => [ISSUE[r.issue][0], r.tag, r.code, r.strain, r.app_lbs, r.metrc_lbs, r.app_item, r.metrc_item, r.app_license, r.note])))
  return <>
    <p className="muted">In METRC, open Packages › Active for one license and export it (CSV or Excel). Drop the file here and the app compares every package: tags, weights, items and licenses. Weight tolerance {c.ov.weight_tol ?? 1} lb.</p>
    {c.canEdit && <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
      <F label="License"><Pick value={lic} options={c.ov.licenses.map(l => ({ v: l, l }))} onChange={setLic} /></F>
      <div style={{ flex: 1, minWidth: 260 }}><DropZone onFiles={read} accept=".csv,.xlsx,.txt" label="Drop the METRC Active Packages export" /></div></div>}
    {parsed && <div className="infobox" style={{ marginTop: 10 }}>
      <b>{parsed.file}</b>: {parsed.rows.length} packages. Columns found: {(Object.keys(parsed.cols) as Field[]).map(k => FIELD_LABEL[k]).join(', ')}.
      {parsed.cols.qty == null && <div className="warn-t">No Quantity column, so weights won't be compared.</div>}
      <div className="row" style={{ marginTop: 6 }}><button className="primary" disabled={busy || !lic} onClick={compare}>Compare with the app ({lic})</button><button className="ghost" onClick={() => setParsed(null)}>Cancel</button></div></div>}
    {ups.length > 0 && <div className="row wrap toolbar" style={{ marginTop: 12 }}><span className="muted">Uploads</span>
      <Select value={cur?.id ?? ''} onChange={e => setCur(ups.find(u => u.id === Number(e.target.value)) ?? null)}><option value="">Pick one…</option>
        {ups.map(u => <option key={u.id} value={u.id}>{u.license} · {when(u.uploaded_at)} · {u.rows} pkgs · {u.uploaded_by?.split('@')[0]}</option>)}</Select>
      {cur && res && <button className="ghost small" onClick={exportCsv}>Export CSV</button>}</div>}
    {cur && (res == null ? <p className="muted">Comparing…</p> : !res.length ? <div className="infobox" style={{ marginTop: 10 }}>Everything matches for {cur.license}.</div>
      : ORDER.filter(k => by.get(k)?.length).map(k => <div key={k} className="dueg"><h3>{ISSUE[k][0]} <span className="muted">{by.get(k)!.length}</span></h3>
        {ISSUE[k][1] && <p className="muted small">{ISSUE[k][1]}</p>}
        <div className="tablewrap"><table className="ct"><thead><tr><th>Tag</th><th>Package</th><th className="hide-s">Strain</th>
          {(k === 'weight' || k === 'not_in_app' || k === 'closed_in_app' || k === 'other_license') && <><th className="num">App lbs</th><th className="num">METRC lbs</th></>}
          {k === 'item' && <><th>App item</th><th>METRC item</th></>}<th>Note</th></tr></thead>
          <tbody>{by.get(k)!.slice(0, 300).map((r, i) => <tr key={i}><td className="mono small" title={r.tag ?? ''}>{short(r.tag)}</td><td>{r.code ?? ''}</td><td className="hide-s">{r.strain ?? ''}</td>
            {(k === 'weight' || k === 'not_in_app' || k === 'closed_in_app' || k === 'other_license') && <><td className="num">{n2(r.app_lbs)}</td><td className="num">{n2(r.metrc_lbs)}</td></>}
            {k === 'item' && <><td className="small">{r.app_item}</td><td className="small">{r.metrc_item}</td></>}
            <td className="small">{[r.note, r.app_license && k === 'other_license' ? `App: ${r.app_license}` : null].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table></div>
        {by.get(k)!.length > 300 && <p className="muted small">Showing 300. Export CSV for all of them.</p>}</div>))}
  </>
}

// ---------- errors + playbook ----------
function Errors({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<MError[] | null>(null)
  const [plays, setPlays] = useState<Play[]>([])
  const [open, setOpen] = useState<Partial<MError> | null>(null)
  const [fixed, setFixed] = useState(false)
  const load = async () => { try { const [e, p] = await Promise.all([c.api.errors(), c.api.playbook()]); setRows(e); setPlays(p) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load() }, [])
  const shown = (rows ?? []).filter(r => fixed || r.status === 'open')
  return <>
    <div className="row between wrap toolbar"><p className="muted" style={{ margin: 0 }}>Something went wrong in METRC? Log it here with a screenshot. Once it's fixed, add the fix to the playbook so the next person knows.</p>
      <button className="primary" onClick={() => setOpen({ happened_on: today() })}>+ Log a METRC error</button></div>
    <label className="check"><input type="checkbox" checked={fixed} onChange={e => setFixed(e.target.checked)} /> Show fixed ones too</label>
    {rows == null ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">No open METRC errors.</p> : <div className="clist">{shown.map(r => <button key={r.id} className="crow" onClick={() => setOpen(r)}>
      <span className="grow"><span className="t">{r.what}</span><div className="muted small">{fmtD(r.happened_on)}{r.license ? ` · ${r.license}` : ''}{r.tag ? ` · ${short(r.tag)}` : ''}{r.action ? ` · ${r.action}` : ''} · {r.created_by?.split('@')[0]}{r.assigned_to ? ` → ${r.assigned_to.split('@')[0]}` : ''}</div>
        {r.error_text && <div className="small mono">{r.error_text.slice(0, 140)}</div>}</span>
      <span className={`pill ${r.status === 'open' ? 'cp-bad' : 'cp-ok'}`}>{r.status === 'open' ? 'Open' : 'Fixed'}</span></button>)}</div>}
    {open && <ErrorSheet c={c} e={open} plays={plays} onClose={() => setOpen(null)} onSaved={async () => { await load(); await c.reload() }} />}
  </>
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3))
function ErrorSheet({ c, e, plays, onClose, onSaved }: { c: Ctx; e: Partial<MError>; plays: Play[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [x, setX] = useState(e)
  const [id, setId] = useState<number | null>(e.id ?? null)
  const [busy, setBusy] = useState(false)
  const [fix, setFix] = useState(e.fix ?? '')
  const [toPlay, setToPlay] = useState(true)
  const [playTitle, setPlayTitle] = useState('')
  const [pending, setPending] = useState<File[]>([])
  const set = (v: Partial<MError>) => setX(s => ({ ...s, ...v }))
  const like = useMemo(() => {
    const w = words(`${x.what ?? ''} ${x.error_text ?? ''}`); if (w.size < 1) return []
    return plays.map(p => ({ p, n: [...words(`${p.title} ${p.symptom ?? ''}`)].filter(y => w.has(y)).length })).filter(y => y.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3).map(y => y.p)
  }, [x.what, x.error_text, plays])
  async function save() {
    setBusy(true)
    try {
      const nid = await c.api.saveError(x); setId(nid)
      for (const f of pending) {
        const path = await c.api.upload(f, 'metrc')
        await c.api.addDoc({ doc_type: 'metrc', title: `METRC error: ${x.what}`.slice(0, 120), file_path: path, file_name: f.name, mime: f.type || null, size_bytes: f.size, links: [{ kind: 'metrc_error', id: String(nid) }] })
      }
      setPending([]); c.flash('Saved'); await onSaved(); if (!e.id) onClose()
    } catch (err) { c.flash(errText(err), true) } finally { setBusy(false) }
  }
  async function markFixed(reopen = false) {
    setBusy(true)
    try { const pb = await c.api.fixError(id!, fix, toPlay && !e.playbook_id, playTitle || null, reopen); c.flash(reopen ? 'Reopened' : pb && toPlay ? 'Fixed and added to the playbook' : 'Fixed'); await onSaved(); onClose() }
    catch (err) { c.flash(errText(err), true) } finally { setBusy(false) }
  }
  const canFix = id != null && (c.canEdit || e.created_by === c.me || e.assigned_to === c.me)
  return <Sheet title={e.id ? 'METRC error' : 'Log a METRC error'} onClose={onClose}>
    <div className="grid2">
      <F label="When"><DateIn value={x.happened_on} onChange={v => set({ happened_on: v ?? today() })} /></F>
      <F label="License"><Pick value={x.license ?? null} blank="—" options={c.ov.licenses.map(l => ({ v: l, l }))} onChange={v => set({ license: v })} /></F>
      <F label="Package tag"><TextIn value={x.tag} onChange={v => set({ tag: v })} /></F>
      <F label="What you were doing"><TextIn value={x.action} onChange={v => set({ action: v })} placeholder="Split, transfer, adjust…" list="comp-err-actions" /></F>
    </div>
    <datalist id="comp-err-actions">{['Create package', 'Split package', 'Combine packages', 'Adjust package', 'Change item', 'Transfer / manifest', 'Finish package', 'Harvest', 'Lab test', 'Tags'].map(a => <option key={a} value={a} />)}</datalist>
    <F label="What happened"><TextIn value={x.what} onChange={v => set({ what: v ?? '' })} autoFocus={!e.id} /></F>
    <F label="METRC's message" hint="copy it exactly"><textarea value={x.error_text ?? ''} onChange={ev => set({ error_text: ev.target.value || null })} /></F>
    <F label="Assigned to" hint="email"><TextIn value={x.assigned_to} onChange={v => set({ assigned_to: v })} /></F>
    {like.length > 0 && x.status !== 'fixed' && <div className="infobox"><b>Seen before?</b>{like.map(p => <div key={p.id} className="play" style={{ marginTop: 6 }}><b>{p.title}</b><pre>{p.fix}</pre></div>)}</div>}
    {id != null ? <DocList api={c.api} kind="metrc_error" refId={id} docType="metrc" flash={c.flash} title="Screenshots" empty="Drop a screenshot of the error here." defaults={{ title: `METRC error: ${x.what ?? ''}`.slice(0, 120) }} />
      : <><div className="cdl-h">Screenshots</div>{pending.map((f, i) => <div key={i} className="small">{f.name} <button className="ghost small" onClick={() => setPending(p => p.filter((_, j) => j !== i))}>✕</button></div>)}
        <DropZone compact onFiles={fs => setPending(p => [...p, ...fs])} label="drop a screenshot (saved with the error)" /></>}
    <SaveBar busy={busy} onSave={save} onCancel={onClose} disabled={!x.what?.trim()} saveLabel={e.id ? 'Save' : 'Log it'} />
    {canFix && e.id && (e.status === 'fixed'
      ? <div className="infobox" style={{ marginTop: 12 }}><b>Fixed</b> {fmtD(e.fixed_at)} by {e.fixed_by?.split('@')[0]}<pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{e.fix}</pre>
          <button className="ghost small" disabled={busy} onClick={() => markFixed(true)}>Reopen</button></div>
      : <div style={{ marginTop: 14 }}><h3>Fix</h3>
        <F label="How it was fixed"><textarea value={fix} onChange={ev => setFix(ev.target.value)} /></F>
        {!e.playbook_id && <><label className="check"><input type="checkbox" checked={toPlay} onChange={ev => setToPlay(ev.target.checked)} /> Add to the playbook</label>
          {toPlay && <F label="Playbook title"><TextIn value={playTitle} onChange={v => setPlayTitle(v ?? '')} placeholder={(e.what ?? '').slice(0, 80)} /></F>}</>}
        <button className="primary" disabled={busy || !fix.trim()} onClick={() => markFixed()}>Mark fixed</button></div>)}
  </Sheet>
}

function Playbook({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<Play[] | null>(null)
  const [q, setQ] = useState('')
  const [ed, setEd] = useState<Partial<Play> | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => { try { setRows(await c.api.playbook()) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load() }, [])
  const shown = (rows ?? []).filter(p => !q || `${p.title} ${p.symptom ?? ''} ${p.fix} ${p.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  async function save(del = false) {
    setBusy(true)
    try { await c.api.savePlay({ ...ed!, tags: typeof ed!.tags === 'string' ? (ed!.tags as unknown as string).split(',') : ed!.tags ?? [], delete: del }); c.flash(del ? 'Deleted' : 'Saved'); setEd(null); await load() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  return <>
    <div className="row between wrap toolbar"><input className="search" placeholder="Search the playbook (paste METRC's message)" value={q} onChange={e => setQ(e.target.value)} />
      {c.canEdit && <button className="primary" onClick={() => setEd({ tags: [] })}>+ Entry</button>}</div>
    <p className="muted">Known METRC problems and how to fix them. Fixed errors can add themselves here.</p>
    {rows == null ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">{rows.length ? 'Nothing matches.' : 'Nothing yet.'}</p>
      : shown.map(p => <div key={p.id} className="play"><div className="row between"><b>{p.title}</b>{c.canEdit && <button className="ghost small" onClick={() => setEd(p)}>Edit</button>}</div>
        {p.symptom && <div className="muted small mono">{p.symptom}</div>}<pre>{p.fix}</pre>
        {p.tags.length > 0 && <div className="small muted">{p.tags.join(' · ')}</div>}</div>)}
    {ed && <Sheet title={ed.id ? 'Playbook entry' : 'New playbook entry'} onClose={() => setEd(null)}>
      <F label="Title"><TextIn value={ed.title} onChange={v => setEd({ ...ed, title: v ?? '' })} /></F>
      <F label="What you see" hint="METRC's message"><textarea value={ed.symptom ?? ''} onChange={e => setEd({ ...ed, symptom: e.target.value || null })} /></F>
      <F label="The fix"><textarea rows={6} value={ed.fix ?? ''} onChange={e => setEd({ ...ed, fix: e.target.value })} /></F>
      <F label="Tags" hint="comma separated"><TextIn value={Array.isArray(ed.tags) ? ed.tags.join(', ') : String(ed.tags ?? '')} onChange={v => setEd({ ...ed, tags: (v ?? '').split(',').map(s => s.trim()).filter(Boolean) })} /></F>
      <SaveBar busy={busy} onSave={() => save()} onCancel={() => setEd(null)} onDelete={ed.id && c.isAdmin ? () => { if (confirm('Delete this entry?')) save(true) } : undefined} disabled={!ed.title?.trim() || !ed.fix?.trim()} />
    </Sheet>}
  </>
}
