import { useEffect, useMemo, useState } from 'react'
import type { LiveRecon, SyncStatus } from './api'
import type { Ctx } from './ctx'
import { errText } from '../cult/ui'
import { ISSUE_LABEL, ISSUE_ORDER, isPlant, reconExcel, reconPdf, shows } from './reconexport'
import type { Row } from './reconexport'

// Compliance > METRC > Reconcile (live): METRC pulled through T3 every night and on demand, compared with every package in the app.

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never')
const n2 = (x: number | null | undefined) => (x == null ? '' : (Math.round(Number(x) * 100) / 100).toLocaleString())
const HELP: Partial<Record<LiveRecon['issue'], string>> = {
  weight: 'METRC and the app have different weights. "What METRC shows" lists the packages METRC made from it and where they went.',
  not_in_metrc: 'In a freezer in the app, but not active in METRC under this license: shipped, transferred, combined or finished there.',
  not_in_app: 'Active in METRC, no package in the app has this tag. New harvest packages entered in METRC show up here.',
  closed_in_app: 'Shipped, used up or combined in the app, still active in METRC.',
}

export function LiveReconcile({ c }: { c: Ctx }) {
  const [st, setSt] = useState<SyncStatus[]>([])
  const [lic, setLic] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, LiveRecon[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set(['weight', 'not_in_metrc']))
  const loadSt = async () => { try { const s = await c.api.syncStatus(); setSt(s); setLic(l => l ?? s.find(x => x.active > 0)?.license ?? s[0]?.license ?? null); return s } catch (e) { c.flash(errText(e), true); return [] } }
  const loadRows = async (l: string) => { try { const r = await c.api.reconcileLive(l); setRows(m => ({ ...m, [l]: r })); return r } catch (e) { c.flash(errText(e), true); return [] } }
  useEffect(() => { loadSt() }, [])
  useEffect(() => { if (lic && !rows[lic]) loadRows(lic) }, [lic])

  async function pull() {
    setBusy('Pulling from METRC…')
    try {
      let closed = 0
      for (let i = 0; i < 12; i++) {   // big first pull: the server stops at ~4 minutes and carries on next call
        const r = await c.api.pullMetrc()
        closed += r.closed ?? 0
        const left = r.results.filter(x => !x.complete)
        const bad = r.results.find(x => x.error)
        if (bad) { c.flash(`${bad.license}: ${bad.error}`, true); break }
        if (r.done) { c.flash(`METRC pulled for ${r.results.length} license${r.results.length === 1 ? '' : 's'}${closed ? `. ${closed} to-dos were already done in METRC and are closed.` : ''}`); break }
        setBusy(`Still pulling (${left.map(x => x.license).join(', ')})… pass ${i + 2}`)
      }
      await loadSt(); setRows({}); if (lic) await loadRows(lic); await c.reload()
    } catch (e) { c.flash(errText(e), true) } finally { setBusy(null) }
  }
  async function allRows(): Promise<Row[]> {
    const out: Row[] = []
    for (const s of st.filter(x => x.active > 0 || x.last_pull)) {
      const r = rows[s.license] ?? await loadRows(s.license)
      out.push(...r.filter(x => !isPlant(x)).map(x => ({ ...x, license: s.license, site: s.site })))
    }
    return out
  }
  const pulledAt = st.map(s => s.last_pull).filter(Boolean).sort()[0] ?? null
  const fname = `METRC mismatches ${new Date().toISOString().slice(0, 10)}`
  async function excel() { setBusy('Building Excel…'); try { await reconExcel(await allRows(), fname) } catch (e) { c.flash(errText(e), true) } finally { setBusy(null) } }
  async function pdf() { setBusy('Building PDF…'); try { await reconPdf(await allRows(), { name: fname, who: c.me ?? '', pulled: when(pulledAt) }) } catch (e) { c.flash(errText(e), true) } finally { setBusy(null) } }

  const cur = lic ? rows[lic] : null
  const by = useMemo(() => { const m = new Map<LiveRecon['issue'], LiveRecon[]>(); for (const r of cur ?? []) if (!isPlant(r)) m.set(r.issue, [...(m.get(r.issue) ?? []), r]); return m }, [cur])
  const plants = (cur ?? []).filter(isPlant)
  const toggle = (k: string) => setOpen(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })

  return <>
    <p className="muted">METRC is pulled through T3 every night (and when you tap Pull), then compared with every package in the app. Each gap says what METRC did with the package: split, shipped on which manifest, finished. Export to Excel, fill in Action and Reason, and drop it back here to fix the app in bulk.</p>
    <div className="tablewrap"><table className="ct"><thead><tr><th>License</th><th className="num">Active in METRC</th><th>Last pull</th><th /></tr></thead>
      <tbody>{st.map(s => <tr key={s.license} className={`tap ${lic === s.license ? 'sel' : ''}`} onClick={() => setLic(s.license)}>
        <td><b>{s.site}</b> <span className="mono small">{s.license}</span></td><td className="num">{s.active.toLocaleString()}</td>
        <td className="small">{when(s.last_pull)}{!s.complete && s.last_pull && <span className="muted"> (partial)</span>}{s.error && <div className="neg small">{s.error}</div>}</td>
        <td>{lic === s.license && <span className="pill cp-ok">showing</span>}</td></tr>)}</tbody></table></div>
    <div className="row wrap toolbar" style={{ marginTop: 8 }}>
      {c.canEdit && <button className="primary" disabled={!!busy} onClick={pull}>{busy?.startsWith('Pull') || busy?.startsWith('Still') ? busy : 'Pull from METRC now'}</button>}
      <button className="ghost" disabled={!!busy || !st.some(s => s.last_pull)} onClick={excel}>Excel (all licenses)</button>
      <button className="ghost" disabled={!!busy || !st.some(s => s.last_pull)} onClick={pdf}>PDF (all licenses)</button>
      {busy && !busy.startsWith('Pull') && !busy.startsWith('Still') && <span className="muted small">{busy}</span>}
    </div>
    {lic && (cur == null ? <p className="muted">Comparing…</p> : !st.find(s => s.license === lic)?.last_pull ? <p className="muted">Not pulled yet. Tap Pull from METRC now.</p>
      : !cur.length ? <div className="infobox" style={{ marginTop: 10 }}>Everything matches for {lic}.</div>
      : ISSUE_ORDER.filter(k => by.get(k)?.length).map(k => <div key={k} className="dueg">
        <h3 className="tap" onClick={() => toggle(k)}>{open.has(k) ? '▾' : '▸'} {ISSUE_LABEL[k]} <span className="muted">{by.get(k)!.length}</span></h3>
        {open.has(k) && <>{HELP[k] && <p className="muted small">{HELP[k]}</p>}
          <div className="tablewrap"><table className="ct"><thead><tr><th>Package</th><th className="hide-s">Tag</th><th className="hide-s">Strain / item</th><th className="num">App</th><th className="num">METRC</th><th className="hide-s">App spot</th><th>What METRC shows</th></tr></thead>
            <tbody>{by.get(k)!.map((r, i) => <tr key={`${r.tag}-${r.pallet_id}-${i}`}>
              <td>{r.code ?? ''}</td><td className="mono small hide-s" title={r.tag ?? ''}>{r.tag ? `…${r.tag.slice(-8)}` : ''}</td>
              <td className="small hide-s">{r.strain ?? r.metrc_item ?? ''}</td><td className="num">{n2(r.app_lbs)}</td><td className="num">{n2(r.metrc_lbs)}</td>
              <td className="small hide-s">{r.app_spot ?? ''}</td>
              <td className="small">{shows(r)}{r.note && <div className="muted">{r.note}</div>}{r.metrc_location && <div className="muted">METRC: {r.metrc_location}{r.metrc_changed ? `, changed ${when(r.metrc_changed)}` : ''}</div>}</td>
            </tr>)}</tbody></table></div></>}
      </div>))}
    {plants.length > 0 && <div className="dueg"><h3 className="tap" onClick={() => toggle('plants')}>{open.has('plants') ? '▾' : '▸'} Plant packages in METRC (clones, seeds) <span className="muted">{plants.length}</span></h3>
      {open.has('plants') && <><p className="muted small">The app doesn't track clones and seeds as pallets yet (Phase 2, nursery). Left out of the counts and the Excel / PDF.</p>
        <div className="tablewrap"><table className="ct"><thead><tr><th>Tag</th><th>Item</th><th className="num">Qty</th><th>Location</th></tr></thead>
          <tbody>{plants.slice(0, 300).map((r, i) => <tr key={i}><td className="mono small">…{(r.tag ?? '').slice(-8)}</td><td className="small">{r.metrc_item}</td><td className="num">{n2(r.metrc_lbs)}</td><td className="small">{r.metrc_location ?? ''}</td></tr>)}</tbody></table></div></>}
    </div>}
  </>
}
