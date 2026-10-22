import { Fragment, useState } from 'react'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { fmtD, n0, strainKey, today } from './calc'
import type { Mother, NData } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, SelAll, SelBar, SelBox, SelButton, Sheet, StrainList, TextIn, useSel } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { ScanButton } from '../scan'

/** Nursery > Mothers: every mother plant, by strain */
export function MothersTab({ d, c, q, api, flash, onSaved, onOpen, onAdd }: {
  d: NData; c: NCtx; q: string; api: NurseryApi; flash: Flash; onSaved: (m: string) => Promise<void>; onOpen: (m: Mother) => void; onAdd: (strain?: string) => void
}) {
  const [f, setF] = useState<'active' | 'gone' | 'all'>('active')
  const sel = useSel()
  const ql = q.trim().toLowerCase()
  const rows = d.mothers.filter(m => (f === 'all' || (f === 'active' ? m.status === 'active' : m.status !== 'active')) &&
    (!ql || `${m.strain} ${m.plant_tag ?? ''} ${c.room(m.room_id)} ${m.notes ?? ''}`.toLowerCase().includes(ql)))
  const groups = new Map<string, Mother[]>()
  for (const m of rows) (groups.get(strainKey(m.strain)) ?? groups.set(strainKey(m.strain), []).get(strainKey(m.strain))!).push(m)
  const active = d.mothers.filter(m => m.status === 'active')
  const bulk = (v: Partial<Mother>, msg: string) => async (ids: number[]) => {
    try { await api.updateMany('nursery_mothers', ids, v); await onSaved(`${ids.length} ${msg}`) } catch (e) { flash(String((e as Error).message ?? e), true) }
  }
  return <>
    <div className="row toolbar between">
      <div className="seg">{([['active', `Active (${active.length})`], ['gone', 'Retired / destroyed'], ['all', 'All']] as const).map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{l}</button>)}</div>
      <div className="row"><SelButton sel={sel} /><button className="primary" onClick={() => onAdd()}>+ Add mothers</button></div>
    </div>
    {!rows.length ? <p className="muted">No mother plants here yet. Add them with "Add mothers" (one row per plant, with its METRC tag).</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><SelAll sel={sel} ids={rows.map(m => m.id)} /><th>Strain / tag</th><th>Room</th><th>Started</th><th className="hide-s">Notes</th><th>Status</th></tr></thead>
      <tbody>{[...groups.values()].map(ms => <Fragment key={ms[0].strain}>
        <tr className="wk"><td colSpan={sel.on ? 6 : 5}><span className="row between">{ms[0].strain} · {n0(ms.length)} {ms.length === 1 ? 'plant' : 'plants'}
          <button className="linkbtn" onClick={() => onAdd(ms[0].strain)}>+ more</button></span></td></tr>
        {ms.map(m => <tr key={m.id} className={`tap ${m.status !== 'active' ? 'done' : ''}`} onClick={() => sel.on ? sel.toggle(m.id) : onOpen(m)}>
          <SelBox sel={sel} id={m.id} /><td className="small">{m.plant_tag ?? <span className="warn-t">no tag</span>}</td><td>{c.room(m.room_id)}</td>
          <td className="nowrap">{fmtD(m.started_on)}</td><td className="hide-s">{m.notes}</td>
          <td>{m.status === 'active' ? 'Active' : `${m.status === 'retired' ? 'Retired' : 'Destroyed'} ${fmtD(m.ended_on)}`}</td></tr>)}
      </Fragment>)}</tbody>
    </table></div>}
    <SelBar sel={sel} noun="plant" actions={[
      { label: 'Retire', run: bulk({ status: 'retired', ended_on: today() }, 'retired') },
      { label: 'Destroyed', danger: true, run: bulk({ status: 'destroyed', ended_on: today() }, 'marked destroyed') },
      ...d.rooms.filter(r => r.active && r.kind === 'mother').map(r => ({ label: `Move to ${r.name}`, run: bulk({ room_id: r.id }, `moved to ${r.name}`) })),
    ]} />
  </>
}

