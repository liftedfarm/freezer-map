import { useEffect, useRef } from 'react'

// Phone back button / swipe / browser Back support.
// The app keeps its screens in React state, so without this the phone's back button leaves the app.
// Three layers, all sharing one history stack:
//  - useBack(open, close): any detail view or card. Opening it adds a history entry; Back closes it.
//  - ScrimBack: every pop-up sheet (.scrim) gets the same treatment automatically, no per-sheet code.
//  - useTabHistory: module and tab changes. Back returns to the previous tab.
// History calls are queued so a close (history.back) always finishes before the next push.

type Entry = { id: number; close: () => void }
const stack: Entry[] = []
let seq = 0
let ignore = 0
let pendingBack = false
const queue: (() => void)[] = []
let tabHandler: ((state: unknown) => void) | null = null

function flush() { while (!pendingBack && queue.length) queue.shift()!() }
function run(fn: () => void) { queue.push(fn); flush() }

function doBack() {
  run(() => {
    pendingBack = true; ignore++
    history.back()
    // some browsers never fire popstate when there's nothing to go back to
    setTimeout(() => { if (pendingBack) { pendingBack = false; ignore = Math.max(0, ignore - 1); flush() } }, 500)
  })
}

/** Adds a history entry for something that can be closed with Back. Returns its id. */
export function pushBack(close: () => void): number {
  const id = ++seq
  stack.push({ id, close })
  run(() => history.pushState({ ...(history.state ?? {}), lfb: id }, ''))
  return id
}
/** The thing was closed in the app (✕, Done, Back button): drop its history entry. */
export function releaseBack(id: number) {
  const i = stack.findIndex(e => e.id === id)
  if (i < 0) return
  stack.splice(i, 1)
  doBack()
}
/** Tab-level history entry (state = which module and tab is showing). */
export function pushTab(state: unknown) { run(() => history.pushState({ lft: state }, '')) }
export function replaceTab(state: unknown) { run(() => history.replaceState({ lft: state }, '')) }
export function onTabBack(fn: ((state: unknown) => void) | null) { tabHandler = fn }

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', e => {
    if (ignore > 0) { ignore--; pendingBack = false; flush(); return }
    const top = stack.pop()
    if (top) { top.close(); return }
    const st = (e.state ?? {}) as { lft?: unknown }
    if (st.lft !== undefined) tabHandler?.(st.lft)
  })
}

/** While `open` is true, the phone/browser Back button calls `close` instead of leaving the screen. */
export function useBack(open: boolean, close: () => void) {
  const ref = useRef(close)
  ref.current = close
  useEffect(() => {
    if (!open) return
    let done = false
    const id = pushBack(() => { done = true; ref.current() })
    return () => { if (!done) releaseBack(id) }
  }, [open])
}

/** Watches the page for pop-up sheets (.scrim) and wires each one to Back.
 *  Back taps the sheet's backdrop, which every sheet already treats as close. */
export function useScrimBack() {
  useEffect(() => {
    const ids = new Map<Element, { id: number; done: boolean }>()
    const sync = () => {
      const now = new Set(document.querySelectorAll('.scrim'))
      for (const [el, v] of ids) if (!now.has(el)) { ids.delete(el); if (!v.done) releaseBack(v.id) }
      for (const el of now) if (!ids.has(el)) {
        const v = { id: 0, done: false }
        v.id = pushBack(() => { v.done = true; (el as HTMLElement).click() })
        ids.set(el, v)
      }
    }
    const mo = new MutationObserver(sync)
    mo.observe(document.body, { childList: true, subtree: true })
    sync()
    return () => mo.disconnect()
  }, [])
}

/** Module/tab history: pushes an entry whenever `state` changes (by the user), restores it on Back. */
export function useTabHistory<T>(state: T, restore: (s: T) => void) {
  const key = JSON.stringify(state)
  const restoring = useRef(false)
  const first = useRef(true)
  const rref = useRef(restore)
  rref.current = restore
  const kref = useRef(key)
  kref.current = key
  useEffect(() => {
    onTabBack(s => { if (JSON.stringify(s) !== kref.current) restoring.current = true; rref.current(s as T) })
    return () => onTabBack(null)
  }, [])
  useEffect(() => {
    if (first.current) { first.current = false; replaceTab(state); return }
    if (restoring.current) { restoring.current = false; return }
    pushTab(state)
  }, [key])
}

// The app scrolls inside .app.shell, not the window (iOS Safari moves fixed bars while its toolbar
// resizes, which left the bottom menu floating mid-screen). Use these instead of window.scrollTo / scrollY.
const scroller = () => document.querySelector<HTMLElement>('.app.shell')
export function scrollTop(y = 0) { const el = scroller(); if (el) el.scrollTo(0, y); else window.scrollTo(0, y) }
export function scrollPos() { const el = scroller(); return el ? el.scrollTop : window.scrollY }
