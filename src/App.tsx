import { Select } from './combo'
import { Scanner } from './scan'
import { routeScan, sameTag } from './scanroute'
import { screenIcon, SCAN_ICON } from './icons'
import { useScrimBack, useTabHistory, scrollTop } from './nav'
import { StrainCardHost, StrainLink } from './strainCard'
import { CompFleet, CrewFleet } from './fleet/Fleet'
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Backend, CONFIG_MISSING, IS_PORTAL, makeBackend, portalUrl } from './api'
import { FREEZER_STATUSES, PRODUCT_LABEL, PRODUCT_SHORT, FINISH_LABEL } from './types'
import { DistInventory, SalesInventory } from './inventory'
import type { InvCtx } from './inventory'
import { MergeForm, MergeHere, MixedBuilder, NewPalletChooser, PickMixed, SingleForm, SplitForm, TagForm, WeightForm, lbs } from './forms'
import { SettingsView } from './settings'
import { ModulePeople, UsersTab } from './users'
import { PermissionsPanel } from './perms'
import { AdminDashboard, AdminReview, AppSettingsPanel } from './admin'
import type { Jump } from './admin'
import { DeadlinesPanel, SalesDashboard, SalesReview } from './salesdash'
import { MySettings } from './mine'
import { DocSheet, InvoicesView, NewOrderSheet, SharedDocPage, TermsPanel } from './invoices'
import { FulfillView, STATE_LABEL } from './fulfill'
import { applyTheme } from './theme'
import { money } from './docs'
import { EMPTY, active, addMoves, addToTray, backToTray, dropFromPlan, fillStaging, laneShuffle, occupants, place, slotView, suggestions, toSave } from './plan'
import type { Layout, Plan, PlanMove, PlaceMode } from './plan'
import { DragGhost, draggable, onDrop } from './drag'
import { ChooseDialog, PlanBar, RemoveForm, SelectBar, UndoPill } from './planui'
import { isDry, WEIGHT_REASONS } from './metrc'
import { ArchivedView, restoreOne } from './archived'
import type { InvAction } from './metrc'
import { ReservesView, SALES_TITLES } from './reserves'
import type { SalesMode } from './reserves'
import { Portal, PortalLink, PortalLogin } from './portal'
import { BonusScreen } from './bonus'
import { DistLocations } from './locations'
import { DistDashboard } from './distdash'
import { CULT_TABS, CULT_TAIL } from './cult/tabs'
import type { CultTab } from './cult/tabs'
import { NURSERY_TABS, NURSERY_TAIL } from './nursery/tabs'
import type { NTab } from './nursery/tabs'
import { ACCT_TABS, ACCT_TAIL } from './acct/tabs'
import { PROC_TABS, PROC_TAIL } from './proc/tabs'
import { COMP_TABS, COMP_TAIL } from './comp/tabs'
import type { CTab } from './comp/tabs'
import type { PTab } from './proc/tabs'
import type { ATab } from './acct/tabs'
import { LicensesPanel, PURPOSE_LABEL } from './licenses'
import { TestRows } from './comp/trace'
import { LoadForm, LoadView, PickLoad, TransitView, stopColor } from './loads'
import { InboundView } from './inbound'
import { ReceivingView } from './receiving'
import { FillTolerance, ShippingQuote, ShippingSettings, rpc } from './ship'
import { metrcRun } from './metrcCall'
import { TagSuggestProvider } from './tagSuggest'
import type { LoadCtx } from './loads'
import { lang, setLang, t } from './i18n'
import { setMyAccess } from './fold'
import { WeatherBar } from './weather'
import type { Grade, Item, HarvestLot, FOrder, ModKey, UnmatchedTag, ShippedCheck, Freezer, Me, FreezerStatus, InvEvent, Load, LoadItem, LoadStop, Pallet, Site, Slot, Snapshot } from './types'

const backend: Backend = makeBackend()
// Cultivation module: its own bundle, only loaded for users who have it switched on
const CultView = lazy(() => import('./cult/CultView'))
const NurseryView = lazy(() => import('./nursery/NurseryView'))
const AccountingView = lazy(() => import('./acct/AccountingView'))
const ProcessingView = lazy(() => import('./proc/ProcessingView'))
const ComplianceView = lazy(() => import('./comp/ComplianceView'))

type View = 'dash' | 'inventory' | 'fulfill' | 'map' | 'freezer' | 'transit' | 'load' | 'review' | 'activity' | 'settings' | 'sales' | 'cult' | 'nursery' | 'proc' | 'acct' | 'comp' | 'admin' | 'mine' | 'fleet' | 'inbound' | 'archived'
// modules: each person has a level (User / Admin) per module; Owners have all of them (Admin > Settings > Users)
type Mod = 'dist' | 'sales' | 'cult' | 'nurs' | 'proc' | 'acct' | 'comp' | 'admin'
const MOD_KEY: Record<Mod, ModKey> = { dist: 'distribution', sales: 'sales', cult: 'cultivation', nurs: 'nursery', proc: 'processing', acct: 'accounting', comp: 'compliance', admin: 'admin' }
const KEY_MOD: Record<ModKey, Mod> = { distribution: 'dist', sales: 'sales', cultivation: 'cult', nursery: 'nurs', processing: 'proc', accounting: 'acct', compliance: 'comp', admin: 'admin' }
/** Admin > Settings: every module's settings in one place */
const ALL_SETTINGS: [Mod, string][] = [['admin', 'Admin'], ['dist', 'Distribution'], ['sales', 'Sales'], ['cult', 'Production'], ['nurs', 'Nursery'], ['proc', 'Processing'], ['acct', 'Accounting'], ['comp', 'Compliance']]
const MOD_LABEL: Record<Mod, string> = { dist: 'Distribution', sales: 'Sales', cult: 'Production', nurs: 'Nursery', proc: 'Processing', acct: 'Accounting', comp: 'Compliance', admin: 'Admin' }
const ML = (m: Mod) => t(MOD_LABEL[m])
const MOD_WHAT: Record<Mod, string> = { dist: 'Freezer map · transit · review', sales: 'Reserves · menu · orders', cult: 'Harvests · fields · plan', nurs: 'Mothers · cuttings · deliveries', proc: 'Drying · bucking · trimming', acct: 'Invoices to QuickBooks · payments', comp: 'METRC · CCOF · documents · deadlines', admin: 'Company · users · app settings' }
type SalesTab = 'dash' | 'inventory' | SalesMode | 'invoices' | 'shipping' | 'review' | 'activity' | 'settings'
type AdminTab = 'dash' | 'review' | 'activity' | 'settings'
/** s: short plain label for the phone bar; n: count badge (warn = amber) */
interface NavItem { k: string; l: ReactNode; s?: string; n?: number; warn?: boolean; on: boolean; go: () => void }
const MOD_SHORT: Record<Mod, string> = { dist: 'Dist', sales: 'Sales', cult: 'Prod', nurs: 'Nursery', proc: 'Proc', acct: 'Acct', comp: 'Comp', admin: 'Admin' }
const MOD_ICON: Record<Mod, ReactNode> = {
  dist: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="1" y="7" width="14" height="10" /><path d="M15 10h4l3 3v4h-7" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /></svg>,
  sales: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>,
  cult: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 22V12M12 12C12 7 8 4 3 4c0 5 4 8 9 8zM12 12c0-4 3-7 8-7 0 4-3 7-8 7z" /></svg>,
  nurs: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 20h10l-1.5-6h-7z" /><path d="M12 14V9" /><path d="M12 9c0-3-2-5-5-5 0 3 2 5 5 5zM12 9c0-2.5 2-4.5 5-4.5 0 2.5-2 4.5-5 4.5z" /></svg>,
  proc: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" /></svg>,
  acct: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 10h2M14 10h2M8 14h2M14 14h2M8 18h2M14 18h2" /></svg>,
  comp: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="m9 15 2 2 4-4" /></svg>,
  admin: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3z" /><path d="m9 12 2 2 4-4" /></svg>,
}
const stored = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

// ---------- helpers ----------

