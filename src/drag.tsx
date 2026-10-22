// Drag and drop for pallets: mouse drag on computers, press-and-hold then drag on phones.
// Drop targets are elements with data-slot="<id>" or data-tray.
import { useEffect, useState } from 'react'

export interface DragPayload { id: number; label: string }
export type DropTarget = { slot: number } | { tray: true }
type Listener = (s: { payload: DragPayload; x: number; y: number; over: string | null } | null) => void

let dropCb: ((p: DragPayload, t: DropTarget) => void) | null = null
let listeners: Listener[] = []
let dragging: { payload: DragPayload; x: number; y: number } | null = null

export function onDrop(cb: (p: DragPayload, t: DropTarget) => void) { dropCb = cb }

function targetAt(x: number, y: number): { t: DropTarget; key: string } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const s = el?.closest('[data-slot]') as HTMLElement | null
  if (s) return { t: { slot: Number(s.dataset.slot) }, key: `slot-${s.dataset.slot}` }
  if (el?.closest('[data-tray]')) return { t: { tray: true }, key: 'tray' }
  return null
}
function emit() {
  const d = dragging
  listeners.forEach(l => l(d ? { ...d, over: targetAt(d.x, d.y)?.key ?? null } : null))
}
function suppressNextClick() {
  const stop = (e: Event) => { e.stopPropagation(); e.preventDefault() }
  window.addEventListener('click', stop, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 400)
}
function finish(x: number, y: number) {
  const d = dragging
  dragging = null
  emit()
  if (!d) return
  suppressNextClick()
  const hit = targetAt(x, y)
  if (hit && dropCb) dropCb(d.payload, hit.t)
}

if (typeof document !== 'undefined') {
  document.addEventListener('touchmove', e => { if (dragging) e.preventDefault() }, { passive: false })
}

/** spread onto the element that can be dragged */
export function draggable(payload: DragPayload, enabled = true) {
  if (!enabled) return {}
  return {
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const sx = e.clientX, sy = e.clientY
      let started = false
      const move = (ev: MouseEvent) => {
        if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) { started = true; dragging = { payload, x: ev.clientX, y: ev.clientY } }
        if (started && dragging) { dragging.x = ev.clientX; dragging.y = ev.clientY; emit() }
      }
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
        if (started) finish(ev.clientX, ev.clientY)
      }
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]; if (!t) return
      const sx = t.clientX, sy = t.clientY
      let x = sx, y = sy
      const timer = setTimeout(() => { dragging = { payload, x, y }; navigator.vibrate?.(15); emit() }, 380)
      const move = (ev: TouchEvent) => {
        const p = ev.touches[0]; if (!p) return
        x = p.clientX; y = p.clientY
        if (!dragging && Math.hypot(x - sx, y - sy) > 8) cleanup()
        if (dragging) { dragging.x = x; dragging.y = y; emit() }
      }
      const end = () => { const was = !!dragging; cleanup(); if (was) finish(x, y) }
      const cleanup = () => {
        clearTimeout(timer)
        window.removeEventListener('touchmove', move); window.removeEventListener('touchend', end); window.removeEventListener('touchcancel', end)
      }
      window.addEventListener('touchmove', move, { passive: true }); window.addEventListener('touchend', end); window.addEventListener('touchcancel', end)
    },
  }
}

/** the floating chip that follows your finger */
export function DragGhost() {
  const [s, setS] = useState<{ payload: DragPayload; x: number; y: number; over: string | null } | null>(null)
  useEffect(() => { listeners.push(setS); return () => { listeners = listeners.filter(l => l !== setS) } }, [])
  useEffect(() => {
    document.body.classList.toggle('dragging', !!s)
    document.querySelectorAll('.drop-over').forEach(el => el.classList.remove('drop-over'))
    if (s?.over) document.querySelector(s.over === 'tray' ? '[data-tray]' : `[data-slot="${s.over.slice(5)}"]`)?.classList.add('drop-over')
  }, [s])
  if (!s) return null
  return <div className="drag-ghost" style={{ left: s.x, top: s.y }}>{s.payload.label}</div>
}
