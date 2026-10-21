import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Freezer, FreezerStatus, InvEvent, ListName, ListRow, Pallet, Settings, Slot, Snapshot, Strain } from './types'

export interface Backend {
  demo: boolean
  getUser(): Promise<string | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
  load(): Promise<Snapshot>
  movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string): Promise<void>
  setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string): Promise<void>
  clearReview(palletId: number, note?: string): Promise<void>
  splitPallet(palletId: number, lbs: number, tag: string | null, tagPending: boolean, dest: 'same' | 'staging', note?: string): Promise<Pallet>
  mergePallets(ids: number[], tag: string | null, tagPending: boolean, destSlot: number | null, note?: string): Promise<Pallet>
  setTag(palletId: number, tag: string, note?: string): Promise<void>
  adjustWeight(palletId: number, weight: number, note?: string): Promise<void>
  lineage(p: Pallet): Promise<Pallet[]>
  byIds(ids: number[]): Promise<Pallet[]>
  loadSettings(): Promise<Settings>
  saveRow(list: ListName, row: Partial<ListRow>): Promise<void>
  palletEvents(palletId: number): Promise<InvEvent[]>
  recentEvents(limit: number): Promise<InvEvent[]>
  search(q: string): Promise<Pallet[]>
  subscribe(onChange: () => void): () => void
}

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const CONFIG_MISSING = !(URL_ && KEY) && !import.meta.env.DEV

export function makeBackend(): Backend {
  const wantDemo = new URLSearchParams(location.search).has('demo')
  if (!wantDemo && URL_ && KEY) return new SupaBackend(createClient(URL_, KEY))
  return new DemoBackend()
}

// ---------------- Supabase ----------------

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const { data, error } = await fetchPage(from, from + size - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < size) return out
  }
}

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

class SupaBackend implements Backend {
  demo = false
  constructor(private sb: SupabaseClient) {}

