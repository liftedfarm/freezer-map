import { Fragment, useState } from 'react'
import { TagInput } from '../taginput'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { GEN_LABEL, GEN_WHAT, fmtD, live, n0, strainKey, sum, today } from './calc'
import type { Mother, NData } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, SelAll, SelBar, SelBox, SelButton, Sheet, StrainList, TextIn, useSel } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { t, tn } from '../i18n'

const where = (c: NCtx, m: Mother) => [c.room(m.room_id), m.bed].filter(Boolean).join(' · ')
const nextSeason = () => { const d = new Date(); return d.getFullYear() + (d.getMonth() >= 6 ? 1 : 0) }

/** Nursery > Mothers: mother lots (one METRC tag, a count) by generation */
export function MothersTab({ d, c, q, api, flash, onSaved, onOpen, onAdd }: {
  d: NData; c: NCtx; q: string; api: NurseryApi; flash: Flash; onSaved: (m: string) => Promise<void>; onOpen: (m: Mother) => void; onAdd: (v?: Partial<Mother>) => void
}) {
  const [f, setF] = useState<'active' | 'gone' | 'all'>('active')
  const [gen, setGen] = useState<0 | 1 | 2 | 3>(0)
  const sel = useSel()
  const ql = q.trim().toLowerCase()
  const rows = d.mothers.filter(m => (f === 'all' || (f === 'active' ? m.status === 'active' : m.status !== 'active')) && (!gen || m.gen === gen) &&
    (!ql || `${m.strain} ${m.plant_tag ?? ''} ${c.room(m.room_id)} ${m.notes ?? ''}`.toLowerCase().includes(ql)))
    .sort((a, b) => a.gen - b.gen || a.strain.localeCompare(b.strain) || (a.room_id ?? 0) - (b.room_id ?? 0))
  const groups = new Map<string, Mother[]>()
  for (const m of rows) { const k = `${m.gen}|${strainKey(m.strain)}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(m) }
  const active = d.mothers.filter(m => m.status === 'active')
  const byGen = (g: number) => sum(active.filter(m => m.gen === g).map(live))
  const bulk = (v: Partial<Mother>, msg: string) => async (ids: number[]) => {
    try { await api.updateMany('nursery_mothers', ids, v); await onSaved(`${ids.length} ${t(msg)}`) } catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  return <>
    <div className="row toolbar between">
      <div className="row wrap">
        <div className="seg">{([[0, `${t('All')} (${n0(sum(active.map(live)))})`], [1, `G1 (${n0(byGen(1))})`], [2, `G2 (${n0(byGen(2))})`], [3, `G3 (${n0(byGen(3))})`]] as const)
          .map(([k, l]) => <button key={k} className={gen === k ? 'on' : ''} onClick={() => setGen(k)}>{l}</button>)}</div>
        <div className="seg">{([['active', 'Active'], ['gone', 'Retired / destroyed'], ['all', 'All']] as const).map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{t(l)}</button>)}</div>
      </div>
      <div className="row"><SelButton sel={sel} /><button className="primary" onClick={() => onAdd(gen ? { gen } : undefined)}>{t('+ Mother lot')}</button></div>
    </div>
    <p className="muted small-note">{t('A lot is one METRC tag with a count of plants, by strain, generation and location (a bench, or a hoop and bed). G3 lots usually come from planting out a G3 batch.')}</p>
    {!rows.length ? <p className="muted">{t('No mother lots here yet.')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><SelAll sel={sel} ids={rows.map(m => m.id)} /><th>{t('Location')}</th><th className="num">{t('Plants')}</th><th>{t('METRC tag')}</th><th>{t('Planted')}</th><th className="num hide-s">{t('Cuts/plant')}</th><th className="hide-s">{t('Season')}</th><th>{t('Status')}</th></tr></thead>
      <tbody>{[...groups.values()].map(ms => <Fragment key={`${ms[0].gen}${ms[0].strain}`}>
        <tr className="wk"><td colSpan={sel.on ? 8 : 7}><span className="row between"><span><span className={`gpill g${ms[0].gen}`}>{GEN_LABEL[ms[0].gen]}</span> {ms[0].strain} · {tn(sum(ms.map(live)), '{n} plant', '{n} plants')} {t('in')} {tn(ms.length, '{n} lot', '{n} lots')}</span>
          <button className="linkbtn" onClick={() => onAdd({ strain: ms[0].strain, gen: ms[0].gen, season: ms[0].season })}>{t('+ lot')}</button></span></td></tr>
        {ms.map(m => <tr key={m.id} className={`tap ${m.status !== 'active' ? 'done' : ''}`} onClick={() => sel.on ? sel.toggle(m.id) : onOpen(m)}>
          <SelBox sel={sel} id={m.id} /><td>{where(c, m) || <span className="muted">—</span>}{m.source && m.source !== 'Internal' ? <span className="muted small"> · {m.source}</span> : ''}</td>
          <td className="num">{n0(live(m) || m.qty)}{m.lost ? <span className="muted"> ({t('{n} lost', { n: n0(m.lost) })})</span> : ''}</td>
          <td className="small">{m.plant_tag ? m.plant_tag.slice(-10) : <span className="warn-t">{t('no tag')}</span>}</td>
          <td className="nowrap">{fmtD(m.started_on)}</td><td className="num hide-s">{m.cuts_per_plant ?? ''}</td><td className="hide-s">{m.season ?? ''}</td>
          <td>{m.status === 'active' ? t('Active') : `${t(m.status === 'retired' ? 'Retired' : 'Destroyed')} ${fmtD(m.ended_on)}`}</td></tr>)}
      </Fragment>)}</tbody>
    </table></div>}
    <SelBar sel={sel} noun={t('lot')} actions={[
      { label: t('Retire'), run: bulk({ status: 'retired', ended_on: today() }, 'retired') },
      { label: t('Destroyed'), danger: true, run: bulk({ status: 'destroyed', ended_on: today() }, 'marked destroyed') },
    ]} />
  </>
}

/** add or change a mother lot */
export function MotherSheet({ d, c, m: m0, api, flash, onClose, onSaved }: { d: NData; c: NCtx; m: Partial<Mother>; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const isNew = !m0.id
  const site = d.sites[0]?.code ?? '1PN'
  const [x, setX] = useState<Partial<Mother>>(() => ({ site, gen: 2, qty: 1, lost: 0, status: 'active', started_on: today(), season: nextSeason(), ...m0 }))
  const [busy, setBusy] = useState(false)
  const [loss, setLoss] = useState<number | null>(null)
  const set = (v: Partial<Mother>) => setX(s => ({ ...s, ...v }))
  const room = d.rooms.find(r => r.id === x.room_id)
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); onClose(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e).replace(/duplicate key.*plant_tag.*/, t('That tag is already on another mother lot')), true) } finally { setBusy(false) }
  }
  const fillTag = async () => { const tag = (await api.nextTags(x.site ?? site, 1))[0]; if (tag) set({ plant_tag: tag }); else flash(t('No plant tags loaded for this nursery yet.'), true) }
  const locs = d.rooms.filter(r => (r.active || r.id === x.room_id) && r.kind !== 'trailer')
  return (
    <Sheet title={isNew ? t('New mother lot') : `${m0.strain} · ${GEN_LABEL[m0.gen ?? 2]}`} sub={isNew ? t('One METRC tag, a count of plants') : `${where(c, m0 as Mother) || t('no location')} · ${t('{n} plants', { n: n0(live(m0 as Mother)) })}`} onClose={onClose}>
      <F label={t('Strain')}><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} autoFocus={isNew && !m0.strain} /></F>
      <StrainList id="n-strains" names={d.strains} />
      <datalist id="n-sources">{['Internal', 'TC', 'HVN', 'Seed', 'Pheno hunt'].map(v => <option key={v} value={v} />)}</datalist>
      <div className="grid3">
        <F label={t('Generation')}><Pick value={x.gen} options={[1, 2, 3].map(g => ({ v: g as 1 | 2 | 3, l: t(GEN_WHAT[g]) }))} onChange={v => set({ gen: v ?? 2 })} /></F>
        <F label={t('For season')} hint={t('(crop year)')}><NumIn value={x.season} onChange={v => set({ season: v })} /></F>
        <F label={t('Plants')}><NumIn value={x.qty} onChange={v => set({ qty: v ?? 0 })} /></F>
        <F label={t('Location')}><Pick value={x.room_id} blank="—" options={locs.map(r => ({ v: r.id, l: `${r.name}${r.place !== 'Webb' ? ` (${r.place})` : ''}` }))} onChange={v => set({ room_id: v, bed: null })} /></F>
        {room?.kind === 'hoop' ? <F label={t('Bed')}><Pick value={x.bed} blank="—" options={(room.beds.length ? room.beds.map(b => b.bed) : ['A', 'B', 'C']).map(b => ({ v: b, l: b }))} onChange={v => set({ bed: v })} /></F>
          : <F label={t('Pot')}><TextIn value={x.pot} placeholder='4", 1G, 10L' onChange={v => set({ pot: v })} /></F>}
        <F label={t('Planted')}><DateIn value={x.started_on} onChange={v => set({ started_on: v })} /></F>
        <F label={t('Source')}><TextIn value={x.source} list="n-sources" onChange={v => set({ source: v })} placeholder={t('Internal, TC, HVN, seed')} /></F>
        <F label={t('Cuts per plant')} hint={t('(estimate)')}><NumIn value={x.cuts_per_plant} onChange={v => set({ cuts_per_plant: v })} /></F>
        <F label={t('Status')}><Pick value={x.status} options={[{ v: 'active', l: t('Active') }, { v: 'retired', l: t('Retired') }, { v: 'destroyed', l: t('Destroyed') }]}
          onChange={v => set({ status: v ?? 'active', ended_on: v && v !== 'active' ? x.ended_on ?? today() : null })} /></F>
        {x.status !== 'active' && <F label={t('Since')}><DateIn value={x.ended_on} onChange={v => set({ ended_on: v })} /></F>}
      </div>
      <F label={t('METRC plant tag')}><div className="row"><TagInput value={x.plant_tag ?? ''} onChange={v => set({ plant_tag: v || null })} where={{ site: x.site ?? site, type: 'plant' }} keep={m0.plant_tag ?? null} disabled={busy} />
        <button type="button" className="ghost small" onClick={fillTag} disabled={busy}>{t('Next tag')}</button></div></F>
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      {!isNew && m0.status === 'active' && <div className="row lossrow">
        <span className="muted">{m0.lost ? t('{n} lost so far.', { n: n0(m0.lost) }) : t('Plants died or culled?')}</span>
        <NumIn value={loss} onChange={setLoss} placeholder={t('How many')} />
        <button className="ghost small" disabled={busy || !loss || loss > live(m0 as Mother)} onClick={() => run(() => api.save<Mother>('nursery_mothers', { id: m0.id, lost: (m0.lost ?? 0) + loss! }), t('{n} lost', { n: n0(loss) }))}>{t('Record loss')}</button>
      </div>}
      <SaveBar busy={busy} disabled={!x.strain?.trim() || !(Number(x.qty) > 0)} saveLabel={isNew ? 'Add lot' : 'Save'} onCancel={onClose}
        onSave={() => run(() => api.save<Mother>('nursery_mothers', { id: x.id, site: x.site ?? site, strain: x.strain!.trim(), gen: x.gen, season: x.season, qty: x.qty, room_id: x.room_id ?? null,
          bed: x.bed ?? null, pot: x.pot ?? null, source: x.source ?? null, plant_tag: x.plant_tag || null, started_on: x.started_on ?? null, cuts_per_plant: x.cuts_per_plant ?? null,
          status: x.status, ended_on: x.ended_on ?? null, notes: x.notes ?? null }), isNew ? t('{strain} {gen} lot added', { strain: x.strain, gen: GEN_LABEL[x.gen ?? 2] }) : t('Saved'))}
        onDelete={!isNew ? () => run(() => api.remove('nursery_mothers', m0.id!), t('Removed (entered by mistake)')) : undefined} />
    </Sheet>
  )
}
