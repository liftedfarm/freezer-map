// Manifest sheet for one load stop: everything someone needs to complete the METRC manifest
// (Roshi makes the template, someone finishes it in METRC). Transfers between our licenses and sales stops.
import type { ManifestLicense, StopManifest } from './types'
import { dfmt } from './docs'

const lic = (l: ManifestLicense | null | undefined) => !l ? ['–'] : [
  [l.entity ?? l.name, l.dba ? `dba ${l.dba}` : ''].filter(Boolean).join(' '),
  l.license ? `License ${l.license}${l.kind ? ` (${l.kind})` : ''}` : 'License: not on file',
  l.premises ?? '', ...(l.address ?? '').split('\n'), l.contact ?? '', l.phone ?? '',
].filter(Boolean) as string[]

export const manifestFile = (m: StopManifest) => `Manifest sheet ${m.load} stop ${m.stop} - ${m.to.name ?? m.to.license}.pdf`.replace(/[\\/:*?"<>|]/g, '')

export async function manifestPdf(m: StopManifest): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = pdf.internal.pageSize.getWidth(), M = 40
  const green: [number, number, number] = [22, 101, 52], ink: [number, number, number] = [24, 32, 27], mute: [number, number, number] = [105, 115, 108], line: [number, number, number] = [221, 226, 220]
  let y = M + 6
  pdf.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...green).text(m.transfer ? 'TRANSFER MANIFEST SHEET' : 'MANIFEST SHEET', M, y)
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute)
  pdf.text(`For completing the METRC manifest. Not the manifest itself.`, M, y + 14)
  pdf.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...ink)
  pdf.text(`${m.load} · stop ${m.stop} · ${dfmt(m.load_date)}`, W - M, y, { align: 'right' })
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute)
  pdf.text(`METRC manifest #: ${m.manifest ?? '________________'}`, W - M, y + 14, { align: 'right' })
  y += 34

  const colW = (W - 2 * M - 20) / 3
  const block = (x: number, title: string, rows: string[]) => {
    pdf.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...green).text(title, x, y)
    pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...ink)
    rows.forEach((t, i) => pdf.text(pdf.splitTextToSize(t, colW)[0], x, y + 13 + i * 11.5))
    return y + 13 + rows.length * 11.5
  }
  const fromRows = m.from.length ? m.from.flatMap((f, i) => [...(i ? [' '] : []), ...lic(f)]) : ['Nothing planned on this stop yet']
  const b1 = block(M, m.from.length > 1 ? 'SHIPPER (TWO LICENSES: TWO MANIFESTS)' : 'SHIPPER (FROM)', fromRows)
  const b2 = block(M + colW + 10, m.transfer ? 'DESTINATION (OUR LICENSE)' : 'DESTINATION (CUSTOMER)', lic(m.to))
  const b3 = block(M + 2 * (colW + 10), 'TRANSPORTER', [...lic(m.transporter), `Vehicle: ${m.vehicle ?? '–'}${m.plate ? ` (${m.plate})` : ''}`, `Driver: ${m.driver ?? '________________'}`])
  y = Math.max(b1, b2, b3) + 8
  if (m.orders.length) { pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute).text(`For: ${m.orders.join(', ')}`, M, y); y += 14 }
  pdf.setDrawColor(...line).setLineWidth(0.8).line(M, y, W - M, y); y += 8

  const pk = m.packages, two = m.from.length > 1
  const total = pk.reduce((a, p) => a + Number(p.lbs ?? 0), 0)
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M },
    head: [['#', 'METRC package tag', 'Strain', 'Grown at', ...(two ? ['Picked up at'] : []), 'Batch', 'Harvested', 'Net lbs']],
    body: pk.map((p, i) => [String(i + 1), p.tag ?? (p.tag_pending ? 'TAG PENDING' : '–'), p.strain ?? '', p.origin ?? '?', ...(two ? [p.from ?? '?'] : []), p.batch,
      dfmt(p.harvested), Number(p.lbs ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })]),
    foot: [['', `${pk.length} package${pk.length === 1 ? '' : 's'}`, '', '', ...(two ? [''] : []), '', 'Total', total.toLocaleString(undefined, { maximumFractionDigits: 2 })]],
    styles: { fontSize: 8, cellPadding: 3, textColor: ink, lineColor: line, lineWidth: 0.5 },
    headStyles: { fillColor: green, textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: [236, 243, 237], textColor: ink, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 20 }, 1: { font: 'courier', cellWidth: 128 }, [two ? 7 : 6]: { halign: 'right' } },
    didParseCell: h => { if (h.section === 'body' && h.column.index === 1 && String(h.cell.raw).startsWith('TAG')) h.cell.styles.textColor = [185, 28, 28] },
  })
  const pages = pdf.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...mute)
    pdf.text(`Lifted Farms · ${m.load} stop ${m.stop} · printed ${new Date().toLocaleString()}`, M, pdf.internal.pageSize.getHeight() - 20)
    pdf.text(`${i} / ${pages}`, W - M, pdf.internal.pageSize.getHeight() - 20, { align: 'right' })
  }
  return pdf.output('blob')
}
