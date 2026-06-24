import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-customers-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { createCustomer, getCustomer, updateCustomer, deleteCustomer, listCustomers } = await import('./customers')
const { createContract, getContract } = await import('./contracts')
const { createRecurring } = await import('./recurring')

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

test('createCustomer requires a name and round-trips', () => {
  assert.throws(() => createCustomer({ name: '  ' }), /Name/)
  const c = createCustomer({ name: 'Bäckerei Huber', city: 'München', email: 'huber@x.de', vat_id: 'DE123456789' })
  assert.equal(c.name, 'Bäckerei Huber')
  assert.equal(c.client_type, 'geschaeft')
  assert.equal(c.active, 1)
  assert.deepEqual(getCustomer(c.id), c)
})

test('update + active filter + delete', () => {
  const c = createCustomer({ name: 'Alt GmbH' })
  updateCustomer(c.id, { active: 0, city: 'Köln' })
  assert.equal(getCustomer(c.id)!.city, 'Köln')
  assert.ok(!listCustomers(true).some((x) => x.id === c.id)) // inactive excluded
  assert.ok(listCustomers(false).some((x) => x.id === c.id))
  assert.equal(deleteCustomer(c.id), true)
  assert.equal(getCustomer(c.id), null)
})

test('a contract created from a customer prefills the client snapshot + links the id', () => {
  const c = createCustomer({ name: 'Vertrag GmbH', address: 'Hauptstr. 1', zip: '80331', city: 'München', client_type: 'privat' })
  const k = createContract({ customer_id: c.id, title: 'Wartung', value_cents: 10000 })
  assert.equal(k.customer_id, c.id)
  assert.equal(k.client_name, 'Vertrag GmbH')
  assert.equal(k.client_city, 'München')
  assert.equal(k.client_type, 'privat') // carried from the customer
  // Editing the customer afterwards must NOT change the contract snapshot.
  updateCustomer(c.id, { name: 'Umbenannt GmbH' })
  assert.equal(getContract(k.id)!.client_name, 'Vertrag GmbH')
})

test('an explicit client field overrides the customer prefill', () => {
  const c = createCustomer({ name: 'Standard GmbH', city: 'München' })
  const k = createContract({ customer_id: c.id, client_name: 'Sondername', title: 'X' })
  assert.equal(k.client_name, 'Sondername')
  assert.equal(k.client_city, 'München') // not overridden → from customer
})

test('a recurring template created from a customer prefills + links', () => {
  const c = createCustomer({ name: 'Serie GmbH', email: 's@x.de' })
  const r = createRecurring({ customer_id: c.id, title: 'Hosting', cadence: 'monatlich' })
  assert.equal(r.customer_id, c.id)
  assert.equal(r.client_name, 'Serie GmbH')
  assert.equal(r.client_email, 's@x.de')
})
