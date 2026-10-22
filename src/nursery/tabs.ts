import type { NTab } from './types'
// Nursery screens: shared by the app's navigation and the module itself
export const NURSERY_TABS: { t: NTab; l: string }[] = [
  { t: 'dashboard', l: 'Dashboard' }, { t: 'plan', l: 'Plan' }, { t: 'orders', l: 'Orders' }, { t: 'batches', l: 'Batches' }, { t: 'mothers', l: 'Mothers' },
  { t: 'logs', l: 'Logs' }, { t: 'invoices', l: 'Invoices' },
]
/** bottom of the menu, same in every module ('settings' is Nursery Admins only) */
export const NURSERY_TAIL: { t: NTab; l: string }[] = [{ t: 'review', l: 'Review' }, { t: 'activity', l: 'Activity' }, { t: 'settings', l: 'Settings' }]
export const nurseryLabel = (t: NTab) => [...NURSERY_TABS, ...NURSERY_TAIL].find(x => x.t === t)?.l ?? 'Nursery'
export type { NTab }
