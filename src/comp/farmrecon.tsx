import { useEffect, useMemo, useState } from 'react'
import type { HarvestRecon, PlantRecon } from './api'
import type { Ctx } from './ctx'
import { errText } from '../cult/ui'
import { download, toCsv } from './csv'
import { today } from './files'

// Compliance > METRC > Reconcile > Farm plants (OHR, GVR): per strain, plants the app says are standing (planted less harvested)
// next to METRC (immature in plant batches + flowering, counted by strain), and harvested plants in each; then each harvest.

const n0 = (x: number | null | undefined) => (x == null ? '' : Math.round(Number(x)).toLocaleString())
const sgn = (x: number) => (x > 0 ? `+${n0(x)}` : n0(x))
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never')

const PLANT_ISSUES: [PlantRecon['issue'], string, string][] = [
  ['harvest_behind', 'Harvested in the app, still standing in METRC', 'Plants the app has harvested that METRC still shows immature or flowering: harvests not entered in METRC yet.'],
  ['not_flipped', 'Not flipped to flowering in METRC', 'METRC still has these as immature plant batches.'],
  ['not_in_metrc', 'Planted in the app, nothing in METRC', 'No plant batch, flowering plant or harvest of this strain on the license.'],
  ['short', 'METRC has fewer plants', 'Planted, harvested and standing in METRC add up to less than the app planted.'],
  ['over', 'METRC has more plants', 'Standing plants in METRC are more than the app expects.'],
  ['harvest_count', 'Harvested plant counts differ', 'Standing plants match; the number harvested differs.'],
  ['not_in_app', 'In METRC, no planting in the app', 'Strains METRC has on the license that no planting this season carries.'],
  ['not_counted', 'Flowering not counted yet', 'Hit Count plants now.'],
  ['ok', 'Matches', 'Within 1% (or 5 plants).'],
]
const HARVEST_ISSUES: [HarvestRecon['issue'], string][] = [
  ['not_in_metrc', 'App harvests not found in METRC'], ['no_name', 'App harvests with no METRC harvest name'], ['plants', 'Plant counts differ'],
  ['weight', 'Wet weight differs'], ['open', 'Still open in METRC (weight not packaged)'], ['not_in_app', 'METRC harvests not in the app'], ['ok', 'Matches'],
]

