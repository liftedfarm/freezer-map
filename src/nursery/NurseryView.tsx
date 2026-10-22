import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Backend } from '../api'
import type { Customer, PaymentTerm } from '../types'
import { NurseryApi } from './api'
import { GEN_LABEL, STAGE_LABEL, addDays, dueWithin, fmtD, live, makeCtx, n0, planSeason, strainKey, sum, today } from './calc'
import type { NCtx } from './calc'
import type { Batch, Mother, NData, NOrder, NTab } from './types'
import { nurseryLabel } from './tabs'
import { OrderSheet, OrdersTab, statusPill } from './orders'
import { BatchSheet, BatchesTab } from './batches'
import { MotherSheet, MothersTab } from './mothers'
import { PlanTab } from './plan'
import { LabTests } from './tests'
import { Leachate } from './leachate'
import { BreedingTab } from './breeding'
import { OpsLogs } from '../logs'
import { SetupTab } from './setup'
import { Card, Cards, DashHead, Empty, Meter, Tile, Tiles } from '../dash'
import { DocSheet, InvoicesView } from '../invoices'
import { errText } from '../cult/ui'
import { SortDay } from './sortday'
import { lang, t, tn } from '../i18n'
import '../cult/cult.css'
import './nursery.css'

export default function NurseryView({ backend, flash, tab, go, customers, isAdmin, sender, me }: {
  backend: Backend; flash: (t: string, bad?: boolean) => void; tab: NTab; go: (t: NTab) => void; customers: Customer[]; isAdmin: boolean; sender?: string | null; me?: string
}) {
  const sb = useMemo(() => backend.client(), [backend])
  const api = useMemo(() => (sb ? new NurseryApi(sb) : null), [sb])
  const [d, setD] = useState<NData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [terms, setTerms] = useState<PaymentTerm[]>([])
  const [order, setOrder] = useState<Partial<NOrder> | null>(null)
  const [batch, setBatch] = useState<Partial<Batch> | null>(null)
  const [mother, setMother] = useState<Partial<Mother> | null>(null)
  const [doc, setDoc] = useState<{ kind: 'invoice' | 'nso'; id: number } | null>(null)
  const [sortDay, setSortDay] = useState(false)

  const load = useCallback(async () => {
    if (!api) return
    try { setD(await api.load()); setErr(null) } catch (e) { setErr(errText(e)) }
  }, [api])
  useEffect(() => { load(); backend.paymentTerms().then(setTerms).catch(() => {}) }, [load])
  const cust = useMemo(() => new Map(customers.map(c => [c.id, c.name])), [customers])
  const c = useMemo(() => d && makeCtx(d, cust), [d, cust])
  const saved = useCallback(async (m: string) => { await load(); flash(t(m)) }, [load, flash])

  const title = <h2>{tab === 'dashboard' ? '' : t(nurseryLabel(tab))} <span className="dev">{t('new')}</span></h2>
  if (!api || !sb) return <div className="list"><h2>{t('Nursery')}</h2><p className="muted">{t('The Nursery needs the database (not available in the demo).')}</p></div>
  if (err) return <div className="list"><h2>{t('Nursery')}</h2><div className="warnbox">{t('Couldn\'t load the nursery. If this is the first time, run 028_licenses_nursery.sql in Supabase.')} ({err})</div></div>
  if (!d || !c) return <div className="list"><h2>{t('Nursery')}</h2><p className="muted">{t('Loading…')}</p></div>

  const search = ['orders', 'batches', 'mothers'].includes(tab)
  const areas = [...new Set(['Webb', 'GH', ...d.rooms.filter(r => r.active).map(r => r.name), ...d.rooms.map(r => r.place)])]
  return (
    <div className="cult nursery">
      {tab !== 'dashboard' && tab !== 'invoices' && <div className="chead">{title}</div>}
      {search && <div className="row toolbar"><input className="search" type="search" placeholder={t('Search strain, tag, farm, notes')} value={q} onChange={e => setQ(e.target.value)} /></div>}

      {tab === 'dashboard' && <NurseryDashboard d={d} c={c} go={go} onOrder={setOrder} onBatch={setBatch} />}
      {tab === 'orders' && <OrdersTab d={d} c={c} q={q} onOpen={setOrder} onNew={() => setOrder({ nursery_site: d.sites[0]?.code, status: 'confirmed' })} />}
      {tab === 'batches' && <BatchesTab d={d} c={c} q={q} onOpen={setBatch} onNew={() => setBatch({})} onSortDay={() => setSortDay(true)} />}
      {tab === 'plan' && <PlanTab d={d} c={c} api={api} flash={flash} onSaved={saved} />}
      {tab === 'mothers' && <MothersTab d={d} c={c} q={q} api={api} flash={flash} onSaved={saved} onOpen={setMother} onAdd={v => setMother(v ?? {})} />}
      {tab === 'breeding' && <BreedingTab sb={sb} d={d} c={c} flash={flash} me={me ?? ''} />}
      {tab === 'logs' && <OpsLogs sb={sb} module="nursery" sites={d.sites.map(s => s.code)} areas={areas} strains={[...new Set([...d.mothers.map(m => m.strain), ...d.strains])]} flash={flash}
        wage={d.settings.wage} canEditRecipes={isAdmin} batches={d.batches.filter(b => b.stage !== 'cancelled').slice(0, 300).map(b => ({ id: b.id, strain: b.strain, label: `${fmtD(b.cut_on)} ${b.strain} ${GEN_LABEL[b.gen]} · ${n0(b.cuttings)}` }))}
        extraTabs={[{ k: 'leach', l: t('Leachate'), node: <Leachate sb={sb} d={d} flash={flash} /> }, { k: 'lab', l: t('Lab tests'), node: <LabTests d={d} c={c} api={api} flash={flash} onSaved={saved} /> }]} />}
      {tab === 'invoices' && <InvoicesView backend={backend} customers={customers} flash={flash} isAdmin={isAdmin} sender={sender} scope="nursery" />}
      {tab === 'review' && <NurseryReview d={d} c={c} onOrder={setOrder} onBatch={setBatch} onMother={setMother} go={go} />}
      {tab === 'activity' && <NurseryActivity api={api} />}
      {tab === 'settings' && (isAdmin ? <SetupTab d={d} sb={sb} api={api} terms={terms} flash={flash} onSaved={saved} /> : <p className="muted">{t('Only a Nursery Admin can change Nursery settings.')}</p>)}

      {order && <OrderSheet key={order.id ?? 'new'} d={d} c={c} o={order} customers={customers} terms={terms} api={api} flash={flash} isAdmin={isAdmin}
        onClose={() => setOrder(null)} onSaved={async m => { await saved(m) }} onDoc={(kind, id) => setDoc({ kind, id })} />}
      {batch && <BatchSheet key={batch.id ?? 'new'} d={d} c={c} b={batch} api={api} flash={flash} onClose={() => setBatch(null)} onSaved={saved} />}
      {sortDay && <SortDay d={d} api={api} flash={flash} onClose={() => setSortDay(false)} onSaved={saved} />}
      {mother && <MotherSheet key={mother.id ?? 'new'} d={d} c={c} m={mother} api={api} flash={flash} onClose={() => setMother(null)} onSaved={saved} />}
      {doc && <DocSheet backend={backend} kind={doc.kind} id={doc.id} flash={flash} onClose={() => setDoc(null)} onChanged={load} canEdit canVoid={isAdmin} sender={sender} />}
    </div>
  )
}

