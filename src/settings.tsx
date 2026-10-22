import { useEffect, useMemo, useState } from 'react'
import { readSheet } from 'read-excel-file/browser'
import type { Backend } from './api'
import { UsersTab } from './users'
import { canSales } from './types'
import type { Customer, CustomerTerms, ListName, Me, ListRow, ReserveYears, Settings, Strain, Vehicle } from './types'

// ---------- column definitions per list ----------

type Kind = 'text' | 'int' | 'num' | 'bool' | 'kind' | 'aliases' | 'color' | 'active'
interface Col { key: string; label: string; kind: Kind; synonyms: string[]; hint?: string }

const COLS: Record<ListName, Col[]> = {
  vehicles: [
    { key: 'name', label: 'Name', kind: 'text', synonyms: ['name', 'vehicle', 'vehicle name', 'truck'] },
    { key: 'plate', label: 'Plate', kind: 'text', synonyms: ['plate', 'license plate', 'plate #', 'plate number', 'tag'] },
    { key: 'kind', label: 'Type', kind: 'text', synonyms: ['type', 'kind', 'vehicle type'], hint: 'Freezer truck, trailer…' },
    { key: 'spaces', label: 'Pallet spaces', kind: 'int', synonyms: ['spaces', 'pallet spaces', 'pallets', 'capacity'] },
    { key: 'across', label: 'Pallets across', kind: 'int', synonyms: ['across', 'pallets across', 'width'], hint: 'usually 2' },
    { key: 'owner', label: 'Owner / carrier', kind: 'text', synonyms: ['owner', 'carrier', 'company'], hint: 'Lifted, or the carrier name' },
    { key: 'notes', label: 'Notes', kind: 'text', synonyms: ['notes', 'note', 'comments'] },
    { key: 'active', label: 'Active', kind: 'active', synonyms: ['active', 'status'] },
  ],
  customers: [
    { key: 'name', label: 'Name', kind: 'text', synonyms: ['name', 'customer', 'customer name', 'company', 'business name'] },
    { key: 'kind', label: 'Internal or external', kind: 'kind', synonyms: ['type', 'kind', 'internal', 'internal/external'] },
    { key: 'license', label: 'License #', kind: 'text', synonyms: ['license', 'license #', 'license number', 'licence', 'state license'] },
    { key: 'address', label: 'Address', kind: 'text', synonyms: ['address', 'location', 'ship to'] },
    { key: 'contact', label: 'Contact', kind: 'text', synonyms: ['contact', 'phone', 'email', 'contact info'] },
    { key: 'reserves_enabled', label: 'Reserves', kind: 'bool', synonyms: ['reserves', 'reserves enabled', 'has reserves'], hint: 'off: portal ordering from the open menu only' },
    { key: 'price_per_lb', label: 'Price $/lb', kind: 'num', synonyms: ['price', 'price per lb', 'price/lb', '$/lb', 'contract price'], hint: 'fresh frozen, used on portal orders' },
    { key: 'contract_lbs', label: 'Contract lbs', kind: 'num', synonyms: ['contract lbs', 'contract', 'contracted lbs'] },
    { key: 'monthly_min_lbs', label: 'Monthly minimum lbs', kind: 'num', synonyms: ['monthly min', 'monthly minimum', 'min lbs'] },
    { key: 'deposit_usd', label: 'Deposit $', kind: 'num', synonyms: ['deposit', 'deposit $', 'deposit usd'] },
    { key: 'storage_fee', label: 'Storage fee', kind: 'num', synonyms: ['storage', 'storage fee'] },
    { key: 'notes', label: 'Notes', kind: 'text', synonyms: ['notes', 'note', 'comments'] },
    { key: 'active', label: 'Active', kind: 'active', synonyms: ['active', 'status'] },
  ],
  strains: [
    { key: 'name', label: 'Name', kind: 'text', synonyms: ['name', 'strain', 'strain name', 'cultivar'] },
    { key: 'aliases', label: 'Other names', kind: 'aliases', synonyms: ['aliases', 'alias', 'other names', 'also known as', 'aka'], hint: 'comma separated' },
    { key: 'show_on_menu', label: 'Show on menu', kind: 'bool', synonyms: ['show on menu', 'on menu', 'menu'], hint: 'off: customers can\'t order new lbs of it' },
    { key: 'color', label: 'Map color', kind: 'color', synonyms: ['color', 'colour', 'map color', 'hex'], hint: '#RRGGBB' },
    { key: 'notes', label: 'Notes', kind: 'text', synonyms: ['notes', 'note', 'comments', 'lineage'] },
    { key: 'active', label: 'Active', kind: 'active', synonyms: ['active', 'status'] },
  ],
}
const TITLES: Record<ListName, string> = { vehicles: 'Vehicles', customers: 'Customers', strains: 'Strains' }
const SINGULAR: Record<ListName, string> = { vehicles: 'vehicle', customers: 'customer', strains: 'strain' }
const LOCKED = new Set(['ohr', 'gvr'])

