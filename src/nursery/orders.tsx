import { useMemo, useState } from 'react'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { STATUS_LABEL, fmtD, n0, strainKey, sum, today } from './calc'
import type { NCustomer, NData, NOrder } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import type { PaymentTerm } from '../types'

const money = (x: number) => x.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
export const statusPill = (o: NOrder, c: NCtx) => {
  const late = c.isOpen(o) && o.deliver_on && o.deliver_on < today()
  return <span className={`pill ${late ? 'badp' : o.status === 'received' ? 'okp' : o.status === 'planned' ? '' : o.status === 'cancelled' ? '' : 'warnp'}`}>{late ? 'Late' : STATUS_LABEL[o.status]}</span>
}

/** Nursery > Orders: what the farms (and outside farms) want, and when */
export function OrdersTab({ d, c, q, onOpen, onNew }: { d: NData; c: NCtx; q: string; onOpen: (o: NOrder) => void; onNew: () => void }) {
  const [f, setF] = useState<'open' | 'done' | 'all'>('open')
  const ql = q.trim().toLowerCase()
  const rows = d.orders.filter(o => (f === 'all' || (f === 'open' ? c.isOpen(o) : !c.isOpen(o))) &&
    (!ql || `${o.strain} ${c.to(o)} ${o.so_number ?? ''} ${o.notes ?? ''}`.toLowerCase().includes(ql)))
  if (f !== 'open') rows.sort((a, b) => (b.deliver_on ?? '').localeCompare(a.deliver_on ?? ''))
  const open = d.orders.filter(c.isOpen)
  return <>
    <div className="row toolbar between">
      <div className="seg">{([['open', `Open (${open.length})`], ['done', 'Delivered / cancelled'], ['all', 'All']] as const).map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
      <button className="primary" onClick={onNew}>+ New order</button>
    </div>
    {f === 'open' && <p className="muted small-note">Production's nursery deliveries for {d.sites.map(s => s.code).join(', ')} show up here by themselves. Add orders for outside farms with New order.</p>}
    {!rows.length ? <p className="muted">No orders here.</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>Deliver</th><th>Strain</th><th>To</th><th className="num">Plants</th><th className="num">Delivered</th><th className="num hide-s">Cut</th><th className="hide-s">SO</th><th>Status</th></tr></thead>
      <tbody>{rows.map(o => (
        <tr key={o.id} className={`tap ${o.status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => onOpen(o)}>
          <td className="nowrap">{fmtD(o.deliver_on, true) || <span className="muted">no date</span>}</td><td>{o.strain}</td><td>{c.to(o)}</td>
          <td className="num">{n0(o.plants)}</td><td className="num">{n0(c.delivered.get(o.id) ?? 0) || ''}</td>
          <td className="num hide-s">{c.cutFor.get(o.id) ? n0(c.cutFor.get(o.id)) : o.cut_on ? <span className="muted">{fmtD(o.cut_on)}</span> : ''}</td>
          <td className="hide-s nowrap">{o.so_number ?? ''}</td><td>{statusPill(o, c)}</td>
        </tr>
      ))}</tbody>
    </table></div>}
  </>
}

/** one order: details, confirm, deliver, documents */
export function OrderSheet({ d, c, o: o0, customers, terms, api, flash, isAdmin, onClose, onSaved, onDoc }: {
  d: NData; c: NCtx; o: Partial<NOrder>; customers: NCustomer[]; terms: PaymentTerm[]; api: NurseryApi; flash: Flash; isAdmin: boolean
  onClose: () => void; onSaved: (m: string) => Promise<void>; onDoc: (kind: 'invoice' | 'nso', id: number) => void
}) {
  const isNew = !o0.id
  const [edit, setEdit] = useState(isNew)
  const [x, setX] = useState<Partial<NOrder>>(o0)
  const [busy, setBusy] = useState(false)
  const [deliver, setDeliver] = useState(false)
  const set = (v: Partial<NOrder>) => setX(s => ({ ...s, ...v }))
  const run = async (f: () => Promise<unknown>, ok: string, close = true) => {
    setBusy(true)
    try { await f(); if (close) onClose(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const outside = customers.filter(k => k.kind !== 'internal')
  const farms = [...new Set(['OHR', 'GVR'])]
  const where = x.site ? `site:${x.site}` : x.customer_id ? `c:${x.customer_id}` : ''
  const dels = d.deliveries.filter(v => v.order_id === o0.id)
  const refs = [...new Set(dels.map(v => v.ref))]
  const price = x.price_each ?? d.settings.price

  if (deliver && o0.id) return <DeliverSheet d={d} c={c} o={o0 as NOrder} api={api} flash={flash} onClose={() => setDeliver(false)}
    onDone={async (m, inv) => { onClose(); await onSaved(m); if (inv) onDoc('invoice', inv) }} />

  return (
    <Sheet title={isNew ? 'New clone order' : `${o0.strain} · ${n0(o0.plants)} plants`} sub={isNew ? 'For an outside farm, or one of ours' : `${c.to(o0 as NOrder)} · ${o0.so_number ?? 'no SO yet'} · ${STATUS_LABEL[o0.status ?? 'planned']}`} onClose={onClose}>
      {!edit && o0.id && <>
        <div className="calcbox">
          <span>To</span><b>{c.to(o0 as NOrder)}</b>
          <span>Deliver</span><b>{fmtD(o0.deliver_on, true) || '—'}</b>
          <span>Cut by</span><b>{fmtD(o0.cut_on, true) || '—'}</b>
          <span>Plants</span><b>{n0(o0.plants)} ({n0(c.delivered.get(o0.id) ?? 0)} delivered)</b>
          <span>Cuttings taken for it</span><b>{n0(c.cutFor.get(o0.id) ?? 0)}</b>
          <span>Price</span><b>{money(price)} each · {money(price * (o0.plants ?? 0))}</b>
          <span>Terms</span><b>{terms.find(t => t.code === (o0.payment_terms ?? d.settings.terms))?.label ?? o0.payment_terms ?? d.settings.terms}</b>
          {o0.po_number && <><span>PO</span><b>{o0.po_number}</b></>}
          {o0.plan_id && <><span>From</span><b>Production plan</b></>}
        </div>
        {o0.notes && <p className="muted">{o0.notes}</p>}
        {o0.status === 'planned' && <p className="muted">Production has this planned but hasn't ordered it yet. Confirm it to give it an SO number and start cutting.</p>}
        <div className="row wrap docact">
          {c.isOpen(o0 as NOrder) && <button className="primary" disabled={busy} onClick={() => setDeliver(true)}>Deliver…</button>}
          {(o0.status === 'planned' || o0.status === 'ordered') && <button className="ghost" disabled={busy} onClick={() => run(() => api.setStatus(o0.id!, 'confirmed'), 'Confirmed', false)}>Confirm</button>}
          {o0.so_number && <button className="ghost" onClick={() => onDoc('nso', o0.id!)}>Sales order</button>}
          <button className="ghost" onClick={() => setEdit(true)}>Edit</button>
          {c.isOpen(o0 as NOrder) && !dels.length && <button className="ghost danger" disabled={busy} onClick={() => { if (confirm('Cancel this order?')) run(() => api.setStatus(o0.id!, 'cancelled'), 'Cancelled') }}>Cancel order</button>}
          {o0.status === 'cancelled' && <button className="ghost" disabled={busy} onClick={() => run(() => api.setStatus(o0.id!, 'confirmed'), 'Back on')}>Put back on</button>}
        </div>
        {refs.length > 0 && <><h3>Deliveries</h3><div className="dlist">{refs.map(r => {
          const vs = dels.filter(v => v.ref === r), v = vs[0]
          return <div key={r} className="drow"><span className="grow"><b>{fmtD(v.delivered_on, true)}</b> <span className="muted">· {n0(sum(vs.map(z => z.plants)))} plants
            {vs.some(z => z.batch_id) ? ` · ${vs.map(z => d.batches.find(b => b.id === z.batch_id)?.name ?? (z.batch_id ? `batch ${z.batch_id}` : 'no batch')).join(', ')}` : ''}
            {v.manifest ? ` · manifest ${v.manifest}` : ' · no manifest'}</span></span>
            {v.invoice_id && <button className="ghost small" onClick={() => onDoc('invoice', v.invoice_id!)}>Invoice</button>}
            {isAdmin && <button className="ghost small" disabled={busy} title="Entered by mistake" onClick={() => { if (confirm('Take back this delivery? Its invoice is voided and the plants come off Production\'s received list.')) run(() => api.undoDelivery(r), 'Delivery taken back', false) }}>Undo</button>}
          </div>
        })}</div></>}
      </>}
      {edit && <>
        <F label="Strain"><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} autoFocus={isNew} /></F>
        <StrainList id="n-strains" names={d.strains} />
        <div className="grid2">
          <F label="To"><select value={where} onChange={e => { const v = e.target.value; set(v.startsWith('site:') ? { site: v.slice(5), customer_id: null } : { site: null, customer_id: v ? Number(v.slice(2)) : null }) }}>
            <option value="">Pick…</option>
            <optgroup label="Our farms">{farms.map(s => <option key={s} value={`site:${s}`}>{s}</option>)}</optgroup>
            <optgroup label="Outside farms and partners">{outside.map(k => <option key={k.id} value={`c:${k.id}`}>{k.name}</option>)}</optgroup>
          </select></F>
          <F label="Plants"><NumIn value={x.plants} onChange={v => set({ plants: v ?? 0 })} /></F>
          <F label="Cut by"><DateIn value={x.cut_on} onChange={v => set({ cut_on: v })} /></F>
          <F label="Deliver on"><DateIn value={x.deliver_on} onChange={v => set({ deliver_on: v })} /></F>
          <F label="Price each" hint={`blank = ${money(d.settings.price)}`}><NumIn value={x.price_each} onChange={v => set({ price_each: v })} /></F>
          <F label="Payment terms"><Pick value={x.payment_terms} blank={`Default (${terms.find(t => t.code === d.settings.terms)?.label ?? d.settings.terms})`}
            options={terms.filter(t => t.active || t.code === x.payment_terms).map(t => ({ v: t.code, l: t.label }))} onChange={v => set({ payment_terms: v })} /></F>
          <F label="Customer PO"><TextIn value={x.po_number} onChange={v => set({ po_number: v })} /></F>
          {d.sites.length > 1 && <F label="Nursery"><Pick value={x.nursery_site} options={d.sites.map(s => ({ v: s.code, l: s.name }))} onChange={v => set({ nursery_site: v ?? undefined })} /></F>}
        </div>
        <F label="Notes"><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
        {!isNew && o0.plan_id && <p className="muted small-note">This came from Production's plan. Changes here show up there too.</p>}
        <SaveBar busy={busy} disabled={!x.strain?.trim() || !(Number(x.plants) > 0) || (!x.site && !x.customer_id)} saveLabel={isNew ? 'Add order' : 'Save'}
          onCancel={() => (isNew ? onClose() : (setX(o0), setEdit(false)))}
          onSave={() => run(() => api.saveOrder({ id: x.id, nursery_site: x.nursery_site ?? d.sites[0]?.code, site: x.site ?? null, customer_id: x.customer_id ?? null, strain: x.strain!.trim(), plants: Number(x.plants),
            cut_on: x.cut_on ?? null, deliver_on: x.deliver_on ?? null, price_each: x.price_each ?? null, po_number: x.po_number ?? null, payment_terms: x.payment_terms ?? null, notes: x.notes ?? null }),
            isNew ? 'Order added (confirmed, SO number given)' : 'Saved')} />
      </>}
    </Sheet>
  )
}

/** deliver plants on an order: from which batches, the manifest; makes the invoice */
function DeliverSheet({ d, c, o, api, flash, onClose, onDone }: { d: NData; c: NCtx; o: NOrder; api: NurseryApi; flash: Flash; onClose: () => void; onDone: (m: string, invoiceId: number | null) => Promise<void> }) {
  const owed = c.owed(o)
  const batches = useMemo(() => d.batches.filter(b => strainKey(b.strain) === strainKey(o.strain) && (b.stage === 'ready' || b.stage === 'rooting') && c.left(b) > 0)
    .sort((a, b) => (a.order_id === o.id ? 0 : 1) - (b.order_id === o.id ? 0 : 1) || (a.stage === 'ready' ? 0 : 1) - (b.stage === 'ready' ? 0 : 1) || a.cut_on.localeCompare(b.cut_on)), [d, c, o])
  const [qty, setQty] = useState<Record<string, number | null>>(() => {
    const q: Record<string, number | null> = {}; let need = owed
    for (const b of batches) { if (b.stage !== 'ready' && b.order_id !== o.id) continue; const n = Math.min(need, c.left(b)); if (n > 0) { q[b.id] = n; need -= n } }
    return q
  })
  const [loose, setLoose] = useState<number | null>(null)
  const [date, setDate] = useState<string | null>(today())
  const [manifest, setManifest] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const total = sum(Object.values(qty)) + (loose ?? 0)
  const over = batches.find(b => (qty[b.id] ?? 0) > c.left(b))
  async function save() {
    setBusy(true)
    try {
      const lines = [...batches.filter(b => (qty[b.id] ?? 0) > 0).map(b => ({ batch: b.id, plants: qty[b.id]! })), ...(loose ? [{ batch: null, plants: loose }] : [])]
      const r = await api.deliver(o.id, lines, date, manifest.trim() || null, notes.trim() || null)
      await onDone(`${n0(r.plants)} plants delivered${r.invoice ? ` · ${r.invoice}` : ''}`, r.invoice_id)
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={`Deliver ${o.strain}`} sub={`${c.to(o)} · ${n0(owed)} plants still owed${o.so_number ? ` · ${o.so_number}` : ''}`} onClose={onClose}>
      <div className="grid2">
        <F label="Delivered on"><DateIn value={date} onChange={setDate} /></F>
        <F label="METRC manifest #"><input value={manifest} onChange={e => setManifest(e.target.value)} placeholder="Transfer manifest" /></F>
      </div>
      <h3>From which batches</h3>
      {!batches.length && <p className="muted">No {o.strain} batches with plants left. Add the batch on the Batches screen, or enter plants not from a batch below.</p>}
      {batches.length > 0 && <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>Batch</th><th>Cut</th><th>Stage</th><th className="num">Left</th><th className="num">Sending</th></tr></thead>
        <tbody>{batches.map(b => <tr key={b.id}><td>{b.name ?? `#${b.id}`}{b.order_id === o.id && <span className="muted"> · for this order</span>}</td><td className="nowrap">{fmtD(b.cut_on)}</td>
          <td>{b.stage === 'ready' ? 'Ready' : 'Rooting'}</td><td className="num">{n0(c.left(b))}</td>
          <td className="num"><NumIn value={qty[b.id] ?? null} onChange={v => setQty(s => ({ ...s, [b.id]: v }))} /></td></tr>)}</tbody>
      </table></div>}
      <F label="Plants not from a batch" hint="(only if they weren't tracked)"><NumIn value={loose} onChange={setLoose} /></F>
      <F label="Notes"><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" /></F>
      <p className="muted small-note">Sending {n0(total)} of {n0(owed)}.{total > owed ? ' That\'s more than the order; the extra still counts as delivered.' : ''}{' '}
        This makes the invoice from {d.licenses.find(l => l.license_no === d.sites.find(s => s.code === o.nursery_site)?.license)?.entity ?? 'the nursery'}
        {o.site ? ` and adds the plants to ${o.site}'s received list in Production.` : '.'}</p>
      {over && <p className="warn-t">{over.name ?? `#${over.id}`} only has {n0(c.left(over))} left.</p>}
      <SaveBar busy={busy} disabled={total <= 0 || !!over} saveLabel={`Deliver ${n0(total)}`} onCancel={onClose} onSave={save} />
    </Sheet>
  )
}