/** add several mother plants of one strain, one tag each */
export function AddMothers({ d, strain, api, flash, onClose, onSaved }: { d: NData; strain?: string; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const site = d.sites[0]?.code ?? '1PN'
  const [s, setS] = useState<string | null>(strain ?? null)
  const [room, setRoom] = useState<number | null>(d.rooms.find(r => r.active && r.kind === 'mother')?.id ?? null)
  const [started, setStarted] = useState<string | null>(today())
  const [count, setCount] = useState<number | null>(1)
  const [tagText, setTagText] = useState('')
  const [busy, setBusy] = useState(false)
  const tags = tagText.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
  const n = Math.max(count ?? 0, tags.length)
  const fill = async () => {
    const need = (count ?? 0) - tags.length
    if (need <= 0) return
    const pool = (await api.nextTags(site, need + 20)).filter(t => !tags.includes(t)).slice(0, need)
    if (!pool.length) { flash('No tag range for this nursery yet. Add one in Nursery → Settings → METRC tags.', true); return }
    setTagText([...tags, ...pool].join('\n'))
  }
  async function save() {
    setBusy(true)
    try {
      await api.insertMany('nursery_mothers', Array.from({ length: n }, (_, i) => ({ site, room_id: room, strain: s!.trim(), plant_tag: tags[i] ?? null, started_on: started, status: 'active' as const })))
      onClose(); await onSaved(`${n} ${s} ${n === 1 ? 'mother' : 'mothers'} added`)
    } catch (e) { flash(String((e as Error).message ?? e).replace(/duplicate key.*plant_tag.*/, 'One of those tags is already on a mother plant'), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title="Add mother plants" sub="One row per plant, each with its METRC plant tag" onClose={onClose}>
      <F label="Strain"><TextIn value={s} list="n-strains" onChange={setS} autoFocus={!strain} /></F>
      <StrainList id="n-strains" names={d.strains} />
      <div className="grid3">
        <F label="How many"><NumIn value={count} onChange={setCount} /></F>
        <F label="Room"><Pick value={room} blank="—" options={d.rooms.filter(r => r.active).map(r => ({ v: r.id, l: r.name }))} onChange={setRoom} /></F>
        <F label="Started"><DateIn value={started} onChange={setStarted} /></F>
      </div>
      <F label="METRC plant tags" hint={`(${tags.length} of ${count ?? 0})`}>
        <textarea rows={Math.max(2, Math.min(8, tags.length + 1))} value={tagText} onChange={e => setTagText(e.target.value.toUpperCase())} placeholder="One tag per line, or paste from METRC" />
        <div className="row"><button type="button" className="ghost small" onClick={fill} disabled={busy || tags.length >= (count ?? 0)}>Fill next tags</button>
          <ScanButton onScan={t => setTagText(v => (v.trim() ? `${v.trim()}\n${t}` : t))} disabled={busy} /></div>
      </F>
      {tags.length > 0 && tags.length < (count ?? 0) && <p className="muted small-note">{(count ?? 0) - tags.length} will be added without a tag (fix later).</p>}
      <SaveBar busy={busy} disabled={!s?.trim() || n <= 0} saveLabel={`Add ${n}`} onCancel={onClose} onSave={save} />
    </Sheet>
  )
}

export function MotherSheet({ d, m, api, flash, onClose, onSaved }: { d: NData; m: Mother; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [x, setX] = useState<Mother>(m)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Mother>) => setX(s => ({ ...s, ...v }))
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); onClose(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e).replace(/duplicate key.*plant_tag.*/, 'That tag is already on another mother plant'), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={`${m.strain} mother`} sub={m.plant_tag ?? 'no tag yet'} onClose={onClose}>
      <F label="Strain"><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} /></F>
      <StrainList id="n-strains" names={d.strains} />
      <F label="METRC plant tag"><div className="row"><input value={x.plant_tag ?? ''} onChange={e => set({ plant_tag: e.target.value.toUpperCase() || null })} /><ScanButton onScan={t => set({ plant_tag: t })} disabled={busy} /></div></F>
      <div className="grid2">
        <F label="Room"><Pick value={x.room_id} blank="—" options={d.rooms.filter(r => r.active || r.id === x.room_id).map(r => ({ v: r.id, l: r.name }))} onChange={v => set({ room_id: v })} /></F>
        <F label="Started"><DateIn value={x.started_on} onChange={v => set({ started_on: v })} /></F>
        <F label="Status"><Pick value={x.status} options={[{ v: 'active', l: 'Active' }, { v: 'retired', l: 'Retired' }, { v: 'destroyed', l: 'Destroyed' }]}
          onChange={v => set({ status: v ?? 'active', ended_on: v && v !== 'active' ? x.ended_on ?? today() : null })} /></F>
        {x.status !== 'active' && <F label="Since"><DateIn value={x.ended_on} onChange={v => set({ ended_on: v })} /></F>}
      </div>
      <F label="Notes"><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose}
        onSave={() => run(() => api.save<Mother>('nursery_mothers', { id: x.id, strain: x.strain.trim(), plant_tag: x.plant_tag, room_id: x.room_id, started_on: x.started_on, status: x.status, ended_on: x.ended_on, notes: x.notes }), 'Saved')}
        onDelete={() => run(() => api.remove('nursery_mothers', m.id), 'Removed (entered by mistake)')} />
    </Sheet>
  )
}
