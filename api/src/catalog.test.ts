import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-catalog-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  listCatalog,
  getCatalogItem,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
} = await import('./catalog')

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

test('createCatalogItem requires a name', () => {
  assert.throws(() => createCatalogItem({ name: '   ' }), /Bezeichnung/)
})

test('create + get round-trips, with sensible defaults', () => {
  const it = createCatalogItem({ name: 'Webdesign Stunde', unit: 'Std', unit_price_cents: 9500 })
  assert.equal(it.name, 'Webdesign Stunde')
  assert.equal(it.unit, 'Std')
  assert.equal(it.unit_price_cents, 9500)
  assert.equal(it.vat_rate, 19)
  assert.equal(it.active, 1)
  assert.deepEqual(getCatalogItem(it.id), it)
})

test('listCatalog can filter to active items only', () => {
  const a = createCatalogItem({ name: 'Aktiv A', active: 1 })
  const b = createCatalogItem({ name: 'Inaktiv B', active: 0 })
  const all = listCatalog().map((i) => i.id)
  const activeOnly = listCatalog(true).map((i) => i.id)
  assert.ok(all.includes(a.id) && all.includes(b.id))
  assert.ok(activeOnly.includes(a.id))
  assert.ok(!activeOnly.includes(b.id))
})

test('update patches editable fields; an empty name is rejected', () => {
  const it = createCatalogItem({ name: 'Hosting', unit_price_cents: 1000 })
  const u = updateCatalogItem(it.id, { unit_price_cents: 1500, category: 'Betrieb' })!
  assert.equal(u.unit_price_cents, 1500)
  assert.equal(u.category, 'Betrieb')
  assert.throws(() => updateCatalogItem(it.id, { name: '' }), /Bezeichnung/)
})

test('delete removes the item; missing item updates to null', () => {
  const it = createCatalogItem({ name: 'Einmalig' })
  assert.equal(deleteCatalogItem(it.id), true)
  assert.equal(getCatalogItem(it.id), null)
  assert.equal(deleteCatalogItem(999999), false)
  assert.equal(updateCatalogItem(999999, { name: 'x' }), null)
})

test('catalog items are ordered by sort then name', () => {
  // fresh-ish ordering check: lower sort first
  const z = createCatalogItem({ name: 'Zzz', sort: 1 })
  const a = createCatalogItem({ name: 'Aaa', sort: 5 })
  const ids = listCatalog().map((i) => i.id)
  assert.ok(ids.indexOf(z.id) < ids.indexOf(a.id))
})
