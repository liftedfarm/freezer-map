// Icons for the phone bottom bar, by screen key. Simple line icons, 24px grid, currentColor.
import type { ReactNode } from 'react'

const I = ({ children }: { children: ReactNode }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const dash = <I><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></I>
const box = <I><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></I>
const check = <I><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></I>
const clip = <I><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" /></I>
const cal = <I><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></I>
const list = <I><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></I>
const truck = <I><path d="M2 7h12v9H2zM14 10h4l3 3v3h-7" /><circle cx="6" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></I>
const leaf = <I><path d="M12 21V11M12 11c0-4 3-7 8-7 0 5-3 8-8 7zM12 13c0-3-2-6-7-6 0 4 2 7 7 6z" /></I>
const users = <I><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5" /><circle cx="17" cy="9" r="2.5" /><path d="M16 15c3 0 5 2 5 5" /></I>
const sun = <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>
const cycle = <I><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></I>
const chart = <I><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></I>
const send = <I><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></I>
const book = <I><path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z" /></I>
const money = <I><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></I>
const clock = <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>
const seal = <I><circle cx="12" cy="9" r="6" /><path d="M9 14l-2 7 5-3 5 3-2-7" /></I>
const tag = <I><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.5" /></I>
const inbox = <I><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 3h6l1-3h5" /></I>
const pulse = <I><path d="M3 12h4l3-8 4 16 3-8h4" /></I>
const gear = <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>
const map = <I><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></I>
const sprout = <I><path d="M7 20h10l-1.5-6h-7z" /><path d="M12 14V9M12 9c0-3-2-5-5-5 0 3 2 5 5 5zM12 9c0-2.5 2-4.5 5-4.5 0 2.5-2 4.5-5 4.5z" /></I>
const dot = <I><circle cx="12" cy="12" r="3" /></I>

export const SCAN_ICON = <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M8 9v6M11 9v6M14 9v6M17 9v6" /></svg>

const BY_KEY: Record<string, ReactNode> = {
  dash: dash, dashboard: dash, map, inventory: box, fulfill: check, transit: truck, review: inbox, activity: pulse, settings: gear, setup: gear,
  menu: list, orders: clip, invoices: money, requests: inbox, customer: users, strain: leaf,
  harvest: leaf, schedule: cal, week: cal, testing: check, plantings: map, avail: chart, yields: chart, plan: cal, logs: list,
  batches: sprout, mothers: sprout, breeding: sprout,
  crew: users, incoming: sun, runs: cycle,
  send, sent: book, payroll: money,
  deadlines: clock, library: book, ccof: seal, metrc: tag, fleet: truck,
}
export const screenIcon = (k: string) => BY_KEY[k] ?? dot
