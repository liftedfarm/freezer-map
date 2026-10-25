import { useEffect, useMemo, useState } from 'react'
import type { Backend } from './api'
import type { Customer, Invoice, NewOrderLine, PaymentTerm, Product, Strain } from './types'
import { PRODUCT_LABEL, SALE_PRODUCTS } from './types'
import type { SalesDoc } from './docs'
import { dfmt, docTitle, downloadPdf, emailHref, makePdf, money, shareUrl, textHref } from './docs'
import { Tile, Tiles } from './dash'

type Flash = (t: string, bad?: boolean) => void
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const STATUS: Record<string, string> = { open: 'Open', paid: 'Paid', void: 'Void' }
const ACCT: Record<string, string> = { pending: 'Not in QuickBooks yet', sent: 'In QuickBooks', error: 'QuickBooks error', skip: 'Not sent to QuickBooks' }

/** one SO or invoice: preview, download, email, text, link; invoices can be adjusted until they're in accounting */
export function DocSheet({ backend, kind, id, flash, onClose, onChanged, canEdit, canVoid, sender }: {
  backend: Backend; kind: 'invoice' | 'so' | 'nso'; id: number; flash: Flash; onClose: () => void; onChanged?: () => void
  canEdit: boolean; canVoid: boolean; sender?: string | null
}) {
  const [d, setD] = useState<SalesDoc | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [terms, setTerms] = useState<PaymentTerm[]>([])
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(false)
  const load = async () => {
    try {
      const doc = await backend.getDoc(kind, id); setD(doc)
      const blob = await makePdf(doc); setUrl(u => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(blob) })
    } catch (e) { flash(String((e as Error).message ?? e), true); onClose() }
  }
  useEffect(() => { load(); backend.paymentTerms().then(setTerms).catch(() => {}) }, [kind, id])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await load(); onChanged?.(); flash(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const editable = canEdit && d?.kind === 'invoice' && d.status !== 'void' && d.acct_status !== 'sent'
  async function copy() { if (!d) return; try { await navigator.clipboard.writeText(shareUrl(d)); flash('Link copied') } catch { flash(shareUrl(d)) } }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet docsheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{d ? `${docTitle(d)} ${d.number}` : 'Loading…'}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {d && <>
          <div className="row wrap docmeta">
            <b>{d.customer.name}</b><span className="muted">{money(d.total)} · {d.terms}{d.kind === 'invoice' && d.due ? ` · due ${dfmt(d.due)}` : ''}</span>
            {d.kind === 'invoice' && <span className={`pill inv-${d.status}`}>{STATUS[d.status]}</span>}
            {d.kind === 'invoice' && d.acct_status && <span className={`pill acct-${d.acct_status}`}>{ACCT[d.acct_status]}</span>}
            {d.kind === 'invoice' && d.sent_at && <span className="muted">emailed {dfmt(d.sent_at.slice(0, 10))}</span>}
          </div>
          <div className="row wrap docact">
            <button className="primary" disabled={busy} onClick={() => downloadPdf(d)}>Download PDF</button>
            <a className="btn ghost" href={emailHref(d, sender)} onClick={() => { if (d.kind === 'invoice') backend.markInvoiceSent(d.id, d.customer.billing_email ?? '').then(load).catch(() => {}) }}>Email</a>
            <a className="btn ghost" href={textHref(d)}>Text</a>
            <button className="ghost" onClick={copy}>Copy link</button>
            {editable && <button className="ghost" onClick={() => setEdit(!edit)}>{edit ? 'Done editing' : 'Edit'}</button>}
          </div>
          {!d.customer.billing_email && <p className="muted">No billing email for {d.customer.name}. A Sales Admin can add it in Sales → Settings → Customers.</p>}
          <p className="muted small">Email opens your own mail app with the link filled in. Attach the PDF too if the customer prefers it.</p>
          {edit && editable && <InvoiceEditor d={d} terms={terms} busy={busy} run={run} backend={backend} />}
          {d.kind === 'invoice' && canEdit && d.status !== 'void' && (
            <div className="row wrap docact">
              {d.acct_status === 'sent' ? <span className="muted small">Payments are recorded in QuickBooks; paid shows here after the nightly check.</span>
                : d.status === 'open' ? <button className="ghost small" disabled={busy} onClick={() => run(() => backend.setInvoiceStatus(d.id, 'paid'), 'Marked paid')}>Mark paid</button>
                : <button className="ghost small" disabled={busy} onClick={() => run(() => backend.setInvoiceStatus(d.id, 'open'), 'Marked open')}>Mark not paid</button>}
              {canVoid && d.acct_status !== 'sent' && <button className="ghost small" disabled={busy} onClick={() => { const why = prompt(`Void ${d.number}? Say why (optional):`); if (why !== null) run(() => backend.setInvoiceStatus(d.id, 'void', why), 'Voided') }}>Void</button>}
            </div>
          )}
          {url ? <iframe className="docframe" title={d.number} src={url} /> : <p className="muted">Making the PDF…</p>}
        </>}
      </div>
    </div>
  )
}

