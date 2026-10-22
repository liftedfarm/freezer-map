// Sales Order and Invoice PDFs, laid out like the Business Central invoice design
// (SharePoint: Microsoft Business Central / Importing For Real / Invoice Design).
// jsPDF only loads when someone opens a document.

export interface DocLine { id: number; kind: 'product' | 'charge'; item: string | null; description: string; strain: string | null; crop_year: number | null
  qty: number; uom: string; price: number; amount: number; packages: { tag: string | null; pallet: string | null; lbs: number | null; batch: string | null }[] }
export interface SalesDoc {
  kind: 'invoice' | 'so'; id: number; number: string; so: string | null; po: string | null; date: string | null; due?: string | null; wanted?: string | null
  terms: string | null; terms_code: string | null; schedule?: { pct: number; amount: number; due: string }[]; total: number; status: string; notes: string | null
  ship_date?: string | null; token: string; acct_status?: string; sent_at?: string | null; nursery?: boolean
  company: { legal: string; address: string; email: string; phone: string; web: string; license: string | null; remit: string; crypto: string; late: string }
  customer: { id: number; name: string; legal_name: string | null; license: string | null; billing_address: string | null; billing_contact: string | null; billing_email: string | null
    billing_phone: string | null; ship_to_name: string | null; ship_to_address: string | null; receiving_contact: string | null; terms: string | null; kind?: string | null }
  lines: DocLine[]
}

export const money = (x: number) => '$' + Number(x ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyFmt = (x: number) => Number(x ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const dfmt = (s: string | null | undefined) => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-'); return `${m}/${d}/${y}` }
export const docTitle = (d: SalesDoc) => d.kind === 'invoice' ? 'Sales Invoice' : 'Sales Order'
export const docFile = (d: SalesDoc) => `${d.kind === 'invoice' ? 'Invoice' : 'Sales Order'} ${d.number} - ${d.customer.name}.pdf`.replace(/[\\/:*?"<>|]/g, '')
export const shareUrl = (d: SalesDoc) => `${location.origin}/?doc=${d.token}`

async function logoData(): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = '/logo-big.png' })
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    c.getContext('2d')!.drawImage(img, 0, 0)
    return { data: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight }
  } catch { return null }
}

