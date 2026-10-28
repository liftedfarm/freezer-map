import { Select } from './combo'
import { useBack, scrollTop } from './nav'
import { ScanButton } from './scan'
import { sameTag, useScanHandler } from './scanroute'
import { useMemo, useState } from 'react'
import type { Backend } from './api'
import type { Customer, FLine, FOrder, FState, Load, LoadStop, Pallet, Vehicle } from './types'
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
  stops?: LoadStop[]; customers?: Customer[]
  /** which order is open (kept by the app so a load's stop can open an order here) */
  openId?: number | null; setOpenId?: (id: number | null) => void
}

/** Distribution > Fulfillment: confirmed orders get pallets, then go on a load */
export function FulfillView(props: FulfillProps) {
  const { orders } = props
  const [ownId, setOwnId] = useState<number | null>(null)
  const openId = props.setOpenId ? (props.openId ?? null) : ownId
  const setOpenId = props.setOpenId ?? setOwnId
  const [q, setQ] = useState('')
  useBack(openId != null, () => setOpenId(null))
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
                <button key={o.id} className="li setrow forder" onClick={() => { setOpenId(o.id); scrollTop() }}>
                  <div className="grow">
                    <div><b>{o.customer}</b> <span className="muted">{o.so ?? `Order #${o.id}`}{o.source === 'portal' ? ' · portal' : o.source === 'roshi' ? ' · Roshi' : ''}</span></div>
                    <div className="muted">{o.lines.length} strains · {n0(want)} lbs{o.wanted_date ? <> · <span className={late ? 'bad-t' : ''}>wanted {fmt(o.wanted_date)}</span></> : o.order_date ? ` · ordered ${fmt(o.order_date)}` : ''}
                      {o.stop ? ` · ${o.stop.load} ${fmt(o.stop.load_date)}` : ''}</div>
                    {(g === 'open' || g === 'needs_ok') && <Meter value={have} max={want} tone={have > 0 ? 'ok' : undefined} />}
                  </div>
                  <span className={`pill fs-${g === 'loaded' && o.fill && o.fill !== 'ready' ? o.fill : g}`}>{g === 'open' && have > 0 ? `${Math.round(have / want * 100)}%`
                    : g === 'loaded' && o.fill && o.fill !== 'ready' ? `On a load · ${o.fill === 'open' ? 'needs pallets' : 'needs OK'}`
                    : g === 'shipped' && o.stop?.stop_status === 'delivered' ? 'Delivered' : STATE_LABEL[g]}</span>
                </button>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

function OrderPage({ o, back, backend, reload, flash, pallets, heldBy, onLoad, inRun, where, siteOf, rank, canon, loads, vehicles, isSales, openLoad, openPallet, stops, customers }: FulfillProps & { o: FOrder; back: () => void }) {
  const [adding, setAdding] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadPick, setLoadPick] = useState(false)
  const [sendTo, setSendTo] = useState<string | null>(null)
  const [combine, setCombine] = useState<FLine | null>(null)
  const [packSel, setPackSel] = useState<number[]>([])
  const [scanRes, setScanRes] = useState<{ p: Pallet; msg: string; line?: FLine } | null>(null)
  // on a load that hasn't left: still editable (it can only leave once it's complete and OK'd)
  const onOpenLoad = o.state === 'loaded' && !!o.stop && ['planning', 'loading'].includes(o.stop.load_status)
  const fill = o.state === 'loaded' ? (o.fill ?? 'ready') : o.state
  const editable = o.state === 'open' || o.state === 'needs_ok' || o.state === 'ready' || onOpenLoad
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await reload(); flash(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  // Scan on this page: the pallet goes to the line it matches (same strain and product), or says why it can't
  const assign = (l: FLine, p: Pallet) => {
    const over = Number(p.current_weight ?? 0) - Math.max(0, Number(l.lbs) - got(l))
    return run(() => backend.pickPallet(l.id, p.id), `${p.code} assigned to ${l.strain}${over > 0.5 ? ` (${n0(over)} lbs over)` : ''}`)
  }
  useScanHandler(editable ? tag => {
    const p = pallets.find(x => sameTag(x.package_tag, tag))
    if (!p) return false
    if (o.lines.some(l => l.picks.some(pk => pk.pallet_id === p.id))) { flash(`${p.code} is already on this order`); return true }
    const prod = (x: { product?: string | null }) => x.product ?? 'fresh_frozen'
    const fits = o.lines.filter(l => !l.cant_fill && canon(l.strain) === canon(p.strain) && prod(l) === prod(p))
    const line = fits.find(l => got(l) < Number(l.lbs)) ?? fits[0]
    const other = heldBy.get(p.id)
    const why = other ? `Held for ${other.customer} · ${other.so ?? 'another order'}. Unassign it there first.`
      : !line ? (o.lines.some(l => canon(l.strain) === canon(p.strain))
        ? `Wrong product: this is ${PRODUCT_LABEL[prod(p) as keyof typeof PRODUCT_LABEL] ?? prod(p)}, and the ${p.strain} line wants ${o.lines.filter(l => canon(l.strain) === canon(p.strain)).map(l => PRODUCT_LABEL[prod(l) as keyof typeof PRODUCT_LABEL]).join(' or ')}.`
        : `Wrong strain: ${p.strain ?? 'this pallet has no strain'}${p.strain ? " isn't on this order" : ''}. This order is ${[...new Set(o.lines.map(l => l.strain))].join(', ')}.`)
      : p.kind === 'mixed' ? 'This is a mixed pallet. Scan the tag on the package you want instead.'
      : p.container_id && pallets.some(x => x.container_id === p.container_id && x.id !== p.id && heldBy.get(x.id)?.customer_id !== o.customer_id)
        ? `This package is on ${pallets.find(x => x.id === p.container_id)?.code ?? 'a mixed pallet'} with packages that aren't for ${o.customer}. Take it off on the freezer map first.`
      : onLoad(p.id) ? 'Already on a load.'
      : inRun?.(p.id) ? `In a processing run (${inRun(p.id)}).`
      : p.status !== 'in_freezer' ? `Not in a freezer: ${where(p)}.`
      : p.pushed === false ? "Logged at harvest, not a METRC package yet."
      : !(Number(p.current_weight) > 0) ? 'No weight on it. Fix the weight first.'
      : null
    if (why) { setScanRes({ p, msg: why }); return true }
    const need = Math.max(0, Number(line!.lbs) - got(line!)), w = Number(p.current_weight)
    if (need > 0 && w > need + 0.5) { setScanRes({ p, line, msg: `${p.code} has ${n0(w)} lbs and the ${line!.strain} line needs ${n0(need)} more. Assign the whole pallet, or take part of it.` }); return true }
    assign(line!, p)
    return true
  } : null)
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
      {editable && <p className="muted small-note scanhint">Tap Scan and scan a pallet's tag to assign it to the line it matches.</p>}
      {scanRes && (
        <div className="scrim" onClick={() => setScanRes(null)}>
          <div className="sheet scanpick" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><div><h2>{scanRes.p.code}</h2><div className="muted">{scanRes.p.strain ?? 'No strain'} · {n0(Number(scanRes.p.current_weight ?? 0))} lbs · {where(scanRes.p)}</div></div>
              <button className="ghost" onClick={() => setScanRes(null)}>✕</button></div>
            <div className={scanRes.line ? 'okbox' : 'warnbox'}>{scanRes.msg}</div>
            <div className="row end wrap">
              <button className="ghost" onClick={() => { setScanRes(null); openPallet(scanRes.p.id) }}>Open pallet</button>
              {scanRes.line && <button className="ghost" disabled={busy} onClick={() => { setAdding(scanRes.line!.id); setScanRes(null) }}>Take part</button>}
              {scanRes.line && <button className="primary" disabled={busy} onClick={() => { assign(scanRes.line!, scanRes.p); setScanRes(null) }}>Assign whole pallet</button>}
            </div>
          </div>
        </div>
      )}

      {fill === 'needs_ok' && <div className="warnbox">Some lines don't match what was ordered. {isSales ? 'OK the new amounts below, or change the pallets.' : `Sales has to OK the new amounts before this can ${onOpenLoad ? 'leave' : 'go on a load'}.`}
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
                    {editable && !(p?.container_id && pallets.some(x => x.container_id === p.container_id && x.id !== p.id)) && <button className="ghost small" disabled={busy} title="Unassign" onClick={() => run(() => backend.unpick(pk.id), `${pk.code} unassigned`)}>✕</button>}
                  </div>
                )
              })}
              {l.cant_fill && <div className="drow"><span className="grow warn-t"><b>Can't fill.</b> Sales has to OK sending this order without it.</span>
                {editable && <button className="ghost small" disabled={busy} onClick={() => run(() => backend.cantFill(l.id, false), 'Line back on')}>Undo</button>}</div>}
              {editable && !l.cant_fill && adding !== l.id && <div className="row">
                <button className="ghost small grow" disabled={busy} onClick={() => setAdding(l.id)}>+ {g ? 'Add another pallet' : 'Assign pallets'}</button>
                <button className="ghost small" disabled={busy} title="Pull from several pallets of this strain into one new METRC tag" onClick={() => setCombine(l)}>Combine into one tag</button>
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

      {editable && (() => {
        // packing: build mixed pallets from this order's packages (they stay held), or add to one already started for this customer
        const mine = o.lines.flatMap(l => l.picks.map(pk => pal.get(pk.pallet_id))).filter((p): p is Pallet => !!p)
        const loose = mine.filter(p => !p.container_id && p.status === 'in_freezer')
        const mixedIds = [...new Set(pallets.filter(x => x.container_id && heldBy.get(x.id)?.customer_id === o.customer_id).map(x => x.container_id!))]
        const tops = new Set(mine.map(p => p.container_id ?? p.id)).size
        if (!mine.length) return null
        const toggle = (id: number) => setPackSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
        const sel = packSel.filter(id => loose.some(p => p.id === id))
        const selW = sel.reduce((a, id) => a + Number(pal.get(id)?.current_weight ?? 0), 0)
        const mix = (into: number | null) => run(() => backend.orderMixedPallet(o.id, sel, into), into ? `Added to ${pal.get(into)?.code}` : 'Mixed pallet made').then(() => setPackSel([]))
        return <section className="dcard pack">
          <div className="row between wrap"><b>Pack for the truck</b><span className="muted">{tops} truck position{tops === 1 ? '' : 's'}</span></div>
          {mixedIds.map(mid => {
            const m = pal.get(mid), cs = pallets.filter(x => x.container_id === mid)
            const others = [...new Set(cs.map(x => heldBy.get(x.id)).filter(h => h && h.id !== o.id).map(h => h!.so ?? `order #${h!.id}`))]
            return <div key={mid} className="packm">
              <div className="row between"><button className="linkbtn" onClick={() => openPallet(mid)}><b>{m?.code ?? 'Mixed'}</b></button>
                <span className="muted">{cs.length} pkg{cs.length === 1 ? '' : 's'} · {n0(cs.reduce((a, x) => a + Number(x.current_weight ?? 0), 0))} lbs{m ? ` · ${where(m)}` : ''}</span></div>
              <div className="muted small">{cs.map(x => `${x.code} ${x.strain ?? ''}`).join(' · ')}</div>
              {others.length > 0 && <div className="small-note warn-t">Also carries {others.join(', ')}: they go on the truck together.</div>}
            </div>
          })}
          {loose.length > 0 && <>
            <div className="muted small-note">{loose.length > 1 ? 'Tick packages to put on one mixed pallet (each keeps its own tag).' : 'This package can go on a mixed pallet with this customer\'s other packages.'}</div>
            {loose.map(p => <label key={p.id} className={`pick ${sel.includes(p.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={sel.includes(p.id)} onChange={() => toggle(p.id)} />
              <b>{p.code}</b><span>{p.strain} · {n0(Number(p.current_weight ?? 0))} lbs</span><span className="muted">{where(p)}</span></label>)}
            {sel.length > 0 && <div className="row wrap">
              {sel.length > 1 && <button className="primary small" disabled={busy} onClick={() => mix(null)}>Build mixed pallet ({sel.length} · {n0(selW)} lbs)</button>}
              {mixedIds.map(mid => <button key={mid} className="ghost small" disabled={busy} onClick={() => mix(mid)}>Add to {pal.get(mid)?.code}</button>)}
            </div>}
            {sel.length > 1 && <p className="muted small-note">The mixed pallet goes in the slot of the first one ticked (stacked). Move it on the freezer map if you need to.</p>}
          </>}
        </section>
      })()}

      {moving && at.size > 0 && <section className="dcard">
        <div className="row between wrap">
          <span><b>Where it is:</b> <span className="muted">{[...at.entries()].map(([s, n]) => `${n} at ${s === 'truck' ? 'on a truck' : s}`).join(' · ')}</span></span>
          {!sendTo && <div className="row">{['GVR', 'OHR'].filter(s => [...at.keys()].some(k => k !== s && k !== 'truck' && k !== '?')).map(s =>
            <button key={s} className="ghost small" disabled={busy} onClick={() => setSendTo(s)}>Send to {s}</button>)}</div>}
        </div>
        {sites.length > 1 && <p className="warn-t small-note">This order is at OHR and GVR. Send one side over first, or it ships on two METRC manifests (one per license).</p>}
        {sendTo && <LoadChooser o={o} loads={loads} vehicles={vehicles} stops={stops} customers={customers} busy={busy} close={() => setSendTo(null)} title={`Send the pallets that aren't at ${sendTo} to ${sendTo}`}
          onPick={id => run(() => backend.orderTransfer(o.id, id, sendTo), `On the load to ${sendTo}`).then(() => setSendTo(null))}
          onNew={(v, d) => run(() => backend.orderTransferNew(o.id, v, d, sendTo), `New load to ${sendTo} made`).then(() => setSendTo(null))} />}
        {sendTo && <p className="muted small-note">They stay held for {o.customer}. When the load is delivered they're received at {sendTo}, and can go straight onto the customer's load from there.</p>}
      </section>}

      <section className="dcard">
        {o.state === 'ready' && !loadPick && <div className="row between"><span><b>Ready.</b> <span className="muted">Every line has its pallets.</span></span>
          <button className="primary" disabled={busy} onClick={() => setLoadPick(true)}>Put on a load</button></div>}
        {(o.state === 'open' || o.state === 'needs_ok') && orderGot(o) > 0 && !loadPick && <div className="row between wrap"><span className="muted">It can go on a load now and keep filling there. It can't leave until every line is filled and OK'd.</span>
          <button className="ghost" disabled={busy} onClick={() => setLoadPick(true)}>Put on a load</button></div>}
        {['ready', 'open', 'needs_ok'].includes(o.state) && loadPick && <LoadChooser o={o} loads={loads} vehicles={vehicles} stops={stops} customers={customers} busy={busy} close={() => setLoadPick(false)}
          onPick={id => run(() => backend.orderToLoad(o.id, id), 'On the load').then(() => setLoadPick(false))}
          onNew={(v, d) => run(async () => { const l = await backend.createLoad(v, d, [{ customer_id: o.customer_id, manifest: '' }], '', ''); await backend.orderToLoad(o.id, l.id) }, 'New load made with this order').then(() => setLoadPick(false))} />}
        {o.state === 'loaded' && onOpenLoad && fill !== 'ready' && <div className="warnbox">On the load, but it can't leave yet: {fill === 'open' ? 'some lines still need pallets' : 'Sales has to OK the amounts that differ'}.</div>}
        {o.state === 'loaded' && o.stop && <div className="row between wrap"><span>On <b>{o.stop.load}</b> <span className="muted">· {fmt(o.stop.load_date)} · {o.stop.load_status.replace('_', ' ')}</span></span>
          <div className="row"><button className="ghost small" onClick={() => openLoad(o.stop!.load_id)}>Open load</button>
            {(o.stop.load_status === 'planning' || o.stop.load_status === 'loading' || o.stop.load_status === 'cancelled') && <button className="ghost small" disabled={busy} onClick={() => run(() => backend.orderOffLoad(o.id), 'Taken off the load')}>Take off load</button>}</div></div>}
        {o.state === 'shipped' && <span>Shipped {fmt(o.shipped_date)}{o.stop ? ` on ${o.stop.load}` : ''}{o.stop?.stop_status === 'delivered' ? ' · Delivered' : ''}{o.stop?.manifest ? ` · manifest ${o.stop.manifest}` : ''}.</span>}
        {combine && <Combine o={o} line={combine} pallets={pallets} heldBy={heldBy} onLoad={onLoad} inRun={inRun} where={where} rank={rank} canon={canon} busy={busy}
          close={() => setCombine(null)}
          submit={(src, tag) => run(() => backend.combineForLine(combine.id, src, tag), `Combined into one ${combine.strain} package${tag ? '' : ' (tag pending)'}`).then(() => setCombine(null))} />}
        {o.state === 'open' && orderGot(o) === 0 && <span className="muted">Assign pallets to every line. If a line ends up over or short, Sales OKs the amount before it can leave.</span>}
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

function LoadChooser({ o, loads, vehicles, stops = [], customers = [], busy, close, onPick, onNew, title }: {
  o: FOrder; loads: Load[]; vehicles: Vehicle[]; stops?: LoadStop[]; customers?: Customer[]; busy: boolean; close: () => void; onPick: (id: number) => void; onNew: (vehicle: number, date: string) => void; title?: string
}) {
  // loads that already stop at this customer come first (the order joins that stop)
  const stopsAt = (l: Load) => stops.filter(s => s.load_id === l.id).sort((a, b) => a.seq - b.seq)
  const hasMe = (l: Load) => stopsAt(l).some(s => s.customer_id === o.customer_id && s.status === 'pending')
  const open = loads.filter(l => (l.status === 'planning' || l.status === 'loading') && (l.kind !== 'pickup' || stops.some(s => s.load_id === l.id && s.customer_id === o.customer_id)))
    .sort((a, b) => (title ? 0 : Number(hasMe(b)) - Number(hasMe(a))) || a.load_date.localeCompare(b.load_date))
  const names = (l: Load) => stopsAt(l).map(s => customers.find(c => c.id === s.customer_id)?.name ?? '?').join(', ')
  const vs = vehicles.filter(v => v.active && v.kind !== 'Customer pickup')
  const [v, setV] = useState<number | null>(vs[0]?.id ?? null)
  const [d, setD] = useState(o.wanted_date && o.wanted_date >= today() ? o.wanted_date : today())
  return (
    <div className="dlist">
      <div className="row between"><b>{title ?? `Put ${o.customer} on a load`}</b><button className="ghost small" onClick={close}>Cancel</button></div>
      {open.map(l => <button key={l.id} className="drow click" disabled={busy} onClick={() => onPick(l.id)}><span><b>{l.code}</b><span className="muted"> · {fmt(l.load_date)} · {vehicles.find(x => x.id === l.vehicle_id)?.name ?? ''} · {l.status}</span>
        {stopsAt(l).length > 0 && <span className="muted small"><br />Stops: {names(l)}</span>}
        {!title && hasMe(l) && <span className="ok-t small"><br />Already stops at {o.customer}: joins that stop</span>}</span><span>Add ›</span></button>)}
      {!open.length && <p className="muted">No loads being planned. Make a new one:</p>}
      <div className="drow"><span className="grow"><b>New load</b></span>
        <Select value={v ?? ''} onChange={e => setV(Number(e.target.value))}>{vs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <input type="date" value={d} onChange={e => setD(e.target.value)} />
        <button className="primary small" disabled={busy || v == null} onClick={() => onNew(v!, d)}>Make load</button></div>
    </div>
  )
}

/** pull from several pallets of one strain (whole or part of each) into one new METRC package for this line */
function Combine({ o, line, pallets, heldBy, onLoad, inRun, where, rank, canon, busy, close, submit }: {
  o: FOrder; line: FLine; pallets: Pallet[]; heldBy: Map<number, FOrder>; onLoad: (id: number) => boolean; inRun?: (id: number) => string | undefined
  where: (p: Pallet) => string; rank: (p: Pallet) => number; canon: (s: string | null | undefined) => string; busy: boolean
  close: () => void; submit: (src: { pallet_id: number; lbs: number | null }[], tag: string | null) => void
}) {
  const w = (p: Pallet) => Number(p.current_weight ?? 0)
  const prod = (x: { product?: string | null }) => x.product ?? 'fresh_frozen'
  const cands = pallets.filter(p => p.status === 'in_freezer' && p.pushed !== false && !p.container_id && p.kind !== 'mixed' && w(p) > 0
    && canon(p.strain) === canon(line.strain) && prod(p) === prod(line) && (p.crop_year == null || p.crop_year === line.crop_year)
    && (!heldBy.has(p.id) || heldBy.get(p.id)!.id === o.id) && !onLoad(p.id) && !inRun?.(p.id))
  const onLine = new Set(line.picks.map(pk => pk.pallet_id))
  const [sel, setSel] = useState<Map<number, string>>(() => new Map(cands.filter(p => onLine.has(p.id)).map(p => [p.id, String(w(p))])))
  const [tag, setTag] = useState('')
  // what the line still needs from the pallets picked here (other picks on the line stay)
  const kept = line.picks.filter(pk => !sel.has(pk.pallet_id)).reduce((a, pk) => a + Number(pk.lbs), 0)
  const need = Math.max(0, Number(line.lbs) - kept)
  const total = [...sel.values()].reduce((a, v) => a + (Number(v) || 0), 0)
  const toggle = (p: Pallet) => setSel(m => {
    const n = new Map(m)
    if (n.has(p.id)) n.delete(p.id)
    else { const rest = need - [...n.values()].reduce((a, v) => a + (Number(v) || 0), 0); n.set(p.id, String(rest > 0 ? Math.min(w(p), Math.round(rest * 100) / 100) : w(p))) }
    return n
  })
  const sorted = [...cands].sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)) || Number(onLine.has(b.id)) - Number(onLine.has(a.id)) || rank(a) - rank(b) || w(a) - w(b))
  const bad = [...sel.entries()].some(([id, v]) => { const p = cands.find(x => x.id === id); return !p || !(Number(v) > 0) || Number(v) > w(p) + 0.001 })
  return (
    <div className="scrim" onClick={close}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><div><h2>Combine into one tag</h2><div className="muted">{line.strain} · {PRODUCT_LABEL[prod(line) as keyof typeof PRODUCT_LABEL] ?? prod(line)} · {line.crop_year}</div></div><button className="ghost" onClick={close}>✕</button></div>
        <p className="muted small-note">Tick the pallets to pull from and how much from each. They become one new package for {o.so ?? 'this order'}; what's left stays on each pallet.</p>
        <div className={total > 0 && Math.abs(total - need) > 0.5 ? 'warnbox' : 'okbox'}>Line needs <b>{n0(need)}</b> lbs from these · picked <b>{n0(total)}</b> lbs{total > 0 && Math.abs(total - need) > 0.5 ? ` (${total > need ? `${n0(total - need)} over` : `${n0(need - total)} short`})` : ''}</div>
        {!cands.length && <p className="muted">No free {line.strain} pallets for {line.crop_year}.</p>}
        <div className="picklist">
          {sorted.slice(0, 30).map(p => (
            <div key={p.id} className={`pick combine ${sel.has(p.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p)} />
              <span className="grow" onClick={() => toggle(p)}><b>{p.code}</b> <span className="muted">{n0(w(p))} lbs · {where(p)}{onLine.has(p.id) ? ' · on this line' : ''}</span></span>
              {sel.has(p.id) && <span className="row lbsin"><input type="number" inputMode="decimal" value={sel.get(p.id)} onChange={e => setSel(m => new Map(m).set(p.id, e.target.value))} />
                <button className="ghost small" onClick={() => setSel(m => new Map(m).set(p.id, String(w(p))))}>All</button></span>}
            </div>
          ))}
        </div>
        <div className="field"><label>New METRC tag <span className="muted">(blank = tag pending)</span></label><div className="row tagrow"><input className="grow-in" value={tag} onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="Scan or type later" /><ScanButton onScan={setTag} /></div></div>
        <div className="metrcnote"><b>METRC</b> Goes on the METRC to-do as Combine packages: one new package from {sel.size || 'these'} source{sel.size === 1 ? '' : 's'}.</div>
        <div className="row end">
          <button className="ghost" onClick={close}>Cancel</button>
          <button className="primary" disabled={busy || sel.size < 2 || bad} onClick={() => submit([...sel.entries()].map(([id, v]) => { const p = cands.find(x => x.id === id)!; return { pallet_id: id, lbs: Number(v) >= w(p) - 0.001 ? null : Number(v) } }), tag.trim() || null)}>
            Combine {sel.size > 1 ? `${sel.size} pallets` : ''} · {n0(total)} lbs</button>
        </div>
      </div>
    </div>
  )
}
