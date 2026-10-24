// One vehicle report as a PDF (for the insurance company, an inspector or the file).
import type { Asset, Checklist, Log } from './api'
import type { Doc } from '../comp/api'

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '')
const KIND: Record<string, string> = { maintenance: 'MAINTENANCE RECORD', inspection: 'INSPECTION REPORT', incident: 'INCIDENT REPORT' }
const RES: Record<string, string> = { pass: 'Passed', defects: 'Defects found', out_of_service: 'Out of service' }

export async function reportPdf(l: Log, det: Record<string, unknown>, a: Asset | undefined, cl: Checklist | undefined, files: Doc[]): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = pdf.internal.pageSize.getWidth(), M = 40
  const green: [number, number, number] = [22, 101, 52], ink: [number, number, number] = [24, 32, 27], mute: [number, number, number] = [105, 115, 108], line: [number, number, number] = [221, 226, 220]
  let y = M + 8
  pdf.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...green).text(KIND[l.kind] ?? 'REPORT', M, y)
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute).text('Lifted Farms · DNA Organics, Inc.', M, y + 14)
  pdf.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...ink).text(`${fmt(l.happened_on)}${l.happened_at ? ` ${l.happened_at.slice(0, 5)}` : ''}`, W - M, y, { align: 'right' })
  pdf.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...mute).text(`Report #${l.id} · filed by ${l.created_by ?? ''}`, W - M, y + 14, { align: 'right' })
  y += 30
  const d = det as Record<string, string | boolean | Record<string, string> | undefined>
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
  const rows: [string, string][] = [
    ['Vehicle / equipment', a ? `${a.unit_no ? `${a.unit_no} · ` : ''}${a.name}` : 'None'],
    ...(a ? [['Details', [a.year, a.make, a.model].filter(Boolean).join(' ')], ['VIN / serial', a.vin ?? ''], ['Plate', a.plate ?? ''], ['Site', a.site ?? '']] as [string, string][] : []),
    ...(l.odometer != null ? [['Odometer', `${Number(l.odometer).toLocaleString()} mi`]] as [string, string][] : []),
    ...(l.hours != null ? [['Hours', Number(l.hours).toLocaleString()]] as [string, string][] : []),
    ['Summary', l.summary ?? ''],
  ]
  if (l.kind === 'inspection') rows.push(['Result', RES[l.result ?? ''] ?? ''], ['Notes', s('defects')])
  if (l.kind === 'maintenance') rows.push(['Parts and details', s('parts')], ['Done by', l.performed_by ?? ''], ['Shop / vendor', l.vendor ?? ''],
    ['Cost', l.cost != null ? `$${Number(l.cost).toLocaleString()}` : ''], ['Next service', [fmt(l.next_due_on), l.next_due_miles ? `${Number(l.next_due_miles).toLocaleString()} mi` : '', l.next_due_hours ? `${l.next_due_hours} hrs` : ''].filter(Boolean).join(' or ')])
  if (l.kind === 'incident') rows.push(['Description', s('actions')], ['Where', s('location')], ['People involved', s('people')], ['Anyone hurt', d.injuries === true ? `Yes. ${s('injury_notes')}` : d.injuries === false ? 'No' : ''],
    ['Damage', s('damage')], ['Other vehicle', s('vehicle_other')], ['Police report #', s('police_report')], ['Witnesses', s('witnesses')])
  rows.push(['Status', l.status === 'open' ? 'Open' : `Closed${l.closed_at ? ` ${fmt(l.closed_at)} by ${l.closed_by ?? ''}` : ''}${l.closed_note ? `: ${l.closed_note}` : ''}`])
  if (files.length) rows.push(['Photos and files on record', files.map(f => f.file_name ?? f.title).join(', ')])
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M }, body: rows.filter(r => r[1]),
    styles: { fontSize: 9, cellPadding: 4, textColor: ink, lineColor: line, lineWidth: 0.4 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 140, fillColor: [240, 246, 241] } },
  })
  if (l.kind === 'inspection' && cl) {
    const items = (d.items ?? {}) as Record<string, string>, notes = (d.item_notes ?? {}) as Record<string, string>
    autoTable(pdf, {
      startY: (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 16, margin: { left: M, right: M },
      head: [[cl.label, 'Check', 'Notes']],
      body: cl.items.map(i => [i.l, items[i.k] === 'ok' ? 'OK' : items[i.k] === 'defect' ? 'PROBLEM' : items[i.k] === 'na' ? 'N/A' : '', notes[i.k] ?? '']),
      styles: { fontSize: 8.5, cellPadding: 3, textColor: ink, lineColor: line, lineWidth: 0.4 },
      headStyles: { fillColor: [220, 238, 222], textColor: ink, fontStyle: 'bold' },
      columnStyles: { 1: { cellWidth: 60, fontStyle: 'bold' } },
      didParseCell: h => { if (h.section === 'body' && h.column.index === 1 && h.cell.raw === 'PROBLEM') h.cell.styles.textColor = [176, 30, 30] },
    })
  }
  const H = pdf.internal.pageSize.getHeight()
  pdf.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...mute).text(`Printed ${fmt(new Date().toISOString())} from the Lifted Farms app`, W / 2, H - 18, { align: 'center' })
  return pdf.output('blob')
}
