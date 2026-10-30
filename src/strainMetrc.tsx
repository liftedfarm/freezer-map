// New strain > METRC (132). The strain's METRC sheet: everything METRC needs on every Lifted license (the strain, farm items,
// GVR Processing items for both farms, 1PN Clone / URC / Seed for the seasons and crop years ticked), what's already there,
// and Send, which queues METRC to-dos (strain_create, item_create) that go through T3 like every other kind.
// Also the METRC codes list for coded nursery strains (real name next to the code, download as a spreadsheet).
import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { metrcRun } from './metrcCall'
import { download, toCsv } from './comp/csv'

export interface PlanRow {
  key: string; license: string; license_kind: 'cultivation' | 'processor' | 'nursery'; site: string; what: 'strain' | 'item'; name: string
  finish: string | null; crop_year: number | null; farm: string | null; season: 'FL' | 'SP' | null; category: string | null; uom: string | null
  on: boolean; state: 'new' | 'in_metrc' | 'queued'; metrc_name: string | null; action_id: number | null
}
export interface StrainPlan {
  strain: { id: number; name: string; metrc_name: string; strain_no: number | null; code: string | null; coded: boolean; testing: string; thc: number; cbd: number; indica: number; sativa: number }
  years: number[]; seasons: string[]; coded: boolean; this_year: number; can_send: boolean; pulled_at: string | null
  modes: Record<string, 'off' | 'approve' | 'auto'> | null; rows: PlanRow[]
}
type Flash = (m: string, bad?: boolean) => void

const KIND: Record<string, string> = { cultivation: 'Cultivation', processor: 'Processing', nursery: 'Nursery' }
const FIN: Record<string, string> = { FF: 'Fresh Frozen', DH: 'Dry Harvest (wet)', UF: 'Unbucked', BF: 'Bucked', ST: 'Standards', SM: 'Smalls', TR: 'Dry Trim',
  BT: 'Bucking Trim', DB: 'Dry Biomass', DS: 'Dry Sift Biomass', CL: 'Clone', UR: 'URC', SD: 'Seed' }

export function loadStrainPlan(sb: SupabaseClient, strain: number, opts: object) {
  return Promise.resolve(sb.rpc('metrc_strain_plan', { p_strain: strain, p_opts: opts })).then(({ data, error }) => { if (error) throw new Error(error.message); return data as StrainPlan })
}

