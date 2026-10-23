// Accounting screens: shared by the app's navigation and the module itself
export type ATab = 'dashboard' | 'send' | 'sent' | 'review' | 'activity' | 'settings'
export const ACCT_TABS: { t: ATab; l: string }[] = [{ t: 'dashboard', l: 'Dashboard' }, { t: 'send', l: 'To send' }, { t: 'sent', l: 'In QuickBooks' }]
/** bottom of the menu, same in every module ('settings' is Accounting Admins only) */
export const ACCT_TAIL: { t: ATab; l: string }[] = [{ t: 'review', l: 'Review' }, { t: 'activity', l: 'Activity' }, { t: 'settings', l: 'Settings' }]
