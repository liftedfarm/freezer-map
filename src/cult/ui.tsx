import { useState } from 'react'
import type { ReactNode } from 'react'
import { lang, t } from '../i18n'

export type Flash = (t: string, bad?: boolean) => void

export function Sheet({ title, sub, onClose, children, wide }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className={`sheet form ${wide ? 'wide' : ''} csheet`} onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><div><h2>{title}</h2>{sub && <div className="muted">{sub}</div>}</div><button className="ghost" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  )
}

export function F({ label, hint, children, half }: { label: ReactNode; hint?: ReactNode; children: ReactNode; half?: boolean }) {
  return <div className={`field ${half ? 'half' : ''}`}><label>{label}{hint && <span className="muted"> {hint}</span>}</label>{children}</div>
}

const toNum = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')))

/** number input that keeps what's typed until it's a number */
export function NumIn({ value, onChange, placeholder, step, autoFocus }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; step?: string; autoFocus?: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? (value == null ? '' : String(value))
  return <input inputMode="decimal" value={shown} placeholder={placeholder} step={step} autoFocus={autoFocus}
    onChange={e => { setText(e.target.value); const n = toNum(e.target.value); if (n === null || isFinite(n)) onChange(n) }}
    onBlur={() => setText(null)} />
}

export function DateIn({ value, onChange }: { value: string | null | undefined; onChange: (v: string | null) => void }) {
  return <input type="date" value={value ?? ''} onChange={e => onChange(e.target.value || null)} />
}

export function TextIn({ value, onChange, placeholder, list, autoFocus }: { value: string | null | undefined; onChange: (v: string | null) => void; placeholder?: string; list?: string; autoFocus?: boolean }) {
  if (list) return <Combo value={value} onChange={onChange} placeholder={placeholder} list={list} autoFocus={autoFocus} />
  return <input value={value ?? ''} placeholder={placeholder} autoFocus={autoFocus} onChange={e => onChange(e.target.value === '' ? null : e.target.value)} />
}

/** a text box with a real drop-down: the choices come from the <datalist id={list}> on the page (shown on focus, filtered as you type).
 *  Browsers' own datalist pop-ups are easy to miss, so this draws its own. */
function Combo({ value, onChange, placeholder, list, autoFocus }: { value: string | null | undefined; onChange: (v: string | null) => void; placeholder?: string; list: string; autoFocus?: boolean }) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [opts, setOpts] = useState<string[]>([])
  const load = () => {
    const el = document.getElementById(list) as HTMLDataListElement | null
    setOpts(el ? [...el.options].map(o => o.value).filter(Boolean) : [])
  }
  const q = (value ?? '').trim().toLowerCase()
  const exact = opts.some(o => o.toLowerCase() === q)
  const shown = (q && !exact ? opts.filter(o => o.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q))) : opts).slice(0, 60)
  const pick = (v: string) => { onChange(v); setOpen(false) }
  return (
    <span className="combo">
      <input value={value ?? ''} placeholder={placeholder ?? 'Pick or type'} autoFocus={autoFocus} autoComplete="off" role="combobox" aria-expanded={open}
        onFocus={() => { load(); setOpen(true); setHi(0) }} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={e => { onChange(e.target.value === '' ? null : e.target.value); if (!open) load(); setOpen(true); setHi(0) }}
        onKeyDown={e => {
          if (!open || !shown.length) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(i + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter' && shown[hi]) { e.preventDefault(); pick(shown[hi]) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      <button type="button" className="combo-arrow" tabIndex={-1} aria-label="Show choices" onMouseDown={e => { e.preventDefault(); load(); setOpen(o => !o) }}>▾</button>
      {open && shown.length > 0 && <ul className="combo-list" role="listbox">
        {shown.map((o, i) => <li key={o} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseDown={e => { e.preventDefault(); pick(o) }}>{o}</li>)}
      </ul>}
    </span>
  )
}

export function Pick<T extends string | number>({ value, options, onChange, blank }: { value: T | null | undefined; options: { v: T; l: string }[]; onChange: (v: T | null) => void; blank?: string }) {
  return (
    <select value={value == null ? '' : String(value)} onChange={e => {
      const o = options.find(x => String(x.v) === e.target.value)
      onChange(o ? o.v : null)
    }}>
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map(o => <option key={String(o.v)} value={String(o.v)}>{o.l}</option>)}
    </select>
  )
}

export function Choices<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return <div className="choices">{options.map(o => <button key={o.v} type="button" className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.l}</button>)}</div>
}

