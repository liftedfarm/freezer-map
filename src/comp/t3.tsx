import { useEffect, useState } from 'react'
import { Select } from '../combo'
import { Fold } from '../fold'
import { F, errText } from '../cult/ui'
import type { PushKind, T3Conn } from './api'
import type { Ctx } from './ctx'
import { T3More } from './t3more'
import { ItemRules } from './itemrules'

// Compliance > Settings > METRC through T3: connection test, Dry run / Live, adjustment reasons, Off / Approve / Auto per kind.

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const REASONS = [['drying', 'Drying'], ['scale', 'Scale variance'], ['waste', 'Waste'], ['entry', 'Entry error']] as const
const MODE = { off: 'Off (by hand)', approve: 'Approve each one', auto: 'Auto' } as const

export function T3Settings({ c }: { c: Ctx }) {
  const [conn, setConn] = useState<T3Conn | null>(null)
  const [kinds, setKinds] = useState<PushKind[]>([])
  const [set, setSet] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = async () => {
    try {
      const [k, cn, s] = await Promise.all([c.api.pushKinds(), c.api.t3Conn(),
        c.api.sb.from('app_settings').select('key,value').or('key.like.comp.metrc_%,key.eq.comp.tag_autofill').then(r => r.data ?? [])])
      setKinds(k); setConn(cn); setSet(Object.fromEntries(s.map(x => [x.key, x.value]))); setErr(null)
    } catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { load() }, [])
  const live = set['comp.metrc_live'] === 'true'

  async function test() {
    setBusy(true)
    try { const r = await c.api.testT3(); c.flash(r.ok ? 'T3 connection works' : r.error ?? 'Connection test failed', !r.ok); await load() }
    catch (e) { c.flash(errText(e), true) } finally { setBusy(false) }
  }
  async function saveSetting(k: string, v: string) {
    try { await c.api.setSetting(k, v); await load(); c.flash('Saved') } catch (e) { c.flash(errText(e), true) }
  }
  async function flipLive() {
    const msg = live
      ? 'Switch to Dry run?\n\nThe app will only check to-dos with METRC (through T3) and won\'t change anything in METRC. Auto stops.'
      : 'Switch to LIVE?\n\nSend buttons and Auto kinds will change packages in METRC for real, as the app\'s METRC user. Try a few with Dry run first.'
    if (!confirm(msg)) return
    await saveSetting('comp.metrc_live', live ? 'false' : 'true')
  }
  async function mode(k: PushKind, m: PushKind['mode']) {
    if (m === 'auto' && !confirm(`Put "${k.label}" on Auto?\n\nWhen Live, the app sends these every 5 minutes without anyone tapping Send.`)) return
    try { await c.api.setPushMode(k.kind, m); await load(); c.flash(`${k.label}: ${MODE[m]}`) } catch (e) { c.flash(errText(e), true) }
  }

  const allReasons = [...new Set(Object.values(conn?.reasons ?? {}).flat().map(r => r.name))].sort()
  const who = conn?.who && !('error' in conn.who) ? String(conn.who.username ?? conn.who.userName ?? conn.who.name ?? conn.who.email ?? '') : ''
  const phases = [...new Set(kinds.map(k => k.phase))].sort((a, b) => a - b)

  return <Fold id="comp.set.t3" open title="METRC through T3" right={<button className="ghost small" disabled={busy} onClick={test}>{busy ? 'Testing…' : 'Test connection'}</button>}>
    {err && <p className="neg small">{err}</p>}
    <p className="muted">The app sends METRC to-dos through T3 as its own METRC user (the T3 secret key in Vercel). Start on <b>Dry run</b>: T3 checks each to-do against METRC without changing anything. Switch to <b>Live</b> once the checks look right.</p>

    <div className="infobox">
      {!conn?.tested_at ? <span>Not tested yet. Tap <b>Test connection</b>.</span> : <>
        <div><span className={`pill ${conn.ok ? 'cp-ok' : 'cp-bad'}`}>{conn.ok ? 'Connected' : 'Problem'}</span> <span className="muted small">tested {when(conn.tested_at)} by {conn.tested_by?.split('@')[0]}</span>{who && <span className="small"> · METRC user <b>{who}</b></span>}</div>
        {conn.error && <div className="neg small" style={{ marginTop: 4 }}>{conn.error}</div>}
        {!!conn.licenses?.length && <div className="dlist" style={{ marginTop: 8 }}>{conn.licenses.map(l => <div key={l.license} className="drow">
          <span className="grow"><b>{l.site ?? ''}</b> <span className="mono small">{l.license}</span> <span className="muted small">{l.name ?? ''}</span>
            {l.reasons_error && <div className="neg small">{l.reasons_error}</div>}</span>
          <span className="small muted">{l.in_t3 ? `${conn.reasons?.[l.license]?.length ?? 0} adjust reasons` : ''}</span>
          <span className={`pill ${l.in_t3 ? 'cp-ok' : l.in_app ? 'cp-bad' : 'cp-mute'}`}>{l.in_t3 ? 'Can reach' : l.in_app ? 'Not on this user' : 'Not in the app'}</span>
        </div>)}</div>}
      </>}
    </div>

    <div className="row wrap" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
      <span>Sending is</span><span className={`pill ${live ? 'cp-bad' : 'cp-warn'}`}>{live ? 'LIVE' : 'Dry run'}</span>
      <button className={live ? 'ghost' : 'primary'} disabled={!c.isAdmin || (!live && !conn?.ok)} onClick={flipLive}>{live ? 'Back to Dry run' : 'Go Live'}</button>
      {!live && !conn?.ok && <span className="muted small">Test the connection first.</span>}
    </div>

    <h3 style={{ marginTop: 14 }}>Weight adjustment reasons</h3>
    <p className="muted small">Which METRC reason each app reason uses. The list comes from METRC when you test the connection.</p>
    <div className="grid2">{REASONS.map(([k, l]) => {
      const key = `comp.metrc_reason_${k}`; const v = set[key] ?? ''
      const missing = allReasons.length > 0 && v && !allReasons.some(n => n.toLowerCase() === v.toLowerCase())
      return <F key={k} label={l} hint={missing ? `"${v}" isn't one of METRC's reasons` : undefined}>
        {allReasons.length ? <Select value={allReasons.find(n => n.toLowerCase() === v.toLowerCase()) ?? ''} disabled={!c.isAdmin} onChange={e => saveSetting(key, e.target.value)}>
          <option value="">Pick…</option>{allReasons.map(n => <option key={n} value={n}>{n}</option>)}</Select>
          : <span className="muted small">{v || 'not set'} (test the connection to pick from METRC's list)</span>}
      </F>
    })}</div>

    <h3 style={{ marginTop: 14 }}>What the app sends</h3>
    <p className="muted small"><b>Off</b>: done by hand in METRC, checked off on the To do list. <b>Approve</b>: a Send button on each to-do. <b>Auto</b>: sent every 5 minutes while Live. Kinds the app can't send yet show their phase.</p>
    <div className="tablewrap"><table className="ct"><thead><tr><th>Kind</th><th>How</th><th className="hide-s">Changed</th></tr></thead>
      <tbody>{phases.map(ph => kinds.filter(k => k.phase === ph).map((k, i) => <tr key={k.kind}>
        <td>{i === 0 && <div className="muted small">Phase {ph}</div>}<b>{k.label}</b></td>
        <td>{k.ready ? <Select value={k.mode} disabled={!c.isAdmin} onChange={e => mode(k, e.target.value as PushKind['mode'])}>
          {(Object.keys(MODE) as PushKind['mode'][]).map(m => <option key={m} value={m}>{MODE[m]}</option>)}</Select>
          : <span className="muted small">by hand (coming in phase {k.phase})</span>}</td>
        <td className="muted small hide-s">{k.updated_by ? `${k.updated_by.split('@')[0]} ${when(k.updated_at)}` : ''}</td>
      </tr>))}</tbody></table></div>
    <T3More c={c} conn={conn} set={set} save={async (k, v) => { try { await c.api.setSetting(k, v); await load(); c.flash('Saved') } catch (e) { c.flash(errText(e), true) } }} />
    <ItemRules c={c} />
  </Fold>
}
