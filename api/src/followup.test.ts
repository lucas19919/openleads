import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestFollowup } from './ai/followup'

test('cadence per stage relative to last activity', () => {
  // last activity well in the past → schedule = activity + cadence, but never before tomorrow
  const s = suggestFollowup('kontaktiert', '2026-06-10', '2026-06-12')
  assert.equal(s.days, 5)
  assert.equal(s.recontact_at, '2026-06-15') // 2026-06-10 + 5
})

test('overdue lead is scheduled for tomorrow, not the past', () => {
  const s = suggestFollowup('neu', '2026-01-01', '2026-06-19')
  assert.equal(s.recontact_at, '2026-06-20') // tomorrow, since 2026-01-03 < tomorrow
})

test('terminal stages get no follow-up', () => {
  for (const stage of ['gewonnen', 'verloren']) {
    const s = suggestFollowup(stage, '2026-06-10', '2026-06-12')
    assert.equal(s.recontact_at, null)
    assert.equal(s.days, null)
  }
})

test('month boundary arithmetic is correct', () => {
  const s = suggestFollowup('angebot', '2026-06-28', '2026-06-29')
  assert.equal(s.recontact_at, '2026-07-02') // 2026-06-28 + 4
})
