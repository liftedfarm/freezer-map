import { useEffect, useState } from 'react'
import type { NurseryRecon } from './api'
import type { Ctx } from './ctx'
import { errText } from '../cult/ui'
import { download, toCsv } from './csv'
import { today } from './files'

// Compliance > METRC > Reconcile > Nursery (1PN): clone packages against cutting batches, mother lots against METRC plant batches.

const n0 = (x: number | null | undefined) => (x == null ? '' : Math.round(Number(x)).toLocaleString())
const GROUPS: [NurseryRecon['kind'], NurseryRecon['issue'], string, string][] = [
  ['clones', 'count', 'Clone packages: count is off', 'METRC count vs. what the batch should still have (cuttings, less lost, delivered and planted as mothers).'],
  ['clones', 'not_in_metrc', 'Clone packages: not active in METRC', 'The batch still has plants in the app, but its package isn\'t active in METRC.'],
  ['clones', 'no_tag', 'Cutting batches with no package tag', 'Plants left in the app, no clone package tag to match.'],
  ['clones', 'not_in_app', 'In METRC, not on any cutting batch', 'Clone or seed packages in METRC that no batch in the app carries.'],
  ['mothers', 'count', 'Mother lots: count is off', 'Plants alive in the app vs. the METRC plant batch.'],
  ['mothers', 'not_in_metrc', 'Mother lots: not in METRC', 'Active lot in the app with a tag no active METRC plant batch has.'],
  ['mothers', 'no_tag', 'Mother lots with no plant tag', ''],
  ['mothers', 'closed_in_app', 'Mother lots closed in the app, active in METRC', ''],
  ['mothers', 'not_in_app', 'In METRC, no mother lot in the app', 'Immature plant batches on the nursery license that no lot in the app carries.'],
]

export function NurseryReconcile({ c }: { c: Ctx }) {
  const [rows, setRows] = useState<NurseryRecon[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set(['clones:count', 'mothers:count']))
  const load = async () => { try { setRows(await c.api.reconcileNursery()) } catch (e) { c.flash(errText(e), true); setRows([]) } }
  useEffect(() => { load() }, [])
  async function pull() {
    setBusy('Pulling 1PN from METRC…')
    try {
      const lic = (await c.api.syncStatus()).filter(s => s.site === '1PN').map(s => s.license)
      for (let i = 0; i < 8; i++) {
        const r = await c.api.pullMetrc(lic.length ? lic : undefined)
        const bad = r.results.find(x => x.error)
        if (bad) { c.flash(`${bad.license}: ${bad.error}`, true); break }
        if (r.done) { c.flash('1PN pulled from METRC'); break }
        setBusy(`Still pulling… pass ${i + 2}`)
      }
      await load()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(null) }
  }
  const csv = () => download(`Nursery METRC mismatches ${today()}.csv`, toCsv(['What', 'Issue', 'Tag', 'Strain', 'Batch / room', 'App', 'METRC', 'METRC item', 'METRC location', 'Note'],
    (rows ?? []).map(r => [r.kind, GROUPS.find(g => g[0] === r.kind && g[1] === r.issue)?.[2] ?? r.issue, r.tag, r.strain, r.name, r.app_n, r.metrc_n, r.metrc_item, r.metrc_location, r.note])))
  return <div className="list">
    <p className="muted">1PN in METRC (from the last pull) against the Nursery module: each clone package against the cutting batch that carries its tag, and each mother lot against its METRC plant batch.</p>
    <div className="row wrap toolbar">
      <button className="ghost small" disabled={!!busy} onClick={pull}>{busy ?? 'Pull 1PN from METRC'}</button>
      <button className="ghost small" disabled={!rows?.length} onClick={csv}>Export CSV</button>
      {rows && <span className="muted small">{rows.length ? `${rows.length} to look at` : 'Everything matches'}</span>}
    </div>
    {!rows && <p className="muted">Loading…</p>}
    {GROUPS.map(([k, i, label, help]) => {
      const rs = (rows ?? []).filter(r => r.kind === k && r.issue === i)
      if (!rs.length) return null
      const key = `${k}:${i}`, on = open.has(key)
      return <div key={key} className="card" style={{ marginBottom: 8 }}>
        <button className="linkbtn" onClick={() => setOpen(s => { const n = new Set(s); if (on) n.delete(key); else n.add(key); return n })}>{on ? '▾' : '▸'} {label} ({rs.length})</button>
        {on && <>{help && <p className="muted small">{help}</p>}
          <div className="tablewrap"><table className="ct"><thead><tr><th>Tag</th><th>Strain</th><th className="hide-s">{k === 'clones' ? 'Batch' : 'Room'}</th><th>App</th><th>METRC</th><th className="hide-s">Note</th></tr></thead>
            <tbody>{rs.map((r, j) => <tr key={j}><td className="mono small">{r.tag ?? ''}</td><td>{r.strain ?? r.metrc_item ?? ''}</td><td className="hide-s">{r.name ?? r.metrc_location ?? ''}</td>
              <td>{n0(r.app_n)}</td><td>{n0(r.metrc_n)}</td><td className="muted small hide-s">{r.note ?? ''}</td></tr>)}</tbody></table></div></>}
      </div>
    })}
  </div>
}
