import { useState } from 'react'
import type { CultApi } from './api'
import { daysBetween, fmtD, n0, n1, n2, plantingAcres, sum, today } from './calc'
import type { Ctx } from './calc'
import type { CField, CultData, Planting, Receipt, Source } from './types'
import { Choices, DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn, errText } from './ui'
import type { Flash } from './ui'

const SOURCES: { v: Source; l: string }[] = [{ v: 'clone', l: 'Clone' }, { v: 'seed', l: 'Seed' }, { v: 'auto', l: 'Auto (seed)' }]

export function PlantingsTab({ d, c, site, q, api, flash, onSaved }: { d: CultData; c: Ctx; site: string | null; q: string; api: CultApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [edit, setEdit] = useState<Partial<Planting> | null>(null)
  const [rEdit, setREdit] = useState<Partial<Receipt> | null>(null)
  const [view, setView] = useState<'fields' | 'receiving'>('fields')
  const ql = q.trim().toLowerCase()
  const ps = d.plantings.filter(p => (!site || p.site === site) && (!ql || `${p.strain} ${p.nursery ?? ''} ${p.notes ?? ''}`.toLowerCase().includes(ql)))
  const groups = new Map<string, Planting[]>()
  for (const p of ps) { const k = `${p.site}|${p.field_id ?? ''}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(p) }
  const fieldOf = (k: string) => { const [s, f] = k.split('|'); return { site: s, f: f ? c.field.get(Number(f)) : undefined } }
  const order = [...groups.keys()].sort((a, b) => { const x = fieldOf(a), y = fieldOf(b); return x.site.localeCompare(y.site) || (x.f?.sort ?? 99) - (y.f?.sort ?? 99) })
  const harvestedOf = (p: Planting) => d.harvests.filter(h => h.planting_id === p.id && h.status === 'done')
  const now = today()

  // receiving: received - rejected - planted, by strain and batch
  const plantedBy = new Map<string, number>()
  for (const p of d.plantings) { const k = `${p.site}|${p.strain.toLowerCase()}|${p.batch ?? 1}`; plantedBy.set(k, (plantedBy.get(k) ?? 0) + (p.plants ?? 0) + (p.plant_loss ?? 0)) }
  const rs = d.receipts.filter(r => (!site || r.site === site) && (!ql || r.strain.toLowerCase().includes(ql)))

  return (
    <>
      <div className="row toolbar">
        <div className="seg"><button className={view === 'fields' ? 'on' : ''} onClick={() => setView('fields')}>By field</button>
          <button className={view === 'receiving' ? 'on' : ''} onClick={() => setView('receiving')}>Plants received</button></div>
        {view === 'fields'
          ? <button className="primary" onClick={() => setEdit({ crop_year: d.year, site: site ?? 'OHR', source: 'clone', batch: 1 })}>+ Add planting</button>
          : <button className="primary" onClick={() => setREdit({ crop_year: d.year, site: site ?? 'OHR', source: 'clone', batch: 1, received: 0, rejected: 0, received_on: now })}>+ Plants received</button>}
      </div>

      {view === 'fields' && <>
        <div className="ckpis">
          <div><b>{n0(sum(ps.filter(p => p.source === 'clone').map(p => p.plants)))}</b><span>clones planted</span></div>
          <div><b>{n1(sum(ps.filter(p => p.source === 'clone').map(p => plantingAcres(p, c.site.get(p.site)))))}</b><span>acres of clones</span></div>
          <div><b>{n0(sum(ps.filter(p => p.source !== 'clone').map(p => p.plants)))}</b><span>seeded plants (biomass)</span></div>
          <div><b>{new Set(ps.map(p => p.strain.toLowerCase())).size}</b><span>strains</span></div>
          <div><b>{ps.length}</b><span>plantings</span></div>
        </div>
        {order.map(k => {
          const { site: s, f } = fieldOf(k)
          const list = groups.get(k)!.sort((a, b) => (a.planted_on ?? '').localeCompare(b.planted_on ?? '') || a.strain.localeCompare(b.strain))
          const ac = sum(list.map(p => plantingAcres(p, c.site.get(p.site))))
          return (
            <div key={k}>
              <h3 className="csec">{s} {f ? `${f.code}` : '(no field)'} <span className="muted">{f?.name} · {n0(sum(list.map(p => p.plants)))} plants · {n2(ac)} ac{f?.acres ? ` of ${n2(f.acres)}` : ''}</span></h3>
              <div className="cwrap"><table className="ctable">
                <thead><tr><th>Strain</th><th>Planted</th><th className="num">Plants</th><th className="num hide-s">Spacing</th><th className="num">Acres</th><th className="hide-s">Nursery</th>
                  <th className="num">Est. lbs/pl</th><th className="hide-s">First flower</th><th>Harvested</th></tr></thead>
                <tbody>{list.map(p => {
                  const hs = harvestedOf(p)
                  return (
                    <tr key={p.id} className="tap" onClick={() => setEdit(p)}>
                      <td>{p.strain}{p.batch && p.batch > 1 ? <span className="muted"> · batch {p.batch}</span> : null}{p.source !== 'clone' && <span className="muted"> · {p.source}</span>}</td>
                      <td className="nowrap">{fmtD(p.planted_on)}</td><td className="num">{n0(p.plants)}</td><td className="num hide-s">{p.spacing_in ? `${p.spacing_in}"` : ''}</td>
                      <td className="num">{n2(plantingAcres(p, c.site.get(p.site)))}</td><td className="hide-s">{p.nursery ?? ''}</td><td className="num">{n2(p.est_lbs_per_plant)}</td>
                      <td className="hide-s nowrap">{fmtD(p.first_flower)}</td>
                      <td className="nowrap small">{hs.length ? hs.map(h => fmtD(h.harvested_on)).join(', ') : p.planted_on ? <span className="muted">{daysBetween(p.planted_on, now)} days in</span> : ''}</td>
                    </tr>
                  )
                })}</tbody>
              </table></div>
            </div>
          )
        })}
        {!ps.length && <p className="muted">No plantings for {d.year}{site ? ` at ${site}` : ''}.</p>}
      </>}

      {view === 'receiving' && <>
        <div className="cwrap"><table className="ctable">
          <thead><tr><th>Strain</th><th>Batch</th><th>Site</th><th>Nursery</th><th>Received</th><th className="num">Plants</th><th className="num">Rejected</th><th className="num">Planted</th><th className="num">Left over</th></tr></thead>
          <tbody>{rs.map(r => {
            const planted = plantedBy.get(`${r.site}|${r.strain.toLowerCase()}|${r.batch}`) ?? 0
            const left = r.received - r.rejected - planted
            return (
              <tr key={r.id} className="tap" onClick={() => setREdit(r)}>
                <td>{r.strain}</td><td>{r.batch}</td><td>{r.site}</td><td>{r.nursery ?? ''}</td><td className="nowrap">{fmtD(r.received_on)}</td>
                <td className="num">{n0(r.received)}</td><td className="num">{n0(r.rejected) || ''}</td><td className="num">{n0(planted)}</td>
                <td className={`num ${left < 0 ? 'neg' : ''}`}>{n0(left)}</td>
              </tr>
            )
          })}
          {!rs.length && <tr><td colSpan={9} className="muted">Nothing received for {d.year}.</td></tr>}</tbody>
        </table></div>
        <p className="cnote">Planted counts plants in the field plus counted losses for the same strain and batch. Negative left over usually means a batch number doesn't match between receiving and planting.</p>
      </>}

      {edit && <PlantingSheet d={d} c={c} p={edit} api={api} flash={flash} onClose={() => setEdit(null)} onSaved={async m => { setEdit(null); await onSaved(m) }} />}
      {rEdit && <ReceiptSheet d={d} r={rEdit} api={api} flash={flash} onClose={() => setREdit(null)} onSaved={async m => { setREdit(null); await onSaved(m) }} />}
    </>
  )
}

