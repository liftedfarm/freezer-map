import { useEffect, useState } from 'react'
import type { Backend } from './api'
import { MODULES } from './types'
import type { AppUser, Customer, Level, Me, ModKey } from './types'

type Kind = 'staff' | 'customer' | 'none'
const KINDS: { k: Kind; label: string; what: string }[] = [
  { k: 'staff', label: 'Staff', what: 'Signs in with their Lifted Microsoft account. Pick what they can use below.' },
  { k: 'customer', label: 'Customer', what: 'Order portal only, for one customer account' },
  { k: 'none', label: 'No access', what: 'Blocked from the app' },
]
const kindOf = (u: Partial<AppUser>): Kind => u.role === 'customer' ? 'customer' : u.role === 'none' ? 'none' : 'staff'
const isStaffRole = (r?: string) => r === 'admin' || r === 'sales' || r === 'crew'
export function accessText(u: AppUser) {
  if (u.owner) return 'Owner: everything'
  const a = u.access ?? {}
  const parts = MODULES.filter(m => a[m.key]).map(m => m.key === 'admin' ? 'Admin module' : `${m.label}${a[m.key] === 'admin' ? ' (Admin)' : ''}`)
  return parts.length ? parts.join(' · ') : 'no modules'
}

function ago(at: string | null) {
  if (!at) return 'never signed in'
  const d = (Date.now() - new Date(at).getTime()) / 864e5
  return d < 1 ? 'active today' : d < 2 ? 'active yesterday' : `active ${Math.floor(d)} days ago`
}

