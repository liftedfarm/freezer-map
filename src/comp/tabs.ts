// Compliance screens: shared by the app's navigation and the module itself
export type CTab = 'dashboard' | 'metrc' | 'ccof' | 'library' | 'deadlines' | 'fleet' | 'review' | 'activity' | 'settings'
export const COMP_TABS: { t: CTab; l: string }[] = [
  { t: 'dashboard', l: 'Dashboard' }, { t: 'deadlines', l: 'Deadlines' }, { t: 'library', l: 'Library' }, { t: 'ccof', l: 'CCOF' }, { t: 'metrc', l: 'METRC' }, { t: 'fleet', l: 'Vehicles' },
]
/** bottom of the menu, same in every module ('settings' is Compliance Admins only) */
export const COMP_TAIL: { t: CTab; l: string }[] = [{ t: 'review', l: 'Review' }, { t: 'activity', l: 'Activity' }, { t: 'settings', l: 'Settings' }]
