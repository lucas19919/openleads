import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-leads-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { insertLead, applyLeadUpdate, normalizeTags } = await import('./leads')

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

test('insertLead dedupes by registrable domain', () => {
  const a = insertLead({ company: 'Acme', website: 'https://acme.de/kontakt' }, 'tester')
  assert.ok(!a.deduped)
  const b = insertLead({ company: 'Acme 2', website: 'http://www.acme.de' }, 'tester')
  assert.equal(b.deduped, true)
  assert.equal(b.id, a.id) // same row, normalised domain
})

test('applyLeadUpdate: unknown id → null, invalid stage → throws', () => {
  assert.equal(applyLeadUpdate(999999, { company: 'x' }, 'tester'), null)
  const { id } = insertLead({ company: 'StageCo', website: 'stageco.de' }, 'tester')
  assert.throws(() => applyLeadUpdate(id, { stage: 'nonsense' }, 'tester'), /invalid stage/)
})

test('valid stage change updates the row and records a stage_change event', () => {
  const { id } = insertLead({ company: 'MoveCo', website: 'moveco.de' }, 'tester')
  const updated = applyLeadUpdate(id, { stage: 'qualifiziert' }, 'tester')!
  assert.equal(updated.stage, 'qualifiziert')
  const ev = db
    .prepare("SELECT * FROM lead_events WHERE lead_id = ? AND type = 'stage_change'")
    .get(id) as { from_stage: string; to_stage: string } | undefined
  assert.ok(ev)
  assert.equal(ev!.from_stage, 'neu')
  assert.equal(ev!.to_stage, 'qualifiziert')
})

test('non-scalar field values are ignored, not bound (no raw SQLite error)', () => {
  const { id } = insertLead({ company: 'CoerceCo', website: 'coerceco.de' }, 'tester')
  // score is an object, company is an array — both must be skipped, not thrown.
  const updated = applyLeadUpdate(
    id,
    { stage: 'kontaktiert', score: { x: 1 } as unknown, company: ['a'] as unknown, why_lead: 'ok' },
    'tester',
  )!
  assert.equal(updated.stage, 'kontaktiert') // the valid parts still applied
  assert.equal(updated.why_lead, 'ok')
  assert.equal(updated.company, 'CoerceCo') // unchanged (array value skipped)
  assert.equal(updated.score, 0) // unchanged (object value skipped)
})

test('notes change records a note event; no-op returns the lead unchanged', () => {
  const { id } = insertLead({ company: 'NoteCo', website: 'noteco.de' }, 'tester')
  applyLeadUpdate(id, { notes: 'Rückruf vereinbart' }, 'tester')
  const note = db
    .prepare("SELECT body FROM lead_events WHERE lead_id = ? AND type = 'note'")
    .get(id) as { body: string } | undefined
  assert.equal(note?.body, 'Rückruf vereinbart')

  const before = db.prepare('SELECT updated_at FROM leads WHERE id = ?').get(id) as { updated_at: string }
  const same = applyLeadUpdate(id, {}, 'tester')!
  assert.equal(same.updated_at, before.updated_at) // no sets → no write
})

test('normalizeTags trims, drops blanks, de-dupes case-insensitively', () => {
  assert.equal(normalizeTags(' vip , Umbau ,vip,, '), 'vip,Umbau')
  assert.equal(normalizeTags(''), null)
  assert.equal(normalizeTags(42), null)
})
