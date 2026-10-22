import { useMemo, useState } from 'react'
import { ScanButton } from './scan'
import type { MixLine, Pallet, SingleInput } from './types'

// Small shared pieces for the action dialogs (split, merge, tag, weight).

export const lbs = (n: number | null | undefined) => n == null ? '' : `${(Math.round(n * 100) / 100).toLocaleString()} lbs`

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>{title}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  )
}

function TagField({ tag, setTag, pending, setPending, label = 'New METRC tag' }: {
  tag: string; setTag: (v: string) => void; pending: boolean; setPending: (v: boolean) => void; label?: string
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row tagrow">
        <input className="mono-in grow-in" value={tag} disabled={pending} placeholder="1A40603000…"
          onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} />
        <ScanButton disabled={pending} onScan={setTag} />
      </div>
      <label className="check"><input type="checkbox" checked={pending} onChange={e => setPending(e.target.checked)} /> Tag pending, I'll add it later</label>
    </div>
  )
}

export type Dest = 'same' | 'other'

function DestField({ dest, setDest, sameLabel }: { dest: Dest; setDest: (d: Dest) => void; sameLabel: string | null }) {
  return (
    <div className="field">
      <label>Where does it go?</label>
      <div className="choices">
        {sameLabel && <button className={dest === 'same' ? 'on' : ''} onClick={() => setDest('same')}>{sameLabel}</button>}
        <button className={dest === 'other' ? 'on' : ''} onClick={() => setDest('other')}>Pick a slot</button>
      </div>
      {dest === 'other' && <div className="muted">After you tap the button below, tap the slot on the freezer map.</div>}
    </div>
  )
}

export function SplitForm({ p, where, busy, onClose, onSubmit }: {
  p: Pallet; where: string | null; busy: boolean; onClose: () => void
  onSubmit: (lbs: number, tag: string | null, pending: boolean, dest: Dest, note: string) => void
}) {
  const [amt, setAmt] = useState('')
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [dest, setDest] = useState<Dest>(where ? 'same' : 'other')
  const [note, setNote] = useState('')
  const n = parseFloat(amt)
  const w = p.current_weight ?? 0
  const ok = n > 0 && n < w && (pending || tag.trim().length > 0)
  return (
    <Dialog title={`Split ${p.code}`} onClose={onClose}>
      <p className="muted">{p.strain} · {lbs(w)} now. The part you split off becomes a new pallet with its own number and METRC tag. {p.code} keeps the rest.</p>
      <div className="field">
        <label>Lbs to split off</label>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={amt} onChange={e => setAmt(e.target.value)} autoFocus />
        {amt && <div className={n > 0 && n < w ? 'muted' : 'warn-t'}>
          {n > 0 && n < w ? `New pallet ${lbs(n)} · ${p.code} keeps ${lbs(w - n)}` : `Must be more than 0 and less than ${lbs(w)}`}
        </div>}
      </div>
      <TagField tag={tag} setTag={setTag} pending={pending} setPending={setPending} />
      <DestField dest={dest} setDest={setDest} sameLabel={where ? `Same slot (${where})` : null} />
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. pulled for Acquamarcia order" /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit(n, pending ? null : tag, pending, dest, note)}>Split</button>
      </div>
    </Dialog>
  )
}

