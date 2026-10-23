// Compliance: nightly copy of every compliance document to SharePoint (and "Run now" from Compliance > Settings).
//   SharePoint / <top folder> / <document type folder> / <site or Company> / <year> / "<id> - <title>.<ext>"
//   Folders are made as needed. Removed documents move to <top folder>/_Archived/<type folder>. Nothing is ever deleted.
// Needs in Vercel: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (an Entra app with the Graph application permission
// Sites.Selected, given write access to the one site), SUPABASE_SERVICE_ROLE_KEY, and the VITE_SUPABASE_URL / _ANON_KEY the app has.
// The site and top folder are set in the app (Compliance > Settings > SharePoint backup).

export const config = { maxDuration: 300 }

const SB = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const GRAPH = 'https://graph.microsoft.com/v1.0'
const BUDGET_MS = 240000            // stop starting new files after 4 minutes; the rest go next time
const SMALL = 4 * 1024 * 1024       // simple upload up to 4 MB, upload session above
const CHUNK = 10 * 327680           // 3.2 MB, a multiple of 320 KiB as Graph requires

function send(res, status, body) { res.status(status).setHeader('Cache-Control', 'no-store'); return res.json(body) }
const missing = () => ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'].filter(k => !process.env[k]).concat(SB && ANON ? [] : ['VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY'])

// ---------- Supabase (as the server) ----------
const svc = () => SERVICE.startsWith('sb_') ? { apikey: SERVICE } : { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
async function sb(path, opts = {}) {
  const r = await fetch(`${SB}${path}`, { ...opts, headers: { ...svc(), 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!r.ok) throw new Error((body && (body.message || body.error || body.hint)) || `Database error ${r.status}`)
  return body
}
const patchDoc = (id, v) => sb(`/rest/v1/comp_docs?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(v), headers: { Prefer: 'return=minimal' } })
async function setting(key) { const r = await sb(`/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value`); return (r && r[0] && r[0].value || '').trim() }
async function fileBytes(path) {
  const r = await fetch(`${SB}/storage/v1/object/compliance/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: svc() })
  if (!r.ok) throw new Error(`Couldn't read the stored file (${r.status})`)
  return Buffer.from(await r.arrayBuffer())
}

/** who pressed Run now: must be a Compliance Admin (or an Owner) */
async function caller(req) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/comp_me`, { method: 'POST', body: '{}', headers: { apikey: ANON, Authorization: auth, 'Content-Type': 'application/json' } })
    const me = await r.json()
    return r.ok && me && me.admin ? me : null
  } catch { return null }
}

// ---------- Microsoft Graph ----------
async function graphToken() {
  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Microsoft sign-in failed: ${j.error_description || j.error || r.status}`)
  return j.access_token
}
function graph(token) {
  return async (path, opts = {}) => {
    const r = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body && !(opts.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } })
    if (r.status === 204) return null
    const j = await r.json().catch(() => null)
    if (!r.ok) { const e = new Error((j && j.error && j.error.message) || `SharePoint error ${r.status}`); e.status = r.status; throw e }
    return j
  }
}
/** "liftedorganicscom.sharepoint.com/sites/X" or a full https:// link -> site id */
async function siteId(g, site) {
  const u = new URL(/^https?:\/\//.test(site) ? site : `https://${site}`)
  const parts = u.pathname.split('/').filter(Boolean)
  const i = parts.findIndex(p => p === 'sites' || p === 'teams')
  const path = i >= 0 ? `/${parts.slice(i, i + 2).join('/')}` : ''
  const s = await g(path ? `/sites/${u.hostname}:${path}` : `/sites/${u.hostname}`)
  return s.id
}
const clean = s => String(s || '').replace(/["*:<>?/\\|#%~&{}]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'Untitled'

function folders(g, drive) {
  const cache = new Map()
  return async function ensure(segs) {
    let parent = 'root', path = ''
    for (const raw of segs) {
      const name = clean(raw)
      path += `/${name}`
      if (cache.has(path)) { parent = cache.get(path); continue }
      let id
      try { id = (await g(`/drives/${drive}/items/${parent}:/${encodeURIComponent(name)}`)).id }
      catch (e) {
        if (e.status !== 404) throw e
        id = (await g(`/drives/${drive}/items/${parent}/children`, { method: 'POST', body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }) })).id
      }
      cache.set(path, id); parent = id
    }
    return { id: parent, path: path.slice(1) }
  }
}
async function upload(g, drive, folderId, name, bytes, mime) {
  const target = `/drives/${drive}/items/${folderId}:/${encodeURIComponent(name)}`
  if (bytes.length <= SMALL) return g(`${target}:/content?@microsoft.graph.conflictBehavior=replace`, { method: 'PUT', body: bytes, headers: { 'Content-Type': mime || 'application/octet-stream' } })
  const s = await g(`${target}:/createUploadSession`, { method: 'POST', body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) })
  let last = null
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    const r = await fetch(s.uploadUrl, { method: 'PUT', body: part, headers: { 'Content-Length': String(part.length), 'Content-Range': `bytes ${i}-${i + part.length - 1}/${bytes.length}` } })
    if (!r.ok && r.status !== 202) throw new Error(`Upload failed (${r.status})`)
    last = await r.json().catch(() => null)
  }
  return last
}