function InvoiceEditor({ d, terms, busy, run, backend }: { d: SalesDoc; terms: PaymentTerm[]; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; backend: Backend }) {
  const [date, setDate] = useState(d.date ?? today())
  const [po, setPo] = useState(d.po ?? '')
  const [notes, setNotes] = useState(d.notes ?? '')
  const [charge, setCharge] = useState({ product: 'SHIPPING', desc: '', qty: '1', price: '' })
  // QuickBooks products for charges (046): shipping, discounts, returns, refunds
  const [products, setProducts] = useState<{ code: string; name: string; grp: string }[]>([])
  useEffect(() => { backend.client()?.from('acct_products').select('code,name,grp').eq('active', true).order('sort').then(({ data }) => setProducts(((data ?? []) as { code: string; name: string; grp: string }[]).filter(x => ['shipping', 'adjust', 'other'].includes(x.grp)))) }, [])
  const chosen = products.find(x => x.code === charge.product)
  const addCharge = async () => {
    const sb = backend.client()
    if (sb && chosen) {
      const { error } = await sb.rpc('acct_add_line', { p_inv: d.id, p_product: chosen.code, p_description: charge.desc.trim() || chosen.name, p_qty: Number(charge.qty) || 1, p_price: Number(charge.price), p_applies_to: null })
      if (error) throw new Error(error.message)
    } else await backend.setInvoiceLine(d.id, null, charge.desc || 'Customer Shipping', Number(charge.qty) || 1, Number(charge.price))
  }
  return (
    <div className="invedit">
      <div className="grid2">
        <label><span>Payment terms</span>
          <select value={d.terms_code ?? ''} disabled={busy} onChange={e => run(() => backend.setInvoiceTerms(d.id, e.target.value), 'Terms changed')}>
            {terms.filter(t => t.active || t.code === d.terms_code).map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
          </select></label>
        <label><span>Invoice date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label><span>Customer PO</span><input value={po} onChange={e => setPo(e.target.value)} /></label>
        <label><span>Notes on the invoice</span><input value={notes} onChange={e => setNotes(e.target.value)} /></label>
      </div>
      {(date !== d.date || po !== (d.po ?? '') || notes !== (d.notes ?? '')) && <button className="primary small" disabled={busy} onClick={() => run(() => backend.setInvoiceInfo(d.id, date, po, notes), 'Saved')}>Save</button>}
      <table className="restable invlines"><thead><tr><th>Line</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>{d.lines.map(l => <LineRow key={l.id} l={l} busy={busy} onPrice={p => run(() => backend.setInvoiceLine(d.id, l.id, l.description, null, p), 'Price changed')}
          onRemove={l.kind === 'charge' ? () => run(() => backend.removeInvoiceLine(d.id, l.id), 'Removed') : undefined} />)}</tbody></table>
      <div className="row wrap invcharge">
        {products.length > 0 && <select value={charge.product} onChange={e => setCharge({ ...charge, product: e.target.value })}>{products.map(x => <option key={x.code} value={x.code}>{x.name}</option>)}</select>}
        <input value={charge.desc} onChange={e => setCharge({ ...charge, desc: e.target.value })} placeholder={chosen ? `Description (default: ${chosen.name})` : 'Charge (shipping, storage…)'} />
        <input type="number" value={charge.qty} onChange={e => setCharge({ ...charge, qty: e.target.value })} placeholder="Qty" />
        <input type="number" value={charge.price} onChange={e => setCharge({ ...charge, price: e.target.value })} placeholder={chosen?.grp === 'adjust' ? 'Amount off' : 'Price'} />
        <button className="ghost small" disabled={busy || (!chosen && !charge.desc.trim()) || charge.price === ''} onClick={() => run(addCharge, chosen?.grp === 'adjust' ? 'Discount added' : 'Charge added').then(() => setCharge({ product: charge.product, desc: '', qty: '1', price: '' }))}>+ Add</button>
      </div>
      <p className="muted small">Quantities come from what actually shipped. Change prices here, or add shipping, discounts, returns or refunds (they go on as a minus amount). Contract customers get a $0 "Free shipping - contract" line automatically. Locked once the invoice is in QuickBooks.</p>
    </div>
  )
}

function LineRow({ l, busy, onPrice, onRemove }: { l: SalesDoc['lines'][number]; busy: boolean; onPrice: (p: number) => void; onRemove?: () => void }) {
  const [p, setP] = useState(String(l.price))
  return (
    <tr><td>{l.description}</td><td className="num">{Number(l.qty).toLocaleString()} {l.uom}</td>
      <td className="num"><input className="qty" type="number" step="0.01" value={p} onChange={e => setP(e.target.value)} onBlur={() => { if (Number(p) !== Number(l.price) && p !== '') onPrice(Number(p)) }} disabled={busy} /></td>
      <td className="num">{money(l.amount)}</td><td>{onRemove && <button className="ghost small" disabled={busy} onClick={onRemove}>✕</button>}</td></tr>
  )
}

/** Sales > Invoices */
export function InvoicesView({ backend, customers, flash, isAdmin, sender, scope = 'sales' }: { backend: Backend; customers: Customer[]; flash: Flash; isAdmin: boolean; sender?: string | null; scope?: 'sales' | 'nursery' }) {
  const [rows, setRows] = useState<Invoice[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [f, setF] = useState<'open' | 'overdue' | 'paid' | 'void' | 'all'>('open')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const load = () => backend.listInvoices(scope).then(r => { setRows(r); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])
  const cname = useMemo(() => { const m = new Map(customers.map(c => [c.id, c.name])); return (id: number) => m.get(id) ?? `#${id}` }, [customers])
  if (err) return <div className="list"><h2>Invoices</h2><div className="warnbox">{err}</div></div>
  if (!rows) return <p className="muted">Loading…</p>
  const now = today()
  const overdue = (i: Invoice) => i.status === 'open' && !!i.due_date && i.due_date < now
  const ql = q.trim().toLowerCase()
  const shown = rows.filter(i => (f === 'all' || (f === 'overdue' ? overdue(i) : i.status === f)) && (!ql || `${i.inv_number} ${cname(i.customer_id)} ${i.po_number ?? ''}`.toLowerCase().includes(ql)))
  const sum = (xs: Invoice[]) => xs.reduce((a, i) => a + Number(i.total), 0)
  const openI = rows.filter(i => i.status === 'open'), od = rows.filter(overdue)
  const notAcct = rows.filter(i => i.status !== 'void' && i.acct_status === 'pending')
  return (
    <div className="list invoices">
      <h2>Invoices</h2>
      <Tiles>
        <Tile label="Open" value={money(sum(openI))} sub={`${openI.length} invoices`} onClick={() => setF('open')} />
        <Tile label="Overdue" value={money(sum(od))} sub={`${od.length} invoices`} tone={od.length ? 'bad' : 'ok'} onClick={() => setF('overdue')} />
        <Tile label="Not in QuickBooks yet" value={notAcct.length} sub="Accounting sends them" tone={notAcct.length ? 'info' : undefined} />
      </Tiles>
      <div className="row toolbar">
        <div className="seg">{(['open', 'overdue', 'paid', 'void', 'all'] as const).map(k => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}</div>
        <input className="search" type="search" placeholder="Invoice #, customer or PO" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {!shown.length && <p className="muted">{scope === 'nursery' ? 'No invoices here. A clone invoice is made each time plants are delivered on an order.' : 'No invoices here. Invoices are made when an order\'s stop is delivered, or from the order with "Make invoice".'}</p>}
      {shown.map(i => (
        <button key={i.id} className="li setrow" onClick={() => setOpen(i.id)}>
          <div className="grow"><div><b>{i.inv_number}</b> <span className={`pill inv-${overdue(i) ? 'overdue' : i.status}`}>{overdue(i) ? 'Overdue' : STATUS[i.status]}</span></div>
            <div className="muted">{cname(i.customer_id)} · {dfmt(i.invoice_date)} · {i.terms_label}{i.due_date ? ` · due ${dfmt(i.due_date)}` : ''}{i.sent_at ? ' · emailed' : ''}</div></div>
          <b className="num">{money(i.total)}</b>
        </button>
      ))}
      {open != null && <DocSheet backend={backend} kind="invoice" id={open} flash={flash} onClose={() => setOpen(null)} onChanged={load} canEdit canVoid={isAdmin} sender={sender} />}
    </div>
  )
}

/** Sales > Orders > New order */
/** customer license check (Compliance, 055): warn, don't block (we're mostly wholesale) */
export function licenseWarning(c: Customer): string | null {
  if (c.kind !== 'external') return null
  if (!c.license?.trim()) return `No state license on file for ${c.name}.`
  const exp = c.license_expires
  if (exp && exp < new Date().toISOString().slice(0, 10)) return `${c.name}'s license (${c.license}) expired ${exp}.`
  return null
}

export function NewOrderSheet({ backend, customers, strains, flash, onClose, onDone }: {
  backend: Backend; customers: Customer[]; strains: Strain[]; flash: Flash; onClose: () => void; onDone: (id: number) => void
}) {
  const [cust, setCust] = useState<number | null>(null)
  const [po, setPo] = useState('')
  const [wanted, setWanted] = useState('')
  const [notes, setNotes] = useState('')
  const [termsCode, setTermsCode] = useState<string>('')
  const [shipping, setShipping] = useState('')
  const [terms, setTerms] = useState<PaymentTerm[]>([])
  const [lines, setLines] = useState<{ strain: string; lbs: string; price: string; product: Product; sample?: boolean; hold?: string }[]>([{ strain: '', lbs: '', price: '', product: 'fresh_frozen' }])
  const [busy, setBusy] = useState(false)
  useEffect(() => { backend.paymentTerms().then(setTerms).catch(() => {}) }, [])
  const c = customers.find(x => x.id === cust)
  useEffect(() => { setTermsCode(c?.payment_terms ?? '') }, [cust])
  const ok = cust != null && lines.some(l => l.strain.trim() && Number(l.lbs) > 0)
  async function save() {
    setBusy(true)
    try {
      const ls: NewOrderLine[] = lines.filter(l => l.strain.trim() && Number(l.lbs) > 0).map(l => ({ strain: l.strain.trim(), lbs: Number(l.lbs), price: l.price === '' ? null : Number(l.price), product: l.product }))
      const o = await backend.createOrder(cust!, ls, po, wanted || null, notes, termsCode || null)
      const used = lines.filter(l => l.strain.trim() && Number(l.lbs) > 0)
      if (used.some(l => l.sample)) {
        try {
          // lines come back in the order they were sent
          const { data } = await backend.client()!.from('order_lines').select('id').eq('order_id', o.id).order('id')
          const ids = ((data ?? []) as { id: number }[]).map(x => x.id)
          await backend.setOrderSample(o.id, true, used.map((l, i) => ({ line_id: ids[i], sample: !!l.sample && l.product === 'fresh_frozen', hold_lbs: l.sample ? Number(l.hold || 0) || null : null })).filter(x => x.line_id))
        } catch (e) { flash(`Order made, but the sample lines weren't saved: ${(e as Error).message}`, true) }
      }
      if (shipping !== '') {
        const { error } = await backend.client()?.rpc('set_order_shipping', { p_order: o.id, p_amount: Number(shipping) }) ?? { error: null }
        if (error) flash(`Order made, but shipping wasn't saved: ${error.message}`, true)
      }
      flash(`${o.so_number} created`); onDone(o.id)
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>New sales order</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="field"><label>Customer</label>
          <select value={cust ?? ''} onChange={e => setCust(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Pick a customer…</option>
            {customers.filter(x => x.active && x.kind === 'external').sort((a, b) => a.name.localeCompare(b.name)).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          {c && <span className="muted">{c.price_per_lb != null ? `Contract price ${money(Number(c.price_per_lb))}/lb` : 'No contract price set'} · {terms.find(t => t.code === c.payment_terms)?.label ?? 'Due on receipt'}</span>}
          {c && licenseWarning(c) && <div className="warnbox">{licenseWarning(c)} Compliance keeps customer licenses in Compliance › Library › Customer licenses.</div>}</div>
        <div className="field"><label>Lines <span className="muted">(price blank = their contract price for fresh frozen; dry products get priced on the invoice)</span></label>
          <datalist id="no-strains">{strains.filter(s => s.active).map(s => <option key={s.id} value={s.name} />)}</datalist>
          {lines.map((l, i) => (<div key={i} className="nolinewrap">
            <div className="row noline">
              <select value={l.product} aria-label="Product" onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, product: e.target.value as Product } : x))}>
                {SALE_PRODUCTS.map(p => <option key={p} value={p}>{PRODUCT_LABEL[p]}</option>)}</select>
              <input list="no-strains" placeholder="Strain" value={l.strain} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, strain: e.target.value } : x))} />
              <input type="number" placeholder="lbs" value={l.lbs} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, lbs: e.target.value } : x))} />
              <input type="number" placeholder="$/lb" value={l.price} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} />
              {lines.length > 1 && <button className="ghost small" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button>}
            </div>
            {l.product === 'fresh_frozen' && <div className="row nosample">
              <label className="check"><input type="checkbox" checked={!!l.sample} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, sample: e.target.checked } : x))} /> Sample</label>
              {l.sample && <><input type="number" step="10" min="0" placeholder="hold lbs" value={l.hold ?? ''} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, hold: e.target.value } : x))} />
                <span className="muted small">lbs to hold for them</span></>}
            </div>}
          </div>
          ))}
          <button className="ghost small" onClick={() => setLines(ls => [...ls, { strain: '', lbs: '', price: '', product: ls[ls.length - 1]?.product ?? 'fresh_frozen' }])}>+ Line</button></div>
        {lines.some(l => l.sample) && <p className="muted small">Sample lines hold the "hold lbs" for {c?.name ?? 'the customer'} from now until {c?.sample_hold_days ?? 10} days after the order ships. Cancelling the order drops the hold.</p>}
        <div className="grid2">
          <div className="field"><label>Customer PO</label><input value={po} onChange={e => setPo(e.target.value)} /></div>
          <div className="field"><label>Wanted by</label><input type="date" value={wanted} onChange={e => setWanted(e.target.value)} /></div>
        </div>
        <div className="field"><label>Payment terms <span className="muted">(this order only)</span></label>
          <select value={termsCode} onChange={e => setTermsCode(e.target.value)}>
            <option value="">{c ? `Customer default (${terms.find(t => t.code === c.payment_terms)?.label ?? 'Due on receipt'})` : 'Customer default'}</option>
            {terms.filter(t => t.active).map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
          </select></div>
        <div className="field"><label>Shipping <span className="muted">($, blank = none{c && ((c.contract_lbs ?? 0) > 0) ? '; contract customers get a $0 "Free shipping - contract" line' : ''})</span></label>
          <input type="number" step="0.01" min="0" value={shipping} onChange={e => setShipping(e.target.value)} placeholder="0.00" /></div>
        <div className="field"><label>Notes</label><input value={notes} onChange={e => setNotes(e.target.value)} /></div>
        <p className="muted">The order is confirmed and gets its SO number right away, then shows in Distribution → Fulfillment.</p>
        <div className="row between"><span /><div className="row"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !ok} onClick={save}>Create order</button></div></div>
      </div>
    </div>
  )
}