// ---------- value parsing ----------

const norm = (v: unknown) => (v == null ? '' : String(v)).trim()
function parseColor(v: string): string | null | undefined {
  if (!v) return undefined
  const m = v.replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null // invalid
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
  return '#' + h.toLowerCase()
}
function parseActive(v: string): boolean | undefined {
  if (!v) return undefined
  return !/^(no|n|false|0|retired|inactive)$/i.test(v)
}
function parseKind(v: string): 'internal' | 'external' | undefined {
  if (!v) return undefined
  return /^(internal|int|yes|y|true|1)$/i.test(v) ? 'internal' : 'external'
}
const parseAliases = (v: string) => v ? v.split(/[,;|]/).map(x => x.trim()).filter(Boolean) : []

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') q = false; else cell += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

// ---------- import plan ----------

interface PlanRow { line: number; name: string; status: 'new' | 'update' | 'same' | 'error'; msg?: string; changes?: string[]; row?: Partial<ListRow> }

function buildPlan(list: ListName, grid: string[][], existing: ListRow[]): { plan: PlanRow[]; found: string[]; error?: string } {
  const cols = COLS[list]
  // header = first row in the top 10 that has a recognisable name column
  let hi = -1, map: Record<string, number> = {}
  for (let r = 0; r < Math.min(grid.length, 10) && hi < 0; r++) {
    const heads = grid[r].map(h => norm(h).toLowerCase())
    const m: Record<string, number> = {}
    for (const c of cols) { const i = heads.findIndex(h => c.synonyms.includes(h)); if (i >= 0) m[c.key] = i }
    if (m.name != null) { hi = r; map = m }
  }
  if (hi < 0) return { plan: [], found: [], error: `Couldn't find a "${cols[0].label}" column in the first rows. Download the template to see the expected headings.` }
  const byName = new Map(existing.map(e => [e.name.toLowerCase(), e]))
  const seen = new Set<string>()
  const plan: PlanRow[] = []
  for (let r = hi + 1; r < grid.length; r++) {
    const get = (k: string) => map[k] != null ? norm(grid[r][map[k]]) : ''
    const name = get('name')
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) { plan.push({ line: r + 1, name, status: 'error', msg: 'Listed twice in the file' }); continue }
    seen.add(key)
    const ex = byName.get(key)
    const row: Record<string, unknown> = {}
    let bad = ''
    for (const c of cols) {
      if (c.key === 'name' || map[c.key] == null) continue
      const v = get(c.key)
      if (c.kind === 'text') { if (v) row[c.key] = v }
      else if (c.kind === 'bool') { const b = parseActive(v); if (b !== undefined) row[c.key] = b }
      else if (c.kind === 'num') { if (v) { const n = Number(v.replace(/[$,]/g, '')); if (isNaN(n) || n < 0) bad = `"${v}" isn't a number for ${c.label}`; else row[c.key] = n } }
      else if (c.kind === 'int') { if (v) { const n = parseInt(v, 10); if (!(n > 0)) bad = `"${v}" isn't a whole number for ${c.label}`; else row[c.key] = n } }
      else if (c.kind === 'active') { const a = parseActive(v); if (a !== undefined) row.active = a }
      else if (c.kind === 'kind') { const k = parseKind(v); if (k) row.kind = k }
      else if (c.kind === 'color') { const col = parseColor(v); if (col === null) bad = `"${v}" isn't a color like #A1B2C3`; else if (col) row.color = col }
      else if (c.kind === 'aliases') {
        const al = parseAliases(v)
        if (al.length) row.aliases = [...new Set([...((ex as Strain | undefined)?.aliases ?? []), ...al])]
      }
    }
    if (bad) { plan.push({ line: r + 1, name, status: 'error', msg: bad }); continue }
    if (list === 'customers' && ex && LOCKED.has(key) && ((row.kind && row.kind !== 'internal') || row.active === false)) {
      delete row.kind; delete row.active
    }
    if (!ex) { plan.push({ line: r + 1, name, status: 'new', row: { name, ...row } as Partial<ListRow> }); continue }
    const changes = Object.keys(row).filter(k => JSON.stringify((ex as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify(row[k]))
    if (!changes.length) plan.push({ line: r + 1, name: ex.name, status: 'same' })
    else plan.push({ line: r + 1, name: ex.name, status: 'update', changes, row: { id: ex.id, ...Object.fromEntries(changes.map(k => [k, row[k]])) } as Partial<ListRow> })
  }
  return { plan, found: cols.filter(c => map[c.key] != null).map(c => c.label) }
}

function downloadTemplate(list: ListName, rows: ListRow[]) {
  const cols = COLS[list]
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const cell = (r: ListRow, c: Col) => {
    const v = (r as unknown as Record<string, unknown>)[c.key]
    if (c.kind === 'active') return v === false ? 'No' : 'Yes'
    if (c.kind === 'aliases') return (v as string[] | undefined)?.join(', ') ?? ''
    return v == null ? '' : String(v)
  }
  const lines = [cols.map(c => c.label), ...rows.map(r => cols.map(c => cell(r, c)))].map(l => l.map(esc).join(','))
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = `${TITLES[list]} - Lifted Inventory.csv`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ---------- screen ----------

export function SettingsView({ backend, inventoryStrains, onChanged, flash, me }: {
  backend: Backend; inventoryStrains: Map<string, number>; me: Me
  onChanged: () => void; flash: (t: string, bad?: boolean) => void
}) {
  const [data, setData] = useState<Settings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<ListName>('vehicles')
  const [q, setQ] = useState('')
  const [showRetired, setShowRetired] = useState(false)
  const [edit, setEdit] = useState<Partial<ListRow> | null>(null)
  const [plan, setPlan] = useState<{ rows: PlanRow[]; found: string[]; file: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [usersTab, setUsersTab] = useState(false)
  const lists: ListName[] = canSales(me.role) ? ['vehicles', 'customers', 'strains'] : ['vehicles', 'strains']

  const load = () => backend.loadSettings().then(d => { setData(d); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])

  const rows = (data?.[tab] ?? []) as ListRow[]
  const shown = rows.filter(r => (showRetired || r.active) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())))

  // strains on pallets that the list doesn't know (by name or other name)
  const unknownStrains = useMemo(() => {
    if (!data) return []
    const known = new Set(data.strains.flatMap(s => [s.name, ...(s.aliases ?? [])]).map(x => x.toLowerCase()))
    return [...inventoryStrains.entries()].filter(([n]) => !known.has(n.toLowerCase())).map(([n]) => n)
  }, [data, inventoryStrains])

  async function save(row: Partial<ListRow>) {
    setBusy(true)
    try { await backend.saveRow(tab, row); await load(); onChanged(); setEdit(null); flash('Saved') }
    catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }
  async function addMissing() {
    setBusy(true)
    try { for (const n of unknownStrains) await backend.saveRow('strains', { name: n } as Partial<Strain>); await load(); onChanged(); flash(`${unknownStrains.length} strains added`) }
    catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
  }
  async function pickFile(f: File) {
    try {
      const grid = /\.csv$/i.test(f.name)
        ? parseCsv((await f.text()).replace(/^﻿/, ''))
        : (await readSheet(f)).map(r => r.map(c => c instanceof Date ? c.toISOString().slice(0, 10) : norm(c)))
      const res = buildPlan(tab, grid, rows)
      if (res.error) { flash(res.error, true); return }
      setPlan({ rows: res.plan, found: res.found, file: f.name })
    } catch (e) { flash(`Couldn't read ${f.name}: ${(e as Error).message}`, true) }
  }
  async function applyPlan() {
    if (!plan) return
    setBusy(true)
    let done = 0
    try {
      for (const r of plan.rows) if ((r.status === 'new' || r.status === 'update') && r.row) { await backend.saveRow(tab, r.row); done++ }
      await load(); onChanged(); setPlan(null); flash(`Imported ${done} ${TITLES[tab].toLowerCase()}`)
    } catch (e) { await load(); flash(`Stopped after ${done}: ${(e as Error).message}`, true) } finally { setBusy(false) }
  }

  if (err) return <div className="list"><h2>Settings</h2><div className="warnbox">Settings aren't set up in the database yet. Run the 003_settings.sql update in Supabase, then refresh. ({err})</div></div>
  if (!data) return <div className="muted">Loading settings…</div>

  return (
    <div className="list settings">
      <h2>Settings</h2>
      <div className="seg tabs">
        {lists.map(t => (
          <button key={t} className={t === tab && !usersTab ? 'on' : ''} onClick={() => { setTab(t); setQ(''); setUsersTab(false) }}>{TITLES[t]} <span className="muted">{(data[t] as ListRow[]).filter(r => r.active).length}</span></button>
        ))}
        {me.role === 'admin' && <button className={usersTab ? 'on' : ''} onClick={() => setUsersTab(true)}>Users</button>}
      </div>
      {usersTab ? <UsersTab backend={backend} me={me} customers={data.customers} flash={flash} /> : <>
      <div className="row toolbar">
        <input className="search" type="search" placeholder={`Search ${TITLES[tab].toLowerCase()}`} value={q} onChange={e => setQ(e.target.value)} />
        <button className="primary" onClick={() => setEdit(tab === 'customers' ? { kind: 'external', active: true } as Partial<Customer> : tab === 'strains' ? { aliases: [], active: true, show_on_menu: true } as Partial<Strain> : { active: true, spaces: 8, across: 2 } as Partial<Vehicle>)}>+ Add</button>
      </div>
      <div className="row toolbar">
        <label className="ghost small filebtn">Import spreadsheet
          <input type="file" accept=".xlsx,.xlsm,.csv" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickFile(f) }} />
        </label>
        <button className="ghost small" onClick={() => downloadTemplate(tab, rows)}>Download as spreadsheet</button>
        <label className="check small-check"><input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} /> Show retired</label>
      </div>
      <p className="muted">Import adds new {TITLES[tab].toLowerCase()} and updates existing ones by name. Blank cells don't overwrite anything. The download doubles as a template.</p>

      {tab === 'strains' && unknownStrains.length > 0 && (
        <div className="warnbox">{unknownStrains.length} strain{unknownStrains.length > 1 ? 's' : ''} on pallets {unknownStrains.length > 1 ? "aren't" : "isn't"} in the list: {unknownStrains.slice(0, 6).join(', ')}{unknownStrains.length > 6 ? '…' : ''}. <a onClick={addMissing}>Add {unknownStrains.length > 1 ? 'them' : 'it'}</a>, or add {unknownStrains.length > 1 ? 'them' : 'it'} as another name on an existing strain.</div>
      )}

      {shown.length === 0 && <p className="muted">Nothing here yet. Add one, or import a spreadsheet.</p>}
      {shown.map(r => (
        <button key={r.id} className={`li setrow ${r.active ? '' : 'retired'}`} onClick={() => setEdit(structuredClone(r))}>
          {tab === 'strains' && <span className="swatch" style={{ background: (r as Strain).color ?? 'transparent' }} />}
          <div className="grow">
            <div><b>{r.name}</b>{!r.active && <span className="muted"> · retired</span>}</div>
            <div className="muted">{summary(tab, r, inventoryStrains)}</div>
          </div>
        </button>
      ))}

      {edit && <EditForm list={tab} row={edit} busy={busy} onClose={() => setEdit(null)} onSave={save}
        extra={tab === 'customers' && edit.id != null && (edit as Customer).kind !== 'internal' && canSales(me.role) ? <TermsByYear backend={backend} c={edit as Customer} /> : null} />}
      {plan && <ImportPreview list={tab} plan={plan} busy={busy} onClose={() => setPlan(null)} onApply={applyPlan} />}
      </>}
    </div>
  )
}