// ---------- the run ----------
export default async function handler(req, res) {
  const t0 = Date.now()
  const secret = process.env.CRON_SECRET
  const fromCron = req.method === 'GET'
  let who = 'nightly'
  if (fromCron) {
    if (secret && req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'no' })
  } else if (req.method === 'POST') {
    if (!SB || !ANON) return send(res, 500, { error: 'Supabase isn\'t set up in Vercel' })
    const me = await caller(req)
    if (!me) return send(res, 403, { error: 'Only a Compliance Admin can run the backup' })
    who = me.email
  } else return send(res, 405, { error: 'GET (cron) or POST' })

  const miss = missing()
  if (miss.length) return send(res, 200, { skipped: `SharePoint backup isn't set up in Vercel yet. Missing: ${miss.join(', ')}` })
  let site, root
  try { site = await setting('comp.sp_site'); root = (await setting('comp.sp_root')) || 'Compliance Archive' } catch (e) { return send(res, 200, { skipped: e.message }) }
  if (!site) return send(res, 200, { skipped: 'No SharePoint site set (Compliance > Settings > SharePoint backup)' })

  const run = (await sb('/rest/v1/comp_backup_runs', { method: 'POST', body: JSON.stringify({ started_by: who }), headers: { Prefer: 'return=representation' } }))[0]
  const out = { copied: 0, archived: 0, failed: 0, left_over: 0 }
  const finish = async (error) => {
    await sb(`/rest/v1/comp_backup_runs?id=eq.${run.id}`, { method: 'PATCH', body: JSON.stringify({ finished_at: new Date().toISOString(), ...out, error: error || null }), headers: { Prefer: 'return=minimal' } }).catch(() => {})
    await sb('/rest/v1/events', { method: 'POST', body: JSON.stringify({ user_email: who, type: 'comp_backup', note: error || null, details: { ...out, error: error || null } }), headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
  try {
    const g = graph(await graphToken())
    const sid = await siteId(g, site)
    const drive = (await g(`/sites/${sid}/drive`)).id
    const ensure = folders(g, drive)
    const types = new Map((await sb('/rest/v1/comp_doc_types?select=key,folder')).map(t => [t.key, t.folder]))
    const rootSegs = root.split('/').map(x => x.trim()).filter(Boolean)   // e.g. "General/Compliance Archive"

    // 1) new and changed files
    const todo = await sb('/rest/v1/comp_docs?select=*&file_path=not.is.null&deleted_at=is.null&backed_up_at=is.null&order=id&limit=500')
    for (const [i, d] of todo.entries()) {
      if (Date.now() - t0 > BUDGET_MS) { out.left_over = todo.length - i; break }
      try {
        const year = d.crop_year || (d.effective_on || d.created_at || '').slice(0, 4) || String(new Date().getFullYear())
        const f = await ensure([...rootSegs, types.get(d.doc_type) || d.doc_type, d.site || 'Company', year])
        const ext = ((d.file_name || d.file_path).match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0]
        const name = `${d.id} - ${clean(d.title).slice(0, 100)}${d.version > 1 ? ` (v${d.version})` : ''}${ext}`
        let item = null
        if (d.sp_item_id) {   // already there (moved type / site / settings): move it instead of copying again
          try { item = await g(`/drives/${drive}/items/${d.sp_item_id}`, { method: 'PATCH', body: JSON.stringify({ parentReference: { id: f.id }, name, '@microsoft.graph.conflictBehavior': 'replace' }) }) }
          catch (e) { if (e.status !== 404) throw e }
        }
        if (!item) item = await upload(g, drive, f.id, name, await fileBytes(d.file_path), d.mime)
        await patchDoc(d.id, { backed_up_at: new Date().toISOString(), sp_item_id: item && item.id || d.sp_item_id, sp_path: `${f.path}/${name}`, backup_error: null })
        out.copied++
      } catch (e) {
        out.failed++
        await patchDoc(d.id, { backup_error: String(e.message || e).slice(0, 300) }).catch(() => {})
      }
    }
    // 2) removed in the app: move to _Archived (never deleted)
    const gone = await sb('/rest/v1/comp_docs?select=id,doc_type,sp_item_id,sp_path&deleted_at=not.is.null&sp_item_id=not.is.null&sp_archived=is.false&order=id&limit=500')
    for (const d of gone) {
      if (Date.now() - t0 > BUDGET_MS) { out.left_over += 1; continue }
      try {
        const f = await ensure([...rootSegs, '_Archived', types.get(d.doc_type) || d.doc_type])
        const name = (d.sp_path || '').split('/').pop() || `${d.id}`
        try { await g(`/drives/${drive}/items/${d.sp_item_id}`, { method: 'PATCH', body: JSON.stringify({ parentReference: { id: f.id }, name, '@microsoft.graph.conflictBehavior': 'rename' }) }) }
        catch (e) { if (e.status !== 404) throw e }
        await patchDoc(d.id, { sp_archived: true, sp_path: `${f.path}/${name}`, backup_error: null })
        out.archived++
      } catch (e) {
        out.failed++
        await patchDoc(d.id, { backup_error: String(e.message || e).slice(0, 300) }).catch(() => {})
      }
    }
    await finish(null)
    return send(res, 200, out)
  } catch (e) {
    const msg = String(e.message || e).slice(0, 400)
    await finish(msg)
    return send(res, fromCron ? 200 : 500, { ...out, error: msg })
  }
}
