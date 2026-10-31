import { Select } from '../combo'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Backend } from '../api'
import { AcctApi, GRP_LABEL } from './api'
import type { AClass, AInvoice, Conn, Env, Overview, Payload, Product, QLine, Ref, Rule } from './api'
import type { ATab } from './tabs'
import { Card, Cards, DashHead, Empty, Tile, Tiles } from '../dash'
import { DocSheet } from '../invoices'
import { ModulePeople } from '../users'
import { dfmt, money as money2 } from '../docs'
import { PayrollTab, PaySettings } from '../pay/PayrollView'

type Flash = (t: string, bad?: boolean) => void
const money = money2
/** whole dollars for the big tiles */
const dollars = (n: number) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString()
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
const msg = (e: unknown) => String((e as Error)?.message ?? e)
const ENV_LABEL: Record<Env, string> = { sandbox: 'QuickBooks sandbox (test company)', production: 'QuickBooks (real books)' }
const EnvPill = ({ env }: { env: Env }) => <span className={`pill ${env === 'sandbox' ? 'warnp' : 'acct-sent'}`}>{env === 'sandbox' ? 'SANDBOX' : 'LIVE'}</span>
const unpaid = (i: AInvoice) => i.push?.status === 'sent' && Number(i.push.balance ?? i.push.total ?? 0) > 0
const toSend = (i: AInvoice) => i.outside && i.status !== 'void' && i.push?.status !== 'sent'

export default function AccountingView({ backend, flash, tab, go, isAdmin, canEdit, notice }: {
  backend: Backend; flash: Flash; tab: ATab; go: (t: ATab) => void; isAdmin: boolean; canEdit: boolean; notice?: { qbo: string; msg: string | null } | null
}) {
  const sb = useMemo(() => backend.client(), [backend])
  const api = useMemo(() => (sb ? new AcctApi(sb) : null), [sb])
  const [rows, setRows] = useState<AInvoice[] | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [conn, setConn] = useState<{ env: Env; connected: boolean; company?: string; error?: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [pdf, setPdf] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!api) return
    try { const [r, o] = await Promise.all([api.invoices(), api.overview()]); setRows(r); setOv(o); setErr(null) } catch (e) { setErr(msg(e)) }
  }, [api])
  const status = useCallback(async () => {
    if (!api) return
    try { setConn(await api.server('run', { action: 'status' })) } catch (e) { setConn({ env: 'sandbox', connected: false, error: msg(e) }) }
  }, [api])
  useEffect(() => { load(); status() }, [load, status])
  useEffect(() => {
    if (!notice) return
    if (notice.qbo === 'connected') { flash('QuickBooks connected'); status(); load() } else flash(`QuickBooks didn't connect: ${notice.msg ?? 'unknown error'}`, true)
  }, [notice])

  if (!api) return <div className="list"><h2>Accounting</h2><p className="muted">Accounting needs the database (not available in the demo).</p></div>
  if (err) return <div className="list"><h2>Accounting</h2><div className="warnbox">Couldn't load Accounting. If this is the first time, run 046_accounting.sql in Supabase. ({err})</div></div>
  if (!rows || !ov) return <div className="list"><h2>Accounting</h2><p className="muted">Loading…</p></div>

  const env: Env = conn?.env ?? ov.env
  const sheet = open != null && <SendSheet api={api} id={open} flash={flash} canEdit={canEdit} env={env} onClose={() => setOpen(null)} onChanged={load} onPdf={() => setPdf(open)} />
  const pdfSheet = pdf != null && <DocSheet backend={backend} kind="invoice" id={pdf} flash={flash} onClose={() => setPdf(null)} onChanged={load} canEdit={false} canVoid={false} />
  const banner = conn && !conn.connected
    ? <div className="warnbox">QuickBooks isn't connected. {conn.error}{isAdmin && tab !== 'settings' && <> <button className="linkbtn" onClick={() => go('settings')}>Connect it in Settings ›</button></>}</div>
    : env === 'sandbox' ? <div className="viewbanner">Sandbox: invoices go to the QuickBooks test company, not your real books. Nothing here is locked or marked paid by the sandbox.</div> : null

  return (
    <div className="acct">
      {tab === 'dashboard' && <Dashboard ov={ov} rows={rows} conn={conn} env={env} go={go} open={setOpen} banner={banner} />}
      {tab === 'send' && <SendList api={api} rows={rows} env={env} canEdit={canEdit && !!conn?.connected} flash={flash} open={setOpen} reload={load} banner={banner} />}
      {tab === 'sent' && <SentList api={api} rows={rows} env={env} flash={flash} open={setOpen} reload={load} lastSync={ov.last_sync} connected={!!conn?.connected} banner={banner} />}
      {tab === 'payroll' && sb && <PayrollTab sb={sb} flash={flash} canEdit={canEdit} isAdmin={isAdmin} />}
      {tab === 'review' && <ReviewTab api={api} rows={rows} open={setOpen} />}
      {tab === 'settings' && isAdmin && <SettingsTab api={api} flash={flash} conn={conn} env={env} refresh={() => { status(); load() }} sb={sb} canEdit={canEdit} />}
      {tab === 'settings' && !isAdmin && <div className="list"><h2>Settings</h2><p className="muted">Only Accounting Admins can change Accounting settings.</p></div>}
      {sheet}{pdfSheet}
    </div>
  )
}

