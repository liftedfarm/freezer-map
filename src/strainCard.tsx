import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { ListRow } from './types'
import { EditForm } from './settings'
import { StrainProfileEdit, loadProfiles } from './strains'
import type { StrainProfile } from './strains'
import { isAnyAdmin } from './fold'
import type { Strain } from './types'

// The strain settings card, from anywhere: tap a strain name on a pallet, package, reserve, harvest or inventory row.
// Same card as Settings > Strains. Any module Admin can change the name, color and other names;
// each fold of the profile is still only editable by that module's Admins.

export const openStrain = (name: string | null | undefined) => { if (name) window.dispatchEvent(new CustomEvent('lf:strain', { detail: name })) }

/** a strain name that opens the strain card */
export function StrainLink({ name, className }: { name: string | null | undefined; className?: string }) {
  if (!name) return null
  return <a className={`slink ${className ?? ''}`} title="Strain card" onClick={e => { e.stopPropagation(); e.preventDefault(); openStrain(name) }}>{name}</a>
}

export function findStrain(strains: Strain[], name: string): Strain | undefined {
  const n = name.trim().toLowerCase()
  return strains.find(s => s.name.toLowerCase() === n) ?? strains.find(s => (s.aliases ?? []).some(a => a.toLowerCase() === n))
}

export function StrainCardHost({ backend, strains, flash, onChanged }: { backend: Backend; strains: Strain[]; flash: (t: string, bad?: boolean) => void; onChanged: () => void }) {
  const [name, setName] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Map<number, StrainProfile> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const on = (e: Event) => setName((e as CustomEvent<string>).detail)
    window.addEventListener('lf:strain', on)
    return () => window.removeEventListener('lf:strain', on)
  }, [])
  const reloadProfiles = () => loadProfiles(backend.client()).then(setProfiles)
  useEffect(() => { if (name) reloadProfiles() }, [name])
  if (!name) return null
  const s = findStrain(strains, name)
  const close = () => setName(null)
  if (!s) return (
    <div className="scrim" onClick={close}><div className="sheet form" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2>{name}</h2><button className="ghost" onClick={close}>✕</button></div>
      <p className="muted">{name} isn't in the strain list. An Admin can add it in Settings › Strains, or add it as another name on an existing strain.</p>
    </div></div>
  )
  const p = profiles?.get(s.id)
  const profile = p ? <StrainProfileEdit key={s.id} sb={backend.client()} p={p} flash={flash} onSaved={reloadProfiles} /> : <p className="muted">{profiles ? '' : 'Loading…'}</p>
  if (isAnyAdmin()) return (
    <EditForm key={s.id} list="strains" row={structuredClone(s) as Partial<ListRow>} busy={busy} onClose={close} extra={profile}
      onSave={async row => {
        setBusy(true)
        try { await backend.saveRow('strains', row); onChanged(); flash('Saved'); close() }
        catch (e) { flash((e as Error).message, true) } finally { setBusy(false) }
      }} />
  )
  return (
    <div className="scrim" onClick={close}><div className="sheet form" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><h2><span className="swatch" style={{ background: s.color ?? 'transparent' }} /> {s.name}</h2><button className="ghost" onClick={close}>✕</button></div>
      {(s.aliases ?? []).length > 0 && <p className="muted">Also called {s.aliases.join(', ')}</p>}
      {s.notes && <p>{s.notes}</p>}
      {profile}
    </div></div>
  )
}
