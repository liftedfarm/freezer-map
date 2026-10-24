// Accounting actions: { action: 'status' | 'push' | 'sync' | 'check' | 'setup' | 'disconnect', invoice_id? }
import { ENV, caller, classId, companyName, connection, itemId, missingSetup, pushInvoice, qbo, query, revoke, rpc, send, syncBalances, syncCustomers, table } from './_lib.js'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const miss = missingSetup()
  const body = req.body || {}
  const action = String(body.action || '')
  if (miss.length) return send(res, action === 'status' ? 200 : 500, { env: ENV, connected: false, error: `QuickBooks isn't set up in Vercel yet. Missing: ${miss.join(', ')}` })
  const me = await caller(req)
  if (!me) return send(res, 403, { error: 'The Accounting module isn\'t switched on for your account' })
  const edit = me.can_edit && !me.viewing_as
  try {
    if (action === 'status') {
      // the app follows Vercel's QBO_ENV
      await table(`qbo_connection?env=neq.${ENV}&active=eq.true`, { method: 'PATCH', body: JSON.stringify({ active: false }) }).catch(() => {})
      await table(`qbo_connection?env=eq.${ENV}&active=eq.false`, { method: 'PATCH', body: JSON.stringify({ active: true }) }).catch(() => {})
      let c
      try { c = await connection() } catch (e) { return send(res, 200, { env: ENV, connected: false, error: e.message }) }
      const name = await companyName(c)
      if (name && name !== c.company_name) await table(`qbo_connection?env=eq.${ENV}`, { method: 'PATCH', body: JSON.stringify({ company_name: name }) })
      return send(res, 200, { env: ENV, connected: true, company: name, realm: c.realm_id })
    }
    if (action === 'push') {
      if (!edit) return send(res, 403, { error: 'You can only view Accounting' })
      const id = Number(body.invoice_id)
      if (!id) return send(res, 400, { error: 'Which invoice?' })
      const c = await connection()
      try {
        return send(res, 200, { env: ENV, ...(await pushInvoice(c, id, me.email)) })
      } catch (e) {
        const msg = String(e.message || e) + (e.tid ? ` (QuickBooks ref ${e.tid})` : '')
        await rpc('acct_record_push', { p_inv: id, p_env: ENV, p_qbo_id: null, p_doc: null, p_total: null, p_balance: null, p_error: msg, p_by: me.email }).catch(() => {})
        return send(res, 400, { error: msg })
      }
    }
    if (action === 'sync') {
      const c = await connection()
      const inv = await syncBalances(c)
      let cust
      try { cust = await syncCustomers(c) } catch (e) { cust = { customers_error: String(e.message || e).slice(0, 300) } }
      return send(res, 200, { env: ENV, ...inv, ...cust })
    }
    if (action === 'check') {
      // is every product and class we use in QuickBooks (exactly as named)?
      const c = await connection()
      const [products, classes] = await Promise.all([table('acct_products?active=eq.true&select=code,name'), table('acct_classes?active=eq.true&select=name')])
      const rules = await table('acct_class_rules?select=class_name')
      const used = new Set(rules.map(r => r.class_name))
      const missing = { products: [], classes: [] }
      for (const p of products) { try { await itemId(c, p.code, p.name) } catch { missing.products.push(p.name) } }
      for (const cl of classes.filter(x => used.has(x.name))) { try { await classId(c, cl.name) } catch { missing.classes.push(cl.name) } }
      return send(res, 200, { env: ENV, missing, products: products.length, classes: used.size })
    }
    if (action === 'setup') {
      // sandbox only: create our classes and products in the test company so test invoices look like the real ones
      if (!me.admin || me.viewing_as) return send(res, 403, { error: 'Only an Accounting Admin' })
      if (ENV !== 'sandbox') return send(res, 400, { error: 'Set up only works on the sandbox. Add classes and products in the real QuickBooks by hand.' })
      const c = await connection()
      const made = { classes: 0, products: 0 }
      for (const cl of await table('acct_classes?active=eq.true&select=name&order=sort')) {
        if (!(await query(c, `select * from Class where Name = '${cl.name.replace(/'/g, "\\'")}'`)).Class) { await qbo(c, 'POST', 'class', { Name: cl.name }); made.classes++ }
      }
      const acc = await query(c, `select * from Account where AccountType = 'Income' maxresults 50`)
      const income = (acc.Account || []).find(a => /sales|product/i.test(a.Name)) || (acc.Account || [])[0]
      if (!income) throw new Error('No income account in the sandbox company')
      for (const p of await table('acct_products?active=eq.true&select=code,name&order=sort')) {
        if (!(await query(c, `select * from Item where Name = '${p.name.replace(/'/g, "\\'")}'`)).Item) {
          await qbo(c, 'POST', 'item', { Name: p.name, Type: 'Service', IncomeAccountRef: { value: income.Id } }); made.products++
        }
      }
      await table(`qbo_refs?env=eq.sandbox&kind=in.(item,class)`, { method: 'DELETE' })
      return send(res, 200, { env: ENV, ...made, income_account: income.Name })
    }
    if (action === 'disconnect') {
      if (!me.admin || me.viewing_as) return send(res, 403, { error: 'Only an Accounting Admin' })
      const rows = await table(`qbo_connection?env=eq.${ENV}&select=refresh_token`)
      if (rows && rows[0]) await revoke(rows[0].refresh_token)
      await table(`qbo_connection?env=eq.${ENV}`, { method: 'DELETE' })
      await table('events', { method: 'POST', body: JSON.stringify({ user_email: me.email, type: 'acct_disconnected', details: { env: ENV } }) }).catch(() => {})
      return send(res, 200, { env: ENV, disconnected: true })
    }
    return send(res, 400, { error: 'Unknown action' })
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) + (e.tid ? ` (QuickBooks ref ${e.tid})` : '') })
  }
}
