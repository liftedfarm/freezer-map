import { Select } from './combo'
// Inventory table shared by Distribution, Sales and Processing: one table, a preset view per module.
// Group by, filter chips, column picker, sort, totals, select for bulk actions, export to Excel (CSV).
import './cult/cult.css'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { SelAll, SelBox, SelBar, SelButton, useSel } from './cult/ui'
import type { SelAction } from './cult/ui'

export interface Col<R> {
  k: string; l: string
  get: (r: R) => ReactNode
  /** value for sorting and the export (defaults to the text of get) */
  val?: (r: R) => string | number | null | undefined
  num?: boolean
  /** shown on phones (others hide below 700px) */
  phone?: boolean
  /** shown until someone turns it off in Columns */
  on?: boolean
}
export interface GroupBy<R> {
  k: string; l: string
  key: (r: R) => string
  /** heading for a group (defaults to the key) */
  head?: (key: string, rows: R[]) => ReactNode
  /** order of groups (defaults to the key, A-Z) */
  order?: (key: string, rows: R[]) => string | number
  /** tapping the heading (e.g. a mixed pallet opens its card) */
  open?: (key: string) => void
}
export interface Chip<R> { k: string; l: string; get: (r: R) => string | null | undefined; label?: (v: string) => string; order?: string[] }

const store = (k: string) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') } catch { return null } }
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } }
const n0 = (x: number) => Math.round(x).toLocaleString()

