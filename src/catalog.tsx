import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { MenuRow } from './types'
import { loadMenuInfo } from './strains'
import type { MenuInfo } from './strains'

// Sales > Open menu > Catalog PDF: what's open on the menu, as a photo catalog to send customers.
// Each strain: photo, name, lineage, spot price, yield to solventless and hydrocarbon (from the strain's Sales settings).

const KEY = 'fm.catalog'
type Opts = { title: string; price: number | null; only: 'open' | 'all'; showLbs: boolean; note: string }

export function CatalogButton({ backend, flash }: { backend: Backend; flash: (t: string, bad?: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="ghost small" onClick={() => setOpen(true)}>Catalog PDF</button>
    {open && <CatalogSheet backend={backend} flash={flash} onClose={() => setOpen(false)} />}
  </>
}

function CatalogSheet({ backend, flash, onClose }: { backend: Backend; flash: (t: string, bad?: boolean) => void; onClose: () => void }) {
  const [rows, setRows] = useState<MenuRow[] | null>(null)
  const [info, setInfo] = useState<Map<string, MenuInfo>>(new Map())
  const [busy, setBusy] = useState(false)
  const [o, setO] = useState<Opts>(() => {
    const d: Opts = { title: 'Fresh Frozen Catalog', price: null, only: 'open', showLbs: true, note: '' }
    try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return d }
  })
  useEffect(() => { Promise.all([backend.openMenu(), loadMenuInfo(backend.client())]).then(([m, i]) => { setRows(m); setInfo(i) }).catch(e => flash(String(e?.message ?? e), true)) }, [backend])
  const cy = rows ? Math.max(...rows.map(r => r.crop_year), 0) : 0
  const pick = (rows ?? []).filter(r => r.crop_year === cy && (o.only === 'all' || Number(r.available) > 0)).sort((a, b) => a.strain.localeCompare(b.strain))
  const withPhoto = pick.filter(r => info.get(r.strain.toLowerCase())?.photo_url).length
  const noYield = pick.filter(r => info.get(r.strain.toLowerCase())?.solventless_pct == null).length
  async function make() {
    setBusy(true)
    try {
      try { localStorage.setItem(KEY, JSON.stringify(o)) } catch { /* private */ }
      const settings = await backend.appSettings().catch(() => ({} as Record<string, string>))
      const blob = await catalogPdf(pick, info, o, cy, settings)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `Lifted Farms ${o.title} ${new Date().toISOString().slice(0, 10)}.pdf`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
      flash('Catalog made')
    } catch (e) { flash(String((e as Error).message ?? e), true) } finally { setBusy(false) }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet form" onClick={e => e.stopPropagation()}>
        <div className="sheet-h"><h2>Catalog PDF</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {!rows ? <p className="muted">Loading the menu…</p> : <>
          <div className="field"><label>Title</label><input value={o.title} onChange={e => setO({ ...o, title: e.target.value })} /></div>
          <div className="field"><label>Spot price ($/lb) <span className="muted">(a strain's own spot price in its Sales settings wins)</span></label>
            <input inputMode="decimal" value={o.price ?? ''} placeholder="leave blank to show 'Call'" onChange={e => setO({ ...o, price: e.target.value === '' ? null : Number(e.target.value) })} /></div>
          <div className="field"><label>Strains</label><div className="seg">
            <button className={o.only === 'open' ? 'on' : ''} onClick={() => setO({ ...o, only: 'open' })}>Open now ({rows.filter(r => r.crop_year === cy && Number(r.available) > 0).length})</button>
            <button className={o.only === 'all' ? 'on' : ''} onClick={() => setO({ ...o, only: 'all' })}>Everything on the menu ({rows.filter(r => r.crop_year === cy).length})</button></div></div>
          <label className="check"><input type="checkbox" checked={o.showLbs} onChange={e => setO({ ...o, showLbs: e.target.checked })} /> <span>Show lbs open</span></label>
          <div className="field"><label>Note on the cover <span className="muted">(optional)</span></label><input value={o.note} placeholder="e.g. Pricing good through Nov 30" onChange={e => setO({ ...o, note: e.target.value })} /></div>
          <p className="muted small">{pick.length} strains · {withPhoto} with a photo{noYield ? ` · ${noYield} without a solventless yield yet` : ''}. Photos and yields come from each strain's Sales settings.</p>
          <div className="row between"><span /><div className="row"><button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !pick.length} onClick={make}>{busy ? 'Making…' : 'Make PDF'}</button></div></div>
        </>}
      </div>
    </div>
  )
}

async function imageData(src: string, w: number, h: number, png = false): Promise<string | null> {
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = bad; i.src = src })
    const c = document.createElement('canvas'), s = 2
    c.width = w * s; c.height = h * s
    const r = png ? Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight) : Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight)   // photos cover-crop, logo fits
    const dw = img.naturalWidth * r, dh = img.naturalHeight * r
    c.getContext('2d')!.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
    return png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85)
  } catch { return null }
}