/** what needs doing this week, what's ready, and the mother stock */
function NurseryDashboard({ d, c, go, onOrder, onBatch }: { d: NData; c: NCtx; go: (t: NTab) => void; onOrder: (o: NOrder) => void; onBatch: (b: Partial<Batch>) => void }) {
  const now = today(), wk = addDays(now, 6)
  const mothers = d.mothers.filter(m => m.status === 'active' && live(m) > 0)
  const mStrains = new Set(mothers.map(m => strainKey(m.strain)))
  const gN = (g: number) => sum(mothers.filter(m => m.gen === g).map(live))
  const rooting = d.batches.filter(b => b.stage === 'rooting')
  const ready = d.batches.filter(b => b.stage === 'ready' && c.left(b) > 0)
  const readySoon = rooting.filter(b => b.ready_on && b.ready_on <= wk)
  const due = dueWithin(d, c, 6)
  const late = due.filter(o => o.deliver_on! < now)
  const toCut = d.orders.filter(o => c.isOpen(o) && o.status !== 'planned' && o.cut_on && o.cut_on <= wk && (c.short.get(o.id) ?? 0) > 0)
    .sort((a, b) => a.cut_on!.localeCompare(b.cut_on!))
  const next = d.orders.filter(o => c.isOpen(o)).slice(0, 12)
  const strains = [...c.byStrain.entries()].filter(([, v]) => v.owed || v.ready || v.rooting).sort((a, b) => b[1].owed - a[1].owed).slice(0, 10)
  const name = (k: string) => d.batches.find(b => strainKey(b.strain) === k)?.strain ?? d.orders.find(o => strainKey(o.strain) === k)?.strain ?? d.mothers.find(m => strainKey(m.strain) === k)?.strain ?? k
  const mBy = new Map<string, number>()
  for (const m of mothers) mBy.set(m.strain, (mBy.get(m.strain) ?? 0) + live(m))
  return (
    <div className="dash">
      <DashHead title={t('Dashboard')} sub={`${t('Nursery')} · ${d.sites.map(s => s.name).join(', ')} · ${new Date().toLocaleDateString(lang() === 'es' ? 'es-MX' : undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`} />
      <Tiles>
        <Tile label={t('Deliveries this week')} value={n0(sum(due.map(o => c.owed(o))))} sub={due.length ? `${t('plants')} · ${tn(due.length, '{n} order', '{n} orders')}${late.length ? `, ${t('{n} late', { n: late.length })}` : ''}` : t('nothing due')} tone={late.length ? 'bad' : due.length ? 'info' : 'ok'} onClick={() => go('orders')} />
        <Tile label={t('Ready to go')} value={n0(sum(ready.map(c.left)))} sub={ready.length ? `${t('plants in')} ${tn(ready.length, '{n} batch', '{n} batches')}` : t('no batches ready')} tone={ready.length ? 'ok' : undefined} onClick={() => go('batches')} />
        <Tile label={t('Rooting')} value={n0(sum(rooting.map(c.left)))} sub={rooting.length ? `${tn(rooting.length, '{n} batch', '{n} batches')}${readySoon.length ? ` · ${t('{n} ready by {date}', { n: readySoon.length, date: fmtD(wk, true) })}` : ''}` : t('nothing rooting')} onClick={() => go('batches')} />
        <Tile label={t('To cut this week')} value={toCut.length} sub={toCut.length ? t('first by {date}', { date: fmtD(toCut[0].cut_on, true) }) : t('all orders covered')} tone={toCut.some(o => o.cut_on! < now) ? 'bad' : toCut.length ? 'warn' : 'ok'} onClick={() => go('orders')} />
        <Tile label={t('Mother plants')} value={n0(sum(mothers.map(live)))} sub={`${[1, 2, 3].filter(gN).map(g => `${GEN_LABEL[g]} ${n0(gN(g))}`).join(' · ') || t('none yet')} · ${t('{n} strains', { n: mStrains.size })}`} onClick={() => go('mothers')} />
      </Tiles>
      <Cards>
        <Card title={t('Next deliveries')} action={t('Orders')} onAction={() => go('orders')} wide>
          {next.length ? <div className="cwrap"><table className="ctable">
            <thead><tr><th>{t('Deliver')}</th><th>{t('Strain')}</th><th>{t('To')}</th><th className="num">{t('Owed')}</th><th className="num">{t('Ready now')}</th><th>{t('Status')}</th></tr></thead>
            <tbody>{next.map(o => { const s = c.byStrain.get(strainKey(o.strain)); return (
              <tr key={o.id} className="tap" onClick={() => onOrder(o)}><td className="nowrap">{fmtD(o.deliver_on, true) || '—'}</td><td>{o.strain}</td><td>{c.to(o)}</td>
                <td className="num">{n0(c.owed(o))}</td><td className="num">{s?.ready ? n0(s.ready) : <span className="muted">0</span>}</td><td>{statusPill(o, c)}</td></tr>) })}</tbody>
          </table></div> : <Empty>{t('No open orders. Production\'s nursery deliveries show up here when it plans them.')}</Empty>}
        </Card>
        <Card title={t('Cuttings to take')} badge={toCut.length} action={t('Batches')} onAction={() => go('batches')}>
          {toCut.length ? <div className="dlist">{toCut.slice(0, 8).map(o => (
            <button key={o.id} className="drow click" onClick={() => onBatch({ strain: o.strain, order_id: o.id, cuttings: c.short.get(o.id) })}>
              <span><b>{o.strain}</b><span className="muted"> · {t('{n} more for {to}', { n: n0(c.short.get(o.id)), to: c.to(o) })}</span></span>
              <span className={`pill ${o.cut_on! < now ? 'badp' : 'warnp'}`}>{t('cut by {date}', { date: fmtD(o.cut_on, true) })}</span></button>))}</div> : <Empty>{t('No cuttings due in the next week.')}</Empty>}
        </Card>
        <Card title={t('Ready vs owed, by strain')}>
          {strains.length ? <div className="dlist">{strains.map(([k, v]) => (
            <Meter key={k} label={<><b>{name(k)}</b> <span className="muted">{n0(v.rooting)} {t('rooting')}</span></>} right={<>{n0(v.ready)} {t('ready')} / {n0(v.owed)} {t('owed')}</>}
              value={v.ready} max={Math.max(v.owed, v.ready, 1)} tone={v.ready >= v.owed ? 'ok' : v.ready + v.rooting >= v.owed ? 'warn' : 'bad'} />))}</div> : <Empty>{t('Nothing owed or rooting.')}</Empty>}
        </Card>
        <Card title={t('Mothers')} action={t('Mothers')} onAction={() => go('mothers')}>
          {mBy.size ? <div className="dlist">{[...mBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, n]) => <div key={s} className="drow"><span>{s}</span><b>{n}</b></div>)}
            {mBy.size > 10 && <div className="muted small-note">{t('+{n} more strains', { n: mBy.size - 10 })}</div>}</div> : <Empty>{t('No mother plants entered yet.')}</Empty>}
        </Card>
      </Cards>
    </div>
  )
}