// ---------- Dashboard ----------
function Dashboard({ ov, rows, conn, env, go, open, banner }: { ov: Overview; rows: AInvoice[]; conn: { env: Env; connected: boolean; company?: string; error?: string } | null; env: Env; go: (t: ATab) => void; open: (id: number) => void; banner: React.ReactNode }) {
  const errs = rows.filter(i => i.push?.status === 'error' && i.status !== 'void')
  const oldest = rows.filter(toSend).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8)
  const od = rows.filter(i => unpaid(i) && i.due && i.due < today()).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '')).slice(0, 8)
  return (
    <div className="dash">
      <DashHead title="Accounting" sub={<>{ENV_LABEL[env]} <EnvPill env={env} />{conn?.company ? ` · ${conn.company}` : ''}</>} />
      {banner}
      <Tiles>
        <Tile label="To send" value={ov.to_send} sub={money(ov.to_send_amt)} tone={ov.to_send ? 'info' : 'ok'} onClick={() => go('send')} />
        <Tile label="Couldn't send" value={ov.errors} sub="need a fix" tone={ov.errors ? 'warn' : 'ok'} onClick={() => go('review')} />
        <Tile label="Unpaid in QuickBooks" value={dollars(ov.unpaid_amt)} sub={`${ov.unpaid} invoices`} onClick={() => go('sent')} />
        <Tile label="Overdue" value={dollars(ov.overdue_amt)} sub={`${ov.overdue} invoices`} tone={ov.overdue ? 'warn' : 'ok'} onClick={() => go('sent')} />
        <Tile label="Sent this month" value={ov.sent_month} sub={money(ov.sent_month_amt)} />
      </Tiles>
      <Cards>
        <Card title="Oldest waiting to send" badge={ov.to_send} action="To send" onAction={() => go('send')}>
          {oldest.length ? oldest.map(i => <button key={i.id} className="drow click" onClick={() => open(i.id)}><span><b>{i.inv}</b> <span className="muted">{i.customer} · {dfmt(i.date)}</span></span><b>{money(i.total)}</b></button>)
            : <Empty>Nothing waiting. Every outside invoice is in QuickBooks.</Empty>}
        </Card>
        <Card title="Couldn't send" badge={errs.length} action="Review" onAction={() => go('review')}>
          {errs.length ? errs.slice(0, 8).map(i => <button key={i.id} className="drow click" onClick={() => open(i.id)}><span><b>{i.inv}</b> <span className="muted">{i.push?.error}</span></span></button>)
            : <Empty>No errors.</Empty>}
        </Card>
        <Card title="Overdue in QuickBooks" badge={ov.overdue} action="In QuickBooks" onAction={() => go('sent')}>
          {od.length ? od.map(i => <button key={i.id} className="drow click" onClick={() => open(i.id)}><span><b>{i.inv}</b> <span className="muted">{i.customer} · due {dfmt(i.due)}</span></span><b>{money(Number(i.push?.balance ?? i.total))}</b></button>)
            : <Empty>Nothing overdue{ov.last_sync ? '' : ' (no sync yet)'}.</Empty>}
          <p className="muted small">Paid / balance last checked {ov.last_sync ? when(ov.last_sync) : 'never'}. It checks every night.</p>
        </Card>
      </Cards>
    </div>
  )
}