/** strain names to pick from (any text is fine, it gets matched to the Strains list when saved) */
export function StrainList({ id, names }: { id: string; names: string[] }) {
  return <datalist id={id}>{names.map(n => <option key={n} value={n} />)}</datalist>
}

export function SaveBar({ busy, onSave, onCancel, onDelete, saveLabel, disabled }: { busy: boolean; onSave: () => void; onCancel: () => void; onDelete?: () => void; saveLabel?: string; disabled?: boolean }) {
  const [sure, setSure] = useState(false)
  return (
    <div className="row between csave">
      {onDelete ? (sure
        ? <span className="row"><button className="ghost danger" disabled={busy} onClick={onDelete}>{t('Yes, delete')}</button><button className="ghost small" onClick={() => setSure(false)}>{t('Keep')}</button></span>
        : <button className="ghost" disabled={busy} onClick={() => setSure(true)}>{t('Delete')}</button>) : <span />}
      <div className="row">
        <button className="ghost" onClick={onCancel}>{t('Cancel')}</button>
        <button className="primary" disabled={busy || disabled} onClick={onSave}>{busy ? t('Saving…') : saveLabel ?? t('Save')}</button>
      </div>
    </div>
  )
}

export function Kpis({ items }: { items: [ReactNode, ReactNode][] }) {
  return <div className="ckpis">{items.map(([v, l], i) => <div key={i}><b>{v}</b><span>{l}</span></div>)}</div>
}

// ---------- pick several rows ----------
export interface Sel { on: boolean; ids: Set<number>; start: () => void; stop: () => void; toggle: (id: number) => void; setAll: (ids: number[], v: boolean) => void }
export function useSel(): Sel {
  const [on, setOn] = useState(false)
  const [ids, setIds] = useState<Set<number>>(new Set())
  return {
    on, ids,
    start: () => setOn(true),
    stop: () => { setOn(false); setIds(new Set()) },
    toggle: id => setIds(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }),
    setAll: (list, v) => setIds(s => { const n = new Set(s); for (const id of list) { if (v) n.add(id); else n.delete(id) } return n }),
  }
}
/** checkbox header cell: ticks every row shown */
export function SelAll({ sel, ids }: { sel: Sel; ids: number[] }) {
  if (!sel.on) return null
  const all = ids.length > 0 && ids.every(id => sel.ids.has(id))
  return <th className="selcol"><input type="checkbox" checked={all} onChange={() => sel.setAll(ids, !all)} /></th>
}
export function SelBox({ sel, id }: { sel: Sel; id: number | null | undefined }) {
  if (!sel.on) return null
  return <td className="selcol" onClick={e => e.stopPropagation()}>{id != null && <input type="checkbox" checked={sel.ids.has(id)} onChange={() => sel.toggle(id)} />}</td>
}
export function SelButton({ sel, label }: { sel: Sel; label?: string }) {
  return sel.on ? <button className="ghost small" onClick={sel.stop}>{t('Done selecting')}</button> : <button className="ghost small" onClick={sel.start}>{label ?? t('Select')}</button>
}
export interface SelAction { label: string; run: (ids: number[]) => Promise<void>; danger?: boolean }
/** bar that sticks to the bottom while rows are picked */
export function SelBar({ sel, noun, actions }: { sel: Sel; noun: string; actions: SelAction[] }) {
  const [sure, setSure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!sel.on || !sel.ids.size) return null
  const ids = [...sel.ids]
  const go = async (a: SelAction) => {
    if (a.danger && sure !== a.label) { setSure(a.label); return }
    setBusy(true)
    try { await a.run(ids); sel.stop() } finally { setBusy(false); setSure(null) }
  }
  return (
    <div className="selbar">
      <b>{lang() === 'es' ? t('{n} picked', { n: ids.length }) : `${ids.length} ${noun}${ids.length === 1 ? '' : 's'} picked`}</b>
      <div className="row">
        {actions.map(a => <button key={a.label} disabled={busy} className={a.danger ? (sure === a.label ? 'primary dangerbg' : 'ghost danger') : 'ghost'} onClick={() => go(a)}>
          {a.danger && sure === a.label ? `Yes, ${a.label.toLowerCase()} ${ids.length}` : a.label}</button>)}
        <button className="ghost" onClick={sel.stop}>{t('Cancel')}</button>
      </div>
    </div>
  )
}

export const errText = (e: unknown) => String((e as Error)?.message ?? e)
