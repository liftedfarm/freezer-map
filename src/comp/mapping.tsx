import { useEffect, useMemo, useState } from 'react'
import { Select } from '../combo'
import { errText } from '../cult/ui'
import type { LocMap, MapData } from './api'
import type { Ctx } from './ctx'

// Compliance > METRC > Mapping (Phase 2): what METRC calls our fields, nursery rooms, drying rooms and strains,
// plus what's growing where in METRC (plant batches and plant counts from the nightly pull).

const n0 = (x: number | null | undefined) => (x == null ? '' : Math.round(Number(x)).toLocaleString())

export function Mapping({ c }: { c: Ctx }) {
  const [d, setD] = useState<MapData | null>(null)
  const [site, setSite] = useState<string>('OHR')
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const load = async () => { try { setD(await c.api.mapData()) } catch (e) { c.flash(errText(e), true) } }
  useEffect(() => { load() }, [])

  const lic = useMemo(() => {
    if (!d) return null
    if (site === '1PN') return d.nurserySites.find(n => n.code === '1PN')?.license ?? null
    return d.licenses.find(l => l.active && l.kind === 'cultivation' && (l.site ?? '').toUpperCase() === site)?.license_no ?? null
  }, [d, site])
  if (!d) return <p className="muted">Loading…</p>
  const locs = d.locs.filter(l => l.license === lic)
  const mapped = (kind: LocMap['app_kind'], ref: string) => d.locMap.find(m => m.app_kind === kind && m.app_ref === ref && m.license === lic)
  const counts = (locId: number | undefined) => {
    if (!locId) return null
    const b = d.batches.filter(x => x.license === lic && x.location_id === locId).reduce((s, x) => s + Number(x.untracked ?? 0), 0)
    const v = d.counts.filter(x => x.license === lic && x.location_id === locId && x.phase === 'vegetative').reduce((s, x) => s + x.plants, 0)
    const f = d.counts.filter(x => x.license === lic && x.location_id === locId && x.phase === 'flowering').reduce((s, x) => s + x.plants, 0)
    return [b && `${n0(b)} immature`, v && `${n0(v)} veg`, f && `${n0(f)} flowering`].filter(Boolean).join(' · ') || 'empty'
  }
  async function setLoc(kind: LocMap['app_kind'], ref: string, id: string) {
    if (!lic) return
    try { await c.api.mapLocation(kind, ref, lic, id ? Number(id) : null); await load(); c.flash('Saved') } catch (e) { c.flash(errText(e), true) }
  }
  async function setStrain(name: string, id: string) {
    if (!lic) return
    try { await c.api.mapStrain(name, lic, id ? Number(id) : null); await load(); c.flash('Saved') } catch (e) { c.flash(errText(e), true) }
  }
  async function pull() {
    setBusy('Pulling from METRC…')
    try {
      for (let i = 0; i < 12; i++) {
        const r = await c.api.pullMetrc(lic ? [lic] : undefined)
        const bad = r.results.find(x => x.error)
        if (bad) { c.flash(`${bad.license}: ${bad.error}`, true); break }
        if (r.done) { c.flash('METRC pulled'); break }
        setBusy(`Still pulling… pass ${i + 2}`)
      }
      await load()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(null) }
  }
  const locSelect = (kind: LocMap['app_kind'], ref: string, filter: (l: MapData['locs'][number]) => boolean) => {
    const m = mapped(kind, ref)
    const opts = locs.filter(l => filter(l) || l.id === m?.location_id)
    return <Select value={m ? String(m.location_id) : ''} disabled={!c.isAdmin || !locs.length} onChange={e => setLoc(kind, ref, e.target.value)}>
      <option value="">{locs.length ? 'Not mapped' : 'Pull from METRC first'}</option>{opts.map(l => <option key={l.id} value={String(l.id)}>{l.name}{l.type_name ? ` (${l.type_name})` : ''}</option>)}</Select>
  }
  const metrcStrains = d.strains.filter(s => s.license === lic)
  const strainOf = (name: string) => {
    const m = d.strainMap.find(x => x.app_strain.toLowerCase() === name.toLowerCase() && x.license === lic)
    if (m) return { id: m.strain_id, how: 'mapped' }
    const s = metrcStrains.find(x => x.name.toLowerCase() === name.toLowerCase())
    return s ? { id: s.id, how: 'same name' } : null
  }
  const fields = d.fields.filter(f => f.site.toUpperCase() === site && f.active)
  const rooms = d.rooms.filter(r => r.site.toUpperCase() === site && r.active)
  const strains = d.appStrains.filter(s => !q || s.toLowerCase().includes(q.toLowerCase()))
  const unmatched = d.appStrains.filter(s => !strainOf(s)).length
  const lastPull = d.locs.filter(l => l.license === lic).length

  return <div className="list">
    <p className="muted">For plant, nursery and harvest work the app needs to know what METRC calls our places and strains. Pull from METRC, then map each field (and nursery room) to its METRC location, pick each site's drying / harvest location, and fix strains that don't match by name.</p>
    <div className="row wrap toolbar">
      <div className="seg">{['OHR', 'GVR', '1PN'].map(s => <button key={s} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s}</button>)}</div>
      <span className="muted small">{lic ?? 'no license'} · {lastPull} METRC locations · {metrcStrains.length} strains</span>
      <button className="ghost small" disabled={!!busy} onClick={pull}>{busy ?? 'Pull from METRC'}</button>
    </div>

    {site !== '1PN' && <>
      <h3>Drying / harvest location</h3>
      <div className="grid2"><div className="field"><label>Where {site} harvests go in METRC</label>{locSelect('drying', site, l => l.for_harvests !== false)}</div></div>
      <h3>Fields</h3>
      <div className="tablewrap"><table className="ct"><thead><tr><th>Field</th><th>METRC location</th><th className="hide-s">In METRC there</th></tr></thead>
        <tbody>{fields.map(f => <tr key={f.id}><td><b>{f.name}</b>{f.code ? <span className="muted small"> {f.code}</span> : null}</td>
          <td>{locSelect('field', String(f.id), l => l.for_plants !== false || l.for_plant_batches !== false)}</td>
          <td className="muted small hide-s">{counts(mapped('field', String(f.id))?.location_id)}</td></tr>)}
          {!fields.length && <tr><td colSpan={3} className="muted">No fields for {site}</td></tr>}</tbody></table></div>
    </>}
    {site === '1PN' && <>
      <h3>Nursery rooms</h3>
      <div className="tablewrap"><table className="ct"><thead><tr><th>Room</th><th>METRC location</th><th className="hide-s">In METRC there</th></tr></thead>
        <tbody>{rooms.map(r => <tr key={r.id}><td><b>{r.name}</b></td><td>{locSelect('room', String(r.id), l => l.for_plant_batches !== false || l.for_plants !== false)}</td>
          <td className="muted small hide-s">{counts(mapped('room', String(r.id))?.location_id)}</td></tr>)}
          {!rooms.length && <tr><td colSpan={3} className="muted">No rooms</td></tr>}</tbody></table></div>
    </>}

    <h3>Strains {unmatched > 0 && metrcStrains.length > 0 && <span className="pill m-warn">{unmatched} not matched on {lic}</span>}</h3>
    <input placeholder="Find a strain" value={q} onChange={e => setQ(e.target.value)} />
    <div className="tablewrap"><table className="ct"><thead><tr><th>App strain</th><th>METRC strain on {lic}</th><th className="hide-s">How</th></tr></thead>
      <tbody>{strains.map(s => {
        const m = strainOf(s)
        return <tr key={s}><td>{s}</td>
          <td><Select value={m ? String(m.id) : ''} disabled={!c.isAdmin || !metrcStrains.length} onChange={e => setStrain(s, e.target.value)}>
            <option value="">{metrcStrains.length ? 'No match' : 'Pull first'}</option>{metrcStrains.map(x => <option key={x.id} value={String(x.id)}>{x.name}</option>)}</Select></td>
          <td className={`small hide-s ${m ? 'muted' : 'neg'}`}>{m?.how ?? 'none'}</td></tr>
      })}</tbody></table></div>

    <h3>Plant batches in METRC ({lic})</h3>
    <div className="tablewrap"><table className="ct"><thead><tr><th>Batch</th><th>Strain</th><th>Location</th><th>Immature</th><th className="hide-s">Planted</th></tr></thead>
      <tbody>{d.batches.filter(b => b.license === lic).slice(0, 300).map(b => <tr key={b.id}><td className="mono small">{b.name}</td><td>{b.strain}</td><td>{b.location}</td><td>{n0(b.untracked)}</td><td className="muted small hide-s">{b.planted_on ?? ''}</td></tr>)}
        {!d.batches.some(b => b.license === lic) && <tr><td colSpan={5} className="muted">None (or not pulled yet)</td></tr>}</tbody></table></div>
    {d.counts.some(x => x.license === lic) && <>
      <h3>Tagged plants in METRC ({lic})</h3>
      <div className="tablewrap"><table className="ct"><thead><tr><th>Phase</th><th>Location</th><th>Strain</th><th>Plants</th><th className="hide-s">Planted</th></tr></thead>
        <tbody>{d.counts.filter(x => x.license === lic).sort((a, b) => a.phase.localeCompare(b.phase) || String(a.location).localeCompare(String(b.location))).map(x =>
          <tr key={`${x.phase}${x.location_id}${x.strain}`}><td>{x.phase}</td><td>{x.location}</td><td>{x.strain}</td><td>{n0(x.plants)}</td><td className="muted small hide-s">{x.oldest ?? ''}{x.newest && x.newest !== x.oldest ? ` to ${x.newest}` : ''}</td></tr>)}</tbody></table></div>
    </>}
  </div>
}
