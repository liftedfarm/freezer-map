import { Select } from '../combo'
import { useMemo, useState } from 'react'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { STATUS_LABEL, fmtD, n0, strainKey, sum, today } from './calc'
import type { NCustomer, NData, NOrder } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { t } from '../i18n'
import type { PaymentTerm } from '../types'

const money = (x: number) => x.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
export const statusPill = (o: NOrder, c: NCtx) => {
  const late = c.isOpen(o) && o.deliver_on && o.deliver_on < today()
  return <span className={`pill ${late ? 'badp' : o.status === 'received' ? 'okp' : o.status === 'planned' ? '' : o.status === 'cancelled' ? '' : 'warnp'}`}>{late ? t('Late') : t(STATUS_LABEL[o.status])}</span>
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
      <div className="seg">{([['open', `${t('Open')} (${open.length})`], ['done', t('Delivered / cancelled')], ['all', t('All')]] as const).map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
      <button className="primary" onClick={onNew}>{t('+ New order')}</button>
    </div>
    {f === 'open' && <p className="muted small-note">{t('Production\'s nursery deliveries for {sites} show up here by themselves. Add orders for outside farms with New order.', { sites: d.sites.map(s => s.code).join(', ') })}</p>}
    {!rows.length ? <p className="muted">{t('No orders here.')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>{t('Deliver')}</th><th>{t('Strain')}</th><th>{t('To')}</th><th className="num">{t('Plants')}</th><th className="num">{t('Delivered')}</th><th className="num hide-s">{t('Cut')}</th><th className="hide-s">{t('SO')}</th><th>{t('Status')}</th></tr></thead>
      <tbody>{rows.map(o => (
        <tr key={o.id} className={`tap ${o.status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => onOpen(o)}>
          <td className="nowrap">{fmtD(o.deliver_on, true) || <span className="muted">{t('no date')}</span>}</td><td>{o.strain}</td><td>{c.to(o)}</td>
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
    <Sheet title={isNew ? t('New clone order') : `${o0.strain} · ${t('{n} plants', { n: n0(o0.plants) })}`} sub={isNew ? t('For an outside farm, or one of ours') : `${c.to(o0 as NOrder)} · ${o0.so_number ?? t('no SO yet')} · ${t(STATUS_LABEL[o0.status ?? 'planned'])}`} onClose={onClose}>
      {!edit && o0.id && <>
        <div className="calcbox">
          <span>{t('To')}</span><b>{c.to(o0 as NOrder)}</b>
          <span>{t('Deliver')}</span><b>{fmtD(o0.deliver_on, true) || '—'}</b>
          <span>{t('Cut by')}</span><b>{fmtD(o0.cut_on, true) || '—'}</b>
          <span>{t('Plants')}</span><b>{n0(o0.plants)} ({t('{n} delivered', { n: n0(c.delivered.get(o0.id) ?? 0) })})</b>
          <span>{t('Cuttings taken for it')}</span><b>{n0(c.cutFor.get(o0.id) ?? 0)}</b>
          <span>{t('Price')}</span><b>{money(price)} {t('each')} · {money(price * (o0.plants ?? 0))}</b>
          <span>{t('Terms')}</span><b>{terms.find(t => t.code === (o0.payment_terms ?? d.settings.terms))?.label ?? o0.payment_terms ?? d.settings.terms}</b>
          {o0.po_number && <><span>{t('PO')}</span><b>{o0.po_number}</b></>}
          {o0.plan_id && <><span>{t('From')}</span><b>{t('Production plan')}</b></>}
        </div>
        {o0.notes && <p className="muted">{o0.notes}</p>}
        {o0.status === 'planned' && <p className="muted">{t('Production has this planned but hasn\'t ordered it yet. Confirm it to give it an SO number and start cutting.')}</p>}
        <div className="row wrap docact">
          {c.isOpen(o0 as NOrder) && <button className="primary" disabled={busy} onClick={() => setDeliver(true)}>{t('Deliver…')}</button>}
          {(o0.status === 'planned' || o0.status === 'ordered') && <button className="ghost" disabled={busy} onClick={() => run(() => api.setStatus(o0.id!, 'confirmed'), t('Confirmed'), false)}>{t('Confirm')}</button>}
          {o0.so_number && <button className="ghost" onClick={() => onDoc('nso', o0.id!)}>{t('Sales order')}</button>}
          <button className="ghost" onClick={() => setEdit(true)}>{t('Edit')}</button>
          {c.isOpen(o0 as NOrder) && !dels.length && <button className="ghost danger" disabled={busy} onClick={() => { if (confirm(t('Cancel this order?'))) run(() => api.setStatus(o0.id!, 'cancelled'), t('Cancelled')) }}>{t('Cancel order')}</button>}
          {o0.status === 'cancelled' && <button className="ghost" disabled={busy} onClick={() => run(() => api.setStatus(o0.id!, 'confirmed'), t('Back on'))}>{t('Put back on')}</button>}
        </div>
        {refs.length > 0 && <><h3>{t('Deliveries')}</h3><div className="dlist">{refs.map(r => {
          const vs = dels.filter(v => v.ref === r), v = vs[0]
          return <div key={r} className="drow"><span className="grow"><b>{fmtD(v.delivered_on, true)}</b> <span className="muted">· {t('{n} plants', { n: n0(sum(vs.map(z => z.plants))) })}
            {vs.some(z => z.batch_id) ? ` · ${vs.map(z => d.batches.find(b => b.id === z.batch_id)?.name ?? (z.batch_id ? `${t('batch')} ${z.batch_id}` : t('no batch'))).join(', ')}` : ''}
            {v.manifest ? ` · ${t('manifest')} ${v.manifest}` : ` · ${t('no manifest')}`}</span></span>
            {v.invoice_id && <button className="ghost small" onClick={() => onDoc('invoice', v.invoice_id!)}>{t('Invoice')}</button>}
            {isAdmin && <button className="ghost small" disabled={busy} title={t('Entered by mistake')} onClick={() => { if (confirm(t('Take back this delivery? Its invoice is voided and the plants come off Production\'s received list.'))) run(() => api.undoDelivery(r), t('Delivery taken back'), false) }}>{t('Undo')}</button>}
          </div>
        })}</div></>}
      </>}
      {edit && <>
        <F label={t('Strain')}><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} autoFocus={isNew} /></F>
        <StrainList id="n-strains" names={d.strains} />
        <div className="grid2">
          <F label={t('To')}><Select value={where} onChange={e => { const v = e.target.value; set(v.startsWith('site:') ? { site: v.slice(5), customer_id: null } : { site: null, customer_id: v ? Number(v.slice(2)) : null }) }}>
            <option value="">{t('Pick…')}</option>
            <optgroup label={t('Our farms')}>{farms.map(s => <option key={s} value={`site:${s}`}>{s}</option>)}</optgroup>
            <optgroup label={t('Outside farms and partners')}>{outside.map(k => <option key={k.id} value={`c:${k.id}`}>{k.name}</option>)}</optgroup>
          </Select></F>
          <F label={t('Plants')}><NumIn value={x.plants} onChange={v => set({ plants: v ?? 0 })} /></F>
          <F label={t('Cut by')}><DateIn value={x.cut_on} onChange={v => set({ cut_on: v })} /></F>
          <F label={t('Deliver on')}><DateIn value={x.deliver_on} onChange={v => set({ deliver_on: v })} /></F>
          <F label={t('Price each')} hint={`${t('blank')} = ${money(d.settings.price)}`}><NumIn value={x.price_each} onChange={v => set({ price_each: v })} /></F>
          <F label={t('Payment terms')}><Pick value={x.payment_terms} blank={`${t('Default')} (${terms.find(x => x.code === d.settings.terms)?.label ?? d.settings.terms})`}
            options={terms.filter(t => t.active || t.code === x.payment_terms).map(t => ({ v: t.code, l: t.label }))} onChange={v => set({ payment_terms: v })} /></F>
          <F label={t('Customer PO')}><TextIn value={x.po_number} onChange={v => set({ po_number: v })} /></F>
          {d.sites.length > 1 && <F label={t('Nursery')}><Pick value={x.nursery_site} options={d.sites.map(s => ({ v: s.code, l: s.name }))} onChange={v => set({ nursery_site: v ?? undefined })} /></F>}
        </div>
        <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
        {!isNew && o0.plan_id && <p className="muted small-note">{t('This came from Production\'s plan. Changes here show up there too.')}</p>}
        <SaveBar busy={busy} disabled={!x.strain?.trim() || !(Number(x.plants) > 0) || (!x.site && !x.customer_id)} saveLabel={isNew ? t('Add order') : t('Save')}
          onCancel={() => (isNew ? onClose() : (setX(o0), setEdit(false)))}
          onSave={() => run(() => api.saveOrder({ id: x.id, nursery_site: x.nursery_site ?? d.sites[0]?.code, site: x.site ?? null, customer_id: x.customer_id ?? null, strain: x.strain!.trim(), plants: Number(x.plants),
            cut_on: x.cut_on ?? null, deliver_on: x.deliver_on ?? null, price_each: x.price_each ?? null, po_number: x.po_number ?? null, payment_terms: x.payment_terms ?? null, notes: x.notes ?? null }),
            isNew ? t('Order added (confirmed, SO number given)') : t('Saved'))} />
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
    const q: Record<string, number | null> = {}; let need = Math.max(owed, Math.ceil(o.plants * (1 + d.settings.deliverPct / 100)) - (c.delivered.get(o.id) ?? 0))
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
      await onDone(`${t('{n} plants delivered', { n: n0(r.plants) })}${r.invoice ? ` · ${r.invoice}` : ''}`, r.invoice_id)
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={t('Deliver {strain}', { strain: o.strain })} sub={`${c.to(o)} · ${t('{n} plants still owed', { n: n0(owed) })}${o.so_number ? ` · ${o.so_number}` : ''}`} onClose={onClose}>
      <div className="grid2">
        <F label={t('Delivered on')}><DateIn value={date} onChange={setDate} /></F>
        <F label={t('METRC manifest #')}><input value={manifest} onChange={e => setManifest(e.target.value)} placeholder={t('Transfer manifest')} /></F>
      </div>
      <h3>{t('From which batches')}</h3>
      {!batches.length && <p className="muted">No {o.strain} batches with plants left. Add the batch on the Batches screen, or enter plants not from a batch below.</p>}
      {batches.length > 0 && <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>{t('Batch')}</th><th>{t('Cut')}</th><th>{t('Stage')}</th><th className="num">{t('Left')}</th><th className="num">{t('Sending')}</th></tr></thead>
        <tbody>{batches.map(b => <tr key={b.id}><td>{b.name ?? `#${b.id}`}{b.order_id === o.id && <span className="muted"> {t('· for this order')}</span>}</td><td className="nowrap">{fmtD(b.cut_on)}</td>
          <td>{t(b.stage === 'ready' ? 'Ready' : 'Rooting')}</td><td className="num">{n0(c.left(b))}</td>
          <td className="num"><NumIn value={qty[b.id] ?? null} onChange={v => setQty(s => ({ ...s, [b.id]: v }))} /></td></tr>)}</tbody>
      </table></div>}
      <F label={t('Plants not from a batch')} hint={t('(only if they weren\'t tracked)')}><NumIn value={loose} onChange={setLoose} /></F>
      <F label={t('Notes')}><input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('Optional')} /></F>
      <p className="muted small-note">{t('Sending {n} of {owed} owed', { n: n0(total), owed: n0(owed) })}{d.settings.deliverPct ? ` (${t('aim: order + {p}%', { p: d.settings.deliverPct })})` : ''}.{' '}
        {t('This makes the invoice from {who}', { who: d.licenses.find(l => l.license_no === d.sites.find(s => s.code === o.nursery_site)?.license)?.entity ?? t('the nursery') })}
        {o.site ? t(' and adds the plants to {site}\'s received list in Production.', { site: o.site }) : '.'}</p>
      {over && <p className="warn-t">{over.name ?? `#${over.id}`} {t('only has {n} left.', { n: n0(c.left(over)) })}</p>}
      <SaveBar busy={busy} disabled={total <= 0 || !!over} saveLabel={t('Deliver {n}', { n: n0(total) })} onCancel={onClose} onSave={save} />
    </Sheet>
  )
}