async function pullSetup(sb: SupabaseClient) {
  const { data } = await sb.auth.getSession()
  for (let i = 0; i < 4; i++) {
    const r = await fetch('/api/metrc/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` }, body: JSON.stringify({ only: 'setup' }) })
    const j = await r.json().catch(() => ({ error: `The server didn't answer (${r.status})` }))
    if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`)
    if (j.done) return j
    const bad = (j.results ?? []).find((x: { error?: string }) => x.error)
    if (bad) throw new Error(`${bad.license}: ${bad.error}`)
  }
  throw new Error('METRC took too long. Try Refresh again.')
}

export function StrainMetrcSheet({ sb, strainId, flash, onClose, isNew }: { sb: SupabaseClient; strainId: number; flash: Flash; onClose: () => void; isNew?: boolean }) {
  const [plan, setPlan] = useState<StrainPlan | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [years, setYears] = useState<number[] | null>(null)
  const [seasons, setSeasons] = useState<string[]>(['FL'])
  const [coded, setCoded] = useState<boolean | null>(null)
  const [f, setF] = useState<{ metrc_name: string; testing: string; thc: string; cbd: string; indica: string; sativa: string } | null>(null)
  const [off, setOff] = useState<Set<string>>(new Set())     // new rows the person unticked
  const [on, setOn] = useState<Set<string>>(new Set())       // optional rows (Seed, Dry Biomass...) the person ticked
  const [busy, setBusy] = useState<string | null>(null)
  const [skipLic, setSkipLic] = useState<Set<string>>(new Set())   // licenses left out this time

  const opts = useMemo(() => ({ ...(years ? { years } : {}), seasons, ...(coded != null ? { coded } : {}) }), [years, seasons, coded])
  const load = () => loadStrainPlan(sb, strainId, opts).then(p => {
    setPlan(p); setErr(null)
    if (!years) setYears(p.years)
    if (coded == null) setCoded(p.strain.coded)
    if (!f) setF({ metrc_name: p.strain.metrc_name, testing: p.strain.testing, thc: String(p.strain.thc), cbd: String(p.strain.cbd), indica: String(p.strain.indica), sativa: String(p.strain.sativa) })
  }).catch((e: Error) => setErr(String(e.message ?? e)))
  useEffect(() => { load() }, [opts])

  const ticked = (r: PlanRow) => r.state === 'new' && !skipLic.has(r.license) && (r.on ? !off.has(r.key) : on.has(r.key))
  const toggle = (r: PlanRow) => {
    if (r.on) setOff(s => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n })
    else setOn(s => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n })
  }
  const rows = plan?.rows ?? []
  const picked = rows.filter(ticked)
  const byLicense = useMemo(() => {
    const m = new Map<string, PlanRow[]>()
    for (const r of rows) m.set(r.license, [...(m.get(r.license) ?? []), r])
    return [...m.entries()]
  }, [rows])
  const hasNursery = rows.some(r => r.license_kind === 'nursery')
  const nameChanged = !!plan && !!f && f.metrc_name.trim() !== plan.strain.metrc_name
  const splitOk = !f || Number(f.indica) + Number(f.sativa) === 100

  async function refresh() {
    setBusy('pull')
    try { await pullSetup(sb); await load(); flash('Strains and items refreshed from METRC') }
    catch (e) { flash((e as Error).message, true) } finally { setBusy(null) }
  }
  async function queue() {
    if (!plan || !f || !picked.length) return
    setBusy('send')
    try {
      const { data, error } = await sb.rpc('metrc_strain_queue', { p_strain: strainId, p_keys: picked.map(r => r.key),
        p_opts: { ...opts, metrc_name: f.metrc_name.trim(), testing: f.testing, thc: f.thc, cbd: f.cbd, indica: f.indica, sativa: f.sativa } })
      if (error) throw new Error(error.message)
      const r = data as { strains: number; items: number; skipped: number; modes: Record<string, string> | null }
      const n = r.strains + r.items
      const modes = r.modes ?? {}
      const offNow = [modes.strain_create, modes.item_create].every(m => !m || m === 'off')
      const auto = [modes.strain_create, modes.item_create].some(m => m === 'auto')
      if (auto) metrcRun(sb, { action: 'kick' }).catch(() => {})
      flash(`${n} METRC to-do${n === 1 ? '' : 's'} made (${r.strains} strain, ${r.items} item${r.items === 1 ? '' : 's'}). `
        + (offNow ? 'New strain sends are Off in Compliance > Settings > METRC through T3, so they wait on the METRC to-do list.'
          : auto ? 'Sending now.' : 'They wait for Send on the METRC to-do list.'))
      setOff(new Set()); setOn(new Set())
      await load()
    } catch (e) { flash((e as Error).message, true) } finally { setBusy(null) }
  }

  const set = (k: keyof NonNullable<typeof f>, v: string) => setF(x => (x ? { ...x, [k]: v } : x))
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>METRC: {plan?.strain.name ?? 'strain'}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {err && <div className="warnbox">{err}</div>}
        {!plan || !f ? <p className="muted">Loading…</p> : <>
          {isNew && <p className="muted">Strain added. Here's what METRC needs for it on every license.</p>}
          {!plan.can_send && <div className="warnbox">Only Production, Nursery or Compliance Admins (or Admin) can send a strain to METRC. This is what it would need.</div>}

          <div className="field"><label>Name in METRC</label>
            <input value={f.metrc_name} disabled={!plan.can_send} onChange={e => set('metrc_name', e.target.value)} />
            {nameChanged && <span className="muted small">Item names below update when you send. Use the exact METRC spelling.</span>}
          </div>
          {hasNursery && <label className="check">
            <input type="checkbox" checked={!!coded} disabled={!plan.can_send || plan.strain.coded} onChange={e => setCoded(e.target.checked)} />
            Nursery: use the number code {plan.strain.code} instead of the name on 1PN (strain and items){plan.strain.coded ? ' · coded (stays coded)' : ''}
          </label>}

          <div className="row" style={{ gap: 14, margin: '10px 0' }}>
            <span className="muted small">Crop years</span>
            {[plan.this_year, plan.this_year + 1].map(y => (
              <label key={y} className="check small-check"><input type="checkbox" checked={(years ?? plan.years).includes(y)}
                onChange={e => setYears(ys => { const cur = ys ?? plan.years; const n = e.target.checked ? [...cur, y] : cur.filter(x => x !== y); return n.length ? n.sort() : cur })} /> {y}</label>
            ))}
            {hasNursery && <>
              <span className="muted small">Nursery seasons</span>
              {(['FL', 'SP'] as const).map(s => (
                <label key={s} className="check small-check"><input type="checkbox" checked={seasons.includes(s)}
                  onChange={e => setSeasons(ss => { const n = e.target.checked ? [...ss, s] : ss.filter(x => x !== s); return n.length ? n : ss })} /> {s === 'FL' ? 'Fall (FL)' : 'Spring (SP)'}</label>
              ))}
            </>}
          </div>

          {rows.some(r => r.what === 'strain' && r.state === 'new') && plan.can_send && (
            <details className="field"><summary className="muted small">Strain details METRC asks for: {f.testing === 'None' ? 'no testing' : f.testing}, THC {f.thc}%, CBD {f.cbd}%, Indica/Sativa {f.indica}/{f.sativa}</summary>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <select value={f.testing} onChange={e => set('testing', e.target.value)}>
                  <option value="None">Testing: None</option><option value="InHouse">In house</option><option value="ThirdParty">Third party</option>
                </select>
                {(['thc', 'cbd', 'indica', 'sativa'] as const).map(k => (
                  <label key={k} className="small">{k.toUpperCase()} % <input style={{ width: 70 }} inputMode="decimal" value={f[k]} onChange={e => set(k, e.target.value)} /></label>
                ))}
              </div>
              {!splitOk && <div className="warnbox">Indica + Sativa has to add up to 100.</div>}
            </details>
          )}

          <div className="row between" style={{ margin: '8px 0' }}>
            <span className="muted small">Checked against METRC {plan.pulled_at ? new Date(plan.pulled_at).toLocaleString() : 'never (Refresh first)'}</span>
            <button className="ghost small" disabled={!!busy} onClick={refresh}>{busy === 'pull' ? 'Refreshing…' : 'Refresh from METRC'}</button>
          </div>

          {byLicense.map(([lic, rs]) => (
            <div key={lic} className="metrc-lic">
              <label className="check" style={{ margin: '12px 0 4px' }}>
                <input type="checkbox" checked={!skipLic.has(lic)} disabled={!plan.can_send} onChange={e => setSkipLic(x => { const n = new Set(x); if (e.target.checked) n.delete(lic); else n.add(lic); return n })} />
                <b style={{ fontSize: 15 }}>{rs[0].site} {KIND[rs[0].license_kind]}</b> <span className="muted small">{lic}</span>
              </label>
              {!skipLic.has(lic) && rs.map(r => (
                <label key={r.key} className="check small-check" style={{ alignItems: 'flex-start', margin: '3px 0' }}>
                  <input type="checkbox" checked={r.state !== 'new' || ticked(r)} disabled={r.state !== 'new' || !plan.can_send} onChange={() => toggle(r)} />
                  <span>
                    {r.what === 'strain' ? <b>Strain: {r.name}</b> : <>{r.name}</>}
                    {r.what === 'item' && <span className="muted"> · {FIN[r.finish ?? ''] ?? r.finish}{r.category ? ` · ${r.category}` : ''}</span>}
                    {' '}{r.state === 'in_metrc' ? <span className="pill">In METRC{r.metrc_name && r.metrc_name !== r.name ? `: ${r.metrc_name}` : ''}</span>
                      : r.state === 'queued' ? <span className="pill warn">To-do{r.action_id ? ` #${r.action_id}` : ''}</span>
                      : !r.on ? <span className="muted">(optional)</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ))}

          {plan.can_send && <div className="row end" style={{ marginTop: 14 }}>
            <button className="ghost" onClick={onClose}>{picked.length ? 'Not now' : 'Close'}</button>
            <button className="primary" disabled={!!busy || !picked.length || !splitOk} onClick={queue}>
              {busy === 'send' ? 'Sending…' : `Send ${picked.length} to METRC`}</button>
          </div>}
          <p className="muted small">Send makes METRC to-dos (Compliance &gt; METRC). They follow the New strain switches in Compliance &gt; Settings &gt; METRC through T3 (Off, Approve, Auto) and Dry run / Live, like every other METRC action.</p>
        </>}
      </div>
    </div>
  )
}

