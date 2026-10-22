import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Backend } from '../api'
import { CultApi } from './api'
import { makeCtx } from './calc'
import type { CultData, Harvest } from './types'
import { HarvestSheet, ScheduleTab } from './schedule'
import { WeekTab } from './week'
import { TestingTab } from './testing'
import { AvailabilityTab } from './avail'
import { PlantingsTab } from './plantings'
import { YieldsTab } from './yields'
import { PlanTab } from './plan'
import { SetupTab } from './setup'
import { CultDashboard } from './dash'
import { errText } from './ui'
import './cult.css'

import { cultLabel } from './tabs'
import { t } from '../i18n'
import { ActivityTab, ReviewTab } from './review'
import { HarvestTab } from './harvest'
import { OpsLogs } from '../logs'
import type { CultTab as Tab } from './tabs'
const remembered = <T extends string>(k: string, d: T): T => { try { return (localStorage.getItem(k) as T) || d } catch { return d } }
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

export default function CultView({ backend, flash, onPalletsChanged, tab, go }: { backend: Backend; flash: (t: string, bad?: boolean) => void; onPalletsChanged: () => void; tab: Tab; go: (t: Tab) => void }) {
  const api = useMemo(() => { const sb = backend.client(); return sb ? new CultApi(sb) : null }, [backend])
  const [site, setSiteS] = useState<string | null>(() => remembered('cult.site', '') || null)
  const [year, setYear] = useState<number | null>(null)
  const [logId, setLogId] = useState<number | null>(null)
  useEffect(() => { if (tab !== 'harvest') setLogId(null) }, [tab])
  const [d, setD] = useState<CultData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Partial<Harvest> | null>(null)
  const setSite = (s: string | null) => { setSiteS(s); remember('cult.site', s ?? '') }

  const load = useCallback(async () => {
    if (!api) return
    try { setD(await api.load(year)); setErr(null) } catch (e) { setErr(errText(e)) }
  }, [api, year])
  useEffect(() => { load() }, [load])
  const c = useMemo(() => d && makeCtx(d), [d])
  const saved = useCallback(async (msg: string) => { await load(); flash(msg); if (/pallet/i.test(msg)) onPalletsChanged() }, [load, flash, onPalletsChanged])

  if (!api) return <div className="list"><h2>Cultivation</h2><p className="muted">Cultivation needs the database (not available in the demo).</p></div>
  if (err) return <div className="list"><h2>Cultivation</h2><div className="warnbox">Couldn't load cultivation data. If this is the first time, run 018_modules_sites_fields.sql and 019_cultivation.sql in Supabase. ({err})</div></div>
  if (!d || !c) return <div className="list"><h2>Cultivation</h2><p className="muted">Loading…</p></div>

  return (
    <div className="cult">
      <div className="chead">
        {tab === 'dashboard' ? <span className="dev">{t('in development')}</span> : <h2>{tab === 'setup' ? t('Production settings') : t(cultLabel(tab))} <span className="dev">{t('in development')}</span></h2>}
        <div className="row">
          {tab !== 'plan' && tab !== 'setup' && tab !== 'activity' && tab !== 'logs' && <select value={d.year} onChange={e => setYear(Number(e.target.value))}>
            {[...new Set([...d.years, d.currentYear + 1])].sort((a, b) => b - a).map(y => <option key={y} value={y}>{y} season</option>)}
          </select>}
          {tab !== 'plan' && tab !== 'setup' && tab !== 'activity' && tab !== 'logs' && <div className="seg">
            {[null, ...d.sites.map(s => s.code)].map(s => <button key={s ?? 'all'} className={site === s ? 'on' : ''} onClick={() => setSite(s)}>{s ?? 'Both'}</button>)}
          </div>}
        </div>
      </div>
      {['schedule', 'avail', 'plantings', 'yields', 'plan'].includes(tab) &&
        <div className="row toolbar"><input className="search" type="search" placeholder="Search strain, field, notes" value={q} onChange={e => setQ(e.target.value)} /></div>}

      {tab === 'dashboard' && <CultDashboard d={d} c={c} site={site} onOpen={setOpen} go={go} />}
      {tab === 'schedule' && <ScheduleTab d={d} c={c} site={site} q={q} onOpen={setOpen} api={api} flash={flash} onSaved={saved} />}
      {tab === 'week' && <WeekTab d={d} c={c} site={site} onOpen={setOpen} />}
      {tab === 'testing' && <TestingTab d={d} c={c} site={site} api={api} flash={flash} onSaved={saved} />}
      {tab === 'avail' && <AvailabilityTab d={d} c={c} site={site} q={q} api={api} flash={flash} onSaved={saved} />}
      {tab === 'plantings' && <PlantingsTab d={d} c={c} site={site} q={q} api={api} flash={flash} onSaved={saved} />}
      {tab === 'yields' && <YieldsTab d={d} c={c} site={site} q={q} api={api} />}
      {tab === 'plan' && <PlanTab d={d} c={c} api={api} flash={flash} q={q} />}
      {tab === 'harvest' && <HarvestTab key={logId ?? 'list'} openFirst={logId} d={d} c={c} site={site} api={api} flash={flash} onSaved={async m => { await load(); flash(m) }} />}
      {tab === 'review' && <ReviewTab d={d} c={c} site={site} onOpen={setOpen} go={go} />}
      {tab === 'activity' && <ActivityTab api={api} />}
      {tab === 'logs' && backend.client() && <OpsLogs sb={backend.client()!} module="cultivation" sites={d.sites.map(s => s.code)} flash={flash}
        areas={d.fields.filter(f => f.active).map(f => `Block ${f.code}`)} strains={[...new Set(d.harvests.map(h => h.strain))].sort()} canEditRecipes
        fieldAcres={Object.fromEntries(d.fields.filter(f => f.acres).flatMap(f => [[`Block ${f.code}`, f.acres!], [`Field ${f.code}`, f.acres!], [f.name, f.acres!]]))} />}
      {tab === 'setup' && <SetupTab d={d} api={api} sb={backend.client()} flash={flash} onSaved={saved} />}

      {open && <HarvestSheet key={open.id ?? 'new'} d={d} c={c} harvest={open} api={api} flash={flash} onClose={() => setOpen(null)} onLog={id => { setOpen(null); setLogId(id); go('harvest') }}
        onSaved={async m => { setOpen(null); await saved(m) }} />}
    </div>
  )
}
