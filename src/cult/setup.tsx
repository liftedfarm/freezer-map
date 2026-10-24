import { useEffect, useState } from 'react'
import type { CultApi, TagRule } from './api'
import { n0, n2, pct } from './calc'
import type { CField, CSite, CultData, LogRow } from './types'
import { F, NumIn, Pick, SaveBar, Sheet, TextIn, errText } from './ui'
import type { Flash } from './ui'
import type { SupabaseClient } from '@supabase/supabase-js'
import { can, Fold } from '../fold'
import { ModulePeople } from '../users'

const TABLE_LABEL: Record<string, string> = {
  cult_harvests: 'Harvest', cult_plantings: 'Planting', cult_tests: 'Test', cult_flower_picks: 'Dry flower pick', cult_demand: 'Plan strain',
  cult_plan: 'Plan row', cult_nursery_orders: 'Nursery delivery', cult_receipts: 'Plants received', app_settings: 'Setting',
}

/** one line for a Production change log row */
export function describeLog(r: LogRow) {
  const what = TABLE_LABEL[r.tbl] ?? r.tbl
  const name = (r.data?.strain ?? r.was?.strain ?? '') as string
  const keys = r.op === 'update' ? Object.keys(r.data ?? {}).filter(k => !['updated_by', 'updated_at'].includes(k)) : []
  return `${what} ${r.op === 'insert' ? 'added' : r.op === 'delete' ? 'deleted' : 'changed'}${name ? `: ${name}` : ''}${keys.length ? ` (${keys.join(', ').replace(/_/g, ' ')})` : ''}`
}