  async getUser() {
    const { data } = await this.sb.auth.getSession()
    return data.session?.user.email ?? null
  }
  async signIn() {
    await this.sb.auth.signInWithOAuth({
      provider: 'azure',
      options: { scopes: 'email', redirectTo: location.origin },
    })
  }
  async signOut() {
    await this.sb.auth.signOut()
  }
  async load(): Promise<Snapshot> {
    const [freezers, slots, pallets, strains] = await Promise.all([
      pageAll<Freezer>((a, b) => this.sb.from('freezers').select('*').order('id').range(a, b)),
      pageAll<Slot>((a, b) => this.sb.from('slots').select('*').order('id').range(a, b)),
      pageAll<Pallet>((a, b) =>
        this.sb.from('pallets').select('*').in('status', ['in_freezer', 'unslotted']).order('id').range(a, b)),
      // strains table arrives with migration 003; tolerate it missing
      pageAll<Strain>((a, b) => this.sb.from('strains').select('*').order('name').range(a, b)).catch(() => [] as Strain[]),
    ])
    return { freezers, slots, pallets, strains }
  }
  async movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string) {
    const { error } = await this.sb.rpc('move_pallet', {
      p_pallet_id: palletId, p_to_slot: toSlot, p_combine: combine, p_note: note || null,
    })
    fail(error)
  }
  async setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string) {
    const { error } = await this.sb.rpc('set_freezer_status', {
      p_freezer_id: freezerId, p_status: status, p_note: note || null,
    })
    fail(error)
  }
  async clearReview(palletId: number, note?: string) {
    const { error } = await this.sb.rpc('clear_review', { p_pallet_id: palletId, p_note: note || null })
    fail(error)
  }
  async splitPallet(palletId: number, lbs: number, tag: string | null, tagPending: boolean, dest: 'same' | 'staging', note?: string) {
    const { data, error } = await this.sb.rpc('split_pallet', {
      p_pallet_id: palletId, p_lbs: lbs, p_new_tag: tag, p_tag_pending: tagPending, p_dest: dest, p_note: note || null,
    })
    fail(error)
    return data as Pallet
  }
  async mergePallets(ids: number[], tag: string | null, tagPending: boolean, destSlot: number | null, note?: string) {
    const { data, error } = await this.sb.rpc('merge_pallets', {
      p_ids: ids, p_new_tag: tag, p_tag_pending: tagPending, p_dest: destSlot, p_note: note || null,
    })
    fail(error)
    return data as Pallet
  }
  async setTag(palletId: number, tag: string, note?: string) {
    const { error } = await this.sb.rpc('set_tag', { p_pallet_id: palletId, p_tag: tag, p_note: note || null })
    fail(error)
  }
  async adjustWeight(palletId: number, weight: number, note?: string) {
    const { error } = await this.sb.rpc('adjust_weight', { p_pallet_id: palletId, p_weight: weight, p_note: note || null })
    fail(error)
  }
  async lineage(p: Pallet) {
    const ors = [`parent_id.eq.${p.id}`, `merged_into.eq.${p.id}`]
    if (p.parent_id) ors.push(`id.eq.${p.parent_id}`)
    if (p.merged_into) ors.push(`id.eq.${p.merged_into}`)
    const { data, error } = await this.sb.from('pallets').select('*').or(ors.join(',')).limit(200)
    fail(error)
    return (data ?? []) as Pallet[]
  }
  async loadSettings(): Promise<Settings> {
    const [vehicles, customers, strains] = await Promise.all((['vehicles', 'customers', 'strains'] as const).map(t =>
      pageAll<ListRow>((a, b) => this.sb.from(t).select('*').order('name').range(a, b))))
    return { vehicles, customers, strains } as Settings
  }
  async saveRow(list: ListName, row: Partial<ListRow>) {
    const { id, ...rest } = row as ListRow
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'updated_at'))
    const { error } = id ? await this.sb.from(list).update(clean).eq('id', id) : await this.sb.from(list).insert(clean)
    if (error) throw new Error(error.code === '23505' ? `"${(row as ListRow).name}" is already in the list` : error.message)
  }
  async byIds(ids: number[]) {
    const { data, error } = await this.sb.from('pallets').select('*').in('id', ids.slice(0, 300))
    fail(error)
    return (data ?? []) as Pallet[]
  }
  async palletEvents(palletId: number) {
    const { data, error } = await this.sb.from('events').select('*').eq('pallet_id', palletId).order('at', { ascending: false })
    fail(error)
    return (data ?? []) as InvEvent[]
  }
  async recentEvents(limit: number) {
    const { data, error } = await this.sb.from('events').select('*').neq('type', 'import')
      .order('at', { ascending: false }).limit(limit)
    fail(error)
    return (data ?? []) as InvEvent[]
  }
  async search(q: string) {
    const s = q.replace(/[%,()]/g, '').trim()
    const { data, error } = await this.sb.from('pallets').select('*')
      .or(`code.ilike.%${s}%,strain.ilike.%${s}%,package_tag.ilike.%${s}%,label.ilike.%${s}%`)
      .limit(200)
    fail(error)
    return (data ?? []) as Pallet[]
  }
  subscribe(onChange: () => void) {
    let t: number | undefined
    const bump = () => { clearTimeout(t); t = window.setTimeout(onChange, 400) }
    const ch = this.sb.channel('inv')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pallets' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'freezers' }, bump)
      .subscribe()
    return () => { this.sb.removeChannel(ch) }
  }
}

// ---------------- Demo (in-browser, nothing saved) ----------------

class DemoBackend implements Backend {
  demo = true
  private snap: Snapshot | null = null
  private events: InvEvent[] = []
  private nextEvent = 1
  private user = 'demo@lifted-organics.com'

