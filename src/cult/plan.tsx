import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CultApi } from './api'
import { acresFor, addDays, fmtD, n0, n1, n2, sum } from './calc'
import type { Ctx } from './calc'
import type { CultData, Demand, NurseryOrder, PlanData, PlanRow, Source } from './types'
import { Choices, DateIn, F, Kpis, NumIn, Pick, SaveBar, SelAll, SelBar, SelBox, SelButton, Sheet, StrainList, TextIn, errText, useSel } from './ui'
import type { Flash } from './ui'

const STATUSES: NurseryOrder['status'][] = ['planned', 'ordered', 'confirmed', 'received', 'cancelled']
const lc = (s: string) => s.toLowerCase()

export function PlanTab({ d, c, api, flash, q }: { d: CultData; c: Ctx; api: CultApi; flash: Flash; q: string }) {
  const [year, setYear] = useState(d.currentYear + 1)
  const [p, setP] = useState<PlanData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dEdit, setDEdit] = useState<Partial<Demand> | null>(null)
  const [pEdit, setPEdit] = useState<Partial<PlanRow> | null>(null)
  const [oEdit, setOEdit] = useState<Partial<NurseryOrder> | null>(null)
  const [busy, setBusy] = useState(false)
  const selD = useSel(), selP = useSel(), selO = useSel()
  const load = useCallback(() => api.loadPlan(year).then(x => { setP(x); setErr(null) }).catch(e => setErr(errText(e))), [api, year])
  useEffect(() => { setP(null); load() }, [load])
  const saved = async (m: string) => { setDEdit(null); setPEdit(null); setOEdit(null); await load(); flash(m) }

  // lbs per plant from history: the two most recent seasons before the plan year, weighted by plants
  const lppHist = useMemo(() => {
    const m = new Map<string, { plants: number; lbs: number; years: Set<number> }>()
    if (!p) return m
    const rows = [...p.history.map(h => ({ strain: h.strain, crop_year: h.crop_year, plants: h.plants ?? 0, ff_lbs: h.ff_lbs ?? 0 })), ...p.actuals]
    const yrs = [...new Set(rows.map(r => r.crop_year))].filter(y => y < year).sort((a, b) => b - a).slice(0, 2)
    for (const r of rows) {
      if (!yrs.includes(r.crop_year) || !r.plants || !r.ff_lbs) continue
      const x = m.get(lc(r.strain)) ?? m.set(lc(r.strain), { plants: 0, lbs: 0, years: new Set() }).get(lc(r.strain))!
      x.plants += r.plants; x.lbs += r.ff_lbs; x.years.add(r.crop_year)
    }
    return m
  }, [p, year])

  if (err) return <div className="warnbox">Couldn't load the plan: {err}</div>
  if (!p) return <p className="muted">Loading the {year} plan…</p>

  const ql = q.trim().toLowerCase()
  const planLpp = (r: Partial<PlanRow>) => r.est_lbs_per_plant ?? (r.strain ? (() => { const h = lppHist.get(lc(r.strain!)); return h ? h.lbs / h.plants : null })() : null)
  const strains = [...new Set([...p.demand.map(x => x.strain), ...p.plan.map(x => x.strain)].map(s => s))]
    .filter((s, i, a) => a.findIndex(t => lc(t) === lc(s)) === i).filter(s => !ql || lc(s).includes(ql)).sort((a, b) => a.localeCompare(b))
  const rows = strains.map(s => {
    const dem = p.demand.find(x => lc(x.strain) === lc(s))
    const pl = p.plan.filter(x => lc(x.strain) === lc(s))
    const h = lppHist.get(lc(s))
    const lpp = pl.find(x => x.est_lbs_per_plant != null)?.est_lbs_per_plant ?? (h ? h.lbs / h.plants : null)
    const need = dem?.lbs ?? 0
    const plantsNeeded = lpp && need ? Math.ceil((need / lpp) * 1.03) : null
    const planned = sum(pl.map(x => x.plants))
    const projected = sum(pl.map(x => x.plants * (planLpp(x) ?? 0)))
    return { s, dem, pl, h, lpp, need, plantsNeeded, planned, projected, delta: projected - need, reserve: p.reserves?.get(s) ?? null }
  })
  const bySite = d.sites.map(s => {
    const pl = p.plan.filter(x => x.site === s.code)
    const acres = sum(pl.map(x => acresFor(x.plants, x.spacing_in, s)))
    const avail = sum(d.fields.filter(f => f.site === s.code && f.active && f.kind !== 'biomass').map(f => f.acres))
    return { s, plants: sum(pl.map(x => Math.ceil(x.plants * (1 + x.overage_pct / 100)))), acres, avail }
  })

  const bulk = (f: () => Promise<unknown>, m: string) => async () => { try { await f(); await saved(m) } catch (e) { flash(errText(e), true) } }
  async function copyReserves() {
    if (!p?.reserves) return
    setBusy(true)
    try {
      const have = new Set(p.demand.map(x => lc(x.strain)))
      const add = [...p.reserves.entries()].filter(([s, lbs]) => lbs > 0 && !have.has(lc(s))).map(([strain, lbs]) => ({ crop_year: year, strain, lbs, notes: `From ${d.currentYear} reserves` }))
      await api.insertMany('cult_demand', add)
      await saved(add.length ? `Added ${add.length} strains from current reserves` : 'Every reserve strain is already on the list')
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  async function copyPlan(from: number) {
    setBusy(true)
    try {
      const prev = await api.loadPlan(from)
      await api.insertMany('cult_plan', prev.plan.map(({ id: _id, crop_year: _y, ...r }) => ({ ...r, crop_year: year, est_lbs_per_plant: null })))
      await saved(`Copied ${prev.plan.length} rows from the ${from} plan`)
    } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="row toolbar">
        <b>Plan for</b>
        <select value={year} onChange={e => setYear(Number(e.target.value))}>
          {[d.currentYear + 2, d.currentYear + 1, d.currentYear, d.currentYear - 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {p.reserves && <button className="ghost small" disabled={busy} onClick={copyReserves}>Add strains from current reserves</button>}
        {!p.plan.length && <button className="ghost small" disabled={busy} onClick={() => copyPlan(year - 1)}>Start from the {year - 1} plan</button>}
      </div>
      <Kpis items={[
        [n0(sum(rows.map(r => r.need))), 'lbs needed'], [n0(sum(rows.map(r => r.projected))), 'lbs projected'],
        ...bySite.map(x => [`${n0(x.plants)}`, `${x.s.code} plants to order (with overage)`] as [string, string]),
        ...bySite.map(x => [`${n1(x.acres)}${x.avail ? ` / ${n1(x.avail)}` : ''}`, `${x.s.code} acres planned${x.avail ? ' / flower fields' : ''}`] as [string, string]),
      ]} />

      <div className="row between"><h3 className="csec">By strain <span className="muted">what to grow for, and whether the plan covers it</span></h3>
        <div className="row"><SelButton sel={selD} /><button className="primary small" onClick={() => setDEdit({ crop_year: year, strain: '', lbs: 0 })}>+ Strain</button></div></div>
      <div className="cwrap"><table className="ctable">
        <thead><tr><SelAll sel={selD} ids={rows.map(r => r.dem?.id).filter((x): x is number => x != null)} /><th>Strain</th><th className="num">Lbs needed</th><th className="num">Lbs / plant</th><th className="num">Plants needed</th><th className="num">Planned</th>
          <th className="num">Projected lbs</th><th className="num">Short / over</th>{p.reserves && <th className="num hide-s">{d.currentYear} reserves</th>}<th /></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.s} className="tap" onClick={() => selD.on ? r.dem && selD.toggle(r.dem.id) : setDEdit(r.dem ?? { crop_year: year, strain: r.s, lbs: 0 })}>
            <SelBox sel={selD} id={r.dem?.id} /><td>{r.s}</td><td className="num">{r.need ? n0(r.need) : ''}</td>
            <td className="num" title={r.h ? `${[...r.h.years].sort().join(' + ')}: ${n0(r.h.lbs)} lbs from ${n0(r.h.plants)} plants` : 'no history'}>{n2(r.lpp)}{!r.lpp && <span className="warn-t">?</span>}</td>
            <td className="num">{n0(r.plantsNeeded)}</td><td className="num">{n0(r.planned) || ''}</td><td className="num">{n0(r.projected) || ''}</td>
            <td className={`num ${r.delta < 0 ? 'neg' : 'pos'}`}>{r.need || r.projected ? (r.delta > 0 ? '+' : '') + n0(r.delta) : ''}</td>
            {p.reserves && <td className="num hide-s">{n0(r.reserve)}</td>}
            <td onClick={e => e.stopPropagation()}>{r.plantsNeeded && r.planned < r.plantsNeeded / 1.03 &&
              <button className="ghost small" onClick={() => setPEdit({ crop_year: year, site: 'OHR', strain: r.s, plants: Math.ceil((r.plantsNeeded! / 1.03) - r.planned), overage_pct: 3, source: 'clone', trial: false, est_lbs_per_plant: null })}>Plan it</button>}</td>
          </tr>))}
        {!rows.length && <tr><td colSpan={10} className="muted">Nothing yet. Add strains with the lbs you want to grow for, or start from current reserves.</td></tr>}</tbody>
        {rows.length > 0 && <tfoot><tr className="tot">{selD.on && <td />}<td>Total</td><td className="num">{n0(sum(rows.map(r => r.need)))}</td><td /><td className="num">{n0(sum(rows.map(r => r.plantsNeeded)))}</td>
          <td className="num">{n0(sum(rows.map(r => r.planned)))}</td><td className="num">{n0(sum(rows.map(r => r.projected)))}</td><td className="num">{n0(sum(rows.map(r => r.delta)))}</td>{p.reserves && <td className="hide-s" />}<td /></tr></tfoot>}
      </table></div>
      <p className="cnote">Lbs / plant: what's set on the plan, otherwise the average from the last two seasons (hover for the numbers). Plants needed includes 3% overage.</p>

      <div className="row between"><h3 className="csec">Crop plan <span className="muted">{p.plan.length} rows</span></h3>
        <div className="row"><SelButton sel={selP} /><button className="primary small" onClick={() => setPEdit({ crop_year: year, site: 'OHR', strain: '', plants: 0, overage_pct: 3, source: 'clone', trial: false })}>+ Add to plan</button></div></div>
      {d.sites.map(s => {
        const pl = p.plan.filter(x => x.site === s.code && (!ql || lc(x.strain).includes(ql))).sort((a, b) => Number(a.trial) - Number(b.trial) || a.strain.localeCompare(b.strain))
        if (!pl.length) return null
        return (
          <div key={s.code} className="cwrap"><table className="ctable">
            <thead><tr><SelAll sel={selP} ids={pl.map(x => x.id)} /><th>{s.code}</th><th>Nursery</th><th className="num">Plants</th><th className="num">To order</th><th className="num hide-s">Spacing</th><th className="num">Acres</th>
              <th className="num">Lbs / pl</th><th className="num">Projected</th><th className="hide-s">Deliveries</th></tr></thead>
            <tbody>{pl.map(x => {
              const os = p.orders.filter(o => o.plan_id === x.id && o.status !== 'cancelled')
              return (
                <tr key={x.id} className="tap" onClick={() => selP.on ? selP.toggle(x.id) : setPEdit(x)}>
                  <SelBox sel={selP} id={x.id} /><td>{x.strain}{x.trial && <span className="kpill s-planned"> trial</span>}{x.field_id && <span className="fpill" style={{ marginLeft: 4 }}>{c.field.get(x.field_id)?.code}</span>}</td>
                  <td>{x.nursery ?? ''}{x.source !== 'clone' ? ` · ${x.source}` : ''}</td><td className="num">{n0(x.plants)}</td>
                  <td className="num">{n0(Math.ceil(x.plants * (1 + x.overage_pct / 100)))}</td><td className="num hide-s">{x.spacing_in ? `${x.spacing_in}"` : ''}</td>
                  <td className="num">{n2(acresFor(x.plants, x.spacing_in, s))}</td><td className="num">{n2(planLpp(x))}</td><td className="num">{n0(x.plants * (planLpp(x) ?? 0)) || ''}</td>
                  <td className="hide-s small">{os.map(o => `${n0(o.plants)} ${fmtD(o.deliver_on)}`).join(', ')}</td>
                </tr>
              )
            })}</tbody>
            <tfoot><tr className="tot"><td colSpan={selP.on ? 3 : 2}>Total</td><td className="num">{n0(sum(pl.map(x => x.plants)))}</td><td className="num">{n0(sum(pl.map(x => Math.ceil(x.plants * (1 + x.overage_pct / 100)))))}</td>
              <td className="hide-s" /><td className="num">{n1(sum(pl.map(x => acresFor(x.plants, x.spacing_in, s))))}</td><td /><td className="num">{n0(sum(pl.map(x => x.plants * (planLpp(x) ?? 0))))}</td><td className="hide-s" /></tr></tfoot>
          </table></div>
        )
      })}

      <div className="row between"><h3 className="csec">Nursery deliveries <span className="muted">{p.orders.filter(o => o.status !== 'cancelled').length} · {n0(sum(p.orders.filter(o => o.status !== 'cancelled').map(o => o.plants)))} plants</span></h3>
        <div className="row"><SelButton sel={selO} /><button className="primary small" onClick={() => setOEdit({ crop_year: year, site: 'OHR', strain: '', plants: 0, status: 'planned' })}>+ Delivery</button></div></div>
      <div className="cwrap"><table className="ctable">
        <thead><tr><SelAll sel={selO} ids={p.orders.filter(o => !ql || lc(o.strain).includes(ql)).map(o => o.id)} /><th>Delivery</th><th>Plant</th><th>Strain</th><th>Site</th><th>Nursery</th><th className="num">Plants</th><th>Status</th></tr></thead>
        <tbody>{p.orders.filter(o => !ql || lc(o.strain).includes(ql)).map(o => (
          <tr key={o.id} className={`tap ${o.status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => selO.on ? selO.toggle(o.id) : setOEdit(o)}>
            <SelBox sel={selO} id={o.id} /><td className="nowrap">{fmtD(o.deliver_on, true)}</td><td className="nowrap">{fmtD(o.plant_on, true)}</td><td>{o.strain}</td><td>{o.site}</td><td>{o.nursery ?? ''}</td>
            <td className="num">{n0(o.plants)}</td><td><span className={`kpill ${o.status === 'received' ? 's-done' : 's-planned'}`}>{o.status}</span></td></tr>))}
        {!p.orders.length && <tr><td colSpan={7} className="muted">No deliveries yet. Open a plan row to add its deliveries.</td></tr>}</tbody>
      </table></div>

      <SelBar sel={selD} noun="strain" actions={[{ label: 'Delete', danger: true, run: async ids => bulk(() => api.removeMany('cult_demand', ids), `Removed ${ids.length} from lbs needed`)() }]} />
      <SelBar sel={selP} noun="plan row" actions={[{ label: 'Delete', danger: true, run: async ids => bulk(() => api.removeMany('cult_plan', ids), `Removed ${ids.length} plan rows`)() }]} />
      <SelBar sel={selO} noun="delivery" actions={[
        ...(['ordered', 'confirmed', 'received'] as const).map(st => ({ label: `Mark ${st}`, run: async (ids: number[]) => bulk(() => api.updateMany('cult_nursery_orders', ids, { status: st }), `${ids.length} marked ${st}`)() })),
        { label: 'Delete', danger: true, run: async ids => bulk(() => api.removeMany('cult_nursery_orders', ids), `Removed ${ids.length} deliveries`)() }]} />
      {dEdit && <DemandSheet d={d} x={dEdit} hist={dEdit.strain ? lppHist.get(lc(dEdit.strain)) : undefined} reserve={dEdit.strain ? p.reserves?.get(dEdit.strain) ?? null : null}
        api={api} flash={flash} onClose={() => setDEdit(null)} onSaved={saved} />}
      {pEdit && <PlanSheet d={d} c={c} x={pEdit} lpp={planLpp({ ...pEdit, est_lbs_per_plant: null })} orders={p.orders.filter(o => pEdit.id != null && o.plan_id === pEdit.id)}
        api={api} flash={flash} onClose={() => setPEdit(null)} onSaved={saved} onOrder={o => { setPEdit(null); setOEdit(o) }} />}
      {oEdit && <OrderSheet d={d} x={oEdit} api={api} flash={flash} onClose={() => setOEdit(null)} onSaved={saved} />}
    </>
  )
}

function DemandSheet({ d, x: x0, hist, reserve, api, flash, onClose, onSaved }: { d: CultData; x: Partial<Demand>; hist?: { plants: number; lbs: number; years: Set<number> }; reserve: number | null
  api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(x0)
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<unknown>, m: string) => { setBusy(true); try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return (
    <Sheet title={x0.id ? x0.strain : x0.strain || 'Strain to grow'} sub={`${x0.crop_year} plan`} onClose={onClose}>
      <StrainList id="cult-strains" names={d.strains.map(s => s.name)} />
      <F label="Strain"><TextIn value={x.strain} list="cult-strains" autoFocus={!x0.strain} onChange={v => setX({ ...x, strain: v ?? '' })} /></F>
      <F label="Fresh frozen lbs to grow for" hint={reserve ? `(current reserves ${n0(reserve)})` : ''}><NumIn value={x.lbs} onChange={v => setX({ ...x, lbs: v ?? 0 })} /></F>
      <F label="Notes"><TextIn value={x.notes} onChange={v => setX({ ...x, notes: v })} /></F>
      {hist && <p className="cnote">History: {n0(hist.lbs)} lbs from {n0(hist.plants)} plants ({[...hist.years].sort().join(', ')}) = {n2(hist.lbs / hist.plants)} lbs/plant.</p>}
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose} onSave={() => run(() => api.save('cult_demand', x), 'Saved')}
        onDelete={x0.id ? () => run(() => api.remove('cult_demand', x0.id!), 'Removed') : undefined} />
    </Sheet>
  )
}

function PlanSheet({ d, c, x: x0, lpp, orders, api, flash, onClose, onSaved, onOrder }: { d: CultData; c: Ctx; x: Partial<PlanRow>; lpp: number | null; orders: NurseryOrder[]
  api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void>; onOrder: (o: Partial<NurseryOrder>) => void }) {
  const [x, setX] = useState(x0)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<PlanRow>) => setX(o => ({ ...o, ...v }))
  const run = async (f: () => Promise<unknown>, m: string) => { setBusy(true); try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  const s = c.site.get(x.site ?? 'OHR')
  const toOrder = Math.ceil((x.plants ?? 0) * (1 + (x.overage_pct ?? 3) / 100))
  const ordered = sum(orders.filter(o => o.status !== 'cancelled').map(o => o.plants))
  const use = x.est_lbs_per_plant ?? lpp
  return (
    <Sheet title={x0.id ? x0.strain : 'Add to plan'} sub={`${x0.crop_year} plan`} onClose={onClose} wide>
      <StrainList id="cult-strains" names={d.strains.map(t => t.name)} />
      <div className="grid2">
        <F label="Strain"><TextIn value={x.strain} list="cult-strains" autoFocus={!x0.strain} onChange={v => set({ strain: v ?? '' })} /></F>
        <F label="Site"><Choices value={x.site ?? 'OHR'} options={d.sites.map(t => ({ v: t.code, l: t.code }))} onChange={v => set({ site: v, field_id: null })} /></F>
      </div>
      <div className="grid3">
        <F label="Plants"><NumIn value={x.plants} onChange={v => set({ plants: v ?? 0 })} /></F>
        <F label="Overage %"><NumIn value={x.overage_pct} onChange={v => set({ overage_pct: v ?? 0 })} /></F>
        <F label="Spacing" hint="inches"><NumIn value={x.spacing_in} onChange={v => set({ spacing_in: v })} /></F>
        <F label="Nursery"><TextIn value={x.nursery} onChange={v => set({ nursery: v })} /></F>
        <F label="Source"><Pick value={x.source ?? 'clone'} onChange={v => set({ source: (v ?? 'clone') as Source })} options={[{ v: 'clone', l: 'Clone' }, { v: 'seed', l: 'Seed' }, { v: 'auto', l: 'Auto' }]} /></F>
        <F label="Lbs / plant" hint={lpp ? `(history ${n2(lpp)})` : ''}><NumIn value={x.est_lbs_per_plant} placeholder={lpp ? n2(lpp) : ''} onChange={v => set({ est_lbs_per_plant: v })} /></F>
        <F label="Field" hint="(optional)"><Pick value={x.field_id ?? null} blank="Not set" onChange={v => set({ field_id: v })}
          options={d.fields.filter(f => f.site === x.site && f.active).map(f => ({ v: f.id, l: `${f.code} (${f.name})` }))} /></F>
        <F label="Trial"><Choices value={x.trial ? 'y' : 'n'} options={[{ v: 'n', l: 'No' }, { v: 'y', l: 'Trial' }]} onChange={v => set({ trial: v === 'y' })} /></F>
      </div>
      <div className="calcbox"><span>Plants to order</span><b>{n0(toOrder)}</b><span>Acres</span><b>{n2(acresFor(x.plants ?? 0, x.spacing_in ?? null, s))}</b>
        <span>Projected</span><b>{use ? `${n0((x.plants ?? 0) * use)} lbs FF` : 'set lbs/plant'}</b><span>On deliveries</span><b>{n0(ordered)} of {n0(toOrder)}</b></div>
      <F label="Notes"><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      {x0.id != null && <div className="row">
        <button className="ghost small" onClick={() => onOrder({ crop_year: x0.crop_year, plan_id: x0.id, site: x.site, strain: x.strain, nursery: x.nursery, plants: Math.max(0, toOrder - ordered), status: 'planned' })}>+ Delivery for this</button>
        {orders.map(o => <a key={o.id} onClick={() => onOrder(o)}>{n0(o.plants)} on {fmtD(o.deliver_on) || '?'}</a>)}
      </div>}
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose} onSave={() => run(() => api.save('cult_plan', x), x0.id ? 'Saved' : 'Added to plan')}
        onDelete={x0.id ? () => run(() => api.remove('cult_plan', x0.id!), 'Removed from plan') : undefined} />
    </Sheet>
  )
}

function OrderSheet({ d, x: x0, api, flash, onClose, onSaved }: { d: CultData; x: Partial<NurseryOrder>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(x0)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<NurseryOrder>) => setX(o => ({ ...o, ...v }))
  const run = async (f: () => Promise<unknown>, m: string) => { setBusy(true); try { await f(); await onSaved(m) } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return (
    <Sheet title={x0.id ? `${x0.strain} delivery` : 'Nursery delivery'} sub={`${x0.crop_year} plan`} onClose={onClose}>
      <StrainList id="cult-strains" names={d.strains.map(t => t.name)} />
      <div className="grid2">
        <F label="Strain"><TextIn value={x.strain} list="cult-strains" onChange={v => set({ strain: v ?? '' })} /></F>
        <F label="Site"><Choices value={x.site ?? 'OHR'} options={d.sites.map(t => ({ v: t.code, l: t.code }))} onChange={v => set({ site: v })} /></F>
        <F label="Nursery"><TextIn value={x.nursery} onChange={v => set({ nursery: v })} /></F>
        <F label="Plants"><NumIn value={x.plants} onChange={v => set({ plants: v ?? 0 })} /></F>
        <F label="Cut date"><DateIn value={x.cut_on} onChange={v => set({ cut_on: v })} /></F>
        <F label="Delivery"><DateIn value={x.deliver_on} onChange={v => set({ deliver_on: v, plant_on: x.plant_on ?? (v ? addDays(v, 5) : null) })} /></F>
        <F label="Plant date"><DateIn value={x.plant_on} onChange={v => set({ plant_on: v })} /></F>
        <F label="Status"><Pick value={x.status ?? 'planned'} onChange={v => set({ status: v ?? 'planned' })} options={STATUSES.map(s => ({ v: s, l: s[0].toUpperCase() + s.slice(1) }))} /></F>
      </div>
      <F label="Notes"><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose} onSave={() => run(() => api.save('cult_nursery_orders', x), 'Saved')}
        onDelete={x0.id ? () => run(() => api.remove('cult_nursery_orders', x0.id!), 'Removed') : undefined} />
    </Sheet>
  )
}
