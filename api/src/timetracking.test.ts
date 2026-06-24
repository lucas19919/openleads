import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-time-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  entryAmountCents,
  createTimeEntry,
  getTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  listTime,
  timeSummary,
  invoiceTimeEntries,
} = await import('./timetracking')
const { getDocument } = await import('./documents')

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

test('entryAmountCents: hours × rate, 0 when non-billable', () => {
  assert.equal(entryAmountCents(90, 9500, 1), 14250) // 1.5h × 95€ = 142,50€
  assert.equal(entryAmountCents(60, 10000, 1), 10000)
  assert.equal(entryAmountCents(90, 9500, 0), 0)
  assert.equal(entryAmountCents(15, 12000, 1), 3000) // 0.25h × 120€
})

test('create + summary tracks billable vs non-billable and uninvoiced', () => {
  createTimeEntry({ entry_date: '2026-06-01', description: 'Dev', minutes: 120, rate_cents: 9000, billable: 1 })
  createTimeEntry({ entry_date: '2026-06-02', description: 'Call', minutes: 30, rate_cents: 9000, billable: 0 })
  const sum = timeSummary({})
  assert.equal(sum.count, 2)
  assert.equal(sum.minutes, 150)
  assert.equal(sum.billable_minutes, 120)
  assert.equal(sum.amount_cents, 18000) // 2h × 90€
  assert.equal(sum.uninvoiced_amount_cents, 18000)
})

test('an invoiced entry is locked against edit and delete', () => {
  const e = createTimeEntry({ entry_date: '2026-06-03', description: 'X', minutes: 60, rate_cents: 8000 })
  const doc = invoiceTimeEntries([e.id])
  assert.equal(doc.kind, 'rechnung')
  assert.equal(doc.status, 'entwurf')
  assert.equal(doc.items.length, 1)
  // entry now stamped
  const after = getTimeEntry(e.id)!
  assert.equal(after.document_id, doc.id)
  assert.ok(after.invoiced_at)
  assert.throws(() => updateTimeEntry(e.id, { minutes: 30 }), /Abgerechnet/)
  assert.deepEqual(deleteTimeEntry(e.id), { ok: false, reason: 'invoiced' })
})

test('invoiceTimeEntries builds one line per entry with hours × rate', () => {
  const a = createTimeEntry({ entry_date: '2026-06-05', description: 'Design', minutes: 90, rate_cents: 10000 })
  const b = createTimeEntry({ entry_date: '2026-06-06', description: 'Build', minutes: 60, rate_cents: 10000 })
  const doc = invoiceTimeEntries([a.id, b.id])
  assert.equal(doc.items.length, 2)
  // 1.5h×100€ + 1h×100€ = 150€ + 100€ = 250€ (net; small_business default → gross == net)
  assert.equal(doc.totals.net_cents, 25000)
  assert.match(doc.items[0].description ?? '', /Design \(05\.06\.2026\)/)
  assert.equal(doc.items[0].unit, 'Std')
  assert.equal(doc.items[0].quantity, 1.5)
})

test('only billable + uninvoiced entries are eligible; double-bill is refused', () => {
  const billed = createTimeEntry({ entry_date: '2026-06-07', description: 'A', minutes: 60, rate_cents: 9000 })
  invoiceTimeEntries([billed.id])
  // re-billing the same entry → nothing eligible → throws
  assert.throws(() => invoiceTimeEntries([billed.id]), /Keine abrechenbaren/)
  // non-billable entry → not eligible
  const nb = createTimeEntry({ entry_date: '2026-06-08', description: 'B', minutes: 60, rate_cents: 9000, billable: 0 })
  assert.throws(() => invoiceTimeEntries([nb.id]), /Keine abrechenbaren/)
  // empty selection
  assert.throws(() => invoiceTimeEntries([]), /Keine Zeiteinträge/)
})

test('list filters by invoiced state', () => {
  const open = listTime({ invoiced: false }).every((e) => e.document_id === null)
  const inv = listTime({ invoiced: true }).every((e) => e.document_id !== null)
  assert.ok(open)
  assert.ok(inv)
})