export function InvTable<R>({ id, title, note, rows, rowId, cols, groups, defaultGroup, defaultSort, chips, text, lbs, onOpen, expand, totals, actions, noun = 'package', toolbar, rowClass }: {
  id: string; title: ReactNode; note?: ReactNode
  rows: R[]; rowId: (r: R) => number
  cols: Col<R>[]; groups: GroupBy<R>[]; defaultGroup: string
  /** column to sort by until someone picks one */
  defaultSort?: string
  chips?: Chip<R>[]
  text: (r: R) => string
  lbs: (r: R) => number
  onOpen?: (r: R) => void
  /** drill-down under a row (Sales: lots and pallets) */
  expand?: (r: R) => ReactNode
  /** extra words for the totals bar, from the rows shown */
  totals?: (rows: R[]) => ReactNode
  actions?: SelAction[]; noun?: string
  toolbar?: ReactNode
  rowClass?: (r: R) => string
}) {
  const key = `fm.inv.${id}`
  const saved = store(key) as { g?: string; hide?: string[]; show?: string[]; sort?: [string, 1 | -1] } | null
  const [g, setG] = useState<string>(saved?.g && (saved.g === 'none' || groups.some(x => x.k === saved.g)) ? saved.g : defaultGroup)
  const [hide, setHide] = useState<Set<string>>(new Set(saved?.hide ?? []))
  const [show, setShow] = useState<Set<string>>(new Set(saved?.show ?? []))
  const [sort, setSort] = useState<[string, 1 | -1] | null>(saved?.sort ?? (defaultSort ? [defaultSort, 1] : null))
  const [pick, setPick] = useState<Record<string, Set<string>>>({})
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [colMenu, setColMenu] = useState(false)
  const sel = useSel()
  const persist = (p: Partial<{ g: string; hide: string[]; show: string[]; sort: [string, 1 | -1] | null }>) =>
    save(key, { g, hide: [...hide], show: [...show], sort, ...p })

  const visible = cols.filter(c => c.on === false ? show.has(c.k) : !hide.has(c.k))
  const toggleCol = (c: Col<R>) => {
    if (c.on === false) { const s = new Set(show); s.has(c.k) ? s.delete(c.k) : s.add(c.k); setShow(s); persist({ show: [...s] }) }
    else { const h = new Set(hide); h.has(c.k) ? h.delete(c.k) : h.add(c.k); setHide(h); persist({ hide: [...h] }) }
  }

  // filter
  const ql = q.trim().toLowerCase()
  const shown = useMemo(() => rows.filter(r => (!ql || text(r).toLowerCase().includes(ql))
    && (chips ?? []).every(c => !pick[c.k]?.size || pick[c.k].has(c.get(r) ?? '')))
  , [rows, ql, pick, chips])
  // sort
  const valOf = (c: Col<R>, r: R) => { const v = c.val ? c.val(r) : c.get(r); return typeof v === 'number' ? v : v == null ? '' : String(v) }
  const sorted = useMemo(() => {
    if (!sort) return shown
    const c = cols.find(x => x.k === sort[0]); if (!c) return shown
    return [...shown].sort((a, b) => { const x = valOf(c, a), y = valOf(c, b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort[1] })
  }, [shown, sort])
  // group
  const grp = groups.find(x => x.k === g)
  const grouped = useMemo(() => {
    if (!grp) return [['', sorted]] as [string, R[]][]
    const m = new Map<string, R[]>()
    for (const r of sorted) { const k = grp.key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r) }
    const ord = (k: string, rs: R[]) => grp.order ? grp.order(k, rs) : k
    return [...m.entries()].sort((a, b) => { const x = ord(a[0], a[1]), y = ord(b[0], b[1])
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }) })
  }, [sorted, g])

  const totLbs = shown.reduce((a, r) => a + lbs(r), 0)
  const exportCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [[...(grp ? [grp.l] : []), ...visible.map(c => c.l)].map(esc).join(',')]
    for (const [k, rs] of grouped) for (const r of rs) lines.push([...(grp ? [k] : []), ...visible.map(c => valOf(c, r))].map(esc).join(','))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    a.download = `${id}-inventory-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
  }
  const chipOpts = (c: Chip<R>) => { const vs = [...new Set(rows.map(r => c.get(r) ?? '').filter(Boolean))]
    return c.order ? vs.sort((a, b) => (c.order!.indexOf(a) + 1 || 99) - (c.order!.indexOf(b) + 1 || 99)) : vs.sort() }
  const togglePick = (c: string, v: string) => setPick(p => { const s = new Set(p[c] ?? []); s.has(v) ? s.delete(v) : s.add(v); return { ...p, [c]: s } })
  const ncol = visible.length + (sel.on ? 1 : 0)

  return (
    <div className="list inv">
      <div className="row between wrap toolbar"><h2>{title}</h2>
        <div className="row wrap">{toolbar}{actions?.length ? <SelButton sel={sel} /> : null}
          <button className="ghost small" onClick={exportCsv}>Export to Excel</button></div></div>
      {note && <p className="muted">{note}</p>}
      <div className="row wrap toolbar invbar">
        <input className="search" type="search" placeholder="Search strain, pallet, tag, lot" value={q} onChange={e => setQ(e.target.value)} />
        <label className="row">Group by <Select className="inline" value={g} onChange={e => { setG(e.target.value); persist({ g: e.target.value }) }}>
          {groups.map(x => <option key={x.k} value={x.k}>{x.l}</option>)}<option value="none">Nothing</option></Select></label>
        <span className="colpick"><button className="ghost small" onClick={() => setColMenu(v => !v)}>Columns</button>
          {colMenu && <div className="colmenu" onMouseLeave={() => setColMenu(false)}>{cols.map(c =>
            <label key={c.k}><input type="checkbox" checked={visible.includes(c)} onChange={() => toggleCol(c)} /> {c.l}</label>)}</div>}</span>
      </div>
      {chips?.length ? <div className="chips">{chips.map(c => { const opts = chipOpts(c); if (opts.length < 2) return null
        return <span key={c.k} className="chipset"><span className="muted small">{c.l}</span>{opts.map(v =>
          <button key={v} className={`chip ${pick[c.k]?.has(v) ? 'on' : ''}`} onClick={() => togglePick(c.k, v)}>{c.label ? c.label(v) : v}</button>)}</span> })}</div> : null}
      <div className="invtot"><b>{shown.length.toLocaleString()}</b> {noun}{shown.length === 1 ? '' : 's'} · <b>{n0(totLbs)}</b> lbs{totals ? <> · {totals(shown)}</> : null}
        {grp && grouped.length > 1 && <> · <a onClick={() => setClosed(closed.size ? new Set() : new Set(grouped.map(x => x[0])))}>{closed.size ? 'Open all' : 'Fold all'}</a></>}</div>
      {!shown.length ? <p className="muted">Nothing matches.</p> :
        <div className="cwrap"><table className="ctable invt">
          <thead><tr><SelAll sel={sel} ids={shown.map(rowId)} />{visible.map(c =>
            <th key={c.k} className={`${c.num ? 'num' : ''} ${c.phone ? '' : 'hide-s'} sortable`} onClick={() => { const s: [string, 1 | -1] = sort?.[0] === c.k ? [c.k, sort[1] === 1 ? -1 : 1] : [c.k, 1]; setSort(s); persist({ sort: s }) }}>
              {c.l}{sort?.[0] === c.k ? (sort[1] === 1 ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
          <tbody>{grouped.map(([k, rs]) => {
            const isClosed = closed.has(k)
            return [
              grp && <tr key={`g-${k}`} className="wk ghead"><td colSpan={ncol}>
                <span className="row between"><span><a className="fold" onClick={() => setClosed(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })}>{isClosed ? '▸' : '▾'}</a>{' '}
                  {grp.open ? <a onClick={() => grp.open!(k)}>{grp.head ? grp.head(k, rs) : k || '(none)'}</a> : grp.head ? grp.head(k, rs) : k || '(none)'}</span>
                  <span className="muted">{rs.length} · {n0(rs.reduce((a, r) => a + lbs(r), 0))} lbs</span></span></td></tr>,
              ...(isClosed ? [] : rs.flatMap(r => {
                const idr = rowId(r)
                return [
                  <tr key={idr} className={`tap ${rowClass?.(r) ?? ''}`} onClick={() => expand ? setOpenRow(o => o === idr ? null : idr) : onOpen?.(r)}>
                    <SelBox sel={sel} id={idr} />{visible.map(c => <td key={c.k} className={`${c.num ? 'num' : ''} ${c.phone ? '' : 'hide-s'}`}>{c.get(r)}</td>)}</tr>,
                  expand && openRow === idr ? <tr key={`x-${idr}`} className="xrow"><td colSpan={ncol}>{expand(r)}</td></tr> : null,
                ]
              })),
            ]
          })}</tbody>
        </table></div>}
      {actions && <SelBar sel={sel} noun={noun} actions={actions} />}
    </div>
  )
}
