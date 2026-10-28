import { useEffect, useRef, useState } from 'react'
import type { Backend } from './api'
import { clock, computeBonus, hm, SPEED_MAX, SPEED_RED, SPEED_YELLOW, speedLevel } from './cult/bonuscalc'
import type { BonusData, BonusView, Level } from './cult/bonuscalc'
import './bonus.css'

// Live Bonus: the TV screen in the pack shed. Public link /?bonus=<token> (one per site, from Production > Harvest).
// No login. Refreshes every 20 seconds; the clock ticks in between. Spanish on purpose: it's for the crew.

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const fecha = (day: string) => { const d = new Date(`${day}T12:00:00`); return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}` }
const money = (n: number) => `$${n.toFixed(2)}`
const n0 = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (n: number, max: number) => `${Math.max(0, Math.min(100, (n / max) * 100)).toFixed(1)}%`
const STATUS: Record<Level, string> = { g: 'VAN BIEN · EN CAMINO', y: 'CERCA · HAY QUE APURAR', r: 'LEJOS DE LA META', wait: 'ESPERANDO LA PRIMERA TARIMA' }
const MISSING: Record<string, string> = { 'box start': 'hora de la primera caja', people: 'personas', buckers: 'buckers', 'La Meta': 'la meta' }

export function BonusScreen({ backend, token }: { backend: Backend; token: string }) {
  const [d, setD] = useState<BonusData | null | undefined>(undefined)
  const [at, setAt] = useState(Date.now())
  const [, tick] = useState(0)
  const day = new URLSearchParams(location.search).get('day')
  const stage = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ s: 1, x: 0, y: 0 })

  useEffect(() => {
    document.title = 'Bono en vivo · Lifted Farms'
    document.documentElement.lang = 'es'
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700;800&family=Barlow:wght@500;600&display=swap'
    document.head.appendChild(l)
  }, [])
  useEffect(() => {
    const sb = backend.client()
    if (!sb) { setD(null); return }
    let stop = false
    const load = () => sb.rpc('bonus_live', { p_token: token, p_day: day || null }).then(({ data, error }) => {
      if (stop) return
      if (error) { if (d === undefined) setD(null); return }       // keep the last good numbers on a blip
      setD((data ?? null) as BonusData | null); setAt(Date.now())
    })
    load()
    const a = setInterval(load, 20000), b = setInterval(() => tick(x => x + 1), 15000)
    return () => { stop = true; clearInterval(a); clearInterval(b) }
  }, [token])
  useEffect(() => {
    const go = () => { const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080); setFit({ s, x: (window.innerWidth - 1920 * s) / 2, y: (window.innerHeight - 1080 * s) / 2 }) }
    go(); window.addEventListener('resize', go)
    return () => window.removeEventListener('resize', go)
  }, [])

  if (d === undefined) return <div className="bz-wrap"><p className="bz-msg">Cargando…</p></div>
  if (!d) return <div className="bz-wrap"><p className="bz-msg">Este enlace no funciona. Pide uno nuevo en Producción › Cosecha.</p></div>
  const nowMin = d.now_min + (d.is_today ? (Date.now() - at) / 60000 : 0)
  const v = computeBonus(d, nowMin)
  return (
    <div className="bz-wrap">
      <div className={`bz${!v.ready || v.onBreak ? ' banner' : ''}`} ref={stage} style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.s})` }} data-level={v.level}>
        <div className="bz-top">
          <div className="bz-brand"><img className="bz-logo" src="/logo-light.svg" alt="Lifted Farms" /><span className="bz-dim">Cosecha en vivo · {d.site}</span></div>
          <div className="bz-var"><span className="bz-cap">Variedad ahora</span><b>{v.variety ?? '—'}</b></div>
          <div className="bz-clock"><b>{v.ended ? `Terminó ${clock(hm(v.ended)!)}` : d.is_today ? clock(nowMin) : 'Día cerrado'}</b><span className="bz-dim">{fecha(d.day)}</span></div>
        </div>
        {(!v.ready || v.onBreak) && <div className="bz-banner">
          {v.onBreak ? (v.onBreak.kind === 'pause' ? `Línea en pausa desde ${clock(hm(v.onBreak.start_at)!)}. El tiempo no cuenta.` : `${v.onBreak.kind === 'lunch' ? 'Almuerzo' : 'Descanso'} desde ${clock(hm(v.onBreak.start_at)!)}. El tiempo no cuenta.`)
            : `Falta en la tarjeta del día: ${v.missing.map(m => MISSING[m] ?? m).join(', ')}`}</div>}
        <div className="bz-main">
          <Hero v={v} />
          <div className="bz-col">
            <Meta v={v} />
            <Speed v={v} />
          </div>
        </div>
        <Bottom v={v} />
      </div>
    </div>
  )
}

