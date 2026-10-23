// Reading the CCOF "OSP Materials List" PDF (MyCCOF › materials list) into rows.
// Columns by position on the page: Code | Input/Material | Manufacturer | Approved on | Status, Restrictions & Comments.

export interface CcofRow {
  code: string; name: string; manufacturer: string; category: string | null; approved_on: string | null
  status: string | null; listing: string | null; restriction: string | null; comment: string | null; action_required: boolean
}
export interface PItem { x: number; y: number; str: string }   // y = distance from the top of the page (baseline)
export interface PPage { height: number; width: number; items: PItem[] }

/** rows from the text of every page */
export function parseCcof(pages: PPage[]): { rows: CcofRow[]; listDate: string | null } {
  type Cur = { code: string; name: string[]; mfr: string[]; date: string; cmt: string[]; cat: string | null; action: boolean }
  const raw: Cur[] = []
  let cat: string | null = null, action = false, cur: Cur | null = null, listDate: string | null = null
  const flush = () => { if (cur) raw.push(cur); cur = null }
  for (const pg of pages) {
    const sx = pg.width / 792   // the list is printed landscape letter (792 x 612)
    const head = pg.items.map(i => i.str).join(' ').replace(/\s+/g, ' ')
    const gd = head.match(/Generated on (\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (gd && !listDate) listDate = `${gd[3]}-${gd[1].padStart(2, '0')}-${gd[2].padStart(2, '0')}`
    const body = pg.items.filter(i => i.str.trim() && i.y > 105 * (pg.height / 612) && i.y < pg.height - 45 * (pg.height / 612))
    // words: some PDFs give whole runs; split runs that cross a column edge is rare here, keep runs whole
    const lines: { y: number; items: PItem[] }[] = []
    for (const it of [...body].sort((a, b) => a.y - b.y)) {
      const l = lines[lines.length - 1]
      if (l && it.y - l.y <= 3.5) l.items.push(it); else lines.push({ y: it.y, items: [it] })
    }
    for (const l of lines) {
      const ws = l.items.sort((a, b) => a.x - b.x)
      const text = ws.map(w => w.str.trim()).join(' ').replace(/\s+/g, ' ').trim()
      const firstX = ws[0].x / sx
      if (firstX < 45 && !/^\d{5}\b/.test(text)) {
        if (/^APPROVED - ACTION REQUIRED/.test(text)) { flush(); action = true; continue }
        if (text === 'APPROVED') { flush(); action = false; continue }
        if (/^Code Input\/Material/.test(text)) continue
        if (/ - Approved/.test(text)) { flush(); cat = text.replace(/\s*-\s*Approved.*$/, ''); continue }
      }
      const cols: Record<'code' | 'name' | 'mfr' | 'date' | 'cmt', string[]> = { code: [], name: [], mfr: [], date: [], cmt: [] }
      for (const w of ws) {
        const x = w.x / sx
        const k = x < 70 ? 'code' : x < 232 ? 'name' : x < 328 ? 'mfr' : x < 394 ? 'date' : 'cmt'
        // a run that starts in the code column can carry the name too ("01771 Down To Earth…")
        if (k === 'code') { const m = w.str.trim().match(/^(\d{5})\s*(.*)$/); if (m) { cols.code.push(m[1]); if (m[2]) cols.name.push(m[2]) } else cols.code.push(w.str.trim()) }
        else cols[k].push(w.str.trim())
      }
      if (cols.code.length && /^\d{5}$/.test(cols.code[0])) { flush(); cur = { code: cols.code[0], name: [], mfr: [], date: '', cmt: [], cat, action } }
      if (!cur) continue
      const c = cur as Cur
      if (cols.name.length) c.name.push(cols.name.join(' '))
      if (cols.mfr.length) c.mfr.push(cols.mfr.join(' '))
      if (cols.date.length) c.date = cols.date.join(' ')
      if (cols.cmt.length) c.cmt.push(cols.cmt.join(' '))
    }
  }
  flush()
  const sp = (xs: string[]) => xs.join(' ').replace(/\s+/g, ' ').trim()
  const rows = raw.map(r => {
    const cmt = sp(r.cmt)
    const m = cmt.match(/OCal:\s*(.*)$/)
    const pre = m ? cmt.slice(0, m.index).trim() : cmt
    let oc = m ? m[1] : ''
    let restr: string | null = null
    const mr = oc.match(/,?\s*Restriction:\s*(.*)$/)
    if (mr) { restr = mr[1].trim(); oc = oc.slice(0, mr.index) }
    const i = oc.indexOf(' - ')
    const st = (i >= 0 ? oc.slice(0, i) : oc).trim(), listing = i >= 0 ? oc.slice(i + 3).trim() : ''
    const dm = r.date.match(/(\d\d)\/(\d\d)\/(\d\d)/)
    return { code: r.code, name: sp(r.name), manufacturer: sp(r.mfr), category: r.cat, approved_on: dm ? `20${dm[3]}-${dm[1]}-${dm[2]}` : null,
      status: st || null, listing: listing || null, restriction: restr, comment: pre || null, action_required: r.action }
  })
  return { rows, listDate }
}

/** read the PDF in the browser (pdf.js loads only when someone imports a list) */
export async function readCcofPdf(f: File): Promise<{ rows: CcofRow[]; listDate: string | null }> {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise
  const pages: PPage[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n)
    const vp = p.getViewport({ scale: 1 })
    const tc = await p.getTextContent()
    pages.push({ width: vp.width, height: vp.height, items: (tc.items as { str?: string; transform?: number[] }[])
      .filter(i => typeof i.str === 'string' && i.transform)
      .map(i => ({ str: i.str!, x: i.transform![4], y: vp.height - i.transform![5] })) })
  }
  return parseCcof(pages)
}