export function FarmReconcile({ c }: { c: Ctx }) {
  const [lics, setLics] = useState<{ license: string; site: string }[]>([])
  const [lic, setLic] = useState<string | null>(null)
  const [plants, setPlants] = useState<PlantRecon[] | null>(null)
  const [harv, setHarv] = useState<HarvestRecon[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set(['p:harvest_behind', 'p:not_flipped', 'p:not_in_metrc', 'h:not_in_metrc']))
  useEffect(() => {
    c.api.farmLicenses().then(farms => { setLics(farms); setLic(l => l ?? farms[0]?.license ?? null) }).catch(e => setErr(errText(e)))
  }, [])
  const load = async (l: string) => {
    setPlants(null); setHarv(null)
    try { const [p, h] = await Promise.all([c.api.reconcilePlants(l), c.api.reconcileFarmHarvests(l)]); setPlants(p); setHarv(h); setErr(null) }
    catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { if (lic) load(lic) }, [lic])
  async function count() {
    if (!lic) return
    setBusy('Counting plants in METRC (a few minutes for big licenses)…')
    try {
      const r = await c.api.countPlants(lic)
      const x = r.results[0]
      if (x?.error) c.flash(`${lic}: ${x.error}`, true)
      else c.flash(`${lic}: ${n0(x?.plants)} plants counted${x?.complete ? '' : ' (ran out of time: count again for the rest)'}${x?.notes?.length ? `. ${x.notes.join('; ')}` : ''}`)
      await load(lic)
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(null) }
  }
  const tot = useMemo(() => {
    const ps = plants ?? []
    const s = (f: (r: PlantRecon) => number) => ps.reduce((a, r) => a + (f(r) || 0), 0)
    return { planted: s(r => r.planted), ah: s(r => r.app_harvested), al: s(r => r.app_live), mi: s(r => r.metrc_immature), mf: s(r => r.metrc_flowering ?? 0), mh: s(r => r.metrc_harvested),
      counted: ps.map(r => r.metrc_counted).filter(Boolean).sort().pop() ?? null }
  }, [plants])
  const toggle = (k: string) => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const csv = () => download(`Farm plants ${lic} ${today()}.csv`, toCsv(
    ['Issue', 'Strain', 'METRC strain', 'App fields', 'METRC locations', 'Plantings', 'Planted', 'Harvested (app)', 'Standing (app)', 'Immature (METRC)', 'Flowering (METRC)', 'Standing (METRC)', 'Harvested (METRC)', 'Difference', 'Note'],
    (plants ?? []).map(r => [PLANT_ISSUES.find(i => i[0] === r.issue)?.[1] ?? r.issue, r.strain, r.metrc_strain, r.fields, r.metrc_locations, r.plantings, r.planted, r.app_harvested, r.app_live,
      r.metrc_immature, r.metrc_flowering, r.metrc_live, r.metrc_harvested, r.diff, r.note])))
  return <div className="list">
    <p className="muted">Farm plants this season: what the app says is standing in the field (planted, less harvested) against METRC (immature plant batches plus flowering plants, counted by strain), and harvested plants on both sides. Then each harvest against its METRC harvest.</p>
    <div className="row wrap toolbar">
      <div className="chips">{lics.map(l => <button key={l.license} className={lic === l.license ? 'on' : ''} onClick={() => setLic(l.license)}>{l.site} {l.license}</button>)}</div>
      <button className="ghost small" disabled={!!busy || !lic} onClick={count}>{busy ?? 'Count plants now'}</button>
      <button className="ghost small" disabled={!plants?.length} onClick={csv}>Export CSV</button>
      <span className="muted small">Flowering counted {when(tot.counted)}</span>
    </div>
    {err && <p className="neg small">{err}</p>}
    {!plants && !err && <p className="muted">Loading…</p>}
    {plants && <div className="farm-tiles">
      <div className="card"><div className="muted small">Planted (app)</div><b>{n0(tot.planted)}</b></div>
      <div className="card"><div className="muted small">Standing: app / METRC</div><b>{n0(tot.al)} / {n0(tot.mi + tot.mf)}</b><div className="muted small">METRC {n0(tot.mi)} immature, {n0(tot.mf)} flowering</div></div>
      <div className="card"><div className="muted small">Harvested: app / METRC</div><b>{n0(tot.ah)} / {n0(tot.mh)}</b></div>
      <div className="card"><div className="muted small">Strains to look at</div><b>{(plants ?? []).filter(r => r.issue !== 'ok').length}</b><div className="muted small">of {plants.length}</div></div>
    </div>}
    {PLANT_ISSUES.map(([i, label, help]) => {
      const rs = (plants ?? []).filter(r => r.issue === i)
      if (!rs.length) return null
      const key = `p:${i}`, on = open.has(key)
      return <div key={key} className="card" style={{ marginBottom: 8 }}>
        <button className="linkbtn" onClick={() => toggle(key)}>{on ? '▾' : '▸'} {label} ({rs.length})</button>
        {on && <><p className="muted small">{help}</p>
          <div className="tablewrap"><table className="ct"><thead><tr><th>Strain</th><th className="hide-s">Fields (app) / locations (METRC)</th><th>Planted</th><th>Harvested app / METRC</th><th>Standing app</th><th>METRC immature + flowering</th><th>Diff</th><th className="hide-s">Note</th></tr></thead>
            <tbody>{rs.map((r, j) => <tr key={j}>
              <td>{r.strain}{r.metrc_strain && r.metrc_strain.toLowerCase() !== r.strain.toLowerCase() ? <div className="muted small">METRC: {r.metrc_strain}</div> : null}</td>
              <td className="hide-s small">{r.fields ?? ''}{r.metrc_locations ? <div className="muted">{r.metrc_locations}</div> : null}</td>
              <td>{n0(r.planted)}</td><td>{n0(r.app_harvested)} / {n0(r.metrc_harvested)}</td><td>{n0(r.app_live)}</td>
              <td>{n0(r.metrc_immature)} + {r.metrc_flowering == null ? '?' : n0(r.metrc_flowering)}</td>
              <td className={r.diff ? 'neg' : ''}>{sgn(r.diff)}</td><td className="muted small hide-s">{r.note ?? ''}</td></tr>)}</tbody></table></div></>}
      </div>
    })}
    <h3 style={{ margin: '14px 0 6px' }}>Harvests</h3>
    {HARVEST_ISSUES.map(([i, label]) => {
      const rs = (harv ?? []).filter(r => r.issue === i)
      if (!rs.length) return null
      const key = `h:${i}`, on = open.has(key)
      return <div key={key} className="card" style={{ marginBottom: 8 }}>
        <button className="linkbtn" onClick={() => toggle(key)}>{on ? '▾' : '▸'} {label} ({rs.length})</button>
        {on && <div className="tablewrap"><table className="ct"><thead><tr><th>Harvest</th><th>Strain</th><th className="hide-s">Date</th><th>Plants app / METRC</th><th>Wet lb app / METRC</th><th className="hide-s">Left in METRC</th><th className="hide-s">Note</th></tr></thead>
          <tbody>{rs.map((r, j) => <tr key={j}><td className="small">{r.name ?? '(no name)'}</td><td>{r.strain ?? ''}{r.field ? <div className="muted small">{r.field}</div> : null}</td>
            <td className="hide-s small">{r.harvested_on ?? ''}</td><td>{n0(r.app_plants)} / {n0(r.metrc_plants)}</td><td>{n0(r.app_wet)} / {n0(r.metrc_wet)}</td>
            <td className="hide-s">{r.metrc_finished ? 'finished' : n0(r.metrc_left)}</td><td className="muted small hide-s">{r.note ?? ''}</td></tr>)}</tbody></table></div>}
      </div>
    })}
  </div>
}
