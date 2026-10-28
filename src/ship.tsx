import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer, Load, ShipQuoteRow, ShipSettings, ShipZone, StopShipping } from './types'
import { Select } from './combo'

// 089: shipping (zones, rules, quotes), customer pickups, and the app's own RPC helper for these screens.

type Flash = (t: string, bad?: boolean) => void

/** call a database function; a missing function means the SQL file hasn't been run yet */
export async function rpc<T>(sb: SupabaseClient | null, fn: string, args: Record<string, unknown> = {}, sql = '089_depart_invoice'): Promise<T> {
  if (!sb) throw new Error('Not in the demo')
  const { data, error } = await sb.rpc(fn, args)
  if (error) {
    if (/Could not find the function|does not exist|schema cache/i.test(error.message)) throw new Error(`Run ${sql}.sql in Supabase first`)
    throw new Error(error.message)
  }
  return data as T
}

export const money = (n: number | null | undefined) => n == null ? '' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const RULE_LABEL: Record<string, string> = { calc: 'Calculated', free: 'Free (contract)', split: 'Split', pickup: 'They pick up' }
export const CLASS_LABEL: Record<string, string> = { van: 'Reefer van', box: 'Reefer box truck', carrier: 'Outside carrier', pickup: 'Customer pickup' }
const FACILITY = '1363 Green Valley Rd, Watsonville, CA 95076'
const mapUrl = (a: string) => `https://maps.google.com/maps?q=${encodeURIComponent(a)}`
const dirUrl = (a: string) => `https://maps.google.com/maps/dir/${encodeURIComponent(FACILITY)}/${encodeURIComponent(a)}`

// ---------- a stop's shipping line (load screen) ----------
export function ShipLine({ sh, canEdit, onSet }: { sh: StopShipping | undefined; canEdit: boolean; onSet: (amount: number | null, reason: string) => Promise<unknown> }) {
  const [edit, setEdit] = useState(false)
  const [amt, setAmt] = useState('')
  const [why, setWhy] = useState('')
  if (!sh || !sh.billed) return null
  const charge = sh.charge
  return <div className="small-note shipline">
    <div className="row between wrap">
      <span>{sh.rule === 'pickup' ? <b>Customer pickup: no shipping</b>
        : sh.problem ? <span className="warn-t">{sh.problem}</span>
        : <><b>Shipping {sh.rule === 'free' ? 'FREE (contract)' : money(charge)}</b> <span className="muted">· {sh.descr}</span></>}
        {sh.override != null && <span className="muted"> · typed by Sales{sh.reason ? ` (${sh.reason})` : ''}</span>}
        {sh.override == null && sh.quoted != null && <span className="muted"> · as quoted on the order</span>}</span>
      {canEdit && !edit && sh.rule !== 'pickup' && <button className="linkbtn" onClick={() => { setAmt(sh.override != null ? String(sh.override) : ''); setWhy(sh.reason ?? ''); setEdit(true) }}>Change</button>}
    </div>
    {edit && <div className="row wrap" style={{ marginTop: 6 }}>
      <input type="number" step="0.01" min="0" placeholder={charge != null ? String(charge) : 'Amount'} value={amt} onChange={e => setAmt(e.target.value)} style={{ width: 110 }} />
      <input placeholder="Why (shows on the invoice)" value={why} onChange={e => setWhy(e.target.value)} className="grow" />
      <button className="primary small" disabled={amt === '' || !why.trim()} onClick={async () => { await onSet(Number(amt), why); setEdit(false) }}>Save</button>
      {sh.override != null && <button className="ghost small" onClick={async () => { await onSet(null, ''); setEdit(false) }}>Use calculated</button>}
      <button className="ghost small" onClick={() => setEdit(false)}>Cancel</button>
    </div>}
  </div>
}

