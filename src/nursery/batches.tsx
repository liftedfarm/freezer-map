import { useEffect, useState } from 'react'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { GEN_LABEL, GEN_WHAT, STAGE_LABEL, addDays, batchName, daysBetween, fmtD, live, n0, rooted, strainKey, tagsNeeded, today } from './calc'
import type { Batch, NData, Stage } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { ScanButton } from '../scan'
import { t } from '../i18n'

const stagePill = (b: Batch) => {
  const late = b.stage === 'rooting' && b.ready_on && b.ready_on < today()
  return <span className={`pill ${b.stage === 'ready' ? 'okp' : late ? 'warnp' : ''}`}>{late ? t('Rooting (past ready date)') : t(STAGE_LABEL[b.stage])}</span>
}
const pct = (x: number | null) => (x == null ? '' : `${Math.round(x * 100)}%`)
export const success = (b: Batch) => { const r = rooted(b); return r == null || !b.cuttings ? null : r / b.cuttings }

/** Nursery > Batches: cuttings taken, rooting, sorts, ready, out the door (or into the hoops as moms) */
export function BatchesTab({ d, c, q, onOpen, onNew, onSortDay }: { d: NData; c: NCtx; q: string; onOpen: (b: Batch) => void; onNew: () => void; onSortDay: () => void }) {
  const [f, setF] = useState<'live' | Stage | 'all'>('live')
  const [gen, setGen] = useState<0 | 1 | 2 | 3 | 4>(0)
  const ql = q.trim().toLowerCase()
  const rows = d.batches.filter(b => (f === 'all' || (f === 'live' ? b.stage === 'rooting' || b.stage === 'ready' : b.stage === f)) && (!gen || b.gen === gen) &&
    (!ql || `${b.strain} ${b.name ?? ''} ${b.tags.join(' ')} ${b.notes ?? ''}`.toLowerCase().includes(ql)))
  const n = (s: Stage) => d.batches.filter(b => b.stage === s).length
  return <>
    <div className="row toolbar between">
      <div className="row wrap">
        <div className="seg">{([['live', t('In the nursery ({n})', { n: n('rooting') + n('ready') })], ['rooting', t('Rooting')], ['ready', t('Ready')], ['done', t('Done')], ['all', t('All')]] as const)
          .map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
        <div className="seg">{([0, 4, 3, 2, 1] as const).map(g => <button key={g} className={gen === g ? 'on' : ''} onClick={() => setGen(g)}>{g ? GEN_LABEL[g] : t('All gens')}</button>)}</div>
      </div>
      <div className="row"><button className="ghost" onClick={onSortDay}>{t('Sort day')}</button><button className="primary" onClick={onNew}>{t('+ Cuttings taken')}</button></div>
    </div>
    {!rows.length ? <p className="muted">{t('No batches here. When cuttings are taken, add them with "Cuttings taken".')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>{t('Cut')}</th><th>{t('Gen')}</th><th>{t('Strain')}</th><th className="num">{t('Cuttings')}</th><th className="num hide-s">{t('Trays')}</th><th className="num">{t('Rooted')}</th><th className="num">{t('Left')}</th><th>{t('Ready')}</th><th className="hide-s">{t('Where / for')}</th><th>{t('Stage')}</th><th className="hide-s">{t('Tags')}</th></tr></thead>
      <tbody>{rows.map(b => {
        const o = b.order_id ? d.orders.find(x => x.id === b.order_id) : undefined, s = success(b)
        return <tr key={b.id} className={`tap ${b.stage === 'done' ? 'done' : b.stage === 'cancelled' ? 'cancelled' : ''}`} onClick={() => onOpen(b)}>
          <td className="nowrap">{fmtD(b.cut_on)}</td><td><span className={`gpill g${b.gen}`}>{GEN_LABEL[b.gen]}</span></td><td>{b.strain}</td>
          <td className="num">{n0(b.cuttings)}</td><td className="num hide-s">{b.trays ?? ''}</td>
          <td className="num">{s == null ? '' : <span className={s < 0.85 ? 'warn-t' : ''}>{pct(s)}</span>}</td><td className="num"><b>{n0(c.left(b))}</b></td>
          <td className="nowrap">{fmtD(b.ready_on)}</td><td className="hide-s small">{[c.room(b.room_id), o ? `${c.to(o)} ${fmtD(o.deliver_on)}` : ''].filter(Boolean).join(' · ')}</td><td>{stagePill(b)}</td>
          <td className="hide-s">{b.tags.length ? b.tags.length : <span className="warn-t">{t('none')}</span>}</td>
        </tr>
      })}</tbody>
    </table></div>}
  </>
}

const nextSeason = (gen: number, cut: string) => { const y = Number(cut.slice(0, 4)), m = Number(cut.slice(5, 7)); return gen === 4 || gen === 3 ? y + (gen === 3 && m >= 7 ? 1 : 0) : y + (m >= 6 ? 1 : 0) }

export function BatchSheet({ d, c, b: b0, api, flash, onClose, onSaved }: { d: NData; c: NCtx; b: Partial<Batch>; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const isNew = !b0.id
  const site = b0.site ?? d.sites[0]?.code ?? '1PN'
  const tray = d.settings.tray || 72
  const [x, setX] = useState<Partial<Batch>>(() => ({ site, cut_on: today(), tags: [], lost: 0, gen: 4,
    room_id: isNew ? d.rooms.find(r => r.active && r.kind === 'trailer')?.id ?? null : null, ...b0 }))
  const [tagText, setTagText] = useState((b0.tags ?? []).join('\n'))
  const [pkgTags, setPkgTags] = useState<string[]>([])
  // clone package tag: suggestions from METRC's available package tags, filled in for a new batch when autofill is on
  useEffect(() => {
    let on = true
    Promise.all([api.nextTags(x.site ?? site, 20, 'package'), api.tagAutofill()]).then(([p, auto]) => {
      if (!on) return
      setPkgTags(p)
      if (auto && isNew && !x.package_tag && p[0]) set({ package_tag: p[0] })
    })
    return () => { on = false }
  }, [x.site])
  const [busy, setBusy] = useState(false)
  const [good, setGood] = useState<number | null>(null)
  const [mode, setMode] = useState<'edit' | 'ready' | 'loss' | 'plant'>('edit')
  const [loss, setLoss] = useState<number | null>(null)
  const set = (v: Partial<Batch>) => setX(s => ({ ...s, ...v }))
  const tags = tagText.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
  const delivered = b0.id ? c.fromBatch.get(b0.id) ?? 0 : 0
  const autoName = x.strain && x.cut_on ? batchName(x.site ?? site, x.cut_on, x.strain) + (x.gen && x.gen < 4 ? `-G${x.gen}` : '') : ''
  const gen = x.gen ?? 4
  const orders = d.orders.filter(o => c.isOpen(o) && (!x.strain || strainKey(o.strain) === strainKey(x.strain)))
  const moms = d.mothers.filter(m => m.status === 'active' && (!x.strain || strainKey(m.strain) === strainKey(x.strain)) && (gen === 1 || m.gen === gen - 1))
  const r = rooted({ ...(b0 as Batch), ...(x as Batch) })
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); onClose(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const fillTags = async () => {
    const need = tagsNeeded(x.cuttings ?? 1) - tags.length
    if (need <= 0) return
    const pool = (await api.nextTags(x.site ?? site, need + 20)).filter(t => !tags.includes(t)).slice(0, need)
    if (!pool.length) { flash(t('No plant tags loaded for this nursery yet (Admin → Settings → Licenses).'), true); return }
    setTagText([...tags, ...pool].join('\n'))
  }
  const save = () => run(() => api.save<Batch>('nursery_batches', {
    id: x.id, site: x.site ?? site, room_id: x.room_id ?? null, strain: x.strain!.trim(), name: (x.name ?? '').trim() || autoName || null, order_id: gen === 4 ? x.order_id ?? null : null,
    cut_on: x.cut_on!, cuttings: x.cuttings!, lost: x.lost ?? 0, ready_on: x.ready_on ?? (x.cut_on ? addDays(x.cut_on, d.settings.rootDays) : null), stage: x.stage ?? 'rooting', tags, package_tag: (x.package_tag ?? '').trim().toUpperCase() || null, notes: x.notes ?? null,
    gen, season: x.season ?? (x.cut_on ? nextSeason(gen, x.cut_on) : null), mother_id: x.mother_id ?? null, trays: x.trays ?? (x.cuttings ? Math.round(x.cuttings / tray * 10) / 10 : null),
    emerged_on: x.emerged_on ?? null, moved_out_on: x.moved_out_on ?? null,
    sort1_on: x.sort1_on ?? null, s1_vigorous: x.s1_vigorous ?? null, s1_minimal: x.s1_minimal ?? null, s1_none: x.s1_none ?? null, s1_dead: x.s1_dead ?? null,
    sort2_on: x.sort2_on ?? null, s2_vigorous: x.s2_vigorous ?? null, s2_minimal: x.s2_minimal ?? null, s2_none: x.s2_none ?? null, s2_dead: x.s2_dead ?? null,
  }), isNew ? t('{n} {strain} {gen} cuttings added', { n: n0(x.cuttings), strain: x.strain, gen: GEN_LABEL[gen] }) : t('Saved'))

  if (mode === 'ready' && b0.id) return (
    <Sheet title={`${b0.strain}: ${t('ready')}`} sub={`${b0.name ?? ''} · ${t('{n} cut {date}', { n: n0(b0.cuttings), date: fmtD(b0.cut_on) })}`} onClose={() => setMode('edit')}>
      <F label={t('Good plants (rooted, ready to go)')}><NumIn value={good} onChange={setGood} autoFocus /></F>
      <p className="muted small-note">{t('The rest ({n}) count as lost.', { n: n0(Math.max(0, b0.cuttings! - delivered - (good ?? 0))) })}{r != null ? ' ' + t('The sorts say {n} rooted.', { n: n0(r) }) : ''}</p>
      <SaveBar busy={busy} disabled={good == null || good < 0 || good > b0.cuttings! - delivered} saveLabel={t('Mark ready')} onCancel={() => setMode('edit')}
        onSave={() => run(() => api.save<Batch>('nursery_batches', { id: b0.id, stage: 'ready', ready_on: today(), lost: b0.cuttings! - delivered - good! }), t('{n} {strain} ready', { n: n0(good), strain: b0.strain }))} />
    </Sheet>
  )
  if (mode === 'loss' && b0.id) return (
    <Sheet title={`${b0.strain}: ${t('losses')}`} sub={t('{n} left in {batch}', { n: n0(c.left(b0 as Batch)), batch: b0.name ?? t('this batch') })} onClose={() => setMode('edit')}>
      <F label={t('Plants lost (died, culled)')}><NumIn value={loss} onChange={setLoss} autoFocus /></F>
      <SaveBar busy={busy} disabled={!loss || loss < 0 || loss > c.left(b0 as Batch)} saveLabel={t('Record loss')} onCancel={() => setMode('edit')}
        onSave={() => run(() => api.save<Batch>('nursery_batches', { id: b0.id, lost: (b0.lost ?? 0) + loss!, ...(loss === c.left(b0 as Batch) ? { stage: delivered ? 'done' : 'cancelled' } : {}) }), t('{n} lost', { n: n0(loss) }))} />
    </Sheet>
  )
  if (mode === 'plant' && b0.id) return <PlantMoms d={d} c={c} b={b0 as Batch} api={api} flash={flash} onBack={() => setMode('edit')} onDone={async m => { onClose(); await onSaved(m) }} />

  const sortRow = (n: 1 | 2) => {
    const k = (f: string) => `s${n}_${f}` as keyof Batch
    return <div className="sortrow">
      <F label={t('Sort {n}', { n })}><DateIn value={x[`sort${n}_on` as keyof Batch] as string | null} onChange={v => set({ [`sort${n}_on`]: v } as Partial<Batch>)} /></F>
      {(['vigorous', 'minimal', 'none', 'dead'] as const).map(f => <F key={f} label={t(f === 'none' ? 'No roots' : f === 'dead' ? 'Dead / contam.' : f === 'vigorous' ? 'Vigorous' : 'Minimal')}>
        <NumIn value={x[k(f)] as number | null} onChange={v => set({ [k(f)]: v } as Partial<Batch>)} /></F>)}
    </div>
  }
  return (
    <Sheet title={isNew ? t('Cuttings taken') : t('{strain} · {gen} batch', { strain: b0.strain, gen: GEN_LABEL[b0.gen ?? 4] })} sub={isNew ? t('One batch per strain per cut day') : `${b0.name ?? ''} · ${t('{n} left', { n: n0(c.left(b0 as Batch)) })} · ${t(STAGE_LABEL[b0.stage ?? 'rooting'])}`} onClose={onClose} wide>
      {!isNew && (b0.stage === 'rooting' || b0.stage === 'ready') && <div className="row wrap docact">
        {b0.stage === 'rooting' && <button className="primary" disabled={busy} onClick={() => { setGood(r ?? c.left(b0 as Batch)); setMode('ready') }}>{t('Mark ready…')}</button>}
        {(b0.gen ?? 4) < 4 && <button className="primary" disabled={busy} onClick={() => setMode('plant')}>{t('Plant as {gen} moms…', { gen: GEN_LABEL[b0.gen!] })}</button>}
        <button className="ghost" disabled={busy} onClick={() => setMode('loss')}>{t('Record losses…')}</button>
        {b0.stage === 'ready' && <button className="ghost" disabled={busy} onClick={() => run(() => api.save<Batch>('nursery_batches', { id: b0.id, stage: 'rooting' }), t('Back to rooting'))}>{t('Back to rooting')}</button>}
      </div>}
      <div className="grid3">
        <F label={t('Generation')}><Pick value={gen} options={[4, 3, 2, 1].map(g => ({ v: g as 1 | 2 | 3 | 4, l: t(GEN_WHAT[g]) }))} onChange={v => set({ gen: v ?? 4, mother_id: null })} /></F>
        <F label={t('Strain')}><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} autoFocus={isNew && !b0.strain} /></F>
        <F label={t('Cut on')}><DateIn value={x.cut_on} onChange={v => set({ cut_on: v ?? today() })} /></F>
        <F label={t('Cuttings')}><NumIn value={x.cuttings} onChange={v => set({ cuttings: v ?? undefined })} /></F>
        <F label={t('Trays')} hint={t('({n} per tray)', { n: tray })}><NumIn value={x.trays ?? (x.cuttings ? Math.round(x.cuttings / tray * 10) / 10 : null)} onChange={v => set({ trays: v })} /></F>
        <F label={t('Rooting in')}><Pick value={x.room_id} blank="—" options={d.rooms.filter(r => r.active || r.id === x.room_id).map(r => ({ v: r.id, l: `${r.name}${r.place !== 'Webb' ? ` (${r.place})` : ''}` }))} onChange={v => set({ room_id: v })} /></F>
        <F label={t('Cut from')} hint={gen === 1 ? '' : t('({gen} lots)', { gen: GEN_LABEL[gen - 1] })}><Pick value={x.mother_id} blank="—" options={moms.map(m => ({ v: m.id, l: `${m.strain} ${GEN_LABEL[m.gen]} · ${[c.room(m.room_id), m.bed].filter(Boolean).join(' ') || t('no location')} · ${live(m)}` }))} onChange={v => set({ mother_id: v })} /></F>
        <F label={t('Ready by')} hint={x.ready_on ? '' : t('({n} days)', { n: d.settings.rootDays })}><DateIn value={x.ready_on ?? (x.cut_on ? addDays(x.cut_on, d.settings.rootDays) : null)} onChange={v => set({ ready_on: v })} /></F>
        {gen === 4 ? <F label={t('For order')} hint={t('(optional)')}><Pick value={x.order_id} blank={t('Not for a particular order')} options={orders.map(o => ({ v: o.id, l: `${c.to(o)} · ${n0(o.plants)} · ${fmtD(o.deliver_on) || t('no date')}` }))} onChange={v => set({ order_id: v })} /></F>
          : <F label={t('For season')}><NumIn value={x.season ?? (x.cut_on ? nextSeason(gen, x.cut_on) : null)} onChange={v => set({ season: v })} /></F>}
      </div>
      <StrainList id="n-strains" names={[...new Set([...d.mothers.filter(m => m.status === 'active').map(m => m.strain), ...d.strains])]} />
      <F label={t('METRC batch name')}><TextIn value={x.name} placeholder={autoName} onChange={v => set({ name: v })} /></F>
      <F label={t('Clone package tag (METRC)')} hint={t('one package for this cutting event')}>
        <div className="row"><input className="mono" list="n-pkg-tags" value={x.package_tag ?? ''} onChange={e => set({ package_tag: e.target.value.toUpperCase().replace(/\s/g, '') })} placeholder="1A40603…" />
          <ScanButton onScan={v => set({ package_tag: v })} disabled={busy} /></div>
        <datalist id="n-pkg-tags">{pkgTags.map(p => <option key={p} value={p} />)}</datalist>
      </F>
      <F label={t('METRC tags')} hint={t('({n} of {of}: one per 100 plants)', { n: tags.length, of: tagsNeeded(x.cuttings ?? 1) })}>
        <textarea rows={Math.max(2, Math.min(6, tags.length + 1))} value={tagText} onChange={e => setTagText(e.target.value.toUpperCase())} placeholder={t('One tag per line')} />
        <div className="row"><button type="button" className="ghost small" onClick={fillTags} disabled={busy || tags.length >= tagsNeeded(x.cuttings ?? 1)}>{t('Fill next tags')}</button>
          <ScanButton onScan={t => setTagText(s => (s.trim() ? `${s.trim()}\n${t}` : t))} disabled={busy} /></div>
      </F>
      {!isNew && <><h3>{t('Rooting')}</h3>
      <div className="grid3">
        <F label={t('First roots seen')}><DateIn value={x.emerged_on} onChange={v => set({ emerged_on: v })} /></F>
        <F label={t('Moved outside')}><DateIn value={x.moved_out_on} onChange={v => set({ moved_out_on: v })} /></F>
        <div className="field"><label>{t('Rooted so far')}</label><div className="calcline">{r == null ? <span className="muted">{t('enter a sort')}</span> : <><b>{n0(r)}</b> {t('of')} {n0(x.cuttings)} · {pct(x.cuttings ? r / x.cuttings : null)}
          {x.sort1_on && x.cut_on ? <span className="muted"> · {t('{n} days to first sort', { n: daysBetween(x.cut_on, x.sort1_on) })}</span> : ''}</>}</div></div>
      </div>
      {sortRow(1)}{sortRow(2)}
      <p className="muted small-note">{t('Rooted = vigorous at sort 1 + vigorous at sort 2 (sort 2 re-sorts the minimal and no-root ones).')}</p></>}
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      {!isNew && delivered > 0 && <p className="muted small-note">{t('{n} plants from this batch were delivered.', { n: n0(delivered) })}</p>}
      <SaveBar busy={busy} disabled={!x.strain?.trim() || !(Number(x.cuttings) > 0) || !x.cut_on} saveLabel={isNew ? t('Add batch') : t('Save')} onCancel={onClose} onSave={save}
        onDelete={!isNew && !delivered ? () => run(() => api.remove('nursery_batches', b0.id!), t('Batch deleted')) : undefined} />
    </Sheet>
  )
}

/** G1-G3 batch planted out: becomes a mother lot (one tag per lot) */
function PlantMoms({ d, c, b, api, flash, onBack, onDone }: { d: NData; c: NCtx; b: Batch; api: NurseryApi; flash: Flash; onBack: () => void; onDone: (m: string) => Promise<void> }) {
  const left = c.left(b)
  const kinds = b.gen === 3 ? ['hoop'] : ['bench', 'greenhouse', 'hoop']
  const locs = d.rooms.filter(r => r.active && kinds.includes(r.kind))
  const [room, setRoom] = useState<number | null>(locs[0]?.id ?? null)
  const [bed, setBed] = useState<string | null>(null)
  const [qty, setQty] = useState<number | null>(left)
  const [tag, setTag] = useState('')
  const [on, setOn] = useState<string | null>(today())
  const [busy, setBusy] = useState(false)
  const r = d.rooms.find(x => x.id === room)
  const used = r ? d.mothers.filter(m => m.room_id === r.id && m.status === 'active' && (!bed || m.bed === bed)).reduce((a, m) => a + live(m), 0) : 0
  const cap = r?.kind === 'hoop' ? (bed ? r.beds.find(x => x.bed === bed)?.cap : r.capacity) ?? null : null
  const go = async () => {
    setBusy(true)
    try { await api.plantMoms(b.id, room, bed, qty!, tag || null, on); await onDone(t('{n} {strain} {gen} moms planted', { n: n0(qty), strain: b.strain, gen: GEN_LABEL[b.gen] }) + (r ? ` · ${r.name}${bed ? ` ${bed}` : ''}` : '')) }
    catch (e) { flash(String((e as Error).message ?? e).replace(/duplicate key.*plant_tag.*/, t('That tag is already on another mother lot')), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={t('Plant {strain} as {gen} moms', { strain: b.strain, gen: GEN_LABEL[b.gen] })} sub={t('{n} plants left in {batch}. Plant them in one lot, or a few (one tag each).', { n: n0(left), batch: b.name ?? t('this batch') })} onClose={onBack}>
      <div className="grid3">
        <F label={t('Where')}><Pick value={room} options={locs.map(x => ({ v: x.id, l: `${x.name}${x.place !== 'Webb' ? ` (${x.place})` : ''}` }))} onChange={v => { setRoom(v); setBed(null) }} /></F>
        {r?.kind === 'hoop' && <F label={t('Bed')}><Pick value={bed} blank="—" options={(r.beds.length ? r.beds.map(x => x.bed) : ['A', 'B', 'C']).map(x => ({ v: x, l: x }))} onChange={setBed} /></F>}
        <F label={t('Plants')}><NumIn value={qty} onChange={setQty} /></F>
        <F label={t('Planted on')}><DateIn value={on} onChange={setOn} /></F>
      </div>
      <F label={t('METRC plant tag for this lot')}><div className="row"><input value={tag} onChange={e => setTag(e.target.value.toUpperCase())} placeholder={t('Scan or type')} />
        <button type="button" className="ghost small" onClick={async () => { const t = (await api.nextTags(b.site, 1))[0]; if (t) setTag(t) }}>{t('Next tag')}</button><ScanButton onScan={setTag} disabled={busy} /></div></F>
      {cap != null && <p className={`small-note ${used + (qty ?? 0) > cap ? 'warn-t' : 'muted'}`}>{r!.name}{bed ? ` ${t('bed')} ${bed}` : ''}: {t('{n} planted of {cap} spots', { n: n0(used), cap: n0(cap) })}{used + (qty ?? 0) > cap ? ' ' + t('(this goes over)') : ''}.</p>}
      <SaveBar busy={busy} disabled={!qty || qty <= 0 || qty > left} saveLabel={t('Plant {n}', { n: n0(qty) })} onCancel={onBack} onSave={go} />
    </Sheet>
  )
}
