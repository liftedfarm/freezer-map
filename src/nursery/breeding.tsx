import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NCtx } from './calc'
import { GEN_LABEL, fmtD, live, n0, strainKey, sum, today } from './calc'
import type { NData } from './types'
import { DateIn, F, NumIn, Pick, SaveBar, Sheet, StrainList, TextIn } from '../cult/ui'
import type { Flash } from '../cult/ui'
import { t, tn } from '../i18n'

// Breeding: pollination runs (one donor x many receivers per trailer), seed lots, pheno hunts with group scoring, keepers.
interface Run {
  id: number; site: string; season: number; name: string; room_id: number | null; donor_strain: string; donor_mother_id: number | null; donor_room_id: number | null
  donor_plants: number | null; donors_cut_on: string | null; donors_flip_on: string | null; receivers_cut_on: string | null; receivers_planted_on: string | null
  flip_on: string | null; pollinated_on: string | null; harvested_on: string | null; status: string; notes: string | null
}
interface Receiver { id?: number; run_id?: number; strain: string; mother_id: number | null; plants: number; plant_tag: string | null; notes: string | null; _del?: boolean }
interface SeedLot {
  id: number; code: string | null; mother_strain: string | null; father_strain: string | null; run_id: number | null; receiver_id: number | null; source: string; breeder: string | null
  harvested_on: string | null; seeds: number | null; germ_pct: number | null; notes: string | null
}
interface Hunt { id: number; site: string; season: number; name: string; seed_lot_id: number | null; sown_on: string | null; seeds_sown: number | null; germinated: number | null; room_id: number | null; status: string; notes: string | null }
interface Pheno { id: number; hunt_id: number; number: number; label: string | null; plant_tag: string | null; room_id: number | null; bed: string | null; status: string; keeper_strain: string | null; notes: string | null }
interface Score { id: number; pheno_id: number; scorer: string; scored_on: string; vigor: number | null; structure: number | null; aroma: number | null; color: number | null; tackiness: number | null; jar: number | null; notes: string | null }
interface BData { runs: Run[]; receivers: Receiver[]; seeds: SeedLot[]; hunts: Hunt[]; phenos: Pheno[]; scores: Score[] }

const TRAITS = [['vigor', 'Vigor'], ['structure', 'Structure'], ['aroma', 'Aroma'], ['color', 'Color'], ['tackiness', 'Tackiness'], ['jar', 'Jar test']] as const
type Trait = typeof TRAITS[number][0]
const RUN_STATUS = ['planned', 'growing', 'flowering', 'pollinated', 'harvested', 'done', 'cancelled']
const PSTATUS: Record<string, string> = { growing: 'Growing', maybe: 'Maybe', keeper: 'Keeper', culled: 'Culled', male: 'Male' }
const who = (e: string) => e.split('@')[0]
const cap = (s: string) => t(s[0].toUpperCase() + s.slice(1))
const cross = (s: SeedLot) => [s.mother_strain, s.father_strain].filter(Boolean).join(' x ') || s.code || `Lot ${s.id}`
const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const f1 = (x: number | null) => (x == null ? '' : x.toFixed(1))

