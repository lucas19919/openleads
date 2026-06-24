import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-dash-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { buildDashboard } = await import('./dashboard')
const { createTimeEntry } = await import('./timetracking')
const { createContract, finalizeContract, signContract, updateContract } = await import('./contracts')

const TODAY = '2026-06-24'

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

test('dashboard surfaces unbilled billable time', () => {
  createTimeEntry({ entry_date: '2026-06-10', description: 'Dev', minutes: 120, rate_cents: 9000, billable: 1 })
  createTimeEntry({ entry_date: '2026-06-11', description: 'intern', minutes: 60, rate_cents: 9000, billable: 0 })
  const d = buildDashboard(TODAY)
  assert.equal(d.time.uninvoiced_count, 1) // only the billable, uninvoiced entry is in the set
  assert.equal(d.time.uninvoiced_amount_cents, 18000) // 2h × 90€
})

test('dashboard counts active contracts, their value, and drafts', () => {
  // a draft contract
  createContract({ client_name: 'Entwurf GmbH', value_cents: 10000 })
  // an active contract (finalise → sign)
  const c = createContract({ client_name: 'Aktiv GmbH', value_cents: 50000 })
  finalizeContract(c.id)
  signContract(c.id, 'Chef', null, '2026-06-20')

  const d = buildDashboard(TODAY)
  assert.ok(d.contracts.active >= 1)
  assert.ok(d.contracts.active_value_cents >= 50000)
  assert.ok(d.contracts.drafts >= 1)
})

test('dashboard lists contracts expiring within 60 days', () => {
  const soon = createContract({ client_name: 'Bald-Ende GmbH', value_cents: 20000, end_date: '2026-07-15' })
  finalizeContract(soon.id)
  signContract(soon.id, 'X', null, '2026-06-20')

  const far = createContract({ client_name: 'Spät GmbH', value_cents: 20000, end_date: '2027-01-01' })
  finalizeContract(far.id)
  signContract(far.id, 'Y', null, '2026-06-20')

  const d = buildDashboard(TODAY)
  const names = d.contracts.expiring_soon.map((c) => c.client_name)
  assert.ok(names.includes('Bald-Ende GmbH')) // ends 2026-07-15, within 60d of 2026-06-24
  assert.ok(!names.includes('Spät GmbH')) // ends 2027-01-01, beyond the window
})

test('a contract without an end date is never "expiring"', () => {
  const c = createContract({ client_name: 'Unbefristet GmbH', value_cents: 20000 })
  finalizeContract(c.id)
  signContract(c.id, 'Z', null, '2026-06-20')
  // also ensure a non-sent draft with an end date doesn't show up
  updateContract(createContract({ client_name: 'Entwurf m. Ende', end_date: '2026-07-01' }).id, {})
  const d = buildDashboard(TODAY)
  const names = d.contracts.expiring_soon.map((c) => c.client_name)
  assert.ok(!names.includes('Unbefristet GmbH'))
  assert.ok(!names.includes('Entwurf m. Ende')) // status 'entwurf' is excluded
})