/** Sales > Settings > Payment terms */
export function TermsPanel({ backend, flash, canEdit }: { backend: Backend; flash: Flash; canEdit: boolean }) {
  const [rows, setRows] = useState<PaymentTerm[] | null>(null)
  const [ed, setEd] = useState<{ code: string; label: string; parts: { pct: string; days: string }[]; cod: boolean; active: boolean; isNew: boolean } | null>(null)
  const load = () => backend.paymentTerms().then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  if (!rows) return <p className="muted">Loading…</p>
  const desc = (t: PaymentTerm) => t.schedule.map(p => `${p.pct}% ${p.days ? `in ${p.days} days` : 'on the invoice date'}`).join(', ')
  async function save() {
    if (!ed) return
    try {
      await backend.setPaymentTerm({ code: ed.code, label: ed.label, schedule: ed.parts.map(p => ({ pct: Number(p.pct), days: Number(p.days) || 0 })), cod: ed.cod, active: ed.active })
      setEd(null); await load(); flash('Saved')
    } catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  return (
    <div className="dlist">
      <p className="muted">Set each customer's default in Customers. Sales can change the terms on any order or invoice.</p>
      {canEdit && <button className="primary small" onClick={() => setEd({ code: '', label: '', parts: [{ pct: '100', days: '30' }], cod: false, active: true, isNew: true })}>+ Payment terms</button>}
      {rows.map(t => (
        <button key={t.code} className="drow click" disabled={!canEdit} onClick={() => setEd({ code: t.code, label: t.label, parts: t.schedule.map(p => ({ pct: String(p.pct), days: String(p.days) })), cod: t.cod, active: t.active, isNew: false })}>
          <span><b>{t.label}</b><span className="muted"> · {t.code} · {desc(t)}{t.cod ? ' · cash on delivery' : ''}</span></span>{!t.active && <span className="pill">retired</span>}</button>
      ))}
      {ed && (
        <div className="scrim" onClick={() => setEd(null)}>
          <div className="sheet form" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><h2>{ed.isNew ? 'New payment terms' : ed.label}</h2><button className="ghost" onClick={() => setEd(null)}>✕</button></div>
            <div className="grid2"><div className="field"><label>Code</label><input value={ed.code} disabled={!ed.isNew} onChange={e => setEd({ ...ed, code: e.target.value.toUpperCase() })} placeholder="NET60" /></div>
              <div className="field"><label>Name on invoices</label><input value={ed.label} onChange={e => setEd({ ...ed, label: e.target.value })} placeholder="Net 60" /></div></div>
            <div className="field"><label>Parts <span className="muted">(must add up to 100%)</span></label>
              {ed.parts.map((p, i) => (
                <div key={i} className="row noline"><input type="number" value={p.pct} onChange={e => setEd({ ...ed, parts: ed.parts.map((x, j) => j === i ? { ...x, pct: e.target.value } : x) })} /><span>% due</span>
                  <input type="number" value={p.days} onChange={e => setEd({ ...ed, parts: ed.parts.map((x, j) => j === i ? { ...x, days: e.target.value } : x) })} /><span>days after the invoice</span>
                  {ed.parts.length > 1 && <button className="ghost small" onClick={() => setEd({ ...ed, parts: ed.parts.filter((_, j) => j !== i) })}>✕</button>}</div>))}
              <button className="ghost small" onClick={() => setEd({ ...ed, parts: [...ed.parts, { pct: '', days: '' }] })}>+ Part</button></div>
            <label className="check"><input type="checkbox" checked={ed.cod} onChange={e => setEd({ ...ed, cod: e.target.checked })} /> Cash on delivery</label>
            <label className="check"><input type="checkbox" checked={ed.active} onChange={e => setEd({ ...ed, active: e.target.checked })} /> In use</label>
            <div className="row between"><span /><div className="row"><button className="ghost" onClick={() => setEd(null)}>Cancel</button>
              <button className="primary" disabled={!ed.code.trim() || !ed.label.trim() || ed.parts.reduce((a, p) => a + Number(p.pct || 0), 0) !== 100} onClick={save}>Save</button></div></div>
          </div>
        </div>
      )}
    </div>
  )
}

/** the page behind a texted / emailed link: anyone with the link sees the document and can download it */
export function SharedDocPage({ backend, token }: { backend: Backend; token: string }) {
  const [d, setD] = useState<SalesDoc | null | undefined>(undefined)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => { backend.sharedDoc(token).then(async doc => { setD(doc); if (doc) setUrl(URL.createObjectURL(await makePdf(doc))) }).catch(() => setD(null)) }, [token])
  useEffect(() => { if (d) document.title = `${docTitle(d)} ${d.number} · Lifted Farms` }, [d])
  if (d === undefined) return <div className="center muted">Loading…</div>
  if (!d) return <div className="center"><img className="logo-login logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-login logo-d" src="/logo-dark.svg" alt="Lifted Farms" /><h2>This link doesn't work</h2><p className="muted">It may have been replaced. Ask Lifted Farms for a new one.</p></div>
  return (
    <div className="shareddoc">
      <div className="row between wrap"><div><img className="logo-img logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-img logo-d" src="/logo-dark.svg" alt="Lifted Farms" /></div>
        <div className="row"><button className="primary" onClick={() => downloadPdf(d)}>Download PDF</button></div></div>
      <h2>{docTitle(d)} {d.number}</h2>
      <p className="muted">{d.customer.name} · {money(d.total)} · {d.terms}{d.kind === 'invoice' && d.due ? ` · due ${dfmt(d.due)}` : ''}{d.kind === 'invoice' && d.status === 'paid' ? ' · paid, thank you' : ''}</p>
      {url ? <iframe className="docframe big" title={d.number} src={url} /> : <p className="muted">Making the PDF…</p>}
    </div>
  )
}
