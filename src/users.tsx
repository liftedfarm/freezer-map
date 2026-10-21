import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { AppUser, Customer, Me, Role } from './types'

const ROLES: { role: Role; label: string; what: string }[] = [
  { role: 'admin', label: 'Admin', what: 'Everything, plus managing users' },
  { role: 'sales', label: 'Sales', what: 'Everything except users: customers, reserves, orders, pricing' },
  { role: 'crew', label: 'Crew', what: 'Freezers, pallets, loads. Customer names only, no orders or prices' },
  { role: 'customer', label: 'Customer', what: 'Order portal only, for one customer account' },
  { role: 'none', label: 'No access', what: 'Blocked from the app' },
]

function ago(at: string | null) {
  if (!at) return 'never signed in'
  const d = (Date.now() - new Date(at).getTime()) / 864e5
  return d < 1 ? 'active today' : d < 2 ? 'active yesterday' : `active ${Math.floor(d)} days ago`
}

export function UsersTab({ backend, me, customers, flash }: {
  backend: Backend; me: Me; customers: Customer[]; flash: (t: string, bad?: boolean) => void
}) {
  const [users, setUsers] = useState<AppUser[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [edit, setEdit] = useState<Partial<AppUser> | null>(null)
  const [q, setQ] = useState('')
  const load = () => backend.listUsers().then(u => { setUsers(u); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])

  if (err) return <div className="warnbox">Users aren't set up in the database yet. Run the 007_roles.sql update in Supabase, then refresh. ({err})</div>
  if (!users) return <p className="muted">Loading users…</p>
  const cust = new Map(customers.map(c => [c.id, c.name]))
  const shown = users.filter(u => !q || `${u.email} ${u.display_name ?? ''} ${u.role} ${cust.get(u.customer_id ?? -1) ?? ''}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <div className="row toolbar">
        <input className="search" type="search" placeholder="Search users" value={q} onChange={e => setQ(e.target.value)} />
        <button className="primary" onClick={() => setEdit({ role: 'crew' })}>+ Add user</button>
      </div>
      <p className="muted">Anyone with a Lifted Microsoft account can sign in and starts as Crew. Change their role here. Customer logins have to be added by an admin.</p>
      {ROLES.map(({ role, label: l }) => {
        const list = shown.filter(u => u.role === role)
        if (!list.length) return null
        return (
          <div key={role}>
            <h3 className="grouph">{l} <span className="muted">{list.length}</span></h3>
            {list.map(u => (
              <button key={u.email} className="li setrow" onClick={() => setEdit({ ...u })}>
                <div className="grow">
                  <div><b>{u.display_name || u.email}</b>{u.email === me.email && <span className="muted"> · you</span>}</div>
                  <div className="muted">{[u.display_name ? u.email : '', u.customer_id ? cust.get(u.customer_id) : '', ago(u.last_seen)].filter(Boolean).join(' · ')}</div>
                </div>
              </button>
            ))}
          </div>
        )
      })}
      {edit && <UserForm user={edit} customers={customers} isMe={edit.email === me.email}
        onClose={() => setEdit(null)}
        onSave={async (u) => {
          try { await backend.setUser(u.email!, u.role!, u.customer_id ?? null, u.display_name ?? ''); await load(); setEdit(null); flash('Saved') }
          catch (e) { flash(String((e as Error).message ?? e), true) }
        }}
        onRemove={async (email) => {
          try { await backend.removeUser(email); await load(); setEdit(null); flash('Removed') }
          catch (e) { flash(String((e as Error).message ?? e), true) }
        }} />}
    </>
  )
}

function UserForm({ user, customers, isMe, onClose, onSave, onRemove }: {
  user: Partial<AppUser>; customers: Customer[]; isMe: boolean
  onClose: () => void; onSave: (u: Partial<AppUser>) => Promise<void>; onRemove: (email: string) => Promise<void>
}) {
  const [u, setU] = useState(user)
  const [busy, setBusy] = useState(false)
  const set = (x: Partial<AppUser>) => setU(v => ({ ...v, ...x }))
  const isNew = !user.created_at
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((u.email ?? '').trim())
  const ok = emailOk && !!u.role && (u.role !== 'customer' || !!u.customer_id)
  const run = (f: () => Promise<void>) => { setBusy(true); f().finally(() => setBusy(false)) }
  const external = customers.filter(c => c.active && c.kind === 'external')
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{isNew ? 'Add user' : 'Edit user'}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="field"><label>Email</label>
          <input type="email" value={u.email ?? ''} disabled={!isNew} autoFocus={isNew} onChange={e => set({ email: e.target.value })} placeholder="name@company.com" /></div>
        <div className="field"><label>Name <span className="muted">(what the app shows)</span></label>
          <input value={u.display_name ?? ''} onChange={e => set({ display_name: e.target.value })} /></div>
        <div className="field"><label>Role</label>
          <div className="choices col">
            {ROLES.map(r => (
              <button key={r.role} className={u.role === r.role ? 'on' : ''} disabled={isMe && r.role !== 'admin'} onClick={() => set({ role: r.role })}>
                <b>{r.label}</b> <span className="muted">{r.what}</span>
              </button>
            ))}
          </div>
        </div>
        {u.role === 'customer' && (
          <div className="field"><label>Customer account</label>
            <select value={u.customer_id ?? ''} onChange={e => set({ customer_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Pick a customer…</option>
              {external.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <p className="muted">They'll only ever see this customer's reserves, menu and orders. Portal sign-in is coming in the next update.</p>
          </div>
        )}
        {isMe && <p className="muted">You can't change your own role. Another admin can.</p>}
        <div className="row between">
          {!isNew && !isMe
            ? <button className="ghost" disabled={busy} onClick={() => run(() => onRemove(u.email!))}>Remove</button>
            : <span />}
          <div className="row">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !ok} onClick={() => run(() => onSave({ ...u, email: u.email!.trim().toLowerCase() }))}>Save</button>
          </div>
        </div>
        {!isNew && <p className="muted">Added by {user.added_by ?? 'unknown'} · {ago(user.last_seen ?? null)}</p>}
      </div>
    </div>
  )
}