// ---------- To send ----------
function SendList({ api, rows, env, canEdit, flash, open, reload, banner }: { api: AcctApi; rows: AInvoice[]; env: Env; canEdit: boolean; flash: Flash; open: (id: number) => void; reload: () => Promise<void>; banner: React.ReactNode }) {
  const [f, setF] = useState<'send' | 'internal' | 'void'>('send')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<number[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<{ inv: string; ok: boolean; text: string }[]>([])
  const ql = q.trim().toLowerCase()
  const base = f === 'send' ? rows.filter(toSend) : f === 'internal' ? rows.filter(i => !i.outside && i.status !== 'void') : rows.filter(i => i.status === 'void')
  const shown = base.filter(i => !ql || `${i.inv} ${i.customer} ${i.so ?? ''}`.toLowerCase().includes(ql)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
  async function sendMany() {
    const ids = shown.filter(i => sel.includes(i.id))
    const out: { inv: string; ok: boolean; text: string }[] = []
    for (const [k, i] of ids.entries()) {
      setBusy(`Sending ${k + 1} of ${ids.length}…`)
      try { const r = await api.server<{ doc_number: string; mode: string; note?: string }>('run', { action: 'push', invoice_id: i.id }); out.push({ inv: i.inv, ok: true, text: r.note ?? (r.mode === 'updated' ? 'updated' : 'sent') }) }
      catch (e) { out.push({ inv: i.inv, ok: false, text: msg(e) }) }
    }
    setBusy(null); setSel([]); setResults(out); await reload()
    const bad = out.filter(x => !x.ok).length
    flash(bad ? `${out.length - bad} sent, ${bad} couldn't go` : `${out.length} sent to QuickBooks`, bad > 0)
  }
  return (
    <div className="list">
      <h2>To send <EnvPill env={env} /></h2>
      {banner}
      <div className="row toolbar wrap">
        <div className="seg">{([['send', `Outside sales (${rows.filter(toSend).length})`], ['internal', 'Our own farms'], ['void', 'Void']] as const).map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => { setF(k); setSel([]) }}>{l}</button>)}</div>
        <input className="search" type="search" placeholder="Invoice #, customer or SO" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {f === 'send' && <p className="muted small">Invoices to outside customers that aren't in {env === 'sandbox' ? 'the sandbox' : 'QuickBooks'} yet. New ones go on their own 30 minutes after they're made (editing restarts the clock); price fixes made in QuickBooks come back here. You can still open one and send it now, or tick several.</p>}
      {f === 'internal' && <p className="muted small">Transfers to our own farms (clones to OHR / GVR and so on). These never go to QuickBooks.</p>}
      {f === 'send' && canEdit && shown.length > 0 && (
        <div className="row wrap">
          <label className="check"><input type="checkbox" checked={sel.length > 0 && sel.length === shown.length} onChange={e => setSel(e.target.checked ? shown.map(i => i.id) : [])} /> Select all</label>
          {sel.length > 0 && <button className="primary small" disabled={!!busy} onClick={sendMany}>{busy ?? `Send ${sel.length} to QuickBooks`}</button>}
        </div>
      )}
      {results.length > 0 && <div className={`${results.every(r => r.ok) ? 'viewbanner' : 'warnbox'} small`}>{results.map(r => <div key={r.inv}><b>{r.inv}</b>: {r.ok ? '✓ ' : '✕ '}{r.text}</div>)}<button className="linkbtn" onClick={() => setResults([])}>Hide</button></div>}
      {!shown.length && <Empty>{f === 'send' ? 'Nothing to send.' : 'None.'}</Empty>}
      {shown.map(i => (
        <div key={i.id} className="li setrow acctrow">
          {f === 'send' && canEdit && <input type="checkbox" checked={sel.includes(i.id)} onChange={e => setSel(s => e.target.checked ? [...s, i.id] : s.filter(x => x !== i.id))} />}
          <button className="grow plain" onClick={() => open(i.id)}>
            <div><b>{i.inv}</b> {i.nursery && <span className="pill">1PN</span>} {i.push?.status === 'error' && <span className="pill acct-error">Couldn't send</span>} <span className={`pill inv-${i.status}`}>{i.status === 'paid' ? 'Paid (app)' : i.status === 'void' ? 'Void' : 'Open'}</span></div>
            <div className="muted">{i.customer} · {dfmt(i.date)}{i.so ? ` · ${i.so}` : ''}{i.terms ? ` · ${i.terms}` : ''}</div>
            {i.push?.status === 'error' && <div className="bad-t small">{i.push.error}</div>}
            {i.push_after && i.push?.status !== 'error' && <div className="small muted">Goes automatically at {new Date(i.push_after).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>}
          </button>
          <b className="num">{money(i.total)}</b>
        </div>
      ))}
    </div>
  )
}

// ---------- In QuickBooks ----------
function SentList({ api, rows, env, flash, open, reload, lastSync, connected, banner }: { api: AcctApi; rows: AInvoice[]; env: Env; flash: Flash; open: (id: number) => void; reload: () => Promise<void>; lastSync: string | null; connected: boolean; banner: React.ReactNode }) {
  const [f, setF] = useState<'unpaid' | 'overdue' | 'paid' | 'all'>('unpaid')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const sent = rows.filter(i => i.push?.status === 'sent')
  const ql = q.trim().toLowerCase()
  const isOd = (i: AInvoice) => unpaid(i) && !!i.due && i.due < today()
  const shown = sent.filter(i => (f === 'all' || (f === 'unpaid' ? unpaid(i) : f === 'overdue' ? isOd(i) : !unpaid(i))) && (!ql || `${i.inv} ${i.customer} ${i.push?.doc_number ?? ''}`.toLowerCase().includes(ql)))
  async function sync() {
    setBusy(true)
    try { const r = await api.server<{ checked: number; paid: number; reopened: number; changed: number }>('run', { action: 'sync' }); await reload()
      flash(`Checked ${r.checked}${r.paid ? ` · ${r.paid} now paid` : ''}${r.reopened ? ` · ${r.reopened} reopened` : ''}${r.changed ? ` · ${r.changed} changed in QuickBooks` : ''}`) }
    catch (e) { flash(msg(e), true) } finally { setBusy(false) }
  }
  const tot = (xs: AInvoice[]) => xs.reduce((a, i) => a + Number(i.push?.balance ?? i.push?.total ?? 0), 0)
  return (
    <div className="list">
      <div className="row between wrap"><h2>In QuickBooks <EnvPill env={env} /></h2>
        <button className="ghost small" disabled={busy || !connected} onClick={sync}>{busy ? 'Checking…' : 'Check payments now'}</button></div>
      {banner}
      <p className="muted small">QuickBooks is where payments are recorded. Balances here come from QuickBooks (last checked {lastSync ? when(lastSync) : 'never'}; it checks every night).</p>
      <Tiles>
        <Tile label="Unpaid" value={dollars(tot(sent.filter(unpaid)))} sub={`${sent.filter(unpaid).length} invoices`} onClick={() => setF('unpaid')} />
        <Tile label="Overdue" value={dollars(tot(sent.filter(isOd)))} sub={`${sent.filter(isOd).length} invoices`} tone={sent.some(isOd) ? 'warn' : 'ok'} onClick={() => setF('overdue')} />
      </Tiles>
      <div className="row toolbar wrap">
        <div className="seg">{(['unpaid', 'overdue', 'paid', 'all'] as const).map(k => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}</div>
        <input className="search" type="search" placeholder="Invoice #, customer" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {!shown.length && <Empty>None here.</Empty>}
      {shown.map(i => (
        <button key={i.id} className="li setrow" onClick={() => open(i.id)}>
          <div className="grow"><div><b>{i.inv}</b> <span className={`pill ${isOd(i) ? 'inv-overdue' : unpaid(i) ? 'inv-open' : 'inv-paid'}`}>{isOd(i) ? 'Overdue' : unpaid(i) ? 'Unpaid' : 'Paid'}</span>{i.push?.error && <span className="pill acct-error">{i.push.error}</span>}</div>
            <div className="muted">{i.customer} · {dfmt(i.date)}{i.due ? ` · due ${dfmt(i.due)}` : ''} · QuickBooks #{i.push?.doc_number} · sent {when(i.push?.sent_at)} by {(i.push?.sent_by ?? '').split('@')[0]}</div></div>
          <div className="num"><b>{money(Number(i.push?.balance ?? i.total))}</b><div className="muted small">of {money(Number(i.push?.total ?? i.total))}</div></div>
        </button>
      ))}
    </div>
  )
}

// ---------- Review ----------
function ReviewTab({ api, rows, open }: { api: AcctApi; rows: AInvoice[]; open: (id: number) => void }) {
  const [noProduct, setNoProduct] = useState<Set<number> | null>(null)
  useEffect(() => { api.linesWithoutProduct().then(setNoProduct).catch(() => setNoProduct(new Set())) }, [rows])
  const errs = rows.filter(i => i.push?.status === 'error' && i.status !== 'void')
  const gone = rows.filter(i => i.push?.status === 'sent' && i.push.error)
  const missing = rows.filter(i => toSend(i) && noProduct?.has(i.id))
  const changed = rows.filter(i => i.push?.status === 'sent' && i.push.total != null && Math.abs(Number(i.push.total) - Number(i.total)) > 0.005)
  const paidHere = rows.filter(i => toSend(i) && i.status === 'paid')
  const sec = (title: string, note: string, xs: AInvoice[], extra?: (i: AInvoice) => React.ReactNode) => xs.length > 0 && (
    <><h3>{title} ({xs.length})</h3><p className="muted small">{note}</p>
      {xs.map(i => <button key={i.id} className="li setrow" onClick={() => open(i.id)}><div className="grow"><b>{i.inv}</b> <span className="muted">{i.customer} · {dfmt(i.date)}</span>{extra && <div className="small">{extra(i)}</div>}</div><b className="num">{money(i.total)}</b></button>)}</>)
  const flagged = rows.filter(i => (i.flags?.length ?? 0) > 0)
  const none = !errs.length && !gone.length && !missing.length && !changed.length && !paidHere.length && !flagged.length
  return (
    <div className="list">
      <h2>Review</h2>
      {none && <Empty>All clear.</Empty>}
      {sec("Couldn't send", 'Open it to see why. Usually a product or class that isn\'t in QuickBooks with the same name, or a line with no product.', errs, i => <span className="bad-t">{i.push?.error}</span>)}
      {sec('Lines with no QuickBooks product', 'Pick a product for each line before sending.', missing)}
      {sec('Not found in QuickBooks anymore', 'Sent, but the last check couldn\'t find it (deleted or voided in QuickBooks?).', gone, i => <span className="bad-t">{i.push?.error}</span>)}
      {sec('Different total in QuickBooks', 'Someone changed it in QuickBooks after it was sent, or it was changed here before the lock.', changed, i => <span>QuickBooks {money(Number(i.push?.total))} · app {money(i.total)}</span>)}
      {sec('Changed in QuickBooks: check these', 'Prices changed in QuickBooks come back to the app on their own. These are changes the app didn\'t copy (quantities match METRC and never change here; lines it doesn\'t know).', flagged, i => <span className="warn-t">{i.flags!.join(' · ')}</span>)}
      {sec('Marked paid in the app but not in QuickBooks', 'Payments belong in QuickBooks. Send the invoice, then record the payment there.', paidHere)}
    </div>
  )
}

// ---------- one invoice: how it goes to QuickBooks ----------
function SendSheet({ api, id, flash, canEdit, env, onClose, onChanged, onPdf }: { api: AcctApi; id: number; flash: Flash; canEdit: boolean; env: Env; onClose: () => void; onChanged: () => void; onPdf: () => void }) {
  const [p, setP] = useState<Payload | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [classes, setClasses] = useState<AClass[]>([])
  const [busy, setBusy] = useState(false)
  const [add, setAdd] = useState<{ product: string; desc: string; amount: string; applies: string } | null>(null)
  const load = useCallback(async () => { try { setP(await api.payload(id)) } catch (e) { flash(msg(e), true); onClose() } }, [api, id])
  useEffect(() => { load(); api.products().then(setProducts).catch(() => {}); api.classes().then(setClasses).catch(() => {}) }, [load])
  if (!p) return <div className="scrim" onClick={onClose}><div className="sheet" onClick={e => e.stopPropagation()}><p className="muted">Loading…</p></div></div>
  const locked = p.push?.status === 'sent' && env === 'production'
  const editable = canEdit && !locked && p.status !== 'void'
  const run = async (f: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await f(); await load(); onChanged(); if (ok) flash(ok) } catch (e) { flash(msg(e), true) } finally { setBusy(false) } }
  const byLine = new Map<number, QLine[]>()
  for (const l of p.lines) byLine.set(l.line_id, [...(byLine.get(l.line_id) ?? []), l])
  const productLines = p.lines.filter(l => ['flower', 'bio', 'clones'].includes(l.grp ?? ''))
  async function send() {
    setBusy(true)
    try {
      const r = await api.server<{ doc_number: string; mode: string; note?: string | null }>('run', { action: 'push', invoice_id: id })
      flash(r.note ?? `${r.doc_number} ${r.mode === 'updated' ? 'updated in' : 'sent to'} ${env === 'sandbox' ? 'the sandbox' : 'QuickBooks'}`, !!r.note && /different/.test(r.note))
      await load(); onChanged()
    } catch (e) { flash(msg(e), true); await load(); onChanged() } finally { setBusy(false) }
  }
  const sentLabel = p.push?.status === 'sent' ? `In ${env === 'sandbox' ? 'the sandbox' : 'QuickBooks'} as #${p.push.doc_number} · sent ${when(p.push.sent_at)} by ${(p.push.sent_by ?? '').split('@')[0]}` : null
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet docsheet acctsheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{p.doc_number} <EnvPill env={env} /></h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="row wrap docmeta">
          <b>{p.customer.legal_name}</b><span className="muted">{money(p.total)} · {dfmt(p.date)} · {p.terms}{p.due ? ` · due ${dfmt(p.due)}` : ''}{p.so ? ` · ${p.so}` : ''}</span>
          {p.nursery && <span className="pill">1PN</span>}
          <button className="ghost small" onClick={onPdf}>Invoice PDF</button>
        </div>
        {sentLabel && <p className="ok-t">{sentLabel}{p.push?.balance != null ? ` · balance ${money(Number(p.push.balance))}` : ''}</p>}
        {p.push?.status === 'error' && <div className="warnbox">Last try: {p.push.error}</div>}
        {p.problems.length > 0 && <div className="warnbox">{p.problems.map((x, k) => <div key={k}>{x}</div>)}</div>}
        {!p.customer.qbo_id && p.customer.kind === 'external' && <p className="muted small">The customer isn't linked to QuickBooks yet. On send it's matched by name ("{p.customer.qbo_name || p.customer.legal_name}") or added.</p>}
        <table className="restable acctlines">
          <thead><tr><th>Line</th><th>QuickBooks product</th><th>Class</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th>{editable && <th />}</tr></thead>
          <tbody>{p.lines.map((l, k) => {
            const first = byLine.get(l.line_id)?.[0] === l
            const split = (byLine.get(l.line_id)?.length ?? 1) > 1
            return (
              <tr key={k}>
                <td className="desc">{l.description.split('\n').map((s, j) => <div key={j} className={j ? 'muted small' : ''}>{s}</div>)}</td>
                <td>{editable && first ? <Select value={l.product ?? ''} disabled={busy} onChange={e => run(() => api.setLine(id, l.line_id, e.target.value || null, l.class_set ?? null, l.applies_to ?? null))}>
                  <option value="">Pick…</option>{products.filter(x => x.active || x.code === l.product).map(x => <option key={x.code} value={x.code}>{x.name}</option>)}</Select>
                  : <span className={l.product ? '' : 'bad-t'}>{l.item ?? 'none'}</span>}</td>
                <td>{editable && first && !split ? <Select value={l.class_set ?? ''} disabled={busy} onChange={e => run(() => api.setLine(id, l.line_id, l.product, e.target.value || null, l.applies_to ?? null))}>
                  <option value="">{l.class && !l.class_set ? `${l.class} (from rules)` : l.class_set ? 'Back to the rules' : 'Pick…'}</option>{classes.filter(c => c.active).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</Select>
                  : <span className={l.class ? '' : 'bad-t'}>{l.class ?? 'none'}</span>}
                  <div className="muted small">{[l.site, l.year].filter(Boolean).join(' · ')}{split ? ' · split by farm' : ''}</div></td>
                <td className="num">{Number(l.qty).toLocaleString()}</td><td className="num">{money(Number(l.price))}</td><td className="num">{money(Number(l.amount))}</td>
                {editable && <td>{first && l.kind === 'charge' && <button className="ghost small" disabled={busy} title="Remove line" onClick={() => run(() => api.removeLine(id, l.line_id), 'Removed')}>✕</button>}</td>}
              </tr>)
          })}</tbody>
          <tfoot><tr><td colSpan={5}><b>Total</b></td><td className="num"><b>{money(p.total)}</b></td>{editable && <td />}</tr></tfoot>
        </table>
        <p className="muted small">The class comes from where each package was grown and its harvest year (Accounting › Settings › Class rules). Picking a class in the dropdown overrides the rules for that line.</p>
        {editable && (add ? (
          <div className="row wrap invcharge">
            <Select value={add.product} onChange={e => setAdd({ ...add, product: e.target.value })}>
              {products.filter(x => x.active && ['shipping', 'adjust', 'other'].includes(x.grp)).map(x => <option key={x.code} value={x.code}>{x.name}</option>)}</Select>
            <input placeholder="Description (optional)" value={add.desc} onChange={e => setAdd({ ...add, desc: e.target.value })} />
            <input type="number" step="0.01" placeholder="Amount" value={add.amount} onChange={e => setAdd({ ...add, amount: e.target.value })} />
            {products.find(x => x.code === add.product)?.grp === 'adjust' && <Select value={add.applies} onChange={e => setAdd({ ...add, applies: e.target.value })}>
              <option value="">Applies to: biggest line</option>{[...new Map(productLines.map(l => [l.line_id, l])).values()].map(l => <option key={l.line_id} value={l.line_id}>{l.description.split('\n')[0]}</option>)}</Select>}
            <button className="primary small" disabled={busy || add.amount === ''} onClick={() => run(() => api.addLine(id, add.product, add.desc, 1, Number(add.amount), add.applies ? Number(add.applies) : null), 'Line added').then(() => setAdd(null))}>Add</button>
            <button className="ghost small" onClick={() => setAdd(null)}>Cancel</button>
            {products.find(x => x.code === add.product)?.grp === 'adjust' && <span className="muted small">Discounts, returns and refunds go on as a minus amount.</span>}
          </div>
        ) : <button className="ghost small" onClick={() => setAdd({ product: products.find(x => x.grp === 'shipping')?.code ?? 'SHIPPING', desc: '', amount: '', applies: '' })}>+ Shipping, discount, return or refund</button>)}
        {p.memo && <div className="muted small acctmemo"><b>Message on the invoice:</b> {p.memo.split('\n').map((s, k) => <div key={k}>{s}</div>)}</div>}
        <div className="row between wrap">
          <span className="muted small">{locked ? 'Locked: it\'s in your real QuickBooks. Make changes there.' : env === 'sandbox' && p.push?.status === 'sent' ? 'Sending again updates the sandbox copy.' : ''}</span>
          {canEdit && !locked && <button className="primary" disabled={busy || p.problems.length > 0} onClick={send}>{busy ? 'Working…' : p.push?.status === 'sent' ? 'Send again (update)' : `Send to ${env === 'sandbox' ? 'sandbox' : 'QuickBooks'}`}</button>}
        </div>
      </div>
    </div>
  )
}

// ---------- Settings ----------
function SettingsTab({ api, flash, conn, env, refresh, sb, canEdit }: { api: AcctApi; flash: Flash; conn: { env: Env; connected: boolean; company?: string; error?: string } | null; env: Env; refresh: () => void; sb: ReturnType<Backend['client']>; canEdit: boolean }) {
  const [sec, setSec] = useState<'conn' | 'products' | 'classes' | 'rules' | 'pay' | 'people'>('conn')
  return (
    <div className="list">
      <h2>Accounting settings</h2>
      <div className="seg tabs">{([['conn', 'QuickBooks'], ['products', 'Products'], ['classes', 'Classes'], ['rules', 'Class rules'], ['pay', 'Crew and piece rates'], ['people', 'People']] as const).map(([k, l]) => <button key={k} className={sec === k ? 'on' : ''} onClick={() => setSec(k)}>{l}</button>)}</div>
      {sec === 'conn' && <ConnPanel api={api} flash={flash} conn={conn} env={env} refresh={refresh} />}
      {sec === 'products' && <ProductsPanel api={api} flash={flash} />}
      {sec === 'classes' && <ClassesPanel api={api} flash={flash} />}
      {sec === 'rules' && <RulesPanel api={api} flash={flash} />}
      {sec === 'pay' && sb && <PaySettings sb={sb} flash={flash} canEdit={canEdit} isAdmin />}
      {sec === 'people' && <ModulePeople sb={sb} module="accounting" flash={flash} />}
    </div>
  )
}

/** Settings > QuickBooks: auto-send on / off. Off = nothing goes to QuickBooks on its own (pause it while switching sandbox to the real books). */
function AutoSend({ api, flash, env, conn }: { api: AcctApi; flash: Flash; env: Env; conn: { connected: boolean } | null }) {
  type Auto = { on: boolean; minutes: number; due: number | null }
  const [auto, setAuto] = useState<Auto | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.server<Auto>('run', { action: 'auto' }).then(a => { setAuto(a); setErr(null) }).catch(e => setErr(msg(e)))
  useEffect(() => { load() }, [conn])
  async function flip(on: boolean) {
    if (!auto) return
    const waiting = auto.due ? `${auto.due >= 40 ? '40 or more invoices are' : auto.due === 1 ? '1 invoice is' : `${auto.due} invoices are`} already waiting and will go to ${ENV_LABEL[env]} within 10 minutes.` : ''
    const ask = on
      ? `Turn auto-send on? New invoices for outside customers will go to ${ENV_LABEL[env]} ${auto.minutes} minutes after they're made.${waiting ? `\n\n${waiting} Check To send first.` : ''}`
      : 'Turn auto-send off? Nothing goes to QuickBooks on its own until it\'s back on. Invoices made while it\'s off won\'t go later on their own: send them from To send.'
    if (!confirm(ask)) return
    setBusy(true)
    try { setAuto(await api.server<Auto>('run', { action: 'auto', on })); flash(on ? 'Auto-send is on' : 'Auto-send is off') }
    catch (e) { flash(msg(e), true) } finally { setBusy(false) }
  }
  return (
    <>
      <h3>Auto-send</h3>
      {err ? <p className="bad-t small">Couldn't load auto-send: {err}</p> : !auto ? <p className="muted small">Loading…</p> : <>
        <p>{auto.on ? <b className="ok-t">On</b> : <b className="bad-t">Off</b>}{' · '}
          {auto.on ? `new invoices for outside customers go to ${ENV_LABEL[env]} ${auto.minutes} minutes after they're made (editing restarts the clock).`
            : 'nothing goes to QuickBooks on its own. Send invoices by hand from To send.'}</p>
        {!!auto.due && <p className={auto.on ? 'muted small' : 'warn-t small'}>{auto.due >= 40 ? '40 or more invoices are' : auto.due === 1 ? '1 invoice is' : `${auto.due} invoices are`} past their wait{auto.on ? ' and going out now.' : ' and will go within 10 minutes of turning auto-send on.'}</p>}
        <div className="row wrap"><button className={auto.on ? 'ghost' : 'primary'} disabled={busy} onClick={() => flip(!auto.on)}>{busy ? 'Saving…' : auto.on ? 'Turn auto-send off' : 'Turn auto-send on'}</button></div>
        <p className="muted small">Turn it off before switching from the sandbox to your real QuickBooks, send one invoice by hand to check it, then turn it back on. While it's off, new invoices aren't queued, so they won't go later on their own.</p>
      </>}
    </>
  )
}

function ConnPanel({ api, flash, conn, env, refresh }: { api: AcctApi; flash: Flash; conn: { env: Env; connected: boolean; company?: string; error?: string } | null; env: Env; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [rows, setRows] = useState<Conn[]>([])
  const [check, setCheck] = useState<{ missing: { products: string[]; classes: string[] }; products: number; classes: number } | null>(null)
  const [refs, setRefs] = useState<Ref[] | null>(null)
  useEffect(() => { api.connection().then(c => setRows(c.connections)).catch(() => {}) }, [conn])
  const act = async (label: string, f: () => Promise<void>) => { setBusy(label); try { await f() } catch (e) { flash(msg(e), true) } finally { setBusy(null) } }
  const cur = rows.find(r => r.env === env)
  return (
    <div className="dlist acctconn">
      <p>Connected to: <b>{ENV_LABEL[env]}</b> <EnvPill env={env} /></p>
      {conn?.connected ? <p className="ok-t">✓ {conn.company ?? 'Connected'}{cur ? ` · connected by ${(cur.connected_by ?? '').split('@')[0]} ${when(cur.connected_at)}` : ''}</p>
        : <p className="bad-t">Not connected{conn?.error ? `: ${conn.error}` : ''}</p>}
      {cur?.last_error && <p className="bad-t small">Last problem: {cur.last_error}</p>}
      <div className="row wrap">
        <button className="primary" disabled={!!busy} onClick={() => act('connect', async () => { const r = await api.server<{ url: string }>('connect', {}); location.href = r.url })}>{conn?.connected ? 'Reconnect' : 'Connect QuickBooks'}</button>
        {conn?.connected && env === 'sandbox' && <button className="ghost" disabled={!!busy} onClick={() => act('setup', async () => { const r = await api.server<{ classes: number; products: number; income_account: string }>('run', { action: 'setup' }); flash(`Sandbox set up: ${r.classes} classes and ${r.products} products added (income account "${r.income_account}")`) })}>{busy === 'setup' ? 'Setting up…' : 'Set up sandbox'}</button>}
        {conn?.connected && <button className="ghost" disabled={!!busy} onClick={() => act('check', async () => setCheck(await api.server('run', { action: 'check' })))}>{busy === 'check' ? 'Checking…' : 'Check products and classes'}</button>}
        {conn?.connected && <button className="ghost" disabled={!!busy} onClick={() => { if (confirm(`Disconnect ${ENV_LABEL[env]}? Sending stops until someone connects again.`)) act('disc', async () => { await api.server('run', { action: 'disconnect' }); flash('Disconnected'); refresh() }) }}>Disconnect</button>}
      </div>
      {check && (check.missing.products.length || check.missing.classes.length
        ? <div className="warnbox">Not found in QuickBooks with exactly these names:{check.missing.products.length > 0 && <div>Products: {check.missing.products.join(', ')}</div>}{check.missing.classes.length > 0 && <div>Classes: {check.missing.classes.join(', ')}</div>}
            <div className="small">Add them in QuickBooks, or fix the names here under Products / Classes.{env === 'sandbox' ? ' On the sandbox, Set up sandbox adds them.' : ''}</div></div>
        : <p className="ok-t">✓ All {check.products} products and the {check.classes} classes the rules use are in QuickBooks.</p>)}
      <AutoSend api={api} flash={flash} env={env} conn={conn} />
      <h3>How it works</h3>
      <ul className="muted small">
        <li>Which QuickBooks the app talks to is set in Vercel (QBO_ENV = sandbox or production). Switching means changing that, redeploying, and connecting here again.</li>
        <li>The sandbox is Intuit's test company. Sending there doesn't lock invoices or mark them paid.</li>
        <li>In the real QuickBooks: sent invoices lock in the app, and paid / balance come back from QuickBooks every night (or Check payments now).</li>
        <li>The QuickBooks login is kept on the server. Nobody can read it from the app.</li>
        <li>Problems with QuickBooks? Email <a href="mailto:accounting@lifted-organics.com?subject=QuickBooks%20connection">accounting@lifted-organics.com</a>. Include the error message and its QuickBooks ref, if it shows one.</li>
      </ul>
      <h3>Matched in QuickBooks</h3>
      {refs == null ? <button className="ghost small" onClick={() => api.refs().then(setRefs).catch(e => flash(msg(e), true))}>Show matches</button> : (
        <div className="dlist">{refs.filter(r => r.env === env).map(r => (
          <div key={`${r.kind}${r.key}`} className="drow"><span><b>{r.kind}</b> {r.key} → {r.name ?? r.qbo_id} <span className="muted small">#{r.qbo_id}</span></span>
            <button className="ghost small" title="Look it up again on the next send" onClick={() => api.forgetRef(r.kind, r.key).then(() => api.refs().then(setRefs)).catch(e => flash(msg(e), true))}>Forget</button></div>))}
          {!refs.some(r => r.env === env) && <Empty>Nothing matched yet. Customers, products and classes get matched the first time an invoice uses them.</Empty>}</div>)}
    </div>
  )
}

function ProductsPanel({ api, flash }: { api: AcctApi; flash: Flash }) {
  const [rows, setRows] = useState<Product[] | null>(null)
  const [ed, setEd] = useState<{ code: string; name: string; grp: Product['grp']; active: boolean; isNew: boolean } | null>(null)
  const load = () => api.products().then(setRows).catch(e => flash(msg(e), true))
  useEffect(() => { load() }, [])
  if (!rows) return <p className="muted">Loading…</p>
  const save = async () => { if (!ed) return; try { await api.saveProduct(ed); setEd(null); await load(); flash('Saved') } catch (e) { flash(msg(e), true) } }
  return (
    <div className="dlist">
      <p className="muted small">Names must match the QuickBooks product / service list exactly. The group decides the class (Class rules) and where the product shows up.</p>
      <button className="primary small" onClick={() => setEd({ code: '', name: '', grp: 'flower', active: true, isNew: true })}>+ Product</button>
      {rows.map(p => <button key={p.code} className="drow click" onClick={() => setEd({ ...p, isNew: false })}><span><b>{p.name}</b><span className="muted"> · {GRP_LABEL[p.grp]}</span></span>{!p.active && <span className="pill">off</span>}</button>)}
      {ed && <div className="scrim" onClick={() => setEd(null)}><div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{ed.isNew ? 'New product' : ed.name}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
        <div className="field"><label>Name in QuickBooks</label><input value={ed.name} onChange={e => setEd({ ...ed, name: e.target.value })} placeholder="Fresh Frozen" /></div>
        <div className="field"><label>Group</label><Select value={ed.grp} onChange={e => setEd({ ...ed, grp: e.target.value as Product['grp'] })}>{(Object.keys(GRP_LABEL) as Product['grp'][]).map(g => <option key={g} value={g}>{GRP_LABEL[g]}</option>)}</Select></div>
        <label className="check"><input type="checkbox" checked={ed.active} onChange={e => setEd({ ...ed, active: e.target.checked })} /> In use</label>
        <div className="row between"><span /><div className="row"><button className="ghost" onClick={() => setEd(null)}>Cancel</button><button className="primary" disabled={!ed.name.trim()} onClick={save}>Save</button></div></div>
      </div></div>}
    </div>
  )
}

function ClassesPanel({ api, flash }: { api: AcctApi; flash: Flash }) {
  const [rows, setRows] = useState<AClass[] | null>(null)
  const [ed, setEd] = useState<{ name: string; old: string | null; active: boolean } | null>(null)
  const load = () => api.classes().then(setRows).catch(e => flash(msg(e), true))
  useEffect(() => { load() }, [])
  if (!rows) return <p className="muted">Loading…</p>
  const save = async () => { if (!ed) return; try { await api.saveClass(ed.name, ed.old, ed.active); setEd(null); await load(); flash('Saved') } catch (e) { flash(msg(e), true) } }
  return (
    <div className="dlist">
      <p className="muted small">Your QuickBooks classes, named exactly as in QuickBooks. Renaming here changes the rules that use it.</p>
      <button className="primary small" onClick={() => setEd({ name: '', old: null, active: true })}>+ Class</button>
      {rows.map(c => <button key={c.name} className="drow click" onClick={() => setEd({ name: c.name, old: c.name, active: c.active })}><span><b>{c.name}</b>{c.notes && <span className="muted"> · {c.notes}</span>}</span>{!c.active && <span className="pill">off</span>}</button>)}
      {ed && <div className="scrim" onClick={() => setEd(null)}><div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{ed.old ?? 'New class'}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
        <div className="field"><label>Name in QuickBooks</label><input value={ed.name} onChange={e => setEd({ ...ed, name: e.target.value })} /></div>
        <label className="check"><input type="checkbox" checked={ed.active} onChange={e => setEd({ ...ed, active: e.target.checked })} /> In use</label>
        <div className="row between"><span /><div className="row"><button className="ghost" onClick={() => setEd(null)}>Cancel</button><button className="primary" disabled={!ed.name.trim()} onClick={save}>Save</button></div></div>
      </div></div>}
    </div>
  )
}

function RulesPanel({ api, flash }: { api: AcctApi; flash: Flash }) {
  const [rows, setRows] = useState<Rule[] | null>(null)
  const [classes, setClasses] = useState<AClass[]>([])
  const [dirty, setDirty] = useState(false)
  const load = () => Promise.all([api.rules(), api.classes()]).then(([r, c]) => { setRows(r); setClasses(c); setDirty(false) }).catch(e => flash(msg(e), true))
  useEffect(() => { load() }, [])
  if (!rows) return <p className="muted">Loading…</p>
  const set = (k: number, patch: Partial<Rule>) => { setRows(rows.map((r, j) => j === k ? { ...r, ...patch } : r)); setDirty(true) }
  const move = (k: number, d: number) => { const r = [...rows]; const [x] = r.splice(k, 1); r.splice(k + d, 0, x); setRows(r); setDirty(true) }
  const num = (v: string) => v === '' ? null : Number(v)
  const save = async () => { try { await api.saveRules(rows); await load(); flash('Rules saved') } catch (e) { flash(msg(e), true) } }
  return (
    <div>
      <p className="muted small">Each invoice line's class: the first rule that matches wins. Farm comes from the package's METRC batch (FL26-GV… = GVR, FL26-OH… = OHR); outside nursery sales are 1PN. Year is the crop / harvest year. Blank = any. Discounts, returns and refunds take the class of the line they apply to.</p>
      <div className="tablewrap"><table className="restable rules">
        <thead><tr><th /><th>Farm</th><th>Group</th><th>From year</th><th>To year</th><th>Class</th><th>Note</th><th /></tr></thead>
        <tbody>{rows.map((r, k) => (
          <tr key={k}>
            <td className="nowrap"><button className="ghost small" disabled={k === 0} onClick={() => move(k, -1)}>↑</button><button className="ghost small" disabled={k === rows.length - 1} onClick={() => move(k, 1)}>↓</button></td>
            <td><Select value={r.site ?? ''} onChange={e => set(k, { site: e.target.value || null })}><option value="">Any</option>{['OHR', 'GVR', '1PN'].map(s => <option key={s}>{s}</option>)}</Select></td>
            <td><Select value={r.grp ?? ''} onChange={e => set(k, { grp: e.target.value || null })}><option value="">Any</option>{(Object.keys(GRP_LABEL) as Product['grp'][]).filter(g => g !== 'adjust').map(g => <option key={g} value={g}>{GRP_LABEL[g].split(' (')[0]}</option>)}</Select></td>
            <td><input className="qty" type="number" value={r.year_from ?? ''} onChange={e => set(k, { year_from: num(e.target.value) })} /></td>
            <td><input className="qty" type="number" value={r.year_to ?? ''} onChange={e => set(k, { year_to: num(e.target.value) })} /></td>
            <td><Select value={r.class_name} onChange={e => set(k, { class_name: e.target.value })}>{classes.map(c => <option key={c.name}>{c.name}</option>)}</Select></td>
            <td><input value={r.notes ?? ''} onChange={e => set(k, { notes: e.target.value || null })} /></td>
            <td><button className="ghost small" onClick={() => { setRows(rows.filter((_, j) => j !== k)); setDirty(true) }}>✕</button></td>
          </tr>))}</tbody>
      </table></div>
      <div className="row wrap">
        <button className="ghost small" onClick={() => { setRows([...rows, { site: null, grp: null, year_from: null, year_to: null, class_name: classes[0]?.name ?? '', notes: null }]); setDirty(true) }}>+ Rule</button>
        {dirty && <><button className="primary small" onClick={save}>Save rules</button><button className="ghost small" onClick={load}>Undo changes</button></>}
      </div>
    </div>
  )
}