// custom map colors from the Strains list (name or other names), set when data loads
let strainColors = new Map<string, string>()
function setStrainColors(snap: Snapshot) {
  strainColors = new Map((snap.strains ?? []).filter(s => s.color).flatMap(s => [s.name, ...(s.aliases ?? [])].map(n => [n.toLowerCase(), s.color!] as [string, string])))
}
function swatch(strain: string | null | undefined): { cls: string; style?: React.CSSProperties } {
  const c = strain ? strainColors.get(strain.toLowerCase()) : undefined
  if (c) return { cls: 'cc', style: { ['--c' as string]: c } }
  const h = hue(strain ?? null)
  return h < 0 ? { cls: 'unk' } : { cls: '', style: { ['--h' as string]: h } }
}
function hue(strain: string | null) {
  if (!strain) return -1
  let h = 0
  for (const c of strain.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const who = (email: string | null) => (email ?? '').split('@')[0]

function matches(p: Pallet, q: string, ix?: Index): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  if ([p.code, p.strain, p.package_tag, p.label].some(v => v?.toLowerCase().includes(s))) return true
  return p.kind === 'mixed' && !!ix && (ix.contentsOf.get(p.id) ?? []).some(c => matches(c, q))
}

interface Index {
  freezer: Map<number, Freezer>
  slot: Map<number, Slot>
  slotsOf: Map<number, Slot[]>
  inSlot: Map<number, Pallet[]>      // top-level pallets in a slot (not the packages on a mixed pallet)
  contentsOf: Map<number, Pallet[]>  // packages on each mixed pallet
  pallet: Map<number, Pallet>
  loadOf: Map<number, { item: LoadItem; load: Load; stop: LoadStop }>  // pallets on an open load
  sku: Map<number, Item>             // items (SKUs) by id
  lot: Map<number, HarvestLot>       // harvest lots by id
  strainGrade: Map<string, Grade>    // strain default grade by lower-case name or alias
}

function buildIndex(s: Snapshot): Index {
  const freezer = new Map(s.freezers.map(f => [f.id, f]))
  const slot = new Map(s.slots.map(x => [x.id, x]))
  const slotsOf = new Map<number, Slot[]>()
  for (const x of s.slots) (slotsOf.get(x.freezer_id) ?? slotsOf.set(x.freezer_id, []).get(x.freezer_id)!).push(x)
  const inSlot = new Map<number, Pallet[]>()
  const contentsOf = new Map<number, Pallet[]>()
  for (const p of s.pallets) {
    if (p.container_id) (contentsOf.get(p.container_id) ?? contentsOf.set(p.container_id, []).get(p.container_id)!).push(p)
    else if (p.slot_id != null) (inSlot.get(p.slot_id) ?? inSlot.set(p.slot_id, []).get(p.slot_id)!).push(p)
  }
  const loadOf = new Map<number, { item: LoadItem; load: Load; stop: LoadStop }>()
  for (const it of s.items ?? []) {
    const load = s.loads?.find(l => l.id === it.load_id), stop = s.stops?.find(x => x.id === it.stop_id)
    if (load && stop && ['planning', 'loading', 'in_transit'].includes(load.status)) loadOf.set(it.pallet_id, { item: it, load, stop })
  }
  const strainGrade = new Map<string, Grade>()
  for (const st of s.strains ?? []) if (st.default_grade) for (const n of [st.name, ...(st.aliases ?? [])]) strainGrade.set(n.toLowerCase().trim(), st.default_grade)
  return { freezer, slot, slotsOf, inSlot, contentsOf, loadOf, pallet: new Map(s.pallets.map(p => [p.id, p])),
    sku: new Map((s.skus ?? []).map(i => [i.id, i])), lot: new Map((s.lots ?? []).map(l => [l.id, l])), strainGrade }
}

/** SHO / BHO that applies to a pallet: this pallet > its harvest lot > the strain default */
function gradeOf(ix: Index, p: Pallet): { grade: Grade; from: 'pallet' | 'lot' | 'strain' } {
  if (p.grade) return { grade: p.grade, from: 'pallet' }
  const l = p.lot_id != null ? ix.lot.get(p.lot_id) : undefined
  if (l?.grade) return { grade: l.grade, from: 'lot' }
  return { grade: ix.strainGrade.get((p.strain ?? '').toLowerCase().trim()) ?? 'SHO', from: 'strain' }
}

/** weight of a pallet; a mixed pallet weighs what's on it */
function weightOf(ix: Index, p: Pallet) {
  return p.kind === 'mixed' ? (ix.contentsOf.get(p.id) ?? []).reduce((a, c) => a + (c.current_weight ?? 0), 0) : (p.current_weight ?? 0)
}
const isPackage = (p: Pallet) => p.kind !== 'mixed'
const loose = (p: Pallet) => isPackage(p) && !p.container_id && (p.status === 'in_freezer' || p.status === 'unslotted')

/** freezer names: F12 / Freezer 12, trailers R1 / Reefer 1 (GVR 101-104) */
export const fShort = (f: Freezer) => f.kind === 'trailer' ? `R${f.number - 100}` : `F${f.number}`
export const fName = (f: Freezer) => f.kind === 'trailer' ? `Reefer ${f.number - 100}` : `Freezer ${f.number}`

function whereIs(ix: Index, slotId: number | null) {
  if (slotId == null) return 'Needs a spot'
  const s = ix.slot.get(slotId)
  if (!s) return '?'
  const f = ix.freezer.get(s.freezer_id)!
  return f.kind === 'staging' ? `${f.site} Staging · ${s.row}` : f.kind === 'trailer' ? `${f.site} ${fName(f)} · ${s.code.slice(2)}` : `${f.site} F${f.number} · ${s.code}`
}

function describe(ix: Index, e: InvEvent, names?: Map<number, string>) {
  const code = e.pallet_id != null ? (ix.pallet.get(e.pallet_id)?.code ?? names?.get(e.pallet_id) ?? (e.details as { code?: string } | null)?.code ?? `#${e.pallet_id}`) : ''
  switch (e.type) {
    case 'move': { const k = (e.details as { kind?: string } | null)?.kind
      return `${code} ${k === 'swap' ? 'swapped' : k === 'shuffle' ? 'shuffled' : k === 'undo' ? 'moved back' : 'moved'} ${whereIs(ix, e.from_slot_id)} to ${whereIs(ix, e.to_slot_id)}` }
    case 'removed': { const r = (e.details as { reason?: string } | null)?.reason
      return `${code} removed: ${r === 'used' ? 'used up' : r === 'shipped' ? 'shipped outside the app' : 'entered by mistake'} (${lbs(e.lbs)})` }
    case 'unslot': return `${code} taken out of ${whereIs(ix, e.from_slot_id)}`
    case 'restored': { const d = e.details as { site?: string; staging?: boolean } | null
      return `${code} brought back from Archived to ${e.to_slot_id != null ? whereIs(ix, e.to_slot_id) : `Needs a spot at ${d?.site ?? ''}`} (${lbs(e.lbs)})` }
    case 'pallet_deleted': return `${code} deleted for good (was archived, ${lbs(e.lbs)})`
    case 'created': return `${code} entered by hand at ${whereIs(ix, e.to_slot_id)} (${lbs(e.lbs)})`
    case 'mixed_created': { const d = e.details as { packages?: string[] } | null
      return `${code} mixed pallet started at ${whereIs(ix, e.to_slot_id)} with ${(d?.packages ?? []).join(', ')}` }
    case 'mixed_added': { const d = e.details as { packages?: string[] } | null
      return `${code}: added ${(d?.packages ?? []).join(', ')}` }
    case 'mixed_on': { const d = e.details as { mixed?: string } | null
      return `${code} put on mixed pallet ${d?.mixed} (${lbs(e.lbs)})` }
    case 'mixed_off': { const d = e.details as { mixed?: string; broken?: boolean } | null
      return d?.broken ? `${code} unstacked from ${d?.mixed}, now its own pallet` : `${code} taken off ${d?.mixed} to ${whereIs(ix, e.to_slot_id)}` }
    case 'mixed_broken': { const d = e.details as { packages?: string[] } | null
      return `${code} broken apart: ${(d?.packages ?? []).join(', ')} now separate` }
    case 'import': return `${code} imported at ${whereIs(ix, e.to_slot_id)}`
    case 'review_cleared': return `${code} review flag cleared`
    case 'review_flagged': return `${code} flagged for review: ${e.note ?? ''}`
    case 'split': { const d = e.details as { child?: string; remaining?: number; mixed?: string } | null
      return `${code} split: ${lbs(e.lbs)} off to ${d?.child}${d?.mixed ? ` (onto ${d.mixed})` : ''}, ${lbs(d?.remaining)} left` }
    case 'split_from': { const d = e.details as { parent?: string; tag?: string | null; mixed?: string } | null
      return `${code} created from ${d?.parent} (${lbs(e.lbs)})${d?.mixed ? ` onto ${d.mixed}` : ''}${d?.tag ? '' : ', tag pending'}` }
    case 'merge': { const d = e.details as { sources?: string[] } | null
      return `${code} made by merging ${(d?.sources ?? []).join(', ')} (${lbs(e.lbs)})` }
    case 'merged_into': { const d = e.details as { into?: string } | null
      return `${code} merged into ${d?.into} (${lbs(e.lbs)})` }
    case 'tag_set': { const d = e.details as { from?: string | null; to?: string } | null
      return `${code} METRC tag ${d?.from ? `changed from ${d.from} ` : ''}set to ${d?.to}` }
    case 'weight_adjust': { const d = e.details as { from?: number | null; to?: number; reason?: string } | null
      const r = WEIGHT_REASONS.find(x => x.k === d?.reason)
      return `${code} weight adjusted ${d?.from != null ? `from ${lbs(d.from)} ` : ''}to ${lbs(d?.to)}${r ? ` (${r.l})` : ''}` }
    case 'weight_audit': { const d = e.details as { from?: number | null; to?: number } | null
      return `${code} weight set ${d?.from != null ? `from ${lbs(d.from)} ` : ''}to ${lbs(d?.to)} in the app only (audit, not sent to METRC)` }
    case 'manifest_sync': { const d = e.details as { manifest?: string; tag?: string; to_site?: string; shipped_to?: string; new?: boolean; from?: string | number; to?: number } | null
      const m = `manifest ${d?.manifest ?? ''} (already in METRC)`
      const tg = d?.tag ? ` …${d.tag.slice(-6)}` : ''
      if (d?.shipped_to) return d.new ? `${code}${tg} added as shipped to ${d.shipped_to} from ${d.from ?? ''}: ${m}` : `${code}${tg} shipped to ${d.shipped_to}: ${m}`
      if (d?.to_site) return d.new ? `${code}${tg} made from ${d.from ?? ''} and sent to ${d.to_site}: ${m}` : `${code} tagged${tg}, sent to ${d.to_site}: ${m}`
      if (typeof d?.from === 'number' || d?.to != null) return `${code} weight ${d?.from != null ? `from ${lbs(Number(d.from))} ` : ''}to ${lbs(d?.to)}: ${m}`
      return `${code} caught up with ${m}` }
    case 'freezer_status': {
      const f = e.freezer_id != null ? ix.freezer.get(e.freezer_id) : undefined
      const d = e.details as { from?: string; to?: string } | null
      return `${f ? `${f.site} Freezer ${f.number}` : 'Freezer'}: ${d?.from} to ${d?.to}`
    }
    case 'sheet_sync': { const d = e.details as { strain?: string; weight?: number } | null
      return `${code} filled in from the spreadsheet: ${d?.strain ?? ''} ${lbs(d?.weight)}` }
    case 'load_created': return `Load ${(e.details as { load?: string } | null)?.load} created`
    case 'load_updated': return `Load ${(e.details as { load?: string } | null)?.load} edited`
    case 'load_planned': { const d = e.details as { load?: string; position?: number } | null
      return `${code} planned on ${d?.load}, position ${d?.position}` }
    case 'load_removed': return `${code} removed from ${(e.details as { load?: string } | null)?.load}`
    case 'loaded': { const d = e.details as { load?: string; position?: number } | null
      return `${code} pulled from ${whereIs(ix, e.from_slot_id)} onto ${d?.load}, position ${d?.position}` }
    case 'unloaded': return `${code} taken off ${(e.details as { load?: string } | null)?.load}, back to ${whereIs(ix, e.to_slot_id)}`
    case 'load_departed': return `Load ${(e.details as { load?: string } | null)?.load} departed`
    case 'load_cancelled': return `Load ${(e.details as { load?: string } | null)?.load} cancelled`
    case 'stop_delivered': { const d = e.details as { load?: string; customer?: string; seq?: number } | null
      return `${d?.load} stop ${d?.seq} delivered to ${d?.customer}` }
    case 'shipped_out': return `${code} taken out of inventory: ${e.note ?? 'shipped'} (${lbs(e.lbs)})`
    case 'shipped': { const d = e.details as { load?: string; customer?: string } | null
      return `${code} delivered to ${d?.customer} on ${d?.load} (${lbs(e.lbs)})` }
    case 'received': { const d = e.details as { load?: string; customer?: string } | null
      return `${code} received at ${d?.customer} from ${d?.load}, needs a spot` }
    case 'strain_renamed': { const d = e.details as { from?: string; to?: string } | null
      return `${code} strain renamed from ${d?.from} to ${d?.to}` }
    case 'settings': { const d = e.details as { list?: string; name?: string; active?: boolean } | null
      return `${d?.list ? d.list[0].toUpperCase() + d.list.slice(1, -1) : 'Setting'} "${d?.name}" ${e.note === 'added' ? 'added' : d?.active === false ? 'retired' : 'updated'}` }
    case 'user_role': { const d = e.details as { email?: string; role?: string; was?: string } | null
      return d?.was ? `${d?.email} changed from ${d.was} to ${d.role}` : `${d?.email} added as ${d?.role}` }
    case 'reserve_set': { const d = e.details as { customer?: string; strain?: string; lbs?: number; was?: number | null } | null
      return d?.lbs === 0 ? `Reserve removed: ${d?.customer} · ${d?.strain}` : `Reserve ${d?.was != null ? `changed ${lbs(Number(d.was))} →` : 'set:'} ${d?.customer} · ${d?.strain} ${lbs(Number(d?.lbs ?? 0))}` }
    case 'reserve_import': { const d = e.details as { rows?: number; lbs?: number; customers?: number } | null
      return `Reserves loaded from ${e.note ?? 'a file'}: ${d?.rows} reserves, ${d?.customers} customers, ${lbs(Number(d?.lbs ?? 0))}` }
    case 'reserve_request': { const d = e.details as { customer?: string; strain?: string; from?: number; to?: number } | null
      return `Reserve request: ${d?.customer} · ${d?.strain} ${lbs(Number(d?.from ?? 0))} → ${lbs(Number(d?.to ?? 0))}` }
    case 'reserve_approved': case 'reserve_declined': { const d = e.details as { customer?: string; strain?: string; from?: number; to?: number } | null
      return `Reserve request ${e.type === 'reserve_approved' ? 'approved' : 'declined'}: ${d?.customer} · ${d?.strain} ${lbs(Number(d?.from ?? 0))} → ${lbs(Number(d?.to ?? 0))}` }
    case 'user_removed': return `${e.note} removed from users`
    case 'fulfill_assigned': case 'fulfill_unassigned': case 'fulfill_cant_fill': case 'fulfill_can_fill': case 'fulfill_loaded': case 'fulfill_unloaded': case 'order_fill_ok': {
      const d = e.details as { customer?: string; so?: string; strain?: string; load?: string; from?: number; to?: number } | null
      const o = `${d?.customer ?? ''}${d?.so ? ` ${d.so}` : ''}`
      const code = e.pallet_id != null ? (ix.pallet.get(e.pallet_id)?.code ?? names?.get(e.pallet_id) ?? `#${e.pallet_id}`) : ''
      if (e.type === 'fulfill_assigned') return `${code} assigned to ${o}${e.lbs ? ` (${lbs(Number(e.lbs))})` : ''}`
      if (e.type === 'fulfill_unassigned') return `${code} unassigned from ${o}`
      if (e.type === 'fulfill_cant_fill') return `${o}: can't fill ${d?.strain}`
      if (e.type === 'fulfill_can_fill') return `${o}: ${d?.strain} back on`
      if (e.type === 'fulfill_loaded') return `${o} put on ${d?.load}`
      if (e.type === 'fulfill_unloaded') return `${o} taken off ${d?.load}`
      return `${o}: Sales OK'd ${d?.strain} at ${lbs(Number(d?.to ?? 0))} (ordered ${lbs(Number(d?.from ?? 0))})` }
    case 'user_access': { const d = e.details as { email?: string; owner?: boolean; kind?: string; access?: Record<string, string> } | null
      return `${d?.email}: ${d?.kind !== 'staff' ? d?.kind : d?.owner ? 'Owner' : Object.entries(d?.access ?? {}).map(([m, l]) => `${m === 'cultivation' ? 'production' : m} ${l}`).join(', ') || 'no modules'}` }
    case 'app_setting': { const d = e.details as { key?: string; value?: string } | null; return `App setting ${d?.key} set to ${d?.value}` }
    case 'user_hidden_modules': { const d = e.details as { email?: string; hidden?: string[] } | null
      return `${d?.email} hidden modules: ${(d?.hidden ?? []).join(', ') || 'none'}` }
    case 'user_modules': { const d = e.details as { email?: string; modules?: string[] } | null
      return `${d?.email} modules: ${(d?.modules ?? []).join(', ') || 'none'}` }
    case 'harvested': { const d = e.details as { strain?: string; site?: string; field?: string; tag?: string | null } | null
      return `${code} harvested: ${d?.strain} from ${d?.site} ${d?.field ?? ''} (${lbs(e.lbs)})${d?.tag ? '' : ', tag pending'}, needs a spot` }
    case 'proc_wet': { const d = e.details as { strain?: string; site?: string; field?: string; processor?: string; sent?: boolean; tag?: string | null } | null
      return `${code} wet package: ${d?.strain} from ${d?.site} ${d?.field ?? ''} (${lbs(e.lbs)})${d?.tag ? '' : ', tag pending'}${d?.sent ? `, sent to ${d.processor}` : ''}` }
    case 'proc_sent': { const d = e.details as { processor?: string } | null; return `${code} sent to ${d?.processor} for drying (${lbs(e.lbs)})` }
    case 'proc_received': { const d = e.details as { processor?: string; site?: string; new_tag?: string | null } | null
      return `${code} back from ${d?.processor ?? 'the processor'} unbucked, at ${d?.site}${d?.new_tag ? ` (new tag …${d.new_tag.slice(-6)})` : ''}` }
    case 'proc_dried': return `${code} dried in house, now unbucked`
    case 'proc_run_started': { const d = e.details as { run?: string; kind?: string; strain?: string; packages?: string[] } | null
      return `${d?.run} ${d?.kind === 'buck' ? 'bucking' : 'trimming'} started: ${d?.strain}, ${(d?.packages ?? []).join(', ')} (${lbs(e.lbs)})` }
    case 'proc_run_done': { const d = e.details as { run?: string; kind?: string; strain?: string; in?: number; out?: number; mold?: number; loss?: number } | null
      return `${d?.run} ${d?.kind === 'buck' ? 'bucked' : 'trimmed'}: ${d?.strain} ${lbs(Number(d?.in ?? 0))} in, ${lbs(Number(d?.out ?? 0))} out, ${lbs(Number(d?.mold ?? 0))} mold, ${lbs(Number(d?.loss ?? 0))} ${d?.kind === 'buck' ? 'moisture' : 'difference'}` }
    case 'proc_run_cancelled': { const d = e.details as { run?: string } | null; return `${d?.run} cancelled` }
    case 'proc_output': { const d = e.details as { run?: string; product?: string; strain?: string } | null; return `${code} ${d?.product} from ${d?.run}: ${d?.strain} (${lbs(e.lbs)}), needs a spot` }
    case 'proc_used': { const d = e.details as { run?: string; whole?: boolean } | null; return `${code} ${d?.whole ? 'used up' : `${lbs(e.lbs)} used`} in ${d?.run}` }
    case 'proc_request': { const d = e.details as { strain?: string; product?: string; due?: string; customer?: string; new?: boolean } | null
      return `Trim request ${d?.new ? 'added' : 'changed'}: ${lbs(e.lbs)} ${d?.strain} ${d?.product}${d?.customer ? ` for ${d.customer}` : ''}${d?.due ? `, due ${d.due}` : ''}` }
    case 'proc_request_status': { const d = e.details as { status?: string } | null; return `Trim request marked ${d?.status}` }
    case 'proc_settings': return `Processing settings: ${e.note}`
    case 'proc_promised': { const d = e.details as { so?: string; product?: string } | null; return `${lbs(e.lbs)} ${d?.product} from ${code} promised to ${d?.so}` }
    case 'proc_unpromised': return `Promise on ${code} taken off`
    case 'proc_promise_filled': { const d = e.details as { so?: string; product?: string; strain?: string } | null; return `${lbs(e.lbs)} ${d?.strain} ${d?.product} put on ${d?.so}` }
    case 'pay_day': { const d = e.details as { date?: string; task?: string; run?: string | null; strain?: string; rows?: number } | null
      return `Crew day logged: ${d?.date} ${d?.task === 'buck' ? 'bucking' : 'trimming'} ${d?.run ?? d?.strain ?? ''} (${d?.rows} ${d?.rows === 1 ? 'person' : 'people'})` }
    case 'pay_employee': return `Crew: ${e.note}`
    case 'pay_rate': { const d = e.details as { task?: string; rate?: number; target?: number; effective_from?: string } | null; return `Piece rate: ${d?.task === 'buck' ? 'bucking' : 'trimming'} $${d?.rate}/lb at ${d?.target} lb/hr from ${d?.effective_from}` }
    case 'pay_closed': { const d = e.details as { starts?: string; total?: number } | null; return `Pay period from ${d?.starts} closed${d?.total != null ? ` ($${Number(d.total).toFixed(2)})` : ''}` }
    case 'pay_reopened': { const d = e.details as { starts?: string } | null; return `Pay period from ${d?.starts} reopened` }
    case 'pay_exported': { const d = e.details as { starts?: string } | null; return `Pay period from ${d?.starts} sent to payroll` }
    case 'pay_adjusted': { const d = e.details as { starts?: string; employee?: string; amount?: number; reason?: string; removed?: number } | null
      return d?.removed ? `Pay adjustment removed (period from ${d?.starts})` : `Pay adjustment: ${d?.employee} $${d?.amount} (${d?.reason})` }
    case 'order_created': { const d = e.details as { so?: string; customer?: string; lines?: number } | null; return `${d?.so ?? 'Order'} created for ${d?.customer ?? ''}${d?.lines ? ` (${d.lines} line${d.lines === 1 ? '' : 's'})` : ''}` }
    case 'acct_sent': { const d = e.details as { inv?: string; env?: string; total?: number } | null
      return `${d?.inv} sent to ${d?.env === 'production' ? 'QuickBooks' : 'the QuickBooks sandbox'}${d?.total != null ? ` (${money(Number(d.total))})` : ''}` }
    case 'acct_error': { const d = e.details as { inv?: string; env?: string } | null; return `${d?.inv} couldn't go to ${d?.env === 'production' ? 'QuickBooks' : 'the sandbox'}` }
    case 'acct_connected': { const d = e.details as { env?: string; company?: string } | null; return `QuickBooks ${d?.env} connected${d?.company ? `: ${d.company}` : ''}` }
    case 'acct_disconnected': { const d = e.details as { env?: string } | null; return `QuickBooks ${d?.env} disconnected` }
    case 'acct_settings': return `Accounting settings: ${e.note} changed`
    case 'comp_doc_added': { const d = e.details as { version?: number } | null; return `Document added: ${e.note}${(d?.version ?? 1) > 1 ? ` (version ${d?.version})` : ''}` }
    case 'comp_doc_updated': return `Document changed: ${e.note}`
    case 'comp_doc_deleted': return `Document removed: ${e.note}`
    case 'comp_deadline_saved': return `Deadline saved: ${e.note}`
    case 'comp_deadline_done': { const d = e.details as { next?: string | null } | null; return `Done: ${e.note}${d?.next ? ` (next due ${d.next})` : ''}` }
    case 'comp_deadline_deleted': return `Deadline deleted: ${e.note}`
    case 'comp_material': { const d = e.details as { changes?: { ccof_status?: string } } | null; return `CCOF material ${e.note}${d?.changes?.ccof_status ? `: ${d.changes.ccof_status.replace('_', ' ')}` : ' updated'}` }
    case 'comp_metrc_status': { const d = e.details as { n?: number } | null; return `${d?.n ?? ''} METRC action${d?.n === 1 ? '' : 's'} marked ${e.note === 'todo' ? 'to do' : e.note === 'error' ? 'problem' : e.note}` }
    case 'comp_metrc_upload': { const d = e.details as { rows?: number } | null; return `METRC export uploaded for ${e.note} (${d?.rows ?? 0} packages)` }
    case 'comp_error': return `METRC error logged: ${e.note}`
    case 'comp_error_fixed': return `METRC error fixed: ${e.note}`
    case 'comp_playbook': return `Playbook: ${e.note}`
    case 'comp_customer_license': { const d = e.details as { license?: string; expires?: string } | null; return `Customer license for ${e.note}: ${d?.license ?? 'none'}${d?.expires ? `, expires ${d.expires}` : ''}` }
    case 'comp_license': { const d = e.details as { expires?: string } | null; return `License ${e.note} expires ${d?.expires ?? '(no date)'}` }
    case 'comp_setting': return `Compliance settings: ${e.note}`
    case 'comp_backup': { const d = e.details as { copied?: number; archived?: number; failed?: number } | null; return `SharePoint backup: ${d?.copied ?? 0} copied, ${d?.archived ?? 0} archived, ${d?.failed ?? 0} failed` }
    case 'sample_set': { const d = e.details as { sample?: boolean; customer?: string } | null; return `${e.note ?? 'Order'} ${d?.sample ? 'marked as a sample' : 'no longer a sample'}${d?.customer ? ` (${d.customer})` : ''}` }
    case 'sample_hold': { const d = e.details as { release?: boolean; until?: string; customer?: string } | null; return `Sample hold ${e.note}${d?.customer ? ` for ${d.customer}` : ''}: ${d?.release ? 'released' : `until ${d?.until}`}` }
    case 'fleet_driver': { const d = e.details as { new?: boolean; carrier?: number | null } | null; return `${d?.new ? 'Driver added' : 'Driver changed'}: ${e.note}${d?.carrier ? ' (carrier)' : ''}` }
    case 'fleet_carrier': { const d = e.details as { new?: boolean } | null; return `${d?.new ? 'Carrier added' : 'Carrier changed'}: ${e.note}` }
    case 'fleet_asset': { const d = e.details as { new?: boolean } | null; return `${d?.new ? 'Vehicle added' : 'Vehicle changed'}: ${e.note}` }
    case 'fleet_inspection': { const d = e.details as { result?: string } | null; return `Inspection${d?.result ? ` (${d.result === 'pass' ? 'passed' : d.result === 'defects' ? 'defects found' : 'out of service'})` : ''}: ${e.note}` }
    case 'fleet_maintenance': return `Maintenance: ${e.note}`
    case 'fleet_incident': return `Incident reported: ${e.note}`
    case 'fleet_closed': { const d = e.details as { open?: boolean } | null; return `${d?.open ? 'Reopened' : 'Closed'}: ${e.note}` }
    case 'fleet_deleted': return `Vehicle report removed: ${e.note}`
    case 'invoice_paid': { const d = e.details as { inv?: string; total?: number; via?: string } | null; return `${d?.inv} paid${d?.via ? ` (from ${d.via})` : ''}` }
    default: return `${e.type} ${code}`
  }
}

// ---------- app ----------

type FormState =
  | { kind: 'split' | 'merge' | 'tag' | 'weight'; p: Pallet }
  | { kind: 'newchoice' | 'newmixed' | 'newsingle' | 'newmerged'; slot: Slot; tag?: string }
  | { kind: 'addmixed'; m: Pallet; initial?: Pallet[] }
  | { kind: 'pickmixed'; p: Pallet }
  | { kind: 'stopmixed'; stop: number; onTruck: boolean }
interface Placing { title: string; sub: string; run: (slot: Slot) => Promise<void> }

// opened from a request email: go straight to Sales > Requests or Orders
const GO = new URLSearchParams(location.search).get('go')
const GO_TAB: 'requests' | 'orders' | null = GO === 'requests' || GO === 'orders' ? GO : null
// back from connecting QuickBooks (api/qbo/callback): Accounting > Settings
const GO_ACCT = GO === 'accounting'
const QBO_BACK = (() => { const q = new URLSearchParams(location.search); return q.get('qbo') ? { qbo: q.get('qbo')!, msg: q.get('msg') } : null })()

export default function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const [me, setMe] = useState<Me | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [site, setSite] = useState<Site>('OHR')
  useEffect(() => { if (GO) history.replaceState(null, '', location.pathname) }, [])
  const storedMod = stored('fm.mod') as Mod | null
  const [view, setView] = useState<View>(GO_ACCT ? 'acct' : GO_TAB ? 'sales' : storedMod === 'cult' ? 'cult' : storedMod === 'nurs' ? 'nursery' : storedMod === 'acct' ? 'acct' : storedMod === 'proc' ? 'proc' : storedMod === 'comp' ? 'comp' : storedMod === 'sales' ? 'sales' : storedMod === 'admin' ? 'admin' : 'dash')
  const [mod, setModS] = useState<Mod>(GO_ACCT ? 'acct' : GO_TAB ? 'sales' : storedMod && storedMod in MOD_KEY ? storedMod : 'dist')
  const [cultTab, setCultTabS] = useState<CultTab>(() => ([...CULT_TABS, ...CULT_TAIL].find(t => t.t === stored('cult.tab'))?.t ?? 'dashboard'))
  const [salesTab, setSalesTabS] = useState<SalesTab>(GO_TAB ?? 'dash')
  const [adminSet, setAdminSet] = useState<Mod>('admin')
  const [adminTab, setAdminTabS] = useState<AdminTab>('dash')
  const [procTab, setProcTabS] = useState<PTab>(() => ([...PROC_TABS, ...PROC_TAIL].find(x => x.t === stored('proc.tab'))?.t ?? 'dashboard'))
  const [compTab, setCompTabS] = useState<CTab>(() => ([...COMP_TABS, ...COMP_TAIL].find(x => x.t === stored('comp.tab'))?.t ?? 'dashboard'))
  const [acctTab, setAcctTabS] = useState<ATab>(GO_ACCT ? (QBO_BACK ? 'settings' : 'dashboard') : 'dashboard')
  const [nurTab, setNurTabS] = useState<NTab>(() => ([...NURSERY_TABS, ...NURSERY_TAIL].find(t => t.t === stored('nur.tab'))?.t ?? 'dashboard'))
  const [modMenu, setModMenu] = useState(false)
  const [more, setMore] = useState(false)
  // Scan (bottom bar in Distribution and Processing): camera open, a tag nobody has, an older pallet found by its tag
  const [scanning, setScanning] = useState(false)
  const [scanMiss, setScanMiss] = useState<{ tag: string; checked: boolean; range: string | null } | null>(null)
  const [scanned, setScanned] = useState<Pallet | null>(null)
  const top = () => { setMore(false); scrollTop() }
  const setCultTab = (t: CultTab) => { setCultTabS(t); store('cult.tab', t); setView('cult'); top() }
  const setSalesTab = (t: SalesTab) => { setSalesTabS(t); setView('sales'); top() }
  const setAdminTab = (t: AdminTab) => { setAdminTabS(t); setView('admin'); top() }
  const setNurTab = (t: NTab) => { setNurTabS(t); store('nur.tab', t); setView('nursery'); top() }
  const setAcctTab = (t: ATab) => { setAcctTabS(t); setView('acct'); top() }
  const setProcTab = (t: PTab) => { setProcTabS(t); store('proc.tab', t); setView('proc'); top() }
  const setCompTab = (t: CTab) => { setCompTabS(t); store('comp.tab', t); setView('comp'); top() }
  const lastView = useRef<View>('dash')
  const go = (v: View) => { if (view !== 'mine' && view !== 'fleet') lastView.current = view; setView(v); top() }
  const [freezerId, setFreezerId] = useState<number | null>(null)
  const [palletId, setPalletId] = useState<number | null>(null)
  const [plan, setPlan] = useState<Plan>(EMPTY)
  const [selecting, setSelecting] = useState(false)
  const [sel, setSel] = useState<number[]>([])
  const [choose, setChoose] = useState<{ id: number; slot: Slot } | null>(null)
  const [removeP, setRemoveP] = useState<Pallet | null>(null)
  const [archQ, setArchQ] = useState<string | null>(null)
  const [lastBatch, setLastBatch] = useState<{ id: string; n: number; at: number } | null>(null)
  const [pickLoadMany, setPickLoadMany] = useState<Pallet[] | null>(null)
  const [tagPool, setTagPool] = useState<string[]>([])
  const [placing, setPlacing] = useState<Placing | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; ok: string; run: () => Promise<void> } | null>(null)
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [extra, setExtra] = useState<Pallet[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [crossSite, setCrossSite] = useState<{ moves: { pallet_id: number; from_slot: number | null; to_slot: number; kind: string }[]; cross: { id: number; from: string; to: string }[] } | null>(null)
  const [pool, setPool] = useState<Pallet[]>([])
  const [loadId, setLoadId] = useState<number | null>(null)
  const [counts, setCounts] = useState({ orders: 0, requests: 0 })
  // phone / browser Back: steps back through modules, tabs, freezers and loads; pop-up sheets close first
  useScrimBack()
  useTabHistory({ view, mod, cultTab, salesTab, adminTab, adminSet, procTab, compTab, acctTab, nurTab, freezerId, loadId }, s => {
    setModS(s.mod); store('fm.mod', s.mod); setCultTabS(s.cultTab); setSalesTabS(s.salesTab); setAdminTabS(s.adminTab); setAdminSet(s.adminSet)
    setProcTabS(s.procTab); setCompTabS(s.compTab); setAcctTabS(s.acctTab); setNurTabS(s.nurTab); setFreezerId(s.freezerId); setLoadId(s.loadId)
    setView(s.view); setMore(false); setModMenu(false)
  })
  const isSales = !!me?.access?.modules.sales
  const salesAdmin = me?.access?.modules.sales === 'admin'
  const refreshCounts = useCallback(() => { if (isSales) backend.salesCounts().then(setCounts).catch(() => {}) }, [isSales])
  useEffect(() => { refreshCounts(); if (!isSales) return; const t = setInterval(refreshCounts, 60000); return () => clearInterval(t) }, [isSales, refreshCounts])
  const salesBadge = counts.orders + (salesAdmin ? counts.requests : 0)
  const [loadForm, setLoadForm] = useState<{ load?: Load } | null>(null)
  const [pickLoad, setPickLoad] = useState<Pallet | null>(null)
  const [invTick, setInvTick] = useState(0)   // bumps after a pallet action so Processing reloads its own data

  const reload = useCallback(async () => { const s = await backend.load(); setStrainColors(s); setSnap(s) }, [])
  const flash = (text: string, bad = false) => { setToast({ text, bad }); setTimeout(() => setToast(null), bad ? 5000 : 2500) }

  useEffect(() => { backend.getUser().then(setUser) }, [])
  useEffect(() => {
    setMe(null)
    if (!user) return
    backend.me().then(setMe).catch(e => setLoadError(String(e?.message ?? e)))
  }, [user])
  const staff = !!me && ['admin', 'sales', 'crew'].includes(me.role)
  // language: the person's own setting (an Admin may have set it for them); English until signed in
  if (me && (me.access?.prefs?.lang ?? 'en') !== lang()) setLang(me.access?.prefs?.lang ?? 'en')
  setMyAccess(me?.access ?? null)
  const lv = me?.access?.modules ?? {}
  const MODS = (Object.keys(MOD_KEY) as Mod[]).map(m => ({ m, l: ML(m), on: !!lv[MOD_KEY[m]] }))
  const myMods = MODS.filter(x => x.on)
  const noMods = staff && myMods.length === 0
  const cur: Mod = myMods.some(x => x.m === mod) ? mod : myMods[0]?.m ?? 'dist'
  const inCult = cur === 'cult'
  const isAdminOf = (m: Mod) => lv[MOD_KEY[m]] === 'admin'
  const goMod = (m: Mod) => {
    setModS(m); store('fm.mod', m); setModMenu(false)
    if (m === 'cult') setCultTab('dashboard'); else if (m === 'nurs') setNurTab('dashboard'); else if (m === 'acct') setAcctTab('dashboard'); else if (m === 'proc') setProcTab('dashboard'); else if (m === 'comp') setCompTab('dashboard'); else if (m === 'sales') setSalesTab('dash'); else if (m === 'admin') setAdminTab('dash'); else go('dash')
  }
  // signed in: personal settings (theme, where to start, which site)
  useEffect(() => {
    if (!me || !staff) return
    const p = me.access?.prefs ?? {}
    if (p.theme) applyTheme(p.theme)
    if (p.start_site) setSite(p.start_site)
    if (!GO_TAB && !GO_ACCT && p.start_module && lv[p.start_module]) goMod(KEY_MOD[p.start_module])
  }, [me?.email])
  // the module we're in isn't on for this person: go to one that is
  useEffect(() => { if (staff && cur !== mod && myMods.length) goMod(cur) }, [cur, mod, staff, myMods.length])
  // Fulfillment: open orders and the pallets held for them (Distribution and Sales)
  const [forders, setForders] = useState<FOrder[] | null>(null)
  const [fOpen, setFOpen] = useState<number | null>(null)   // order open in Fulfillment (a load's stop can open one)
  useEffect(() => { if (view !== 'fulfill') setFOpen(null) }, [view])
  const canFulfill = !!lv.distribution || !!lv.sales
  const [fErr, setFErr] = useState<string | null>(null)
  const [doc, setDoc] = useState<{ kind: 'invoice' | 'so'; id: number } | null>(null)
  const [newOrder, setNewOrder] = useState(false)
  const [ordersKey, setOrdersKey] = useState(0)
  const refreshF = useCallback(async () => {
    if (!canFulfill) return
    try { setForders(await backend.fulfillmentOrders()); setFErr(null) } catch (e) { setForders([]); setFErr(String((e as Error).message ?? e)) }
  }, [canFulfill])
  useEffect(() => {
    if (!staff) return
    reload().then(() => setLoadError(null)).catch(e => setLoadError(String(e?.message ?? e)))
    refreshF()
    return backend.subscribe(() => { reload(); refreshF() })
  }, [staff, reload, refreshF])

  // search outside the live set (archived / old pallets) once the query is specific
  useEffect(() => {
    if (query.trim().length < 3) { setExtra([]); return }
    const t = setTimeout(() => backend.search(query.trim()).then(setExtra).catch(() => setExtra([])), 350)
    return () => clearTimeout(t)
  }, [query])

  const ix = useMemo(() => snap && buildIndex(snap), [snap])
  // new mixed pallets: next tags from the site's range
  useEffect(() => {
    setTagPool([])
    if (!ix || !form || (form.kind !== 'newmixed' && form.kind !== 'addmixed')) return
    const slotId = form.kind === 'addmixed' ? form.m.slot_id : 'slot' in form ? form.slot.id : null
    const f = slotId != null ? ix.freezer.get(ix.slot.get(slotId)?.freezer_id ?? -1) : undefined
    if (f) backend.nextTags(f.site, 'mixed', 30).then(setTagPool).catch(() => {})
  }, [form?.kind, ix])
  const L: Layout | null = useMemo(() => ix && {
    inSlot: id => ix.inSlot.get(id) ?? [], pallet: id => ix.pallet.get(id), slot: id => ix.slot.get(id),
    slotsOf: id => ix.slotsOf.get(id) ?? [], freezer: id => ix.freezer.get(id),
  }, [ix])
  // a pallet that changed under the plan (moved by someone else, shipped) drops out of the tray
  useEffect(() => {
    if (!ix || !active(plan)) return
    const gone = [...plan.tray, ...plan.moves.map(m => m.id)].filter(id => { const p = ix.pallet.get(id); return !p || p.container_id || !['in_freezer', 'unslotted'].includes(p.status) })
    if (gone.length) setPlan(pl => gone.reduce(dropFromPlan, pl))
  }, [ix])
  // undo is offered for 15 minutes
  useEffect(() => { if (!lastBatch) return; const t = setTimeout(() => setLastBatch(null), 15 * 60000 - (Date.now() - lastBatch.at)); return () => clearTimeout(t) }, [lastBatch])
  function doPlace(id: number, slot: Slot, mode?: PlaceMode) {
    if (!L) return
    const r = place(L, plan, id, slot.id, mode)
    if (r === 'choose') setChoose({ id, slot }); else { setPlan(r); setChoose(null) }
  }
  onDrop((d, t) => {
    if (!ix || !L) return
    if (d.span) {   // trailer: stretch a pallet over more spots (saved right away), or back to one spot
      if ('tray' in t) return
      const p = ix.pallet.get(d.id)
      act(() => backend.setSpan(d.id, t.slot === p?.slot_id ? null : t.slot), t.slot === p?.slot_id ? `${p?.code} back to one spot` : `${p?.code} now takes more spots`)
      return
    }
    const ids = d.ids?.length ? d.ids : [d.id]
    if ('tray' in t) { setPlan(pl => addToTray(pl, ids)); return }
    const slot = ix.slot.get(t.slot)
    if (!slot) return
    if (ids.length === 1) { doPlace(d.id, slot); return }
    // a whole stack: the first one lands like a single pallet would (into an empty spot), the rest stack on it
    setPlan(pl => {
      let next = pl
      ids.forEach((id, i) => { const r = place(L, next, id, slot.id, i === 0 && occupants(slotView(L, next, slot.id)).length === 0 ? undefined : 'stack'); if (r !== 'choose') next = r })
      return next
    })
  })
  async function applyPlan(skipCross = false) {
    if (!L) return
    const moves = toSave(L, plan)
    if (!moves.length) { setPlan(EMPTY); return }
    // OHR <> GVR on the map: offer a real transfer (load + METRC manifest) instead of a to-do
    if (!skipCross && ix) {
      const siteOfSlot = (id: number | null) => id == null ? null : ix.freezer.get(ix.slot.get(id)?.freezer_id ?? -1)?.site ?? null
      const cross = moves.map(m => { const p = ix.pallet.get(m.pallet_id); const from = siteOfSlot(m.from_slot) ?? (p ? siteOf(p) : null); const to = siteOfSlot(m.to_slot)
        return from && to && from !== to ? { id: m.pallet_id, from: String(from), to: String(to) } : null }).filter((x): x is { id: number; from: string; to: string } => !!x)
      if (cross.length) { setCrossSite({ moves, cross }); return }
    }
    setBusy(true)
    try {
      const id = await backend.applyMoves(moves)
      await reload(); setPlan(EMPTY); setSel([]); setSelecting(false)
      setLastBatch({ id, n: moves.length, at: Date.now() }); flash(`Saved ${moves.length} move${moves.length === 1 ? '' : 's'}`)
    } catch (e) { flash((e as Error).message, true); reload().catch(() => {}) } finally { setBusy(false) }
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); await reload(); setInvTick(t => t + 1); refreshF().catch(() => {}); flash(ok) } catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }
  async function submit<T>(fn: () => Promise<T>, ok: (r: T) => string, after?: (r: T) => void) {
    setBusy(true)
    let r: T
    try { r = await fn() } catch (e) { flash((e as Error).message, true); setBusy(false); return }
    // saved: close the form now; a slow or failed refresh afterwards isn't a failed save
    setForm(null); flash(ok(r)); after?.(r)
    try { await reload(); setInvTick(t => t + 1); refreshF().catch(() => {}) }
    catch (e) { flash(`Saved. Refreshing the map failed (${(e as Error).message}); it updates on its own shortly.`, true) }
    finally { setBusy(false) }
  }

  function slotLabel(slot: Slot) {
    const f = ix!.freezer.get(slot.freezer_id)!
    return f.kind === 'staging' ? `${f.site} Staging · ${slot.row}` : f.kind === 'trailer' ? `${f.site} ${fName(f)} · ${slot.code.slice(2)}` : `${f.site} F${f.number} · ${slot.code}`
  }

  function tapSlot(slot: Slot) {
    if (!ix) return
    const here = ix.inSlot.get(slot.id) ?? []
    const f = ix.freezer.get(slot.freezer_id)!
    if (placing) {
      const pl = placing
      const go = async () => { setPlacing(null); await pl.run(slot) }
      if (here.length) setConfirm({ text: `${slot.code} already has ${here.map(h => h.code).join(', ')}. Stack on top? Each pallet keeps its own number.`, ok: 'Stack', run: go })
      else go()
      return
    }
    if (plan.current != null) { doPlace(plan.current, slot); return }
    if (selecting) return
    if (here.length) setPalletId(here[0].id)
    else if (f.status === 'Not Working') flash(`${fName(f)} is marked Not Working`, true)
    else setForm({ kind: 'newchoice', slot })
  }

  if (CONFIG_MISSING) return (
    <div className="center"><h2>Setup needed</h2>
      <p className="muted">This build has no database connection. In Vercel, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy.</p></div>
  )
  const refreshUser = () => backend.getUser().then(setUser)
  const linkParams = new URLSearchParams(location.search)
  const link = linkParams.get('invite') ? { kind: 'invite' as const, code: linkParams.get('invite')! } : linkParams.get('reset') ? { kind: 'reset' as const, code: linkParams.get('reset')! } : null
  const docToken = linkParams.get('doc')
  if (docToken) return <SharedDocPage backend={backend} token={docToken} />
  const bonusToken = linkParams.get('bonus')
  if (bonusToken) return <BonusScreen backend={backend} token={bonusToken} />
  if (link) return <PortalLink backend={backend} kind={link.kind} code={link.code} onDone={refreshUser} />
  if (user === undefined) return <Splash />
  if (!user) return IS_PORTAL ? <PortalLogin backend={backend} onDone={refreshUser} /> : <Login />
  if (user && !me && !loadError) return <Splash />
  const viewBar = me?.viewing_as ? <ViewAsBar me={me} stop={() => backend.stopViewAs().then(() => location.reload())} /> : null
  if (me?.role === 'customer') return <>{viewBar}<Portal backend={backend} me={me} signOut={() => backend.signOut().then(() => setUser(null))} /></>
  if (me && !staff) return <>{viewBar}<NoAccess me={me} signOut={() => backend.signOut().then(() => setUser(null))} /></>
  if (loadError && !snap) return (
    <div className="center"><h2>Couldn't load the app</h2>
      <p className="muted">{loadError}</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="primary" onClick={() => { setLoadError(null); reload().catch(e => setLoadError(String(e?.message ?? e))) }}>Try again</button>
        <button className="ghost" onClick={() => backend.signOut().then(() => setUser(null))}>Sign out</button>
      </div></div>
  )
  if (!snap || !ix) return <Splash />

  const siteFreezers = snap.freezers.filter(f => f.site === site && (f.kind ?? 'freezer') === 'freezer' && f.active !== false).sort((a, b) => a.number - b.number)
  const siteTrailers = snap.freezers.filter(f => f.site === site && f.kind === 'trailer' && f.active !== false).sort((a, b) => a.number - b.number)
  const unplaced = snap.pallets.filter(p => p.status === 'unslotted' && !p.container_id)
  const review = snap.pallets.filter(p => p.needs_review)
  const pendingTags = snap.pallets.filter(p => p.tag_pending)
  const shippedChecks = (snap.shipped ?? []).filter(c => ix.pallet.has(c.pallet_id))
  const fromHarvest = snap.pallets.filter(p => p.harvest_id != null && p.status === 'in_freezer' && p.slot_id != null && ix.freezer.get(ix.slot.get(p.slot_id)?.freezer_id ?? -1)?.kind === 'staging')
  const reviewCount = fromHarvest.length + review.length + pendingTags.length + unplaced.length + shippedChecks.length
  const selected = palletId != null ? (ix.pallet.get(palletId) ?? pool.find(p => p.id === palletId) ?? extra.find(p => p.id === palletId) ?? (scanned?.id === palletId ? scanned : null)) : null
  const where = (p: Pallet): string => {
    const m = p.container_id ? ix.pallet.get(p.container_id) : undefined
    if (m) return `on ${m.code} · ${where(m)}`
    const lo = ix.loadOf.get(p.id)
    if (p.status === 'in_transit' && lo) return `On truck ${lo.load.code} · position ${lo.item.position}`
    if (p.status === 'unslotted' && p.received_site) return `Received at ${p.received_site}, needs a spot`
    return whereIs(ix, p.slot_id)
  }
  const siteOf = (p: Pallet): string | null => {
    const top = p.container_id ? ix.pallet.get(p.container_id) ?? p : p
    const fz = top.slot_id != null ? ix.freezer.get(ix.slot.get(top.slot_id)?.freezer_id ?? -1) : undefined
    return fz?.site ?? top.received_site ?? null
  }
  const looseList = snap.pallets.filter(loose).filter(p => !ix.loadOf.has(p.id))
  const openLoads = (snap.loads ?? []).filter(l => ['planning', 'loading', 'in_transit'].includes(l.status))
  const heldBy = new Map<number, FOrder>()
  for (const o of forders ?? []) if (o.state !== 'shipped') for (const l of o.lines) for (const pk of l.picks) heldBy.set(pk.pallet_id, o)
  const toFulfill = (forders ?? []).filter(o => o.state === 'open' || o.state === 'ready').length
  const canonOf = (() => { const m = new Map<string, string>(); for (const st of snap.strains ?? []) for (const n of [st.name, ...(st.aliases ?? [])]) m.set(n.toLowerCase(), st.name.toLowerCase()); return (x: string | null | undefined) => { const k = (x ?? '').trim().toLowerCase(); return m.get(k) ?? k } })()
  const ctx: LoadCtx = {
    loads: snap.loads ?? [], stops: snap.stops ?? [], items: snap.items ?? [],
    vehicles: snap.vehicles ?? [], customers: snap.customers ?? [], drivers: snap.drivers ?? [],
    pallet: id => ix.pallet.get(id), contents: id => ix.contentsOf.get(id) ?? [], weight: p => weightOf(ix, p), where,
    freezerSpot: id => whereIs(ix, id),
    available: snap.pallets.filter(p => !p.container_id && (p.status === 'in_freezer' || (p.status === 'unslotted' && !!p.received_site)) && !ix.loadOf.has(p.id)),
    siteOf,
    held: id => { const o = heldBy.get(id); return o ? `${o.customer} · ${o.so ?? 'order'}` : undefined },
    busy,
    run: async (fn, ok) => { setBusy(true); try { await fn(); await reload(); setInvTick(t => t + 1); refreshF().catch(() => {}); flash(ok); return true } catch (e) { flash((e as Error).message, true); await reload().catch(() => {}); refreshF().catch(() => {}); return false } finally { setBusy(false) } },
    confirm: (text, ok, fn) => setConfirm({ text, ok, run: fn }),
    openPallet: id => setPalletId(id),
    orders: forders ?? [],
    openOrder: id => { setFOpen(id); go('fulfill') },
    refreshOrders: refreshF,
    canShip: isSales,
    newMixedOnStop: (stop, onTruck) => setForm({ kind: 'stopmixed', stop, onTruck }),
    putBack: (item, p) => { setView('map'); startPlacing({ title: `Putting ${p.code} back in a freezer`, sub: 'Open a freezer and tap the slot.', run: slot => act(() => backend.unloadPallet(item.id, slot.id), `${p.code} back in ${slot.code}`) }) },
    api: backend,
  }
  const invCtx: InvCtx = {
    pallets: snap.pallets, pallet: id => ix.pallet.get(id), where, grade: p => gradeOf(ix, p),
    item: id => id != null ? ix.sku.get(id) : undefined, lot: id => id != null ? ix.lot.get(id) : undefined,
    held: id => { const o = heldBy.get(id); return o ? `${o.customer} · ${o.so ?? 'order'}` : undefined },
    onLoad: id => ix.loadOf.get(id)?.load.code, inRun: id => snap.inRun?.[id], open: id => setPalletId(id), site: siteOf,
  }
  const byNearness = (p: Pallet) => (a: Pallet, b: Pallet) => {
    const fz = (x: Pallet) => ix.slot.get(x.slot_id ?? -1)?.freezer_id
    return Number(b.slot_id === p.slot_id) - Number(a.slot_id === p.slot_id)
      || Number(fz(b) === fz(p)) - Number(fz(a) === fz(p))
      || where(a).localeCompare(where(b), undefined, { numeric: true })
  }
  // pallets on the same stop of a load that hasn't left (planned or on the truck) can be merged / mixed with each other
  const editLoadOf = (id: number) => { const lo = ix.loadOf.get(id); return lo && ['planning', 'loading'].includes(lo.load.status) ? lo : undefined }
  const sameStop = (p: Pallet) => { const lo = editLoadOf(p.id); return lo ? snap.pallets.filter(x => x.id !== p.id && !x.container_id && isPackage(x) && editLoadOf(x.id)?.item.stop_id === lo.item.stop_id) : [] }
  const mergeCandidates = (p: Pallet) => [...looseList, ...sameStop(p)]
    .filter(x => x.id !== p.id && x.kind !== 'mixed' && x.pushed !== false && !!x.strain && !!p.strain && x.strain.toLowerCase() === p.strain.toLowerCase()
      && (x.product ?? 'fresh_frozen') === (p.product ?? 'fresh_frozen')
      && (!isDry(p) || (x.crop_year ?? null) === (p.crop_year ?? null)))   // METRC merges one item: dry needs the same product and crop
    .sort(byNearness(p))
  const mixedList = snap.pallets.filter(p => p.kind === 'mixed' && (p.status === 'in_freezer' || (p.status === 'in_transit' && !!editLoadOf(p.id))))
    .map(p => ({ p, n: ix.contentsOf.get(p.id)?.length ?? 0, w: weightOf(ix, p) }))
  const strainNames = (snap.strains ?? []).filter(s => s.active).map(s => s.name)
  const canDist = lv.distribution === 'user' || lv.distribution === 'admin'
  // a scanned tag: the screen you're on gets first go (order, load, Processing), then the pallet card, then "not found"
  const handleScan = async (tag: string) => {
    setScanning(false)
    if (await routeScan(tag)) return
    const hit = snap.pallets.find(p => sameTag(p.package_tag, tag))
    if (hit) { setPalletId(hit.id); return }
    try {
      const old = (await backend.search(tag)).find(p => sameTag(p.package_tag, tag))
      if (old) { setScanned(old); setPalletId(old.id); return }
    } catch { /* not found below */ }
    setScanMiss({ tag, checked: false, range: null })
    const sb = backend.client()
    const done = (range: string | null) => setScanMiss(m => m && m.tag === tag ? { ...m, checked: true, range } : m)
    if (!sb) { done(null); return }
    sb.from('tag_ranges').select('*').then(({ data }) => {
      const r = ((data ?? []) as { site: string; purpose: string; prefix: string; first_n: number; last_n: number; digits: number; license?: string | null; active?: boolean }[])
        .find(r => tag.startsWith(r.prefix) && tag.length === r.prefix.length + r.digits && Number(tag.slice(r.prefix.length)) >= r.first_n && Number(tag.slice(r.prefix.length)) <= r.last_n)
      done(r ? `${r.site} · ${t(PURPOSE_LABEL[r.purpose] ?? r.purpose)}${r.license ? ` · ${r.license}` : ''}${r.active === false ? ` (${t('range switched off')})` : ''}` : null)
    })
  }
  const newWithTag = (tag: string) => {
    setView('map')
    startPlacing({ title: t('New pallet with tag …{x}', { x: tag.slice(-6) }), sub: t('Open a freezer and tap the slot it goes in.'), run: async slot => setForm({ kind: 'newsingle', slot, tag }) })
  }
  const openFreezer = (id: number) => { setFreezerId(id); setView('freezer'); scrollTop() }
  const goTo = (slotId: number | null) => {
    const s = slotId != null ? ix.slot.get(slotId) : undefined
    if (s) { const f = ix.freezer.get(s.freezer_id)!; setSite(f.site); openFreezer(f.id) }
  }
  const startPlacing = (pl: Placing, from?: Pallet) => {
    setPlacing(pl); setPalletId(null); setForm(null)
    if (from) goTo(from.container_id ? ix.pallet.get(from.container_id)?.slot_id ?? null : from.slot_id)
  }
  // pallet actions started outside the freezer map (Processing package sheet); the dialogs are the same ones the map uses
  const invAct = (pp: Pallet, kind: InvAction) => {
    const p = ix.pallet.get(pp.id) ?? pp
    if (kind === 'split' || kind === 'merge' || kind === 'tag' || kind === 'weight') setForm({ kind, p })
    else if (kind === 'addto') setForm({ kind: 'pickmixed', p })
    else if (kind === 'load') setPickLoad(p)
    else if (kind === 'remove') setRemoveP(p)
  }
  const invInfo = (id: number) => {
    const p = ix.pallet.get(id), m = p?.container_id ? ix.pallet.get(p.container_id) : undefined
    return { load: ix.loadOf.get(id)?.load.code, mixed: m?.code, inSnap: !!p }
  }
  const banner = placing ? { title: placing.title, sub: placing.sub, cancel: () => setPlacing(null) } : null
  const stagingOf = (st: Site) => snap.freezers.find(f => f.site === st && f.kind === 'staging')
  const curFreezer = view === 'freezer' && freezerId != null ? ix.freezer.get(freezerId) : undefined
  const lanes = L && plan.tray.length === 0 ? suggestions(L, plan) : []
  const tapPallet = (p: Pallet, role: 'stay' | 'incoming' | 'leaving', s: Slot) => {
    if (placing) { tapSlot(s); return }
    if (selecting && role === 'stay' && !active(plan)) { setSel(x => x.includes(p.id) ? x.filter(i => i !== p.id) : [...x, p.id]); return }
    if (role === 'incoming') { setPlan(pl => backToTray(pl, p.id)); return }
    if (role === 'leaving') { setPlan(pl => dropFromPlan(pl, p.id)); flash(`${p.code} stays where it is`); return }
    if (plan.current != null) { doPlace(plan.current, s); return }
    setPalletId(p.id)
  }
  const compact = () => {
    if (!L || !curFreezer) return
    const ls = [1, 2].map(c => laneShuffle(L, plan, curFreezer, c)).filter(x => !!x)
    if (!ls.length) { flash('No gaps to close in this freezer'); return }
    setPlan(pl => ls.reduce((acc, l) => addMoves(acc, l!.moves), pl))
    flash('Shuffle added to the plan. Tap Apply to save.')
  }
  const invStrains = snap.pallets.reduce((m, p) => p.strain ? m.set(p.strain, (m.get(p.strain) ?? 0) + 1) : m, new Map<string, number>())
  // each module's settings, used in the module and again in Admin > Settings
  const distSettings = <SettingsView key="dist-set" backend={backend} flash={flash} onChanged={() => { reload() }} inventoryStrains={invStrains} title="Distribution settings" lists={['strains']}
    extra={[{ k: 'locations', l: 'Locations', node: <DistLocations sb={backend.client()} flash={flash} onChanged={() => { reload() }} /> }, { k: 'vehicles', l: 'Vehicles', node: <CompFleet sb={backend.client()} flash={flash} dept="distribution" /> }, { k: 'people', l: 'People', node: <ModulePeople sb={backend.client()} module="distribution" flash={flash} /> }]} />
  const salesSettings = <SettingsView key="sales-set" backend={backend} flash={flash} onChanged={() => { reload() }} inventoryStrains={invStrains} title="Sales settings" focus="sales"
    lists={['customers', 'strains']} canTerms={salesAdmin} extra={[{ k: 'terms', l: 'Payment terms', node: <TermsPanel backend={backend} flash={flash} canEdit={salesAdmin} /> },
      { k: 'deadlines', l: 'Reserve deadlines', node: <DeadlinesPanel backend={backend} flash={flash} /> },
      { k: 'shipping', l: 'Shipping', node: <ShippingSettings sb={backend.client()} flash={flash} canEdit={salesAdmin || isAdminOf('dist')} /> },
      { k: 'fulfill', l: 'Fulfillment', node: <FillTolerance sb={backend.client()} flash={flash} canEdit={salesAdmin || isAdminOf('dist')} /> },
      { k: 'people', l: 'People', node: <ModulePeople sb={backend.client()} module="sales" flash={flash} /> }]} />
  const cultSettings = <Suspense fallback={<p className="muted">Loading…</p>}><CultView backend={backend} flash={flash} tab="setup" go={setCultTab} onPalletsChanged={() => { reload() }} /></Suspense>
  const strainSettings = <div className="modset"><SettingsView key="cult-strains" backend={backend} flash={flash} onChanged={() => { reload() }} inventoryStrains={invStrains} title="Strains" lists={['strains']} focus="cult" /></div>
  const nurStrainSettings = <div className="modset"><SettingsView key="nurs-strains" backend={backend} flash={flash} onChanged={() => { reload() }} inventoryStrains={invStrains} title="Strains" lists={['strains']} focus="nurs" /></div>
  const selWeight = sel.reduce((a, id) => { const p = ix.pallet.get(id); return a + (p ? weightOf(ix, p) : 0) }, 0)

  // ---------- navigation: the same shape in every module ----------
  // main screens at the top (Dashboard first), then Review, Activity and Settings at the bottom
  const badge = (n: number, warn = false) => n > 0 ? <span className={`badge ${warn ? 'warn' : ''}`}>{n}</span> : null
  const distMain: NavItem[] = [
    { k: 'dash', l: 'Dashboard', on: view === 'dash', go: () => go('dash') },
    { k: 'map', l: 'Map', on: view === 'map' || view === 'freezer', go: () => go(view !== 'map' && view !== 'freezer' && freezerId != null ? 'freezer' : 'map') },
    { k: 'inventory', l: 'Inventory', on: view === 'inventory', go: () => go('inventory') },
    { k: 'fulfill', l: <>Fulfillment{badge(toFulfill)}</>, s: t('Fulfill'), n: toFulfill, on: view === 'fulfill', go: () => go('fulfill') },
    { k: 'transit', l: <>Transit{badge(openLoads.length)}</>, s: 'Transit', n: openLoads.length, on: view === 'transit' || view === 'load', go: () => go('transit') },
    ...(staff ? [{ k: 'inbound', l: 'Inbound', on: view === 'inbound', go: () => go('inbound') }] : []),
    ...(staff ? [{ k: 'archived', l: 'Archived', on: view === 'archived', go: () => { setArchQ(null); go('archived') } }] : []),
  ]
  const distTail: NavItem[] = [
    { k: 'review', l: <>Review{badge(reviewCount, true)}</>, s: 'Review', n: reviewCount, warn: true, on: view === 'review', go: () => go('review') },
    { k: 'activity', l: 'Activity', on: view === 'activity', go: () => go('activity') },
    ...(isAdminOf('dist') ? [{ k: 'settings', l: 'Settings', on: view === 'settings', go: () => go('settings') }] : []),
  ]
  const sItem = (t: SalesTab, l: ReactNode, x?: Partial<NavItem>): NavItem => ({ k: t, l, ...x, on: view === 'sales' && salesTab === t, go: () => setSalesTab(t) })
  const salesMain: NavItem[] = [sItem('dash', 'Dashboard'), sItem('inventory', 'Inventory'), sItem('menu', SALES_TITLES.menu), sItem('orders', <>Orders{badge(counts.orders, true)}</>, { s: 'Orders', n: counts.orders, warn: true }), sItem('invoices', 'Invoices'), sItem('shipping', 'Shipping'),
    sItem('requests', <>Requests{badge(counts.requests, salesAdmin)}</>, { s: 'Requests', n: counts.requests, warn: salesAdmin }), sItem('customer', 'Reserves'), sItem('strain', 'By strain')]
  const fillsToOk = (forders ?? []).filter(o => o.state === 'needs_ok').length
  const salesTail: NavItem[] = [sItem('review', <>Review{badge(salesBadge + fillsToOk, true)}</>, { s: 'Review', n: salesBadge + fillsToOk, warn: true }), sItem('activity', 'Activity'), ...(isAdminOf('sales') ? [sItem('settings', 'Settings')] : [])]
  const cItem = (t: CultTab, l: string): NavItem => ({ k: t, l, on: view === 'cult' && cultTab === t, go: () => setCultTab(t) })
  const cultMain = CULT_TABS.map(x => cItem(x.t, t(x.l)))
  const cultTail = CULT_TAIL.filter(x => x.t !== 'setup' || isAdminOf('cult')).map(x => cItem(x.t, t(x.l)))
  const aItem = (t: AdminTab, l: string): NavItem => ({ k: t, l, on: view === 'admin' && adminTab === t, go: () => setAdminTab(t) })
  const adminMain = [aItem('dash', 'Dashboard')], adminTail = [aItem('review', 'Review'), aItem('activity', 'Activity'), aItem('settings', 'Settings')]
  const nItem = (t: NTab, l: string): NavItem => ({ k: t, l, on: view === 'nursery' && nurTab === t, go: () => setNurTab(t) })
  const nurMain = NURSERY_TABS.map(x => nItem(x.t, t(x.l)))
  const nurTail = NURSERY_TAIL.filter(x => x.t !== 'settings' || isAdminOf('nurs')).map(x => nItem(x.t, t(x.l)))
  const prItem = (t: PTab, l: string): NavItem => ({ k: t, l, on: view === 'proc' && procTab === t, go: () => setProcTab(t) })
  const procMain = PROC_TABS.map(x => prItem(x.t, t(x.l)))
  const procTail = PROC_TAIL.filter(x => x.t !== 'settings' || isAdminOf('proc')).map(x => prItem(x.t, t(x.l)))
  const acItem = (t: ATab, l: string): NavItem => ({ k: t, l, on: view === 'acct' && acctTab === t, go: () => setAcctTab(t) })
  const acctMain = ACCT_TABS.map(x => acItem(x.t, x.l))
  const acctTail = ACCT_TAIL.filter(x => x.t !== 'settings' || isAdminOf('acct')).map(x => acItem(x.t, x.l))
  const coItem = (t: CTab, l: string): NavItem => ({ k: t, l, on: view === 'comp' && compTab === t, go: () => setCompTab(t) })
  const compMain = COMP_TABS.map(x => coItem(x.t, x.l))
  const compTail = COMP_TAIL.filter(x => x.t !== 'settings' || isAdminOf('comp')).map(x => coItem(x.t, x.l))
  const NAV: Record<Mod, { main: NavItem[]; tail: NavItem[] }> = {
    acct: { main: acctMain, tail: acctTail }, proc: { main: procMain, tail: procTail }, comp: { main: compMain, tail: compTail },
    dist: { main: distMain, tail: distTail }, sales: { main: salesMain, tail: salesTail }, cult: { main: cultMain, tail: cultTail }, nurs: { main: nurMain, tail: nurTail }, admin: { main: adminMain, tail: adminTail } }
  const nav = NAV[cur]
  const all = [...nav.main, ...nav.tail]
  // phone bottom bar: module button, the module's first four screens (Scan in the middle in Distribution and Processing)
  const bottomFit = all.slice(0, 4)
  const extras: NavItem[] = [
    ...(staff ? [{ k: 'fleet', l: t('Vehicles'), on: view === 'fleet', go: () => go('fleet') }] : []),
  ]
  const bottomRest = [...all.slice(4), ...extras]
  const restOn = bottomRest.some(x => x.on)
  const restBadge = all.slice(4).reduce((a, x) => a + (x.n ?? 0), 0)
  const canScan = cur === 'dist' || cur === 'proc'
  const shortL = (x: NavItem) => x.k === 'dash' || x.k === 'dashboard' ? t('Home') : x.s ?? (typeof x.l === 'string' ? x.l : x.k)
  const curScreen = all.find(x => x.on) ?? extras.find(x => x.on)
  const pageTitle = view === 'mine' ? t('My settings') : !curScreen || curScreen.k === 'dash' || curScreen.k === 'dashboard' ? ML(cur) : typeof curScreen.l === 'string' ? curScreen.l : curScreen.s ?? ML(cur)
  const jump = (j: Jump) => {
    const [m, t] = j.split('.') as [Mod, string]
    if (!lv[MOD_KEY[m]]) { flash(`You don't have ${MOD_LABEL[m]}`, true); return }
    setModS(m); store('fm.mod', m)
    if (m === 'dist') go(t as View); else if (m === 'sales') setSalesTab(t as SalesTab); else if (m === 'cult') setCultTab(t as CultTab); else if (m === 'nurs') setNurTab(t as NTab); else if (m === 'acct') setAcctTab(t as ATab); else if (m === 'proc') setProcTab(t as PTab); else if (m === 'comp') setCompTab(t as CTab); else setAdminTab(t === 'users' ? 'settings' : t as AdminTab)
  }
  const appName = ML(cur)
  document.title = noMods ? 'Lifted Farms' : `${view === 'mine' ? t('My settings') : view === 'fleet' ? t('Vehicles') : ML(cur)} · Lifted Farms`

  return (
    <TagSuggestProvider sb={backend.client()} site={site}><div className={`app shell ${noMods ? '' : 'with-rail'} ${myMods.length > 1 ? 'with-mods' : ''} ${banner ? 'is-moving' : ''} mod-${cur} ${!noMods && lv[MOD_KEY[cur]] === 'view' ? 'viewonly' : ''}`}
      style={{ ['--navw' as string]: myMods.length > 1 ? '284px' : '200px' }}>
      {viewBar}
      {!noMods && (
        <aside className="rail" aria-label="Navigation">
          {myMods.length > 1 && <div className="rail-mods">
            <img className="rail-logo" src="/logo-dark.svg" alt="Lifted Farms" />
            {myMods.map(x => (
              <button key={x.m} className={`rail-mod ${cur === x.m ? 'on' : ''}`} onClick={() => goMod(x.m)}>
                {MOD_ICON[x.m]}<span>{x.l}</span>
              </button>
            ))}
          </div>}
          <nav className="rail-screens" aria-label={`${ML(cur)} screens`}>
            <div className="rail-h">{ML(cur).toUpperCase()}</div>
            {canScan && <button className="rail-scan" onClick={() => setScanning(true)}>{SCAN_ICON}<span>{t('Scan a tag')}</span></button>}
            {nav.main.map(x => <button key={x.k} className={x.on ? 'on' : ''} onClick={x.go}>{x.l}</button>)}
            {nav.tail.length > 0 && <div className="rail-sep" />}
            {nav.tail.map(x => <button key={x.k} className={x.on ? 'on' : ''} onClick={x.go}>{x.l}</button>)}
          </nav>
        </aside>
      )}
      <header className="top">
        <div className="brand" onClick={() => nav.main[0]?.go()}>
          <img className="logo-img logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-img logo-d" src="/logo-dark.svg" alt="Lifted Farms" /> <span className="app-name">{appName}</span><span className="ptitle">{pageTitle}</span> {backend.demo && <span className="demo">DEMO</span>}
        </div>
        {myMods.length > 1 && (
          <div className="modpick">
            <button className={`modpill m-${cur}`} aria-haspopup="menu" aria-expanded={modMenu} onClick={() => setModMenu(!modMenu)}>
              {ML(cur)} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {modMenu && <>
              <div className="modscrim" onClick={() => setModMenu(false)} />
              <div className="modmenu" role="menu">
                {myMods.map(x => <button key={x.m} role="menuitem" className={cur === x.m ? 'on' : ''} onClick={() => goMod(x.m)}>
                  <b>{x.l}</b><span className="muted">{t(MOD_WHAT[x.m])}</span></button>)}
              </div>
            </>}
          </div>
        )}
        {cur === 'dist' && !noMods && <div className="seg">
          {(['OHR', 'GVR'] as Site[]).map(s => (
            <button key={s} className={s === site ? 'on' : ''} onClick={() => { setSite(s); if (view === 'freezer') setView('map') }}>{s}</button>
          ))}
        </div>}
        {cur === 'dist' && !noMods && <><input className="search" type="search" placeholder="Pallet, strain or tag" value={query}
          onChange={e => { setQuery(e.target.value); if (view === 'freezer' || view === 'activity' || view === 'dash' || view === 'mine' || view === 'fleet') setView('map') }} />
          <button type="button" className="ghost small scanbtn desk-only" title={t('Scan a METRC tag')} onClick={() => setScanning(true)}>📷</button></>}
        {(cur !== 'dist' || noMods) && <span className="grow" />}
        {staff && <WeatherBar sb={backend.client()} canEdit={!!me?.access?.owner || lv.cultivation === 'admin'} flash={flash} />}
        {staff && <button className={`ghost small desk-only ${view === 'fleet' ? 'on-btn' : ''}`} title={t('Vehicles: inspections, maintenance, incidents')} onClick={() => (view === 'fleet' ? go(lastView.current) : go('fleet'))}>🚚<span className="hide-phone"> {t('Vehicles')}</span></button>}
        <button className={`ghost small ${view === 'mine' ? 'on-btn' : ''}`} title={t('Your own settings')} onClick={() => (view === 'mine' ? go(lastView.current) : go('mine'))}>⚙<span className="hide-phone"> {t('My settings')}</span></button>
        <button className="ghost small" title={t('Signed in as {u}. Click to sign out.', { u: user ?? '' })} onClick={() => backend.signOut().then(() => setUser(null))}>{who(user)} ⏏</button>
      </header>

      {banner && (
        <div className="movebar">
          <div><b>{banner.title}</b><div className="muted">{banner.sub}</div></div>
          <button className="ghost" onClick={banner.cancel}>Cancel</button>
        </div>
      )}

      <main>
        {!noMods && lv[MOD_KEY[cur]] === 'view' && view !== 'mine' && view !== 'fleet' && <div className="viewbanner">{t('View only: you can look at everything in {m}, but not change anything.', { m: ML(cur) })}</div>}
        {view === 'fleet' && <CrewFleet sb={backend.client()} flash={flash} />}
        {view === 'mine' && <MySettings backend={backend} me={me!} flash={flash} onSaved={(p, name) => setMe(m => m && ({ ...m, display_name: name ?? m.display_name, access: { ...m.access, prefs: p } }))} />}
        {noMods && view !== 'mine' && view !== 'fleet' && <div className="list"><h2>No modules</h2><p className="muted">No parts of the app are switched on for your account yet. Ask someone with the Admin module to give you access.</p></div>}
        {view === 'dash' && cur === 'dist' && (
          <DistDashboard staged={{ n: fromHarvest.length, lbs: fromHarvest.reduce((a, p) => a + Number(p.current_weight ?? 0), 0), sites: [...new Set(fromHarvest.map(p => ix.freezer.get(ix.slot.get(p.slot_id!)!.freezer_id)!.site))],
            go: () => { const st = fromHarvest[0] ? ix.freezer.get(ix.slot.get(fromHarvest[0].slot_id!)!.freezer_id) : undefined; if (st) { setSite(st.site); openFreezer(st.id) } } }}
            goMap={() => { setView('map'); setFreezerId(null) }} fulfill={forders ? { open: (forders ?? []).filter(o => o.state === 'open').length, ready: (forders ?? []).filter(o => o.state === 'ready').length, waiting: (forders ?? []).filter(o => o.state === 'needs_ok').length, go: () => go('fulfill') } : undefined}
            ctx={{
              snap, site, backend,
              slotsOf: id => ix.slotsOf.get(id) ?? [], inSlot: id => ix.inSlot.get(id) ?? [], weight: p => weightOf(ix, p),
              onLoad: p => ix.loadOf.has(p.id) || heldBy.has(p.id), slot: id => ix.slot.get(id),
              freezerOf: id => { const sl = ix.slot.get(id); return sl ? ix.freezer.get(sl.freezer_id) : undefined },
              describe: e => describe(ix, e),
              reviewCounts: { spot: unplaced.length, tags: pendingTags.length, issues: review.length },
              openFreezer: id => { const f = ix.freezer.get(id)!; setSite(f.site); openFreezer(id) },
              openPallet: id => setPalletId(id),
              openLoad: id => { setLoadId(id); setView('load'); scrollTop() },
              goReview: () => setView('review'),
              goActivity: () => setView('activity'),
              goTransit: () => setView('transit'),
              searchFor: q => { setQuery(q); setView('map') },
            }} />
        )}
        {view === 'map' && (
          <MapView ix={ix} freezers={siteFreezers} trailers={siteTrailers} staging={stagingOf(site)} query={query} extra={extra} where={where}
            needsSpot={unplaced.filter(p => (p.received_site ?? siteOf(p)) === site)} onOpen={openFreezer} onPallet={setPalletId} />
        )}
        {view === 'freezer' && freezerId != null && (
          <FreezerView ix={ix} L={L!} plan={plan} freezer={ix.freezer.get(freezerId)!} query={query} placing={!!placing}
            selecting={selecting} sel={sel}
            siblings={ix.freezer.get(freezerId)?.kind === 'trailer' ? siteTrailers : siteFreezers}
            onOpen={openFreezer}
            onBack={() => setView('map')}
            onSlot={tapSlot}
            onPalletTap={tapPallet}
            onSelect={() => { if (selecting) { setSelecting(false); setSel([]) } else setSelecting(true) }}
            onCompact={compact}
            onStatus={(st) => setConfirm({
              text: `Set ${fName(ix.freezer.get(freezerId)!)} to "${st}"?`, ok: 'Update',
              run: () => act(() => backend.setFreezerStatus(freezerId, st), 'Freezer status updated'),
            })} />
        )}
        {view === 'review' && (<>
          {shippedChecks.length > 0 && <>
            <ShippedReview checks={shippedChecks} ix={ix} where={where} busy={busy} onPallet={setPalletId}
              run={(fn, ok) => act(fn, ok)} />
            <div style={{ height: 18 }} />
          </>}
          {(snap.unmatched ?? []).length > 0 && <>
            <UnmatchedTags tags={snap.unmatched!} busy={busy} run={(fn, ok) => act(fn, ok)}
              find={s => { setQuery(s); setView('map') }} />
            <div style={{ height: 18 }} />
          </>}
          {fromHarvest.length > 0 && <>
            <ListView title={`Harvest staging (${fromHarvest.length})`} empty=""
              note="Pallets logged at harvest, waiting in Staging. Open Staging on the map and move them into freezers."
              items={fromHarvest} ix={ix} where={where} onPallet={setPalletId} />
            <div style={{ height: 18 }} />
          </>}
          {unplaced.length > 0 && <>
            <ListView title={`Needs a spot (${unplaced.length})`} empty=""
              note="Pallets that aren't in a freezer slot, including ones just received from a load. Open one and tap Move to put it somewhere."
              items={unplaced} ix={ix} where={where} onPallet={setPalletId} />
            <div style={{ height: 18 }} />
          </>}
          <ListView title={`METRC tags pending (${pendingTags.length})`} empty="No pending tags."
            note="Splits, merges and new pallets waiting on a METRC tag. Open one and tap Enter tag."
            items={pendingTags} ix={ix} where={where} onPallet={setPalletId} />
          <div style={{ height: 18 }} />
          <ListView title={`Import issues (${review.length})`} empty="All clear."
            note="Flagged during import from the spreadsheet: duplicates, items not in the pallet list, or missing data. Fix the info and clear the flag."
            items={review} ix={ix} where={where} onPallet={setPalletId} showReason />
        </>)}
        {view === 'activity' && cur === 'dist' && <ActivityView ix={ix} module="distribution" />}
        {view === 'inventory' && cur === 'dist' && <DistInventory c={invCtx} flash={flash}
          onMove={ids => { setPlan(pl => addToTray(pl, ids)); go('map'); flash(`${ids.length} in the tray. Open a freezer and tap where they go.`) }} />}
        {view === 'sales' && cur === 'sales' && (() => {
          const goS = (m: SalesMode) => setSalesTab(m)
          if (salesTab === 'dash') return <SalesDashboard backend={backend} customers={snap.customers ?? []} isAdmin={salesAdmin} go={goS} />
          if (salesTab === 'review') return <SalesReview backend={backend} customers={snap.customers ?? []} isAdmin={salesAdmin} go={goS} fulfil={forders} onFulfil={refreshF} flash={flash} />
          if (salesTab === 'activity') return <ActivityView ix={ix} module="sales" />
          if (salesTab === 'inventory') return <SalesInventory c={invCtx} strains={snap.strains ?? []} sb={backend.client()} onNewOrder={isSales ? () => setNewOrder(true) : undefined} />
          if (salesTab === 'shipping') return <ShippingQuote sb={backend.client()} customers={snap.customers ?? []} flash={flash} />
          if (salesTab === 'invoices') return <InvoicesView backend={backend} customers={snap.customers ?? []} flash={flash} isAdmin={salesAdmin} sender={me?.display_name} />
          if (salesTab === 'settings') return salesSettings
          return <ReservesView key={`sales-${ordersKey}`} backend={backend} flash={flash} isAdmin={salesAdmin} mode={salesTab} onCounts={refreshCounts} fulfil={new Map((forders ?? []).map(f => [f.id, f]))} onFulfil={refreshF} customers={snap.customers ?? []}
            onNewOrder={() => setNewOrder(true)} onDoc={(k, id) => setDoc({ kind: k, id })}
            onInvoice={async id => { try { const inv = await backend.makeInvoice(id); setDoc({ kind: 'invoice', id: inv.id }) } catch (e) { flash(String((e as Error).message ?? e), true) } }} strains={snap.strains ?? []}
            onHand={snap.pallets.reduce((m, p) => (p.kind !== 'mixed' && p.strain && (p.status === 'in_freezer' || p.status === 'unslotted'))
              ? m.set(p.strain.toLowerCase(), (m.get(p.strain.toLowerCase()) ?? 0) + Number(p.current_weight ?? 0)) : m, new Map<string, number>())} />
        })()}
        {view === 'fulfill' && cur === 'dist' && <FulfillView err={fErr} backend={backend} orders={forders} reload={async () => { await reload(); await refreshF() }} flash={flash}
          pallets={snap.pallets} heldBy={heldBy} onLoad={id => ix.loadOf.has(id)} inRun={id => snap.inRun?.[id]} where={where} siteOf={siteOf} rank={p => (p.slot_id != null ? ix.slot.get(p.slot_id)?.front_rank : null) ?? 99}
          canon={canonOf} loads={snap.loads ?? []} vehicles={snap.vehicles ?? []} isSales={isSales} stops={snap.stops ?? []} customers={snap.customers ?? []} openId={fOpen} setOpenId={setFOpen}
          openLoad={id => { setLoadId(id); setView('load'); scrollTop() }} openPallet={setPalletId} />}
        {view === 'inbound' && <InboundView sb={backend.client()} flash={flash} onChanged={() => { reload() }} />}
        {view === 'archived' && <ArchivedView key={archQ ?? ''} initialQ={archQ} sb={backend.client()} flash={flash} onChanged={() => { reload() }}
          openPallet={async id => { const { data } = await backend.client()!.from('pallets').select('*').eq('id', id).single(); if (data) { setScanned(data as Pallet); setPalletId(id) } }}
          pickSpot={(r, w, note, done) => { setView('map'); startPlacing({ title: `Putting ${r.code} back`, sub: 'Open a freezer and tap the spot it\'s in.',
            run: slot => act(() => restoreOne(backend.client()!, r.id, note, { slot: slot.id }, w), `${r.code} is back in ${slotLabel(slot)}`).then(done) }) }} />}
        {view === 'transit' && <TransitView ctx={ctx} onOpen={id => { setLoadId(id); setView('load'); scrollTop() }} onNew={() => setLoadForm({})} />}
        {view === 'load' && loadId != null && <LoadView ctx={ctx} loadId={loadId} onBack={() => setView('transit')} onEdit={() => setLoadForm({ load: (snap.loads ?? []).find(l => l.id === loadId) })} />}
        {view === 'cult' && inCult && cultTab === 'receiving' && <ReceivingView sb={backend.client()} module="cultivation" flash={flash} nurseryLicenses={['CCL24-0000156']} />}
        {view === 'cult' && inCult && cultTab !== 'receiving' && <Suspense fallback={<p className="muted">Loading…</p>}><CultView backend={backend} flash={flash} tab={cultTab} go={setCultTab} onPalletsChanged={() => { reload() }} /></Suspense>}
        {view === 'cult' && inCult && cultTab === 'setup' && strainSettings}
        {view === 'nursery' && cur === 'nurs' && nurTab === 'receiving' && <ReceivingView sb={backend.client()} module="nursery" flash={flash} />}
        {view === 'nursery' && cur === 'nurs' && nurTab !== 'receiving' && <Suspense fallback={<p className="muted">Loading…</p>}><NurseryView backend={backend} flash={flash} tab={nurTab} go={setNurTab} customers={snap.customers ?? []} isAdmin={isAdminOf('nurs')} sender={me?.display_name} me={me?.email} /></Suspense>}
        {view === 'nursery' && cur === 'nurs' && nurTab === 'settings' && isAdminOf('nurs') && nurStrainSettings}
        {view === 'proc' && cur === 'proc' && procTab === 'activity' && <ActivityView ix={ix} module="processing" />}
        {view === 'proc' && cur === 'proc' && procTab !== 'activity' && <Suspense fallback={<p className="muted">Loading…</p>}><ProcessingView backend={backend} flash={flash} tab={procTab} go={setProcTab}
          isAdmin={isAdminOf('proc')} canEdit={lv.processing === 'user' || lv.processing === 'admin'} customers={snap.customers ?? []} strains={snap.strains ?? []} onChanged={() => { reload() }}
          inv={{ act: invAct, info: invInfo, tick: invTick }} /></Suspense>}
        {view === 'acct' && cur === 'acct' && acctTab === 'activity' && <ActivityView ix={ix} module="accounting" />}
        {view === 'acct' && cur === 'acct' && acctTab !== 'activity' && <Suspense fallback={<p className="muted">Loading…</p>}><AccountingView backend={backend} flash={flash} tab={acctTab} go={setAcctTab}
          isAdmin={isAdminOf('acct')} canEdit={lv.accounting === 'user' || lv.accounting === 'admin'} notice={GO_ACCT ? QBO_BACK : null} /></Suspense>}
        {view === 'comp' && cur === 'comp' && compTab === 'activity' && <ActivityView ix={ix} module="compliance" />}
        {view === 'comp' && cur === 'comp' && compTab !== 'activity' && <Suspense fallback={<p className="muted">Loading…</p>}><ComplianceView backend={backend} flash={flash} tab={compTab} go={setCompTab}
          isAdmin={isAdminOf('comp')} canEdit={lv.compliance === 'user' || lv.compliance === 'admin'} me={me?.email ?? null} /></Suspense>}
        {view === 'admin' && cur === 'admin' && adminTab === 'dash' && <AdminDashboard backend={backend} open={jump} />}
        {view === 'admin' && cur === 'admin' && adminTab === 'review' && <AdminReview backend={backend} open={jump} />}
        {view === 'admin' && cur === 'admin' && adminTab === 'activity' && <ActivityView ix={ix} module="all" />}
        {view === 'admin' && cur === 'admin' && adminTab === 'settings' && <div className="allset">
          <div className="seg setpick">{ALL_SETTINGS.map(([k, l]) => <button key={k} className={adminSet === k ? 'on' : ''} onClick={() => setAdminSet(k)}>{l}</button>)}</div>
          {adminSet === 'admin' && <SettingsView backend={backend} flash={flash} onChanged={() => { reload() }} inventoryStrains={invStrains} title="Admin settings"
            lists={[]} extra={[{ k: 'users', l: 'Users and access', node: <UsersTab backend={backend} me={me!} customers={snap.customers ?? []} flash={flash} /> },
              { k: 'perms', l: 'Permissions', node: <PermissionsPanel sb={backend.client()} flash={flash} /> },
              { k: 'licenses', l: 'Licenses', node: <LicensesPanel backend={backend} flash={flash} /> },
              { k: 'app', l: 'App settings', node: <AppSettingsPanel backend={backend} flash={flash} /> }]} />}
          {adminSet === 'dist' && distSettings}
          {adminSet === 'sales' && salesSettings}
          {adminSet === 'cult' && <>{cultSettings}{strainSettings}</>}
          {adminSet === 'nurs' && <Suspense fallback={<p className="muted">Loading…</p>}><NurseryView backend={backend} flash={flash} tab="settings" go={setNurTab} customers={snap.customers ?? []} isAdmin={isAdminOf('nurs')} sender={me?.display_name} me={me?.email} /></Suspense>}{adminSet === 'nurs' && nurStrainSettings}
          {adminSet === 'proc' && <Suspense fallback={<p className="muted">Loading…</p>}><ProcessingView backend={backend} flash={flash} tab="settings" go={setProcTab}
            isAdmin={isAdminOf('proc')} canEdit={isAdminOf('proc')} customers={snap.customers ?? []} strains={snap.strains ?? []} onChanged={() => { reload() }} /></Suspense>}
          {adminSet === 'acct' && <Suspense fallback={<p className="muted">Loading…</p>}><AccountingView backend={backend} flash={flash} tab="settings" go={setAcctTab}
            isAdmin={isAdminOf('acct')} canEdit={isAdminOf('acct')} notice={null} /></Suspense>}
          {adminSet === 'comp' && <Suspense fallback={<p className="muted">Loading…</p>}><ComplianceView backend={backend} flash={flash} tab="settings" go={setCompTab}
            isAdmin={isAdminOf('comp')} canEdit={isAdminOf('comp')} me={me?.email ?? null} /></Suspense>}
        </div>}
        {view === 'settings' && cur === 'dist' && distSettings}
      </main>

      {active(plan) && L && (
        <PlanBar plan={plan} code={id => ix.pallet.get(id)?.code ?? `#${id}`} lanes={lanes} busy={busy}
          stagingOpen={curFreezer?.kind === 'staging'}
          onPick={id => setPlan(pl => ({ ...pl, current: id }))}
          onDrop={id => setPlan(pl => dropFromPlan(pl, id))}
          onApply={() => applyPlan()} onCancel={() => setPlan(EMPTY)}
          onShuffle={l => setPlan(pl => addMoves(pl, l.moves))}
          onShuffleAll={() => setPlan(pl => lanes.reduce((acc, l) => addMoves(acc, l.moves), pl))}
          onFillStaging={() => curFreezer && setPlan(pl => fillStaging(L, pl, curFreezer.id))} />
      )}
      {!active(plan) && selecting && (
        <SelectBar n={sel.length} weight={selWeight} busy={busy}
          onMove={() => { setPlan(pl => addToTray(pl, sel)); setSel([]); setSelecting(false) }}
          onLoad={() => setPickLoadMany(sel.map(id => ix.pallet.get(id)!).filter(Boolean))}
          onClear={() => setSel([])} onDone={() => { setSelecting(false); setSel([]) }} />
      )}
      {!active(plan) && !selecting && lastBatch && (
        <UndoPill n={lastBatch.n} onClose={() => setLastBatch(null)}
          onUndo={() => { const b = lastBatch; setLastBatch(null); act(() => backend.undoBatch(b.id), 'Undone') }} />
      )}
      <DragGhost />
      {!noMods && <>
        <nav className={`bottom pbar ${canScan ? 'with-scan' : ''}`} aria-label={`${ML(cur)} screens`}>
          <button className={`pmod ${restOn ? 'on' : ''}`} aria-label={t('Switch module, now {m}', { m: ML(cur) })} onClick={() => setMore(true)}>
            <span className="pmod-i">{MOD_ICON[cur]}{restBadge > 0 && <i className="pdot" />}</span><span className="pl">{t(MOD_SHORT[cur])} ▴</span></button>
          {bottomFit.map((x, i) => <Fragment key={x.k}>
            {canScan && i === 2 && <div className="pscan-w"><button className="pscan" aria-label={t('Scan a METRC tag')} onClick={() => setScanning(true)}>{SCAN_ICON}</button></div>}
            <button className={`ptab ${x.on ? 'on' : ''}`} onClick={x.go}>
              <span className="pti">{screenIcon(x.k)}{(x.n ?? 0) > 0 && <b className={`pbadge ${x.warn ? 'warn' : ''}`}>{x.n}</b>}</span><span className="pl">{shortL(x)}</span></button>
          </Fragment>)}
        </nav>
        {more && (
          <div className="scrim" onClick={() => setMore(false)}>
            <div className="sheet modsheet" onClick={e => e.stopPropagation()}>
              <div className="sheet-h"><span /><button className="ghost" aria-label={t('Close')} onClick={() => setMore(false)}>✕</button></div>
              {myMods.length > 1 && <>
                <div className="msh">{t('Switch module')}</div>
                <div className="modgrid">{myMods.map(x => <button key={x.m} className={cur === x.m ? 'on' : ''} onClick={() => { setMore(false); goMod(x.m) }}>{MOD_ICON[x.m]}<span>{x.l}</span></button>)}</div>
              </>}
              <div className="msh">{t('More in {m}', { m: ML(cur) })}</div>
              <div className="morechips">{bottomRest.map(x => <button key={x.k} className={x.on ? 'on' : ''} onClick={() => { setMore(false); x.go() }}>{x.l}</button>)}</div>
            </div>
          </div>
        )}
      </>}

      {scanning && <Scanner typed onClose={() => setScanning(false)} onScan={handleScan} />}
      {scanMiss && (
        <div className="scrim" onClick={() => setScanMiss(null)}>
          <div className="sheet scanmiss" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><div><h2>{t('Tag not found')}</h2><div className="mono small">{scanMiss.tag}</div></div><button className="ghost" onClick={() => setScanMiss(null)}>✕</button></div>
            <p className="muted">{t('No pallet or package in the app has this tag, current or older.')}</p>
            {!scanMiss.checked ? <p className="muted">{t('Checking our METRC tag ranges…')}</p>
              : scanMiss.range ? <div className="okbox scanrange">{t('This tag is one of ours: {r}', { r: scanMiss.range })}</div>
              : <div className="warnbox">{t("This tag isn't in any of our METRC tag ranges. Check that it's ours before using it.")}</div>}
            <div className="choices col">
              {cur === 'dist' && canDist && <button onClick={() => { const tg = scanMiss.tag; setScanMiss(null); newWithTag(tg) }}>{t('Make a new pallet with this tag')}</button>}
              {cur === 'dist' && <button onClick={() => { const tg = scanMiss.tag; setScanMiss(null); setQuery(tg.slice(-6)); setView('map') }}>{t('Search by the last 6 digits')}</button>}
              <button onClick={() => { setScanMiss(null); setScanning(true) }}>{t('Scan again')}</button>
            </div>
          </div>
        </div>
      )}
      {selected && !banner && (
        <PalletSheet ix={ix} p={selected} busy={busy} where={where} flash={flash}
          others={selected.slot_id != null && !selected.container_id ? (ix.inSlot.get(selected.slot_id) ?? []).filter(x => x.id !== selected.id) : []}
          onPick={setPalletId}
          onClose={() => setPalletId(null)}
          onGo={() => { goTo(selected.container_id ? ix.pallet.get(selected.container_id)?.slot_id ?? null : selected.slot_id); setPalletId(null) }}
          onMove={() => {
            const lo = editLoadOf(selected.id)
            if (selected.status === 'in_transit' && lo) { setPalletId(null); ctx.putBack(lo.item, selected); return }
            setPlan(pl => addToTray(pl, [selected.id])); setPalletId(null); if (selected.slot_id != null) goTo(selected.slot_id); flash(`${selected.code} is in the tray. Tap the slot it goes to.`) }}
          onRemove={() => { setRemoveP(selected); setPalletId(null) }}
          onArchived={staff && selected.status === 'archived' ? () => { setArchQ(selected.code); setPalletId(null); go('archived') } : undefined}
          onClear={() => act(() => backend.clearReview(selected.id), 'Flag cleared')}
          onFlag={(why: string) => act(() => backend.flagReview(selected.id, why), 'Flagged for review')}
          onForm={(kind) => {
            if (kind === 'addto') setForm({ kind: 'pickmixed', p: selected })
            else if (kind === 'addmixed') setForm({ kind: 'addmixed', m: selected })
            else setForm({ kind, p: selected })
          }}
          onTakeOff={() => {
            const m = ix.pallet.get(selected.container_id!)!
            if (editLoadOf(m.id)) {
              setConfirm({ text: `Take ${selected.code} off ${m.code}? It stays on ${editLoadOf(m.id)!.load.code} as its own pallet (or move it to a freezer after).`, ok: 'Take off',
                run: () => act(() => backend.takeOffMixed(selected.id, null), `${selected.code} off ${m.code}, still on the load`) })
              return
            }
            startPlacing({ title: `Taking ${selected.code} off ${m.code}`, sub: 'Tap the slot it goes to.',
              run: slot => act(() => backend.takeOffMixed(selected.id, slot.id), `${selected.code} moved to ${slot.code}`) }, selected)
          }}
          onBreak={() => setConfirm({
            text: `Break ${selected.code} apart? Each package stays ${editLoadOf(selected.id) ? `on ${editLoadOf(selected.id)!.load.code}, stacked in its spot` : `in ${whereIs(ix, selected.slot_id)} as its own pallet, stacked in that slot`}.`, ok: 'Break apart',
            run: async () => { await act(() => backend.breakMixed(selected.id), `${selected.code} broken apart`); setPalletId(null) },
          })}
          onLineage={(ps) => setPool(ps)}
          loadInfo={ix.loadOf.get(selected.id)}
          held={heldBy.get(selected.id) ? `${heldBy.get(selected.id)!.customer} · ${heldBy.get(selected.id)!.so ?? 'order'} (${STATE_LABEL[heldBy.get(selected.id)!.state]})` : undefined}
          onHeld={() => { setPalletId(null); go('fulfill') }}
          inRun={snap.inRun?.[selected.id]}
          originAdmin={isAdminOf('dist') && !backend.demo}
          onOrigin={site => act(() => backend.setPalletOrigin(selected.id, site), `${selected.code}: grown at ${site}`)}
          canGrade={(isAdminOf('cult') || isAdminOf('sales')) && !backend.demo}
          onLotGrade={(lot, grade) => setConfirm({
            text: `Make all of lot ${lot.code} ${grade ?? `the strain default (${ix.strainGrade.get((selected.strain ?? '').toLowerCase().trim()) ?? 'SHO'})`}? Every pallet from it still in inventory follows, except pallets graded on their own.`,
            ok: grade ? `Make it ${grade}` : 'Use strain default',
            run: async () => {
              setBusy(true)
              try {
                const r = await backend.setLotGrade(lot.id, grade)
                await reload()
                const held = r.held.length ? `, ${r.held.length} held for orders (check Fulfillment)` : ''
                const shipped = r.shipped.length ? `. Already shipped: ${r.shipped.map(x => `${x.invoice} ${x.customer}`).join(', ')}` : ''
                flash(`Lot ${lot.code}: ${grade ?? 'strain default'} · ${r.on_hand.pallets} pallets on hand${held}${shipped}`)
              } catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
            },
          })}
          onPalletGrade={grade => act(() => backend.setPalletGrade(selected.id, grade), `${selected.code}: ${grade ?? 'same as lot'}`)}
          customerName={id => (snap.customers ?? []).find(c => c.id === id)?.name ?? ''}
          onOpenLoad={id => { setPalletId(null); setLoadId(id); setView('load') }}
          onPutOnLoad={() => setPickLoad(selected)}
          onPulled={() => { const lo = ix.loadOf.get(selected.id); if (lo) act(() => backend.loadPallet(lo.item.id), `${selected.code} on the truck`) }} />
      )}
      {doc && <DocSheet backend={backend} kind={doc.kind} id={doc.id} flash={flash} onClose={() => setDoc(null)} canEdit={isSales} canVoid={salesAdmin} sender={me?.display_name} />}
      {newOrder && <NewOrderSheet backend={backend} customers={snap.customers ?? []} strains={snap.strains ?? []} flash={flash} onClose={() => setNewOrder(false)}
        onDone={id => { setNewOrder(false); setOrdersKey(k => k + 1); refreshF(); setDoc({ kind: 'so', id }) }} />}
      {loadForm && <LoadForm ctx={ctx} load={loadForm.load} onClose={() => setLoadForm(null)} onSaved={id => { setLoadForm(null); setLoadId(id); setView('load') }} />}
      {pickLoad && <PickLoad ctx={ctx} ps={[pickLoad]} onClose={() => setPickLoad(null)} />}
      {pickLoadMany && <PickLoad ctx={ctx} ps={pickLoadMany} onClose={() => { setPickLoadMany(null); setSel([]); setSelecting(false) }} />}
      {choose && (() => {
        const p = ix.pallet.get(choose.id)!
        const occ = occupants(slotView(L!, { ...plan, moves: plan.moves.filter(m => m.id !== choose.id), tray: plan.tray.filter(x => x !== choose.id) }, choose.slot.id))
        return <ChooseDialog p={p} occ={occ} where={slotLabel(choose.slot)} canSwap={p.slot_id != null}
          onClose={() => setChoose(null)} onPick={m => doPlace(choose.id, choose.slot, m)} />
      })()}
      {removeP && <RemoveForm p={removeP} busy={busy} onClose={() => setRemoveP(null)}
        onSubmit={(r, note) => { const p = removeP; setRemoveP(null); act(() => backend.removePallet(p.id, r, note), `${p.code} removed`) }} />}

      {form?.kind === 'split' && (
        <SplitForm p={form.p} where={form.p.slot_id != null ? where(form.p) : null} busy={busy} onClose={() => setForm(null)}
          onLoad={editLoadOf(form.p.id) ? `${editLoadOf(form.p.id)!.load.code} with it (stop ${editLoadOf(form.p.id)!.stop.seq}${editLoadOf(form.p.id)!.item.loaded ? ', on the truck' : ''})` : null}
          onSubmit={(n, tag, pending, dest, note) => {
            const p = form.p
            const run = (slot: number | null, keep = false) => submit(() => backend.splitPallet(p.id, n, tag, pending, slot, note, keep), c => `${c.code} created (${lbs(n)})${keep ? ' on the load' : ''}`, () => setPalletId(null))
            if (dest === 'load') run(null, true)
            else if (dest === 'same') run(null)
            else startPlacing({ title: `Splitting ${lbs(n)} off ${p.code}`, sub: 'Tap the slot the new piece goes to.', run: slot => run(slot.id) }, p)
          }} />
      )}
      {form?.kind === 'merge' && (
        <MergeForm p={form.p} candidates={mergeCandidates(form.p)} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onLoad={editLoadOf(form.p.id) ? `Takes ${form.p.code}'s place on ${editLoadOf(form.p.id)!.load.code}` : null}
          onSubmit={(ids, tag, pending, dest, note) => {
            const p = form.p
            const run = (slot: number | null) => submit(() => backend.mergePallets(ids, tag, pending, slot ?? p.slot_id, note), m => `${m.code} created from ${ids.length} pallets`, m => { if (view !== 'proc') setPalletId(m.id) })
            if (dest === 'same' || dest === 'load') run(null)
            else startPlacing({ title: `Merging ${ids.length} pallets`, sub: 'Tap the slot for the merged pallet.', run: slot => run(slot.id) }, p)
          }} />
      )}
      {form?.kind === 'tag' && (
        <TagForm p={form.p} busy={busy} onClose={() => setForm(null)}
          onSubmit={tag => submit(() => backend.setTag(form.p.id, tag), () => 'Tag saved')} />
      )}
      {form?.kind === 'weight' && (
        <WeightForm p={form.p} busy={busy} onClose={() => setForm(null)}
          canAppOnly={!!me?.access?.owner || !!me?.access?.perms?.distribution?.audit_weight}
          onSubmit={(w, note, reason, appOnly) => submit(() => appOnly
            ? (async () => { const { error } = await backend.client()!.rpc('adjust_weight_app_only', { p_pallet_id: form.p.id, p_weight: w, p_note: note })
                if (error) throw new Error(/adjust_weight_app_only|schema cache/i.test(error.message) ? `${error.message} (run 097_audit_weight.sql in Supabase)` : error.message) })()
            : backend.adjustWeight(form.p.id, w, note, reason), () => appOnly ? 'Weight updated in the app only (nothing to METRC)' : 'Weight updated')} />
      )}
      {form?.kind === 'newchoice' && (
        <NewPalletChooser where={slotLabel(form.slot)} onClose={() => setForm(null)}
          onPick={k => setForm({ kind: k === 'mixed' ? 'newmixed' : k === 'merged' ? 'newmerged' : 'newsingle', slot: form.slot })} />
      )}
      {form?.kind === 'newmixed' && (
        <MixedBuilder title="New mixed pallet" autoTags={tagPool} target={slotLabel(form.slot)} candidates={looseList} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(lines, note) => submit(() => backend.createMixed(form.slot.id, lines, note), m => `${m.code} created with ${lines.length} package${lines.length === 1 ? '' : 's'}`, m => setPalletId(m.id))} />
      )}
      {form?.kind === 'newmerged' && (
        <MergeHere where={slotLabel(form.slot)} slot={form.slot.id} candidates={looseList.filter(p => p.kind !== 'mixed' && p.strain && p.current_weight)} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(ids, tag, pending, note) => submit(() => backend.mergePallets(ids, tag, pending, form.slot.id, note), m => `${m.code} created from ${ids.length} pallets`, m => setPalletId(m.id))} />
      )}
      {form?.kind === 'newsingle' && (
        <SingleForm where={slotLabel(form.slot)} slot={form.slot.id} tag={form.tag} strains={strainNames} busy={busy} onClose={() => setForm(null)}
          onSubmit={i => submit(() => backend.createSingle(form.slot.id, i), p => `${p.code} created`, p => setPalletId(p.id))} />
      )}
      {form?.kind === 'pickmixed' && (
        <PickMixed mixed={mixedList} whereOf={where} onClose={() => setForm(null)}
          onPick={m => setForm({ kind: 'addmixed', m, initial: [form.p] })} />
      )}
      {form?.kind === 'addmixed' && (
        <MixedBuilder title={`Pull for ${form.m.code}`} autoTags={tagPool} target={`${form.m.code} · ${where(form.m)}`} candidates={[...looseList, ...sameStop(form.m)]} initial={form.initial}
          whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(lines, note) => { const m = form.m; submit(() => backend.addToMixed(m.id, lines, note), () => `Pulled ${lines.length} for ${m.code}`, () => setPalletId(m.id)) }} />
      )}

      {form?.kind === 'stopmixed' && (() => {
        const st = (snap.stops ?? []).find(x => x.id === form.stop)
        const onStop = snap.pallets.filter(x => !x.container_id && isPackage(x) && editLoadOf(x.id)?.item.stop_id === form.stop)
        return <MixedBuilder title="New mixed pallet on the load" autoTags={tagPool} target={`stop ${st?.seq ?? ''}${form.onTruck ? ', on the truck' : ' (planned)'}`}
          candidates={[...onStop, ...looseList]} initial={onStop.slice(0, 0)} whereOf={where} busy={busy} onClose={() => setForm(null)}
          onSubmit={(lines, note) => submit(() => rpc<Pallet>(backend.client(), 'create_mixed_on_stop', { p_stop: form.stop, p_lines: lines, p_on_truck: form.onTruck, p_note: note || null }),
            m => `${m.code} made on the load with ${lines.length} package${lines.length === 1 ? '' : 's'}`)} />
      })()}
      {crossSite && <CrossSiteDialog cs={crossSite} vehicles={(snap.vehicles ?? []).filter(v => v.active && v.kind !== 'Customer pickup')} drivers={(snap.drivers ?? []).filter(d => d.active).map(d => d.name)}
        code={id => ix.pallet.get(id)?.code ?? ''} busy={busy} onClose={() => setCrossSite(null)}
        onNo={async () => { setCrossSite(null); await applyPlan(true) }}
        onYes={async (vehicle, driver) => {
          const cs = crossSite; setCrossSite(null)
          const sb = backend.client()
          setBusy(true)
          try {
            const crossIds = new Set(cs.cross.map(c => c.id))
            const rest = cs.moves.filter(m => !crossIds.has(m.pallet_id))
            if (rest.length) await backend.applyMoves(rest)
            const made: string[] = []
            for (const to of [...new Set(cs.cross.map(c => c.to))]) {
              const ids = cs.cross.filter(c => c.to === to).map(c => c.id)
              const loadId = await rpc<number>(sb, 'quick_transfer', { p_pallets: ids, p_to_site: to, p_vehicle: vehicle, p_driver: driver }, '090_receiving')
              const { data: kinds } = await sb!.from('metrc_push_kinds').select('mode').eq('kind', 'transfer')
              if ((kinds?.[0]?.mode ?? 'off') !== 'off') {
                await metrcRun(sb!, { action: 'checklist', load_id: loadId })
                const r = await metrcRun<{ departed: boolean; error?: string }>(sb!, { action: 'depart', load_id: loadId })
                made.push(r.departed ? `transfer to ${to} made (METRC manifest)` : `load to ${to} made, but the manifest didn't go: ${r.error ?? ''} (open it in Transit)`)
              } else {
                await rpc(sb, 'depart_prepare', { p_load: loadId })
                const fin = await rpc<{ departed?: boolean; error?: string }>(sb, 'depart_finish', { p_load: loadId })
                if (fin.departed === false) throw new Error(fin.error)
                made.push(`load to ${to} left (METRC transfers are Off: make the manifest by hand)`)
              }
            }
            await reload(); setPlan(EMPTY); setSel([]); setSelecting(false)
            flash(`${made.join(' · ')}. Mark it delivered in Transit when it gets there, then put the pallets in their spots.`)
          } catch (e) { flash((e as Error).message, true); reload().catch(() => {}) } finally { setBusy(false) }
        }} />}
      {confirm && (
        <div className="scrim" onClick={() => setConfirm(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <p>{confirm.text}</p>
            <div className="row end">
              <button className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={async () => { const c = confirm; setConfirm(null); await c.run() }}>{confirm.ok}</button>
            </div>
          </div>
        </div>
      )}
      {snap && <StrainCardHost backend={backend} strains={snap.strains ?? []} flash={flash} onChanged={() => { reload() }} />}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}
    </div></TagSuggestProvider>
  )
}

