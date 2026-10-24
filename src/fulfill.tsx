import { ScanButton } from './scan'
import { useMemo, useState } from 'react'
import type { Backend } from './api'
import type { FLine, FOrder, FState, Load, Pallet, Vehicle } from './types'
import { Meter } from './dash'
import { PRODUCT_LABEL } from './types'

const n0 = (x: number) => Math.round(Number(x)).toLocaleString()
const fmt = (s: string | null) => s ? new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export const STATE_LABEL: Record<string, string> = { open: 'Needs pallets', needs_ok: 'Waiting on Sales', ready: 'Ready to load', loaded: 'On a load', shipped: 'Shipped', cancelled: 'Cancelled', submitted: 'Not confirmed', draft: 'Draft' }
const GROUPS: FState[] = ['open', 'needs_ok', 'ready', 'loaded', 'shipped']
const got = (l: FLine) => l.picks.reduce((a, p) => a + Number(p.lbs), 0)
export const orderLbs = (o: FOrder) => o.lines.reduce((a, l) => a + Number(l.lbs), 0)
export const orderGot = (o: FOrder) => o.lines.reduce((a, l) => a + got(l), 0)

export interface FulfillProps {
  err?: string | null; backend: Backend; orders: FOrder[] | null; reload: () => Promise<void>; flash: (t: string, bad?: boolean) => void
  pallets: Pallet[]; heldBy: Map<number, FOrder>; onLoad: (id: number) => boolean; inRun?: (id: number) => string | undefined
  where: (p: Pallet) => string; siteOf: (p: Pallet) => string | null; rank: (p: Pallet) => number; canon: (s: string | null | undefined) => string
  loads: Load[]; vehicles: Vehicle[]; isSales: boolean; openLoad: (id: number) => void; openPallet: (id: number) => void
}

