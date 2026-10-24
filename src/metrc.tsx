// What each inventory action means in METRC. Shown in the action dialogs so the person doing it
// knows what lands on the Compliance > METRC to-do list (the server queues it from the event).
import type { Pallet, Product } from './types'
import { PRODUCT_LABEL } from './types'

export type InvAction = 'move' | 'split' | 'merge' | 'addto' | 'load' | 'weight' | 'tag' | 'remove'

const DRY: Product[] = ['wet', 'unbucked', 'bucked', 'bucked_standards', 'standards', 'smalls', 'trim']
export const isDry = (p: Pallet) => DRY.includes((p.product ?? 'fresh_frozen') as Product)
const item = (p: Pallet) => PRODUCT_LABEL[(p.product ?? 'fresh_frozen') as Product] ?? 'Fresh Frozen'
const tagOf = (p: Pallet) => p.package_tag ? `…${p.package_tag.slice(-6)}` : 'its tag'

/** METRC package adjustment reasons we use (CA). The code goes in the event details. */
export const WEIGHT_REASONS: { k: string; l: string; hint: string }[] = [
  { k: 'drying', l: 'Drying (moisture loss)', hint: 'Lost weight while it dried or sat in the reefer' },
  { k: 'scale', l: 'Scale variance', hint: 'Reweighed and the scale reads different' },
  { k: 'waste', l: 'Waste', hint: 'Mold, stems or refuse pulled out' },
  { k: 'entry', l: 'Entry error', hint: 'The number in the app or METRC was typed wrong' },
]
export const defaultReason = (p: Pallet) => (p.product === 'wet' || p.product === 'unbucked') ? 'drying' : 'scale'

export function metrcText(kind: InvAction, p: Pallet, opt: { reason?: string; removeReason?: string; n?: number } = {}): string {
  switch (kind) {
    case 'move': return 'No METRC change while it stays at this site. Product going to the other farm goes on a load (transfer manifest).'
    case 'split': return `New ${item(p)} package split from ${tagOf(p)} with the new tag, same item and harvest batch. ${p.code} keeps the rest under its tag.`
    case 'merge': return `New ${item(p)} package made from ${opt.n ? `${opt.n} packages` : 'these packages'} (same item only) with the new tag. The old tags go to 0 and are finished.`
    case 'addto': return 'Whole packages keep their tags: nothing to do in METRC. A partial amount is split into a new package with its own tag.'
    case 'load': return 'When the stop is delivered it goes on the METRC to-do list: a transfer manifest to the customer or the other license.'
    case 'weight': { const r = WEIGHT_REASONS.find(x => x.k === opt.reason)
      return `Package adjustment on ${tagOf(p)}${r ? `, reason ${r.l.replace(/ \(.*\)/, '')}` : ''}. The difference is the adjustment amount.` }
    case 'tag': return p.package_tag ? 'Fixes the tag on the record. If METRC has the old tag, correct it there too.' : 'Create this package in METRC with this tag.'
    case 'remove': return opt.removeReason === 'used' ? `Adjust ${tagOf(p)} to 0 lbs${isDry(p) ? ' (waste or drying)' : ''} and finish the package.`
      : opt.removeReason === 'shipped' ? 'Check it left on a METRC manifest. If it did, nothing else to do.'
      : opt.removeReason === 'mistake' ? 'Nothing in METRC, unless it was created there by mistake too (then void it there).'
      : 'Pick a reason to see what to do in METRC.'
  }
}

/** small box at the bottom of an action dialog */
export function MetrcNote({ kind, p, ...opt }: { kind: InvAction; p: Pallet; reason?: string; removeReason?: string; n?: number }) {
  return <div className="metrcnote"><b>METRC</b> {metrcText(kind, p, opt)}</div>
}
