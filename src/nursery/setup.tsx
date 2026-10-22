import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NurseryApi } from './api'
import type { NData, NRoom, NSettings, RoomKind } from './types'
import { live, n0, sum } from './calc'
import { F, NumIn, Pick, SaveBar, Sheet, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { t } from '../i18n'
import { TagRanges } from '../licenses'
import type { PaymentTerm } from '../types'

const KIND: Record<RoomKind, string> = { bench: 'Greenhouse bench', greenhouse: 'Greenhouse', hoop: 'Hoop', trailer: 'Rooting trailer', veg: 'Veg', other: 'Other' }
// setting key, label, hint
const NUMS: [keyof NSettings, string, string, string][] = [
  ['buffer', 'nursery.buffer_pct', 'Extra cuttings %', 'covers losses'],
  ['deliverPct', 'nursery.deliver_pct', 'Deliver over order %', 'what you aim to send'],
  ['tray', 'nursery.tray', 'Cells per tray', ''],
  ['cutsG3', 'nursery.cuts_g3', 'Cuts per G3 field mom', ''],
  ['cutsG2', 'nursery.cuts_g2', 'Cuts per G2 greenhouse mom', ''],
  ['cutsG1', 'nursery.cuts_g1', 'Cuts per G1 mom', ''],
  ['rootDays', 'nursery.root_days', 'Days to root (G4)', 'cut to delivery'],
  ['g3VegDays', 'nursery.g3_veg_days', 'G3 planted → first G4 cut', 'days'],
  ['g3RootDays', 'nursery.g3_root_days', 'G3 cut → planted', 'days'],
  ['g2Lead', 'nursery.g2_lead_days', 'G2 cut → G3 cut', 'days'],
  ['g1Lead', 'nursery.g1_lead_days', 'G1 cut → G2 cut', 'days'],
  ['readyWarn', 'nursery.ready_warn_days', 'Flag ready batches after', 'days'],
  ['wage', 'nursery.wage', 'Hourly wage (labor cost)', '$'],
  ['price', 'nursery.clone_price', 'Price per clone', '$ (default)'],
]

/** Nursery > Settings (Nursery Admins) */
export function SetupTab({ d, sb, api, terms, flash, onSaved }: { d: NData; sb: SupabaseClient; api: NurseryApi; terms: PaymentTerm[]; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [vals, setVals] = useState<Record<string, number | null>>(() => Object.fromEntries(NUMS.map(([k]) => [k, d.settings[k] as number])))
  const [termsCode, setTerms] = useState<string | null>(d.settings.terms)
  const [busy, setBusy] = useState(false)
  const [room, setRoom] = useState<Partial<NRoom> | null>(null)
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const changed = NUMS.filter(([k]) => vals[k] !== d.settings[k])
  const nLics = d.licenses.filter(l => l.kind === 'nursery')
  const used = (r: { prefix: string; first_n: number; last_n: number; digits: number }) => {
    const inR = (t: string | null) => !!t && t.startsWith(r.prefix) && t.length === r.prefix.length + r.digits && (n => n >= r.first_n && n <= r.last_n)(Number(t.slice(r.prefix.length)))
    return d.mothers.filter(m => inR(m.plant_tag)).length + d.batches.reduce((a, b) => a + b.tags.filter(inR).length, 0)
  }
  const places = [...new Set(d.rooms.map(r => r.place))]
  const inRoom = (id: number) => sum(d.mothers.filter(m => m.room_id === id).map(live))
  return (
    <div className="dash">
      <section className="dcard"><div className="dcard-h"><h3>{t('Planning numbers')}</h3></div>
        <div className="nset">{NUMS.map(([k, , l, h]) => <F key={k} label={t(l)} hint={h ? `(${t(h)})` : undefined}><NumIn value={vals[k]} onChange={v => setVals(s => ({ ...s, [k]: v }))} /></F>)}
          <F label={t('Payment terms')} hint={t('(default)')}><Pick value={termsCode} options={terms.filter(t => t.active || t.code === termsCode).map(t => ({ v: t.code, l: t.label }))} onChange={setTerms} /></F></div>
        {(changed.length > 0 || termsCode !== d.settings.terms) && <button className="primary small" disabled={busy} onClick={() => run(async () => {
          for (const [k, key] of changed) await api.setSetting(key, String(vals[k] ?? 0))
          if (termsCode !== d.settings.terms) await api.setSetting('nursery.terms', termsCode ?? 'COD')
        }, t('Saved'))}>{t('Save')}</button>}
        <p className="muted small-note">{t('The Plan screen uses these. Cuts per mom can also be set per strain (tap a strain on the Plan). Each clone order can have its own price and terms.')}</p>
      </section>

      <section className="dcard"><div className="dcard-h"><h3>{t('Locations')}</h3><button className="linkbtn" onClick={() => setRoom({ site: d.sites[0]?.code, place: 'Webb', kind: 'hoop', active: true, beds: [{ bed: 'A', cap: 150 }, { bed: 'B', cap: 200 }, { bed: 'C', cap: 150 }] })}>{t('+ Add ›')}</button></div>
        {places.map(p => { const rs = d.rooms.filter(r => r.place === p); const hoops = rs.filter(r => r.kind === 'hoop'); return (
          <div key={p} className="locgroup"><b>{p}{rs.some(r => r.rented) ? ' (rented)' : ''}</b>
            <span className="muted small"> · {hoops.length} hoops, {n0(sum(hoops.map(h => h.capacity ?? 0)))} mom spots{rs.some(r => r.kind === 'trailer') ? ` · ${rs.filter(r => r.kind === 'trailer').length} trailers` : ''}</span>
            <div className="locgrid">{rs.map(r => <button key={r.id} className={`loc ${r.active ? '' : 'off'}`} onClick={() => setRoom(r)}>
              <b>{r.name}</b><span className="muted">{r.kind === 'hoop' ? `${n0(inRoom(r.id))} / ${n0(r.capacity)}` : r.kind === 'trailer' ? t('{n} trays', { n: n0(r.trays) }) : inRoom(r.id) ? t('{n} moms', { n: n0(inRoom(r.id)) }) : t(KIND[r.kind])}</span></button>)}</div>
          </div>) })}
      </section>

      <section className="dcard"><div className="dcard-h"><h3>{t('Nursery sites')}</h3></div>
        <div className="dlist">{d.sites.map(s => { const l = d.licenses.find(x => x.license_no === s.license)
          return <div key={s.code} className="drow"><span className="grow"><b>{s.name}</b><span className="muted"> · {t('license')} {s.license ?? t('none')}{l ? ` · ${l.entity}` : ''}</span></span></div> })}</div>
        <p className="muted small-note">{t('Invoices for clones come from the nursery license\'s entity. Edit licenses in Admin → Settings → Licenses.')}</p>
      </section>

      {nLics.map(l => <section key={l.license_no} className="dcard"><div className="dcard-h"><h3>{t('METRC tags')} · {l.license_no}</h3></div>
        <TagRanges sb={sb} license={l.license_no} kind="nursery" ranges={d.ranges} used={used} canEdit flash={flash} onChanged={() => onSaved(t('Tags updated'))} />
      </section>)}

      {room && <RoomSheet d={d} r={room} api={api} busy={busy} run={run} onClose={() => setRoom(null)} />}
    </div>
  )
}

function RoomSheet({ d, r, api, busy, run, onClose }: { d: NData; r: Partial<NRoom>; api: NurseryApi; busy: boolean; run: (f: () => Promise<unknown>, ok: string) => Promise<void>; onClose: () => void }) {
  const [x, setX] = useState<Partial<NRoom>>(r)
  const set = (v: Partial<NRoom>) => setX(s => ({ ...s, ...v }))
  const beds = x.beds ?? []
  const setBed = (i: number, cap: number | null) => set({ beds: beds.map((b, j) => (j === i ? { ...b, cap: cap ?? 0 } : b)) })
  const used = r.id ? d.mothers.some(m => m.room_id === r.id) || d.batches.some(b => b.room_id === r.id) : false
  return (
    <Sheet title={r.id ? r.name ?? t('Location') : t('New location')} onClose={onClose}>
      <div className="grid2">
        <F label={t('Name')}><TextIn value={x.name} onChange={v => set({ name: v ?? '' })} autoFocus={!r.id} placeholder={t('Hoop 19')} /></F>
        <F label={t('Place')}><TextIn value={x.place} list="n-places" onChange={v => set({ place: v ?? 'Webb' })} /></F>
        <F label={t('Kind')}><Pick value={x.kind} options={(Object.keys(KIND) as RoomKind[]).map(k => ({ v: k, l: t(KIND[k]) }))} onChange={v => set({ kind: v ?? 'other' })} /></F>
        {x.kind === 'trailer' && <F label={t('Trays it holds')}><NumIn value={x.trays} onChange={v => set({ trays: v })} /></F>}
      </div>
      <datalist id="n-places">{[...new Set(d.rooms.map(z => z.place))].map(p => <option key={p} value={p} />)}</datalist>
      {x.kind === 'hoop' && <>
        <h3>{t('Beds (plants each)')}</h3>
        <div className="grid3">{beds.map((b, i) => <F key={b.bed} label={`${t('Bed')} ${b.bed}`}><NumIn value={b.cap} onChange={v => setBed(i, v)} /></F>)}</div>
        <div className="row"><button className="ghost small" onClick={() => set({ beds: [...beds, { bed: String.fromCharCode(65 + beds.length), cap: 0 }] })}>{t('+ Bed')}</button>
          {beds.length > 0 && <button className="ghost small" onClick={() => set({ beds: beds.slice(0, -1) })}>{t('− Bed')}</button>}<span className="muted small">{t('{n} plants', { n: n0(sum(beds.map(b => b.cap))) })}</span></div>
      </>}
      <label className="check"><input type="checkbox" checked={!!x.rented} onChange={e => set({ rented: e.target.checked })} /> <span>{t('Rented space')}</span></label>
      <label className="check"><input type="checkbox" checked={x.active !== false} onChange={e => set({ active: e.target.checked })} /> <span>{t('In use')}</span></label>
      <SaveBar busy={busy} disabled={!x.name?.trim()} onCancel={onClose}
        onSave={() => run(() => api.save<NRoom>('nursery_rooms', { id: x.id, site: x.site ?? d.sites[0]?.code, place: (x.place ?? 'Webb').trim(), name: x.name!.trim(), kind: x.kind ?? 'other',
          active: x.active !== false, rented: !!x.rented, beds: x.kind === 'hoop' ? beds : [], capacity: x.kind === 'hoop' ? sum(beds.map(b => b.cap)) : null, trays: x.kind === 'trailer' ? x.trays ?? null : null }), t('Location saved')).then(onClose)}
        onDelete={r.id && !used ? () => run(() => api.remove('nursery_rooms', r.id!), t('Location removed')).then(onClose) : undefined} />
    </Sheet>
  )
}
