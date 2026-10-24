import { useState } from 'react'
import type { Pallet } from './types'
import type { Lane, Plan } from './plan'
import { MetrcNote } from './metrc'

const lbs = (n: number) => `${Math.round(n).toLocaleString()} lbs`

export function SelectBar({ n, weight, busy, onMove, onLoad, onClear, onDone }: {
  n: number; weight: number; busy: boolean; onMove: () => void; onLoad: () => void; onClear: () => void; onDone: () => void
}) {
  return (
    <div className="planbar select">
      <div className="pb-top">
        <div><b>{n} selected</b>{n > 0 && <span className="muted"> · {lbs(weight)}</span>}
          <div className="muted small">Tap pallets to pick them. You can switch freezers and keep picking.</div></div>
        <div className="row">
          {n > 0 && <button className="ghost small" onClick={onClear}>Clear</button>}
          <button className="ghost small" onClick={onDone}>Done</button>
        </div>
      </div>
      {n > 0 && <div className="row pb-actions">
        <button className="primary" disabled={busy} onClick={onMove}>Move {n}</button>
        <button className="ghost" disabled={busy} onClick={onLoad}>Put on a load</button>
      </div>}
    </div>
  )
}

export function PlanBar({ plan, code, lanes, busy, stagingOpen, onPick, onDrop, onApply, onCancel, onShuffle, onShuffleAll, onFillStaging }: {
  plan: Plan; code: (id: number) => string; lanes: Lane[]; busy: boolean; stagingOpen: boolean
  onPick: (id: number) => void; onDrop: (id: number) => void; onApply: () => void; onCancel: () => void
  onShuffle: (l: Lane) => void; onShuffleAll: () => void; onFillStaging: () => void
}) {
  const n = plan.moves.length, t = plan.tray.length
  return (
    <div className="planbar" data-tray>
      <div className="pb-top">
        <div>
          <b>{t > 0 ? `${t} to place` : `${n} move${n === 1 ? '' : 's'} ready`}</b>
          <div className="muted small">{t > 0
            ? 'Open any freezer or staging and tap a slot. Tap a ghost to take it back. Drag pallets here to add them.'
            : 'Nothing is saved until you tap Apply.'}</div>
        </div>
        <div className="row">
          <button className="ghost small" onClick={onCancel}>Cancel</button>
          <button className="primary small" disabled={busy || t > 0 || n === 0} onClick={onApply}>Apply</button>
        </div>
      </div>
      {t > 0 && (
        <div className="chips tray">
          {plan.tray.map(id => (
            <span key={id} className={`chip ${plan.current === id ? 'cur' : ''}`} onClick={() => onPick(id)}>
              {code(id)} <a title="Leave it where it is" onClick={e => { e.stopPropagation(); onDrop(id) }}>✕</a>
            </span>
          ))}
          {stagingOpen && <button className="ghost small" onClick={onFillStaging}>Put all in staging, in this order</button>}
        </div>
      )}
      {t === 0 && lanes.length > 0 && (
        <div className="shuffle">
          <span>Gaps left behind: {lanes.map(l => l.label).join(', ')}.</span>
          <div className="row">
            {lanes.length > 1 && <button className="ghost small" onClick={onShuffleAll}>Shuffle all back</button>}
            {lanes.map(l => <button key={l.key} className="ghost small" onClick={() => onShuffle(l)}>Shuffle {l.label.split(' (')[0]}</button>)}
          </div>
        </div>
      )}
    </div>
  )
}

export function UndoPill({ n, onUndo, onClose }: { n: number; onUndo: () => void; onClose: () => void }) {
  return (
    <div className="undo-pill">
      <span>Saved {n} move{n === 1 ? '' : 's'}.</span>
      <button className="ghost small" onClick={onUndo}>Undo</button>
      <a onClick={onClose}>✕</a>
    </div>
  )
}

export function ChooseDialog({ p, occ, where, canSwap, onPick, onClose }: {
  p: Pallet; occ: Pallet[]; where: string; canSwap: boolean
  onPick: (mode: 'stack' | 'swap' | 'bump') => void; onClose: () => void
}) {
  const names = occ.map(o => o.code).join(', ')
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{where} has {names}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="choices col">
          <button onClick={() => onPick('stack')}><b>Stack</b> <span className="muted">{p.code} shares the slot. Each pallet keeps its own number.</span></button>
          <button disabled={!canSwap} onClick={() => onPick('swap')}><b>Swap</b> <span className="muted">{canSwap ? `${names} goes to ${p.code}'s old spot.` : `${p.code} has no slot to swap into.`}</span></button>
          <button onClick={() => onPick('bump')}><b>Move it too</b> <span className="muted">{names} goes in the tray so you can place it next.</span></button>
        </div>
      </div>
    </div>
  )
}

export function RemoveForm({ p, busy, onClose, onSubmit }: {
  p: Pallet; busy: boolean; onClose: () => void; onSubmit: (reason: 'used' | 'shipped' | 'mistake', note: string) => void
}) {
  const [reason, setReason] = useState<'used' | 'shipped' | 'mistake' | null>(null)
  const [note, setNote] = useState('')
  const ok = reason && (reason !== 'mistake' || note.trim())
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Remove {p.code}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <p className="muted">It comes off the map. Its history stays.</p>
        <div className="choices col">
          <button className={reason === 'used' ? 'on' : ''} onClick={() => setReason('used')}><b>Used up</b> <span className="muted">Weight goes to 0 (processing, waste, samples)</span></button>
          <button className={reason === 'shipped' ? 'on' : ''} onClick={() => setReason('shipped')}><b>Shipped outside the app</b> <span className="muted">Left on an order that wasn't a load here</span></button>
          <button className={reason === 'mistake' ? 'on' : ''} onClick={() => setReason('mistake')}><b>Entered by mistake</b> <span className="muted">It was never really there</span></button>
        </div>
        <div className="field"><label>Note {reason === 'mistake' ? <span className="warn-t">(required)</span> : <span className="muted">(optional)</span>}</label>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder={reason === 'mistake' ? 'What happened?' : ''} /></div>
        <MetrcNote kind="remove" p={p} removeReason={reason ?? undefined} />
        <div className="row end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary danger-bg" disabled={busy || !ok} onClick={() => reason && onSubmit(reason, note.trim())}>Remove</button>
        </div>
      </div>
    </div>
  )
}
