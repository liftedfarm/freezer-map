import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { metrcRun } from './metrcCall'

// Distribution > Inbound: METRC transfers coming in to our licenses (from OHR / GVR, processors, nurseries, outside sellers).
// Receive takes the delivery in METRC (Live; a dry-run check otherwise) and brings the packages into the app: ones the app
// knows come back into inventory at the site (Needs a spot), new ones are added and flagged to check strain and product.

interface Item { id: number; tag: string; item: string | null; strain: string | null; qty: number; uom: string; state: string | null
  app?: { id: number; code: string; status: string; lbs: number | null; site: string | null } }
interface Delivery { license: string; site: string; transfer_id?: number; delivery_id?: number; manifest?: string; from_license?: string; from?: string; type?: string
  departed?: string; arrival?: string; driver?: string; vehicle?: string; packages?: number; items?: Item[]; error?: string }

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const STATUS: Record<string, string> = { in_transit: 'on a load', at_processor: 'at processor', shipped: 'shipped', unslotted: 'needs a spot', in_freezer: 'in a freezer', depleted: 'used up', merged: 'merged', archived: 'archived' }

export function InboundView({ sb, flash, onChanged }: { sb: SupabaseClient | null; flash: (m: string, bad?: boolean) => void; onChanged: () => void }) {
  const module = 'distribution'
  const [rows, setRows] = useState<Delivery[] | null>(null)
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const load = async () => {
    if (!sb) return
    setBusy('Asking METRC…')
    try { const r = await metrcRun<{ live: boolean; deliveries: Delivery[] }>(sb, { action: 'incoming', module }); setRows(r.deliveries); setLive(r.live) }
    catch (e) { flash(e instanceof Error ? e.message : String(e), true); setRows([]) } finally { setBusy(null) }
  }
  useEffect(() => { load() }, [])
  async function receive(d: Delivery) {
    if (!sb || !d.delivery_id) return
    if (!confirm(live ? `Receive manifest ${d.manifest} from ${d.from} in METRC (${d.items?.length ?? d.packages} packages) and bring it into the app?`
      : `Dry run: check that METRC would take manifest ${d.manifest}? (Nothing changes until Compliance goes Live.)`)) return
    setBusy(`Receiving ${d.manifest}…`)
    try {
      const r = await metrcRun<{ ok: boolean; info: string }>(sb, { action: 'inbound_receive', license: d.license, delivery_id: d.delivery_id, module })
      flash(r.info, !r.ok)
      if (live && r.ok) { onChanged(); await load() }
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true) } finally { setBusy(null) }
  }
  const ok = (rows ?? []).filter(d => !d.error)
  const errs = (rows ?? []).filter(d => d.error)
  return <div className="list">
    <div className="row between wrap toolbar"><h2>Inbound</h2>
      <div className="row"><span className={`pill ${live ? 'm-bad' : 'm-warn'}`}>{live ? 'METRC Live' : 'Dry run'}</span>
        <button className="ghost small" disabled={!!busy} onClick={load}>{busy ?? 'Refresh'}</button></div></div>
    <p className="muted">Product packages on their way to OHR and GVR (plants go to Production › Receiving, anything for 1PN to Nursery › Receiving). Receive takes the whole delivery in METRC{live ? '' : ' (a dry-run check until Compliance goes Live)'} and brings its packages into the app (Needs a spot).</p>
    {errs.map(d => <p key={d.license} className="neg small">{d.site} {d.license}: {d.error}</p>)}
    {rows && !ok.length && !busy && <p className="muted">Nothing incoming.</p>}
    {ok.map(d => {
      const known = (d.items ?? []).filter(i => i.app).length
      return <div key={`${d.license}${d.delivery_id}`} className="card">
        <div className="row between wrap">
          <div><b>{d.manifest}</b> <span className="muted">from</span> <b>{d.from}</b> <span className="muted small">{d.from_license}</span>
            <div className="muted small">to {d.site} {d.license} · {d.type ?? ''} · left {when(d.departed)}{d.arrival ? ` · due ${when(d.arrival)}` : ''}{d.driver ? ` · ${d.driver}` : ''}{d.vehicle ? ` · ${d.vehicle}` : ''}</div>
            <div className="small">{d.items?.length ?? d.packages} packages{known ? ` · ${known} the app knows` : ''}</div></div>
          <div className="row">
            <button className="ghost small" onClick={() => setOpen(o => o === d.delivery_id ? null : d.delivery_id ?? null)}>{open === d.delivery_id ? 'Hide' : 'Packages'}</button>
            <button className="primary small" disabled={!!busy} onClick={() => receive(d)}>{live ? 'Receive' : 'Check'}</button>
          </div>
        </div>
        {open === d.delivery_id && <div className="tablewrap"><table className="ct"><thead><tr><th>Tag</th><th>Item</th><th>Qty</th><th>In the app</th></tr></thead>
          <tbody>{(d.items ?? []).map(i => <tr key={i.tag}><td className="mono small">{i.tag}</td><td>{i.item}</td><td>{i.qty} {i.uom}</td>
            <td className="small">{i.app ? <>{i.app.code} <span className="muted">({STATUS[i.app.status] ?? i.app.status})</span></> : /^(lb|lbs)/i.test(i.uom) ? <span className="muted">new: added on receive</span> : <span className="muted">plant package (METRC only)</span>}</td></tr>)}</tbody></table></div>}
      </div>
    })}
  </div>
}
