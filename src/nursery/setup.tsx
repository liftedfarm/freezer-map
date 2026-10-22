import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NurseryApi } from './api'
import type { NData, NRoom } from './types'
import { F, NumIn, Pick, SaveBar, Sheet, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { TagRanges } from '../licenses'
import type { PaymentTerm } from '../types'

const KIND: Record<NRoom['kind'], string> = { mother: 'Mother room', clone: 'Clone / rooting', veg: 'Veg', other: 'Other' }

/** Nursery > Settings (Nursery Admins) */
export function SetupTab({ d, sb, api, terms, flash, onSaved }: { d: NData; sb: SupabaseClient; api: NurseryApi; terms: PaymentTerm[]; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [price, setPrice] = useState<number | null>(d.settings.price)
  const [termsCode, setTerms] = useState<string | null>(d.settings.terms)
  const [root, setRoot] = useState<number | null>(d.settings.rootDays)
  const [busy, setBusy] = useState(false)
  const [room, setRoom] = useState<Partial<NRoom> | null>(null)
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const changed = price !== d.settings.price || termsCode !== d.settings.terms || root !== d.settings.rootDays
  const nLics = d.licenses.filter(l => l.kind === 'nursery')
  const used = (r: { prefix: string; first_n: number; last_n: number; digits: number }) => {
    const inR = (t: string | null) => !!t && t.startsWith(r.prefix) && t.length === r.prefix.length + r.digits && (n => n >= r.first_n && n <= r.last_n)(Number(t.slice(r.prefix.length)))
    return d.mothers.filter(m => inR(m.plant_tag)).length + d.batches.reduce((a, b) => a + b.tags.filter(inR).length, 0)
  }
  return (
    <div className="dash">
      <section className="dcard"><div className="dcard-h"><h3>Clone orders</h3></div>
        <div className="grid3 nset">
          <F label="Price per clone" hint="(default)"><NumIn value={price} onChange={setPrice} /></F>
          <F label="Payment terms" hint="(default)"><Pick value={termsCode} options={terms.filter(t => t.active || t.code === termsCode).map(t => ({ v: t.code, l: t.label }))} onChange={setTerms} /></F>
          <F label="Days to root" hint="(ready-by date)"><NumIn value={root} onChange={setRoot} /></F>
        </div>
        {changed && <button className="primary small" disabled={busy} onClick={() => run(async () => {
          if (price !== d.settings.price) await api.setSetting('nursery.clone_price', String(price ?? 0))
          if (termsCode !== d.settings.terms) await api.setSetting('nursery.terms', termsCode ?? 'COD')
          if (root !== d.settings.rootDays) await api.setSetting('nursery.root_days', String(root ?? 14))
        }, 'Saved')}>Save</button>}
        <p className="muted small-note">Each order can have its own price and terms. These are used when it doesn't.</p>
      </section>

      <section className="dcard"><div className="dcard-h"><h3>Nursery sites</h3></div>
        <div className="dlist">{d.sites.map(s => {
          const l = d.licenses.find(x => x.license_no === s.license)
          return <div key={s.code} className="drow"><span className="grow"><b>{s.name}</b><span className="muted"> · license {s.license ?? 'none'}{l ? ` · ${l.entity}` : ''}</span></span></div>
        })}</div>
        <p className="muted small-note">Invoices for clones come from the nursery license's entity. Edit licenses (entity, address, how to pay) in Admin → Settings → Licenses.</p>
      </section>

      <section className="dcard"><div className="dcard-h"><h3>Rooms</h3><button className="linkbtn" onClick={() => setRoom({ site: d.sites[0]?.code, kind: 'clone', active: true })}>+ Add ›</button></div>
        <div className="dlist">{d.rooms.map(r => <button key={r.id} className={`drow click ${r.active ? '' : 'off'}`} onClick={() => setRoom(r)}>
          <span className="grow"><b>{r.name}</b><span className="muted"> · {KIND[r.kind]}{d.sites.length > 1 ? ` · ${r.site}` : ''}{r.active ? '' : ' · not in use'}</span></span></button>)}</div>
      </section>

      {nLics.map(l => <section key={l.license_no} className="dcard"><div className="dcard-h"><h3>METRC tags · {l.license_no}</h3></div>
        <TagRanges sb={sb} license={l.license_no} kind="nursery" ranges={d.ranges} used={used} canEdit flash={flash} onChanged={() => onSaved('Tags updated')} />
        <p className="muted small-note">Enter the first and last tag of each range METRC issued. "Fill next tags" on mothers and batches takes the next unused ones.</p>
      </section>)}

      {room && <Sheet title={room.id ? room.name ?? 'Room' : 'New room'} onClose={() => setRoom(null)}>
        <F label="Name"><TextIn value={room.name} onChange={v => setRoom({ ...room, name: v ?? '' })} autoFocus /></F>
        <F label="Use"><Pick value={room.kind} options={(Object.keys(KIND) as NRoom['kind'][]).map(k => ({ v: k, l: KIND[k] }))} onChange={v => setRoom({ ...room, kind: v ?? 'clone' })} /></F>
        <label className="check"><input type="checkbox" checked={room.active !== false} onChange={e => setRoom({ ...room, active: e.target.checked })} /> <span>In use</span></label>
        <SaveBar busy={busy} disabled={!room.name?.trim()} onCancel={() => setRoom(null)}
          onSave={() => run(() => api.save<NRoom>('nursery_rooms', { id: room.id, site: room.site ?? d.sites[0]?.code, name: room.name!.trim(), kind: room.kind ?? 'clone', active: room.active !== false }), 'Room saved').then(() => setRoom(null))} />
      </Sheet>}
    </div>
  )
}
