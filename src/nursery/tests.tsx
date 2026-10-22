import { useState } from 'react'
import type { NurseryApi } from './api'
import type { NCtx } from './calc'
import { GEN_LABEL, fmtD, live, n0, strainKey, today } from './calc'
import type { LabTest, NData } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { t, tn } from '../i18n'

const RESULT: Record<LabTest['result'], string> = { pending: 'Pending', negative: 'Negative', positive: 'Positive', inconclusive: 'Inconclusive' }

/** Nursery > Logs > Lab tests (HLVD and others) */
export function LabTests({ d, c, api, flash, onSaved }: { d: NData; c: NCtx; api: NurseryApi; flash: Flash; onSaved: (m: string) => Promise<void> }) {
  const [open, setOpen] = useState<Partial<LabTest> | null>(null)
  const pos = d.tests.filter(x => x.result === 'positive')
  return <>
    <div className="row toolbar between"><span className="muted">{tn(d.tests.length, '{n} test', '{n} tests')}{pos.length ? ` · ${t('{n} positive', { n: pos.length })}` : ''}</span>
      <button className="primary" onClick={() => setOpen({ test: 'HLVD', round: 1, result: 'pending', tested_on: today(), culled: 0 })}>{t('+ Lab test')}</button></div>
    {!d.tests.length ? <p className="muted">{t('No lab tests yet. Log HLVD rounds here (vials, results, plants culled).')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>{t('Date')}</th><th>{t('Strain')}</th><th>{t('Test')}</th><th className="num">{t('Round')}</th><th>{t('Lot / location')}</th><th className="num">{t('Plants')}</th><th className="num">{t('Tested')}</th><th>{t('Vials')}</th><th>{t('Result')}</th><th className="num">{t('Culled')}</th></tr></thead>
      <tbody>{d.tests.map(x => { const m = d.mothers.find(z => z.id === x.mother_id); return (
        <tr key={x.id} className="tap" onClick={() => setOpen(x)}><td className="nowrap">{fmtD(x.tested_on)}</td><td>{x.strain}</td><td>{x.test}</td><td className="num">{x.round}</td>
          <td className="small">{m ? `${GEN_LABEL[m.gen]} ${c.room(m.room_id)}${m.bed ? ` ${m.bed}` : ''}` : c.room(x.room_id)}</td><td className="num">{n0(x.plants)}</td><td className="num">{n0(x.tested)}</td>
          <td className="small">{[x.vial_from, x.vial_to].filter(Boolean).join('–')}</td>
          <td><span className={`pill ${x.result === 'negative' ? 'okp' : x.result === 'positive' ? 'badp' : ''}`}>{t(RESULT[x.result])}</span></td><td className="num">{x.culled || ''}</td></tr>) })}</tbody>
    </table></div>}
    {open && <TestSheet d={d} c={c} t={open} api={api} flash={flash} onClose={() => setOpen(null)} onSaved={onSaved} />}
  </>
}

function TestSheet({ d, c, t: t0, api, flash, onClose, onSaved }: { d: NData; c: NCtx; t: Partial<LabTest>; api: NurseryApi; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState<Partial<LabTest>>(t0)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<LabTest>) => setX(s => ({ ...s, ...v }))
  const lots = d.mothers.filter(m => m.status === 'active' && (!x.strain || strainKey(m.strain) === strainKey(x.strain)))
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await f(); onClose(); await onSaved(ok) } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <Sheet title={t0.id ? `${t0.strain} · ${t0.test} ${t('round')} ${t0.round}` : t('New lab test')} onClose={onClose}>
      <F label={t('Strain')}><TextIn value={x.strain} list="n-strains" onChange={v => set({ strain: v ?? '' })} autoFocus={!t0.id} /></F>
      <StrainList id="n-strains" names={[...new Set(d.mothers.map(m => m.strain))]} />
      <div className="grid3">
        <F label={t('Mother lot')}><Pick value={x.mother_id} blank="—" options={lots.map(m => ({ v: m.id, l: `${GEN_LABEL[m.gen]} · ${[c.room(m.room_id), m.bed].filter(Boolean).join(' ') || t('no location')} · ${live(m)}` }))}
          onChange={v => { const m = d.mothers.find(z => z.id === v); set({ mother_id: v, ...(m ? { plants: live(m), room_id: m.room_id } : {}) }) }} /></F>
        <F label={t('Test')}><TextIn value={x.test} onChange={v => set({ test: v ?? 'HLVD' })} /></F>
        <F label={t('Round')}><NumIn value={x.round} onChange={v => set({ round: v ?? 1 })} /></F>
        <F label={t('Tested on')}><DateIn value={x.tested_on} onChange={v => set({ tested_on: v ?? today() })} /></F>
        <F label={t('Plants in group')}><NumIn value={x.plants} onChange={v => set({ plants: v })} /></F>
        <F label={t('Plants sampled')}><NumIn value={x.tested} onChange={v => set({ tested: v })} /></F>
        <F label={t('First vial #')}><TextIn value={x.vial_from} onChange={v => set({ vial_from: v })} /></F>
        <F label={t('Last vial #')}><TextIn value={x.vial_to} onChange={v => set({ vial_to: v })} /></F>
        <F label={t('Result')}><Pick value={x.result} options={(Object.keys(RESULT) as LabTest['result'][]).map(k => ({ v: k, l: t(RESULT[k]) }))} onChange={v => set({ result: v ?? 'pending' })} /></F>
        <F label={t('Plants culled')}><NumIn value={x.culled} onChange={v => set({ culled: v ?? 0 })} /></F>
      </div>
      <F label={t('Action taken')}><TextIn value={x.action} onChange={v => set({ action: v })} /></F>
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      {x.result === 'positive' && <p className="warn-t small-note">{t('Positive: cull the plants and record the loss on the mother lot (Mothers → the lot → Record loss).')}</p>}
      <SaveBar busy={busy} disabled={!x.strain?.trim()} onCancel={onClose}
        onSave={() => run(() => api.save<LabTest>('nursery_tests', { id: x.id, site: d.sites[0]?.code ?? '1PN', strain: x.strain!.trim(), mother_id: x.mother_id ?? null, room_id: x.room_id ?? null,
          test: x.test || 'HLVD', round: x.round ?? 1, plants: x.plants ?? null, tested: x.tested ?? null, vial_from: x.vial_from ?? null, vial_to: x.vial_to ?? null,
          tested_on: x.tested_on ?? today(), result: x.result ?? 'pending', culled: x.culled ?? 0, action: x.action ?? null, notes: x.notes ?? null }), t('Test saved'))}
        onDelete={t0.id ? () => run(() => api.remove('nursery_tests', t0.id!), t('Test deleted')) : undefined} />
    </Sheet>
  )
}
