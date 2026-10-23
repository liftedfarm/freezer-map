// Processing screens: shared by the app's navigation and the module itself
export type PTab = 'dashboard' | 'incoming' | 'runs' | 'crew' | 'available' | 'inventory' | 'yields' | 'review' | 'activity' | 'settings'
export const PROC_TABS: { t: PTab; l: string }[] = [
  { t: 'dashboard', l: 'Dashboard' }, { t: 'inventory', l: 'Inventory' }, { t: 'crew', l: 'Crew' }, { t: 'available', l: 'Available' },
  { t: 'incoming', l: 'Drying' }, { t: 'runs', l: 'Runs' }, { t: 'yields', l: 'Yields' },
]
/** bottom of the menu, same in every module ('settings' is Processing Admins only) */
export const PROC_TAIL: { t: PTab; l: string }[] = [{ t: 'review', l: 'Review' }, { t: 'activity', l: 'Activity' }, { t: 'settings', l: 'Settings' }]
