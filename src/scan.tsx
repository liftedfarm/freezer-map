// Scan a METRC tag's barcode with the phone camera. The scanner code only loads when you tap Scan.
import { useEffect, useRef, useState } from 'react'

const TAG = /^[0-9A-Z]{24}$/

export function ScanButton({ onScan, disabled }: { onScan: (tag: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="ghost small scanbtn" disabled={disabled} onClick={() => setOpen(true)} title="Scan the tag's barcode">📷 Scan</button>
      {open && <Scanner onClose={() => setOpen(false)} onScan={t => { setOpen(false); onScan(t) }} />}
    </>
  )
}

function Scanner({ onClose, onScan }: { onClose: () => void; onScan: (tag: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const [seen, setSeen] = useState<string | null>(null)
  useEffect(() => {
    let stop: (() => void) | null = null
    let done = false
    ;(async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        if (done || !video.current) return
        const reader = new BrowserMultiFormatReader()
        const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video.current, result => {
          if (!result || done) return
          const text = result.getText().trim().toUpperCase().replace(/\s/g, '')
          const tag = text.match(/[0-9A-Z]{24}/)?.[0] ?? text
          if (TAG.test(tag)) { done = true; controls.stop(); navigator.vibrate?.(30); onScan(tag) }
          else setSeen(text)
        })
        stop = () => controls.stop()
        if (done) stop()
      } catch (e) {
        const m = (e as Error).message ?? String(e)
        setErr(/permission|denied|NotAllowed/i.test(m) ? 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.' : `Couldn't start the camera: ${m}`)
      }
    })()
    return () => { done = true; stop?.() }
  }, [])
  return (
    <div className="scrim scanner" onClick={onClose}>
      <div className="scanbox" onClick={e => e.stopPropagation()}>
        <div className="row between"><b>Point at the barcode on the tag</b><button className="ghost small" onClick={onClose}>✕</button></div>
        {err ? <p className="warn-t">{err}</p> : <div className="scanview"><video ref={video} muted playsInline /><i className="scanline" /></div>}
        {seen && <p className="muted small-note">Read "{seen}", which isn't a METRC tag. Try the package tag's main barcode.</p>}
        <p className="muted small-note">Hold steady about 6 inches away. It fills in by itself once it reads the tag.</p>
      </div>
    </div>
  )
}