/** Nursery > Review: things that need someone */
function NurseryReview({ d, c, onOrder, onBatch, onMother, go }: { d: NData; c: NCtx; onOrder: (o: NOrder) => void; onBatch: (b: Batch) => void; onMother: (m: Mother) => void; go: (t: NTab) => void }) {
  const now = today()
  const late = d.orders.filter(o => c.isOpen(o) && o.deliver_on && o.deliver_on < now)
  const unconfirmed = d.orders.filter(o => (o.status === 'planned' || o.status === 'ordered') && c.isOpen(o) && o.deliver_on && o.deliver_on <= addDays(now, 21))
  const shortStrains = dueWithin(d, c, 14).filter(o => o.status !== 'planned' && (c.short.get(o.id) ?? 0) > 0)
  const stuck = d.batches.filter(b => b.stage === 'rooting' && b.ready_on && b.ready_on < now)
  const stale = d.batches.filter(b => b.stage === 'ready' && c.left(b) > 0 && b.ready_on && b.ready_on < addDays(now, -d.settings.readyWarn))
  const noTags = d.batches.filter(b => (b.stage === 'rooting' || b.stage === 'ready') && !b.tags.length)
  const motherNoTag = d.mothers.filter(m => m.status === 'active' && live(m) > 0 && !m.plant_tag)
  const noManifest = [...new Map(d.deliveries.filter(x => !x.manifest).map(x => [x.ref, x])).values()]
  const yr = now.slice(0, 4), plan = [...planSeason(d, c, Number(yr)), ...planSeason(d, c, Number(yr) + 1)]
  const behind = plan.flatMap(r => ([['G3', r.g3], ['G2', r.g2], ['G1', r.g1]] as const).filter(([, g]) => g.cutBy && g.cutBy <= addDays(now, 14) && g.need > g.have + g.rooting)
    .map(([n, g]) => ({ r, n, g })))
  const positives = d.tests.filter(t => t.result === 'positive' && !t.culled)
  const total = behind.length + positives.length + late.length + unconfirmed.length + shortStrains.length + stuck.length + stale.length + noTags.length + motherNoTag.length + noManifest.length
  const oRow = (o: NOrder, tag: string, bad = true) => <button key={o.id} className="drow click" onClick={() => onOrder(o)}>
    <span><b>{o.strain}</b><span className="muted"> · {t('{n} for {to}', { n: n0(c.owed(o)), to: c.to(o) })}</span></span><span className={`pill ${bad ? 'badp' : 'warnp'}`}>{tag}</span></button>
  const bRow = (b: Batch, tag: string) => <button key={b.id} className="drow click" onClick={() => onBatch(b)}>
    <span><b>{b.strain}</b><span className="muted"> · {b.name ?? `#${b.id}`} · {t('{n} plants', { n: n0(c.left(b)) })} · {t(STAGE_LABEL[b.stage])}</span></span><span className="pill warnp">{tag}</span></button>
  const sec = (title: string, n: number, note: string, body: React.ReactNode, action?: [string, NTab]) => n > 0 && (
    <section className="dcard"><div className="dcard-h"><h3>{t(title)} <span className="side-badge">{n}</span></h3>{action && <button className="linkbtn" onClick={() => go(action[1])}>{t(action[0])} ›</button>}</div>
      <p className="muted">{t(note, { n: d.settings.readyWarn })}</p><div className="dlist">{body}</div></section>)
  return (
    <div className="dash">
      {total === 0 && <p className="muted">{t('Nothing needs attention in the nursery.')}</p>}
      {sec('Moms to cut soon', behind.length, 'From the Plan: a generation is short and its cut-by date is within two weeks (or passed).', behind.map(({ r, n, g }) => (
        <button key={r.strain + n} className="drow click" onClick={() => go('plan')}><span><b>{r.strain}</b><span className="muted"> · {t('{gen} need {need}, have {have} · cut {cut}', { gen: n, need: n0(g.need), have: n0(g.have + g.rooting), cut: n0(g.cut) })}</span></span>
          <span className={`pill ${g.cutBy! < now ? 'badp' : 'warnp'}`}>{t('cut by {date}', { date: fmtD(g.cutBy, true) })}</span></button>)), ['Plan', 'plan'])}
      {sec('Positive lab tests', positives.length, 'Positive and nothing culled yet.', positives.map(x => <button key={x.id} className="drow click" onClick={() => go('logs')}>
        <span><b>{x.strain}</b><span className="muted"> · {x.test} {t('round')} {x.round} · {fmtD(x.tested_on)}</span></span><span className="pill badp">{t('positive')}</span></button>), ['Logs', 'logs'])}
      {sec('Late deliveries', late.length, 'The delivery date has passed and plants are still owed.', late.map(o => oRow(o, fmtD(o.deliver_on, true))))}
      {sec('Short for upcoming deliveries', shortStrains.length, 'Ready plus rooting isn\'t enough for what\'s owed in the next two weeks. Take more cuttings.',
        shortStrains.map(o => oRow(o, `${t('{n} short', { n: n0(c.short.get(o.id)) })} · ${fmtD(o.deliver_on, true)}`)))}
      {sec('Not confirmed yet', unconfirmed.length, 'Production planned these but they aren\'t confirmed. Confirm them to give them an SO number.', unconfirmed.map(o => oRow(o, fmtD(o.deliver_on, true), false)))}
      {sec('Past their ready date', stuck.length, 'Still rooting after the ready-by date. Mark them ready, or record losses.', stuck.map(b => bRow(b, t('ready by {date}', { date: fmtD(b.ready_on, true) }))))}
      {sec('Ready for a while', stale.length, 'Ready more than {n} days and not delivered.', stale.map(b => bRow(b, `${t('ready')} ${fmtD(b.ready_on, true)}`)))}
      {sec('Batches with no METRC tag', noTags.length, 'Every immature plant batch needs a tag (one per 100 plants).', noTags.map(b => bRow(b, t('no tag'))))}
      {sec('Mother lots with no METRC tag', motherNoTag.length, 'Each mother lot needs its plant tag.', motherNoTag.slice(0, 30).map(m => <button key={m.id} className="drow click" onClick={() => onMother(m)}>
        <span><b>{m.strain}</b><span className="muted"> · {GEN_LABEL[m.gen]} · {t('{n} plants', { n: n0(live(m)) })} · {t('planted')} {fmtD(m.started_on)}</span></span><span className="pill warnp">{t('no tag')}</span></button>), ['Mothers', 'mothers'])}
      {sec('Deliveries with no manifest', noManifest.length, 'Plants left the nursery without a METRC manifest number on record.', noManifest.slice(0, 30).map(x => {
        const o = d.orders.find(v => v.id === x.order_id)
        return o ? oRow(o, fmtD(x.delivered_on, true), false) : null
      }))}
    </div>
  )
}

