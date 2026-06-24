import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-report-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { replaceItems, finalizeDraft } = await import('./documents')
const { createExpense } = await import('./expenses')
const { buildEuer } = await import('./report')

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

function makeInvoice(net: number, small: 0 | 1, vatRate: number, issue: string): void {
  const info = db
    .prepare("INSERT INTO documents (kind, small_business, vat_rate, status) VALUES ('rechnung', ?, ?, 'entwurf')")
    .run(small, vatRate)
  const id = Number(info.lastInsertRowid)
  replaceItems(id, [{ description: 'X', quantity: 1, unit_price_cents: net }])
  finalizeDraft(id)
  db.prepare('UPDATE documents SET issue_date = ? WHERE id = ?').run(issue, id)
}

test('buildEuer sums revenue and expenses and computes the VAT position', () => {
  // Switch off §19 so invoices carry VAT (19%).
  db.prepare('UPDATE settings SET small_business = 0, vat_rate = 19 WHERE id = 1').run()

  makeInvoice(100000, 0, 19, '2026-03-10') // net 1000 €, VAT 190 €
  makeInvoice(50000, 0, 19, '2026-05-20') // net 500 €, VAT 95 €
  makeInvoice(99999, 0, 19, '2025-12-31') // out of range → excluded

  const exp = (category: string, gross: number, date: string) =>
    createExpense(
      { vendor: null, category, description: null, expense_date: date, paid_on: null, gross_cents: gross, vat_rate: 19, payment_method: null, note: null },
      'tester',
    )
  exp('software', 11900, '2026-04-01') // net 100, vat 19
  exp('bueromaterial', 5950, '2026-04-02') // net 50, vat 9,50

  const r = buildEuer('2026-01-01', '2026-12-31')
  assert.equal(r.revenue.count, 2)
  assert.equal(r.revenue.net_cents, 150000)
  assert.equal(r.revenue.vat_cents, 28500) // 190 + 95
  assert.equal(r.expenses.count, 2)
  assert.equal(r.expenses.by_category.length, 2)
  // result = revenue net − expenses net
  assert.equal(r.result_net_cents, 150000 - r.expenses.net_cents)
  // VAT payable = collected − input
  assert.equal(r.vat.collected_cents, 28500)
  assert.equal(r.vat.payable_cents, 28500 - r.expenses.vat_cents)
  // categories carry their SKR03 account + label
  const sw = r.expenses.by_category.find((c) => c.category === 'software')!
  assert.equal(sw.skr03, '4965')
  assert.equal(sw.label, 'Software / Lizenzen')
})

test('the date range excludes out-of-range revenue and expenses', () => {
  const all = buildEuer() // no range → everything (incl. the 2025 invoice)
  assert.equal(all.revenue.count, 3)
  const q2 = buildEuer('2026-04-01', '2026-06-30')
  assert.equal(q2.revenue.count, 1) // only the 2026-05-20 invoice
  assert.equal(q2.revenue.net_cents, 50000)
})

test('§19 small-business invoices contribute no VAT', () => {
  const DB2 = join(tmpdir(), `openleads-report2-${process.pid}.db`)
  // fresh settings state on the same DB: flip to §19 and add a small-biz invoice
  db.prepare('UPDATE settings SET small_business = 1 WHERE id = 1').run()
  makeInvoice(20000, 1, 19, '2026-07-01')
  const r = buildEuer('2026-07-01', '2026-07-31')
  assert.equal(r.revenue.net_cents, 20000)
  assert.equal(r.revenue.vat_cents, 0)
  assert.equal(r.small_business, true)
  void DB2
})
