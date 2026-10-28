// Production (Cultivation) screens: shared by the app's navigation and the module itself
export type CultTab = 'dashboard' | 'receiving' | 'harvest' | 'schedule' | 'week' | 'testing' | 'avail' | 'plantings' | 'yields' | 'plan' | 'logs' | 'review' | 'activity' | 'setup'
/** main screens, top of the menu */
export const CULT_TABS: { t: CultTab; l: string }[] = [
  { t: 'dashboard', l: 'Dashboard' }, { t: 'receiving', l: 'Receiving' }, { t: 'harvest', l: 'Harvest' }, { t: 'schedule', l: 'Schedule' }, { t: 'week', l: 'Week' }, { t: 'testing', l: 'Testing' },
  { t: 'plantings', l: 'Fields' }, { t: 'avail', l: 'Availability' }, { t: 'yields', l: 'Yields' }, { t: 'plan', l: 'Plan' }, { t: 'logs', l: 'Logs' },
]
/** bottom of the menu, same in every module ('setup' is Production settings, Admins only) */
export const CULT_TAIL: { t: CultTab; l: string }[] = [{ t: 'review', l: 'Review' }, { t: 'activity', l: 'Activity' }, { t: 'setup', l: 'Settings' }]
export const cultLabel = (t: CultTab) => [...CULT_TABS, ...CULT_TAIL].find(x => x.t === t)?.l ?? 'Production'