export async function makePdf(d: SalesDoc): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = pdf.internal.pageSize.getWidth(), M = 40
  const green: [number, number, number] = [22, 101, 52], ink: [number, number, number] = [24, 32, 27], mute: [number, number, number] = [105, 115, 108], line: [number, number, number] = [221, 226, 220]
  const inv = d.kind === 'invoice'
  let y = M

  // ---- header: logo + company (left), title + details box (right)
  const logo = d.nursery ? null : await logoData()   // clone invoices come from the nursery's own entity
  if (logo) { const h = 46, w = h * logo.w / logo.h; pdf.addImage(logo.data, 'PNG', M, y, w, h); y += h + 8 }
  pdf.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...ink).text(d.company.legal, M, y + 4)
  pdf.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...mute)
  const compLines = [...d.company.address.split('\n'), d.company.email, d.company.phone, d.company.web, d.company.license ? `License ${d.company.license}` : ''].filter(Boolean)
  compLines.forEach((t, i) => pdf.text(t, M, y + 16 + i * 11))
  const leftBottom = y + 16 + compLines.length * 11

  const bx = W - M - 230
  pdf.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...green).text(inv ? 'SALES INVOICE' : 'SALES ORDER', W - M, M + 18, { align: 'right' })
  const rows: [string, string][] = inv
    ? [['Invoice No.', d.number], ['Invoice Date', dfmt(d.date)], ['Due Date', dfmt(d.due)], ['Payment Terms', d.terms ?? ''], ['Sales Order No.', d.so ?? ''], ['Customer PO', d.po ?? '']]
    : [['Sales Order No.', d.number], ['Order Date', dfmt(d.date)], ['Requested', dfmt(d.wanted)], ['Payment Terms', d.terms ?? ''], ['Customer PO', d.po ?? '']]
  let ry = M + 34
  pdf.setDrawColor(...line).setLineWidth(0.8).roundedRect(bx, ry - 12, 230, rows.length * 15 + 10, 4, 4)
  rows.forEach(([k, v]) => {
    pdf.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...mute).text(k, bx + 10, ry + 2)
    pdf.setFont('helvetica', 'bold').setTextColor(...ink).text(v || '–', bx + 220, ry + 2, { align: 'right' }); ry += 15
  })
  y = Math.max(leftBottom, ry) + 14

  // ---- customer & delivery
  const section = (t: string) => { pdf.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...green).text(t, M, y); pdf.setDrawColor(...green).setLineWidth(1).line(M, y + 4, W - M, y + 4); y += 18 }
  section('CUSTOMER & DELIVERY')
  const c = d.customer, colW = (W - 2 * M - 20) / 2
  const block = (x: number, title: string, lines: string[]) => {
    pdf.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...mute).text(title, x, y)
    let yy = y + 13
    lines.filter(Boolean).forEach((t, i) => {
      pdf.setFont('helvetica', i === 0 ? 'bold' : 'normal').setFontSize(9).setTextColor(...ink)
      const wrapped = pdf.splitTextToSize(t, colW) as string[]; pdf.text(wrapped, x, yy); yy += wrapped.length * 11
    })
    return yy
  }
  const b1 = block(M, 'BILL TO', [c.legal_name || c.name, c.legal_name && c.legal_name !== c.name && c.kind !== 'internal' ? `dba ${c.name}` : '', ...(c.billing_address ?? '').split('\n'),
    c.billing_contact ? `Billing contact: ${c.billing_contact}` : '', c.billing_phone ?? '', c.billing_email ?? ''])
  const b2 = block(M + colW + 20, 'SHIP TO', [c.ship_to_name || c.name, ...(c.ship_to_address ?? '').split('\n'), c.license ? `Premises DCC License: ${c.license}` : '',
    c.receiving_contact ? `Receiving contact: ${c.receiving_contact}` : ''])
  y = Math.max(b1, b2) + 10

  // ---- line items
  section('LINE ITEMS')
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M },
    head: [['PRODUCT', 'QTY', 'UOM', 'PRICE', 'AMOUNT']],
    body: d.lines.map(l => [l.description + (l.kind === 'product' && l.crop_year ? `\n${l.crop_year} crop` : ''), qtyFmt(l.qty), l.uom, money(l.price), money(l.amount)]),
    didParseCell: (h: { section: string; column: { index: number }; cell: { styles: { halign: string } } }) => { if (h.section === 'head' && [1, 3, 4].includes(h.column.index)) h.cell.styles.halign = 'right' },
    styles: { font: 'helvetica', fontSize: 9, textColor: ink, cellPadding: 5, lineColor: line, lineWidth: 0.5 },
    headStyles: { fillColor: [240, 244, 240], textColor: mute, fontStyle: 'bold', fontSize: 8 },
    columnStyles: { 1: { halign: 'right', cellWidth: 70 }, 2: { cellWidth: 40 }, 3: { halign: 'right', cellWidth: 70 }, 4: { halign: 'right', cellWidth: 85 } },
  })
  y = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8
  pdf.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...ink).text(inv ? 'Total Due' : 'Order Total', W - M - 95, y + 10, { align: 'right' }).text(money(d.total), W - M, y + 10, { align: 'right' })
  y += 18
  if (inv && d.schedule && d.schedule.length > 1) {
    pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute)
    d.schedule.forEach(s => { pdf.text(`${s.pct}% due ${dfmt(s.due)}`, W - M - 95, y + 8, { align: 'right' }); pdf.setTextColor(...ink).text(money(s.amount), W - M, y + 8, { align: 'right' }); pdf.setTextColor(...mute); y += 12 })
  }
  if (d.notes) { y += 6; pdf.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(...mute); const t = pdf.splitTextToSize(`Notes: ${d.notes}`, W - 2 * M) as string[]; pdf.text(t, M, y + 8); y += t.length * 11 }
  y += 14

  // ---- payment & remittance
  const need = (h: number) => { if (y + h > pdf.internal.pageSize.getHeight() - 50) { pdf.addPage(); y = M } }
  need(90)
  section('PAYMENT & REMITTANCE')
  pdf.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...ink)
  for (const t of [d.company.remit, d.company.crypto ? `Crypto: ${d.company.crypto}` : '']) { if (!t) continue; const w = pdf.splitTextToSize(t, W - 2 * M) as string[]; pdf.text(w, M, y); y += w.length * 11 + 2 }
  pdf.setFontSize(7.5).setTextColor(...mute); const late = pdf.splitTextToSize(d.company.late, W - 2 * M) as string[]; pdf.text(late, M, y + 2); y += late.length * 9.5 + 14

  // ---- METRC (invoice only)
  const pk = d.lines.flatMap(l => l.packages.map(p => [l.description, qtyFmt(Number(p.lbs ?? 0)), l.uom, p.batch ?? '', p.tag ?? (p.pallet ? `${p.pallet} (tag pending)` : '')]))
  if (inv && pk.length) {
    need(60)
    section('METRC INFORMATION')
    autoTable(pdf, {
      startY: y, margin: { left: M, right: M },
      head: [['PRODUCT', 'QTY', 'UOM', 'BATCH', 'PACKAGE TAG']], body: pk,
      styles: { font: 'helvetica', fontSize: 8, textColor: ink, cellPadding: 4, lineColor: line, lineWidth: 0.5 },
      headStyles: { fillColor: [240, 244, 240], textColor: mute, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: { 1: { halign: 'right', cellWidth: 55 }, 2: { cellWidth: 32 } },
      didParseCell: (h: { section: string; column: { index: number }; cell: { styles: { halign: string } } }) => { if (h.section === 'head' && h.column.index === 1) h.cell.styles.halign = 'right' },
    })
  }

  // ---- footer on every page
  const n = pdf.getNumberOfPages()
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...mute)
    pdf.text(`${d.nursery ? d.company.legal : 'Lifted Farms'} - ${docTitle(d)} ${d.number}`, M, pdf.internal.pageSize.getHeight() - 24)
    pdf.text(`Page ${i} of ${n}`, W - M, pdf.internal.pageSize.getHeight() - 24, { align: 'right' })
  }
  return pdf.output('blob')
}