export function BreedingTab({ sb, d, c, flash, me }: { sb: SupabaseClient; d: NData; c: NCtx; flash: Flash; me: string }) {
  const [tab, setTab] = useState<'runs' | 'seeds' | 'hunts'>('runs')
  const [b, setB] = useState<BData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [run, setRun] = useState<Partial<Run> | null>(null)
  const [lot, setLot] = useState<Partial<SeedLot> | null>(null)
  const [hunt, setHunt] = useState<Partial<Hunt> | null>(null)
  const [huntView, setHuntView] = useState<number | null>(null)
  const load = useCallback(async () => {
    const r = await Promise.all(['breed_runs', 'breed_receivers', 'seed_lots', 'pheno_hunts', 'phenos', 'pheno_scores'].map(t => sb.from(t).select('*').order('id').limit(10000)))
    const bad = r.find(x => x.error)
    if (bad?.error) { setErr(/breed_|seed_lots|pheno/.test(bad.error.message) ? t('Breeding needs 034_breeding.sql run in Supabase.') : bad.error.message); return }
    const [runs, receivers, seeds, hunts, phenos, scores] = r.map(x => x.data ?? [])
    setB({ runs: runs as Run[], receivers: receivers as Receiver[], seeds: seeds as SeedLot[], hunts: hunts as Hunt[], phenos: phenos as Pheno[], scores: scores as Score[] }); setErr(null)
  }, [sb])
  useEffect(() => { load() }, [load])
  const saved = async (m: string) => { await load(); flash(t(m)) }
  if (err) return <div className="warnbox">{err}</div>
  if (!b) return <p className="muted">{t('Loading…')}</p>
  if (huntView != null) { const h = b.hunts.find(x => x.id === huntView); if (h) return <HuntView sb={sb} d={d} c={c} b={b} h={h} me={me} flash={flash} onBack={() => setHuntView(null)} onSaved={saved} onEdit={() => setHunt(h)} /> }
  const sown = (id: number) => sum(b.hunts.filter(h => h.seed_lot_id === id).map(h => h.seeds_sown ?? 0))
  return <>
    <div className="row toolbar between">
      <div className="seg">{([['runs', 'Pollination runs'], ['seeds', 'Seed lots'], ['hunts', 'Pheno hunts']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(l)}</button>)}</div>
      {tab === 'runs' && <button className="primary" onClick={() => setRun({ season: new Date().getFullYear(), status: 'planned', room_id: d.rooms.find(r => r.name === 'Trailer 1')?.id ?? null, donor_room_id: d.rooms.find(r => r.name === 'Trailer 3')?.id ?? null })}>{t('+ Pollination run')}</button>}
      {tab === 'seeds' && <button className="primary" onClick={() => setLot({ source: 'breeder' })}>{t('+ Seed lot')}</button>}
      {tab === 'hunts' && <button className="primary" onClick={() => setHunt({ season: new Date().getFullYear(), status: 'sown', sown_on: today() })}>{t('+ Pheno hunt')}</button>}
    </div>
    {tab === 'runs' && <>
      <p className="muted small-note">{t('One run = one trailer: one donor (pollen) variety and as many receiver varieties as you put in. Donors start and flower separately (Trailer 3).')}</p>
      {!b.runs.length ? <p className="muted">{t('No pollination runs yet.')}</p> : <div className="cwrap"><table className="ctable">
        <thead><tr><th>{t('Season')}</th><th>{t('Run')}</th><th>{t('Trailer')}</th><th>{t('Donor')}</th><th className="num">{t('Receivers')}</th><th className="num">{t('Plants')}</th><th>{t('Flipped')}</th><th>{t('Pollinated')}</th><th>{t('Seeds harvested')}</th><th className="num">{t('Seeds')}</th><th>{t('Status')}</th></tr></thead>
        <tbody>{[...b.runs].sort((x, y) => y.season - x.season || y.id - x.id).map(r => { const rs = b.receivers.filter(z => z.run_id === r.id); const sl = b.seeds.filter(s => s.run_id === r.id)
          return <tr key={r.id} className={`tap ${r.status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => setRun(r)}><td>{r.season}</td><td><b>{r.name}</b></td><td>{c.room(r.room_id)}</td><td>{r.donor_strain}</td>
            <td className="num">{rs.length}</td><td className="num">{n0(sum(rs.map(z => z.plants)))}</td><td className="nowrap">{fmtD(r.flip_on)}</td><td className="nowrap">{fmtD(r.pollinated_on)}</td>
            <td className="nowrap">{fmtD(r.harvested_on)}</td><td className="num">{sl.length ? n0(sum(sl.map(s => s.seeds ?? 0))) : ''}</td><td><span className="pill">{cap(r.status)}</span></td></tr> })}</tbody>
      </table></div>}
    </>}
    {tab === 'seeds' && (!b.seeds.length ? <p className="muted">{t('No seed lots yet. They come from harvesting a run\'s receivers, or add bought or traded seeds.')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>{t('Code')}</th><th>{t('Cross (seed parent x pollen)')}</th><th>{t('Source')}</th><th>{t('Harvested')}</th><th className="num">{t('Seeds')}</th><th className="num">{t('Sown')}</th><th className="num">{t('Left')}</th><th className="num">{t('Germ %')}</th><th /></tr></thead>
      <tbody>{[...b.seeds].sort((x, y) => (y.harvested_on ?? '').localeCompare(x.harvested_on ?? '') || y.id - x.id).map(s => (
        <tr key={s.id} className="tap" onClick={() => setLot(s)}><td><b>{s.code}</b></td><td>{cross(s)}</td><td>{s.source === 'in-house' ? (b.runs.find(r => r.id === s.run_id)?.name ?? t('In house')) : s.breeder ?? cap(s.source)}</td>
          <td className="nowrap">{fmtD(s.harvested_on)}</td><td className="num">{n0(s.seeds)}</td><td className="num">{n0(sown(s.id)) || ''}</td><td className="num">{s.seeds != null ? n0(s.seeds - sown(s.id)) : ''}</td>
          <td className="num">{s.germ_pct != null ? `${s.germ_pct}%` : ''}</td>
          <td><button className="ghost small" onClick={e => { e.stopPropagation(); setHunt({ season: new Date().getFullYear(), status: 'sown', sown_on: today(), seed_lot_id: s.id, name: `${s.code ?? cross(s)} hunt` }) }}>{t('Hunt…')}</button></td></tr>))}</tbody>
    </table></div>)}
    {tab === 'hunts' && (!b.hunts.length ? <p className="muted">{t('No pheno hunts yet. Start one from a seed lot.')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>{t('Season')}</th><th>{t('Hunt')}</th><th>{t('Cross')}</th><th>{t('Sown')}</th><th className="num">{t('Seeds')}</th><th className="num">{t('Up')}</th><th className="num">{t('Phenos')}</th><th className="num">{t('Scored')}</th><th className="num">{t('Keepers')}</th><th>{t('Status')}</th></tr></thead>
      <tbody>{[...b.hunts].sort((x, y) => y.season - x.season || y.id - x.id).map(h => { const ps = b.phenos.filter(p => p.hunt_id === h.id); const s = b.seeds.find(z => z.id === h.seed_lot_id)
        return <tr key={h.id} className="tap" onClick={() => setHuntView(h.id)}><td>{h.season}</td><td><b>{h.name}</b></td><td>{s ? cross(s) : ''}</td><td className="nowrap">{fmtD(h.sown_on)}</td>
          <td className="num">{n0(h.seeds_sown)}</td><td className="num">{n0(h.germinated)}</td><td className="num">{ps.length}</td>
          <td className="num">{ps.filter(p => b.scores.some(z => z.pheno_id === p.id)).length}</td><td className="num">{ps.filter(p => p.status === 'keeper').length || ''}</td><td><span className="pill">{cap(h.status)}</span></td></tr> })}</tbody>
    </table></div>)}
    {run && <RunSheet sb={sb} d={d} c={c} b={b} r0={run} flash={flash} onClose={() => setRun(null)} onSaved={saved} />}
    {lot && <SeedSheet sb={sb} d={d} s0={lot} flash={flash} onClose={() => setLot(null)} onSaved={saved} />}
    {hunt && <HuntSheet sb={sb} d={d} b={b} h0={hunt} flash={flash} onClose={() => setHunt(null)} onSaved={async (m, id) => { await saved(m); if (id) setHuntView(id) }} />}
  </>
}

function RunSheet({ sb, d, c, b, r0, flash, onClose, onSaved }: { sb: SupabaseClient; d: NData; c: NCtx; b: BData; r0: Partial<Run>; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState<Partial<Run>>(r0)
  const [recs, setRecs] = useState<Receiver[]>(() => b.receivers.filter(z => z.run_id === r0.id))
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState(false)
  const set = (v: Partial<Run>) => setX(s => ({ ...s, ...v }))
  const trailers = d.rooms.filter(r => r.kind === 'trailer' && (r.active || r.id === x.room_id || r.id === x.donor_room_id))
  const donorLots = d.mothers.filter(m => m.status === 'active' && x.donor_strain && strainKey(m.strain) === strainKey(x.donor_strain))
  const seedsFor = (id?: number) => b.seeds.find(s => s.receiver_id === id)
  const shown = recs.filter(z => !z._del)
  async function save() {
    setBusy(true)
    try {
      const row = { site: d.sites[0]?.code ?? '1PN', season: x.season, name: x.name!.trim(), room_id: x.room_id ?? null, donor_strain: x.donor_strain!.trim(), donor_mother_id: x.donor_mother_id ?? null,
        donor_room_id: x.donor_room_id ?? null, donor_plants: x.donor_plants ?? null, donors_cut_on: x.donors_cut_on ?? null, donors_flip_on: x.donors_flip_on ?? null,
        receivers_cut_on: x.receivers_cut_on ?? null, receivers_planted_on: x.receivers_planted_on ?? null, flip_on: x.flip_on ?? null, pollinated_on: x.pollinated_on ?? null,
        harvested_on: x.harvested_on ?? null, status: x.status ?? 'planned', notes: x.notes ?? null }
      let id = x.id
      if (id) { const { error } = await sb.from('breed_runs').update(row).eq('id', id); if (error) throw error }
      else { const { data, error } = await sb.from('breed_runs').insert(row).select('id').single(); if (error) throw error; id = data.id }
      const del = recs.filter(z => z._del && z.id).map(z => z.id!)
      if (del.length) { const { error } = await sb.from('breed_receivers').delete().in('id', del); if (error) throw error }
      for (const z of recs.filter(z => !z._del)) {
        const v = { run_id: id, strain: z.strain, mother_id: z.mother_id, plants: z.plants, plant_tag: z.plant_tag || null, notes: z.notes || null }
        const { error } = z.id ? await sb.from('breed_receivers').update(v).eq('id', z.id) : await sb.from('breed_receivers').insert(v)
        if (error) throw error
      }
      onClose(); await onSaved(x.id ? 'Run saved' : t('{name} added with {n} receivers', { name: x.name, n: shown.length }))
    } catch (e) { flash(String((e as { message?: string }).message ?? e), true) } finally { setBusy(false) }
  }
  async function harvest(z: Receiver) {
    const s = prompt(t('Seeds harvested from {a} x {b}?', { a: z.strain, b: x.donor_strain })); if (s == null) return
    const n = Number(s.replace(/,/g, '')); if (!isFinite(n) || n < 0) { flash(t('Enter a number'), true); return }
    const code = prompt(t('Short code for this cross (e.g. HBxP)'), `${initials(z.strain)}x${initials(x.donor_strain ?? '')}`) ?? undefined
    const { error } = await sb.from('seed_lots').insert({ code: code || null, mother_strain: z.strain, father_strain: x.donor_strain, run_id: x.id, receiver_id: z.id, source: 'in-house', harvested_on: x.harvested_on ?? today(), seeds: n })
    if (error) flash(error.message, true); else await onSaved(`${t('{n} seeds', { n: n0(n) })}: ${z.strain} x ${x.donor_strain}`)
  }
  return (
    <Sheet title={x.id ? x.name ?? t('Run') : t('New pollination run')} sub={x.id ? `${x.season} · ${t('{n} receivers', { n: shown.length })} · ${t('{n} plants', { n: n0(sum(shown.map(z => z.plants))) })}` : t('One trailer: one donor, many receivers')} onClose={onClose} wide>
      <div className="grid3">
        <F label={t('Name')}><TextIn value={x.name} onChange={v => set({ name: v ?? '' })} placeholder={t('2026 Honey Banana run')} autoFocus={!x.id} /></F>
        <F label={t('Season')}><NumIn value={x.season} onChange={v => set({ season: v ?? new Date().getFullYear() })} /></F>
        <F label={t('Status')}><Pick value={x.status} options={RUN_STATUS.map(s => ({ v: s, l: cap(s) }))} onChange={v => set({ status: v ?? 'planned' })} /></F>
        <F label={t('Receivers flower in')}><Pick value={x.room_id} blank="—" options={trailers.map(r => ({ v: r.id, l: r.name }))} onChange={v => set({ room_id: v })} /></F>
        <F label={t('Donor (pollen) variety')}><TextIn value={x.donor_strain} list="n-strains" onChange={v => set({ donor_strain: v ?? '', donor_mother_id: null })} /></F>
        <F label={t('Donor lot')}><Pick value={x.donor_mother_id} blank="—" options={donorLots.map(m => ({ v: m.id, l: `${GEN_LABEL[m.gen]} · ${c.room(m.room_id)} · ${live(m)}` }))} onChange={v => set({ donor_mother_id: v })} /></F>
        <F label={t('Donors start / flower in')}><Pick value={x.donor_room_id} blank="—" options={d.rooms.filter(r => r.active || r.id === x.donor_room_id).map(r => ({ v: r.id, l: r.name }))} onChange={v => set({ donor_room_id: v })} /></F>
        <F label={t('Donor plants')}><NumIn value={x.donor_plants} onChange={v => set({ donor_plants: v })} /></F>
      </div>
      <StrainList id="n-strains" names={[...new Set([...d.mothers.filter(m => m.status === 'active').map(m => m.strain), ...d.strains])]} />
      <h3>{t('Dates')}</h3>
      <div className="grid3">
        <F label={t('Donors cut')}><DateIn value={x.donors_cut_on} onChange={v => set({ donors_cut_on: v })} /></F>
        <F label={t('Donors flipped')}><DateIn value={x.donors_flip_on} onChange={v => set({ donors_flip_on: v })} /></F>
        <F label={t('Receivers cut')}><DateIn value={x.receivers_cut_on} onChange={v => set({ receivers_cut_on: v })} /></F>
        <F label={t('Receivers planted')}><DateIn value={x.receivers_planted_on} onChange={v => set({ receivers_planted_on: v })} /></F>
        <F label={t('Receivers flipped')}><DateIn value={x.flip_on} onChange={v => set({ flip_on: v })} /></F>
        <F label={t('Pollinated (donors in)')}><DateIn value={x.pollinated_on} onChange={v => set({ pollinated_on: v })} /></F>
        <F label={t('Seeds harvested')}><DateIn value={x.harvested_on} onChange={v => set({ harvested_on: v })} /></F>
      </div>
      <h3 className="row between"><span>{t('Receivers')} <span className="muted small">{shown.length} varieties · {n0(sum(shown.map(z => z.plants)))} plants</span></span><button className="ghost small" onClick={() => setPick(true)}>{t('+ Add receivers…')}</button></h3>
      {shown.length > 0 && <div className="cwrap tight"><table className="ctable">
        <thead><tr><th>{t('Receiver')}</th><th>{t('Lot')}</th><th className="num">{t('Plants')}</th><th>{t('Tag')}</th><th className="num">{t('Seeds')}</th><th /></tr></thead>
        <tbody>{recs.map((z, i) => z._del ? null : <tr key={z.id ?? `n${i}`}><td>{z.strain}</td>
          <td className="small">{z.mother_id ? (() => { const m = d.mothers.find(q => q.id === z.mother_id); return m ? `${GEN_LABEL[m.gen]} ${c.room(m.room_id)}` : '' })() : ''}</td>
          <td className="num"><input className="qty" type="number" value={z.plants} onChange={e => setRecs(rs => rs.map((q, j) => j === i ? { ...q, plants: Number(e.target.value) || 0 } : q))} /></td>
          <td><input className="tagin" value={z.plant_tag ?? ''} onChange={e => setRecs(rs => rs.map((q, j) => j === i ? { ...q, plant_tag: e.target.value.toUpperCase() } : q))} placeholder={t('METRC tag')} /></td>
          <td className="num">{seedsFor(z.id) ? n0(seedsFor(z.id)!.seeds) : z.id && x.id ? <button className="ghost small" onClick={() => harvest(z)}>{t('Seeds…')}</button> : ''}</td>
          <td>{!seedsFor(z.id) && <button className="ghost small" onClick={() => setRecs(rs => rs.map((q, j) => j === i ? { ...q, _del: true } : q))}>✕</button>}</td></tr>)}</tbody>
      </table></div>}
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      <SaveBar busy={busy} disabled={!x.name?.trim() || !x.donor_strain?.trim()} saveLabel={x.id ? 'Save' : 'Add run'} onCancel={onClose} onSave={save}
        onDelete={x.id && !b.seeds.some(s => s.run_id === x.id) ? async () => { const { error } = await sb.from('breed_runs').delete().eq('id', x.id!); if (error) flash(error.message, true); else { onClose(); await onSaved('Run deleted') } } : undefined} />
      {pick && <ReceiverPicker d={d} c={c} have={new Set(shown.map(z => strainKey(z.strain)))} onClose={() => setPick(false)}
        onAdd={(list, plants) => { setRecs(rs => [...rs, ...list.map(l => ({ strain: l.strain, mother_id: l.mother_id, plants, plant_tag: null, notes: null }))]); setPick(false) }} />}
    </Sheet>
  )
}
const initials = (s: string) => s.split(/[\s#]+/).filter(w => /^[A-Za-z]/.test(w)).map(w => w[0].toUpperCase()).join('').slice(0, 4)

/** pick many receiver varieties at once (from the mother lots, or any strain) */
function ReceiverPicker({ d, c, have, onClose, onAdd }: { d: NData; c: NCtx; have: Set<string>; onClose: () => void; onAdd: (l: { strain: string; mother_id: number | null }[], plants: number) => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Map<string, number | null>>(new Map())
  const [plants, setPlants] = useState<number | null>(4)
  const [extra, setExtra] = useState('')
  const lots = useMemo(() => {
    const m = new Map<string, { strain: string; mother_id: number; label: string }>()
    for (const x of d.mothers.filter(z => z.status === 'active' && live(z) > 0).sort((a, b) => b.gen - a.gen)) {
      const k = strainKey(x.strain); if (!m.has(k)) m.set(k, { strain: x.strain, mother_id: x.id, label: `${GEN_LABEL[x.gen]} · ${c.room(x.room_id)} · ${live(x)}` })
    }
    return [...m.values()].sort((a, b) => a.strain.localeCompare(b.strain))
  }, [d, c])
  const ql = q.trim().toLowerCase()
  const list = lots.filter(l => !have.has(strainKey(l.strain)) && (!ql || l.strain.toLowerCase().includes(ql)))
  const toggle = (l: { strain: string; mother_id: number }) => setSel(s => { const x = new Map(s); if (x.has(l.strain)) x.delete(l.strain); else x.set(l.strain, l.mother_id); return x })
  return (
    <div className="scrim" onClick={onClose}><div className="sheet form csheet" onClick={e => e.stopPropagation()}>
      <div className="sheet-h"><div><h2>{t('Add receivers')}</h2><div className="muted">{sel.size} picked</div></div><button className="ghost" onClick={onClose}>✕</button></div>
      <div className="row"><input className="search" type="search" placeholder={t('Search strains')} value={q} onChange={e => setQ(e.target.value)} autoFocus />
        <button className="ghost small" onClick={() => setSel(s => { const x = new Map(s); for (const l of list) x.set(l.strain, l.mother_id); return x })}>{t('All shown')}</button></div>
      <div className="pickgrid">{list.map(l => <label key={l.strain} className={`check pick ${sel.has(l.strain) ? 'on' : ''}`}><input type="checkbox" checked={sel.has(l.strain)} onChange={() => toggle(l)} />
        <span>{l.strain}<span className="muted small"> · {l.label}</span></span></label>)}</div>
      <div className="grid2">
        <F label={t('Not in the mother lots')} hint={t('(comma separated)')}><input value={extra} onChange={e => setExtra(e.target.value)} placeholder={t('Strain A, Strain B')} /></F>
        <F label={t('Plants of each')}><NumIn value={plants} onChange={setPlants} /></F>
      </div>
      <SaveBar busy={false} disabled={!sel.size && !extra.trim()} saveLabel={t('Add {n}', { n: sel.size + extra.split(',').filter(s => s.trim()).length })} onCancel={onClose}
        onSave={() => onAdd([...[...sel.entries()].map(([strain, mother_id]) => ({ strain, mother_id })), ...extra.split(',').map(s => s.trim()).filter(Boolean).map(strain => ({ strain, mother_id: null }))], plants ?? 1)} />
    </div></div>
  )
}

function SeedSheet({ sb, d, s0, flash, onClose, onSaved }: { sb: SupabaseClient; d: NData; s0: Partial<SeedLot>; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const [x, setX] = useState<Partial<SeedLot>>(s0)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<SeedLot>) => setX(s => ({ ...s, ...v }))
  async function save() {
    setBusy(true)
    const row = { code: x.code || null, mother_strain: x.mother_strain || null, father_strain: x.father_strain || null, source: x.source ?? 'breeder', breeder: x.breeder || null,
      harvested_on: x.harvested_on ?? null, seeds: x.seeds ?? null, germ_pct: x.germ_pct ?? null, notes: x.notes || null }
    const { error } = x.id ? await sb.from('seed_lots').update(row).eq('id', x.id) : await sb.from('seed_lots').insert(row)
    setBusy(false)
    if (error) flash(error.message, true); else { onClose(); await onSaved('Seed lot saved') }
  }
  return (
    <Sheet title={x.id ? `${t('Seed lot')} ${x.code ?? ''}` : t('New seed lot')} sub={t(x.source === 'in-house' ? 'From a pollination run' : 'Bought or traded seeds')} onClose={onClose}>
      <div className="grid2">
        <F label={t('Code')}><TextIn value={x.code} onChange={v => set({ code: v })} placeholder={t('HBxP')} /></F>
        <F label={t('Source')}><Pick value={x.source} options={['in-house', 'breeder', 'trade', 'other'].map(s => ({ v: s, l: cap(s) }))} onChange={v => set({ source: v ?? 'breeder' })} /></F>
        <F label={t('Seed parent (receiver)')}><TextIn value={x.mother_strain} list="n-strains" onChange={v => set({ mother_strain: v })} /></F>
        <F label={t('Pollen parent (donor)')}><TextIn value={x.father_strain} list="n-strains" onChange={v => set({ father_strain: v })} /></F>
        <F label={t('Breeder')}><TextIn value={x.breeder} onChange={v => set({ breeder: v })} placeholder={t('Old Soul Seeds, Bloom Seed Co…')} /></F>
        <F label={t(x.source === 'in-house' ? 'Harvested' : 'Received')}><DateIn value={x.harvested_on} onChange={v => set({ harvested_on: v })} /></F>
        <F label={t('Seeds')}><NumIn value={x.seeds} onChange={v => set({ seeds: v })} /></F>
        <F label={t('Germination %')}><NumIn value={x.germ_pct} onChange={v => set({ germ_pct: v })} /></F>
      </div>
      <StrainList id="n-strains" names={d.strains} />
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      <SaveBar busy={busy} onCancel={onClose} onSave={save}
        onDelete={x.id ? async () => { const { error } = await sb.from('seed_lots').delete().eq('id', x.id!); if (error) flash(error.message, true); else { onClose(); await onSaved('Seed lot deleted') } } : undefined} />
    </Sheet>
  )
}

function HuntSheet({ sb, d, b, h0, flash, onClose, onSaved }: { sb: SupabaseClient; d: NData; b: BData; h0: Partial<Hunt>; flash: Flash; onClose: () => void; onSaved: (m: string, id?: number) => Promise<void> }) {
  const [x, setX] = useState<Partial<Hunt>>(h0)
  const [busy, setBusy] = useState(false)
  const set = (v: Partial<Hunt>) => setX(s => ({ ...s, ...v }))
  async function save() {
    setBusy(true)
    const row = { site: d.sites[0]?.code ?? '1PN', season: x.season, name: x.name!.trim(), seed_lot_id: x.seed_lot_id ?? null, sown_on: x.sown_on ?? null, seeds_sown: x.seeds_sown ?? null,
      germinated: x.germinated ?? null, room_id: x.room_id ?? null, status: x.status ?? 'sown', notes: x.notes || null }
    const r = x.id ? await sb.from('pheno_hunts').update(row).eq('id', x.id).select('id').single() : await sb.from('pheno_hunts').insert(row).select('id').single()
    setBusy(false)
    if (r.error) flash(r.error.message, true); else { onClose(); await onSaved('Hunt saved', x.id ? undefined : r.data.id) }
  }
  return (
    <Sheet title={x.id ? x.name ?? t('Hunt') : t('New pheno hunt')} onClose={onClose}>
      <div className="grid2">
        <F label={t('Name')}><TextIn value={x.name} onChange={v => set({ name: v ?? '' })} autoFocus={!x.id} placeholder={t('2026 HBxP hunt')} /></F>
        <F label={t('Season')}><NumIn value={x.season} onChange={v => set({ season: v ?? new Date().getFullYear() })} /></F>
        <F label={t('Seed lot')}><Pick value={x.seed_lot_id} blank="—" options={b.seeds.map(s => ({ v: s.id, l: `${s.code ? s.code + ' · ' : ''}${cross(s)}` }))} onChange={v => set({ seed_lot_id: v })} /></F>
        <F label={t('Where')}><Pick value={x.room_id} blank="—" options={d.rooms.filter(r => r.active || r.id === x.room_id).map(r => ({ v: r.id, l: r.name }))} onChange={v => set({ room_id: v })} /></F>
        <F label={t('Sown')}><DateIn value={x.sown_on} onChange={v => set({ sown_on: v })} /></F>
        <F label={t('Seeds sown')}><NumIn value={x.seeds_sown} onChange={v => set({ seeds_sown: v })} /></F>
        <F label={t('Came up')}><NumIn value={x.germinated} onChange={v => set({ germinated: v })} /></F>
        <F label={t('Status')}><Pick value={x.status} options={['sown', 'growing', 'scoring', 'done', 'cancelled'].map(s => ({ v: s, l: cap(s) }))} onChange={v => set({ status: v ?? 'sown' })} /></F>
      </div>
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => set({ notes: v })} /></F>
      <SaveBar busy={busy} disabled={!x.name?.trim()} onCancel={onClose} onSave={save} />
    </Sheet>
  )
}

/** one hunt: numbered phenos, everyone's scores, the ranking, keepers */
function HuntView({ sb, d, c, b, h, me, flash, onBack, onSaved, onEdit }: { sb: SupabaseClient; d: NData; c: NCtx; b: BData; h: Hunt; me: string; flash: Flash; onBack: () => void; onSaved: (m: string) => Promise<void>; onEdit: () => void }) {
  const [open, setOpen] = useState<Pheno | null>(null)
  const [f, setF] = useState<'all' | 'growing' | 'keeper' | 'maybe' | 'culled'>('all')
  const [addN, setAddN] = useState<number | null>(null)
  const s = b.seeds.find(z => z.id === h.seed_lot_id)
  const [prefix, setPrefix] = useState(s?.code ?? '')
  const ps = b.phenos.filter(p => p.hunt_id === h.id)
  const rows = ps.map(p => {
    const sc = b.scores.filter(z => z.pheno_id === p.id)
    const tr = Object.fromEntries(TRAITS.map(([k]) => [k, avg(sc.map(z => z[k]))])) as Record<Trait, number | null>
    const total = avg(TRAITS.map(([k]) => tr[k]))
    return { p, sc, t: tr, total, mine: sc.some(z => z.scorer === me) }
  }).filter(r => f === 'all' || r.p.status === f || (f === 'culled' && r.p.status === 'male'))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.p.number - b.p.number)
  const add = async () => {
    const { error } = await sb.rpc('pheno_hunt_number', { p_hunt: h.id, p_count: addN, p_prefix: prefix })
    if (error) flash(error.message, true); else { setAddN(null); await onSaved(t('{n} phenos numbered', { n: String(addN) })) }
  }
  return <div>
    <div className="row toolbar between"><button className="ghost" onClick={onBack}>{t('‹ Hunts')}</button><button className="ghost small" onClick={onEdit}>{t('Edit hunt')}</button></div>
    <h3 className="huntname">{h.name} <span className="muted">· {s ? cross(s) : t('no seed lot')} · {t('sown')} {fmtD(h.sown_on) || '—'} · {t('{n} seeds', { n: n0(h.seeds_sown) })}{h.germinated ? `, ${t('{n} up', { n: n0(h.germinated) })}` : ''}{h.room_id ? ` · ${c.room(h.room_id)}` : ''}</span></h3>
    <div className="row wrap toolbar">
      <div className="seg">{(['all', 'growing', 'maybe', 'keeper', 'culled'] as const).map(k => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{k === 'all' ? `${t('All')} (${ps.length})` : t(PSTATUS[k])}</button>)}</div>
      <span className="row addpheno"><input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder={t('Label (HBxP)')} /><NumIn value={addN} onChange={setAddN} placeholder={t('How many')} />
        <button className="ghost small" disabled={!addN} onClick={add}>{t('+ Number phenos')}</button></span>
    </div>
    <p className="muted small-note">{t('Everyone scores on their own: vigor, structure, aroma, color, tackiness and the jar test, 1-5. The table shows the group average, best first.')}</p>
    {!rows.length ? <p className="muted">{t('No phenos here yet. Number them above (they get #1, #2… in order).')}</p> : <div className="cwrap"><table className="ctable">
      <thead><tr><th>#</th><th>{t('Pheno')}</th>{TRAITS.map(([k, l]) => <th key={k} className="num">{t(l)}</th>)}<th className="num">{t('Avg')}</th><th className="num">{t('Scores')}</th><th>{t('Status')}</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.p.id} className={`tap ${r.p.status === 'culled' || r.p.status === 'male' ? 'done' : ''}`} onClick={() => setOpen(r.p)}>
        <td>{r.p.number}</td><td><b>{r.p.label ?? `#${r.p.number}`}</b>{r.p.keeper_strain && r.p.keeper_strain !== r.p.label ? <span className="muted"> → {r.p.keeper_strain}</span> : ''}</td>
        {TRAITS.map(([k]) => <td key={k} className="num">{f1(r.t[k])}</td>)}<td className="num"><b>{f1(r.total)}</b></td>
        <td className="num">{r.sc.length || ''}{r.mine ? ' ✓' : ''}</td><td><span className={`pill ${r.p.status === 'keeper' ? 'okp' : r.p.status === 'maybe' ? 'warnp' : ''}`}>{t(PSTATUS[r.p.status])}</span></td></tr>)}</tbody>
    </table></div>}
    {open && <PhenoSheet sb={sb} d={d} b={b} p={open} me={me} flash={flash} onClose={() => setOpen(null)} onSaved={async m => { setOpen(null); await onSaved(m) }} />}
  </div>
}

function PhenoSheet({ sb, d, b, p, me, flash, onClose, onSaved }: { sb: SupabaseClient; d: NData; b: BData; p: Pheno; me: string; flash: Flash; onClose: () => void; onSaved: (m: string) => Promise<void> }) {
  const scores = b.scores.filter(z => z.pheno_id === p.id)
  const mine = scores.find(z => z.scorer === me)
  const [sc, setSc] = useState<Partial<Score>>(mine ?? {})
  const [x, setX] = useState<Pheno>(p)
  const [busy, setBusy] = useState(false)
  const run = async (f: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true)
    const { error } = await f()
    setBusy(false)
    if (error) flash(error.message, true); else await onSaved(ok)
  }
  const saveScore = () => run(() => mine
    ? sb.from('pheno_scores').update({ ...Object.fromEntries(TRAITS.map(([k]) => [k, sc[k] ?? null])), notes: sc.notes ?? null, scored_on: today() }).eq('id', mine.id)
    : sb.from('pheno_scores').insert({ pheno_id: p.id, ...Object.fromEntries(TRAITS.map(([k]) => [k, sc[k] ?? null])), notes: sc.notes ?? null }), 'Score saved')
  const savePheno = (v: Partial<Pheno>, ok: string) => run(() => sb.from('phenos').update({ label: v.label ?? x.label, plant_tag: v.plant_tag ?? x.plant_tag, room_id: v.room_id ?? x.room_id, bed: v.bed ?? x.bed,
    status: v.status ?? x.status, notes: v.notes ?? x.notes }).eq('id', p.id), ok)
  const keeper = async () => {
    const name = prompt(t('Name for this keeper (it goes on the Strains list)'), x.keeper_strain ?? x.label ?? ''); if (name == null) return
    await run(() => sb.rpc('pheno_keeper', { p_pheno: p.id, p_name: name }), t('{name} is a keeper', { name: name || x.label || '' }))
  }
  return (
    <Sheet title={x.label ?? `#${x.number}`} sub={`${tn(scores.length, '{n} score', '{n} scores')} · ${t(PSTATUS[x.status])}${x.keeper_strain ? ` · ${x.keeper_strain}` : ''}`} onClose={onClose}>
      <h3>{t('Your score')}</h3>
      <div className="scoregrid">{TRAITS.map(([k, l]) => <Fragment key={k}><span>{t(l)}</span>
        <div className="choices">{[1, 2, 3, 4, 5].map(v => <button key={v} type="button" className={sc[k] === v ? 'on' : ''} onClick={() => setSc(s => ({ ...s, [k]: s[k] === v ? null : v }))}>{v}</button>)}</div></Fragment>)}</div>
      <F label={t('Notes')}><TextIn value={sc.notes} onChange={v => setSc(s => ({ ...s, notes: v }))} placeholder={t('Smells like…')} /></F>
      <button className="primary" disabled={busy || !TRAITS.some(([k]) => sc[k])} onClick={saveScore}>{t(mine ? 'Update my score' : 'Save my score')}</button>
      {scores.filter(z => z.scorer !== me).length > 0 && <><h3>{t('Everyone else')}</h3><div className="cwrap tight"><table className="ctable">
        <thead><tr><th>{t('Who')}</th>{TRAITS.map(([k, l]) => <th key={k} className="num">{t(l).slice(0, 5)}</th>)}<th>{t('Notes')}</th></tr></thead>
        <tbody>{scores.filter(z => z.scorer !== me).map(z => <tr key={z.id}><td>{who(z.scorer)}</td>{TRAITS.map(([k]) => <td key={k} className="num">{z[k] ?? ''}</td>)}<td className="small">{z.notes}</td></tr>)}</tbody>
      </table></div></>}
      <h3>{t('Plant')}</h3>
      <div className="grid2">
        <F label={t('Label')}><TextIn value={x.label} onChange={v => setX({ ...x, label: v })} /></F>
        <F label={t('METRC tag')}><TextIn value={x.plant_tag} onChange={v => setX({ ...x, plant_tag: v ? v.toUpperCase() : null })} /></F>
        <F label={t('Where')}><Pick value={x.room_id} blank="—" options={d.rooms.filter(r => r.active || r.id === x.room_id).map(r => ({ v: r.id, l: r.name }))} onChange={v => setX({ ...x, room_id: v })} /></F>
        <F label={t('Bed / row')}><TextIn value={x.bed} onChange={v => setX({ ...x, bed: v })} /></F>
      </div>
      <F label={t('Notes')}><TextIn value={x.notes} onChange={v => setX({ ...x, notes: v })} /></F>
      <div className="row wrap docact">
        <button className="ghost" disabled={busy} onClick={() => savePheno(x, 'Saved')}>{t('Save plant details')}</button>
        <button className="primary" disabled={busy} onClick={keeper}>{t(x.status === 'keeper' ? 'Rename keeper…' : 'Keeper…')}</button>
        {x.status !== 'maybe' && <button className="ghost" disabled={busy} onClick={() => savePheno({ status: 'maybe' }, 'Marked maybe')}>{t('Maybe')}</button>}
        {x.status !== 'culled' && <button className="ghost danger" disabled={busy} onClick={() => savePheno({ status: 'culled' }, 'Culled')}>{t('Cull')}</button>}
        {x.status !== 'male' && <button className="ghost" disabled={busy} onClick={() => savePheno({ status: 'male' }, 'Marked male')}>{t('Male')}</button>}
        {x.status !== 'growing' && <button className="ghost" disabled={busy} onClick={() => savePheno({ status: 'growing' }, 'Back to growing')}>{t('Back to growing')}</button>}
      </div>
    </Sheet>
  )
}
