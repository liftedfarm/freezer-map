import { useEffect, useState } from 'react'
import type { Backend } from './api'
import type { Statement } from './types'
import { dfmt, logoData, money } from './docs'
import { Tile, Tiles } from './dash'

// Customer dashboard and statement (feedback 10/24, Matt): current balance, lbs picked up this month vs. the monthly minimum,
// reserves left, and a statement with a PDF. Same thing in the portal (their own) and in Sales (any customer).
// The balance is QuickBooks' customer balance once QuickBooks production is connected (it has the payments, credit memos
// and Roshi-era invoices); until then it's the app's own open invoices.

const n0 = (x: number | null | undefined) => Math.round(Number(x ?? 0)).toLocaleString()
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const monthName = (iso: string) => new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString([], { month: 'long' })
const TYPE_L: Record<string, string> = { Invoice: 'Invoice', Credit: 'Credit memo', Payment: 'Unapplied payment' }

export function useStatement(backend: Backend, customerId?: number | null, rev = 0) {
  const [s, setS] = useState<Statement | null | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setS(undefined)
    backend.statement(customerId).then(x => { setS(x); setErr(null) }).catch(e => { setS(null); setErr(String((e as Error).message ?? e)) })
  }, [customerId, rev])
  return { s, err }
}

/** the four numbers at the top of a customer's dashboard */
export function StatementTiles({ s, onBalance }: { s: Statement; onBalance?: () => void }) {
  const b = s.balance, m = s.month, r = s.reserves
  return (
    <Tiles>
      <Tile label="Current balance" value={money(b.amount)} tone={b.past_due > 0 ? 'warn' : 'ok'} onClick={onBalance}
        sub={b.past_due > 0 ? `${money(b.past_due)} past due` : b.amount > 0 ? 'nothing past due' : 'all paid up'} />
      <Tile label={`Picked up in ${monthName(m.start)}`} value={`${n0(m.shipped)} lbs`} tone={m.min && m.left ? 'info' : undefined}
        sub={m.min ? (m.left ? `${n0(m.left)} lbs left of your ${n0(m.min)} lb monthly minimum` : `monthly minimum of ${n0(m.min)} lbs met`) : 'no monthly minimum'} />
      {r.strains > 0 && <Tile label={`${r.year} reserves left`} value={`${n0(r.remaining)} lbs`} sub={`of ${n0(r.reserved)} reserved · ${n0(r.shipped)} picked up`} />}
      <Tile label="Ordered, not shipped yet" value={`${n0(s.pending_lbs)} lbs`} sub={s.pending_lbs ? 'on open orders' : 'no open orders'} />
    </Tiles>
  )
}

/** the statement: what QuickBooks has open, and every invoice in the last 12 months */
export function StatementView({ s, staff }: { s: Statement; staff?: boolean }) {
  const [busy, setBusy] = useState(false)
  const b = s.balance
  const open = s.invoices.filter(i => i.status === 'open' && i.balance > 0)
  return (
    <div className="stmt">
      <div className="row between wrap">
        <p className="muted small">{b.source === 'quickbooks' ? `From our books, updated ${when(b.synced_at)}.` : staff ? 'QuickBooks production isn\'t connected yet, so this is the app\'s own open invoices (no credit memos or Roshi invoices).' : 'From our invoices. Payments can take a day to show.'}</p>
        <button className="ghost small" disabled={busy} onClick={async () => { setBusy(true); try { await downloadStatement(s) } finally { setBusy(false) } }}>{busy ? 'Making PDF…' : 'Download statement (PDF)'}</button>
      </div>
      {b.source === 'quickbooks' && s.open_items.length > 0 && <>
        <h3>Open items</h3>
        <div className="cwrap"><table className="restable wide">
          <thead><tr><th>Date</th><th>Type</th><th>#</th><th>Due</th><th className="num">Amount</th><th className="num">Open</th></tr></thead>
          <tbody>{s.open_items.map((x, i) => <tr key={i} className={x.type === 'Invoice' && x.due && x.due < today() ? 'pastdue' : ''}>
            <td>{dfmt(x.date)}</td><td>{TYPE_L[x.type] ?? x.type}</td><td>{x.doc ?? ''}</td><td>{dfmt(x.due)}</td>
            <td className="num">{money(x.total)}</td><td className="num"><b>{money(x.balance)}</b></td></tr>)}</tbody>
          <tfoot><tr><td colSpan={5}><b>Balance</b></td><td className="num"><b>{money(b.amount)}</b></td></tr></tfoot>
        </table></div>
      </>}
      {b.source === 'app' && open.length > 0 && <p className="muted small">{open.length} open invoice{open.length === 1 ? '' : 's'}.</p>}
      <h3>Invoices <span className="muted small">since {dfmt(s.from)}</span></h3>
      {!s.invoices.length ? <p className="muted">No invoices yet.</p> : <div className="cwrap"><table className="restable wide">
        <thead><tr><th>Date</th><th>Invoice</th><th className="hide-s">Order</th><th>Due</th><th className="num">Total</th><th className="num">Open</th><th></th></tr></thead>
        <tbody>{s.invoices.map(i => <tr key={i.id} className={i.past_due ? 'pastdue' : ''}>
          <td>{dfmt(i.invoice_date)}</td><td><a href={`/?doc=${i.share_token}`} target="_blank" rel="noreferrer">{i.inv_number}</a></td><td className="hide-s">{i.so_number ?? ''}</td>
          <td>{dfmt(i.due_date)}</td><td className="num">{money(i.total)}</td><td className="num">{i.balance ? money(i.balance) : ''}</td>
          <td><span className={`pill ${i.status === 'paid' || !i.balance ? 'cp-ok' : i.past_due ? 'cp-bad' : 'cp-warn'}`}>{i.status === 'paid' || !i.balance ? 'Paid' : i.past_due ? 'Past due' : 'Open'}</span></td></tr>)}</tbody>
      </table></div>}
    </div>
  )
}

