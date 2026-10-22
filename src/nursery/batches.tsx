import { useState } from 'react'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { STAGE_LABEL, addDays, batchName, fmtD, n0, strainKey, tagsNeeded, today } from './calc'
import type { Batch, NData, Stage } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { ScanButton } from '../scan'

const stagePill = (b: Batch) => {
  const late = b.stage === 'rooting' && b.ready_on && b.ready_on < today()
  return <span className={`pill ${b.stage === 'ready' ? 'okp' : late ? 'warnp' : ''}`}>{late ? 'Rooting (past ready date)' : STAGE_LABEL[b.stage]}</span>
}

/** Nursery > Batches: cuttings taken, rooting, ready, out the door */
export function BatchesTab({ d, c, q, onOpen, onNew }: { d: NData; c: NCtx; q: string; onOpen: (b: Batch) => void; onNew: () => void }) {
  const [f, setF] = useState<'live' | Stage | 'all'>('live')
  const ql = q.trim().toLowerCase()
  const rows = d.batches.filter(b => (f === 'all' || (f === 'live' ? b.stage === 'rooting' || b.stage === 'ready' : b.stage === f)) &&
    (!ql || `${b.strain} ${b.name ?? ''} ${b.tags.join(' ')} ${b.notes ?? ''}`.toLowerCase().includes(ql)))
  const n = (s: Stage) => d.batches.filter(b => b.stage === s).length
  return <>
    <div className="row toolbar between">
      <div className="seg">{([['live', `In the nursery (${n('rooting') + n('ready')})`], ['rooting', 'Rooting'], ['ready', 'Ready'], ['done', 'Delivered'], ['all', 'All']] as const)
        .map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
      <button className="primary" onClick={onNew}>+ Cuttings taken</button>
    </div>
    {!rows.length ? <p className="muted">No batches here. When cuttings are taken, add them with "Cuttings taken".</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>Cut</th><th>Strain</th><th className="hide-s">Batch</th><th className="num">Cuttings</th><th className="num">Lost</th><th className="num">Left</th><th>Ready</th><th className="hide-s">For</th><th>Stage</th><th className="hide-s">Tags</th></tr></thead>
      <tbody>{rows.map(b => {
        const o = b.order_id ? d.orders.find(x => x.id === b.order_id) : undefined
        return <tr key={b.id} className={`tap ${b.stage === 'done' ? 'done' : b.stage === 'cancelled' ? 'cancelled' : ''}`} onClick={() => onOpen(b)}>
          <td className="nowrap">{fmtD(b.cut_on)}</td><td>{b.strain}</td><td className="hide-s small">{b.name}</td>
          <td className="num">{n0(b.cuttings)}</td><td className="num">{b.lost ? n0(b.lost) : ''}</td><td className="num"><b>{n0(c.left(b))}</b></td>
          <td className="nowrap">{fmtD(b.ready_on)}</td><td className="hide-s">{o ? `${c.to(o)} ${fmtD(o.deliver_on)}` : ''}</td><td>{stagePill(b)}</td>
          <td className="hide-s">{b.tags.length ? b.tags.length : <span className="warn-t">none</span>}</td>
        </tr>
      })}</tbody>
    </table></div>}
  </>
}

export function BatchSheet({ d, c, b: b0, api, flash, onClose, onSaved }: { d: NData; c: NCtx; b: Partial<Batch>; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const isNew = !b0.id
  const site = b0.site ?? d.sites[0]?.code ?? '1PN'
  const [x, setX] = useState<Partial<Batch>>(() => ({ site, cut_on: today(), tags: [], lost: 0, room_id: isNew ? d.rooms.find(r => r.active && r.kind === 'clone')?.id ?? null : null, ...b0 }))
  const [tagText, setTagText] = useState((b0.tags ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [good, setGood] = useState<number | null>(null)
  const [mode, setMode] = useState<'edit' | 'ready' | 'loss'>('edit')
  const [loss, setLoss] = useState<number | null>(null)
  const set = (v: Partial<Batch>) => setX(s => ({ ...s, ...v }))
  const tags = tagText.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
  const delivered = b0.id ? c.fromBatch.get(b0.id) ?? 0 : 0
  const autoName = x.strain && x.cut_on ? batchName(x.site ?? site, x.cut_on, x.strain) : ''
  const orders = d.orders.filter(o => c.isOpen(o) && (!x.strain || strainKey(o.strain) === strainKey(x.strain)))
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); onClose(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const fillTags = async () => {
    const need = tagsNeeded(x.cuttings ?? 1) - tags.length
    if (need <= 0) return
    const pool = (await api.nextTags(x.site ?? site, need + 20)).filter(t => !tags.includes(t)).slice(0, need)
    if (!pool.length) { flash('No tag range for this nursery yet. Add one in Nursery → Settings → METRC tags.', true); return }
    setTagText([...tags, ...pool].join('\n'))
  }
  const save = () => run(() => api.save<Batch>('nursery_batches', {
    id: x.id, site: x.site ?? site, room_id: x.room_id ?? null, strain: x.strain!.trim(), name: (x.name ?? '').trim() || autoName || null, order_id: x.order_id ?? null,
    cut_on: x.cut_on!, cuttings: x.cuttings!, lost: x.lost ?? 0, ready_on: x.ready_on ?? (x.cut_on ? addDays(x.cut_on, d.settings.rootDays) : null), stage: x.stage ?? 'rooting', tags, notes: x.notes ?? null,
  }), isNew ? `${n0(x.cuttings)} ${x.strain} cuttings added` : 'Saved')

  if (mode === 'ready' && b0.id) return (
    <Sheet title={`${b0.strain}: ready`} sub={`${b0.name ?? ''} · ${n0(b0.cuttings)} cut ${fmtD(b0.cut_on)}`} onClose={() => setMode('edit')}>
      <F label="Good plants (rooted, ready to go)"><NumIn value={good} onChange={setGood} autoFocus /></F>
      <p className="muted small-note">The rest ({n0(Math.max(0, b0.cuttings! - delivered - (good ?? 0)))}) count as lost.</p>
      <SaveBar busy={busy} disabled={good == null || good < 0 || good > b0.cuttings! - delivered} saveLabel="Mark ready" onCancel={() => setMode('edit')}
        onSave={() => run(() => api.save<Batch>('nursery_batches', { id: b0.id, stage: 'ready', ready_on: today(), lost: b0.cuttings! - delivered - good! }), `${n0(good)} ${b0.strain} ready`)} />
    </Sheet>
  )
  if (mode === 'loss' && b0.id) return (
    <Sheet title={`${b0.strain}: losses`} sub={`${n0(c.left(b0 as Batch))} left in ${b0.name ?? 'this batch'}`} onClose={() => setMode('edit')}>
      <F label="Plants lost (died, culled)"><NumIn value={loss} onChange={setLoss} autoFocus /></F>
      <SaveBar busy={busy} disabled={!loss || loss < 0 || loss > c.left(b0 as Batch)} saveLabel="Record loss" onCancel={() => setMode('edit')}
        onSave={() => run(() => api.save<Batch>('nursery_batches', { id: b0.id, lost: (b0.lost ?? 0) + loss!, ...(loss === c.left(b0 as Batch) ? { stage: delivered ? 'done' : 'cancelled' } : {}) }), `${n0(loss)} lost`)} />
    </Sheet>
  )
  return (
    <Sheet title={isNew ? 'Cuttings taken' : `${b0.strain} batch`} sub={isNew ? 'One batch per strain per day' : `${b0.name ?? ''} · ${n0(c.left(b0 as Batch))} left · ${STAGE_LABEL[b0.stage ?? 'rooting']}`} onClose={onClose}>
      {!isNew && (b0.stage === 'rooting' || b0.stage === 'ready') && <div className="row wrap docact">
        {b0.stage === 'rooting' && <button className="primary" disabled={busy} onClick={() => { setGood(c.left(b0 as Batch)); setMode('ready') }}>Mark ready…</button>}
        <button className="ghost" disabled={busy} onClick={() => setMode('loss')}>Record losses…</button>
        {b0.stage === 'ready' && <button className="ghost" disabled={busy} onClick={() => run(() => api.save<Batch>('nursery_batches', { id: b0.id, stage: 'rooting' }), 'Back to rooting')}>Back to rooting</button>}
      </div>}
      <F label="Strain"><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} autoFocus={isNew} /></F>
      <StrainList id="n-strains" names={[...new Set([...d.mothers.filter(m => m.status === 'active').map(m => m.strain), ...d.strains])]} />
      <div className="grid2">
        <F label="Cut on"><DateIn value={x.cut_on} onChange={v => set({ cut_on: v ?? today() })} /></F>
        <F label="Cuttings"><NumIn value={x.cuttings} onChange={v => set({ cuttings: v ?? undefined })} /></F>
        <F label="Room"><Pick value={x.room_id} blank="—" options={d.rooms.filter(r => r.active && r.site === (x.site ?? site)).map(r => ({ v: r.id, l: r.name }))} onChange={v => set({ room_id: v })} /></F>
        <F label="Ready by" hint={x.ready_on ? '' : `(${d.settings.rootDays} days)`}><DateIn value={x.ready_on ?? (x.cut_on ? addDays(x.cut_on, d.settings.rootDays) : null)} onChange={v => set({ ready_on: v })} /></F>
      </div>
      <F label="For order" hint="(optional)"><Pick value={x.order_id} blank="Not for a particular order" options={orders.map(o => ({ v: o.id, l: `${o.strain} · ${c.to(o)} · ${n0(o.plants)} · ${fmtD(o.deliver_on) || 'no date'}` }))} onChange={v => set({ order_id: v })} /></F>
      <F label="METRC batch name"><TextIn value={x.name} placeholder={autoName} onChange={v => set({ name: v })} /></F>
      <F label="METRC tags" hint={`(${tags.length} of ${tagsNeeded(x.cuttings ?? 1)}: one per 100 plants)`}>
        <textarea rows={Math.max(2, Math.min(6, tags.length + 1))} value={tagText} onChange={e => setTagText(e.target.value.toUpperCase())} placeholder="One tag per line" />
        <div className="row"><button type="button" className="ghost small" onClick={fillTags} disabled={busy || tags.length >= tagsNeeded(x.cuttings ?? 1)}>Fill next tags</button>
          <ScanButton onScan={t => setTagText(s => (s.trim() ? `${s.trim()}\n${t}` : t))} disabled={busy} /></div>
      </F>
      <F label="Notes"><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      {!isNew && delivered > 0 && <p className="muted small-note">{n0(delivered)} plants from this batch were delivered.</p>}
      <SaveBar busy={busy} disabled={!x.strain?.trim() || !(Number(x.cuttings) > 0) || !x.cut_on} saveLabel={isNew ? 'Add batch' : 'Save'} onCancel={onClose} onSave={save}
        onDelete={!isNew && !delivered ? () => run(() => api.remove('nursery_batches', b0.id!), 'Batch deleted') : undefined} />
    </Sheet>
  )
}