function summary(list: ListName, r: ListRow, inv: Map<string, number>) {
  if (list === 'vehicles') { const v = r as Vehicle; return [v.spaces ? `${v.spaces} spaces (${v.across ?? 2} across)` : '', v.owner, v.kind, v.plate].filter(Boolean).join(' · ') }
  if (list === 'customers') { const c = r as Customer; return [c.kind === 'internal' ? 'Internal' : 'External', c.kind === 'external' ? (c.reserves_enabled ? 'Reserves on' : 'Menu only') : '', c.price_per_lb != null ? `$${Number(c.price_per_lb).toFixed(2)}/lb` : '', c.license, c.contact].filter(Boolean).join(' · ') }
  const s = r as Strain
  const n = [s.name, ...(s.aliases ?? [])].reduce((a, x) => a + (inv.get(x) ?? [...inv.entries()].find(([k]) => k.toLowerCase() === x.toLowerCase())?.[1] ?? 0), 0)
  return [s.show_on_menu === false ? 'Hidden from menu' : '', n ? `${n} pallet${n === 1 ? "" : "s"} in inventory` : 'none in inventory', s.aliases?.length ? `also: ${s.aliases.join(', ')}` : ''].filter(Boolean).join(' · ')
}

function EditForm({ list, row, busy, onClose, onSave, extra }: {
  list: ListName; row: Partial<ListRow>; busy: boolean; onClose: () => void; onSave: (r: Partial<ListRow>) => void; extra?: React.ReactNode
}) {
  const [r, setR] = useState<Record<string, unknown>>(row as Record<string, unknown>)
  const set = (k: string, v: unknown) => setR(x => ({ ...x, [k]: v }))
  const locked = list === 'customers' && row.id != null && LOCKED.has(String(row.name).toLowerCase())
  const [aliasText, setAliasText] = useState(((row as Strain).aliases ?? []).join(', '))
  const colorOk = !r.color || /^#[0-9a-f]{6}$/i.test(String(r.color))
  function submit() {
    const out: Record<string, unknown> = { ...r, name: String(r.name ?? '').trim() }
    for (const k of Object.keys(out)) if (typeof out[k] === 'string' && k !== 'name') out[k] = (out[k] as string).trim() || null
    if (list === 'strains') out.aliases = parseAliases(aliasText)
    onSave(out as Partial<ListRow>)
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{row.id ? `Edit ${SINGULAR[list]}` : `Add ${SINGULAR[list]}`}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {COLS[list].filter(c => c.kind !== 'active').map(c => (
          <div className="field" key={c.key}>
            <label>{c.label}{c.hint && <span className="muted"> ({c.hint})</span>}</label>
            {c.kind === 'kind' ? (
              <div className="choices">
                {(['external', 'internal'] as const).map(k => (
                  <button key={k} disabled={locked} className={r.kind === k ? 'on' : ''} onClick={() => set('kind', k)}>{k === 'internal' ? 'Internal (our site or lab)' : 'External customer'}</button>
                ))}
              </div>
            ) : c.kind === 'aliases' ? (
              <input value={aliasText} onChange={e => setAliasText(e.target.value)} placeholder="e.g. KLP, Key Lime" />
            ) : c.kind === 'color' ? (
              <div className="row">
                <input type="color" value={colorOk && r.color ? String(r.color) : '#cccccc'} onChange={e => set('color', e.target.value)} />
                <input style={{ flex: 1 }} value={String(r.color ?? '')} placeholder="Auto" onChange={e => set('color', e.target.value)} />
                {Boolean(r.color) && <button className="ghost small" onClick={() => set('color', null)}>Auto</button>}
              </div>
            ) : c.kind === 'bool' ? (
              <label className="check"><input type="checkbox" checked={Boolean(r[c.key] ?? c.key === 'show_on_menu')} onChange={e => set(c.key, e.target.checked)} /> On</label>
            ) : c.kind === 'num' ? (
              <input type="number" min="0" step="any" value={String(r[c.key] ?? '')} onChange={e => set(c.key, e.target.value === '' ? null : Number(e.target.value))} />
            ) : c.kind === 'int' ? (
              <input type="number" min="1" step="1" value={String(r[c.key] ?? '')} onChange={e => set(c.key, e.target.value === '' ? null : parseInt(e.target.value, 10))} />
            ) : (
              <input value={String(r[c.key] ?? '')} disabled={locked && c.key === 'name'} autoFocus={c.key === 'name'} onChange={e => set(c.key, e.target.value)} />
            )}
          </div>
        ))}
        {!colorOk && <div className="warn-t">Color must look like #A1B2C3</div>}
        {extra}
        {locked && <p className="muted">{String(row.name)} is a Lifted site. You can edit its details but not rename or retire it.</p>}
        <div className="row between">
          {row.id && !locked
            ? <button className="ghost" disabled={busy} onClick={() => onSave({ id: row.id, active: !r.active } as Partial<ListRow>)}>{r.active ? 'Retire' : 'Restore'}</button>
            : <span />}
          <div className="row">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !String(r.name ?? '').trim() || !colorOk} onClick={submit}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ImportPreview({ list, plan, busy, onClose, onApply }: {
  list: ListName; plan: { rows: PlanRow[]; found: string[]; file: string }; busy: boolean; onClose: () => void; onApply: () => void
}) {
  const count = (s: PlanRow['status']) => plan.rows.filter(r => r.status === s).length
  const n = count('new'), u = count('update')
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Import {TITLES[list].toLowerCase()}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <p className="muted">{plan.file} · columns found: {plan.found.join(', ')}</p>
        <div className="row chips">
          <span className="chip new">{n} new</span><span className="chip upd">{u} updates</span>
          <span className="chip">{count('same')} unchanged</span>{count('error') > 0 && <span className="chip err">{count('error')} skipped</span>}
        </div>
        <div className="picklist preview">
          {plan.rows.filter(r => r.status !== 'same').map(r => (
            <div key={r.line} className={`prev s-${r.status}`}>
              <span className="muted">row {r.line}</span><b>{r.name}</b>
              <span>{r.status === 'new' ? 'new' : r.status === 'update' ? `update ${r.changes?.join(', ')}` : r.msg}</span>
            </div>
          ))}
          {n + u + count('error') === 0 && <div className="muted" style={{ padding: 10 }}>Everything in the file already matches.</div>}
        </div>
        <div className="row end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || n + u === 0} onClick={onApply}>{busy ? 'Importing…' : `Import ${n + u}`}</button>
        </div>
      </div>
    </div>
  )
}

// contract terms by crop year: the terms above carry over until a later year gets its own
const TERM_KEYS: { k: keyof CustomerTerms; l: string }[] = [
  { k: 'price_per_lb', l: 'Price $/lb' }, { k: 'contract_lbs', l: 'Contract lbs' }, { k: 'monthly_min_lbs', l: 'Monthly min lbs' },
  { k: 'deposit_usd', l: 'Deposit $' }, { k: 'storage_fee', l: 'Storage fee' },
]
function TermsByYear({ backend, c }: { backend: Backend; c: Customer }) {
  const [rows, setRows] = useState<CustomerTerms[] | null>(null)
  const [ys, setYs] = useState<ReserveYears | null>(null)
  const [edit, setEdit] = useState<CustomerTerms | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const load = () => backend.listTerms().then(t => setRows(t.filter(x => x.customer_id === c.id))).catch(() => setRows([]))
  useEffect(() => { load(); backend.reserveYears().then(setYs).catch(() => {}) }, [c.id])
  if (!rows || !ys) return null
  const cur = ys.current
  const years = [...new Set([...ys.years.map(y => y.year).filter(y => y > cur), ...rows.map(r => r.crop_year)])].sort((a, b) => a - b)
  if (!years.length) return null
  const base = c as unknown as Record<string, number | null>
  const inForce = (y: number) => rows.filter(r => r.crop_year <= y).sort((a, b) => b.crop_year - a.crop_year)[0]
  const fmt = (t: Record<string, unknown>) => t.price_per_lb != null ? `$${Number(t.price_per_lb).toFixed(2)}/lb` : 'no price'
  async function save(clear: boolean) {
    if (!edit) return
    try { await backend.setTerms(edit, clear); setEdit(null); setMsg(clear ? `${edit.crop_year} terms removed` : `${edit.crop_year} terms saved`); load() }
    catch (e) { setMsg(String((e as Error).message ?? e)) }
  }
  return (
    <div className="field">
      <label>Terms by crop year</label>
      <p className="muted">The terms above are this customer's {cur} terms and carry over to later crops until a year gets its own.</p>
      {years.map(y => {
        const own = rows.find(r => r.crop_year === y), f = inForce(y)
        return (
          <div key={y} className="row between">
            <span><b>{y}</b> <span className="muted">{own ? fmt(own as unknown as Record<string, unknown>) : `same as ${f ? f.crop_year : cur} (${fmt((f ?? base) as unknown as Record<string, unknown>)})`}</span></span>
            <button className="ghost small" onClick={() => setEdit(own ?? { customer_id: c.id!, crop_year: y,
              price_per_lb: (f ?? base).price_per_lb ?? null, contract_lbs: (f ?? base).contract_lbs ?? null, monthly_min_lbs: (f ?? base).monthly_min_lbs ?? null,
              deposit_usd: (f ?? base).deposit_usd ?? null, storage_fee: (f ?? base).storage_fee ?? null })}>{own ? 'Edit' : `Set ${y} terms`}</button>
          </div>
        )
      })}
      {edit && (
        <div className="card-ish">
          <b>{edit.crop_year} terms</b>
          {TERM_KEYS.map(t => (
            <div key={t.k} className="field"><label>{t.l}</label>
              <input type="number" min="0" step="any" value={edit[t.k] == null ? '' : String(edit[t.k])}
                onChange={e => setEdit({ ...edit, [t.k]: e.target.value === '' ? null : Number(e.target.value) })} /></div>
          ))}
          <div className="row">
            <button className="primary small" onClick={() => save(false)}>Save {edit.crop_year} terms</button>
            {rows.some(r => r.crop_year === edit.crop_year) && <button className="ghost small" onClick={() => save(true)}>Remove (carry over instead)</button>}
            <button className="ghost small" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  )
}
