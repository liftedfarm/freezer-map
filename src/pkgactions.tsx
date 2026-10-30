import { useState } from 'react'
import type { Pallet } from './types'

// The package buttons every package card shares (Distribution's pallet screen, Processing's package card, ...).
// Module-only buttons (Buck, Sort, Trim, Dried here, loads and transit) stay in their module, above these.
// Which buttons show and which are greyed out comes from the package's state, passed in by the card.

export type PkgForm = 'split' | 'merge' | 'addto' | 'weight' | 'tag'

export function PackageActions({ p, busy, big, move, onForm, onLoad, onRemove, onFlag, onClear, off = {} }: {
  p: Pallet; busy: boolean
  /** Distribution's layout: Move / New package / Merge as big buttons on their own row */
  big?: boolean
  move?: { label: string; run: () => void } | null
  onForm: (k: PkgForm) => void
  /** shown only when the package can go on a load */
  onLoad?: (() => void) | null
  /** shown only when the package can be removed */
  onRemove?: (() => void) | null
  onFlag?: ((why: string) => void) | null
  onClear?: (() => void) | null
  /** greyed out (in a processing run, on a mixed pallet, on a load that can't change ...) */
  off?: { split?: boolean; merge?: boolean; addto?: boolean; remove?: boolean }
}) {
  const [why, setWhy] = useState<string | null>(null)
  const sz = big ? 'big' : 'small'
  const main = <>
    {move && <button className={big ? 'primary big' : 'ghost small'} disabled={busy} onClick={move.run}>{move.label}</button>}
    <button className={`ghost ${sz}`} disabled={busy || !!off.split || !p.current_weight} onClick={() => onForm('split')}>New package</button>
    <button className={`ghost ${sz}`} disabled={busy || !!off.merge || !p.strain} onClick={() => onForm('merge')}>Merge</button>
  </>
  const rest = <>
    <button className="ghost small" disabled={busy || !!off.addto} onClick={() => onForm('addto')}>Pull for mixed pallet</button>
    {onLoad && <button className="ghost small" disabled={busy} onClick={onLoad}>Put on a load</button>}
    <button className="ghost small" disabled={busy} onClick={() => onForm('weight')}>Adjust weight</button>
    <button className="ghost small" disabled={busy} onClick={() => onForm('tag')}>{p.package_tag ? 'Edit tag' : 'Enter tag'}</button>
    {p.needs_review && onClear && <button className="ghost small" disabled={busy} onClick={onClear}>Clear flag</button>}
    {onFlag && <button className="ghost small" disabled={busy} onClick={() => setWhy(p.needs_review ?? '')}>{p.needs_review ? 'Change flag' : 'Flag for review'}</button>}
    {onRemove && <button className="ghost small danger" disabled={busy || !!off.remove} onClick={onRemove}>Remove</button>}
  </>
  return <>
    {big ? <><div className="row actions">{main}</div><div className="row">{rest}</div></> : <div className="row invacts">{main}{rest}</div>}
    {why != null && onFlag && <div className="flagform">
      <label><span>Why does {p.code} need review?</span>
        <input autoFocus value={why} placeholder="e.g. Not on the reefer sheet, can't find it" onChange={e => setWhy(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && why.trim()) { onFlag(why.trim()); setWhy(null) } if (e.key === 'Escape') setWhy(null) }} /></label>
      <div className="row"><button className="ghost small" onClick={() => setWhy(null)}>Cancel</button>
        <button className="primary small" disabled={busy || !why.trim()} onClick={() => { onFlag(why.trim()); setWhy(null) }}>Flag it</button></div>
    </div>}
  </>
}