/** Distribution > Fulfillment: confirmed orders get pallets, then go on a load */
export function FulfillView(props: FulfillProps) {
  const { orders } = props
  const [openId, setOpenId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  if (props.err) return <div className="list fulfill"><h2>Fulfillment</h2><div className="warnbox">{props.err}</div></div>
  if (!orders) return <p className="muted">Loading…</p>
  const cur = orders.find(o => o.id === openId)
  if (cur) return <OrderPage {...props} o={cur} back={() => setOpenId(null)} />
  const ql = q.trim().toLowerCase()
  const shown = orders.filter(o => !ql || `${o.customer} ${o.so ?? ''} ${o.po ?? ''} ${o.lines.map(l => l.strain).join(' ')}`.toLowerCase().includes(ql))
  return (
    <div className="list fulfill">
      <h2>Fulfillment</h2>
      <p className="muted">Confirmed orders. Assign pallets to each line, then put the order on a load. Pallets you assign are held for that customer.</p>
      <div className="row toolbar"><input className="search" type="search" placeholder="Customer, SO # or strain" value={q} onChange={e => setQ(e.target.value)} /></div>
      {!shown.length && <p className="muted">No open orders.</p>}
      {GROUPS.map(g => {
        const os = shown.filter(o => o.state === g)
        if (!os.length) return null
        return (
          <section key={g}>
            <h3 className="grouph">{STATE_LABEL[g]} <span className="muted">{os.length}</span></h3>
            {os.map(o => {
              const want = orderLbs(o), have = orderGot(o)
              const late = o.wanted_date && o.wanted_date < today() && (g === 'open' || g === 'needs_ok' || g === 'ready')
              return (
                <button key={o.id} className="li setrow forder" onClick={() => { setOpenId(o.id); window.scrollTo(0, 0) }}>
                  <div className="grow">
                    <div><b>{o.customer}</b> <span className="muted">{o.so ?? `Order #${o.id}`}{o.source === 'portal' ? ' · portal' : o.source === 'roshi' ? ' · Roshi' : ''}</span></div>
                    <div className="muted">{o.lines.length} strains · {n0(want)} lbs{o.wanted_date ? <> · <span className={late ? 'bad-t' : ''}>wanted {fmt(o.wanted_date)}</span></> : o.order_date ? ` · ordered ${fmt(o.order_date)}` : ''}
                      {o.stop ? ` · ${o.stop.load} ${fmt(o.stop.load_date)}` : ''}</div>
                    {(g === 'open' || g === 'needs_ok') && <Meter value={have} max={want} tone={have > 0 ? 'ok' : undefined} />}
                  </div>
                  <span className={`pill fs-${g}`}>{g === 'open' && have > 0 ? `${Math.round(have / want * 100)}%` : STATE_LABEL[g]}</span>
                </button>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

function OrderPage({ o, back, backend, reload, flash, pallets, heldBy, onLoad, inRun, where, siteOf, rank, canon, loads, vehicles, isSales, openLoad, openPallet }: FulfillProps & { o: FOrder; back: () => void }) {
  const [adding, setAdding] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadPick, setLoadPick] = useState(false)
  const [sendTo, setSendTo] = useState<string | null>(null)
  const editable = o.state === 'open' || o.state === 'needs_ok' || o.state === 'ready'
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await reload(); flash(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const pal = useMemo(() => new Map(pallets.map(p => [p.id, p])), [pallets])
  // where this order's pallets are right now (OHR / GVR / on a truck)
  const at = new Map<string, number>()
  for (const l of o.lines) for (const pk of l.picks) { const p = pal.get(pk.pallet_id); const s = p ? (p.status === 'in_transit' ? 'truck' : siteOf(p) ?? '?') : '?'; at.set(s, (at.get(s) ?? 0) + 1) }
  const sites = [...at.keys()].filter(s => s === 'OHR' || s === 'GVR').sort()
  const moving = o.state !== 'shipped' && o.state !== 'loaded'
  return (
    <div className="list fulfill">
      <button className="ghost small" onClick={back}>‹ Fulfillment</button>
      <h2>{o.customer} <span className="muted">{o.so ?? `Order #${o.id}`}</span></h2>
      <div className="row wrap">
        <span className={`pill fs-${o.state}`}>{STATE_LABEL[o.state]}</span>
        <span className="muted">{[o.po && `PO ${o.po}`, o.order_date && `ordered ${fmt(o.order_date)}`, o.wanted_date && `wanted ${fmt(o.wanted_date)}`, o.source === 'roshi' ? 'from Roshi' : o.source === 'portal' ? 'from the portal' : ''].filter(Boolean).join(' · ')}</span>
      </div>
      {o.notes && <p className="muted">"{o.notes}"</p>}

      {o.state === 'needs_ok' && <div className="warnbox">Some lines don't match what was ordered. {isSales ? 'OK the new amounts below, or change the pallets.' : 'Sales has to OK the new amounts before this can go on a load.'}
        {isSales && <div className="row" style={{ marginTop: 8 }}><button className="primary small" disabled={busy} onClick={() => run(() => backend.approveFill(o.id), 'Amounts OK\'d')}>OK these amounts</button></div>}</div>}

      {o.lines.map(l => {
        const g = got(l), diff = g - Number(l.lbs)
        return (
          <section key={l.id} className="dcard fline">
            <div className="dcard-h">
              <h3>{l.strain}{l.product && l.product !== 'fresh_frozen' ? <span className="pill prod">{PRODUCT_LABEL[l.product]}</span> : null}{l.crop_year && l.crop_year !== new Date().getFullYear() ? <span className="pill old">{l.crop_year}</span> : null}</h3>
              <span className={g === 0 ? 'muted' : diff === 0 ? 'ok-t' : 'warn-t'}><b>{n0(g)}</b> of {n0(Number(l.lbs))} lbs{l.ordered_lbs != null ? <span className="muted"> (ordered {n0(Number(l.ordered_lbs))})</span> : null}
                {g > 0 && diff !== 0 ? <span> · {diff > 0 ? `${n0(diff)} over` : `${n0(-diff)} short`}</span> : g > 0 ? ' ✓' : ''}</span>
            </div>
            <div className="dlist">
              {l.picks.map(pk => {
                const p = pal.get(pk.pallet_id)
                return (
                  <div key={pk.id} className="drow">
                    <button className="linkbtn" onClick={() => openPallet(pk.pallet_id)}><b>{pk.code}</b></button>
                    <span className="grow muted">{p ? where(p) : ''}{pk.tag ? ` · ${pk.tag.slice(-6)}` : pk.tag_pending ? ' · tag pending' : ''}{p?.origin_site ? ` · grown at ${p.origin_site}` : ''}</span>
                    <b>{n0(Number(pk.lbs))} lbs</b>
                    {editable && <button className="ghost small" disabled={busy} title="Unassign" onClick={() => run(() => backend.unpick(pk.id), `${pk.code} unassigned`)}>✕</button>}
                  </div>
                )
              })}
              {l.cant_fill && <div className="drow"><span className="grow warn-t"><b>Can't fill.</b> Sales has to OK sending this order without it.</span>
                {editable && <button className="ghost small" disabled={busy} onClick={() => run(() => backend.cantFill(l.id, false), 'Line back on')}>Undo</button>}</div>}
              {editable && !l.cant_fill && adding !== l.id && <div className="row">
                <button className="ghost small grow" disabled={busy} onClick={() => setAdding(l.id)}>+ {g ? 'Add another pallet' : 'Assign pallets'}</button>
                {g === 0 && <button className="ghost small" disabled={busy} onClick={() => run(() => backend.cantFill(l.id, true), `${l.strain} marked can't fill`)}>Can't fill</button>}</div>}
              {editable && adding === l.id && <Pick line={l} need={Math.max(0, Number(l.lbs) - g)} busy={busy} close={() => setAdding(null)}
                cands={pallets.filter(p => p.status === 'in_freezer' && p.pushed !== false && !p.container_id && p.kind !== 'mixed' && (p.current_weight ?? 0) > 0
                  && canon(p.strain) === canon(l.strain) && (p.product ?? 'fresh_frozen') === (l.product ?? 'fresh_frozen') && !heldBy.has(p.id) && !onLoad(p.id) && !inRun?.(p.id))}
                where={where} rank={rank}
                onWhole={p => run(() => backend.pickPallet(l.id, p.id), `${p.code} assigned`).then(() => setAdding(null))}
                onPart={(p, lbs, tag) => run(() => backend.pickPart(l.id, p.id, lbs, tag), `${n0(lbs)} lbs from ${p.code} assigned. Split it when you pull it.`).then(() => setAdding(null))} />}
            </div>
          </section>
        )
      })}

      {moving && at.size > 0 && <section className="dcard">
        <div className="row between wrap">
          <span><b>Where it is:</b> <span className="muted">{[...at.entries()].map(([s, n]) => `${n} at ${s === 'truck' ? 'on a truck' : s}`).join(' · ')}</span></span>
          {!sendTo && <div className="row">{['GVR', 'OHR'].filter(s => [...at.keys()].some(k => k !== s && k !== 'truck' && k !== '?')).map(s =>
            <button key={s} className="ghost small" disabled={busy} onClick={() => setSendTo(s)}>Send to {s}</button>)}</div>}
        </div>
        {sites.length > 1 && <p className="warn-t small-note">This order is at OHR and GVR. Send one side over first, or it ships on two METRC manifests (one per license).</p>}
        {sendTo && <LoadChooser o={o} loads={loads} vehicles={vehicles} busy={busy} close={() => setSendTo(null)} title={`Send the pallets that aren't at ${sendTo} to ${sendTo}`}
          onPick={id => run(() => backend.orderTransfer(o.id, id, sendTo), `On the load to ${sendTo}`).then(() => setSendTo(null))}
          onNew={(v, d) => run(() => backend.orderTransferNew(o.id, v, d, sendTo), `New load to ${sendTo} made`).then(() => setSendTo(null))} />}
        {sendTo && <p className="muted small-note">They stay held for {o.customer}. When the load is delivered they're received at {sendTo}, and can go straight onto the customer's load from there.</p>}
      </section>}

      <section className="dcard">
        {o.state === 'ready' && !loadPick && <div className="row between"><span><b>Ready.</b> <span className="muted">Every line has its pallets.</span></span>
          <button className="primary" disabled={busy} onClick={() => setLoadPick(true)}>Put on a load</button></div>}
        {o.state === 'ready' && loadPick && <LoadChooser o={o} loads={loads} vehicles={vehicles} busy={busy} close={() => setLoadPick(false)}
          onPick={id => run(() => backend.orderToLoad(o.id, id), 'On the load').then(() => setLoadPick(false))}
          onNew={(v, d) => run(async () => { const l = await backend.createLoad(v, d, [{ customer_id: o.customer_id, manifest: '' }], '', ''); await backend.orderToLoad(o.id, l.id) }, 'New load made with this order').then(() => setLoadPick(false))} />}
        {o.state === 'loaded' && o.stop && <div className="row between wrap"><span>On <b>{o.stop.load}</b> <span className="muted">· {fmt(o.stop.load_date)} · {o.stop.load_status.replace('_', ' ')}</span></span>
          <div className="row"><button className="ghost small" onClick={() => openLoad(o.stop!.load_id)}>Open load</button>
            {(o.stop.load_status === 'planning' || o.stop.load_status === 'loading') && <button className="ghost small" disabled={busy} onClick={() => run(() => backend.orderOffLoad(o.id), 'Taken off the load')}>Take off load</button>}</div></div>}
        {o.state === 'shipped' && <span>Shipped {fmt(o.shipped_date)}{o.stop ? ` on ${o.stop.load}` : ''}.</span>}
        {o.state === 'open' && <span className="muted">Assign pallets to every line. If a line ends up over or short, Sales OKs the amount before it can go on a load.</span>}
        {o.state === 'needs_ok' && <span className="muted">Waiting on Sales to OK the amounts that differ.</span>}
      </section>
    </div>
  )
}

/** pallets to choose from: ones that cover what's left first (smallest), then front slots first */
function Pick({ line, need, cands, where, rank, busy, close, onWhole, onPart }: {
  line: FLine; need: number; cands: Pallet[]; where: (p: Pallet) => string; rank: (p: Pallet) => number; busy: boolean; close: () => void
  onWhole: (p: Pallet) => void; onPart: (p: Pallet, lbs: number, tag: string | null) => void
}) {
  const [part, setPart] = useState<{ p: Pallet; lbs: string; tag: string } | null>(null)
  const w = (p: Pallet) => Number(p.current_weight ?? 0)
  const sorted = [...cands].sort((a, b) => {
    const ca = w(a) >= need ? 0 : 1, cb = w(b) >= need ? 0 : 1
    return ca - cb || (ca === 0 ? w(a) - w(b) : w(b) - w(a)) || rank(a) - rank(b)
  })
  const total = cands.reduce((a, p) => a + w(p), 0)
  return (
    <div className="fpick">
      <div className="row between"><b>Pick from {cands.length} {line.strain} pallet{cands.length === 1 ? '' : 's'} <span className="muted">({n0(total)} lbs free)</span></b><button className="ghost small" onClick={close}>Close</button></div>
      {!cands.length && <p className="muted">Nothing free for this strain. Pallets already held for an order, on a load or in a processing run don't show.</p>}
      {sorted.slice(0, 12).map(p => (
        <div key={p.id} className="drow">
          <span className="grow"><b>{p.code}</b> <span className="muted">{where(p)}{p.package_tag ? ` · ${p.package_tag.slice(-6)}` : ''}</span></span>
          <b>{n0(w(p))} lbs</b>
          {need > 0 && w(p) > need && <button className="primary small" disabled={busy} onClick={() => setPart({ p, lbs: String(Math.round(need * 100) / 100), tag: '' })}>Take {n0(need)}</button>}
          <button className={`${need > 0 && w(p) > need ? 'ghost' : 'primary'} small`} disabled={busy} onClick={() => onWhole(p)}>{need > 0 && w(p) > need ? 'Whole' : 'Assign'}</button>
        </div>
      ))}
      {sorted.length > 12 && <p className="muted">+{sorted.length - 12} more</p>}
      {part && (
        <div className="scrim" onClick={() => setPart(null)}>
          <div className="sheet form" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><h2>Take part of {part.p.code}</h2><button className="ghost" onClick={() => setPart(null)}>✕</button></div>
            <p className="muted">{part.p.code} has {n0(w(part.p))} lbs. The part you take becomes its own package for this order (the rest stays as {part.p.code}). Split it for real when you pull it.</p>
            <div className="field"><label>Lbs for this order</label><input type="number" inputMode="decimal" value={part.lbs} onChange={e => setPart({ ...part, lbs: e.target.value })} /></div>
            <div className="field"><label>New METRC tag <span className="muted">(blank = tag pending)</span></label><div className="row tagrow"><input className="grow-in" value={part.tag} onChange={e => setPart({ ...part, tag: e.target.value.toUpperCase().replace(/\s/g, '') })} placeholder="Scan or type later" /><ScanButton onScan={tag => setPart({ ...part, tag })} /></div></div>
            <div className="row between"><span /><div className="row">
              <button className="ghost" onClick={() => setPart(null)}>Cancel</button>
              <button className="primary" disabled={busy || !(Number(part.lbs) > 0 && Number(part.lbs) < w(part.p))} onClick={() => { onPart(part.p, Number(part.lbs), part.tag.trim() || null); setPart(null) }}>Assign {n0(Number(part.lbs) || 0)} lbs</button>
            </div></div>
          </div>
        </div>
      )}
    </div>
  )
}

function LoadChooser({ o, loads, vehicles, busy, close, onPick, onNew, title }: {
  o: FOrder; loads: Load[]; vehicles: Vehicle[]; busy: boolean; close: () => void; onPick: (id: number) => void; onNew: (vehicle: number, date: string) => void; title?: string
}) {
  const open = loads.filter(l => l.status === 'planning' || l.status === 'loading').sort((a, b) => a.load_date.localeCompare(b.load_date))
  const vs = vehicles.filter(v => v.active)
  const [v, setV] = useState<number | null>(vs[0]?.id ?? null)
  const [d, setD] = useState(o.wanted_date && o.wanted_date >= today() ? o.wanted_date : today())
  return (
    <div className="dlist">
      <div className="row between"><b>{title ?? `Put ${o.customer} on a load`}</b><button className="ghost small" onClick={close}>Cancel</button></div>
      {open.map(l => <button key={l.id} className="drow click" disabled={busy} onClick={() => onPick(l.id)}><span><b>{l.code}</b><span className="muted"> · {fmt(l.load_date)} · {vehicles.find(x => x.id === l.vehicle_id)?.name ?? ''} · {l.status}</span></span><span>Add ›</span></button>)}
      {!open.length && <p className="muted">No loads being planned. Make a new one:</p>}
      <div className="drow"><span className="grow"><b>New load</b></span>
        <select value={v ?? ''} onChange={e => setV(Number(e.target.value))}>{vs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <input type="date" value={d} onChange={e => setD(e.target.value)} />
        <button className="primary small" disabled={busy || v == null} onClick={() => onNew(v!, d)}>Make load</button></div>
    </div>
  )
}
