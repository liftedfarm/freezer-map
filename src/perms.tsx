import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MODULES } from './types'

// Admin > Settings > Permissions (058): per module, the lowest level that can do each action, plus per-person exceptions.
type Min = 'view' | 'user' | 'admin' | 'owner'
interface Rule { module: string; action: string; label: string; min_level: Min; sort: number; updated_by: string | null }
interface Override { email: string; module: string; action: string; allow: boolean; set_by: string | null }
const LEVELS: [Min, string][] = [['view', 'View'], ['user', 'User'], ['admin', 'Admin'], ['owner', 'Owner only']]

export function PermissionsPanel({ sb, flash }: { sb: SupabaseClient | null; flash: (t: string, bad?: boolean) => void }) {
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [ovs, setOvs] = useState<Override[]>([])
  const [people, setPeople] = useState<{ email: string; name: string | null }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [add, setAdd] = useState<{ email: string; key: string; allow: boolean } | null>(null)
  const load = async () => {
    if (!sb) return
    const [r, o, u] = await Promise.all([sb.from('perm_rules').select('*').order('module').order('sort'), sb.from('perm_overrides').select('*').order('email'),
      sb.from('app_users').select('email,display_name').in('role', ['admin', 'sales', 'crew']).order('email')])
    if (r.error) { setErr(/perm_rules/.test(r.error.message) ? 'Run 058_access.sql in Supabase first.' : r.error.message); return }
    setRules(r.data as Rule[]); setOvs((o.data ?? []) as Override[])
    setPeople(((u.data ?? []) as { email: string; display_name: string | null }[]).map(x => ({ email: x.email, name: x.display_name })))
  }
  useEffect(() => { load() }, [sb])
  const rpc = async (fn: string, args: object, ok: string) => {
    if (!sb) return
    setBusy(true)
    const { error } = await sb.rpc(fn, args)
    setBusy(false)
    if (error) flash(error.message, true); else { flash(ok); await load() }
  }
  if (err) return <div className="warnbox">{err}</div>
  if (!rules) return <p className="muted">Loading…</p>
  const mods = MODULES.filter(m => rules.some(r => r.module === m.key))
  const ruleOf = (k: string) => rules.find(r => `${r.module}.${r.action}` === k)
  const nameOf = (e: string) => people.find(p => p.email === e)?.name || e
  return (
    <div className="perms">
      <p className="muted">Who can do what in each module. Owners can always do everything. A level includes the ones above it (Admin can do what User can). Changes apply the next time each person loads the app.</p>
      {mods.map(m => (
        <div key={m.key}>
          <h3 className="grouph">{m.label}</h3>
          <div className="dlist">{rules.filter(r => r.module === m.key).map(r => (
            <div key={r.action} className="drow">
              <span className="grow">{r.label}{r.updated_by && <span className="muted small"> · changed by {r.updated_by.split('@')[0]}</span>}</span>
              <div className="seg">{LEVELS.filter(([v]) => r.action !== 'make_admins' || v === 'admin' || v === 'owner').map(([v, l]) =>
                <button key={v} disabled={busy} className={r.min_level === v ? 'on' : ''} onClick={() => r.min_level !== v && rpc('save_perm_rule', { p_module: r.module, p_action: r.action, p_min: v }, `${r.label}: ${l} and up`)}>{l}</button>)}</div>
            </div>))}</div>
        </div>
      ))}
      <h3 className="grouph">Exceptions for one person <span className="muted">{ovs.length}</span></h3>
      <p className="muted small">Let someone do one thing their level wouldn't allow, or stop them doing something it would.</p>
      <div className="dlist">{ovs.map(o => { const r = ruleOf(`${o.module}.${o.action}`)
        return <div key={`${o.email}.${o.module}.${o.action}`} className="drow">
          <span className="grow"><b>{nameOf(o.email)}</b> <span className={o.allow ? 'pos' : 'neg'}>{o.allow ? 'can' : "can't"}</span> {r ? `${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}` : o.action}
            <span className="muted small"> · {MODULES.find(m => m.key === o.module)?.label}</span></span>
          <button className="ghost small" disabled={busy} onClick={() => rpc('save_perm_override', { p_email: o.email, p_module: o.module, p_action: o.action, p_allow: null }, 'Exception removed')}>Remove</button>
        </div> })}</div>
      {!add ? <button className="ghost small" onClick={() => setAdd({ email: '', key: '', allow: true })}>+ Exception</button>
        : <div className="dcard">
          <div className="field"><label>Person</label><select value={add.email} onChange={e => setAdd({ ...add, email: e.target.value })}>
            <option value="">Pick someone…</option>{people.map(p => <option key={p.email} value={p.email}>{p.name ? `${p.name} (${p.email})` : p.email}</option>)}</select></div>
          <div className="field"><label>Action</label><select value={add.key} onChange={e => setAdd({ ...add, key: e.target.value })}>
            <option value="">Pick an action…</option>{mods.map(m => <optgroup key={m.key} label={m.label}>{rules.filter(r => r.module === m.key).map(r => <option key={r.action} value={`${r.module}.${r.action}`}>{r.label}</option>)}</optgroup>)}</select></div>
          <div className="seg"><button className={add.allow ? 'on' : ''} onClick={() => setAdd({ ...add, allow: true })}>Allow</button><button className={!add.allow ? 'on' : ''} onClick={() => setAdd({ ...add, allow: false })}>Don't allow</button></div>
          <div className="row"><button className="ghost" onClick={() => setAdd(null)}>Cancel</button>
            <button className="primary" disabled={busy || !add.email || !add.key} onClick={() => { const [m, a] = add.key.split('.'); rpc('save_perm_override', { p_email: add.email, p_module: m, p_action: a, p_allow: add.allow }, 'Exception saved').then(() => setAdd(null)) }}>Save</button></div>
        </div>}
    </div>
  )
}
