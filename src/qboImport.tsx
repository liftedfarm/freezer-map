// Admin / Sales settings > Customers > Import from QuickBooks.
// Takes the customer list exported from QuickBooks Online (CSV or Excel: the Customers page export, or the
// Customer Contact List report) and matches each QuickBooks customer to an app customer.
//  * Matched: QuickBooks wins for billing info (email, phone, contact, billing and ship-to address, company name).
//    Blank cells never clear anything. The QuickBooks name is saved as "QuickBooks name" so invoices match it exactly.
//  * Not in the app: listed unticked. Pick "Add as new customer" or match it to an app customer by hand.
import { useMemo, useState } from 'react'
import { readSheet } from 'read-excel-file/browser'
import type { Backend } from './api'
import type { Customer } from './types'

// ---------- reading the file ----------

const cellText = (v: unknown) => (v == null ? '' : String(v)).replace(/ /g, ' ').trim()
/** a heading as a plain key: "Billing Address*" > "billing address" */
export const headKey = (h: string) => cellText(h).toLowerCase().replace(/[*:#]/g, '').replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ').trim()

const H = {
  name: ['customer full name', 'customer', 'display name', 'customer display name', 'display name as', 'customer name', 'name'],
  company: ['company name', 'company'],
  email: ['email', 'e mail', 'email address', 'primary email', 'main email'],
  phone: ['phone', 'phone numbers', 'phone number', 'main phone', 'primary phone', 'work phone', 'business phone'],
  mobile: ['mobile', 'mobile phone', 'mobile number', 'cell'],
  contact: ['full name', 'contact', 'contact name', 'primary contact'],
  first: ['first name', 'given name'],
  last: ['last name', 'family name'],
  bill: ['billing address', 'bill to', 'bill address', 'bill to address'],
  billStreet: ['billing street', 'billing address line 1', 'billing address 1', 'bill street', 'billing street address', 'street address', 'street', 'address', 'address line 1'],
  billStreet2: ['billing address line 2', 'billing address 2', 'billing street 2', 'street address 2', 'address line 2'],
  billCity: ['billing city', 'bill city', 'city'],
  billState: ['billing state', 'bill state', 'billing state province', 'state', 'province', 'state province'],
  billZip: ['billing zip', 'billing zip code', 'billing postal code', 'bill zip', 'zip', 'zip code', 'postal code'],
  billCountry: ['billing country', 'bill country', 'country'],
  ship: ['shipping address', 'ship to', 'ship to address', 'ship address'],
  shipStreet: ['shipping street', 'shipping address line 1', 'shipping address 1', 'ship street', 'shipping street address'],
  shipStreet2: ['shipping address line 2', 'shipping address 2', 'shipping street 2'],
  shipCity: ['shipping city', 'ship city'],
  shipState: ['shipping state', 'ship state', 'shipping state province'],
  shipZip: ['shipping zip', 'shipping zip code', 'shipping postal code', 'ship zip'],
  shipCountry: ['shipping country', 'ship country'],
  terms: ['terms', 'payment terms'],
  status: ['status', 'active'],
} as const
type HKey = keyof typeof H

/** the header row (first 15 rows; QuickBooks reports put a title above it) and where each column is */
export function findColumns(grid: string[][]): { row: number; at: Partial<Record<HKey, number>> } | null {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const heads = grid[r].map(headKey)
    const at: Partial<Record<HKey, number>> = {}
    for (const k of Object.keys(H) as HKey[]) {
      // the first synonym that matches wins ("customer full name" over "name")
      for (const syn of H[k]) { const i = heads.indexOf(syn); if (i >= 0 && !Object.values(at).includes(i)) { at[k] = i; break } }
    }
    if (at.name != null && Object.keys(at).length >= 2) return { row: r, at }
  }
  return null
}

const US = /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i
function joinAddr(street: string, street2: string, city: string, state: string, zip: string, country: string) {
  const l3 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [street, street2, l3, country && !US.test(country) ? country : ''].filter(Boolean).join('\n')
}
/** a one-cell address from a QuickBooks report: tidy the spacing, keep the lines */
const tidyAddr = (s: string) => s.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
/** "Phone: (831) 555-1212 Mobile: (831) 555-3434" > the first number */
function firstPhone(s: string) {
  const m = s.match(/(?:phone|main|work|mobile|cell)?\s*:?\s*([+()\d][\d\s().+-]{6,}\d(?:\s*(?:x|ext\.?)\s*\d+)?)/i)
  return (m ? m[1] : s).replace(/\s+/g, ' ').trim()
}

export interface QboRow {
  line: number
  qbo_name: string
  company?: string
  email?: string
  phone?: string
  contact?: string
  billing_address?: string
  ship_to_address?: string
  terms?: string
  inactive?: boolean
}

/** one QuickBooks customer per row; report footers and totals are skipped */
export function readQbo(grid: string[][]): { rows: QboRow[]; found: string[]; error?: string } {
  const cols = findColumns(grid)
  if (!cols) return { rows: [], found: [], error: 'Couldn\'t find the QuickBooks customer columns. Export the customer list from QuickBooks (Customers > Export, or the Customer Contact List report) and pick that file.' }
  const { row, at } = cols
  const rows: QboRow[] = []
  const seen = new Set<string>()
  for (let r = row + 1; r < grid.length; r++) {
    const g = (k: HKey) => at[k] != null ? cellText(grid[r][at[k]!]) : ''
    const name = g('name')
    if (!name || /^(total|grand total)\b/i.test(name)) continue
    const filled = grid[r].filter(c => cellText(c)).length
    if (filled <= 1 && /\d{4}|gmt|am|pm/i.test(name) && name.split(' ').length > 3) continue   // "Tuesday, October 28, 2026 09:12 PM GMT-07:00"
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const q: QboRow = { line: r + 1, qbo_name: name }
    const company = g('company'); if (company) q.company = company
    const email = g('email'); if (email) q.email = email.replace(/\s*[,;]\s*/g, ', ')
    const phone = g('phone') || g('mobile'); if (phone) q.phone = firstPhone(phone)
    const contact = g('contact') || [g('first'), g('last')].filter(Boolean).join(' '); if (contact && contact !== name) q.contact = contact
    const bill = g('bill') ? tidyAddr(g('bill')) : joinAddr(g('billStreet'), g('billStreet2'), g('billCity'), g('billState'), g('billZip'), g('billCountry'))
    if (bill) q.billing_address = bill
    const ship = g('ship') ? tidyAddr(g('ship')) : joinAddr(g('shipStreet'), g('shipStreet2'), g('shipCity'), g('shipState'), g('shipZip'), g('shipCountry'))
    if (ship) q.ship_to_address = ship
    const terms = g('terms'); if (terms) q.terms = terms
    const st = g('status'); if (st && /^(inactive|no|false|0)$/i.test(st)) q.inactive = true
    rows.push(q)
  }
  const label: Partial<Record<HKey, string>> = { name: 'Customer', company: 'Company', email: 'Email', phone: 'Phone', mobile: 'Mobile', contact: 'Contact',
    bill: 'Billing address', billStreet: 'Billing address', ship: 'Shipping address', shipStreet: 'Shipping address', terms: 'Terms' }
  const found = [...new Set((Object.keys(at) as HKey[]).map(k => label[k]).filter(Boolean) as string[])]
  return { rows, found }
}

// ---------- matching ----------

/** "Pardis Works, Inc." and "PARDIS WORKS INC" are the same customer */
export const normName = (s: string | null | undefined) => (s ?? '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(inc|incorporated|llc|l l c|corp|corporation|co|company|ltd|limited|lp|llp|pc|dba)\b/g, ' ')
  .replace(/\s+/g, ' ').trim()

export function matchCustomer(q: QboRow, custs: Customer[]): Customer | null {
  const exact = (c: Customer) => [c.qbo_name, c.legal_name, c.name].some(x => x && x.trim().toLowerCase() === q.qbo_name.toLowerCase())
  const hit = custs.find(c => c.qbo_name && c.qbo_name.trim().toLowerCase() === q.qbo_name.toLowerCase()) ?? custs.find(exact)
  if (hit) return hit
  const keys = [q.qbo_name, q.company].map(normName).filter(Boolean)
  const close = custs.filter(c => [c.qbo_name, c.legal_name, c.name, c.ship_to_name].some(x => x && keys.includes(normName(x))))
  return close.length === 1 ? close[0] : null
}

/** the app fields QuickBooks fills in for one customer */
export function fieldsFrom(q: QboRow, terms?: { code: string; label: string }[]): Partial<Customer> {
  const f: Partial<Customer> = { qbo_name: q.qbo_name }
  if (q.company) f.legal_name = q.company
  if (q.email) f.billing_email = q.email
  if (q.phone) f.billing_phone = q.phone
  if (q.contact) f.billing_contact = q.contact
  if (q.billing_address) f.billing_address = q.billing_address
  if (q.ship_to_address) f.ship_to_address = q.ship_to_address
  if (q.terms && terms) {
    const t = terms.find(x => x.label.toLowerCase() === q.terms!.toLowerCase() || x.code.toLowerCase() === q.terms!.toLowerCase())
    if (t) f.payment_terms = t.code
  }
  return f
}

export const FIELD_LABEL: Record<string, string> = {
  qbo_name: 'QuickBooks name', legal_name: 'Legal name', billing_email: 'Billing email', billing_phone: 'Billing phone',
  billing_contact: 'Billing contact', billing_address: 'Billing address', ship_to_address: 'Ship-to address', payment_terms: 'Payment terms',
}
const same = (a: unknown, b: unknown) => cellText(a).replace(/\s+/g, ' ').toLowerCase() === cellText(b).replace(/\s+/g, ' ').toLowerCase()
/** what would change on an app customer (QuickBooks wins; blanks in the file change nothing) */
export function changesFor(c: Customer, f: Partial<Customer>): Partial<Customer> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f)) if (v != null && v !== '' && !same((c as unknown as Record<string, unknown>)[k], v)) out[k] = v
  return out as Partial<Customer>
}

