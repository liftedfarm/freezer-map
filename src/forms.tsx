import { useMemo, useState } from 'react'
import type { Pallet } from './types'

// Small shared pieces for the action dialogs (split, merge, tag, weight).

export const lbs = (n: number | null | undefined) => n == null ? '' : `${(Math.round(n * 100) / 100).toLocaleString()} lbs`

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{title}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  )
}

function TagField({ tag, setTag, pending, setPending }: {
  tag: string; setTag: (v: string) => void; pending: boolean; setPending: (v: boolean) => void
}) {
  return (
    <div className="field">
      <label>New METRC tag</label>
      <input className="mono-in" value={tag} disabled={pending} placeholder="1A40603000…"
        onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} />
      <label className="check"><input type="checkbox" checked={pending} onChange={e => setPending(e.target.checked)} /> Tag pending, I'll add it later</label>
    </div>
  )
}

type Dest = 'same' | 'other' | 'staging'

function DestField({ dest, setDest, sameLabel }: { dest: Dest; setDest: (d: Dest) => void; sameLabel: string | null }) {
  return (
    <div className="field">
      <label>Where does it go?</label>
      <div className="choices">
        {sameLabel && <button className={dest === 'same' ? 'on' : ''} onClick={() => setDest('same')}>{sameLabel}</button>}
        <button className={dest === 'other' ? 'on' : ''} onClick={() => setDest('other')}>Pick a slot</button>
        <button className={dest === 'staging' ? 'on' : ''} onClick={() => setDest('staging')}>Staging</button>
      </div>
    </div>
  )
}

export function SplitForm({ p, where, busy, onClose, onSubmit }: {
  p: Pallet; where: string | null; busy: boolean; onClose: () => void
  onSubmit: (lbs: number, tag: string | null, pending: boolean, dest: Dest, note: string) => void
}) {
  const [amt, setAmt] = useState('')
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [dest, setDest] = useState<Dest>(where ? 'same' : 'staging')
  const [note, setNote] = useState('')
  const n = parseFloat(amt)
  const w = p.current_weight ?? 0
  const ok = n > 0 && n < w && (pending || tag.trim().length > 0)
  return (
    <Dialog title={`Split ${p.code}`} onClose={onClose}>
      <p className="muted">{p.strain} · {lbs(w)} now. The part you split off becomes a new pallet with its own number and METRC tag. {p.code} keeps the rest.</p>
      <div className="field">
        <label>Lbs to split off</label>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={amt} onChange={e => setAmt(e.target.value)} autoFocus />
        {amt && <div className={n > 0 && n < w ? 'muted' : 'warn-t'}>
          {n > 0 && n < w ? `New pallet ${lbs(n)} · ${p.code} keeps ${lbs(w - n)}` : `Must be more than 0 and less than ${lbs(w)}`}
        </div>}
      </div>
      <TagField tag={tag} setTag={setTag} pending={pending} setPending={setPending} />
      <DestField dest={dest} setDest={setDest} sameLabel={where ? `Same slot (${where})` : null} />
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. pulled for Acquamarcia order" /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit(n, pending ? null : tag, pending, dest, note)}>Split</button>
      </div>
    </Dialog>
  )
}

export function MergeForm({ p, candidates, whereOf, busy, onClose, onSubmit }: {
  p: Pallet; candidates: Pallet[]; whereOf: (x: Pallet) => string; busy: boolean; onClose: () => void
  onSubmit: (ids: number[], tag: string | null, pending: boolean, dest: Dest, note: string) => void
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [dest, setDest] = useState<Dest>(p.slot_id != null ? 'same' : 'staging')
  const [note, setNote] = useState('')
  const total = useMemo(() => (p.current_weight ?? 0) + candidates.filter(c => picked.has(c.id)).reduce((a, c) => a + (c.current_weight ?? 0), 0), [picked, candidates, p])
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const ok = picked.size > 0 && (pending || tag.trim().length > 0)
  return (
    <Dialog title={`Merge ${p.code}`} onClose={onClose}>
      <p className="muted">Combine {p.strain} pallets into one new C pallet with a new METRC tag. The originals are closed out and linked in history.</p>
      <div className="field">
        <label>Merge with ({candidates.length} other {p.strain} pallets)</label>
        <div className="picklist">
          {candidates.length === 0 && <div className="muted">No other {p.strain} pallets in inventory.</div>}
          {candidates.map(c => (
            <label key={c.id} className={`pick ${picked.has(c.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <b>{c.code}</b><span>{lbs(c.current_weight)}</span><span className="muted">{whereOf(c)}</span>
            </label>
          ))}
        </div>
        {picked.size > 0 && <div className="muted">New pallet: {picked.size + 1} pallets · {lbs(total)}</div>}
      </div>
      <TagField tag={tag} setTag={setTag} pending={pending} setPending={setPending} />
      <DestField dest={dest} setDest={setDest} sameLabel={p.slot_id != null ? `${p.code}'s slot (${whereOf(p)})` : null} />
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit([p.id, ...picked], pending ? null : tag, pending, dest, note)}>Merge {picked.size + 1} pallets</button>
      </div>
    </Dialog>
  )
}

export function TagForm({ p, busy, onClose, onSubmit }: { p: Pallet; busy: boolean; onClose: () => void; onSubmit: (tag: string) => void }) {
  const [tag, setTag] = useState(p.package_tag ?? '')
  return (
    <Dialog title={`METRC tag for ${p.code}`} onClose={onClose}>
      <div className="field">
        <label>Tag</label>
        <input className="mono-in" value={tag} autoFocus onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} />
      </div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!tag.trim() || busy} onClick={() => onSubmit(tag)}>Save tag</button>
      </div>
    </Dialog>
  )
}

export function WeightForm({ p, busy, onClose, onSubmit }: { p: Pallet; busy: boolean; onClose: () => void; onSubmit: (w: number, note: string) => void }) {
  const [w, setW] = useState(p.current_weight != null ? String(p.current_weight) : '')
  const [note, setNote] = useState('')
  const n = parseFloat(w)
  return (
    <Dialog title={`Adjust weight · ${p.code}`} onClose={onClose}>
      <p className="muted">Currently {lbs(p.current_weight) || 'unknown'}. Use this for a reweigh or to fix a wrong number.</p>
      <div className="field"><label>New weight (lbs)</label>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={w} autoFocus onChange={e => setW(e.target.value)} /></div>
      <div className="field"><label>Reason</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. reweighed on scale 2" /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!(n >= 0) || busy} onClick={() => onSubmit(n, note)}>Save</button>
      </div>
    </Dialog>
  )
}
