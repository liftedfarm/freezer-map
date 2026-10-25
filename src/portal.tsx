import { SampleHolds } from './samples'
import { CustomerDashboard } from './statement'
import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { Balance, LinkInfo, Me, ReserveRequest, ReserveYears, Terms } from './types'

const n0 = (x: number) => Math.round(x).toLocaleString()
import { MyOrders, MyReserves } from './reserves'
import { OpenMenu, OrderForm } from './menu'

const clean = () => history.replaceState(null, '', location.pathname)

function Shell({ children }: { children: React.ReactNode }) {
  useEffect(() => { document.title = 'Lifted Farms Orders' }, [])
  return (
    <div className="center login portal-auth">
      <img className="logo-login logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-login logo-d" src="/logo-dark.svg" alt="Lifted Farms" />
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
        <div className="brand"><img className="logo-img logo-l" src="/logo-light.svg" alt="Lifted Farms" /><img className="logo-img logo-d" src="/logo-dark.svg" alt="Lifted Farms" /> <span className="app-name">Orders</span></div>
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
        <CustomerDashboard backend={backend} rev={rev} />
        <div className="portal-soon" key={rev}>
          <h3>Orders</h3><MyOrders backend={backend} onChange={m => { setMsg(m); setRev(r => r + 1) }} />
          {reserves && future.map(y => <div key={y.year}><h3>{y.year} reserves</h3><ReserveTable backend={backend} year={y.year} current={false} deadline={y.deadline} open={y.open} onMsg={setMsg} /></div>)}
          {reserves && ys && <><h3>{ys.current} reserves</h3><ReserveTable backend={backend} year={ys.current} current deadline={null} open onMsg={setMsg} /></>}
          {reserves && !ys && <><h3>Your reserves</h3><MyReserves backend={backend} /></>}
          <SampleHolds backend={backend} title="Held for you" rev={rev} />
          <h3>Open menu</h3>{terms !== undefined && <OpenMenu backend={backend} reserves={reserves} />}
        </div>
      </main>
      {ordering && <OrderForm backend={backend} reserves={reserves} onClose={() => setOrdering(false)} onDone={m => { setOrdering(false); setMsg(m); setRev(r => r + 1) }} />}
    </div>
  )
}

