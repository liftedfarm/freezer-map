import { useEffect, useState } from 'react'
import { Select } from '../combo'
import { errText } from '../cult/ui'
import type { T3Conn } from './api'
import type { Ctx } from './ctx'

// Compliance > Settings > METRC through T3: transfers and manifests, Phase 2 reasons, cutover dates per site.

const TYPES = [['internal', 'Between our licenses (OHR / GVR)'], ['customer', 'Customer manifests'], ['processor', 'Out to a drying processor'], ['nursery', 'Nursery clones out (1PN)']] as const

export function T3More({ c, conn, set, save }: { c: Ctx; conn: T3Conn | null; set: Record<string, string>; save: (k: string, v: string) => Promise<void> }) {
  const [drivers, setDrivers] = useState<{ id: number; name: string; license_no: string | null }[]>([])
  const [trucks, setTrucks] = useState<{ id: number; name: string; make: string | null; model: string | null; plate: string | null }[]>([])
  const [text, setText] = useState<Record<string, string>>({})
  useEffect(() => {
    c.api.sb.from('fleet_drivers').select('id,name,license_no').eq('active', true).is('carrier_id', null).order('name').then(r => setDrivers(r.data ?? []))
    c.api.sb.from('fleet_assets').select('id,name,make,model,plate').in('kind', ['vehicle', 'trailer']).neq('status', 'retired').order('name').then(r => setTrucks(r.data ?? []))
  }, [])
  const tr = conn?.transfer ?? {}
  const types = [...new Map(Object.values(tr).flatMap(x => x.types).map(t => [t.name, t])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const reasons = [...new Set(Object.values(conn?.reasons ?? {}).flat().map(r => r.name))].sort()
  const val = (k: string) => text[k] ?? set[k] ?? ''
  const blur = async (k: string) => { if (text[k] !== undefined && text[k] !== (set[k] ?? '')) { try { await save(k, text[k]) } catch (e) { c.flash(errText(e), true) } } setText(t => { const n = { ...t }; delete n[k]; return n }) }
  const inp = (k: string, ph?: string) => <input value={val(k)} placeholder={ph} disabled={!c.isAdmin} onChange={e => setText(t => ({ ...t, [k]: e.target.value }))} onBlur={() => blur(k)} />

  return <>
    <h3 style={{ marginTop: 14 }}>Transfers and manifests</h3>
    <p className="muted small">No prices go on manifests, so pick types that aren't Wholesale. Our C13 is the transporter on every manifest. Types come from METRC when you test the connection.</p>
    <div className="grid2">
      {TYPES.map(([k, l]) => {
        const key = `comp.metrc_ttype_${k}`; const v = set[key] ?? ''
        return <div className="field" key={k}><label>{l}</label>
          {types.length ? <Select value={v} disabled={!c.isAdmin} onChange={e => save(key, e.target.value)}>
            <option value="">Pick…</option>{types.map(t => <option key={t.name} value={t.name} disabled={t.wholesale}>{t.name}{t.wholesale ? ' (wholesale: needs prices)' : ''}</option>)}</Select>
            : <span className="muted small">{v || 'not set'} (test the connection first)</span>}
        </div>
      })}
      <div className="field"><label>Phone for questions</label>{inp('comp.metrc_phone', Object.values(tr)[0]?.phone ?? '(831) …')}</div>
      <div className="field"><label>Hours on the road (arrival estimate)</label>{inp('comp.metrc_transit_hours', '3')}</div>
      <div className="field"><label>Runs without a load (processor, nursery): driver</label>
        <Select value={set['comp.metrc_proc_driver'] ?? ''} disabled={!c.isAdmin} onChange={e => save('comp.metrc_proc_driver', e.target.value)}>
          <option value="">Pick…</option>{drivers.map(d => <option key={d.id} value={d.name}>{d.name}{d.license_no ? '' : ' (no DL # yet)'}</option>)}</Select></div>
      <div className="field"><label>Runs without a load: truck</label>
        <Select value={set['comp.metrc_proc_vehicle'] ?? ''} disabled={!c.isAdmin} onChange={e => save('comp.metrc_proc_vehicle', e.target.value)}>
          <option value="">Pick…</option>{trucks.map(t => <option key={t.id} value={String(t.id)}>{t.name}{t.make && t.model && t.plate ? '' : ' (needs make / model / plate)'}</option>)}</Select></div>
    </div>
    {Object.keys(tr).length > 0 && <p className="muted small">Drivers METRC knows: {[...new Set(Object.values(tr).flatMap(x => x.drivers))].join(', ') || 'none'} · Vehicles: {[...new Set(Object.values(tr).flatMap(x => x.vehicles))].join(', ') || 'none'}. The app uses METRC's employee ID for a driver whose name matches; otherwise the driver's license number from Compliance &gt; Vehicles.</p>}

    <h3 style={{ marginTop: 14 }}>METRC tags</h3>
    <label className="check"><input type="checkbox" checked={(set['comp.tag_autofill'] ?? 'true') === 'true'} disabled={!c.isAdmin}
      onChange={e => save('comp.tag_autofill', e.target.checked ? 'true' : 'false')} /> <span>Autofill the next available tag <span className="muted">(new tag boxes start filled in; suggestions show either way)</span></span></label>
    <p className="muted small">Tags come from METRC's available list for each license (pulled nightly, or Admin › Settings › Licenses › Pull tags from METRC). Ranges blocked off for a purpose there are kept for that purpose.</p>

    <h3 style={{ marginTop: 14 }}>Plants and harvests (Phase 2)</h3>
    <div className="grid2">
      <div className="field"><label>Used up (Remove) reason</label>
        {reasons.length ? <Select value={reasons.find(n => n.toLowerCase() === (set['comp.metrc_reason_used'] ?? '').toLowerCase()) ?? ''} disabled={!c.isAdmin} onChange={e => save('comp.metrc_reason_used', e.target.value)}>
          <option value="">Pick…</option>{reasons.map(n => <option key={n} value={n}>{n}</option>)}</Select> : inp('comp.metrc_reason_used')}</div>
      <div className="field"><label>Lost clones (clone package adjustment reason)</label>
        {reasons.length ? <Select value={reasons.find(n => n.toLowerCase() === (set['comp.metrc_plant_adjust_reason'] ?? '').toLowerCase()) ?? ''} disabled={!c.isAdmin} onChange={e => save('comp.metrc_plant_adjust_reason', e.target.value)}>
          <option value="">Pick…</option>{reasons.map(n => <option key={n} value={n}>{n}</option>)}</Select> : inp('comp.metrc_plant_adjust_reason')}</div>
      <div className="field"><label>Destroying immature plants (waste reason, as METRC names it)</label>{inp('comp.metrc_plant_waste_reason', 'e.g. Male Plants / Died')}</div>
      <div className="field"><label>Harvest waste type <span className="muted">(blank = METRC's first)</span></label>{inp('comp.metrc_waste_type', 'e.g. Plant Material')}</div>
      <div className="field"><label>Hours after Finish: record harvest waste <span className="muted">(0 = right away)</span></label>{inp('comp.metrc_waste_hours', '48')}</div>
      <div className="field"><label>Hours after Finish: finish the harvest in METRC <span className="muted">(0 = right away)</span></label>{inp('comp.metrc_finish_hours', '48')}</div>
    </div>
    <p className="muted small">Counted from when Finish is pressed in the app. A change applies to harvests finished after it; to-dos already waiting keep their time. Send on a to-do sends it right away. The finish never goes before its waste.</p>
    <h3 style={{ marginTop: 14 }}>Cutover per site</h3>
    <p className="muted small">Plant, nursery and harvest to-dos only go to METRC from a site's cutover date on. Before that (or with no date) they stay by hand, even if the kind is on.</p>
    <div className="grid2">{['OHR', 'GVR', '1PN'].map(s => {
      const key = `comp.metrc_cutover_${s}`
      return <div className="field" key={s}><label>{s}</label>
        <input type="date" value={set[key] ?? ''} disabled={!c.isAdmin} onChange={e => save(key, e.target.value)} /></div>
    })}</div>
  </>
}