export function SetupTab({ d, api, sb, flash, onSaved }: { d: CultData; api: CultApi; sb: SupabaseClient | null; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [site, setSite] = useState<CSite | null>(null)
  const [field, setField] = useState<Partial<CField> | null>(null)
  const [labs, setLabs] = useState(d.settings.labs.join(', '))
  const [eq, setEq] = useState(d.settings.equipment.join(', '))
  const [ready, setReady] = useState<number | null>(d.settings.readyDays)
  async function saveSettings() {
    try {
      await api.setSetting('cult.labs', labs.split(',').map(s => s.trim()).filter(Boolean).join('|'))
      await api.setSetting('cult.equipment', eq.split(',').map(s => s.trim()).join('|'))
      await api.setSetting('cult.ready_days', String(ready ?? 2))
      await onSaved('Settings saved')
    } catch (e) { flash(errText(e), true) }
  }
  return (
    <>
      <Fold id="cset.sites" title="Sites" count={d.sites.length} open>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Site</th><th>License</th><th className="num">Row ft / acre</th><th className="num">Dry ice / 10 lb</th><th className="num">Truck (raw lbs)</th><th className="num">Work day</th>
          <th className="num">Deleaf rate</th><th className="num">Buck rate</th><th className="num">Dry conv.</th><th>Pallets</th></tr></thead>
        <tbody>{d.sites.map(s => (
          <tr key={s.code} className="tap" onClick={() => setSite(s)}><td><b>{s.code}</b> <span className="muted">{s.name}</span></td><td className="small">{s.license}</td>
            <td className="num">{n0(s.row_feet_per_acre)}</td><td className="num">{s.dry_ice_per_10lb}</td><td className="num">{n0(s.truck_raw_lbs)}</td><td className="num">{s.workday_hours} h</td>
            <td className="num">{s.deleaf_rate ?? ''}</td><td className="num">{s.buck_rate ?? ''}</td><td className="num">{pct(s.dry_conversion)}</td><td>{s.pallet_prefix}###</td></tr>))}
        </tbody>
      </table></div>
      <p className="cnote">Deleaf and buck rates here are the defaults for harvests that don't have their own. Row feet per acre: 13,068 for 40" beds, 17,424 for 60" beds.</p>
      </Fold>

      <Fold id="cset.fields" title="Fields" count={d.fields.filter(f => f.active).length} right={<button className="primary small" onClick={() => setField({ site: 'OHR', kind: 'flower', active: true, aliases: [], sort: 50 })}>+ Field</button>}>
      <div className="cwrap"><table className="ctable">
        <thead><tr><th>Site</th><th>Code</th><th>Name</th><th>Also written as</th><th className="num">Acres</th><th>Use</th></tr></thead>
        <tbody>{d.fields.map(f => (
          <tr key={f.id} className={`tap ${f.active ? '' : 'cancelled'}`} onClick={() => setField(f)}><td>{f.site}</td><td><b>{f.code}</b></td><td>{f.name}</td>
            <td className="small">{f.aliases.join(', ')}</td><td className="num">{n2(f.acres)}</td><td>{f.kind}</td></tr>))}
        </tbody>
      </table></div>
      <p className="cnote">Pallet zones, harvest log fields and planting zones all match to these by code, name or "also written as" ("Block 1- A", "1A", "Field 8A").</p>
      </Fold>

      <Fold id="cset.lists" title="Lists">
      <F label="Labs" hint="comma separated"><TextIn value={labs} onChange={v => setLabs(v ?? '')} /></F>
      <F label="Biomass equipment" hint="cut, merge, combine, strip header"><TextIn value={eq} onChange={v => setEq(v ?? '')} /></F>
      <F label="Days from harvest to ready" hint="(availability)"><NumIn value={ready} onChange={setReady} /></F>
      <button className="primary" onClick={saveSettings}>Save lists</button>
      </Fold>
      <Fold id="cset.tags" title="METRC tags from pallet numbers"><TagRules api={api} flash={flash} /></Fold>
      <Fold id="cset.people" title="People"><ModulePeople sb={sb} module="cultivation" flash={flash} /></Fold>

      <p className="cnote">Every change in Production is listed under Activity.</p>

      {site && <SiteSheet s={site} api={api} flash={flash} onClose={() => setSite(null)} onSaved={async m => { setSite(null); await onSaved(m) }} />}
      {field && <FieldSheet d={d} f={field} api={api} flash={flash} onClose={() => setField(null)} onSaved={async m => { setField(null); await onSaved(m) }} />}
    </>
  )
}

function SiteSheet({ s, api, flash, onClose, onSaved }: { s: CSite; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(s)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<CSite>) => setX(o => ({ ...o, ...v }))
  async function save() { setBusy(true); try { await api.save('sites', x); await onSaved('Site saved') } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return (
    <Sheet title={`${s.code} settings`} onClose={onClose}>
      <div className="grid2">
        <F label="Name"><TextIn value={x.name} onChange={v => set({ name: v ?? s.name })} /></F>
        <F label="License"><TextIn value={x.license} onChange={v => set({ license: v })} /></F>
        <F label="Row feet per acre"><NumIn value={x.row_feet_per_acre} onChange={v => set({ row_feet_per_acre: v ?? 13068 })} /></F>
        <F label="Dry ice per 10 lb box"><NumIn value={x.dry_ice_per_10lb} onChange={v => set({ dry_ice_per_10lb: v ?? 3 })} /></F>
        <F label="Raw lbs per truck"><NumIn value={x.truck_raw_lbs} onChange={v => set({ truck_raw_lbs: v ?? 10000 })} /></F>
        <F label="Work day (hours)"><NumIn value={x.workday_hours} onChange={v => set({ workday_hours: v ?? 8 })} /></F>
        <F label="Deleaf rate" hint="plants/man-hr"><NumIn value={x.deleaf_rate} onChange={v => set({ deleaf_rate: v })} /></F>
        <F label="Buck rate" hint="lbs/man-hr"><NumIn value={x.buck_rate} onChange={v => set({ buck_rate: v })} /></F>
        <F label="Dry conversion" hint="0.075 = 7.5%"><NumIn value={x.dry_conversion} onChange={v => set({ dry_conversion: v ?? 0.075 })} /></F>
        <F label="Pallet letter"><TextIn value={x.pallet_prefix} onChange={v => set({ pallet_prefix: v ? v.toUpperCase() : null })} /></F>
      </div>
      <SaveBar busy={busy} onSave={save} onCancel={onClose} />
    </Sheet>
  )
}

function FieldSheet({ d, f, api, flash, onClose, onSaved }: { d: CultData; f: Partial<CField>; api: CultApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState(f)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<CField>) => setX(o => ({ ...o, ...v }))
  async function save() { setBusy(true); try { await api.save('fields', x); await onSaved('Field saved') } catch (e) { flash(errText(e), true) } finally { setBusy(false) } }
  return (
    <Sheet title={f.id ? `${f.site} ${f.code}` : 'Add field'} onClose={onClose}>
      <div className="grid2">
        <F label="Site"><Pick value={x.site ?? 'OHR'} onChange={v => set({ site: v ?? 'OHR' })} options={d.sites.map(s => ({ v: s.code, l: s.code }))} /></F>
        <F label="Code" hint="short, like 1A"><TextIn value={x.code} onChange={v => set({ code: v ?? '' })} /></F>
        <F label="Name"><TextIn value={x.name} onChange={v => set({ name: v ?? '' })} placeholder="Block 1- A" /></F>
        <F label="Acres" hint="net planted"><NumIn value={x.acres} onChange={v => set({ acres: v })} /></F>
        <F label="Use"><Pick value={x.kind ?? 'flower'} onChange={v => set({ kind: v ?? 'flower' })} options={['flower', 'biomass', 'both', 'trials', 'nursery'].map(k => ({ v: k as CField['kind'], l: k }))} /></F>
        <F label="Order"><NumIn value={x.sort} onChange={v => set({ sort: v ?? 0 })} /></F>
      </div>
      <F label="Also written as" hint="comma separated"><TextIn value={(x.aliases ?? []).join(', ')} onChange={v => set({ aliases: (v ?? '').split(',').map(s => s.trim()).filter(Boolean) })} /></F>
      <label className="check"><input type="checkbox" checked={x.active !== false} onChange={e => set({ active: e.target.checked })} /> In use</label>
      <SaveBar busy={busy} disabled={!x.code?.trim() || !x.name?.trim()} onSave={save} onCancel={onClose} />
    </Sheet>
  )
}

/** pallet # → METRC package tag, per site and letter: tag = prefix + (offset + number) padded to the digits. P53 at OHR = 1A406030007AD3D000010053. */
function TagRules({ api, flash }: { api: CultApi; flash: Flash }) {
  const [rules, setRules] = useState<TagRule[] | null>(null)
  const [ed, setEd] = useState<Partial<TagRule> | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.tagRules().then(setRules)
  useEffect(() => { load() }, [])
  const mine = can('cultivation', 'tag_rules')
  const sample = (r: Partial<TagRule>, n = 53) => r.prefix ? r.prefix + String((Number(r.offset) || 0) + n).padStart(Number(r.digits) || 9, '0') : ''
  const save = async (r: Partial<TagRule> & { delete?: boolean }) => {
    setBusy(true)
    try { await api.saveTagRule(r); await load(); setEd(null); flash(r.delete ? 'Rule removed' : 'Tag rule saved') } catch (e) { flash(errText(e), true) } finally { setBusy(false) }
  }
  if (!rules) return <p className="muted">Loading…</p>
  return (
    <>
      <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>Site</th><th>Pallets</th><th>Tag for #53</th><th className="hide-s">License</th><th /></tr></thead>
        <tbody>{rules.map(r => <tr key={r.site + r.letter} className={r.active ? '' : 'cancelled'}>
          <td>{r.site}</td><td>{r.letter}…</td><td className="mono small">{sample(r)}</td><td className="hide-s">{r.license ?? ''}</td>
          <td>{mine && <button className="ghost small" onClick={() => setEd(r)}>Edit</button>}</td></tr>)}
          {!rules.length && <tr><td colSpan={5} className="muted">No rules yet. Tags are typed or scanned.</td></tr>}</tbody>
      </table></div>
      {mine && !ed && <button className="ghost small" onClick={() => setEd({ site: 'OHR', letter: 'P', offset: 0, digits: 9, active: true })}>+ Rule</button>}
      {ed && <div className="grid3">
        <F label="Site"><TextIn value={ed.site} onChange={v => setEd({ ...ed, site: (v ?? '').toUpperCase() })} /></F>
        <F label="Pallet letter"><TextIn value={ed.letter} onChange={v => setEd({ ...ed, letter: (v ?? '').toUpperCase() })} /></F>
        <F label="Tag start" hint="before the number"><TextIn value={ed.prefix} onChange={v => setEd({ ...ed, prefix: (v ?? '').toUpperCase().replace(/\s/g, '') })} /></F>
        <F label="Add to the number"><NumIn value={ed.offset} onChange={v => setEd({ ...ed, offset: v ?? 0 })} /></F>
        <F label="Digits"><NumIn value={ed.digits} onChange={v => setEd({ ...ed, digits: v ?? 9 })} /></F>
        <F label="License"><TextIn value={ed.license} onChange={v => setEd({ ...ed, license: v })} /></F>
        <label className="check"><input type="checkbox" checked={ed.active !== false} onChange={e => setEd({ ...ed, active: e.target.checked })} /> <span>On</span></label>
        <p className="cnote" style={{ gridColumn: '1 / -1' }}>{ed.letter ?? ''}53 → <span className="mono">{sample(ed) || '…'}</span></p>
        <div className="row" style={{ gridColumn: '1 / -1' }}>
          <button className="ghost" onClick={() => setEd(null)}>Cancel</button>
          {rules.some(r => r.site === ed.site && r.letter === ed.letter) && <button className="ghost danger" disabled={busy} onClick={() => save({ site: ed.site, letter: ed.letter, delete: true })}>Remove</button>}
          <button className="primary" disabled={busy || !ed.site || !ed.letter || !ed.prefix} onClick={() => save(ed)}>Save rule</button>
        </div>
      </div>}
      <p className="cnote">The Harvest log fills in each pallet's METRC tag from its number. Trial (T) pallets have no rule: their tags are checked against METRC and typed. A tag typed or scanned on a pallet always wins.</p>
    </>
  )
}
