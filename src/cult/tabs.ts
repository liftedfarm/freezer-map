// Production (Cultivation) screens: shared by the app's navigation and the module itself
export type CultTab = 'dashboard' | 'schedule' | 'week' | 'testing' | 'avail' | 'plantings' | 'yields' | 'plan' | 'setup'
export const CULT_TABS: { t: CultTab; l: string; bottom?: boolean }[] = [
  { t: 'dashboard', l: 'Dashboard', bottom: true }, { t: 'schedule', l: 'Schedule', bottom: true }, { t: 'week', l: 'Week', bottom: true }, { t: 'testing', l: 'Testing', bottom: true },
  { t: 'plantings', l: 'Fields' }, { t: 'avail', l: 'Availability' }, { t: 'yields', l: 'Yields' }, { t: 'plan', l: 'Plan' }, { t: 'setup', l: 'Setup' },
]