interface CodeRow { id: number; code: string; name: string; aliases: string[]; active: boolean; coded_at: string | null; items: { license: string; what: string; name: string; status: string }[] }

/** coded nursery strains: the code, the real name, and what METRC has under the code */
export function StrainCodesSheet({ sb, onClose }: { sb: SupabaseClient; onClose: () => void }) {
  const [rows, setRows] = useState<CodeRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { sb.rpc('metrc_strain_codes').then(({ data, error }) => { if (error) setErr(error.message); else setRows((data ?? []) as CodeRow[]) }) }, [])
  const shown = (rows ?? []).filter(r => !q || `${r.code} ${r.name} ${r.aliases.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  function exportIt() {
    const out = (rows ?? []).flatMap(r => (r.items.length ? r.items : [null]).map(i => [r.code, r.name, r.aliases.join(', '), r.active ? 'Yes' : 'No',
      i?.license ?? '', i ? (i.what === 'strain' ? 'Strain' : 'Item') : '', i?.name ?? '', i?.status === 'in_metrc' ? 'In METRC' : i ? 'To-do' : '']))
    download(`METRC strain codes ${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + toCsv(['Code', 'Strain', 'Other names', 'Active', 'License', 'Type', 'METRC name', 'Status'], out))
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>METRC strain codes</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <p className="muted small">Nursery strains that go into METRC on 1PN as a number. Everyone in the app still sees the real name.</p>
        {err && <div className="warnbox">{err}</div>}
        <div className="row toolbar">
          <input className="search" type="search" placeholder="Search code or strain" value={q} onChange={e => setQ(e.target.value)} />
          <button className="ghost small" disabled={!rows?.length} onClick={exportIt}>Download as spreadsheet</button>
        </div>
        {!rows ? (err ? null : <p className="muted">Loading…</p>) : !rows.length ? <p className="muted">No coded strains yet. Tick "use the number code" on a strain's METRC sheet.</p> : (
          <table className="tbl" style={{ width: '100%' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Code</th><th style={{ textAlign: 'left' }}>Strain</th><th style={{ textAlign: 'left' }}>In METRC on 1PN</th></tr></thead>
            <tbody>{shown.map(r => (
              <tr key={r.id}><td><b>{r.code}</b></td><td>{r.name}{!r.active && <span className="muted"> · retired</span>}{r.aliases.length ? <div className="muted small">also: {r.aliases.join(', ')}</div> : null}</td>
                <td className="small">{r.items.filter(i => i.what === 'item').map(i => <div key={i.name}>{i.name}{i.status !== 'in_metrc' && <span className="muted"> (to-do)</span>}</div>)}
                  {!r.items.length && <span className="muted">nothing yet</span>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** Item generator: many strains at once (a new crop year, a new season, an item added to the rules later). Same plan and
 *  queue as one strain's METRC sheet, filtered by license and item type; only what METRC doesn't have yet is made. */
export function ItemGeneratorSheet({ sb, flash, onClose }: { sb: SupabaseClient; flash: Flash; onClose: () => void }) {
  const yr = new Date().getFullYear()
  const [strains, setStrains] = useState<{ id: number; name: string; active: boolean; trial: boolean; metrc_coded: boolean }[] | null>(null)
  const [lics, setLics] = useState<{ license_no: string; kind: string; site: string | null }[]>([])
  const [rules, setRules] = useState<{ license_kind: string; finish: string; default_on: boolean }[]>([])
  const [pick, setPick] = useState<Set<number>>(new Set())
  const [q, setQ] = useState('')
  const [years, setYears] = useState<number[]>([yr + 1])
  const [seasons, setSeasons] = useState<string[]>(['FL'])
  const [licOn, setLicOn] = useState<Set<string> | null>(null)
  const [fin, setFin] = useState<Set<string> | null>(null)      // license_kind|finish
  const [withStrain, setWithStrain] = useState(true)
  const [preview, setPreview] = useState<{ id: number; name: string; keys: string[]; rows: PlanRow[] }[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [canSend, setCanSend] = useState(false)
  useEffect(() => {
    sb.from('strains').select('id,name,active,trial,metrc_coded').order('name').then(r => setStrains((r.data ?? []) as never))
    sb.from('licenses').select('license_no,kind,site').eq('active', true).in('kind', ['cultivation', 'processor', 'nursery']).order('sort').then(r => {
      const l = (r.data ?? []) as { license_no: string; kind: string; site: string | null }[]; setLics(l); setLicOn(new Set(l.map(x => x.license_no))) })
    sb.from('metrc_item_rules').select('license_kind,finish,default_on').order('license_kind').order('sort').then(r => {
      const rs = (r.data ?? []) as { license_kind: string; finish: string; default_on: boolean }[]; setRules(rs); setFin(new Set(rs.filter(x => x.default_on).map(x => `${x.license_kind}|${x.finish}`))) })
  }, [])
  useEffect(() => { setPreview(null) }, [pick, years, seasons, licOn, fin, withStrain])
  const shown = (strains ?? []).filter(s => s.active && (!q || s.name.toLowerCase().includes(q.toLowerCase())))
  const flip = <T,>(set: (f: (x: Set<T>) => Set<T>) => void, v: T) => set(x => { const n = new Set(x); if (n.has(v)) n.delete(v); else n.add(v); return n })

  async function look() {
    if (!licOn || !fin) return
    setBusy('look')
    const ids = [...pick], out: NonNullable<typeof preview> = []
    try {
      for (let i = 0; i < ids.length; i += 6) {
        const part = await Promise.all(ids.slice(i, i + 6).map(id => loadStrainPlan(sb, id, { years, seasons })))
        for (const p of part) {
          setCanSend(p.can_send)
          const rows = p.rows.filter(r => r.state === 'new' && licOn.has(r.license)
            && (r.what === 'strain' ? withStrain : fin.has(`${r.license_kind}|${r.finish}`)))
          // an item needs its strain on that license: keep the strain row when an item there is picked
          const need = new Set(rows.filter(r => r.what === 'item').map(r => r.license))
          const extra = p.rows.filter(r => r.what === 'strain' && r.state === 'new' && need.has(r.license) && !rows.includes(r))
          const all = [...extra, ...rows]
          out.push({ id: p.strain.id, name: p.strain.name, keys: all.map(r => r.key), rows: all })
        }
      }
      setPreview(out)
    } catch (e) { flash((e as Error).message, true) } finally { setBusy(null) }
  }
  async function queue() {
    if (!preview) return
    setBusy('send')
    let n = 0, done = 0
    try {
      for (const p of preview.filter(x => x.keys.length)) {
        const { data, error } = await sb.rpc('metrc_strain_queue', { p_strain: p.id, p_keys: p.keys, p_opts: { years, seasons } })
        if (error) throw new Error(`${p.name}: ${error.message}`)
        const r = data as { strains: number; items: number }
        n += r.strains + r.items; done++
      }
      metrcRun(sb, { action: 'kick' }).catch(() => {})
      flash(`${n} METRC to-dos made for ${done} strain${done === 1 ? '' : 's'}. They follow the New strain switches in Compliance > Settings > METRC through T3.`)
      setPreview(null)
    } catch (e) { flash(`Stopped after ${done} strains (${n} to-dos): ${(e as Error).message}`, true) } finally { setBusy(null) }
  }
  const total = (preview ?? []).reduce((a, p) => a + p.keys.length, 0)
  const kinds = [...new Set(rules.map(r => r.license_kind))]
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form wide" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>METRC item generator</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <p className="muted small">Make METRC items for many strains at once: a new crop year, a new season, or an item type added later. Only what METRC doesn't have yet is made. Coded nursery strains use their code.</p>

        <div className="row" style={{ gap: 14, margin: '8px 0' }}>
          <span className="muted small">Crop years</span>
          {[yr, yr + 1].map(y => <label key={y} className="check small-check"><input type="checkbox" checked={years.includes(y)}
            onChange={e => setYears(ys => { const n = e.target.checked ? [...ys, y] : ys.filter(x => x !== y); return n.length ? n.sort() : ys })} /> {y}</label>)}
          <span className="muted small">Nursery seasons</span>
          {(['FL', 'SP'] as const).map(se => <label key={se} className="check small-check"><input type="checkbox" checked={seasons.includes(se)}
            onChange={e => setSeasons(ss => { const n = e.target.checked ? [...ss, se] : ss.filter(x => x !== se); return n.length ? n : ss })} /> {se === 'FL' ? 'Fall' : 'Spring'}</label>)}
        </div>
        <div className="row" style={{ gap: 14, margin: '8px 0' }}>
          <span className="muted small">Licenses</span>
          {lics.map(l => <label key={l.license_no} className="check small-check"><input type="checkbox" checked={!!licOn?.has(l.license_no)}
            onChange={() => setLicOn(x => { const n = new Set(x ?? []); if (n.has(l.license_no)) n.delete(l.license_no); else n.add(l.license_no); return n })} /> {l.site} {KIND[l.kind]}</label>)}
        </div>
        {kinds.map(k => <div key={k} className="row" style={{ gap: 10, margin: '4px 0' }}>
          <span className="muted small" style={{ minWidth: 80 }}>{KIND[k]}</span>
          {rules.filter(r => r.license_kind === k).map(r => <label key={r.finish} className="check small-check"><input type="checkbox" checked={!!fin?.has(`${k}|${r.finish}`)}
            onChange={() => setFin(x => { const n = new Set(x ?? []); const key = `${k}|${r.finish}`; if (n.has(key)) n.delete(key); else n.add(key); return n })} /> {FIN[r.finish] ?? r.finish}</label>)}
        </div>)}
        <label className="check small-check" style={{ margin: '6px 0' }}><input type="checkbox" checked={withStrain} onChange={e => setWithStrain(e.target.checked)} /> Also make the strain where METRC doesn't have it</label>

        <div className="row toolbar" style={{ marginTop: 10 }}>
          <input className="search" type="search" placeholder="Search strains" value={q} onChange={e => setQ(e.target.value)} />
          <button className="ghost small" onClick={() => setPick(x => { const n = new Set(x); shown.forEach(s => n.add(s.id)); return n })}>Select all shown</button>
          <button className="ghost small" disabled={!pick.size} onClick={() => setPick(new Set())}>Clear ({pick.size})</button>
        </div>
        <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: '4px 8px' }}>
          {!strains ? <p className="muted">Loading…</p> : shown.map(s => <label key={s.id} className="check small-check" style={{ margin: '3px 0' }}>
            <input type="checkbox" checked={pick.has(s.id)} onChange={() => flip(setPick, s.id)} /> {s.name}{s.trial ? <span className="muted"> · trial</span> : null}{s.metrc_coded ? <span className="muted"> · coded</span> : null}</label>)}
        </div>

        {preview && <div style={{ margin: '10px 0' }}>
          <b>{total} to make</b> <span className="muted small">across {preview.filter(p => p.keys.length).length} strains ({preview.filter(p => !p.keys.length).length} already have everything)</span>
          <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 6 }} className="small">
            {preview.filter(p => p.keys.length).map(p => <details key={p.id}><summary>{p.name}: {p.keys.length}</summary>
              {p.rows.map(r => <div key={r.key} className="muted">{r.license} · {r.what === 'strain' ? `Strain ${r.name}` : r.name}</div>)}</details>)}
          </div>
        </div>}
        <div className="row end" style={{ marginTop: 12 }}>
          <button className="ghost" disabled={!!busy || !pick.size} onClick={look}>{busy === 'look' ? 'Checking…' : 'Preview'}</button>
          <button className="primary" disabled={!!busy || !preview || !total || !canSend} onClick={queue}>{busy === 'send' ? 'Sending…' : `Send ${total} to METRC`}</button>
        </div>
        {preview && !canSend && <p className="muted small">Only Production, Nursery or Compliance Admins (or Admin) can send to METRC.</p>}
      </div>
    </div>
  )
}