const ACT: Record<string, string> = {
  nursery_order_new: 'New clone order', nursery_order_edit: 'Order changed', nursery_order_confirmed: 'Order confirmed', nursery_order_cancelled: 'Order cancelled', nursery_order_ordered: 'Order marked ordered',
  nursery_order_received: 'Order marked delivered', nursery_delivered: 'Delivered', nursery_delivery_undone: 'Delivery taken back',
  nursery_batches_insert: 'Cuttings taken', nursery_batches_update: 'Batch changed', nursery_batches_delete: 'Batch deleted',
  nursery_mothers_insert: 'Mother added', nursery_mothers_update: 'Mother changed', nursery_mothers_delete: 'Mother removed',
  nursery_setting: 'Setting changed', nursery_invoice_paid: 'Invoice paid', nursery_invoice_open: 'Invoice marked not paid', nursery_invoice_void: 'Invoice voided', nursery_invoice_sent: 'Invoice emailed',
}
function NurseryActivity({ api }: { api: NurseryApi }) {
  const [rows, setRows] = useState<Awaited<ReturnType<NurseryApi['activity']>> | null>(null)
  useEffect(() => { api.activity().then(setRows).catch(() => setRows([])) }, [api])
  if (!rows) return <p className="muted">{t('Loading…')}</p>
  if (!rows.length) return <p className="muted">{t('Nothing yet. Everything done in the Nursery shows up here.')}</p>
  const what = (r: NonNullable<typeof rows>[number]) => {
    const x = r.details ?? {}, row = (x.row ?? {}) as Record<string, unknown>
    const bits = [ACT[r.type] ? t(ACT[r.type]) : r.type.replace(/_/g, ' '), r.note]
    if (r.type === 'nursery_delivered') bits.push(`${t('{n} plants', { n: String(x.plants) })} → ${x.site ?? x.customer ?? ''}${x.invoice ? ` · ${x.invoice}` : ''}`)
    if (r.type === 'nursery_batches_insert') bits.push(t('{n} cuttings', { n: String(row.cuttings) }))
    if (r.type === 'nursery_order_new') bits.push(`${t('{n} plants', { n: String(x.plants) })}${x.so ? ` · ${x.so}` : ''}`)
    if (r.type === 'nursery_mothers_insert' && row.plant_tag) bits.push(String(row.plant_tag).slice(-8))
    if (r.type.startsWith('nursery_invoice')) bits.push(String(x.inv ?? ''))
    return bits.filter(Boolean).join(' · ')
  }
  return <div className="list">{rows.map(r => <div key={r.id} className="li static"><div>{what(r)}</div>
    <div className="muted">{new Date(r.at).toLocaleString(lang() === 'es' ? 'es-MX' : [], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {(r.user_email ?? '').split('@')[0]}</div></div>)}</div>
}
