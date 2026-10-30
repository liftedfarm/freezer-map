import { useEffect, useState } from 'react'
import { errText } from '../cult/ui'
import type { Ctx } from './ctx'

// Compliance > Settings > METRC through T3 > New strain items (132): which items a new strain gets on each kind of license,
// with the METRC category and unit. Blank category or unit = copied from an existing item of the same kind on that license.
interface Rule { license_kind: string; finish: string; default_on: boolean; label: string | null; category: string | null; uom: string | null; sort: number }
const KIND: Record<string, string> = { cultivation: 'Farm (OHR / GVR cultivation)', processor: 'GVR Processing (both farms)', nursery: 'Nursery (1PN)' }
const FIN: Record<string, string> = { FF: 'Fresh Frozen', DH: 'Dry Harvest (wet weight)', UF: 'Unbucked', BF: 'Bucked', ST: 'Standards', SM: 'Smalls', TR: 'Dry Trim',
  BT: 'Bucking Trim', DB: 'Dry Biomass', DS: 'Dry Sift Biomass', CL: 'Clone', UR: 'Unrooted cutting (URC)', SD: 'Seed' }

export function ItemRules({ c }: { c: Ctx }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [edit, setEdit] = useState<Record<string, Partial<Rule>>>({})
  const load = () => c.api.sb.from('metrc_item_rules').select('*').order('license_kind').order('sort').then(r => setRules((r.data ?? []) as Rule[]))
  useEffect(() => { load() }, [])
  const key = (r: Rule) => `${r.license_kind}|${r.finish}`
  async function save(r: Rule, patch: Partial<Rule>) {
    const n = { ...r, ...patch }
    try {
      const { error } = await c.api.sb.rpc('save_metrc_item_rule', { p_kind: n.license_kind, p_finish: n.finish, p_default_on: n.default_on, p_label: n.label ?? '', p_category: n.category ?? '', p_uom: n.uom ?? '' })
      if (error) throw new Error(error.message)
      await load(); c.flash('Saved')
    } catch (e) { c.flash(errText(e), true) }
    setEdit(x => { const y = { ...x }; delete y[key(r)]; return y })
  }
  const txt = (r: Rule, k: 'label' | 'category' | 'uom', ph: string) => {
    const v = edit[key(r)]?.[k] ?? r[k] ?? ''
    return <input value={String(v)} placeholder={ph} disabled={!c.isAdmin} style={{ width: '100%' }}
      onChange={e => setEdit(x => ({ ...x, [key(r)]: { ...x[key(r)], [k]: e.target.value } }))}
      onBlur={() => { const nv = edit[key(r)]?.[k]; if (nv !== undefined && nv !== (r[k] ?? '')) save(r, { [k]: nv }); }} />
  }
  return <>
    <h3 style={{ marginTop: 14 }}>New strain items</h3>
    <p className="muted small">What a strain's METRC sheet makes on each kind of license. Ticked = on by default (the rest can be ticked per strain). Category and unit as METRC names them; blank = copy from an existing item of the same kind on that license.</p>
    <div className="tablewrap"><table className="ct"><thead><tr><th>License</th><th>Item</th><th>Default</th><th>Name ends</th><th>METRC category</th><th>Unit</th></tr></thead>
      <tbody>{rules.map((r, i) => <tr key={key(r)}>
        <td className="small">{i === 0 || rules[i - 1].license_kind !== r.license_kind ? KIND[r.license_kind] : ''}</td>
        <td>{FIN[r.finish] ?? r.finish}</td>
        <td><input type="checkbox" checked={r.default_on} disabled={!c.isAdmin} onChange={e => save(r, { default_on: e.target.checked })} /></td>
        <td>{txt(r, 'label', 'finish label')}</td>
        <td>{txt(r, 'category', 'copy')}</td>
        <td>{txt(r, 'uom', 'copy')}</td>
      </tr>)}</tbody></table></div>
  </>
}