export function MergeForm({ p, candidates, whereOf, busy, onClose, onSubmit }: {
  p: Pallet; candidates: Pallet[]; whereOf: (x: Pallet) => string; busy: boolean; onClose: () => void
  onSubmit: (ids: number[], tag: string | null, pending: boolean, dest: Dest, note: string) => void
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [dest, setDest] = useState<Dest>(p.slot_id != null ? 'same' : 'other')
  const [note, setNote] = useState('')
  const total = useMemo(() => (p.current_weight ?? 0) + candidates.filter(c => picked.has(c.id)).reduce((a, c) => a + (c.current_weight ?? 0), 0), [picked, candidates, p])
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const ok = picked.size > 0 && (pending || tag.trim().length > 0)
  return (
    <Dialog title={`Merge ${p.code}`} onClose={onClose}>
      <p className="muted">Combine {p.strain} pallets into one new C pallet with a new METRC tag. The originals are closed out and linked in history.</p>
      <div className="field">
        <label>Merge with ({candidates.length} other {p.strain} pallets)</label>
        <div className="picklist">
          {candidates.length === 0 && <div className="muted">No other {p.strain} pallets in inventory.</div>}
          {candidates.map(c => (
            <label key={c.id} className={`pick ${picked.has(c.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <b>{c.code}</b><span>{lbs(c.current_weight)}</span><span className="muted">{whereOf(c)}</span>
            </label>
          ))}
        </div>
        {picked.size > 0 && <div className="muted">New pallet: {picked.size + 1} pallets · {lbs(total)}</div>}
      </div>
      <TagField tag={tag} setTag={setTag} pending={pending} setPending={setPending} />
      <DestField dest={dest} setDest={setDest} sameLabel={p.slot_id != null ? `${p.code}'s slot (${whereOf(p)})` : null} />
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit([p.id, ...picked], pending ? null : tag, pending, dest, note)}>Merge {picked.size + 1} pallets</button>
      </div>
    </Dialog>
  )
}

export function TagForm({ p, busy, onClose, onSubmit }: { p: Pallet; busy: boolean; onClose: () => void; onSubmit: (tag: string) => void }) {
  const [tag, setTag] = useState(p.package_tag ?? '')
  return (
    <Dialog title={`METRC tag for ${p.code}`} onClose={onClose}>
      <div className="field">
        <label>Tag</label>
        <div className="row tagrow">
          <input className="mono-in grow-in" value={tag} autoFocus onChange={e => setTag(e.target.value.toUpperCase().replace(/\s/g, ''))} />
          <ScanButton onScan={setTag} />
        </div>
      </div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!tag.trim() || busy} onClick={() => onSubmit(tag)}>Save tag</button>
      </div>
    </Dialog>
  )
}

export function WeightForm({ p, busy, onClose, onSubmit }: { p: Pallet; busy: boolean; onClose: () => void; onSubmit: (w: number, note: string) => void }) {
  const [w, setW] = useState(p.current_weight != null ? String(p.current_weight) : '')
  const [note, setNote] = useState('')
  const n = parseFloat(w)
  return (
    <Dialog title={`Adjust weight · ${p.code}`} onClose={onClose}>
      <p className="muted">Currently {lbs(p.current_weight) || 'unknown'}. Use this for a reweigh or to fix a wrong number.</p>
      <div className="field"><label>New weight (lbs)</label>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={w} autoFocus onChange={e => setW(e.target.value)} /></div>
      <div className="field"><label>Reason</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. reweighed on scale 2" /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!(n >= 0) || busy} onClick={() => onSubmit(n, note)}>Save</button>
      </div>
    </Dialog>
  )
}

// ---------- new pallet from an empty slot ----------

export function NewPalletChooser({ where, onClose, onPick }: { where: string; onClose: () => void; onPick: (k: 'mixed' | 'merged' | 'single') => void }) {
  return (
    <Dialog title={`New pallet in ${where}`} onClose={onClose}>
      <button className="bigchoice" onClick={() => onPick('mixed')}>
        <b>Mixed pallet (M)</b>
        <span className="muted">Stack packages from other pallets onto one pallet. Whole packages keep their METRC tag; partial amounts get split off with a new tag.</span>
      </button>
      <button className="bigchoice" onClick={() => onPick('merged')}>
        <b>Merged pallet (C)</b>
        <span className="muted">Combine partial pallets of the same strain into one new C pallet with a new METRC tag. The originals are closed out and linked in history.</span>
      </button>
      <button className="bigchoice" onClick={() => onPick('single')}>
        <b>Single pallet</b>
        <span className="muted">Enter one package by hand: product that's in the freezer but not in the app yet.</span>
      </button>
    </Dialog>
  )
}

interface Line { p: Pallet; whole: boolean; lbs: string; tag: string; pending: boolean; auto?: boolean }

export function MixedBuilder({ title, target, candidates, initial, whereOf, busy, onClose, onSubmit, autoTags = [] }: {
  title: string; target: string; candidates: Pallet[]; initial?: Pallet[]; whereOf: (p: Pallet) => string; busy: boolean; autoTags?: string[]
  onClose: () => void; onSubmit: (lines: MixLine[], note: string) => void
}) {
  const [q, setQ] = useState('')
  const [lines, setLines] = useState<Line[]>((initial ?? []).map(p => ({ p, whole: true, lbs: '', tag: '', pending: false })))
  const [note, setNote] = useState('')
  const picked = new Set(lines.map(l => l.p.id))
  const results = q.trim().length < 1 ? [] : candidates
    .filter(c => !picked.has(c.id) && [c.code, c.strain, c.package_tag].some(v => v?.toLowerCase().includes(q.trim().toLowerCase())))
    .slice(0, 12)
  // next tag from the site's range that no other line is using
  const nextAuto = (ls: Line[]) => autoTags.find(t => !ls.some(l => l.tag === t)) ?? ''
  const withAuto = (ls: Line[]) => ls.map((l, i) => {
    if (l.whole && l.auto) return { ...l, tag: '', auto: false }
    if (!l.whole && !l.pending && !l.tag) { const t = nextAuto(ls.slice(0, i).concat(ls.slice(i + 1))); return t ? { ...l, tag: t, auto: true } : l }
    return l
  })
  const upd = (i: number, ch: Partial<Line>) => setLines(ls => withAuto(ls.map((l, j) => j === i ? { ...l, ...ch, ...('tag' in ch ? { auto: false } : {}) } : l)))
  const lineLbs = (l: Line) => l.whole ? (l.p.current_weight ?? 0) : (parseFloat(l.lbs) || 0)
  const lineErr = (l: Line) => {
    if (l.whole) return ''
    const n = parseFloat(l.lbs), w = l.p.current_weight ?? 0
    if (!(n > 0)) return 'Enter lbs'
    if (n >= w) return `That's the whole pallet (${lbs(w)}). Use Whole.`
    if (!l.pending && !l.tag.trim()) return 'New tag or pending'
    return ''
  }
  const total = lines.reduce((a, l) => a + lineLbs(l), 0)
  const ok = lines.length > 0 && lines.every(l => !lineErr(l))
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="muted">Going to {target}. Add each package: take the whole pallet (keeps its METRC tag) or enter lbs to split off (needs a new tag or pending).</p>
      <div className="field">
        <label>Add a package</label>
        <div className="row tagrow"><input className="grow-in" value={q} onChange={e => setQ(e.target.value)} placeholder="Search strain, pallet # or tag" autoFocus /><ScanButton onScan={setQ} /></div>
        {results.length > 0 && (
          <div className="picklist">
            {results.map(c => (
              <button key={c.id} className="pick addrow" onClick={() => { setLines(ls => withAuto([...ls, { p: c, whole: false, lbs: '', tag: '', pending: false }])); setQ('') }}>
                <b>{c.code}</b><span>{c.strain}</span><span className="muted">{lbs(c.current_weight)} · {whereOf(c)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {lines.map((l, i) => (
        <div key={l.p.id} className="mixline">
          <div className="row between">
            <div><b>{l.p.code}</b> {l.p.strain} <span className="muted">· has {lbs(l.p.current_weight)} · {whereOf(l.p)}</span></div>
            <button className="ghost small" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
          <div className="row">
            <div className="choices">
              <button className={!l.whole ? 'on' : ''} onClick={() => upd(i, { whole: false })}>Part</button>
              <button className={l.whole ? 'on' : ''} onClick={() => upd(i, { whole: true })}>Whole</button>
            </div>
            {!l.whole && <input className="lbs-in" type="number" inputMode="decimal" placeholder="lbs" value={l.lbs} onChange={e => upd(i, { lbs: e.target.value })} />}
          </div>
          {l.whole
            ? <div className="muted">Keeps tag {l.p.package_tag ?? '(none)'}</div>
            : <div className="row">
                <input className="mono-in grow-in" placeholder="New METRC tag" disabled={l.pending} value={l.tag}
                  onChange={e => upd(i, { tag: e.target.value.toUpperCase().replace(/\s/g, '') })} />
                <ScanButton disabled={l.pending} onScan={t => upd(i, { tag: t })} />
                <label className="check"><input type="checkbox" checked={l.pending} onChange={e => upd(i, { pending: e.target.checked, ...(e.target.checked && l.auto ? { tag: '' } : {}) })} /> Pending</label>
              </div>}
          {!l.whole && l.auto && <div className="muted small-note">Next tag in the range (ends <b>{l.tag.slice(-6)}</b>), filled in for you. Scan or type over it if you're using a different one.</div>}
          {lineErr(l) && <div className="warn-t small-note">{lineErr(l)}</div>}
        </div>
      ))}
      {lines.length > 0 && <div className="muted">{lines.length} package{lines.length > 1 ? 's' : ''} · {lbs(total)}</div>}
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Acquamarcia order" /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit(lines.map(l => l.whole
          ? { pallet_id: l.p.id, lbs: null }
          : { pallet_id: l.p.id, lbs: parseFloat(l.lbs), tag: l.pending ? null : l.tag.trim(), tag_pending: l.pending }), note)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Dialog>
  )
}

export function SingleForm({ where, strains, busy, onClose, onSubmit }: {
  where: string; strains: string[]; busy: boolean; onClose: () => void; onSubmit: (i: SingleInput) => void
}) {
  const [code, setCode] = useState('')
  const [strain, setStrain] = useState('')
  const [w, setW] = useState('')
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [hd, setHd] = useState('')
  const [note, setNote] = useState('')
  const known = strains.some(s => s.toLowerCase() === strain.trim().toLowerCase())
  const ok = strain.trim() && parseFloat(w) > 0 && (pending || tag.trim())
  return (
    <Dialog title={`Single pallet in ${where}`} onClose={onClose}>
      <div className="field"><label>Pallet # <span className="muted">(from the label; leave blank to auto-number S1, S2…)</span></label>
        <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="e.g. T011" autoFocus /></div>
      <div className="field"><label>Strain</label>
        <input list="strain-list" value={strain} onChange={e => setStrain(e.target.value)} placeholder="Start typing" />
        <datalist id="strain-list">{strains.map(s => <option key={s} value={s} />)}</datalist>
        {strain.trim() && !known && <div className="warn-t small-note">Not in the Strains list. Check the spelling, or add it in Settings.</div>}
      </div>
      <div className="field"><label>Weight (lbs)</label>
        <input type="number" inputMode="decimal" value={w} onChange={e => setW(e.target.value)} /></div>
      <TagField label="METRC tag" tag={tag} setTag={setTag} pending={pending} setPending={setPending} />
      <div className="field"><label>Harvest date (optional)</label><input type="date" value={hd} onChange={e => setHd(e.target.value)} /></div>
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. found during count" /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit({ code, strain: strain.trim(), lbs: parseFloat(w), tag: pending ? null : tag, tag_pending: pending, harvest_date: hd || null, note })}>Create</button>
      </div>
    </Dialog>
  )
}

export function PickMixed({ mixed, whereOf, onClose, onPick }: { mixed: { p: Pallet; n: number; w: number }[]; whereOf: (p: Pallet) => string; onClose: () => void; onPick: (p: Pallet) => void }) {
  return (
    <Dialog title="Pull for which mixed pallet?" onClose={onClose}>
      {mixed.length === 0 && <p className="muted">No mixed pallets yet. Tap an empty slot on the map and choose New pallet, Mixed.</p>}
      <div className="picklist">
        {mixed.map(m => (
          <button key={m.p.id} className="pick addrow" onClick={() => onPick(m.p)}>
            <b>{m.p.code}</b><span>{m.n} packages · {lbs(m.w)}</span><span className="muted">{whereOf(m.p)}</span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}

/** Merge started from an empty slot: pick a strain, check its partials, new tag, lands in this slot */
export function MergeHere({ where, candidates, whereOf, busy, onClose, onSubmit }: {
  where: string; candidates: Pallet[]; whereOf: (p: Pallet) => string; busy: boolean
  onClose: () => void; onSubmit: (ids: number[], tag: string | null, pending: boolean, note: string) => void
}) {
  const [strain, setStrain] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tag, setTag] = useState('')
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState('')
  const strains = [...new Set(candidates.map(c => c.strain!))].sort()
  const list = candidates.filter(c => c.strain!.toLowerCase() === strain.trim().toLowerCase())
    .sort((a, b) => (a.current_weight ?? 0) - (b.current_weight ?? 0))
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const total = list.filter(c => picked.has(c.id)).reduce((a, c) => a + (c.current_weight ?? 0), 0)
  const ok = picked.size >= 2 && (pending || tag.trim().length > 0)
  return (
    <Dialog title={`Merged pallet in ${where}`} onClose={onClose}>
      <div className="field"><label>Strain</label>
        <input list="merge-strains" value={strain} onChange={e => { setStrain(e.target.value); setPicked(new Set()) }} placeholder="Start typing" autoFocus />
        <datalist id="merge-strains">{strains.map(s => <option key={s} value={s} />)}</datalist>
      </div>
      {strain.trim() && (
        <div className="field">
          <label>Pallets to combine ({list.length} available, smallest first)</label>
          <div className="picklist">
            {list.length === 0 && <div className="muted" style={{ padding: 10 }}>No {strain} pallets available.</div>}
            {list.map(c => (
              <label key={c.id} className={`pick ${picked.has(c.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                <b>{c.code}</b><span>{lbs(c.current_weight)}</span><span className="muted">{whereOf(c)}</span>
              </label>
            ))}
          </div>
          {picked.size > 0 && <div className="muted">{picked.size} pallets · {lbs(total)}{picked.size < 2 ? ' · pick at least two' : ''}</div>}
        </div>
      )}
      <TagField tag={tag} setTag={setTag} pending={pending} setPending={setPending} />
      <div className="field"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} /></div>
      <div className="row end">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSubmit([...picked], pending ? null : tag, pending, note)}>Merge {picked.size || ''} pallets</button>
      </div>
    </Dialog>
  )
}
