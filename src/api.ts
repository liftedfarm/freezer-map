import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Freezer, FreezerStatus, InvEvent, Pallet, Slot, Snapshot } from './types'

export interface Backend {
  demo: boolean
  getUser(): Promise<string | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
  load(): Promise<Snapshot>
  movePallet(palletId: number, toSlot: number | null, combine: boolean, note?: string): Promise<void>
  setFreezerStatus(freezerId: number, status: FreezerStatus, note?: string): Promise<void>
  clearReview(palletId: number, note?: string): Promise<void>
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
    const [freezers, slots, pallets] = await Promise.all([
      pageAll<Freezer>((a, b) => this.sb.from('freezers').select('*').order('id').range(a, b)),
      pageAll<Slot>((a, b) => this.sb.from('slots').select('*').order('id').range(a, b)),
      pageAll<Pallet>((a, b) =>
        this.sb.from('pallets').select('*').in('status', ['in_freezer', 'unslotted']).order('id').range(a, b)),
    ])
    return { freezers, slots, pallets }
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
    return structuredClone(this.snap)
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
  async palletEvents(palletId: number) { return this.events.filter(e => e.pallet_id === palletId) }
  async recentEvents(limit: number) { return this.events.filter(e => e.type !== 'import').slice(0, limit) }
  async search(q: string) {
    const s = q.toLowerCase()
    return this.snap!.pallets.filter(p =>
      [p.code, p.strain, p.package_tag, p.label].some(v => v?.toLowerCase().includes(s))).slice(0, 200)
  }
  subscribe() { return () => {} }
}