/** dashboard tiles plus a fold-out statement; loads by itself */
export function CustomerDashboard({ backend, customerId, staff, rev = 0 }: { backend: Backend; customerId?: number | null; staff?: boolean; rev?: number }) {
  const { s, err } = useStatement(backend, customerId, rev)
  const [open, setOpen] = useState(false)
  if (err) return staff ? <div className="warnbox">{err}</div> : null
  if (s === undefined) return <p className="muted">Loading…</p>
  if (!s) return null
  return (
    <div className="cdash">
      <StatementTiles s={s} onBalance={() => setOpen(true)} />
      <button className="linkbtn" onClick={() => setOpen(!open)}>{open ? '▾ Hide statement' : '▸ Statement and invoices'}</button>
      {open && <StatementView s={s} staff={staff} />}
    </div>
  )
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export async function statementPdf(s: Statement): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = pdf.internal.pageSize.getWidth(), M = 40
  const green: [number, number, number] = [22, 101, 52], ink: [number, number, number] = [24, 32, 27], mute: [number, number, number] = [105, 115, 108], line: [number, number, number] = [221, 226, 220]
  let y = M
  const logo = await logoData()
  if (logo) { const h = 46, w = h * logo.w / logo.h; pdf.addImage(logo.data, 'PNG', M, y, w, h) }
  pdf.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...green).text('STATEMENT', W - M, y + 16, { align: 'right' })
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute).text(`as of ${dfmt(today())}`, W - M, y + 30, { align: 'right' })
  y += 66
  pdf.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...ink).text(s.customer.name, M, y)
  pdf.setFont('helvetica', 'bold').setFontSize(11).text(`Balance ${money(s.balance.amount)}`, W - M, y, { align: 'right' })
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...mute)
  if (s.balance.past_due > 0) pdf.text(`${money(s.balance.past_due)} past due`, W - M, y + 13, { align: 'right' })
  y += 26
  const style = { fontSize: 8.5, cellPadding: 3.5, textColor: ink, lineColor: line, lineWidth: 0.4 }
  const head = { fillColor: [220, 238, 222] as [number, number, number], textColor: ink, fontStyle: 'bold' as const }
  if (s.balance.source === 'quickbooks' && s.open_items.length) {
    autoTable(pdf, {
      startY: y, margin: { left: M, right: M }, styles: style, headStyles: head,
      head: [['Date', 'Type', '#', 'Due', 'Amount', 'Open']],
      body: s.open_items.map(x => [dfmt(x.date), TYPE_L[x.type] ?? x.type, x.doc ?? '', dfmt(x.due), money(x.total), money(x.balance)]),
      foot: [['', '', '', '', 'Balance', money(s.balance.amount)]], footStyles: { fillColor: [245, 247, 245], textColor: ink, fontStyle: 'bold' },
      columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' } },
    })
    y = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18
    pdf.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...ink).text(`Invoices since ${dfmt(s.from)}`, M, y); y += 6
  }
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M }, styles: style, headStyles: head,
    head: [['Date', 'Invoice', 'Order', 'Due', 'Total', 'Open', '']],
    body: s.invoices.map(i => [dfmt(i.invoice_date), i.inv_number, i.so_number ?? '', dfmt(i.due_date), money(i.total), i.balance ? money(i.balance) : '',
      i.status === 'paid' || !i.balance ? 'Paid' : i.past_due ? 'Past due' : 'Open']),
    columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' } },
    didParseCell: h => { if (h.section === 'body' && h.column.index === 6 && h.cell.raw === 'Past due') h.cell.styles.textColor = [176, 30, 30] },
  })
  const H = pdf.internal.pageSize.getHeight()
  pdf.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...mute)
    .text('Lifted Farms · DNA Organics, Inc. · Questions about your account? Reply to your invoice email or call your Lifted contact.', W / 2, H - 20, { align: 'center' })
  return pdf.output('blob')
}

export async function downloadStatement(s: Statement) {
  const b = await statementPdf(s)
  const u = URL.createObjectURL(b)
  const a = document.createElement('a'); a.href = u; a.download = `Statement ${today()} - ${s.customer.name}.pdf`.replace(/[\\/:*?"<>|]/g, '')
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(u), 60000)
}