// ---------- pickup: the customer's driver and truck ----------
export function PickupPanel({ load, canEdit, onSave }: { load: Load; canEdit: boolean
  onSave: (v: { driver: string; dl: string; make: string; model: string; plate: string; license: string }) => Promise<unknown> }) {
  const [v, setV] = useState({ driver: load.pickup_driver ?? '', dl: load.pickup_dl ?? '', make: load.pickup_make ?? '', model: load.pickup_model ?? '', plate: load.pickup_plate ?? '', license: load.pickup_license ?? '' })
  useEffect(() => { setV({ driver: load.pickup_driver ?? '', dl: load.pickup_dl ?? '', make: load.pickup_make ?? '', model: load.pickup_model ?? '', plate: load.pickup_plate ?? '', license: load.pickup_license ?? '' }) },
    [load.id, load.pickup_driver, load.pickup_dl, load.pickup_make, load.pickup_model, load.pickup_plate, load.pickup_license])
  const dirty = v.driver !== (load.pickup_driver ?? '') || v.dl !== (load.pickup_dl ?? '') || v.make !== (load.pickup_make ?? '') || v.model !== (load.pickup_model ?? '')
    || v.plate !== (load.pickup_plate ?? '') || v.license !== (load.pickup_license ?? '')
  const f = (k: keyof typeof v, l: string, ph = '') => <div className="field"><label>{l}</label>
    <input value={v[k]} disabled={!canEdit} placeholder={ph} onChange={e => setV(x => ({ ...x, [k]: e.target.value }))} /></div>
  return <section className="dcard pickup">
    <b>Their driver and truck</b> <span className="muted">(goes on the METRC manifest; they're the transporter)</span>
    <div className="grid2">{f('driver', 'Driver name')}{f('dl', "Driver's license #")}</div>
    <div className="grid3">{f('make', 'Make', 'Ford')}{f('model', 'Model', 'Transit')}{f('plate', 'Plate')}</div>
    {f('license', 'Their transport license #', 'Distributor or Type 13')}
    {canEdit && dirty && <div className="row end"><button className="primary small" onClick={() => onSave(v)}>Save driver</button></div>}
  </section>
}

export function PickupForm({ customers, onClose, onCreate }: { customers: Customer[]; onClose: () => void; onCreate: (customer: number, date: string, notes: string) => Promise<unknown> }) {
  const [cust, setCust] = useState<number | null>(null)
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }))
  const [notes, setNotes] = useState('')
  return <div className="scrim" onClick={onClose}>
    <div className="sheet form" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2>New customer pickup</h2><button className="ghost" onClick={onClose}>✕</button></div>
      <p className="muted">The customer comes with their own driver and truck. Put their orders on it like a load; "Picked up" makes the METRC manifest (they're the transporter) and the invoice, with no shipping.</p>
      <div className="field"><label>Customer</label>
        <Select value={cust ?? ''} onChange={e => setCust(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Pick a customer…</option>
          {customers.filter(c => c.active && c.kind === 'external').sort((a, b) => a.name.localeCompare(b.name)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select></div>
      <div className="field"><label>Pickup date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
      <div className="field"><label>Notes (optional)</label><input value={notes} onChange={e => setNotes(e.target.value)} /></div>
      <div className="row end"><button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={cust == null} onClick={() => onCreate(cust!, date, notes)}>Create pickup</button></div>
    </div>
  </div>
}

// ---------- Sales > Shipping: quick quote ----------
export function ShippingQuote({ sb, customers, flash }: { sb: SupabaseClient | null; customers: Customer[]; flash: Flash }) {
  const [picked, setPicked] = useState<number[]>([])
  const [cls, setCls] = useState('box')
  const [cost, setCost] = useState('')
  const [rows, setRows] = useState<ShipQuoteRow[] | null>(null)
  const ext = useMemo(() => customers.filter(c => c.active && c.kind === 'external').sort((a, b) => a.name.localeCompare(b.name)), [customers])
  useEffect(() => {
    if (!picked.length) { setRows(null); return }
    rpc<ShipQuoteRow[]>(sb, 'ship_quote', { p_customers: picked, p_class: cls, p_carrier_cost: cls === 'carrier' && cost !== '' ? Number(cost) : null })
      .then(setRows).catch(e => flash((e as Error).message, true))
  }, [picked.join(','), cls, cost])
  const move = (i: number, d: number) => setPicked(p => { const n = [...p]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n })
  const total = (rows ?? []).reduce((a, r) => a + Number(r.charge ?? 0), 0)
  return <div className="list ship">
    <h2>Shipping quote</h2>
    <p className="muted">Pick the customers on the run in delivery order. Same math as the load screen: the zones' round-trip prices split across the stops, plus the multi-stop fee; contract customers ride free, split customers pay their share.</p>
    <div className="field"><label>Vehicle</label>
      <div className="choices">{['box', 'van', 'carrier'].map(k => <button key={k} className={cls === k ? 'on' : ''} onClick={() => setCls(k)}>{CLASS_LABEL[k]}</button>)}</div></div>
    {cls === 'carrier' && <div className="field"><label>Carrier's cost for the run ($)</label><input type="number" step="0.01" min="0" value={cost} onChange={e => setCost(e.target.value)} /></div>}
    <div className="field"><label>Stops</label>
      {picked.map((id, i) => {
        const r = rows?.find(x => x.customer_id === id), c = ext.find(x => x.id === id)
        return <div key={id} className="stoprow">
          <span className="stopnum">{i + 1}</span>
          <div className="grow"><b>{c?.name}</b> <span className="muted">· {r?.zone ?? 'no zone'} · {RULE_LABEL[r?.rule ?? 'calc']}</span>
            <div>{r?.problem ? <span className="warn-t">{r.problem}</span> : r ? <><b>{r.rule === 'free' ? 'FREE' : money(r.charge)}</b> <span className="muted">{r.descr}</span></> : null}</div>
            {r?.address && <div className="small"><a href={mapUrl(r.address)} target="_blank" rel="noreferrer">Map</a> · <a href={dirUrl(r.address)} target="_blank" rel="noreferrer">Directions</a></div>}</div>
          <div className="stopbtns">
            <button className="ghost small" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="ghost small" disabled={i === picked.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="ghost small" onClick={() => setPicked(p => p.filter(x => x !== id))}>✕</button></div>
        </div>
      })}
      <Select value="" onChange={e => e.target.value && setPicked(p => [...p, Number(e.target.value)])}>
        <option value="">+ Add a customer…</option>
        {ext.filter(c => !picked.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select></div>
    {rows && rows.length > 0 && <p><b>Charged to customers: {money(total)}</b></p>}
  </div>
}

// ---------- Sales > Settings > Shipping ----------
export function ShippingSettings({ sb, flash, canEdit }: { sb: SupabaseClient | null; flash: Flash; canEdit: boolean }) {
  const [s, setS] = useState<ShipSettings | null>(null)
  const [zone, setZone] = useState<Partial<ShipZone> | null>(null)
  const [q, setQ] = useState('')
  const load = () => rpc<ShipSettings>(sb, 'ship_settings').then(setS).catch(e => flash((e as Error).message, true))
  useEffect(() => { load() }, [])
  if (!s) return <p className="muted">Loading…</p>
  const run = async (f: () => Promise<unknown>, ok: string) => { try { await f(); flash(ok); await load() } catch (e) { flash((e as Error).message, true) } }
  const num = (v: unknown) => v === '' || v == null ? null : Number(v)
  const cs = s.customers.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()))
  return <div className="shipset">
    <h3>Zones</h3>
    <p className="muted small">Round-trip price from 1363 Green Valley Rd (same from OHR). Miles x $/mi is for reference. Multi-stop fee: {money(s.fee)} a stop when a run has more than one billed stop.</p>
    <table className="tbl"><thead><tr><th>Zone</th><th>Miles (RT)</th><th>Van</th><th>Box truck</th><th /></tr></thead><tbody>
      {s.zones.map(z => <tr key={z.id} className={z.active ? '' : 'muted'}>
        <td>{z.name}</td><td>{z.miles_rt ?? ''}</td>
        <td>{money(z.price_van)} <span className="muted small">({money((z.miles_rt ?? 0) * (z.rate_van ?? 0))})</span></td>
        <td>{money(z.price_box)} <span className="muted small">({money((z.miles_rt ?? 0) * (z.rate_box ?? 0))})</span></td>
        <td>{canEdit && <button className="linkbtn" onClick={() => setZone(z)}>Edit</button>}</td></tr>)}
    </tbody></table>
    {canEdit && <button className="ghost small" onClick={() => setZone({ name: '', active: true })}>+ Zone</button>}
    {zone && <div className="dcard">
      <div className="grid3">
        {(['name', 'miles_rt', 'rate_van', 'rate_box', 'price_van', 'price_box'] as const).map(k => <div key={k} className="field"><label>{{ name: 'Name', miles_rt: 'Miles round trip', rate_van: '$/mi van', rate_box: '$/mi box truck', price_van: 'Price van', price_box: 'Price box truck' }[k]}</label>
          <input type={k === 'name' ? 'text' : 'number'} value={String(zone[k] ?? '')} onChange={e => setZone(z => ({ ...z, [k]: e.target.value }))} /></div>)}
      </div>
      <label className="check"><input type="checkbox" checked={zone.active !== false} onChange={e => setZone(z => ({ ...z, active: e.target.checked }))} /> Active</label>
      <div className="row end"><button className="ghost" onClick={() => setZone(null)}>Cancel</button>
        <button className="primary" onClick={() => run(() => rpc(sb, 'save_ship_zone', { p_id: zone.id ?? null, p_name: zone.name, p_miles: num(zone.miles_rt), p_rate_van: num(zone.rate_van),
          p_rate_box: num(zone.rate_box), p_price_van: num(zone.price_van), p_price_box: num(zone.price_box), p_active: zone.active !== false }), 'Zone saved').then(() => setZone(null))}>Save zone</button></div>
    </div>}

    <h3>Vehicles</h3>
    <p className="muted small">Which price column each truck uses. Outside carriers: their actual cost is typed on the load and split the same way.</p>
    {s.vehicles.map(v => <div key={v.id} className="row between setrow"><span>{v.name}</span>
      <Select value={v.class ?? ''} disabled={!canEdit} onChange={e => run(() => rpc(sb, 'set_vehicle_ship_class', { p_vehicle: v.id, p_class: e.target.value || null }), `${v.name} updated`)}>
        <option value="">{`Default (${CLASS_LABEL[v.auto_class]})`}</option>
        {['van', 'box', 'carrier'].map(k => <option key={k} value={k}>{CLASS_LABEL[k]}</option>)}
      </Select></div>)}

    <h3>Customers</h3>
    <p className="muted small">Blank rule: contract customers ride free, everyone else is calculated. Split: Lifted pays that % of their share of an outside carrier.</p>
    <input className="search" type="search" placeholder="Customer" value={q} onChange={e => setQ(e.target.value)} />
    {cs.map(c => <CustomerShip key={c.id} c={c} zones={s.zones} canEdit={canEdit}
      onSave={(zoneId, rule, pct) => run(() => rpc(sb, 'set_customer_shipping', { p_customer: c.id, p_zone: zoneId, p_rule: rule, p_pct: pct }), `${c.name} saved`)} />)}
  </div>
}

function CustomerShip({ c, zones, canEdit, onSave }: { c: ShipSettings['customers'][number]; zones: ShipZone[]; canEdit: boolean; onSave: (zone: number | null, rule: string | null, pct: number | null) => void }) {
  const [pct, setPct] = useState(c.pct != null ? String(c.pct) : '50')
  return <div className={`row wrap setrow ${c.zone_id ? '' : 'warn-row'}`}>
    <span className="grow"><b>{c.name}</b>{c.contract && <span className="muted"> · contract</span>}{!c.zone_id && <span className="warn-t"> · no zone</span>}</span>
    <Select value={c.zone_id ?? ''} disabled={!canEdit} onChange={e => onSave(e.target.value ? Number(e.target.value) : null, c.rule, c.pct)}>
      <option value="">No zone</option>{zones.filter(z => z.active || z.id === c.zone_id).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}</Select>
    <Select value={c.rule ?? ''} disabled={!canEdit} onChange={e => onSave(c.zone_id, e.target.value || null, e.target.value === 'split' ? Number(pct) || 50 : null)}>
      <option value="">{`Default (${RULE_LABEL[c.auto_rule]})`}</option>{['calc', 'free', 'split', 'pickup'].map(k => <option key={k} value={k}>{RULE_LABEL[k]}</option>)}</Select>
    {c.rule === 'split' && <><input type="number" min="1" max="100" value={pct} disabled={!canEdit} style={{ width: 64 }} onChange={e => setPct(e.target.value)}
      onBlur={() => Number(pct) !== c.pct && onSave(c.zone_id, 'split', Number(pct))} /><span className="muted small">% Lifted pays</span></>}
  </div>
}