function Hero({ v }: { v: BonusView }) {
  // the bonus rate they've built so far: only goes up as pallets come in (never a projection that can drop)
  const over = !!v.ended && !v.won
  const rate = v.packed > 0 ? v.bonusRate : 0
  const label = v.won ? 'Bono ganado · por hora' : over ? 'Sin bono hoy' : 'Bono acumulado · por hora'
  const big = over ? money(0) : money(rate)
  const sub = over ? (v.corr != null && v.hurdle != null ? `Faltaron ${n0(v.hurdle - v.corr)} libras por persona.` : '')
    : v.ended && v.won ? `Día terminado. ${n0(v.packed)} libras empacadas.`
    : v.level === 'wait' ? (v.pallets ? 'Completen la tarjeta del día en Producción › Cosecha.' : 'Los números empiezan con la primera tarima.')
    : v.won ? 'Sube con cada libra que empaquen.'
    : v.corr != null && v.hurdle != null ? `Se gana al llegar a la meta: faltan ${n0(v.hurdle - v.corr)} libras por persona.` : ''
  return (
    <div className="bz-card bz-hero">
      <div className="bz-pill"><i />{v.won ? '¡META ALCANZADA!' : over ? 'DÍA TERMINADO' : v.level === 'wait' && v.pallets ? 'FALTAN DATOS DEL DÍA' : STATUS[v.level]}</div>
      <div className="bz-herorow">
        <div className="bz-herobody">
          <div className="bz-herolab">{label}</div>
          <div className={`bz-heroval${v.won ? ' won' : ''}`}>{big}</div>
          <div className="bz-herosub">{sub}</div>
        </div>
        <StatusIcon level={v.level} won={v.won} />
      </div>
      <div className="bz-pay">
        <div><span className="bz-cap">Pago por hora ahora</span><b>{money(v.hourly + (v.won ? rate : 0))}</b></div>
        {!v.won && !over && <div><span className="bz-cap">Con la meta</span><b>{money(v.hourly + rate)}</b></div>}
        <div><span className="bz-cap">Base</span><b className="bz-dim">{money(v.hourly)}</b></div>
      </div>
    </div>
  )
}

/** big status symbol: shape and color both change, so it reads from across the shed and for color-blind crew */
function StatusIcon({ level, won }: { level: Level; won: boolean }) {
  const dark = '#0D1310'
  if (won || level === 'g') return (
    <svg className={`bz-icon${won ? ' won' : ''}`} viewBox="0 0 100 100" role="img" aria-label="En meta">
      <circle cx="50" cy="50" r="46" fill="var(--gi)" />
      <path d="M28 52 L44 67 L73 35" fill="none" stroke="#FFFFFF" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>)
  if (level === 'y') return (
    <svg className="bz-icon" viewBox="0 0 100 100" role="img" aria-label="Cerca">
      <path d="M50 6 Q54 6 56.5 10.5 L95 82 Q97.5 88 91 90 L9 90 Q2.5 88 5 82 L43.5 10.5 Q46 6 50 6 Z" fill="var(--yi)" />
      <rect x="44" y="30" width="12" height="34" rx="6" fill={dark} />
      <circle cx="50" cy="76" r="7" fill={dark} />
    </svg>)
  if (level === 'r') return (
    <svg className="bz-icon" viewBox="0 0 100 100" role="img" aria-label="Lejos">
      <path d="M31 4 H69 L96 31 V69 L69 96 H31 L4 69 V31 Z" fill="var(--ri)" />
      <path d="M33 33 L67 67 M67 33 L33 67" stroke="#FFFFFF" strokeWidth="11" strokeLinecap="round" />
    </svg>)
  return (
    <svg className="bz-icon" viewBox="0 0 100 100" role="img" aria-label="Esperando">
      <circle cx="50" cy="50" r="43" fill="none" stroke="#B5C2BA" strokeWidth="7" />
      <path d="M50 24 V50 L66 62" fill="none" stroke="#56665D" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>)
}