export async function downloadPdf(d: SalesDoc) {
  const blob = await makePdf(d)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = docFile(d); document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** a pre-filled email in the salesperson's own mail app (attach the downloaded PDF, or the link does the job) */
export function emailHref(d: SalesDoc, from?: string | null) {
  const what = d.kind === 'invoice' ? `Invoice ${d.number}` : `Sales Order ${d.number}`
  const body = [`Hi${d.customer.billing_contact ? ` ${d.customer.billing_contact.split(/[ ,]/)[0]}` : ''},`, '',
    d.kind === 'invoice' ? `Here's ${what} for ${money(d.total)}${d.due ? `, due ${dfmt(d.due)}` : ''} (${d.terms ?? ''}).` : `Here's ${what} for your records (${money(d.total)}, ${d.terms ?? ''}).`,
    `View or download it here: ${shareUrl(d)}`, '', 'Thank you,', from ?? (d.nursery ? d.company.legal : 'Lifted Farms')].join('\n')
  return `mailto:${encodeURIComponent(d.customer.billing_email ?? '')}?subject=${encodeURIComponent(`${what} from ${d.nursery ? d.company.legal : 'Lifted Farms'}`)}&body=${encodeURIComponent(body)}`
}
export function textHref(d: SalesDoc) {
  return `sms:?&body=${encodeURIComponent(`${d.nursery ? d.company.legal : 'Lifted Farms'} ${d.kind === 'invoice' ? 'invoice' : 'sales order'} ${d.number}: ${shareUrl(d)}`)}`
}
