// Application log PDF (CCOF / inspections): Lifted's own Farm Data layout, one row per product, built from the Feed and Spray logs.
import type { AppLog } from './api'
import { dfmt } from '../docs'

export const actionOf = (l: AppLog) => l.kind === 'feed' ? (l.method ?? 'Feed') : (l.spray_type ? `Spray (${l.spray_type})` : l.method ?? 'Spray')
const n = (x: number | null | undefined, d = 2) => (x == null || !isFinite(Number(x)) ? '' : (Math.round(Number(x) * 10 ** d) / 10 ** d).toLocaleString())
export const rateUnit = (u: string | null | undefined, basis: string | null | undefined) => `${u ?? ''}${(basis ?? 'acre') === 'acre' ? '' : basis ? ` / ${basis}` : ''}`

/** one row per product line; the log's own columns only on its first line */
export function logRows(logs: AppLog[]): string[][] {
  const out: string[][] = []
  for (const l of logs) {
    const ps = l.products.length ? l.products : [{ product: '', manufacturer: null, rate: null, unit: null, total: null, total_unit: null, basis: null }]
    ps.forEach((p, i) => out.push([
      i === 0 ? dfmt(l.log_on) : '', i === 0 ? actionOf(l) : '', i === 0 && l.water_gal != null ? `${n(l.water_gal, 0)} gal` : '',
      `${l.area ?? ''}${l.module === 'nursery' ? ' (nursery)' : ''}`, i === 0 ? n(l.acres) : '', i === 0 ? n(l.run_min, 0) : '',
      p.product ?? '', p.manufacturer ?? '', n(p.rate), rateUnit(p.unit, p.basis), n(p.total, 1), p.total_unit ?? p.unit ?? '',
    ]))
  }
  return out
}
export const LOG_HEAD = ['Date', 'Action', '# of gallons', 'Location', 'Acres', 'Time (min)', 'Product', 'Manufacturer', 'Rate/Acre', 'Unit', 'Total', '']

export async function appLogPdf(logs: AppLog[], o: { from: string; to: string; site: string | null; who: string; entity: string }): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdf = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' })
  const W = pdf.internal.pageSize.getWidth(), M = 32
  const green: [number, number, number] = [22, 101, 52], ink: [number, number, number] = [24, 32, 27], mute: [number, number, number] = [105, 115, 108], line: [number, number, number] = [221, 226, 220]
  let y = M + 8
  pdf.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...green).text('APPLICATION LOG', M, y)
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute)
  pdf.text(`${o.entity}${o.site ? ` · ${o.site}` : ' · all sites'} · fertility and pest control applications`, M, y + 14)
  pdf.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...ink).text(`${dfmt(o.from)} – ${dfmt(o.to)}`, W - M, y, { align: 'right' })
  pdf.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...mute).text(`${logs.length} application${logs.length === 1 ? '' : 's'} · printed ${dfmt(new Date().toISOString())} by ${o.who}`, W - M, y + 14, { align: 'right' })
  y += 28
  const rows = logRows(logs)
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M },
    head: [LOG_HEAD],
    body: rows,
    styles: { fontSize: 7.5, cellPadding: 2.5, textColor: ink, lineColor: line, lineWidth: 0.4 },
    headStyles: { fillColor: [220, 238, 222], textColor: ink, fontStyle: 'bold' },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 52 }, 1: { fontStyle: 'bold', cellWidth: 74 }, 2: { cellWidth: 48 }, 4: { halign: 'right', cellWidth: 34 },
      5: { halign: 'right', cellWidth: 40 }, 8: { halign: 'right', cellWidth: 46 }, 9: { cellWidth: 46 }, 10: { halign: 'right', cellWidth: 44 }, 11: { cellWidth: 36 } },
    didParseCell: h => { if (h.section === 'body' && rows[h.row.index]?.[0]) h.cell.styles.lineWidth = { top: 0.9, bottom: 0.4, left: 0.4, right: 0.4 } as unknown as number },
  })
  const pages = pdf.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...mute)
    pdf.text(`Lifted Farms application log · page ${i} of ${pages}`, W / 2, pdf.internal.pageSize.getHeight() - 16, { align: 'center' })
  }
  return pdf.output('blob')
}
