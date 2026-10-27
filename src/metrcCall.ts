import type { SupabaseClient } from '@supabase/supabase-js'

// Calls the METRC server function (/api/metrc/run) from anywhere in the app (loads, Inbound).
export async function metrcRun<T>(sb: SupabaseClient, body: object): Promise<T> {
  const { data } = await sb.auth.getSession()
  const r = await fetch('/api/metrc/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
  if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
  return j as T
}

export interface StopCheck { key: string; label: string; ok: boolean; detail: string | null }
export interface StopCheckRow { stop_id: number; license: string; ok: boolean; checks: StopCheck[]; checked_at: string; checked_by: string | null }
export interface AppTransfer { id: number; key: string; kind: string; license: string; recipient_license: string | null; recipient_name: string | null; stop_id: number | null
  manifest: string | null; state: 'created' | 'received' | 'voided'; transfer_type: string | null; created_by: string | null; created_at: string }