// ---------- reserves for one crop year: see them, and ask for changes as one batch ----------
export function ReserveTable({ backend, year, current, deadline, open, onMsg }: {
  backend: Backend; year: number; current: boolean; deadline: string | null; open: boolean; onMsg: (m: string) => void
}) {
  const [rows, setRows] = useState<Balance[] | null>(null)
  const [reqs, setReqs] = useState<ReserveRequest[]>([])
  const [names, setNames] = useState<string[]>([])
  const [avail, setAvail] = useState<Map<string, number>>(new Map())
  const [price, setPrice] = useState<number | null>(null)
  const [edit, setEdit] = useState<Record<string, string> | null>(null)
  const [extra, setExtra] = useState<string[]>([])
  const [add, setAdd] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => Promise.all([backend.listBalances(), backend.listRequests().catch(() => [] as ReserveRequest[])])
    .then(([b, r]) => { setRows(b.filter(x => (x.crop_year ?? year) === year)); setReqs(r.filter(x => (x.crop_year ?? year) === year && x.status === 'pending')) }).catch(() => setRows([]))
  useEffect(() => {
    load()
    if (current) backend.openMenu().then(m => { const a = new Map<string, number>(); for (const x of m) if (x.crop_year === year) a.set(x.strain, Number(x.available)); setAvail(a); setNames([...a.keys()].sort((p, q) => p.localeCompare(q))) }).catch(() => {})
    else backend.reserveStrains().then(setNames).catch(() => {})
    if (!current) backend.myTermsFor(year).then(t => setPrice(t?.price_per_lb ?? null)).catch(() => {})
  }, [year])
  if (!rows) return <p className="muted">Loading…</p>
  const lc = (x: string) => x.toLowerCase()
  const bal = (st: string) => rows.find(r => lc(r.strain) === lc(st))
  const req = (st: string) => reqs.find(r => lc(r.strain) === lc(st))
  const strains = [...new Set([...rows.map(r => r.strain), ...reqs.map(r => r.strain), ...extra])].sort((a, b) => a.localeCompare(b))
  const target = (st: string) => req(st) ? Number(req(st)!.requested_lbs) : Number(bal(st)?.reserved ?? 0)
  const changed = edit ? strains.filter(st => edit[st] !== undefined && edit[st] !== '' && Number(edit[st]) !== target(st)) : []
  const dlText = deadline ? new Date(deadline + 'T12:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : null
  const sum = (f: (st: string) => number) => strains.reduce((a, st) => a + f(st), 0)
  function startEdit() { setEdit(Object.fromEntries(strains.map(st => [st, String(target(st))]))); setNote('') }
  function addStrain() {
    const nm = names.find(n => lc(n) === lc(add.trim()))
    if (!nm) { onMsg(current ? `${add} isn't on the open menu` : `Pick a strain from the list`); return }
    if (!strains.some(st => lc(st) === lc(nm))) setExtra([...extra, nm])
    setEdit(e => ({ ...(e ?? {}), [nm]: e?.[nm] ?? '' })); setAdd('')
  }
  async function send() {
    if (!edit) return
    const bad = changed.find(st => !(Number(edit[st]) >= 0) || Number(edit[st]) % 10 !== 0)
    if (bad) { onMsg(`${bad}: use a number of lbs in steps of 10`); return }
    setBusy(true)
    try {
      const n = await backend.requestReserveBatch(year, changed.map(st => ({ strain: st, lbs: Number(edit[st]) })), note)
      setEdit(null); setExtra([]); await load()
      onMsg(`Sent ${n} reserve change${n === 1 ? '' : 's'} for ${year}. Lifted will review ${n === 1 ? 'it' : 'them'}.`)
    } catch (e) { onMsg(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return (
    <div className="card-ish wide">
      {!current && <p className="muted">{open ? `Ask for the strains and lbs you want from the ${year} crop. Requests are open until ${dlText}. Lifted reviews each one.` : `${year} requests closed${dlText ? ` on ${dlText}` : ''}.`}
        {price != null && <> Your {year} price: ${price.toFixed(2)}/lb.</>}</p>}
      {strains.length === 0 && !edit && <p className="muted">No {year} reserves yet.</p>}
      {(strains.length > 0 || edit) && (
        <table className="restable">
          <thead><tr><th>Strain</th><th className="num">Reserved</th>{current && <th className="num">Shipped</th>}{current && <th className="num">Left</th>}
            <th className="num">{edit ? 'New total' : 'Waiting'}</th>{edit && current && <th className="num">Open now</th>}</tr></thead>
          <tbody>{strains.map(st => { const b = bal(st), q = req(st)
            return (
              <tr key={st} className={edit && changed.includes(st) ? 'picked' : ''}>
                <td>{st}</td><td className="num">{b ? n0(Number(b.reserved)) : ''}</td>
                {current && <td className="num">{b ? n0(Number(b.shipped) + Number(b.pending)) : ''}</td>}
                {current && <td className="num"><b>{b ? n0(Number(b.remaining)) : ''}</b></td>}
                <td className="num">{edit
                  ? <input className="qty" type="number" min="0" step="10" value={edit[st] ?? ''} onChange={e => setEdit({ ...edit, [st]: e.target.value })} aria-label={`New total for ${st}`} />
                  : q ? <span className="pill r-pending">{n0(Number(q.requested_lbs))} asked</span> : ''}</td>
                {edit && current && <td className="num">{avail.has(st) ? n0(avail.get(st)!) : ''}</td>}
              </tr>
            ) })}</tbody>
          {!edit && <tfoot><tr><td><b>Total lbs</b></td><td className="num"><b>{n0(sum(st => Number(bal(st)?.reserved ?? 0)))}</b></td>
            {current && <td className="num">{n0(sum(st => Number(bal(st)?.shipped ?? 0) + Number(bal(st)?.pending ?? 0)))}</td>}
            {current && <td className="num"><b>{n0(sum(st => Number(bal(st)?.remaining ?? 0)))}</b></td>}<td /></tr></tfoot>}
        </table>
      )}
      {open && !edit && <button className="primary" onClick={startEdit}>{strains.length ? 'Request changes' : `Request ${year} reserves`}</button>}
      {edit && (
        <div className="authform">
          <div className="row">
            <input list={`rs-${year}`} value={add} onChange={e => setAdd(e.target.value)} placeholder={current ? 'Add a strain from the open menu' : 'Add a strain'}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addStrain() } }} />
            <datalist id={`rs-${year}`}>{names.map(n => <option key={n} value={n} />)}</datalist>
            <button className="ghost small" onClick={addStrain}>Add</button>
          </div>
          <p className="muted">Type the total lbs you want reserved for each strain (steps of 10; 0 drops it). Only the lines you change are sent.{current && ' You can go up by what\'s open now.'}</p>
          <div className="field"><label>Note <span className="muted">(optional)</span></label><input value={note} onChange={e => setNote(e.target.value)} /></div>
          <div className="row"><button className="primary" disabled={busy || !changed.length} onClick={send}>Send {changed.length || ''} change{changed.length === 1 ? '' : 's'}</button>
            <button className="ghost" onClick={() => { setEdit(null); setExtra([]) }}>Cancel</button></div>
        </div>
      )}
    </div>
  )
}
