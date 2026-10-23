// Reading a METRC Active Packages export (CSV or Excel). Column names vary a bit, so headers are matched loosely.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  const t = text.replace(/^﻿/, '')
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(c => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some(c => c.trim() !== '')) rows.push(row)
  return rows
}

export async function readTable(f: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(f.name)) {
    const { readSheet } = await import('read-excel-file/browser')
    const rows = await readSheet(f)
    return rows.map(r => r.map(c => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))))
  }
  return parseCsv(await f.text())
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const SYN: Record<string, string[]> = {
  tag: ['tag', 'package tag', 'package', 'label', 'package label'],
  item: ['item', 'item name', 'product', 'product name'],
  category: ['category', 'item category', 'product category'],
  qty: ['quantity', 'qty', 'current quantity', 'quantity on hand'],
  uom: ['uom', 'unit of measure', 'unit', 'units', 'quantity uom'],
  location: ['location', 'location name', 'room'],
  lab_status: ['lab test', 'lab testing', 'lab testing state', 'lab test status', 'testing status', 'lab status'],
  on_hold: ['on hold', 'is on hold', 'hold'],
  packaged_on: ['date', 'packaged date', 'package date', 'packaged', 'created'],
  harvest: ['src h s', 'src hs', 'source harvests', 'source harvest', 'harvest', 'harvest batch', 'src harvests', 'source harvest names'],
}
export type Field = keyof typeof SYN
export const FIELD_LABEL: Record<Field, string> = { tag: 'Tag', item: 'Item', category: 'Category', qty: 'Quantity', uom: 'Unit', location: 'Location', lab_status: 'Lab test', on_hold: 'On hold', packaged_on: 'Date', harvest: 'Source harvest' }

/** find the header row (first row with a Tag column) and map columns */
export function mapColumns(rows: string[][]): { header: number; cols: Partial<Record<Field, number>> } | null {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const hs = rows[h].map(norm)
    const cols: Partial<Record<Field, number>> = {}
    for (const [f, names] of Object.entries(SYN) as [Field, string[]][]) {
      const i = hs.findIndex(x => names.includes(x))
      if (i >= 0) cols[f] = i
    }
    if (cols.tag != null) return { header: h, cols }
  }
  return null
}

const date = (s: string) => {
  const v = s.trim(); if (!v) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` }
  return null
}

export interface MRow { tag: string; item: string | null; category: string | null; qty: number | null; uom: string | null; location: string | null; lab_status: string | null; on_hold: boolean; packaged_on: string | null; harvest: string | null; raw: Record<string, string> }

export function toRows(rows: string[][], map: { header: number; cols: Partial<Record<Field, number>> }): MRow[] {
  const head = rows[map.header]
  const get = (r: string[], f: Field) => (map.cols[f] == null ? '' : (r[map.cols[f]!] ?? '').trim())
  const out: MRow[] = []
  for (const r of rows.slice(map.header + 1)) {
    const tag = get(r, 'tag').toUpperCase().replace(/\s+/g, '')
    if (!/^[0-9A-Z]{10,}$/.test(tag)) continue
    // quantity can come as "123.45 lb" in one column
    let qtyS = get(r, 'qty'), uom = get(r, 'uom') || null
    const m = qtyS.match(/^\s*([-\d.,]+)\s*([a-zA-Z() ]+)?\s*$/)
    if (m) { qtyS = m[1].replace(/,/g, ''); if (!uom && m[2]) uom = m[2].trim() }
    const qty = qtyS === '' ? null : Number(qtyS)
    const hold = get(r, 'on_hold')
    out.push({ tag, item: get(r, 'item') || null, category: get(r, 'category') || null, qty: qty != null && isFinite(qty) ? qty : null, uom,
      location: get(r, 'location') || null, lab_status: get(r, 'lab_status') || null, on_hold: /^(y|yes|true|1|on hold)$/i.test(hold),
      packaged_on: date(get(r, 'packaged_on')), harvest: get(r, 'harvest') || null,
      raw: Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']).filter(([h]) => h)) })
  }
  return out
}

/** a CSV file from rows (for exports) */
export function toCsv(head: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [head, ...rows].map(r => r.map(esc).join(',')).join('\n')
}
export function download(name: string, text: string, type = 'text/csv') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
