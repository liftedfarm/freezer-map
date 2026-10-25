import { useEffect, useRef } from 'react'

// Scan button routing. The Scan button in the bottom bar always reads a METRC tag the same way;
// what happens next depends on the screen you're on. A screen that knows what to do with a tag
// (an order you're filling, a load you're loading, Processing) registers a handler while it's open.
// The newest open screen gets the tag first. A handler returns true if it took care of it;
// otherwise the app opens the pallet card (or "tag not found").
type Handler = (tag: string) => boolean | Promise<boolean>
const handlers: { current: Handler | null }[] = []

export function useScanHandler(h: Handler | null) {
  const ref = useRef<Handler | null>(h)
  ref.current = h
  useEffect(() => {
    const entry = ref
    handlers.push(entry)
    return () => { const i = handlers.indexOf(entry); if (i >= 0) handlers.splice(i, 1) }
  }, [])
}

export async function routeScan(tag: string): Promise<boolean> {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const h = handlers[i].current
    if (h && await h(tag)) return true
  }
  return false
}

export const sameTag = (a: string | null | undefined, b: string) => !!a && a.trim().toUpperCase() === b.trim().toUpperCase()