// ---------- the screen ----------

type Choice = 'skip' | 'new' | `id:${number}`

export function QboCustomerImport({ backend, customers, terms, flash, onDone, onClose }: {
  backend: Backend; customers: Customer[]; terms: { code: string; label: string }[]
  flash: (t: string, bad?: boolean) => void; onDone: () => void; onClose: () => void
}) {
  const [file, setFile] = useState<{ name: string; rows: QboRow[]; found: string[] } | null>(null)
  const [choice, setChoice] = useState<Record<number, Choice>>({})
  const [withTerms, setWithTerms] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<number | null>(null)

  async function pick(f: File) {
    try {
      const grid = /\.csv$/i.test(f.name)
        ? (await import('./settings')).parseCsv((await f.text()).replace(/^﻿/, ''))
        : (await readSheet(f)).map(r => r.map(c => c instanceof Date ? c.toISOString().slice(0, 10) : cellText(c)))
      const res = readQbo(grid)
      if (res.error) { flash(res.error, true); return }
      if (!res.rows.length) { flash(`No customers in ${f.name}`, true); return }
      setFile({ name: f.name, rows: res.rows, found: res.found }); setChoice({})
    } catch (e) { flash(`Couldn't read ${f.name}: ${(e as Error).message}`, true) }
  }

  const ext = useMemo(() => customers.filter(c => c.kind !== 'internal'), [customers])
  const plan = useMemo(() => {
    if (!file) return null
    const auto = new Map<number, Customer | null>(file.rows.map(q => [q.line, matchCustomer(q, ext)]))
    // a customer two QuickBooks rows both match: neither is automatic
    const count = new Map<number, number>()
    for (const c of auto.values()) if (c) count.set(c.id, (count.get(c.id) ?? 0) + 1)
    return file.rows.map(q => {
      const a = auto.get(q.line)
      const ch: Choice = choice[q.line] ?? (a && count.get(a.id) === 1 ? `id:${a.id}` : 'skip')
      const target = ch.startsWith('id:') ? ext.find(c => c.id === Number(ch.slice(3))) ?? null : null
      const f = fieldsFrom(q, withTerms ? terms : undefined)
      const changes = target ? changesFor(target, f) : null
      return { q, ch, auto: !!(a && count.get(a.id) === 1 && !choice[q.line]), target, f, changes }
    })
  }, [file, choice, ext, withTerms, terms])

  const matched = plan?.filter(p => p.target) ?? []
  const updates = matched.filter(p => p.changes && Object.keys(p.changes).length)
  const adds = plan?.filter(p => p.ch === 'new') ?? []
  const notIn = plan?.filter(p => !p.auto) ?? []   // stays listed after a hand match, so the pick can be changed
  const usedIds = new Set(matched.map(p => p.target!.id))
  const unmatchedApp = ext.filter(c => c.active && !usedIds.has(c.id))

  async function apply() {
    if (!plan) return
    setBusy(true)
    let done = 0
    try {
      for (const p of updates) { await backend.saveRow('customers', { id: p.target!.id, ...p.changes } as Partial<Customer>); done++ }
      for (const p of adds) {
        await backend.saveRow('customers', { name: p.q.qbo_name, kind: 'external', active: true, ...p.f } as Partial<Customer>); done++
      }
      flash(`QuickBooks import: ${updates.length} updated, ${adds.length} added`)
      onDone(); onClose()
    } catch (e) { flash(`Stopped after ${done}: ${(e as Error).message}`, true); onDone() }
    finally { setBusy(false) }
  }

  const show = (v: unknown) => cellText(v).replace(/\n/g, ' · ') || '(blank)'
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form wide qboimp" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Import customers from QuickBooks</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {!file && <>
          <p>In QuickBooks Online: <b>Sales &gt; Customers</b>, then the export button above the list (Export to Excel). The <b>Customer Contact List</b> report exported to Excel or CSV works too.</p>
          <p className="muted">Each QuickBooks customer is matched to an app customer by name. QuickBooks wins for billing info (email, phone, contact, billing and ship-to address, company name); blank cells don't clear anything. You see every change before anything is saved.</p>
          <label className="primary filebtn">Pick the QuickBooks file
            <input type="file" accept=".csv,.xlsx,.xls,.xlsm" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(f) }} />
          </label>
        </>}
        {file && plan && <>
          <p className="muted">{file.name} · {file.rows.length} QuickBooks customers · columns found: {file.found.join(', ')}</p>
          <div className="row chips">
            <span className="chip upd">{updates.length} to update</span>
            <span className="chip">{matched.length - updates.length} already match</span>
            <span className="chip new">{adds.length} to add</span>
            <span className="chip">{notIn.filter(p => p.ch === 'skip').length} not in the app (skipped)</span>
          </div>
          {plan.some(p => p.q.terms) && <label className="check small-check"><input type="checkbox" checked={withTerms} onChange={e => setWithTerms(e.target.checked)} /> Also update payment terms from QuickBooks (only terms with the same name as ours)</label>}

          {updates.length > 0 && <><h3>Updates</h3>
            <div className="picklist preview">
              {updates.map(p => (
                <div key={p.q.line} className="prev s-update qbrow" onClick={() => setOpen(open === p.q.line ? null : p.q.line)}>
                  <span className="muted">row {p.q.line}</span>
                  <span><b>{p.target!.name}</b>{p.q.qbo_name !== p.target!.name && <span className="muted"> · QuickBooks: {p.q.qbo_name}</span>}{!p.auto && <span className="muted"> · matched by hand</span>}</span>
                  <span>{Object.keys(p.changes!).map(k => FIELD_LABEL[k] ?? k).join(', ')}</span>
                  {open === p.q.line && <div className="qbdiff">{Object.entries(p.changes!).map(([k, v]) => (
                    <div key={k}><b>{FIELD_LABEL[k] ?? k}</b>: <span className="muted">{show((p.target as unknown as Record<string, unknown>)[k])}</span> → {show(v)}</div>))}</div>}
                </div>
              ))}
            </div>
            <p className="muted small">Tap a row to see old → new.</p></>}

          {notIn.length > 0 && <><h3>In QuickBooks, not matched in the app</h3>
            <p className="muted small">Skipped unless you pick one. Match it to an app customer if it's the same business under another name.</p>
            <div className="picklist preview">
              {notIn.map(p => (
                <div key={p.q.line} className={`prev qbrow ${p.ch === 'new' ? 's-new' : ''}`}>
                  <span className="muted">row {p.q.line}</span>
                  <span><b>{p.q.qbo_name}</b>{p.q.inactive && <span className="muted"> · inactive in QuickBooks</span>}<span className="muted">{[p.q.email, p.q.phone].filter(Boolean).length ? ' · ' + [p.q.email, p.q.phone].filter(Boolean).join(' · ') : ''}</span></span>
                  <select value={p.ch} onChange={e => setChoice(c => ({ ...c, [p.q.line]: e.target.value as Choice }))}>
                    <option value="skip">Don't import</option>
                    <option value="new">Add as new customer</option>
                    <optgroup label="Same as app customer…">
                      {[...(p.target ? [p.target] : []), ...unmatchedApp].map(c => <option key={c.id} value={`id:${c.id}`}>{c.name}</option>)}
                    </optgroup>
                  </select>
                </div>
              ))}
            </div></>}

          {unmatchedApp.length > 0 && <p className="muted small">App customers with no QuickBooks match: {unmatchedApp.map(c => c.name).join(', ')}. They're left as they are.</p>}
          <div className="row end">
            <button className="ghost" onClick={() => setFile(null)}>Pick another file</button>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || updates.length + adds.length === 0} onClick={apply}>{busy ? 'Importing…' : `Import ${updates.length + adds.length}`}</button>
          </div>
        </>}
      </div>
    </div>
  )
}