/** Admin module > Settings > Users and access */
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

  if (err) return <div className="warnbox">Couldn't load users. ({err})</div>
  if (!users) return <p className="muted">Loading users…</p>
  const cust = new Map(customers.map(c => [c.id, c.name]))
  const shown = users.filter(u => !q || `${u.email} ${u.display_name ?? ''} ${accessText(u)} ${cust.get(u.customer_id ?? -1) ?? ''}`.toLowerCase().includes(q.toLowerCase()))
  const groups: [string, AppUser[]][] = [
    ['Owners', shown.filter(u => u.owner)],
    ['Staff', shown.filter(u => !u.owner && isStaffRole(u.role))],
    ['Customers', shown.filter(u => u.role === 'customer')],
    ['No access', shown.filter(u => u.role === 'none')],
  ]

  return (
    <>
      <div className="row toolbar">
        <input className="search" type="search" placeholder="Search people" value={q} onChange={e => setQ(e.target.value)} />
        <button className="primary" onClick={() => setEdit({ role: 'crew', access: { distribution: 'user' } })}>+ Add person</button>
      </div>
      <p className="muted">Anyone with a Lifted Microsoft account can sign in and starts with Distribution. Give each person a level per module: User works in it, Admin also changes its settings and approves. Owners have everything. For a customer login, add them as Customer, then send the invite link.</p>
      {groups.map(([l, list]) => !list.length ? null : (
        <div key={l}>
          <h3 className="grouph">{l} <span className="muted">{list.length}</span></h3>
          {list.map(u => (
            <button key={u.email} className="li setrow" onClick={() => setEdit({ ...u, access: { ...(u.access ?? {}) } })}>
              <div className="grow">
                <div><b>{u.display_name || u.email}</b>{u.email === (me.real_email ?? me.email) && <span className="muted"> · you</span>}</div>
                <div className="muted">{[u.display_name ? u.email : '', u.customer_id ? cust.get(u.customer_id) : '', loginStatus(u), isStaffRole(u.role) ? accessText(u) : '', ago(u.last_seen)].filter(Boolean).join(' · ')}</div>
              </div>
            </button>
          ))}
        </div>
      ))}
      {edit && <UserForm user={edit} customers={customers} me={me} isMe={edit.email === (me.real_email ?? me.email)} backend={backend}
        claimed={!!(edit.email && logins.get(edit.email)?.claimed)} flash={flash} onLinked={load}
        onClose={() => setEdit(null)}
        onSave={async (u, kind) => {
          try {
            await backend.saveUser({ email: u.email!, name: u.display_name ?? '', kind, customerId: kind === 'customer' ? u.customer_id ?? null : null,
              access: kind === 'staff' ? (u.access ?? {}) : {}, owner: me.access.owner ? !!u.owner : undefined })
            await load(); flash('Saved')
            // new customer: keep the card open so the invite link can be made right away
            if (kind === 'customer' && !edit.created_at) setEdit({ ...u, role: 'customer', created_at: new Date().toISOString(), added_by: me.email }); else setEdit(null)
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

function UserForm({ user, customers, me, isMe, onClose, onSave, onRemove, backend, claimed, flash, onLinked }: {
  user: Partial<AppUser>; customers: Customer[]; me: Me; isMe: boolean; backend: Backend; claimed: boolean
  flash: (t: string, bad?: boolean) => void; onLinked: () => void
  onClose: () => void; onSave: (u: Partial<AppUser>, kind: Kind) => Promise<void>; onRemove: (email: string) => Promise<void>
}) {
  const [u, setU] = useState(user)
  const [kind, setKind] = useState<Kind>(kindOf(user))
  const [busy, setBusy] = useState(false)
  const set = (x: Partial<AppUser>) => setU(v => ({ ...v, ...x }))
  const setLevel = (m: ModKey, lv: Level | null) => setU(v => { const a = { ...(v.access ?? {}) }; if (lv) a[m] = lv; else delete a[m]; return { ...v, access: a } })
  const isNew = !user.created_at
  const iOwn = me.access.owner
  const locked = !!user.owner && !iOwn            // only Owners change Owners
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((u.email ?? '').trim())
  const ok = emailOk && !locked && (kind !== 'customer' || !!u.customer_id)
  const run = (f: () => Promise<void>) => { setBusy(true); f().finally(() => setBusy(false)) }
  const external = customers.filter(c => c.active && c.kind === 'external')
  const a = u.access ?? {}
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{isNew ? 'Add person' : 'Edit person'}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {locked && <div className="warnbox">{user.display_name || user.email} is an Owner. Only another Owner can change them.</div>}
        <div className="field"><label>Email</label>
          <input type="email" value={u.email ?? ''} disabled={!isNew} autoFocus={isNew} onChange={e => set({ email: e.target.value })} placeholder="name@company.com" /></div>
        <div className="field"><label>Name <span className="muted">(what the app shows)</span></label>
          <input value={u.display_name ?? ''} disabled={locked} onChange={e => set({ display_name: e.target.value })} /></div>
        <div className="field"><label>Type</label>
          <div className="choices col">
            {KINDS.map(k => (
              <button key={k.k} className={kind === k.k ? 'on' : ''} disabled={locked || (isMe && k.k !== 'staff')} onClick={() => setKind(k.k)}>
                <b>{k.label}</b> <span className="muted">{k.what}</span>
              </button>
            ))}
          </div>
        </div>
        {kind === 'customer' && (
          <div className="field"><label>Customer account</label>
            <select value={u.customer_id ?? ''} onChange={e => set({ customer_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Pick a customer…</option>
              {external.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <p className="muted">They'll only ever see this customer's reserves, menu and orders. After saving, send them the invite link.</p>
          </div>
        )}
        {kind === 'staff' && (<>
          {iOwn && <label className="check"><input type="checkbox" checked={!!u.owner} disabled={isMe} onChange={e => set({ owner: e.target.checked })} />
            <span><b>Owner</b> <span className="muted">Everything in every module, and can make other Owners</span></span></label>}
          {u.owner ? <p className="muted">Owners have every module as Admin.</p> : (
            <div className="field"><label>Modules</label>
              <div className="accgrid">
                {MODULES.map(m => {
                  const lv = a[m.key] ?? null
                  const opts: [Level | null, string][] = m.key === 'admin' ? [[null, 'Off'], ['admin', 'On']] : [[null, 'Off'], ['user', 'User'], ['admin', 'Admin']]
                  return (
                    <div key={m.key} className="accrow">
                      <div><b>{m.label}</b><div className="muted">{lv === 'admin' && m.key !== 'admin' ? m.admin : lv ? m.user : m.what}</div></div>
                      <div className="seg">{opts.map(([v, l]) => <button key={l} className={lv === v ? 'on' : ''} disabled={locked || (isMe && m.key === 'admin' && !iOwn)} onClick={() => setLevel(m.key, v)}>{l}</button>)}</div>
                    </div>
                  )
                })}
              </div>
              {!MODULES.some(m => a[m.key]) && <p className="warn-t small">With every module off they'll only see a "no modules" message.</p>}
            </div>
          )}
        </>)}
        {!isNew && !isMe && !user.owner && !(user.access ?? {}).admin && (
          <div className="field"><label>See what they see</label>
            <div className="row"><button className="ghost small" disabled={busy} onClick={() => run(async () => { await backend.startViewAs(user.email!); location.reload() })}>View as {user.display_name || user.email}</button>
              <span className="muted">Read-only, for up to 2 hours. Logged in Activity.</span></div></div>
        )}
        {!isNew && user.role === 'customer' && <LinkBox backend={backend} email={user.email!} claimed={claimed} flash={flash} onLinked={onLinked} />}
        {isMe && <p className="muted">You can't take away your own access{iOwn ? ' or Owner' : ' or Admin module'}. Another {iOwn ? 'Owner' : 'Admin'} can.</p>}
        <div className="row between">
          {!isNew && !isMe && !locked
            ? <button className="ghost" disabled={busy} onClick={() => run(() => onRemove(u.email!))}>Remove</button>
            : <span />}
          <div className="row">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !ok} onClick={() => run(() => onSave({ ...u, email: u.email!.trim().toLowerCase() }, kind))}>Save</button>
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