// ---------- views ----------

function ViewAsBar({ me, stop }: { me: Me; stop: () => void }) {
  const label: Record<string, string> = { sales: 'Sales', crew: 'Crew', customer: 'Customer', none: 'No access' }
  return (
    <div className="viewas">
      <span>Viewing as <b>{me.display_name || me.email}</b> ({label[me.role] ?? me.role}{me.customer_name ? ` · ${me.customer_name}` : ''}). Read-only.</span>
      <button className="small" onClick={stop}>Stop</button>
    </div>
  )
}

function NoAccess({ me, signOut }: { me: Me; signOut: () => void }) {
  return (
    <div className="center login">
      <img className="logo-login logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-login logo-d" src="/logo-dark.svg" alt="Lifted Farms" />
      {me.role === 'customer'
        ? <><h2>Hi{me.display_name ? ` ${me.display_name}` : ''}</h2><p className="muted">Your login is set up for {me.customer_name ?? 'your company'}. The order portal is coming soon.</p></>
        : IS_PORTAL
          ? <><h2>Login not set up</h2><p className="muted">{me.email} isn't connected to a customer account yet. Use the invite link from your Lifted contact.</p></>
          : <><h2>No access yet</h2><p className="muted">{me.email} isn't set up for the Lifted Farms app. Ask an admin to add you in Settings &gt; Users.</p></>}
      <button className="ghost" onClick={signOut}>Sign out</button>
    </div>
  )
}

function Login() {
  const [code, setCode] = useState<null | { email: string; sent: boolean; code: string; busy: boolean; err: string | null }>(null)
  const send = async () => {
    if (!code) return
    setCode({ ...code, busy: true, err: null })
    try { await backend.sendCode(code.email); setCode({ ...code, sent: true, busy: false, err: null }) } catch (e) { setCode({ ...code, busy: false, err: (e as Error).message }) }
  }
  const verify = async () => {
    if (!code) return
    setCode({ ...code, busy: true, err: null })
    try { await backend.verifyCode(code.email, code.code) } catch (e) { setCode({ ...code, busy: false, err: (e as Error).message }) }
  }
  return (
    <div className="center login">
      <img className="logo-login logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-login logo-d" src="/logo-dark.svg" alt="Lifted Farms" />
      <h1>Lifted Farms</h1>
      <p className="muted">Distribution, sales and production</p>
      {!code && <button className="primary big" onClick={() => backend.signIn()}>Sign in with Microsoft</button>}
      {!code && <p className="muted small-print">No Lifted email? <a onClick={() => setCode({ email: '', sent: false, code: '', busy: false, err: null })}>Sign in with an email code</a></p>}
      {code && <div className="codebox">
        {!code.sent ? <>
          <input type="email" autoFocus placeholder="Your email" value={code.email} onChange={e => setCode({ ...code, email: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') send() }} />
          <button className="primary big" disabled={code.busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(code.email.trim())} onClick={send}>{code.busy ? 'Sending…' : 'Email me a code'}</button>
        </> : <>
          <p className="muted">We sent a 6-digit code to {code.email}. It works for one hour.</p>
          <input inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Code" value={code.code} maxLength={10}
            onChange={e => setCode({ ...code, code: e.target.value.replace(/\D/g, '') })} onKeyDown={e => { if (e.key === 'Enter') verify() }} />
          <button className="primary big" disabled={code.busy || code.code.length < 6} onClick={verify}>{code.busy ? 'Checking…' : 'Sign in'}</button>
          <a className="small-print" onClick={() => setCode({ ...code, sent: false, code: '' })}>Send a new code</a>
        </>}
        {code.err && <p className="bad-t">{code.err}</p>}
        <p className="muted small-print">Only for people an Admin has added. <a onClick={() => setCode(null)}>Back to Microsoft sign-in</a></p>
      </div>}
      <p className="muted small-print">Customer? <a href={portalUrl('?portal')}>Sign in to the order portal</a></p>
    </div>
  )
}

function MiniGrid({ ix, slots, query }: { ix: Index; slots: Slot[]; query: string }) {
  return (
    <div className="mini">
      {[...slots].sort((a, b) => a.row - b.row || a.col - b.col).map(s => {
        const ps = ix.inSlot.get(s.id) ?? []
        const mixed = ps.some(p => p.kind === 'mixed')
        const sw = swatch(ps[0]?.strain)
        const hit = ps.some(p => matches(p, query, ix))
        if (ps.length > 1) return (
          <i key={s.id} className={`full stack ${query && !hit ? 'dim' : ''}`}>
            {ps.map(p => { const w = swatch(p.strain); return <b key={p.id} className={p.kind === 'mixed' ? 'mx' : w.cls} style={p.kind === 'mixed' ? undefined : w.style} /> })}
          </i>
        )
        return <i key={s.id} className={`${ps.length ? `full ${mixed ? 'mx' : sw.cls}` : ''} ${query && !hit ? 'dim' : ''}`}
          style={ps.length && !mixed ? sw.style : undefined} />
      })}
    </div>
  )
}

function MapView({ ix, freezers, trailers = [], staging, query, extra, where, onOpen, onPallet, needsSpot = [] }: {
  ix: Index; freezers: Freezer[]; trailers?: Freezer[]; staging?: Freezer; query: string; extra: Pallet[]; where: (p: Pallet) => string
  onOpen: (id: number) => void; onPallet: (id: number) => void; needsSpot?: Pallet[]
}) {
  const [showSpot, setShowSpot] = useState(false)
  const ids = new Set(freezers.map(f => f.id))
  const inSite = (p: Pallet) => p.slot_id != null && ids.has(ix.slot.get(p.slot_id)?.freezer_id ?? -1)
  const tops = [...ix.pallet.values()].filter(p => !p.container_id && inSite(p))
  const packages = [...ix.pallet.values()].filter(p => isPackage(p) && inSite(p))
  const total = packages.reduce((a, p) => a + (p.current_weight ?? 0), 0)
  const open = freezers.reduce((a, f) => f.status === 'Not Working' ? a : a + (ix.slotsOf.get(f.id) ?? []).filter(s => !ix.inSlot.get(s.id)?.length).length, 0)
  const hits = query ? [...ix.pallet.values()].filter(p => matches(p, query)) : []
  const hitIds = new Set(hits.map(h => h.id))
  const older = extra.filter(p => !hitIds.has(p.id))
  const hitLbs = hits.filter(isPackage).reduce((a, p) => a + (p.current_weight ?? 0), 0)
  return (
    <>
      <div className="stats">
        <div><b>{freezers.length}</b><span>freezers</span></div>
        <div><b>{tops.length}</b><span>pallets</span></div>
        <div><b>{Math.round(total).toLocaleString()}</b><span>lbs</span></div>
        <div><b>{open}</b><span>open slots</span></div>
      </div>
      {query && (
        <div className="hits">
          <div className="muted">{hits.length} in inventory matching "{query}"{hits.length > 0 && ` · ${lbs(hitLbs)}`}</div>
          <div className="hitlist">
            {hits.slice(0, 60).map(p => (
              <button key={p.id} className="hit" onClick={() => onPallet(p.id)}>
                <b>{p.code}</b> <span>{p.kind === 'mixed' ? 'Mixed' : p.strain}</span> <span className="muted">{where(p)}</span>
              </button>
            ))}
            {older.slice(0, 30).map(p => (
              <button key={p.id} className="hit old" onClick={() => onPallet(p.id)}>
                <b>{p.code}</b> <span>{p.strain}</span> <span className="muted">{p.status}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {staging && (() => {
        const ss = ix.slotsOf.get(staging.id) ?? []
        const sp = ss.flatMap(s => ix.inSlot.get(s.id) ?? [])
        return (
          <button className="stagecard" onClick={() => onOpen(staging.id)}>
            <b>Staging</b><span className="muted">{sp.length}/26 · {lbs(sp.reduce((a, p) => a + weightOf(ix, p), 0))}</span>
            <span className="stage-strip">{sp.slice(0, 26).map(p => { const w = swatch(p.strain); return <i key={p.id} className={p.kind === 'mixed' ? 'mx' : w.cls} style={p.kind === 'mixed' ? undefined : w.style} /> })}</span>
          </button>
        )
      })()}
      {needsSpot.length > 0 && <>
        <button className="stagecard needspot" onClick={() => setShowSpot(v => !v)}>
          <b>Needs a spot</b><span className="muted">{needsSpot.length} pallet{needsSpot.length === 1 ? '' : 's'} · {lbs(needsSpot.reduce((a, p) => a + weightOf(ix, p), 0))} · received, not in a slot yet</span>
          <span className="muted small">{showSpot ? 'Hide' : 'Show'}</span>
        </button>
        {showSpot && <div className="hitlist spotlist">
          {needsSpot.map(p => <button key={p.id} className="hit" onClick={() => onPallet(p.id)}>
            <b>{p.code}</b> <span>{p.kind === 'mixed' ? 'Mixed' : p.strain}</span> <span className="muted">{lbs(weightOf(ix, p))}</span></button>)}
          <p className="muted small">Tap one, then Move to put it in a slot. They can also go straight onto a load from here.</p>
        </div>}
      </>}
      {[freezers, trailers].map((list, li) => list.length > 0 && (
        <div key={li}>
          {li === 1 && <h3 className="map-sec">Reefer trailers{list[0]?.site === 'GVR' && <> <span className="muted">dry flower · processor license</span></>}</h3>}
          <div className={`cards ${li === 1 ? 'trailers' : ''}`}>
            {list.map(f => {
              const slots = ix.slotsOf.get(f.id) ?? []
              const ps = slots.flatMap(s => ix.inSlot.get(s.id) ?? [])
              const used = slots.filter(s => ix.inSlot.get(s.id)?.length).length
              const w = ps.reduce((a, p) => a + weightOf(ix, p), 0)
              return (
                <button key={f.id} className={`card st-${f.status.replace(/ /g, '-')}`} onClick={() => onOpen(f.id)}>
                  <div className="card-h"><b>{fShort(f)}</b><span className="dot" title={f.status} /></div>
                  <MiniGrid ix={ix} slots={slots} query={query} />
                  <div className="card-f">{used}/{slots.length} · {Math.round(w / 100) / 10}k</div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}

function FreezerView({ ix, L, plan, freezer, query, placing, selecting, sel, siblings, onOpen, onBack, onSlot, onPalletTap, onStatus, onSelect, onCompact }: {
  ix: Index; L: Layout; plan: Plan; freezer: Freezer; query: string; placing: boolean; selecting: boolean; sel: number[]; siblings: Freezer[]
  onOpen: (id: number) => void; onBack: () => void; onSlot: (s: Slot) => void
  onPalletTap: (p: Pallet, role: 'stay' | 'incoming' | 'leaving', s: Slot) => void; onStatus: (s: FreezerStatus) => void
  onSelect: () => void; onCompact: () => void
}) {
  const staging = freezer.kind === 'staging'
  const slots = ix.slotsOf.get(freezer.id) ?? []
  const grid = [...slots].sort((a, b) => a.row - b.row || a.col - b.col)
  const views = new Map(grid.map(s => [s.id, slotView(L, plan, s.id)]))
  const ps = grid.flatMap(s => occupants(views.get(s.id)!))
  const i = siblings.findIndex(f => f.id === freezer.id)
  const prev = staging ? undefined : siblings[i - 1], next = staging ? undefined : siblings[i + 1]
  const dead = freezer.status === 'Not Working'
  const placingNow = placing || plan.tray.length > 0
  const trailer = freezer.kind === 'trailer'
  // trailers: a pallet stretched over more spots covers the spots between its own and span_to_slot (same side)
  const coveredBy = new Map<number, Pallet>()
  if (trailer) for (const s of grid) for (const p of ix.inSlot.get(s.id) ?? []) {
    const to = p.span_to_slot != null ? ix.slot.get(p.span_to_slot) : undefined
    if (!to) continue
    for (const x of grid) if (x.id !== s.id && x.col === s.col && x.row >= Math.min(s.row, to.row) && x.row <= Math.max(s.row, to.row)) coveredBy.set(x.id, p)
  }
  const tile = (p: Pallet, role: 'stay' | 'incoming' | 'leaving', s: Slot, stacked: boolean, m?: PlanMove) => {
    const on = ix.contentsOf.get(p.id) ?? []
    const sw = swatch(p.strain)
    const picked = sel.includes(p.id)
    const note = role === 'incoming' ? `from ${m?.from != null ? whereIs(ix, m.from).split(' · ').pop() : 'no spot'}${m?.kind === 'shuffle' ? ' (shuffle)' : m?.kind === 'swap' ? ' (swap)' : ''}`
      : role === 'leaving' ? (m ? `→ ${whereIs(ix, m.to)}` : 'in the tray') : ''
    return (
      <span key={`${role}-${p.id}`} data-pallet={p.id}
        className={`p ${stacked ? `band ${p.kind === 'mixed' ? 'mx' : sw.cls}` : ''} r-${role} ${picked ? 'picked' : ''}`}
        style={stacked && p.kind !== 'mixed' ? sw.style : undefined}
        {...(role !== 'leaving' && !placing ? draggable({ id: p.id, label: `${p.code} · ${p.kind === 'mixed' ? 'Mixed' : p.strain ?? ''}` }) : {})}
        onClick={e => { e.stopPropagation(); onPalletTap(p, role, s) }}>
        <b>{selecting && <span className={`tick ${picked ? 'on' : ''}`}>{picked ? '✓' : ''}</span>}{p.code}{p.needs_review && <span className="flag" title={p.needs_review}>!</span>}{(p.tag_pending || on.some(c => c.tag_pending)) && <span className="flag tag" title="METRC tag pending">T</span>}{ix.loadOf.has(p.id) && <span className="flag load" title={`Planned on ${ix.loadOf.get(p.id)!.load.code}`}>L</span>}{p.pushed === false && <span className="flag np" title="Not pushed to METRC yet (Harvest log)">NP</span>}</b>
        <span className="strain">{note ? <i className="pnote">{note}</i> : p.kind === 'mixed' ? `Mixed · ${on.length} pkg${on.length === 1 ? '' : 's'}: ${[...new Set(on.map(c => c.strain))].join(', ')}` : <>{p.product && p.product !== 'fresh_frozen' && <em className="prodtag">{PRODUCT_SHORT[p.product]}</em>}{(p.product ?? 'fresh_frozen') === 'fresh_frozen' && gradeOf(ix, p).grade === 'BHO' && <em className="prodtag bho">BHO</em>}{p.strain ?? p.label ?? 'No strain'}</>}</span>
        <span className="w">{p.kind !== 'mixed' && p.current_weight == null ? 'no weight' : lbs(weightOf(ix, p))}</span>
        {trailer && role === 'stay' && !placing && !stacked && <span className="spangrip" title="Drag to another spot on this side to make it take more space; drag back here to undo"
          {...draggable({ id: p.id, label: `${p.code}: take spots to…`, span: true })} onClick={e => e.stopPropagation()}>⇕</span>}
      </span>
    )
  }
  return (
    <div className={`freezer ${staging ? 'staging' : ''}`}>
      <div className="fz-head">
        <button className="ghost" onClick={onBack}>‹ All</button>
        <div className="fz-title">
          <h2>{freezer.site} {staging ? 'Staging' : fName(freezer)}</h2>
          <div className="muted">{ps.length} pallet{ps.length === 1 ? '' : 's'}{staging ? ` of 26` : ''} · {lbs(ps.reduce((a, p) => a + weightOf(ix, p), 0))}</div>
        </div>
        {!staging && <Select className={`status st-${freezer.status.replace(/ /g, '-')}`} value={freezer.status}
          onChange={e => onStatus(e.target.value as FreezerStatus)}>
          {FREEZER_STATUSES.map(s => <option key={s}>{s}</option>)}
        </Select>}
      </div>
      <div className="row between fz-tools">
        {!staging ? <button className="ghost small" disabled={!prev} onClick={() => prev && onOpen(prev.id)}>‹ {prev ? fShort(prev) : ''}</button> : <span />}
        <div className="row">
          <button className={`ghost small ${selecting ? 'on-btn' : ''}`} onClick={onSelect}>{selecting ? 'Selecting' : 'Select'}</button>
          {!staging && <button className="ghost small" onClick={onCompact}>Compact</button>}
        </div>
        {!staging ? <button className="ghost small" disabled={!next} onClick={() => next && onOpen(next.id)}>{next ? fShort(next) : ''} ›</button> : <span />}
      </div>
      {!staging && <div className="muted small-t center-t">BACK</div>}
      {staging && <p className="muted small-note">Where orders get built. Positions fill in the order you place pallets.</p>}
      <div className={`grid ${staging ? 'stage-grid' : ''} ${dead && placingNow ? 'dead' : ''}`}>
        {grid.map(s => {
          const v = views.get(s.id)!
          const occ = occupants(v)
          const all = occ.length + v.leaving.length
          const stacked = all > 1
          const first = occ[0] ?? v.leaving[0]?.p
          const mixed = !stacked && first?.kind === 'mixed'
          const sw = swatch(first?.strain)
          const dim = query && !occ.some(p => matches(p, query, ix))
          const ghostOnly = occ.length === 0 && v.leaving.length > 0
          return (
            <button key={s.id} data-slot={s.id}
              className={`tile ${coveredBy.has(s.id) && !all ? 'spanned' : ''} ${all ? 'full' : 'empty'} ${placingNow && !dead ? (occ.length ? 'can-combine' : 'can-drop') : ''} ${dim ? 'dim' : ''} ${stacked ? 'stacked' : all ? (mixed ? 'mx' : sw.cls) : ''} ${ghostOnly ? 'vacating' : ''} ${v.incoming.length ? 'arriving' : ''}`}
              style={all && !mixed && !stacked ? sw.style : undefined}
              disabled={placingNow && dead}
              onClick={() => onSlot(s)}>
              <span className="code">{staging ? s.row : freezer.kind === 'trailer' ? s.code.slice(2) : s.code}</span>
              {all === 0 && coveredBy.has(s.id) && <span className="muted covered">↕ {coveredBy.get(s.id)!.code}</span>}
              {all === 0 && !coveredBy.has(s.id) && <span className="muted">{placingNow ? (dead ? 'Not working' : 'Place here') : dead ? 'empty' : staging ? '' : '+ New pallet'}</span>}
              {stacked && !placing && v.stay.length > 1 && <span className="stackgrip" title="Drag to move the whole stack" onClick={e => e.stopPropagation()}
                {...draggable({ id: v.stay[0].id, ids: v.stay.map(p => p.id), label: `Stack of ${v.stay.length}: ${v.stay.map(p => p.code).join(', ')}` })}>⠿ all {v.stay.length}</span>}
              {v.stay.map(p => tile(p, 'stay', s, stacked))}
              {v.incoming.map(x => tile(x.p, 'incoming', s, stacked, x.m))}
              {v.leaving.map(x => tile(x.p, 'leaving', s, stacked, x.m))}
            </button>
          )
        })}
      </div>
      {!staging && <div className="door">DOOR</div>}
    </div>
  )
}

function UnmatchedTags({ tags, busy, run, find }: {
  tags: UnmatchedTag[]; busy: boolean; run: (fn: () => Promise<unknown>, ok: string) => void; find: (strain: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="list">
      <h2 className="tap" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Shipped Roshi tags not on the map ({tags.length})</h2>
      <p className="muted">Roshi shipped these METRC tags, but no pallet in the app has them, so the app can't check them. Usually the pallet's tag on the map is wrong or missing, or it was never on the map. Fix the tag on the right pallet (open it, Enter tag), or dismiss.</p>
      {open && tags.map(t => (
        <div key={t.package_tag} className="li">
          <div><b>{t.strain}</b> <span className="muted">{lbs(Number(t.lbs))}{t.tags_on_line > 1 ? ` (line split over ${t.tags_on_line} tags)` : ''}</span></div>
          <div className="muted mono">{t.package_tag}</div>
          <div className="muted">{t.sos}{t.last_shipped ? ` · ${t.last_shipped}` : ''}</div>
          <div className="row reqact">
            <button className="ghost small" onClick={() => find(t.strain)}>Find {t.strain} pallets</button>
            <button className="ghost small" onClick={() => { navigator.clipboard?.writeText(t.package_tag) }}>Copy tag</button>
            <button className="ghost small" disabled={busy} onClick={() => run(() => backend.dismissTag(t.package_tag), 'Dismissed')}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function ShippedReview({ checks, ix, where, busy, onPallet, run }: {
  checks: ShippedCheck[]; ix: Index; where: (p: Pallet) => string; busy: boolean; onPallet: (id: number) => void
  run: (fn: () => Promise<unknown>, ok: string) => void
}) {
  const [open, setOpen] = useState<ShippedCheck | null>(null)
  const p = open ? ix.pallet.get(open.pallet_id) : undefined
  const left = p ? Math.max(Number(p.current_weight ?? 0) - Number(open!.new_lbs), 0) : 0
  return (
    <div className="list">
      <h2>Shipped in Roshi, still in a freezer ({checks.length})</h2>
      <p className="muted">Roshi says these METRC tags shipped, but the pallet with that tag is still on the map. Take it out, fix its weight if only part shipped, or mark it handled.</p>
      {checks.map(c => {
        const q = ix.pallet.get(c.pallet_id)!
        return (
          <button key={c.package_tag} className="li" onClick={() => setOpen(c)}>
            <div><b>{q.code}</b> {q.strain} <span className="muted">{lbs(Number(q.current_weight ?? 0))} on the map</span> · <span className="warn-t">{lbs(Number(c.new_lbs))} shipped</span></div>
            <div className="muted">{where(q)} · {c.sos}{c.last_shipped ? ` · last ${c.last_shipped}` : ''}</div>
          </button>
        )
      })}
      {open && p && (
        <div className="scrim" onClick={() => setOpen(null)}>
          <div className="sheet form" onClick={e => e.stopPropagation()}>
            <div className="sheet-h"><h2>{p.code} · {p.strain}</h2><button className="ghost" onClick={() => setOpen(null)}>✕</button></div>
            <p>Roshi shipped <b>{lbs(Number(open.new_lbs))}</b> from tag {open.package_tag} ({open.sos}). The map still has <b>{lbs(Number(p.current_weight ?? 0))}</b> on this pallet at {where(p)}{p.og_weight != null && Number(p.og_weight) !== Number(p.current_weight) ? <> (it started at {lbs(Number(p.og_weight))}, so it may already be adjusted)</> : null}.</p>
            <div className="choices col">
              <button disabled={busy} onClick={() => { run(() => backend.markShipped(p.id, `Shipped in Roshi (${open.sos})`), `${p.code} taken out of inventory`); setOpen(null) }}>
                <b>All of it shipped</b> <span className="muted">Take {p.code} out of inventory</span></button>
              {left > 0 && <button disabled={busy} onClick={() => { run(async () => { await backend.adjustWeight(p.id, left, `Part shipped in Roshi (${open.sos})`); await backend.ackShipped(open.package_tag) }, `${p.code} now ${lbs(left)}`); setOpen(null) }}>
                <b>Part of it shipped</b> <span className="muted">Set {p.code} to {lbs(left)}</span></button>}
              <button disabled={busy} onClick={() => { run(() => backend.ackShipped(open.package_tag), 'Marked handled'); setOpen(null) }}>
                <b>Already handled</b> <span className="muted">The map is right, clear this</span></button>
              <button onClick={() => { onPallet(p.id); setOpen(null) }}><b>Open the pallet</b> <span className="muted">Split it or fix it by hand</span></button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ListView({ title, note, empty, items, ix, where, onPallet, showReason }: {
  title: string; note?: string; empty: string; items: Pallet[]; ix: Index; where: (p: Pallet) => string
  onPallet: (id: number) => void; showReason?: boolean
}) {
  return (
    <div className="list">
      <h2>{title}</h2>
      {note && <p className="muted">{note}</p>}
      {items.length === 0 && empty && <p className="muted">{empty}</p>}
      {items.map(p => (
        <button key={p.id} className="li" onClick={() => onPallet(p.id)}>
          <div><b>{p.code}</b> {p.strain ?? p.label} <span className="muted">{lbs(weightOf(ix, p))}</span></div>
          <div className="muted">{where(p)}{showReason && p.needs_review && <> · <span className="warn-t">{p.needs_review}</span></>}</div>
        </button>
      ))}
    </div>
  )
}

/** which module an activity line belongs to */
function eventModule(e: InvEvent): 'distribution' | 'sales' | 'admin' | 'nursery' | 'cultivation' | 'processing' | 'accounting' | 'compliance' {
  const t = e.type, d = e.details as { list?: string; via?: string } | null
  if (/^comp_/.test(t)) return 'compliance'
  if (/^acct_/.test(t) || (t === 'invoice_paid' && d?.via === 'QuickBooks')) return 'accounting'
  if (/^nursery/.test(t)) return 'nursery'
  if (/^proc_/.test(t) || t === 'pay_day' || t === 'pay_employee') return 'processing'
  if (/^pay_/.test(t)) return 'accounting'
  if (/^cult_log/.test(t)) return 'cultivation'
  if (/^invoice/.test(t)) return 'sales'
  if (/^license/.test(t)) return 'admin'
  if (/^(reserve|order|terms|customer_terms)/.test(t) || (t === 'settings' && /^(customers|reserve deadlines|terms)/.test(d?.list ?? ''))) return 'sales'
  if (/^(user_|app_setting|view_as|login_|password_)/.test(t)) return 'admin'
  return 'distribution'
}
const CULT_TBL: Record<string, string> = { cult_harvests: 'Harvest', cult_plantings: 'Planting', cult_tests: 'Test', cult_flower_picks: 'Dry flower pick', cult_demand: 'Plan strain',
  cult_plan: 'Plan row', cult_nursery_orders: 'Nursery delivery', cult_receipts: 'Plants received', app_settings: 'Production setting' }
interface Line { id: string; at: string; who: string | null; text: ReactNode; note?: string | null; mod: 'distribution' | 'sales' | 'admin' | 'cultivation' | 'nursery' | 'processing' | 'accounting' | 'compliance' }

/** Activity: each module shows its own; Admin shows everything with a filter */
/** loading screen: the logo and a quiet spinner, same for every module */
function Splash() {
  return <div className="center splash"><img className="logo-login logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-login logo-d" src="/logo-dark.svg" alt="Lifted Farms" /><div className="spin" aria-label="Loading" /></div>
}

function ActivityView({ ix, module }: { ix: Index; module: 'distribution' | 'sales' | 'processing' | 'accounting' | 'compliance' | 'all' }) {
  const [events, setEvents] = useState<InvEvent[] | null>(null)
  const [cult, setCult] = useState<Line[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [only, setOnly] = useState<string>('all')
  useEffect(() => {
    backend.recentEvents(module === 'all' ? 500 : 300).then(async evs => {
      setEvents(evs)
      const missing = [...new Set(evs.map(e => e.pallet_id).filter((id): id is number => id != null && !ix.pallet.has(id)))]
      if (missing.length) setNames(new Map((await backend.byIds(missing)).map(p => [p.id, p.code])))
    })
    const sb = backend.client()
    if (module === 'all' && sb) sb.from('cult_log').select('*').order('at', { ascending: false }).limit(300).then(({ data }) => setCult(((data ?? []) as { id: number; at: string; user_email: string | null; tbl: string; op: string; data: Record<string, unknown> | null; was: Record<string, unknown> | null }[]).map(r => {
      const name = (r.data?.strain ?? r.was?.strain ?? '') as string
      return { id: `c${r.id}`, at: r.at, who: r.user_email, mod: 'cultivation' as const,
        text: `${CULT_TBL[r.tbl] ?? r.tbl} ${r.op === 'insert' ? 'added' : r.op === 'delete' ? 'deleted' : 'changed'}${name ? `: ${name}` : ''}` }
    })))
  }, [ix, module])
  const lines: Line[] = [...(events ?? []).map(e => ({ id: `e${e.id}`, at: e.at, who: e.user_email, text: describe(ix, e, names), note: e.note, mod: eventModule(e) } as Line)), ...cult]
    .filter(l => module === 'all' ? only === 'all' || l.mod === only : l.mod === module)
    .sort((a, b) => b.at.localeCompare(a.at))
  const CH: [string, string][] = [['all', 'Everything'], ['distribution', 'Distribution'], ['sales', 'Sales'], ['cultivation', 'Production'], ['nursery', 'Nursery'], ['processing', 'Processing'], ['accounting', 'Accounting'], ['compliance', 'Compliance'], ['admin', 'Admin']]
  return (
    <div className="list">
      <h2>Activity</h2>
      {module === 'all' && <div className="seg tabs">{CH.map(([k, l]) => <button key={k} className={only === k ? 'on' : ''} onClick={() => setOnly(k)}>{l}</button>)}</div>}
      {events && lines.length === 0 && <p className="muted">Nothing yet. Everything people do here shows up in this list.</p>}
      {lines.map(l => (
        <div key={l.id} className="li static">
          <div>{module === 'all' && only === 'all' && <span className="pill">{CH.find(c => c[0] === l.mod)?.[1]}</span>} {l.text}</div>
          <div className="muted">{when(l.at)} · {who(l.who)}{l.note && <> · "{l.note}"</>}</div>
        </div>
      ))}
    </div>
  )
}

type SheetAction = 'split' | 'merge' | 'tag' | 'weight' | 'addto' | 'addmixed'

function PalletSheet({ ix, p, others, busy, where, flash, onArchived, onClose, onGo, onMove, onRemove, onClear, onFlag, onPick, onForm, onTakeOff, onBreak, onLineage, loadInfo, customerName, onOpenLoad, onPutOnLoad, onPulled, held, onHeld, originAdmin, onOrigin, inRun, canGrade, onLotGrade, onPalletGrade }: { flash: (t: string, bad?: boolean) => void;
  onArchived?: () => void
  held?: string; onHeld?: () => void; originAdmin?: boolean; onOrigin?: (site: string) => void; inRun?: string
  canGrade?: boolean; onLotGrade?: (lot: HarvestLot, grade: Grade | null) => void; onPalletGrade?: (grade: Grade | null) => void
  ix: Index; p: Pallet; others: Pallet[]; busy: boolean; where: (p: Pallet) => string
  onClose: () => void; onGo: () => void; onMove: () => void; onRemove: () => void; onClear: () => void; onFlag: (why: string) => void; onPick: (id: number) => void
  onForm: (kind: SheetAction) => void; onTakeOff: () => void; onBreak: () => void; onLineage: (ps: Pallet[]) => void
  loadInfo?: { item: LoadItem; load: Load; stop: LoadStop }; customerName: (id: number) => string
  onOpenLoad: (id: number) => void; onPutOnLoad: () => void; onPulled: () => void
}) {
  const [hist, setHist] = useState<InvEvent[] | null>(null)
  const [kin, setKin] = useState<Pallet[]>([])
  const contents = ix.contentsOf.get(p.id) ?? []
  const [flagWhy, setFlagWhy] = useState<string | null>(null)
  useEffect(() => { setHist(null); backend.palletEvents(p.id).then(setHist) }, [p.id, p.slot_id, p.needs_review, p.current_weight, p.package_tag, p.status, p.container_id, contents.length])
  useEffect(() => {
    if (p.parent_id == null && p.merged_into == null && !/^C\d+$/.test(p.code) && !hist?.some(e => e.type === 'split')) { setKin([]); return }
    backend.lineage(p).then(ps => { setKin(ps); onLineage(ps) }).catch(() => setKin([]))
  }, [p.id, p.parent_id, p.merged_into, hist])
  const isMixed = p.kind === 'mixed'
  const loadEditable = !!loadInfo && ['planning', 'loading'].includes(loadInfo.load.status)
  // on a load that hasn't left (planned, or already on the truck): everything you can do in a freezer
  const live = p.status === 'in_freezer' || p.status === 'unslotted' || (p.status === 'in_transit' && loadEditable)
  const inFreezer = p.status === 'in_freezer'
  const onTruck = p.status === 'in_transit' && loadEditable
  const container = p.container_id ? ix.pallet.get(p.container_id) : undefined
  const parent = kin.find(k => k.id === p.parent_id)
  const children = kin.filter(k => k.parent_id === p.id)
  const into = kin.find(k => k.id === p.merged_into)
  const sources = kin.filter(k => k.merged_into === p.id)
  const item = p.item_id != null ? ix.sku.get(p.item_id) : undefined
  const lot = p.lot_id != null ? ix.lot.get(p.lot_id) : undefined
  const g = gradeOf(ix, p)
  const strainDefault = ix.strainGrade.get((p.strain ?? '').toLowerCase().trim()) ?? 'SHO'
  const [showSku, setShowSku] = useState(false)
  const link = (k: Pallet) => <a key={k.id} onClick={() => onPick(k.id)}>{k.code}</a>
  const join = (ks: Pallet[]) => ks.map((k, i) => <span key={k.id}>{i > 0 && ', '}{link(k)}</span>)
  const statusText: Record<string, string> = { merged: 'Merged (closed out)', shipped: 'Delivered (left inventory)', depleted: isMixed ? 'Broken apart' : 'Depleted', archived: 'Not in a freezer (old record)', in_transit: where(p) }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-h">
          <div>
            <h2>{p.code}</h2>
            <div>{isMixed ? `Mixed pallet · ${contents.length} package${contents.length === 1 ? '' : 's'}` : p.strain ? <StrainLink name={p.strain} /> : p.label ?? 'No strain'}{!isMixed && p.product && p.product !== 'fresh_frozen' && <span className="pill prod">{PRODUCT_LABEL[p.product]}</span>}</div>
          </div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {p.needs_review && <div className="warnbox">{p.needs_review}</div>}
        {p.tag_pending && live && <div className="warnbox">METRC tag pending. <a onClick={() => onForm('tag')}>Enter tag</a></div>}
        {p.pushed === false && live && <div className="warnbox">Not pushed to METRC yet. It can be moved, but it can't be sold, loaded, split or merged until it's pushed in the Harvest log.</div>}
        {p.span_to_slot != null && ix.slot.get(p.span_to_slot) && <div className="infobox">Takes the spots through {ix.slot.get(p.span_to_slot)!.code.slice(2)}. Drag its ⇕ handle back onto its own spot to take one spot again.</div>}
        {container && <div className="infobox">On mixed pallet {link(container)}. It moves with {container.code}.</div>}
        {held && <div className="infobox held">Held for <a onClick={onHeld}>{held}</a></div>}
        {inRun && <div className="infobox held">In processing run {inRun}. It stays put until the run is finished. It can still be moved to another spot.</div>}
        {loadInfo && (
          <div className="infobox load" style={{ ['--sc' as string]: stopColor(loadInfo.stop.seq) }}>
            {loadInfo.item.loaded ? 'On the truck: ' : 'Planned on '}<a onClick={() => onOpenLoad(loadInfo.load.id)}>{loadInfo.load.code}</a>
            {' '}· stop {loadInfo.stop.seq} {customerName(loadInfo.stop.customer_id)} · position {loadInfo.item.position}
            {loadEditable && !loadInfo.item.loaded && <div className="row" style={{ marginTop: 6 }}><button className="primary small" disabled={busy} onClick={onPulled}>Pulled onto truck</button></div>}
          </div>
        )}
        <dl>
          <dt>Location</dt><dd>{live && (p.slot_id != null || container) ? <a onClick={onGo}>{container ? whereIs(ix, container.slot_id) : whereIs(ix, p.slot_id)}</a> : live ? where(p) : statusText[p.status] ?? p.status}</dd>
          {(p.boxes || p.partial) ? <><dt>Boxes</dt><dd>{p.boxes ?? ''}{p.partial ? <span className="muted"> · last pallet (partial)</span> : null}</dd></> : null}
          <dt>Weight</dt><dd>{lbs(weightOf(ix, p)) || 'unknown'}{!isMixed && p.og_weight && p.og_weight !== p.current_weight ? <span className="muted"> (started at {lbs(p.og_weight)})</span> : null}</dd>
          {!isMixed && <>
            <dt>METRC tag</dt><dd className="mono">{p.package_tag ?? (p.tag_pending ? 'pending' : 'none')}</dd>
            <dt>Harvested</dt><dd>{p.harvest_date ?? ''}</dd>
            <dt>Zone</dt><dd>{p.zone ?? ''}</dd>
            <dt>Grown at</dt><dd>{originAdmin && onOrigin
              ? <Select className="inline" value={p.origin_site ?? ''} onChange={e => e.target.value && onOrigin(e.target.value)}>
                  {!p.origin_site && <option value="">unknown</option>}{['OHR', 'GVR', 'GVR+OHR'].map(s => <option key={s} value={s}>{s === 'GVR+OHR' ? 'Both farms' : s}</option>)}</Select>
              : p.origin_site === 'GVR+OHR' ? 'Both farms (GVR and OHR)' : p.origin_site ?? 'unknown'}</dd>
            <dt>Item</dt><dd>{item
              ? <><a onClick={() => setShowSku(v => !v)}>{FINISH_LABEL[item.finish] ?? item.finish} · {item.crop_year} · {item.site}</a>
                  {item.metrc_status === 'to_create' && <span className="pill warn">not in METRC yet</span>}
                  {showSku && <div className="muted small"><div className="mono">{item.sku}</div><div>{item.metrc_name}</div></div>}</>
              : <span className="muted">none (needs strain, farm and year)</span>}</dd>
            <dt>Harvest lot</dt><dd>{lot ? <><span className="mono">{lot.code}</span>{lot.metrc_name && lot.metrc_name !== lot.code && <div className="muted small">METRC: {lot.metrc_name}</div>}</> : <span className="muted">none</span>}</dd>
            <TestRows sb={backend.client()} palletId={p.id} flash={flash} />
            <dt>Grade</dt><dd>
              <span className={`pill grade ${g.grade.toLowerCase()}`}>{g.grade}</span>
              <span className="muted"> {g.from === 'pallet' ? 'set on this pallet' : g.from === 'lot' ? `whole lot${lot?.grade_reason ? ` (${lot.grade_reason})` : ''}` : 'strain default'}</span>
              {canGrade && <div className="row gradeset">
                {lot && onLotGrade && <label>Lot <Select className="inline" disabled={busy} value={lot.grade ?? ''} onChange={e => onLotGrade(lot, (e.target.value || null) as Grade | null)}>
                  <option value="">Strain default ({strainDefault})</option><option value="SHO">SHO</option><option value="BHO">BHO</option></Select></label>}
                {onPalletGrade && <label>This pallet <Select className="inline" disabled={busy} value={p.grade ?? ''} onChange={e => onPalletGrade((e.target.value || null) as Grade | null)}>
                  <option value="">{lot ? 'Same as lot' : 'Strain default'}</option><option value="SHO">SHO</option><option value="BHO">BHO</option></Select></label>}
              </div>}</dd>
          </>}
          {isMixed && contents.length > 0 && <><dt>Grown at</dt><dd>{[...new Set(contents.map(c => c.origin_site ?? '?'))].sort().join(', ')}</dd></>}
          {parent && <><dt>Split from</dt><dd>{link(parent)}</dd></>}
          {children.length > 0 && <><dt>Split off</dt><dd>{join(children)}</dd></>}
          {sources.length > 0 && <><dt>Made from</dt><dd>{join(sources)}</dd></>}
          {into && <><dt>Merged into</dt><dd>{link(into)}</dd></>}
          {p.notes && <><dt>Notes</dt><dd>{p.notes}</dd></>}
        </dl>
        {isMixed && (
          <div className="contents">
            {contents.length === 0 && <div className="muted">Nothing on this pallet.</div>}
            {contents.map(c => (
              <button key={c.id} className="content" onClick={() => onPick(c.id)}>
                <b>{c.code}</b><span><StrainLink name={c.strain} /></span><span>{lbs(c.current_weight)}</span>
                <span className="mono">{c.package_tag ?? (c.tag_pending ? 'tag pending' : 'no tag')}</span>
              </button>
            ))}
          </div>
        )}
        {others.length > 0 && <div className="muted">Stacked with {join(others)}</div>}

        {live && isMixed && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onMove}>{onTruck ? 'Back to a freezer' : 'Move'}</button>
            <button className="ghost big" disabled={busy || (!!loadInfo && !loadEditable)} onClick={() => onForm('addmixed')}>Pull packages</button>
            <button className="ghost big" disabled={busy || (!!loadInfo && !loadEditable)} onClick={onBreak}>Break apart</button>
          </div>
          <div className="row">
            {inFreezer && !loadInfo && <button className="ghost small" disabled={busy} onClick={onPutOnLoad}>Put on a load</button>}
            {contents.length === 0 && (!loadInfo || loadEditable) && <button className="ghost small danger" disabled={busy} onClick={onRemove}>Remove</button>}
          </div>
        </>)}
        {live && container && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onTakeOff}>Take off {container.code}</button>
          </div>
          <div className="row">
            <button className="ghost small" disabled={busy} onClick={() => onForm('weight')}>Adjust weight</button>
            <button className="ghost small" disabled={busy} onClick={() => onForm('tag')}>{p.package_tag ? 'Edit tag' : 'Enter tag'}</button>
          </div>
        </>)}
        {live && !isMixed && !container && (<>
          <div className="row actions">
            <button className="primary big" disabled={busy} onClick={onMove}>{onTruck ? 'Back to a freezer' : 'Move'}</button>
            <button className="ghost big" disabled={busy || !p.current_weight} onClick={() => onForm('split')}>Split</button>
            <button className="ghost big" disabled={busy || !p.strain} onClick={() => onForm('merge')}>Merge</button>
          </div>
          <div className="row">
            <button className="ghost small" disabled={busy || (!!loadInfo && !loadEditable)} onClick={() => onForm('addto')}>Pull for mixed pallet</button>
            {inFreezer && !loadInfo && <button className="ghost small" disabled={busy} onClick={onPutOnLoad}>Put on a load</button>}
            <button className="ghost small" disabled={busy} onClick={() => onForm('weight')}>Adjust weight</button>
            <button className="ghost small" disabled={busy} onClick={() => onForm('tag')}>{p.package_tag ? 'Edit tag' : 'Enter tag'}</button>
            {p.needs_review && <button className="ghost small" disabled={busy} onClick={onClear}>Clear flag</button>}
            <button className="ghost small" disabled={busy} onClick={() => setFlagWhy(p.needs_review ?? '')}>{p.needs_review ? 'Change flag' : 'Flag for review'}</button>
            {(!loadInfo || loadEditable) && <button className="ghost small danger" disabled={busy} onClick={onRemove}>Remove</button>}
          </div>
          {flagWhy != null && <div className="flagform">
            <label><span>Why does {p.code} need review?</span>
              <input autoFocus value={flagWhy} placeholder="e.g. Not on the reefer sheet, can't find it" onChange={e => setFlagWhy(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && flagWhy.trim()) { onFlag(flagWhy.trim()); setFlagWhy(null) } if (e.key === 'Escape') setFlagWhy(null) }} /></label>
            <div className="row"><button className="ghost small" onClick={() => setFlagWhy(null)}>Cancel</button>
              <button className="primary small" disabled={busy || !flagWhy.trim()} onClick={() => { onFlag(flagWhy.trim()); setFlagWhy(null) }}>Flag it</button></div>
          </div>}
        </>)}
        {onArchived && <div className="row actions"><button className="primary big" onClick={onArchived}>Bring back or delete…</button></div>}
        <h3>History</h3>
        {!hist && <p className="muted">Loading…</p>}
        {hist?.length === 0 && <p className="muted">No history.</p>}
        <div className="timeline">
          {hist?.map(e => (
            <div key={e.id} className={`hist t-${e.type}`}>
              <div>{describe(ix, e, new Map([[p.id, p.code]]))}</div>
              <div className="muted">{when(e.at)} · {who(e.user_email)}{e.note && <> · "{e.note}"</>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Freezer map: pallets moved between OHR and GVR. Make a real transfer (a load and its METRC manifest) or just a to-do. */
function CrossSiteDialog({ cs, vehicles, drivers, code, busy, onClose, onNo, onYes }: {
  cs: { cross: { id: number; from: string; to: string }[] }; vehicles: { id: number; name: string }[]; drivers: string[]; code: (id: number) => string; busy: boolean
  onClose: () => void; onNo: () => void; onYes: (vehicle: number, driver: string) => void
}) {
  const [yes, setYes] = useState(false)
  const [vehicle, setVehicle] = useState<number | null>(vehicles[0]?.id ?? null)
  const [driver, setDriver] = useState('')
  const routes = [...new Set(cs.cross.map(c => `${c.from} to ${c.to}`))].join(', ')
  return <div className="scrim" onClick={onClose}>
    <div className="sheet form" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2>Moving between farms</h2><button className="ghost" onClick={onClose}>✕</button></div>
      <p>{cs.cross.map(c => code(c.id)).join(', ')} {cs.cross.length === 1 ? 'goes' : 'go'} {routes}. That's a transfer between licenses: METRC needs a manifest.</p>
      {!yes ? <>
        <p className="muted">Make the transfer manifest now? The app puts {cs.cross.length === 1 ? 'it' : 'them'} on a transfer load and makes the METRC manifest. They show in transit until the load is delivered there.</p>
        <div className="row end wrap">
          <button className="ghost" disabled={busy} onClick={onNo}>No, just move {cs.cross.length === 1 ? 'it' : 'them'} (to-do)</button>
          <button className="primary" disabled={busy} onClick={() => setYes(true)}>Yes, make the manifest</button>
        </div>
      </> : <>
        <div className="field"><label>Truck</label>
          <Select value={vehicle ?? ''} onChange={e => setVehicle(Number(e.target.value))}>{vehicles.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></div>
        <div className="field"><label>Driver</label>
          <input list="xs-drivers" value={driver} onChange={e => setDriver(e.target.value)} placeholder="Pick or type a name" />
          <datalist id="xs-drivers">{drivers.map(d => <option key={d} value={d} />)}</datalist></div>
        <p className="muted small">Other moves in this batch are saved as usual.</p>
        <div className="row end"><button className="ghost" onClick={() => setYes(false)}>Back</button>
          <button className="primary" disabled={busy || vehicle == null || !driver.trim()} onClick={() => onYes(vehicle!, driver.trim())}>Make the transfer</button></div>
      </>}
    </div>
  </div>
}