  async getUser() { return this.user }
  async signIn() {}
  async signOut() {}
  async load() {
    if (!this.snap) {
      const r = await fetch('/demo-data.json')
      this.snap = await r.json() as Snapshot
      for (const p of this.snap.pallets) {
        if (p.status === 'in_freezer') this.log({ type: 'import', pallet_id: p.id, to_slot_id: p.slot_id, lbs: p.current_weight, note: 'Imported from Freezer Map 26.xlsm' }, 'import', '2026-10-20T08:00:00Z')
      }
    }
    const snap = { ...this.snap, strains: (await this.loadSettings()).strains }
    return structuredClone({ ...snap, pallets: snap.pallets.filter(p => p.status === 'in_freezer' || p.status === 'unslotted') })
  }
  private log(e: Partial<InvEvent>, who = this.user, at = new Date().toISOString()) {
    this.events.unshift({
      id: this.nextEvent++, at, user_email: who, type: 'move', pallet_id: null, freezer_id: null,
      from_slot_id: null, to_slot_id: null, lbs: null, note: null, details: null, ...e,
    })
  }
  async movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string) {
    const s = this.snap!
    const p = s.pallets.find(x => x.id === palletId)
    if (!p) throw new Error('Pallet not found')
    if (p.slot_id === toSlot) throw new Error(`Pallet ${p.code} is already there`)
    if (toSlot != null) {
      const slot = s.slots.find(x => x.id === toSlot)!
      const f = s.freezers.find(x => x.id === slot.freezer_id)!
      if (f.status === 'Not Working') throw new Error(`Freezer ${f.number} is marked Not Working`)
      if (!combine && s.pallets.some(x => x.slot_id === toSlot && x.id !== p.id))
        throw new Error('That slot is occupied. Choose combine to share it.')
    }
    this.log({ type: toSlot == null ? 'unslot' : 'move', pallet_id: p.id, from_slot_id: p.slot_id, to_slot_id: toSlot, lbs: p.current_weight, note: note || null })
    p.slot_id = toSlot
    p.status = toSlot == null ? 'unslotted' : 'in_freezer'
  }
  async setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string) {
    const f = this.snap!.freezers.find(x => x.id === freezerId)!
    this.log({ type: 'freezer_status', freezer_id: f.id, note: note || null, details: { from: f.status, to: status } })
    f.status = status
  }
  async clearReview(palletId: number, note?: string) {
    const p = this.snap!.pallets.find(x => x.id === palletId)!
    this.log({ type: 'review_cleared', pallet_id: p.id, note: note || null, details: { reason: p.needs_review } })
    p.needs_review = null
  }
  private nextId() { return Math.max(...this.snap!.pallets.map(p => p.id)) + 1 }
  private tagUsed(tag: string, except?: number) {
    return this.snap!.pallets.find(p => p.package_tag === tag && p.id !== except && (p.status === 'in_freezer' || p.status === 'unslotted'))?.code
  }
  async splitPallet(palletId: number, lbs: number, tag: string | null, tagPending: boolean, dest: 'same' | 'staging', note?: string) {
    const s = this.snap!, p = s.pallets.find(x => x.id === palletId)!
    tag = tag?.trim() || null
    if (p.current_weight == null) throw new Error(`Pallet ${p.code} has no weight. Adjust its weight first.`)
    if (!(lbs > 0)) throw new Error('Enter how many lbs to split off')
    if (lbs >= p.current_weight) throw new Error(`Split must be less than the pallet weight (${p.current_weight} lbs)`)
    if (!tag && !tagPending) throw new Error('Enter the new METRC tag, or mark it pending')
    if (tag && this.tagUsed(tag)) throw new Error(`Tag ${tag} is already on pallet ${this.tagUsed(tag)}`)
    const n = 1 + Math.max(0, ...s.pallets.map(x => x.code.startsWith(p.code + '-') && /^\d+$/.test(x.code.slice(p.code.length + 1)) ? +x.code.slice(p.code.length + 1) : 0))
    const slot = dest === 'same' ? p.slot_id : null
    const child: Pallet = { ...p, id: this.nextId(), code: `${p.code}-${n}`, label: null, og_weight: lbs, current_weight: lbs,
      package_tag: tag, parent_id: p.id, merged_into: null, slot_id: slot, status: slot == null ? 'unslotted' : 'in_freezer',
      tag_pending: !tag, needs_review: null, notes: null }
    s.pallets.push(child)
    p.current_weight = Math.round((p.current_weight - lbs) * 100) / 100
    this.log({ type: 'split', pallet_id: p.id, from_slot_id: p.slot_id, lbs, note: note || null, details: { child: child.code, child_id: child.id, remaining: p.current_weight } })
    this.log({ type: 'split_from', pallet_id: child.id, to_slot_id: slot, lbs, note: note || null, details: { parent: p.code, parent_id: p.id, tag } })
    return structuredClone(child)
  }
  async mergePallets(ids: number[], tag: string | null, tagPending: boolean, destSlot: number | null, note?: string) {
    const s = this.snap!, src = s.pallets.filter(x => ids.includes(x.id))
    tag = tag?.trim() || null
    if (src.length < 2) throw new Error('Pick at least two pallets to merge')
    if (new Set(src.map(x => x.strain?.toLowerCase())).size > 1) throw new Error('Only the same strain can be merged. Use share slot for different strains.')
    if (!tag && !tagPending) throw new Error('Enter the new METRC tag, or mark it pending')
    const total = src.reduce((a, x) => a + (x.current_weight ?? 0), 0)
    const cn = 1 + Math.max(0, ...s.pallets.map(x => /^C\d+$/.test(x.code) ? +x.code.slice(1) : 0))
    const zones = new Set(src.map(x => x.zone))
    const m: Pallet = { ...src[0], id: this.nextId(), code: `C${cn}`, label: null, og_weight: total, current_weight: total, package_tag: tag,
      parent_id: null, merged_into: null, slot_id: destSlot, status: destSlot == null ? 'unslotted' : 'in_freezer', tag_pending: !tag,
      zone: zones.size === 1 ? src[0].zone : 'Mixed', needs_review: null, notes: null }
    s.pallets.push(m)
    this.log({ type: 'merge', pallet_id: m.id, to_slot_id: destSlot, lbs: total, note: note || null, details: { sources: src.map(x => x.code), tag } })
    for (const x of src) {
      this.log({ type: 'merged_into', pallet_id: x.id, from_slot_id: x.slot_id, lbs: x.current_weight, note: note || null, details: { into: m.code, into_id: m.id } })
      x.status = 'merged'; x.slot_id = null; x.merged_into = m.id
    }
    return structuredClone(m)
  }
  async setTag(palletId: number, tag: string, note?: string) {
    const p = this.snap!.pallets.find(x => x.id === palletId)!
    tag = tag.trim()
    if (!tag) throw new Error('Enter a tag')
    if (this.tagUsed(tag, p.id)) throw new Error(`Tag ${tag} is already on pallet ${this.tagUsed(tag, p.id)}`)
    this.log({ type: 'tag_set', pallet_id: p.id, note: note || null, details: { from: p.package_tag, to: tag } })
    p.package_tag = tag; p.tag_pending = false
  }
  async adjustWeight(palletId: number, weight: number, note?: string) {
    const p = this.snap!.pallets.find(x => x.id === palletId)!
    if (!(weight >= 0)) throw new Error('Enter a weight of 0 or more')
    this.log({ type: 'weight_adjust', pallet_id: p.id, lbs: weight, note: note || null, details: { from: p.current_weight, to: weight } })
    p.current_weight = weight
  }
  async lineage(p: Pallet) {
    return structuredClone(this.snap!.pallets.filter(x => x.parent_id === p.id || x.merged_into === p.id || x.id === p.parent_id || x.id === p.merged_into))
  }
  private settings: Settings | null = null
  async loadSettings() {
    if (!this.settings) {
      const names = new Map<string, string>()
      for (const p of this.snap?.pallets ?? []) if (p.strain && !names.has(p.strain.toLowerCase())) names.set(p.strain.toLowerCase(), p.strain)
      this.settings = {
        vehicles: [{ id: 1, name: 'Isuzu Reefer', plate: '8ABC123', kind: 'Reefer truck', notes: null, active: true }],
        customers: [{ id: 1, name: 'OHR', kind: 'internal', license: null, address: null, contact: null, notes: 'Lifted site', active: true },
                    { id: 2, name: 'GVR', kind: 'internal', license: null, address: null, contact: null, notes: 'Lifted site', active: true }],
        strains: [...names.values()].sort().map((name, i) => ({ id: i + 1, name, aliases: [], color: null, notes: null, active: true })),
      }
    }
    return structuredClone(this.settings)
  }
  async saveRow(list: ListName, row: Partial<ListRow>) {
    await this.loadSettings()
    const rows = this.settings![list] as ListRow[]
    const name = (row.name ?? '').trim()
    if (!row.id && !name) throw new Error('Name is required')
    if (name && rows.some(r => r.name.toLowerCase() === name.toLowerCase() && r.id !== row.id)) throw new Error(`"${name}" is already in the list`)
    const ex = rows.find(r => r.id === row.id)
    if (ex) Object.assign(ex, row)
    else rows.push({ active: true, ...(list === 'strains' ? { aliases: [], color: null } : {}), ...row, id: Math.max(0, ...rows.map(r => r.id)) + 1 } as ListRow)
    this.log({ type: 'settings', note: ex ? 'updated' : 'added', details: { list, name: name || ex?.name, active: (ex ?? row).active } })
  }
  async byIds(ids: number[]) { return structuredClone(this.snap!.pallets.filter(p => ids.includes(p.id))) }
  async palletEvents(palletId: number) { return this.events.filter(e => e.pallet_id === palletId) }
  async recentEvents(limit: number) { return this.events.filter(e => e.type !== 'import').slice(0, limit) }
  async search(q: string) {
    const s = q.toLowerCase()
    return this.snap!.pallets.filter(p =>
      [p.code, p.strain, p.package_tag, p.label].some(v => v?.toLowerCase().includes(s))).slice(0, 200)
  }
  subscribe() { return () => {} }
}
