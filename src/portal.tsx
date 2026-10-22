import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { Balance, LinkInfo, Me, ReserveRequest, ReserveYears, Terms } from './types'
import { MyOrders, MyReserves } from './reserves'
import { OpenMenu, OrderForm } from './menu'

const clean = () => history.replaceState(null, '', location.pathname)

function Shell({ children }: { children: React.ReactNode }) {
  useEffect(() => { document.title = 'Lifted Farms Orders' }, [])
  return (
    <div className="center login portal-auth">
      <img className="logo-login" src="/logo-big.png" alt="Lifted Farms" />
      {children}
    </div>
  )
}

function PasswordPair({ pw, setPw, pw2, setPw2 }: { pw: string; setPw: (v: string) => void; pw2: string; setPw2: (v: string) => void }) {
  return (
    <>
      <div className="field"><label>Password <span className="muted">(8+ characters)</span></label>
        <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></div>
      <div className="field"><label>Password again</label>
        <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></div>
      {pw2.length > 0 && pw !== pw2 && <div className="warn-t">Passwords don't match</div>}
    </>
  )
}

export function PortalLogin({ backend, onDone }: { backend: Backend; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null)
    try { await backend.passwordSignIn(email, pw); onDone() } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }
  return (
    <Shell>
      <h1>Lifted Farms Orders</h1>
      <form className="authform" onSubmit={go}>
        <div className="field"><label>Email</label>
          <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} autoFocus /></div>
        <div className="field"><label>Password</label>
          <input type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></div>
        {err && <div className="warn-t">{err}</div>}
        <button className="primary big" disabled={busy || !email || !pw}>Sign in</button>
      </form>
      <p className="muted">New here or forgot your password? Ask your Lifted contact for a link.</p>
    </Shell>
  )
}

