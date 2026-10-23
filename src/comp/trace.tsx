import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CompApi } from './api'
import type { Trace } from './api'
import type { HarvestLot, Item, Pallet } from '../types'
import { FINISH_LABEL } from '../types'
import { FileChip, fmtD } from './files'
import type { Flash } from '../cult/ui'
import './comp.css'

// Rows for any inventory card (<dl>): item, harvest lot and the pre-harvest test (+ its files), plus COAs on the package itself.

const num = (x: number | null | undefined, u = '%') => (x == null ? null : `${Math.round(Number(x) * 100) / 100}${u}`)

/** item + harvest lot rows (for cards that don't already show them) */
export function ItemLotRows({ sb, p }: { sb: SupabaseClient | null; p: Pallet }) {
  const [item, setItem] = useState<Item | null>(null)
  const [lot, setLot] = useState<HarvestLot | null>(null)
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!sb) return
    setItem(null); setLot(null)
    if (p.item_id != null) sb.from('items').select('*').eq('id', p.item_id).maybeSingle().then(r => setItem((r.data ?? null) as Item | null), () => {})
    if (p.lot_id != null) sb.from('harvest_lots').select('*').eq('id', p.lot_id).maybeSingle().then(r => setLot((r.data ?? null) as HarvestLot | null), () => {})
  }, [sb, p.id, p.item_id, p.lot_id])
  return <>
    <dt>Item</dt><dd>{item
      ? <><a onClick={() => setShow(v => !v)}>{FINISH_LABEL[item.finish] ?? item.finish} · {item.crop_year} · {item.site}</a>
          {item.metrc_status === 'to_create' && <span className="pill warnp">not in METRC yet</span>}
          {show && <div className="muted small"><div className="mono">{item.sku}</div><div>{item.metrc_name}</div></div>}</>
      : <span className="muted">{p.item_id != null ? '…' : 'none (needs strain, farm and year)'}</span>}</dd>
    <dt>Harvest lot</dt><dd>{lot ? <><span className="mono">{lot.code}</span>{lot.metrc_name && lot.metrc_name !== lot.code && <div className="muted small">METRC: {lot.metrc_name}</div>}</>
      : <span className="muted">{p.lot_id != null ? '…' : 'none'}</span>}</dd>
  </>
}

/** pre-harvest test row (+ COAs on the package) */
export function TestRows({ sb, palletId, flash }: { sb: SupabaseClient | null; palletId: number; flash: Flash }) {
  const api = useMemo(() => (sb ? new CompApi(sb) : null), [sb])
  const [t, setT] = useState<Trace | null | undefined>(undefined)
  useEffect(() => { if (!api) return; setT(undefined); api.trace(palletId).then(setT).catch(() => setT(null)) }, [api, palletId])
  if (!api || t === undefined) return <><dt>Pre-harvest test</dt><dd className="muted">…</dd></>
  if (t === null) return null   // Compliance (055) not run yet
  const x = t.test
  const pass = /pass/i.test(x?.result ?? ''), bad = /fail/i.test(x?.result ?? '')
  return <>
    <dt>Pre-harvest test</dt>
    <dd>{!x ? <span className="muted">{t.harvest ? 'none on file for this harvest' : 'no harvest linked'}</span> : <>
      {x.result ? <b className={pass ? 'pos' : bad ? 'neg' : ''}>{x.result}</b> : <span className="muted">{x.results_on ? 'results back' : 'waiting on results'}</span>}
      <span className="muted"> · {x.kind === 'area' ? `${t.harvest?.site ?? ''} ${t.harvest?.field ?? ''} area composite` : `${t.harvest?.strain ?? ''} strain test`}
        {x.lab ? ` · ${x.lab}` : ''}{x.results_on ? ` · ${fmtD(x.results_on)}` : ''}</span>
      {(x.total_thc != null || x.total_cannabinoids != null || x.moisture != null) && <div className="small">
        {[x.total_thc != null && `THC ${num(x.total_thc)}`, x.total_cannabinoids != null && `Total cannabinoids ${num(x.total_cannabinoids)}`, x.moisture != null && `Moisture ${num(x.moisture)}`].filter(Boolean).join(' · ')}</div>}
      {x.files.length > 0 ? <div className="trace-files">{x.files.map(f => <FileChip key={f.id} api={api} f={f} flash={flash} />)}</div>
        : <div className="muted small">No results file yet (Production › Testing).</div>}
    </>}</dd>
    {t.docs.length > 0 && <><dt>COA / docs</dt><dd><div className="trace-files">{t.docs.map(f => <FileChip key={f.id} api={api} f={f} flash={flash} />)}</div></dd></>}
  </>
}
