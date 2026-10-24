import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Access } from './types'

/** a settings area that folds up; remembers open/closed per browser */
export function Fold({ id, title, count, right, open: def = false, force, children }: {
  id: string; title: ReactNode; count?: ReactNode; right?: ReactNode; open?: boolean; force?: boolean; children: ReactNode
}) {
  const key = `fold.${id}`
  const [open, setOpen] = useState<boolean>(() => { try { const v = localStorage.getItem(key); return v == null ? def : v === '1' } catch { return def } })
  const shown = force || open
  return (
    <section className={`fold ${shown ? 'open' : ''}`}>
      <div className="fold-h" onClick={() => { const v = !open; setOpen(v); try { localStorage.setItem(key, v ? '1' : '0') } catch { /* private */ } }}>
        <span className="fold-arrow">{shown ? '▾' : '▸'}</span><b>{title}</b>{count != null && <span className="muted"> {count}</span>}
        <span className="grow" />{right && <span onClick={e => e.stopPropagation()}>{right}</span>}
      </div>
      {shown && <div className="fold-b">{children}</div>}
    </section>
  )
}

// who's signed in (set by App once it knows): lets deep screens check "Admin of this module" without passing it down
let acc: Access | null = null
export const setMyAccess = (a: Access | null) => { acc = a }
export const isAdminOf = (m: string) => !!acc && (acc.owner || (acc.modules as Record<string, string | undefined>)[m] === 'admin')
export const isOwnerMe = () => !!acc?.owner
/** can work in a module (User or Admin, not View) */
export const canEditMod = (m: string) => !!acc && (acc.owner || ['user', 'admin'].includes((acc.modules as Record<string, string | undefined>)[m] ?? ''))
/** the permissions grid (058): can I do this action in this module? Before 058: falls back to the level that used to be needed. */
export function can(m: string, action: string, fallback: 'user' | 'admin' = 'admin') {
  if (!acc) return false
  if (acc.owner) return true
  const p = acc.perms?.[m]?.[action]
  if (p != null) return p
  return fallback === 'user' ? canEditMod(m) : isAdminOf(m)
}