// opened from an invite or reset link
export function PortalLink({ backend, kind, code, onDone }: { backend: Backend; kind: 'invite' | 'reset'; code: string; onDone: () => void }) {
  const [info, setInfo] = useState<LinkInfo | null | undefined>(undefined)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { backend.signOut().then(() => backend.checkLink(code)).then(i => setInfo(i && i.kind === kind ? i : null)).catch(e => { setErr(String(e.message ?? e)); setInfo(null) }) }, [code])

  async function go(e: React.FormEvent) {
    e.preventDefault(); if (!info) return
    setBusy(true); setErr(null)
    try {
      if (kind === 'invite') await backend.claimInvite(code, info.email, pw)
      else { await backend.resetPassword(code, pw); await backend.passwordSignIn(info.email, pw) }
      clean(); onDone()
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  if (info === undefined) return <Shell><p className="muted">Checking your link…</p></Shell>
  if (!info) return (
    <Shell>
      <h2>This link doesn't work</h2>
      <p className="muted">{err ?? 'It may have expired or already been used.'} Ask your Lifted contact for a new one.</p>
      <button className="ghost" onClick={() => { clean(); onDone() }}>Go to sign in</button>
    </Shell>
  )
  const ok = pw.length >= 8 && pw === pw2
  return (
    <Shell>
      <h1>{kind === 'invite' ? `Welcome${info.display_name ? `, ${info.display_name}` : ''}` : 'Set a new password'}</h1>
      <p className="muted">{kind === 'invite' ? `Set a password for the ${info.customer_name ?? ''} ordering portal.` : 'Pick a new password for your login.'}</p>
      <form className="authform" onSubmit={go}>
        <div className="field"><label>Email</label><input type="email" autoComplete="username" value={info.email} disabled /></div>
        <PasswordPair pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        {err && <div className="warn-t">{err}</div>}
        <button className="primary big" disabled={busy || !ok}>{kind === 'invite' ? 'Create my login' : 'Save password'}</button>
      </form>
    </Shell>
  )
}

export function Portal({ backend, me, signOut }: { backend: Backend; me: Me; signOut: () => void }) {
  useEffect(() => { document.title = 'Lifted Farms Orders' }, [])
  const [pwOpen, setPwOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [ordering, setOrdering] = useState(false)
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined)
  useEffect(() => { backend.myTerms().then(setTerms).catch(() => setTerms(null)) }, [])
  const [ys, setYs] = useState<ReserveYears | null>(null)
  useEffect(() => { backend.reserveYears().then(setYs).catch(() => {}) }, [])
  const future = (ys?.years ?? []).filter(y => y.year > (ys?.current ?? 9999))
  const reserves = !!terms?.reserves_enabled
  const [rev, setRev] = useState(0)
  async function change(e: React.FormEvent) {
    e.preventDefault()
    try { await backend.changePassword(pw); setMsg('Password changed'); setPwOpen(false); setPw(''); setPw2('') }
    catch (x) { setMsg((x as Error).message) }
  }
  return (
    <div className="app portal">
      <header className="top">
        <div className="brand"><img className="logo-img" src="/logo.png" alt="Lifted Farms" /> <span className="app-name">Orders</span></div>
        <span className="grow" />
        {!me.viewing_as && <button className="ghost small" onClick={() => setPwOpen(!pwOpen)}>Password</button>}
        {!me.viewing_as && <button className="ghost small" onClick={signOut}>Sign out</button>}
      </header>
      <main className="list">
        <div className="row between portal-head">
          <div><h2>{me.customer_name}</h2>
            <p className="muted">Signed in as {me.display_name ? `${me.display_name} (${me.email})` : me.email}</p></div>
          <button className="primary big" onClick={() => setOrdering(true)}>Place an order</button>
        </div>
        {msg && <div className="okbox">{msg} <a onClick={() => setMsg(null)}>Dismiss</a></div>}
        {pwOpen && (
          <form className="authform card-ish" onSubmit={change}>
            <PasswordPair pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
            <button className="primary" disabled={pw.length < 8 || pw !== pw2}>Change password</button>
          </form>
        )}
        <div className="portal-soon" key={rev}>
          <h3>Orders</h3><MyOrders backend={backend} onChange={m => { setMsg(m); setRev(r => r + 1) }} />
          {reserves && future.map(y => <div key={y.year}><h3>{y.year} reserves</h3><FutureReserves backend={backend} year={y.year} deadline={y.deadline} open={y.open} onMsg={setMsg} /></div>)}
          {reserves && <><h3>{ys ? `${ys.current} reserves` : 'Your reserves'}</h3><MyReserves backend={backend} year={ys?.current} /></>}
          <h3>Open menu</h3>{terms !== undefined && <OpenMenu backend={backend} reserves={reserves} />}
        </div>
      </main>
      {ordering && <OrderForm backend={backend} reserves={reserves} onClose={() => setOrdering(false)} onDone={m => { setOrdering(false); setMsg(m); setRev(r => r + 1) }} />}
    </div>
  )
}

// ---------- next crop: ask for reserves before the deadline ----------
export function FutureReserves({ backend, year, deadline, open, onMsg }: { backend: Backend; year: number; deadline: string | null; open: boolean; onMsg: (m: string) => void }) {
  const [rows, setRows] = useState<Balance[] | null>(null)
  const [reqs, setReqs] = useState<ReserveRequest[]>([])
  const [names, setNames] = useState<string[]>([])
  const [price, setPrice] = useState<number | null>(null)
  const [f, setF] = useState<{ strain: string; lbs: string; note: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => Promise.all([backend.listBalances(), backend.listRequests().catch(() => [] as ReserveRequest[])])
    .then(([b, r]) => { setRows(b.filter(x => x.crop_year === year)); setReqs(r.filter(x => x.crop_year === year)) }).catch(() => setRows([]))
  useEffect(() => {
    load()
    backend.reserveStrains().then(setNames).catch(() => {})
    backend.myTermsFor(year).then(t => setPrice(t?.price_per_lb ?? null)).catch(() => {})
  }, [year])
  if (!rows) return <p className="muted">Loading…</p>
  const pending = reqs.filter(r => r.status === 'pending')
  const strains = [...new Set([...rows.map(r => r.strain), ...pending.map(r => r.strain)])].sort((a, b) => a.localeCompare(b))
  const resOf = (s: string) => Number(rows.find(r => r.strain.toLowerCase() === s.toLowerCase())?.reserved ?? 0)
  const reqOf = (s: string) => pending.find(r => r.strain.toLowerCase() === s.toLowerCase())
  const dlText = deadline ? new Date(deadline + 'T12:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : null
  const total = strains.reduce((a, s) => a + resOf(s), 0)
  async function send() {
    if (!f) return
    const n = Number(f.lbs)
    if (!f.strain.trim() || !(n >= 0) || n % 10 !== 0) { onMsg('Pick a strain and enter lbs in multiples of 10'); return }
    setBusy(true)
    try { await backend.requestReserve(f.strain.trim(), n, f.note, year); setF(null); await load(); onMsg(`Request sent: ${f.strain} ${n.toLocaleString()} lbs for ${year}. Lifted will review it.`) }
    catch (e) { onMsg(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return (
    <div className="card-ish">
      <p className="muted">{open ? `Ask for the strains and lbs you want from the ${year} crop. Requests are open until ${dlText}. Lifted reviews each one.` : `${year} requests closed${dlText ? ` on ${dlText}` : ''}.`}
        {price != null && <> Your {year} price: ${price.toFixed(2)}/lb.</>}</p>
      {strains.length > 0 && (
        <table className="restable">
          <thead><tr><th>Strain</th><th className="num">Reserved</th><th className="num">Requested</th><th /></tr></thead>
          <tbody>{strains.map(s => { const q = reqOf(s)
            return <tr key={s}><td>{s}</td><td className="num">{resOf(s) ? resOf(s).toLocaleString() : ''}</td>
              <td className="num">{q ? <span className="pill r-pending">{Number(q.requested_lbs).toLocaleString()} waiting</span> : ''}</td>
              <td className="num">{open && <a onClick={() => setF({ strain: s, lbs: String(q ? q.requested_lbs : resOf(s)), note: '' })}>Change</a>}
                {q && <> · <a onClick={async () => { try { await backend.cancelRequest(q.id); await load() } catch (e) { onMsg(String((e as Error).message ?? e)) } }}>Cancel</a></>}</td></tr> })}</tbody>
          <tfoot><tr><td><b>Total reserved</b></td><td className="num"><b>{total.toLocaleString()}</b></td><td /><td /></tr></tfoot>
        </table>
      )}
      {open && !f && <button className="primary" onClick={() => setF({ strain: '', lbs: '', note: '' })}>+ Request a {year} reserve</button>}
      {open && f && (
        <div className="authform">
          <div className="field"><label>Strain</label>
            <input list="future-strains" value={f.strain} onChange={e => setF({ ...f, strain: e.target.value })} placeholder="Start typing" autoFocus />
            <datalist id="future-strains">{names.map(n => <option key={n} value={n} />)}</datalist></div>
          <div className="field"><label>Total lbs you want reserved <span className="muted">(multiples of 10; 0 to drop it)</span></label>
            <input type="number" min="0" step="10" value={f.lbs} onChange={e => setF({ ...f, lbs: e.target.value })} /></div>
          <div className="field"><label>Note <span className="muted">(optional)</span></label>
            <input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></div>
          <div className="row"><button className="primary" disabled={busy} onClick={send}>Send request</button><button className="ghost" onClick={() => setF(null)}>Cancel</button></div>
        </div>
      )}
    </div>
  )
}
