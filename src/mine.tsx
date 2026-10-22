import { useState } from 'react'
import type { Backend } from './api'
import { MODULES } from './types'
import type { Me, ModKey, Prefs, Site } from './types'
import { applyTheme } from './theme'

/** Top bar ⚙: your own settings. Nothing here changes anyone else's view. */
export function MySettings({ backend, me, flash, onSaved }: { backend: Backend; me: Me; flash: (t: string, bad?: boolean) => void; onSaved: (p: Prefs, name: string | null) => void }) {
  const p = me.access.prefs ?? {}
  const [name, setName] = useState(me.display_name ?? '')
  const [busy, setBusy] = useState(false)
  const mine = MODULES.filter(m => me.access.modules[m.key])
  const lv = me.access.modules
  async function savePref(x: Prefs, msg = 'Saved') {
    setBusy(true)
    try { const out = await backend.setMyPrefs(x); onSaved(out, null); flash(msg) }
    catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  async function saveName() {
    setBusy(true)
    try { await backend.setMyName(name); onSaved(p, name.trim() || null); flash('Name saved') }
    catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  const seg = <T extends string>(val: T | undefined, opts: [T, string][], on: (v: T) => void) => (
    <div className="seg">{opts.map(([v, l]) => <button key={v} disabled={busy} className={val === v ? 'on' : ''} onClick={() => on(v)}>{l}</button>)}</div>
  )
  return (
    <div className="list mine">
      <h2>My settings</h2>
      <p className="muted">Just for you. Signed in as {me.real_email ?? me.email}{me.viewing_as ? ` (viewing as ${me.email}: changes are off)` : ''}.</p>

      <section className="dcard"><h3>Name</h3>
        <div className="row"><input value={name} placeholder="What the app shows" onChange={e => setName(e.target.value)} />
          <button className="primary small" disabled={busy || name.trim() === (me.display_name ?? '')} onClick={saveName}>Save</button></div>
        <p className="muted">Shows on your activity and in the top bar.</p></section>

      <section className="dcard"><h3>Look</h3>
        {seg(p.theme ?? 'system', [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], v => { applyTheme(v); savePref({ theme: v }, 'Theme saved') })}
      </section>

      <section className="dcard"><h3>When the app opens</h3>
        {mine.length > 1 && <div className="field"><label>Start in</label>
          {seg(p.start_module ?? '' as ModKey, [['' as ModKey, 'Where I left off'], ...mine.map(m => [m.key, m.label] as [ModKey, string])], v => savePref({ start_module: (v || null) as unknown as ModKey }))}</div>}
        {lv.distribution && <div className="field"><label>Freezer site</label>
          {seg(p.start_site ?? 'OHR' as Site, [['OHR', 'OHR'], ['GVR', 'GVR']], v => savePref({ start_site: v }))}</div>}
      </section>

      {lv.sales && <section className="dcard"><h3>Emails</h3>
        {lv.sales === 'admin' && <label className="check"><input type="checkbox" disabled={busy} checked={p.notify?.requests !== false}
          onChange={e => savePref({ notify: { ...p.notify, requests: e.target.checked } })} /><span><b>Reserve requests</b> <span className="muted">when a customer asks to change a reserve</span></span></label>}
        <label className="check"><input type="checkbox" disabled={busy} checked={p.notify?.orders !== false}
          onChange={e => savePref({ notify: { ...p.notify, orders: e.target.checked } })} /><span><b>New orders</b> <span className="muted">when a customer places an order in the portal</span></span></label>
      </section>}

      <section className="dcard"><h3>What you can use</h3>
        {me.access.owner ? <p>Owner: every module, as Admin.</p> : mine.length ? <div className="dlist">{mine.map(m => (
          <div key={m.key} className="drow"><span><b>{m.label}</b><span className="muted"> · {lv[m.key] === 'admin' && m.key !== 'admin' ? `${m.user} ${m.admin}` : m.user}</span></span><span className="pill">{m.key === 'admin' ? 'On' : lv[m.key] === 'admin' ? 'Admin' : 'User'}</span></div>))}</div>
          : <p className="muted">Nothing yet.</p>}
        <p className="muted">Ask someone with the Admin module if you need more.</p>
      </section>
    </div>
  )
}