function Meta({ v }: { v: BonusView }) {
  const meta = v.hurdle ?? 0, corr = v.corr ?? 0
  const scale = Math.max(meta * 1.25, corr * 1.05, 1)
  const left = meta && v.corr != null ? Math.max(0, meta - corr) : null
  return (
    <div className="bz-card bz-sm">
      <div className="bz-head"><b>La meta</b><span className="bz-dim">libras por persona hoy</span></div>
      <div className="bz-nums">
        <div><span className="bz-cap">Ahora</span><b className={`bz-xl${v.won ? ' won' : ''}`}>{v.corr != null ? v.corr.toFixed(1) : '—'}</b></div>
        <div><span className="bz-cap">Meta</span><b className="bz-l">{v.hurdle != null ? n0(v.hurdle) : '—'}</b></div>
        <div><span className="bz-cap">{v.won ? 'Arriba de la meta' : 'Faltan'}</span><b className="bz-l lv">{left == null ? '—' : v.won ? '+' + n0(corr - meta) : n0(left)}</b></div>
      </div>
      <div className="bz-bar">
        <div className="bz-track" />
        <div className={`bz-fill${v.won ? ' won' : ''}`} style={{ width: pct(corr, scale) }} />
        {meta > 0 && <div className="bz-mark" style={{ left: pct(meta, scale) }} />}
      </div>
      <div className="bz-legend"><span>Barra: libras por persona hasta ahora</span><span>Negra: meta</span></div>
    </div>
  )
}

function Speed({ v }: { v: BonusView }) {
  const lv = speedLevel(v.speed)
  const behind = !v.won && v.need != null && (v.speed == null || v.need > v.speed)
  return (
    <div className="bz-card bz-sm">
      <div className="bz-head"><b>Velocidad</b><span className="bz-dim">libras por bucker por hora</span></div>
      <div className="bz-speed">
        <b className={`bz-xl sp-${lv}`}>{v.speed != null ? Math.round(v.speed) : '—'}</b>
        <span>{v.won ? 'Meta ya alcanzada' : v.need == null ? '' : v.speed != null && v.need <= v.speed ? 'A este ritmo llegan a la meta' : `Necesitan ${Math.ceil(v.need)} para llegar a la meta`}</span>
      </div>
      <div className="bz-bar">
        <div className="bz-zones"><i style={{ width: pct(SPEED_RED, SPEED_MAX) }} /><i style={{ width: pct(SPEED_YELLOW - SPEED_RED, SPEED_MAX) }} /><i /></div>
        {v.speed != null && <div className={`bz-fill sp-${lv}`} style={{ width: pct(Math.min(v.speed, SPEED_MAX), SPEED_MAX) }} />}
        {behind && <div className="bz-mark" style={{ left: pct(Math.min(v.need!, SPEED_MAX), SPEED_MAX) }} />}
      </div>
      <div className="bz-legend"><span>Rojo &lt; {SPEED_RED} · Amarillo {SPEED_RED} a {SPEED_YELLOW} · Verde &gt; {SPEED_YELLOW}</span><span>{behind ? 'Negra: velocidad necesaria' : ''}</span></div>
    </div>
  )
}

function Bottom({ v }: { v: BonusView }) {
  // speed at each pallet (last 28), grouped by variety, shaded per variety
  const shown = v.series.slice(-28)
  const groups: { strain: string; bars: typeof shown }[] = []
  for (const s of shown) { const g = groups[groups.length - 1]; if (g && g.strain === s.strain) g.bars.push(s); else groups.push({ strain: s.strain, bars: [s] }) }
  const tiles = [
    { label: 'Libras empacadas', value: n0(v.packed), sub: 'hoy' },
    { label: 'Tarimas', value: String(v.pallets), sub: 'hoy' },
    { label: 'Min. por tarima', value: v.avgPalletMin != null ? v.avgPalletMin.toFixed(1) : '—', sub: 'promedio' },
    { label: 'Personas', value: v.people != null ? String(v.people) : '—', sub: v.buckers != null ? `${v.buckers} buckers` : '' },
    { label: 'Horas', value: v.workedH.toFixed(1), sub: `de ${v.estHours} trabajadas` },
  ]
  return (
    <div className="bz-bottom">
      <div className="bz-card bz-spark">
        <span className="bz-cap">Por tarima</span>
        <div className="bz-groups">{groups.length ? groups.map((g, i) => (
          <div key={i} className={`bz-group b${i % 2}`} style={{ flexGrow: g.bars.length }}>
            <span className="bz-glab">{g.strain}</span>
            <div className="bz-bars">{g.bars.map(b => <i key={b.code} className={`sp-${speedLevel(b.v)}`} style={{ height: pct(Math.min(b.v, SPEED_MAX), SPEED_MAX) }} title={`${b.code} · ${Math.round(b.v)}`} />)}</div>
          </div>)) : <span className="bz-dim">Sin tarimas todavía</span>}</div>
      </div>
      {tiles.map(t => <div key={t.label} className="bz-card bz-tile"><span className="bz-cap">{t.label}</span><b>{t.value}</b><span className="bz-dim">{t.sub}</span></div>)}
    </div>
  )
}
