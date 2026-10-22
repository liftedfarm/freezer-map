import { useEffect, useState } from 'react'
import type { Backend } from './api'
import { MODULES, userModules } from './types'
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
  const [logins, setLogins] = useState<Map<string, { claimed: boolean; invited_at: string | null }>>(new Map())
  const load = () => Promise.all([backend.listUsers(), backend.userLogins()])
    .then(([u, l]) => { setUsers(u); setLogins(l); setErr(null) }).catch(e => setErr(String(e?.message ?? e)))
  const loginStatus = (u: AppUser) => {
    if (u.role !== 'customer') return ''
    const l = logins.get(u.email)
    return l?.claimed ? 'login set up' : l?.invited_at ? 'invited, not set up yet' : 'not invited yet'
  }
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
      <p className="muted">Anyone with a Lifted Microsoft account can sign in and starts as Crew. Change their role here. For a customer login, add them as Customer, then send them the invite link. They set their own password.</p>
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
                  <div className="muted">{[u.display_name ? u.email : '', u.customer_id ? cust.get(u.customer_id) : '', loginStatus(u), ['admin', 'sales', 'crew'].includes(u.role) ? (userModules(u).length ? userModules(u).map(k => MODULES.find(m => m.key === k)?.label ?? k).join(' + ') : 'no modules') : '', ago(u.last_seen)].filter(Boolean).join(' · ')}</div>
                </div>
              </button>
            ))}
          </div>
        )
      })}
      {edit && <UserForm user={edit} customers={customers} isMe={edit.email === me.email} backend={backend}
        claimed={!!(edit.email && logins.get(edit.email)?.claimed)} flash={flash} onLinked={load}
        onClose={() => setEdit(null)}
        onSave={async (u) => {
          try {
            await backend.setUser(u.email!, u.role!, u.customer_id ?? null, u.display_name ?? '')
            const mods = ['admin', 'sales', 'crew'].includes(u.role!) ? (u.modules ?? []) : []
            if (mods.join() !== (edit.modules ?? []).join()) await backend.setUserModules(u.email!, mods)
            const hid = ['admin', 'sales', 'crew'].includes(u.role!) ? (u.hidden_modules ?? []) : []
            if (hid.join() !== (edit.hidden_modules ?? []).join()) await backend.setUserHiddenModules(u.email!, hid)
            await load(); flash('Saved')
            // new customer: keep the card open so the invite link can be made right away
            if (u.role === 'customer' && !edit.created_at) setEdit({ ...u, created_at: new Date().toISOString(), added_by: me.email }); else setEdit(null)
          }
          catch (e) { flash(String((e as Error).message ?? e), true) }
        }}
        onRemove={async (email) => {
          try { await backend.removeUser(email); await load(); setEdit(null); flash('Removed') }
          catch (e) { flash(String((e as Error).message ?? e), true) }
        }} />}
    </>
  )
}

function UserForm({ user, customers, isMe, onClose, onSave, onRemove, backend, claimed, flash, onLinked }: {
  user: Partial<AppUser>; customers: Customer[]; isMe: boolean; backend: Backend; claimed: boolean
  flash: (t: string, bad?: boolean) => void; onLinked: () => void
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
            <p className="muted">They'll only ever see this customer's reserves, menu and orders. After saving, send them the invite link.</p>
          </div>
        )}
        {['admin', 'sales', 'crew'].includes(u.role ?? '') && (
          <div className="field"><label>Modules <span className="muted">(what this person sees)</span></label>
            {MODULES.map(m => {
              const hidden = (u.hidden_modules ?? []).includes(m.key)
              const on = (m.byDefault || (u.modules ?? []).includes(m.key)) && !hidden
              const flip = () => {
                const hid = (u.hidden_modules ?? []).filter(x => x !== m.key), mods = (u.modules ?? []).filter(x => x !== m.key)
                if (m.byDefault) set({ hidden_modules: on ? [...hid, m.key] : hid })
                else set({ modules: on ? mods : [...mods, m.key], hidden_modules: hid })
              }
              return (
                <label key={m.key} className="check">
                  <input type="checkbox" checked={on} onChange={flip} />
                  <span><b>{m.label}</b> <span className="muted">{m.what}{m.byDefault ? ' (on for everyone unless hidden)' : ''}</span></span>
                </label>
              )
            })}
            {userModules(u).length === 0 && <p className="warn-t small">With nothing ticked they'll only see a "no modules" message{isMe ? ' (you can still reach Settings from the top bar)' : ''}.</p>}
          </div>
        )}
        {!isNew && !isMe && user.role !== 'admin' && (
          <div className="field"><label>See what they see</label>
            <div className="row"><button className="ghost small" disabled={busy} onClick={() => run(async () => { await backend.startViewAs(user.email!); location.reload() })}>View as {user.display_name || user.email}</button>
              <span className="muted">Read-only, for up to 2 hours. Logged in Activity.</span></div></div>
        )}
        {!isNew && user.role === 'customer' && <LinkBox backend={backend} email={user.email!} claimed={claimed} flash={flash} onLinked={onLinked} />}
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

function LinkBox({ backend, email, claimed, flash, onLinked }: {
  backend: Backend; email: string; claimed: boolean; flash: (t: string, bad?: boolean) => void; onLinked: () => void
}) {
  const [link, setLink] = useState<{ kind: 'invite' | 'reset'; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  async function make(kind: 'invite' | 'reset') {
    setBusy(true)
    try { const url = await backend.makeLoginLink(email, kind); setLink({ kind, url }); onLinked() }
    catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  async function copy() {
    if (!link) return
    try { await navigator.clipboard.writeText(link.url); flash('Link copied') } catch { flash('Select the link and copy it', true) }
  }
  return (
    <div className="field linkbox">
      <label>Portal login <span className="muted">({claimed ? 'set up' : 'not set up yet'})</span></label>
      <div className="row">
        {!claimed && <button className="ghost small" disabled={busy} onClick={() => make('invite')}>Make invite link</button>}
        {claimed && <button className="ghost small" disabled={busy} onClick={() => make('reset')}>Make password reset link</button>}
      </div>
      {link && <>
        <input readOnly value={link.url} onFocus={e => e.target.select()} />
        <div className="row"><button className="primary small" onClick={copy}>Copy link</button>
          <span className="muted">Send it to them by email or text. Works once, for 14 days. Making a new link cancels the old one.</span></div>
      </>}
    </div>
  )
}