export async function catalogPdf(rows: MenuRow[], info: Map<string, MenuInfo>, o: Opts, cy: number, settings: Record<string, string>): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), M = 36, G = 18
  const green: [number, number, number] = [22, 101, 52], ink: [number, number, number] = [24, 32, 27], mute: [number, number, number] = [105, 115, 108], pale: [number, number, number] = [236, 243, 237]
  const cw = (W - 2 * M - G) / 2, ph = 120, ch = ph + 74
  const logo = await imageData('/logo-big.png', 120, 45, true).catch(() => null)
  const header = (first: boolean) => {
    let y = M
    if (first) {
      if (logo) pdf.addImage(logo, 'PNG', M, y - 6, 120, 45)
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(22); pdf.setTextColor(...ink)
      pdf.text(o.title || 'Catalog', W - M, y + 14, { align: 'right' })
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10); pdf.setTextColor(...mute)
      pdf.text(`${cy} crop · ${rows.length} strains · fresh frozen, priced per lb · ${new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`, W - M, y + 30, { align: 'right' })
      const contact = [settings['company.email'] || 'sales@lifted-organics.com', settings['company.phone'], settings['company.web'] || 'liftedfarms.com'].filter(Boolean).join(' · ')
      pdf.text(contact, W - M, y + 43, { align: 'right' })
      y += 58
      if (o.note) { pdf.setFontSize(10); pdf.setTextColor(...green); pdf.text(o.note, M, y); y += 14 }
      pdf.setDrawColor(...green); pdf.setLineWidth(1.2); pdf.line(M, y, W - M, y)
      return y + 14
    }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(...mute)
    pdf.text(`Lifted Farms · ${o.title || 'Catalog'}`, M, y + 4)
    pdf.setDrawColor(...pale); pdf.line(M, y + 10, W - M, y + 10)
    return y + 22
  }
  let y = header(true), col = 0, page = 1
  const pct = (x: number | null | undefined) => (x == null ? '—' : `${Number(x).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`)
  for (const r of rows) {
    if (y + ch > H - M - 14) { pdf.addPage(); page++; y = header(false); col = 0 }
    const x = M + col * (cw + G), m = info.get(r.strain.toLowerCase())
    const img = m?.photo_url ? await imageData(m.photo_url, cw, ph) : null
    if (img) pdf.addImage(img, 'JPEG', x, y, cw, ph)
    else {
      pdf.setFillColor(...pale); pdf.rect(x, y, cw, ph, 'F')
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(28); pdf.setTextColor(...green)
      pdf.text(r.strain.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase(), x + cw / 2, y + ph / 2 + 10, { align: 'center' })
    }
    let ty = y + ph + 18
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.setTextColor(...ink)
    pdf.text(pdf.splitTextToSize(r.strain, cw - 80)[0], x, ty)
    const price = m?.spot_price ?? o.price
    pdf.setTextColor(...green); pdf.text(price != null ? `$${Number(price).toLocaleString(undefined, { maximumFractionDigits: 2 })}/lb` : 'Call', x + cw, ty, { align: 'right' })
    ty += 13
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(...mute)
    const sub = [m?.lineage, o.showLbs && Number(r.available) > 0 ? `${Number(r.available).toLocaleString()} lbs open` : ''].filter(Boolean).join(' · ')
    if (sub) { pdf.text(pdf.splitTextToSize(sub, cw)[0], x, ty); ty += 13 }
    pdf.setFillColor(...pale); pdf.roundedRect(x, ty - 2, cw, 22, 4, 4, 'F')
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5); pdf.setTextColor(...ink)
    pdf.text(`Solventless ${pct(m?.solventless_pct)}`, x + 8, ty + 12)
    pdf.text(`Hydrocarbon ${pct(m?.hydrocarbon_pct)}`, x + cw - 8, ty + 12, { align: 'right' })
    if (m?.menu_note) { pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8.5); pdf.setTextColor(...mute); pdf.text(pdf.splitTextToSize(m.menu_note, cw)[0], x, ty + 34) }
    col++
    if (col === 2) { col = 0; y += ch + G }
  }
  const pages = pdf.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(...mute)
    pdf.text('Extraction yields are past results and will vary. Availability changes daily.', M, H - 20)
    pdf.text(`${i} / ${pages}`, W - M, H - 20, { align: 'right' })
  }
  void page
  return pdf.output('blob')
}
