import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-ainew-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { runTool } = await import('./ai/tools')

const ctx = { actor: 'ai', ip: null }

after(() => {
  try {
    db.close()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix)
    } catch {
      /* ignore */
    }
  }
})

test('create_catalog_item + list_catalog round-trip via the agent', async () => {
  const made = (await runTool('create_catalog_item', { name: 'Webdesign Stunde', unit: 'Std', unit_price_cents: 9500 }, ctx)) as {
    ok: boolean
    item: { id: number; name: string }
  }
  assert.equal(made.ok, true)
  const list = (await runTool('list_catalog', {}, ctx)) as { count: number; items: { name: string }[] }
  assert.ok(list.items.some((i) => i.name === 'Webdesign Stunde'))
})

test('log_time accepts hours, invoice_time builds a draft and prevents double-billing', async () => {
  const a = (await runTool('log_time', { description: 'Design', hours: 1.5, rate_cents: 10000 }, ctx)) as {
    ok: boolean
    entry: { id: number; minutes: number }
  }
  assert.equal(a.ok, true)
  assert.equal(a.entry.minutes, 90) // 1.5h → 90 min
  const b = (await runTool('log_time', { description: 'Build', minutes: 60, rate_cents: 10000 }, ctx)) as {
    entry: { id: number }
  }
  const inv = (await runTool('invoice_time', { entry_ids: [a.entry.id, b.entry.id] }, ctx)) as {
    ok: boolean
    document: { kind: string; status: string; items: unknown[]; totals: { net_cents: number } }
  }
  assert.equal(inv.ok, true)
  assert.equal(inv.document.kind, 'rechnung')
  assert.equal(inv.document.status, 'entwurf')
  assert.equal(inv.document.items.length, 2)
  assert.equal(inv.document.totals.net_cents, 25000) // 1.5h + 1h × 100€
  // re-billing the same entries → no eligible entries → error
  const again = (await runTool('invoice_time', { entry_ids: [a.entry.id, b.entry.id] }, ctx)) as { error?: string }
  assert.match(again.error ?? '', /abrechenbar/i)
})

test('log_time rejects a non-positive duration', async () => {
  const r = (await runTool('log_time', { description: 'x', minutes: 0 }, ctx)) as { error?: string }
  assert.match(r.error ?? '', /positiv/)
})

test('create_contract + finalize_contract assigns a number and freezes the AGB', async () => {
  db.prepare('UPDATE settings SET agb_text = ? WHERE id = 1').run('KI-AGB gelten.')
  const made = (await runTool('create_contract', {
    type: 'wartungsvertrag',
    title: 'Wartungsvertrag',
    client_name: 'Bäckerei Huber',
    body: 'Pflege der Website.',
    value_cents: 19900,
  }, ctx)) as { ok: boolean; contract: { id: number; number: string | null; status: string } }
  assert.equal(made.ok, true)
  assert.equal(made.contract.number, null)
  assert.equal(made.contract.status, 'entwurf')

  const fin = (await runTool('finalize_contract', { id: made.contract.id }, ctx)) as {
    ok: boolean
    contract: { number: string | null; status: string; agb_text: string | null }
  }
  assert.equal(fin.ok, true)
  assert.match(fin.contract.number ?? '', /^V-\d{4}-\d{4}$/)
  assert.equal(fin.contract.status, 'versendet')
  assert.equal(fin.contract.agb_text, 'KI-AGB gelten.')
})

test('finalize_contract on a missing id reports an error, not a throw', async () => {
  const r = (await runTool('finalize_contract', { id: 999999 }, ctx)) as { error?: string }
  assert.match(r.error ?? '', /nicht gefunden/)
})

test('create_customer + list_customers round-trip via the agent', async () => {
  const made = (await runTool('create_customer', { name: 'KI Kunde GmbH', city: 'Berlin', email: 'k@x.de', vat_id: 'DE999999999', client_type: 'privat' }, ctx)) as {
    ok: boolean
    customer: { id: number; name: string; client_type: string }
  }
  assert.equal(made.ok, true)
  assert.equal(made.customer.client_type, 'privat')
  const list = (await runTool('list_customers', { query: 'KI Kunde' }, ctx)) as { customers: { id: number }[] }
  assert.ok(list.customers.some((c) => c.id === made.customer.id))
})

test('create_document with customer_id prefills the recipient + USt-IdNr.', async () => {
  const c = (await runTool('create_customer', { name: 'Doc Kunde GmbH', address: 'Weg 5', zip: '10115', city: 'Berlin', vat_id: 'DE123' }, ctx)) as { customer: { id: number } }
  const doc = (await runTool('create_document', { kind: 'rechnung', customer_id: c.customer.id }, ctx)) as {
    ok: boolean
    document: { customer_id: number; client_name: string; client_city: string; client_vat_id: string }
  }
  assert.equal(doc.document.customer_id, c.customer.id)
  assert.equal(doc.document.client_name, 'Doc Kunde GmbH')
  assert.equal(doc.document.client_city, 'Berlin')
  assert.equal(doc.document.client_vat_id, 'DE123')
})

test('create_contract with customer_id prefills the Auftraggeber', async () => {
  const c = (await runTool('create_customer', { name: 'Vertrag Kunde GmbH', city: 'Hamburg' }, ctx)) as { customer: { id: number } }
  const k = (await runTool('create_contract', { title: 'Wartung', customer_id: c.customer.id }, ctx)) as {
    ok: boolean
    contract: { customer_id: number; client_name: string; client_city: string }
  }
  assert.equal(k.contract.customer_id, c.customer.id)
  assert.equal(k.contract.client_name, 'Vertrag Kunde GmbH')
  assert.equal(k.contract.client_city, 'Hamburg')
})

test('create_customer requires a name', async () => {
  const r = (await runTool('create_customer', { name: '   ' }, ctx)) as { error?: string }
  assert.match(r.error ?? '', /Name/)
})

test('create_document with an unknown customer_id reports an error', async () => {
  const r = (await runTool('create_document', { kind: 'rechnung', customer_id: 999999 }, ctx)) as { error?: string }
  assert.match(r.error ?? '', /nicht gefunden/)
})

test('contract_from_document turns an offer into a draft contract via the agent', async () => {
  const doc = (await runTool('create_document', { kind: 'angebot', client_name: 'Offer GmbH', items: [{ description: 'Projekt', quantity: 1, unit_price_cents: 50000 }] }, ctx)) as {
    document: { id: number }
  }
  const k = (await runTool('contract_from_document', { document_id: doc.document.id }, ctx)) as {
    ok: boolean
    contract: { document_id: number; client_name: string; value_cents: number }
  }
  assert.equal(k.ok, true)
  assert.equal(k.contract.document_id, doc.document.id)
  assert.equal(k.contract.client_name, 'Offer GmbH')
  assert.equal(k.contract.value_cents, 50000)
  const miss = (await runTool('contract_from_document', { document_id: 999999 }, ctx)) as { error?: string }
  assert.match(miss.error ?? '', /nicht gefunden/)
})
