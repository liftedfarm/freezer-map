// Nightly database backup: uploads one pg_dump file to SharePoint (run by .github/workflows/db-backup.yml).
//   SharePoint site (SP_SITE) / SP_FOLDER (default "Database Backups") / <year> / <yyyy-mm> / lifted-db_<date>_<time>.dump
// Uses the same Entra app as the compliance backup (Graph application permission Sites.Selected, write on that site).
// Never deletes anything in SharePoint. Fails loudly (exit 1) so GitHub emails on a bad night.
//
//   node tools/db_backup.mjs <file.dump>
// Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, SP_SITE (e.g. https://liftedorganics.sharepoint.com/sites/Corporate), SP_FOLDER (optional)

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const GRAPH = process.env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0'
const LOGIN = process.env.LOGIN_BASE || 'https://login.microsoftonline.com'
const SMALL = 4 * 1024 * 1024       // simple upload up to 4 MB, upload session above
const CHUNK = 32 * 327680           // 10 MB, a multiple of 320 KiB as Graph requires

const file = process.argv[2]
const need = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'SP_SITE'].filter(k => !process.env[k])
if (!file || need.length) {
  console.error(!file ? 'Usage: node tools/db_backup.mjs <file.dump>' : `Missing GitHub secrets/variables: ${need.join(', ')}`)
  process.exit(1)
}

async function token() {
  const r = await fetch(`${LOGIN}/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Microsoft sign-in failed: ${j.error_description || j.error || r.status}`)
  return j.access_token
}
function graph(tok) {
  return async (path, opts = {}) => {
    const r = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.body && !(opts.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } })
    if (r.status === 204) return null
    const j = await r.json().catch(() => null)
    if (!r.ok) { const e = new Error((j && j.error && j.error.message) || `SharePoint error ${r.status}`); e.status = r.status; throw e }
    return j
  }
}
async function siteId(g, site) {
  const u = new URL(/^https?:\/\//.test(site) ? site : `https://${site}`)
  const parts = u.pathname.split('/').filter(Boolean)
  const i = parts.findIndex(p => p === 'sites' || p === 'teams')
  const path = i >= 0 ? `/${parts.slice(i, i + 2).join('/')}` : ''
  return (await g(path ? `/sites/${u.hostname}:${path}` : `/sites/${u.hostname}`)).id
}
async function ensure(g, drive, segs) {
  let parent = 'root'
  for (const name of segs) {
    try { parent = (await g(`/drives/${drive}/items/${parent}:/${encodeURIComponent(name)}`)).id }
    catch (e) {
      if (e.status !== 404) throw e
      parent = (await g(`/drives/${drive}/items/${parent}/children`, { method: 'POST', body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) })).id
    }
  }
  return parent
}
async function upload(g, drive, folderId, name, bytes) {
  const target = `/drives/${drive}/items/${folderId}:/${encodeURIComponent(name)}`
  if (bytes.length <= SMALL) return g(`${target}:/content?@microsoft.graph.conflictBehavior=rename`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })
  const s = await g(`${target}:/createUploadSession`, { method: 'POST', body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }) })
  let last = null
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    let r
    for (let attempt = 1; ; attempt++) {
      r = await fetch(s.uploadUrl, { method: 'PUT', body: part, headers: { 'Content-Length': String(part.length), 'Content-Range': `bytes ${i}-${i + part.length - 1}/${bytes.length}` } })
      if (r.ok || r.status === 202 || attempt >= 4) break
      await new Promise(res => setTimeout(res, 2000 * attempt))
    }
    if (!r.ok && r.status !== 202) throw new Error(`Upload failed at byte ${i} (${r.status})`)
    last = await r.json().catch(() => null)
  }
  return last
}

try {
  const bytes = readFileSync(file)
  const name = basename(file)
  const m = name.match(/(\d{4})-(\d{2})-\d{2}/)
  const [year, month] = m ? [m[1], `${m[1]}-${m[2]}`] : [String(new Date().getFullYear()), new Date().toISOString().slice(0, 7)]
  const root = (process.env.SP_FOLDER || 'Database Backups').split('/').map(s => s.trim()).filter(Boolean)

  let step = 'Microsoft sign-in'
  try {
    const tok = await token()
    try {   // what the app is allowed to do (permission names only, nothing secret)
      const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString())
      console.log(`Signed in as app ${claims.appid || claims.azp}; permissions: ${(claims.roles || []).join(', ') || 'none'}`)
    } catch {}
    const g = graph(tok)
    step = `Finding the SharePoint site ${process.env.SP_SITE}`
    const sid = await siteId(g, process.env.SP_SITE)
    step = 'Opening the site\'s Documents library'
    const drive = (await g(`/sites/${sid}/drive`)).id
    step = `Making the folder ${[...root, year, month].join('/')}`
    const folder = await ensure(g, drive, [...root, year, month])
    step = 'Uploading the file'
    var item = await upload(g, drive, folder, name, bytes)
  } catch (e) { throw new Error(`${step}: ${e.message || e}${e.status ? ` (${e.status})` : ''}`) }
  const size = item && item.size
  if (size !== statSync(file).size) throw new Error(`Uploaded size ${size} doesn't match the dump (${bytes.length} bytes)`)
  console.log(`Uploaded ${[...root, year, month, item.name || name].join('/')} (${(bytes.length / 1048576).toFixed(1)} MB)`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**SharePoint:** ${[...root, year, month, item.name || name].join(' / ')} (${(bytes.length / 1048576).toFixed(1)} MB)\n`)
  }
} catch (e) {
  console.error(`Backup upload failed: ${e.message || e}`)
  process.exit(1)
}
