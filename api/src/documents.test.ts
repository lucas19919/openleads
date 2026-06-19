import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTotals } from './documents'
import { normalizeDomain } from './db'
import type { DocumentItemRow } from './db'

function item(quantity: number, unit_price_cents: number): Pick<DocumentItemRow, 'quantity' | 'unit_price_cents'> {
  return { quantity, unit_price_cents }
}

test('computeTotals: standard VAT', () => {
  const t = computeTotals([item(2, 50000), item(1, 25000)], false, 19)
  assert.equal(t.net_cents, 125000)
  assert.equal(t.vat_cents, 23750)
  assert.equal(t.gross_cents, 148750)
})

test('computeTotals: §19 Kleinunternehmer has no VAT', () => {
  const t = computeTotals([item(1, 100000)], true, 19)
  assert.equal(t.vat_cents, 0)
  assert.equal(t.gross_cents, 100000)
})

test('computeTotals: fractional quantities round per line', () => {
  const t = computeTotals([item(1.5, 3333)], false, 19)
  assert.equal(t.net_cents, 5000) // round(4999.5) = 5000
})

test('normalizeDomain strips scheme + www, lowercases', () => {
  assert.equal(normalizeDomain('https://www.Example.DE/pfad'), 'example.de')
  assert.equal(normalizeDomain('example.com'), 'example.com')
  assert.equal(normalizeDomain('  HTTP://Foo.Bar  '), 'foo.bar')
  assert.equal(normalizeDomain(null), null)
  assert.equal(normalizeDomain(''), null)
})