const fieldOpts = (fields: CField[], site: string | undefined, cur: number | null | undefined) =>
  fields.filter(f => f.site === site && (f.active || f.id === cur)).map(f => ({ v: f.id, l: `${f.code}  (${f.name})` }))

function PlantingSheet({ d, c, p, api, flash, onClose, onSaved }: { d: CultData; c: Ctx; p: Partial<Planting>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(p)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Planting>) => setX(o => ({ ...o, ...v }))
  const run = async (f: () => Promise<unknown>, m: string) => { setBusy(true); try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  const site = c.site.get(x.site ?? 'OHR')
  const autoAcres = x.plants && x.spacing_in ? plantingAcres({ ...x, acres: null } as Planting, site) : null
  return (
    <Sheet title={p.id ? p.strain : 'Add planting'} sub={p.id ? `${p.site} ${c.field.get(p.field_id ?? -1)?.code ?? ''} · planted ${fmtD(p.planted_on)}` : undefined} onClose={onClose} wide>
      <StrainList id="cult-strains" names={d.strains.map(s => s.name)} />
      <div className="grid2">
        <F label="Strain"><TextIn value={x.strain} list="cult-strains" autoFocus={!p.id} onChange={v => set({ strain: v ?? '' })} /></F>
        <F label="Site"><Choices value={x.site ?? 'OHR'} options={d.sites.map(s => ({ v: s.code, l: s.code }))} onChange={v => set({ site: v, field_id: null })} /></F>
        <F label="Field"><Pick value={x.field_id ?? null} blank="Pick a field…" options={fieldOpts(d.fields, x.site, x.field_id)} onChange={v => set({ field_id: v })} /></F>
        <F label="Source"><Choices value={x.source ?? 'clone'} options={SOURCES} onChange={v => set({ source: v })} /></F>
      </div>
      <div className="grid3">
        <F label="Planted on"><DateIn value={x.planted_on} onChange={v => set({ planted_on: v })} /></F>
        <F label="Batch"><NumIn value={x.batch} onChange={v => set({ batch: v })} /></F>
        <F label="Nursery"><TextIn value={x.nursery} list="cult-nurseries" onChange={v => set({ nursery: v })} /></F>
        <F label="Plants in field"><NumIn value={x.plants} onChange={v => set({ plants: v })} /></F>
        <F label="Plant loss"><NumIn value={x.plant_loss} onChange={v => set({ plant_loss: v })} /></F>
        <F label="Spacing" hint="inches"><NumIn value={x.spacing_in} onChange={v => set({ spacing_in: v })} /></F>
        <F label="Beds"><NumIn value={x.beds} onChange={v => set({ beds: v })} /></F>
        <F label="Acres" hint={autoAcres ? '(blank = from spacing)' : ''}><NumIn value={x.acres} placeholder={autoAcres ? n2(autoAcres) : ''} onChange={v => set({ acres: v })} /></F>
        <F label="Est. FF lbs / plant"><NumIn value={x.est_lbs_per_plant} onChange={v => set({ est_lbs_per_plant: v })} /></F>
        <F label="First flower"><DateIn value={x.first_flower} onChange={v => set({ first_flower: v })} /></F>
        <F label="License"><TextIn value={x.license} placeholder={site?.license ?? ''} onChange={v => set({ license: v })} /></F>
        {x.source !== 'clone' && <F label="Seed lbs"><NumIn value={x.seed_lbs} onChange={v => set({ seed_lbs: v })} /></F>}
      </div>
      <datalist id="cult-nurseries">{[...new Set(d.plantings.map(p => p.nursery).filter(Boolean))].map(n => <option key={n!} value={n!} />)}</datalist>
      <F label="Notes"><textarea value={x.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></F>
      {x.plants && x.est_lbs_per_plant ? <p className="cnote">Projected {n0(x.plants * x.est_lbs_per_plant)} lbs fresh frozen.</p> : null}
      <SaveBar busy={busy} disabled={!x.strain?.trim() || !x.site} onCancel={onClose}
        onSave={() => run(() => api.save('cult_plantings', { ...x, license: x.license ?? site?.license ?? null }), p.id ? 'Saved' : 'Planting added')}
        onDelete={p.id ? () => run(() => api.remove('cult_plantings', p.id!), 'Planting deleted') : undefined} />
    </Sheet>
  )
}

function ReceiptSheet({ d, r, api, flash, onClose, onSaved }: { d: CultData; r: Partial<Receipt>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(r)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Receipt>) => setX(o => ({ ...o, ...v }))
  const run = async (f: () => Promise<unknown>, m: string) => { setBusy(true); try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return (
    <Sheet title={r.id ? `${r.strain} received` : 'Plants received'} onClose={onClose}>
      <StrainList id="cult-strains" names={d.strains.map(s => s.name)} />
      <div className="grid2">
        <F label="Strain"><TextIn value={x.strain} list="cult-strains" autoFocus={!r.id} onChange={v => set({ strain: v ?? '' })} /></F>
        <F label="Site"><Choices value={x.site ?? 'OHR'} options={d.sites.map(s => ({ v: s.code, l: s.code }))} onChange={v => set({ site: v })} /></F>
        <F label="Received on"><DateIn value={x.received_on} onChange={v => set({ received_on: v })} /></F>
        <F label="Batch"><NumIn value={x.batch} onChange={v => set({ batch: v ?? 1 })} /></F>
        <F label="Plants received"><NumIn value={x.received} onChange={v => set({ received: v ?? 0 })} /></F>
        <F label="Rejected" hint="unplantable"><NumIn value={x.rejected} onChange={v => set({ rejected: v ?? 0 })} /></F>
        <F label="Nursery"><TextIn value={x.nursery} onChange={v => set({ nursery: v })} /></F>
        <F label="Source"><Choices value={x.source ?? 'clone'} options={SOURCES} onChange={v => set({ source: v })} /></F>
      </div>
      <F label="Notes"><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose} onSave={() => run(() => api.save('cult_receipts', x), 'Saved')}
        onDelete={r.id ? () => run(() => api.remove('cult_receipts', r.id!), 'Removed') : undefined} />
    </Sheet>
  )
}
