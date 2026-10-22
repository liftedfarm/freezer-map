import { useState } from 'react'
import type { ReactNode } from 'react'

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
  return <input value={value ?? ''} placeholder={placeholder} list={list} autoFocus={autoFocus} onChange={e => onChange(e.target.value === '' ? null : e.target.value)} />
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

export function SaveBar({ busy, onSave, onCancel, onDelete, saveLabel = 'Save', disabled }: { busy: boolean; onSave: () => void; onCancel: () => void; onDelete?: () => void; saveLabel?: string; disabled?: boolean }) {
  const [sure, setSure] = useState(false)
  return (
    <div className="row between csave">
      {onDelete ? (sure
        ? <span className="row"><button className="ghost danger" disabled={busy} onClick={onDelete}>Yes, delete</button><button className="ghost small" onClick={() => setSure(false)}>Keep</button></span>
        : <button className="ghost" disabled={busy} onClick={() => setSure(true)}>Delete</button>) : <span />}
      <div className="row">
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy || disabled} onClick={onSave}>{busy ? 'Saving…' : saveLabel}</button>
      </div>
    </div>
  )
}

export function Kpis({ items }: { items: [ReactNode, ReactNode][] }) {
  return <div className="ckpis">{items.map(([v, l], i) => <div key={i}><b>{v}</b><span>{l}</span></div>)}</div>
}

export const errText = (e: unknown) => String((e as Error)?.message ?? e)
