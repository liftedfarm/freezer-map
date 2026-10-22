import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { NurseryApi } from './api'
import { GEN_LABEL, fmtD, n0, today } from './calc'
import type { Batch, NData } from './types'
import { DateIn, Sheet } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { t, tn } from '../i18n'

type Which = 'cut' | 1 | 2
const FIELDS = ['vigorous', 'minimal', 'none', 'dead'] as const
type Fld = typeof FIELDS[number]
const FLABEL: Record<Fld, string> = { vigorous: 'Vigorous', minimal: 'Minimal', none: 'No roots', dead: 'Dead / contam.' }
const k = (n: 1 | 2, f: Fld) => `s${n}_${f}` as keyof Batch
const val = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')))

/** Sort day: one trailer at a time, every rooting batch in a grid. Cut counts, then sort 1 and sort 2, like the sheet. */
export function SortDay({ d, api, flash, onClose, onSaved }: { d: NData; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const rooting = d.batches.filter(b => b.stage === 'rooting')
  const count = (id: number | null) => rooting.filter(b => b.room_id === id).length
  // every trailer, plus any other place something is rooting
  const rooms = d.rooms.filter(r => (r.kind === 'trailer' && r.active) || count(r.id) > 0)
  const unplaced = count(null)
  const best = [...rooms].sort((a, b) => count(b.id) - count(a.id))[0]
  const [room, setRoom] = useState<number | null>(best && count(best.id) ? best.id : unplaced ? null : rooms[0]?.id ?? null)
  const [which, setWhich] = useState<Which>(() => {
    const rs = rooting.filter(b => b.room_id === room)
    return rs.length && rs.every(b => b.sort1_on) ? 2 : 1
  })
  const [on, setOn] = useState<string | null>(today())
  const [edits, setEdits] = useState<Record<number, Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => rooting.filter(b => b.room_id === room).sort((a, b) => a.strain.localeCompare(b.strain) || a.cut_on.localeCompare(b.cut_on)), [rooting, room])
  const cols: string[] = which === 'cut' ? ['cuttings'] : FIELDS.map(f => k(which, f) as string)

  const shown = (b: Batch, f: string) => edits[b.id]?.[f] ?? (b[f as keyof Batch] == null ? '' : String(b[f as keyof Batch]))
  const num = (b: Batch, f: string) => { const v = val(shown(b, f)); return v != null && isFinite(v) ? v : null }
  const set = (id: number, f: string, v: string) => setEdits(e => ({ ...e, [id]: { ...e[id], [f]: v.replace(/[^\d,]/g, '') } }))
  const changed = rows.filter(b => edits[b.id] && Object.entries(edits[b.id]).some(([f, v]) => val(v) !== (b[f as keyof Batch] ?? null)))
  const bad = rows.some(b => cols.some(f => { const v = val(shown(b, f)); return v != null && (!isFinite(v) || v < 0) }))

  // what a sort should add up to: sort 1 = cuttings; sort 2 re-sorts sort 1's minimal + no roots
  const expect = (b: Batch) => which === 1 ? num(b, 'cuttings') : which === 2 ? (num(b, 's1_minimal') ?? 0) + (num(b, 's1_none') ?? 0) : null
  const total = (b: Batch) => which === 'cut' ? null : FIELDS.reduce((a, f) => a + (num(b, k(which, f) as string) ?? 0), 0)
  const entered = (b: Batch) => which !== 'cut' && FIELDS.some(f => num(b, k(which, f) as string) != null)
  const rootedNow = (b: Batch) => {
    const v1 = num(b, 's1_vigorous'), v2 = num(b, 's2_vigorous'), cut = num(b, 'cuttings')
    if (v1 == null && v2 == null) return null
    const r = (v1 ?? 0) + (v2 ?? 0)
    return { r, p: cut ? r / cut : null }
  }

  const move = (e: KeyboardEvent<HTMLInputElement>, r: number, col: number) => {
    const dr = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!dr) return
    e.preventDefault()
    const next = document.querySelector<HTMLInputElement>(`.sortday input[data-r="${r + dr}"][data-c="${col}"]`)
      ?? (dr === 1 ? document.querySelector<HTMLInputElement>(`.sortday input[data-r="0"][data-c="${col + 1}"]`) : null)
    next?.focus(); next?.select()
  }

  const save = async () => {
    setBusy(true)
    try {
      const one = async (b: Batch) => {
        const x: Partial<Batch> & { id: number } = { id: b.id }
        for (const [f, v] of Object.entries(edits[b.id])) (x as Record<string, unknown>)[f] = val(v)
        if (which !== 'cut' && entered({ ...b, ...x } as Batch) && !b[`sort${which}_on` as keyof Batch]) (x as Record<string, unknown>)[`sort${which}_on`] = on ?? today()
        if (x.cuttings != null) x.trays = Math.round(x.cuttings / (d.settings.tray || 72) * 10) / 10
        await api.save<Batch>('nursery_batches', x)
      }
      for (let i = 0; i < changed.length; i += 8) await Promise.all(changed.slice(i, i + 8).map(one))
      const n = changed.length
      setEdits({})
      await onSaved(t(n === 1 ? '1 batch saved' : '{n} batches saved', { n }))
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const pick = (id: number | null) => {
    if (changed.length && !confirm(t('Leave without saving the {n} changed rows?', { n: changed.length }))) return
    setEdits({}); setRoom(id)
  }
  const roomName = (id: number | null) => id == null ? t('No location') : d.rooms.find(r => r.id === id)?.name ?? ''

  return (
    <Sheet title={t('Sort day')} sub={t('Every rooting batch in one trailer. Type the counts, Enter goes down the column.')} onClose={onClose} wide>
      <div className="sortday">
        <div className="seg">{rooms.map(r => <button key={r.id} className={room === r.id ? 'on' : ''} onClick={() => pick(r.id)}>{r.name} <span className="muted">{count(r.id)}</span></button>)}
          {unplaced > 0 && <button className={room == null ? 'on' : ''} onClick={() => pick(null)}>{t('No location')} <span className="muted">{unplaced}</span></button>}</div>
        <div className="row wrap sdbar">
          <div className="seg">{([['cut', t('Cut counts')], [1, t('Sort 1')], [2, t('Sort 2')]] as [Which, string][]).map(([w, l]) =>
            <button key={String(w)} className={which === w ? 'on' : ''} onClick={() => setWhich(w)}>{l}</button>)}</div>
          {which !== 'cut' && <label className="row sddate">{t('Sorted on')} <DateIn value={on} onChange={setOn} /></label>}
        </div>
        {which === 2 && <p className="muted small-note">{t('Sort 2 re-sorts the minimal and no-root ones from sort 1.')}</p>}
        {!rows.length ? <p className="muted">{t('Nothing rooting in {room}.', { room: roomName(room) })}</p> : <div className="cwrap"><table className="ctable sdtable">
          <thead><tr><th>{t('Strain')}</th><th className="hide-s">{t('Gen')}</th><th className="hide-s">{t('Cut')}</th>
            {which === 'cut' ? <th className="num">{t('Cuttings')}</th> : <><th className="num hide-s">{which === 1 ? t('Cuttings') : t('To re-sort')}</th>{FIELDS.map(f => <th key={f} className="num">{t(FLABEL[f])}</th>)}<th className="num">{t('Total')}</th></>}
            <th className="num">{t('Rooted')}</th></tr></thead>
          <tbody>{rows.map((b, r) => {
            const ex = expect(b), tot = total(b), off = entered(b) && ex != null && tot !== ex, rr = rootedNow(b)
            return <tr key={b.id} className={changed.includes(b) ? 'edited' : ''}>
              <td title={b.name ?? ''}><b>{b.strain}</b></td>
              <td className="hide-s"><span className={`gpill g${b.gen}`}>{GEN_LABEL[b.gen]}</span></td>
              <td className="nowrap hide-s">{fmtD(b.cut_on)}</td>
              {which !== 'cut' && <td className="num hide-s">{which === 2 && !b.sort1_on && b.s1_minimal == null && b.s1_none == null ? <span className="muted">—</span> : n0(ex)}</td>}
              {cols.map((f, col) => <td key={f} className="num"><input className="qty" inputMode="numeric" data-r={r} data-c={col} value={shown(b, f)}
                onChange={e => set(b.id, f, e.target.value)} onKeyDown={e => move(e, r, col)} onFocus={e => e.target.select()} /></td>)}
              {which !== 'cut' && <td className={`num ${off ? 'bad-t' : ''}`} title={off ? t('Should add up to {n}', { n: n0(ex) }) : ''}>{entered(b) ? n0(tot) : ''}{off ? ` / ${n0(ex)}` : ''}</td>}
              <td className="num">{rr ? <span className={rr.p != null && rr.p < 0.85 ? 'warn-t' : ''}>{n0(rr.r)}{rr.p != null ? ` · ${Math.round(rr.p * 100)}%` : ''}</span> : ''}</td>
            </tr>
          })}</tbody>
        </table></div>}
        <p className="muted small-note">{which === 'cut' ? t('Cuttings stuck per batch. Imported Gen 2 batches came in at 36 each until counted.') : t('Rooted = vigorous at sort 1 + vigorous at sort 2. Red totals don\'t add up to what was sorted.')}</p>
        <div className="row between csave">
          <span className="muted">{changed.length ? tn(changed.length, '1 changed', '{n} changed') : ''}</span>
          <div className="row">
            <button className="ghost" onClick={onClose}>{t('Close')}</button>
            <button className="primary" disabled={busy || bad || !changed.length} onClick={save}>{busy ? t('Saving…') : t('Save {n}', { n: changed.length || '' })}</button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
