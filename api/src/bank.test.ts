import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-bank-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { replaceItems, finalizeDraft, getDocument } = await import('./documents')
const { parseCamt053, parseMt940, parseStatement, suggestMatch, previewStatement, applyMatches, openInvoices } = await import('./bank')

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

/** Create a finalised invoice with a single net line; returns {id, number}. */
function makeInvoice(client: string, cents: number): { id: number; number: string } {
  const info = db
    .prepare("INSERT INTO documents (kind, client_name, small_business, vat_rate, status) VALUES ('rechnung', ?, 1, 19, 'entwurf')")
    .run(client)
  const id = Number(info.lastInsertRowid)
  replaceItems(id, [{ description: 'Leistung', quantity: 1, unit: 'Pauschal', unit_price_cents: cents }])
  const doc = finalizeDraft(id)!
  return { id, number: doc.number! }
}

function camt(entries: { ref: string; amount: string; cd: 'CRDT' | 'DBIT'; date: string; ustrd: string; party?: string }[]): string {
  const ntries = entries
    .map(
      (e) => `
      <Ntry>
        <Amt Ccy="EUR">${e.amount}</Amt>
        <CdtDbtInd>${e.cd}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>${e.date}</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><AcctSvcrRef>${e.ref}</AcctSvcrRef></Refs>
          <RmtInf><Ustrd>${e.ustrd}</Ustrd></RmtInf>
          <RltdPties>${e.cd === 'CRDT' ? `<Dbtr><Nm>${e.party ?? 'Zahler'}</Nm></Dbtr>` : `<Cdtr><Nm>${e.party ?? 'Empfänger'}</Nm></Cdtr>`}</RltdPties>
        </TxDtls></NtryDtls>
      </Ntry>`,
    )
    .join('')
  return `<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt>${ntries}</Stmt></BkToCstmrStmt></Document>`
}

test('parseCamt053 extracts booked entries with amount, direction, date, remittance, party', () => {
  const xml = camt([
    { ref: 'r1', amount: '119.00', cd: 'CRDT', date: '2026-06-20', ustrd: 'Zahlung RE-2026-0001', party: 'Kunde GmbH' },
    { ref: 'r2', amount: '50.00', cd: 'DBIT', date: '2026-06-21', ustrd: 'Miete', party: 'Vermieter' },
  ])
  const e = parseCamt053(xml)
  assert.equal(e.length, 2)
  assert.equal(e[0].amount_cents, 11900)
  assert.equal(e[0].direction, 'credit')
  assert.equal(e[0].booked_on, '2026-06-20')
  assert.match(e[0].remittance, /RE-2026-0001/)
  assert.equal(e[0].counterparty, 'Kunde GmbH')
  assert.equal(e[1].direction, 'debit')
  assert.equal(e[1].amount_cents, 5000)
})

test('parseMt940 extracts a credit with date, amount, remittance and payer', () => {
  const mt = [
    ':20:STARTUMSATZ',
    ':25:DE12345678/1234567',
    ':28C:1/1',
    ':60F:C260601EUR1000,00',
    ':61:2306200620C119,00NTRFNONREF//BANKREF-1',
    ':86:166?00GUTSCHRIFT?20Rechnung RE-2026-0001?21vielen Dank?32Kunde GmbH',
    ':61:2306210621D42,00NTRFNONREF//BANKREF-2',
    ':86:177?00LASTSCHRIFT?20Software-Abo?32Anbieter AG',
    ':62F:C260621EUR1077,00',
  ].join('\r\n')
  const e = parseMt940(mt)
  assert.equal(e.length, 2)
  assert.equal(e[0].direction, 'credit')
  assert.equal(e[0].amount_cents, 11900)
  assert.equal(e[0].booked_on, '2023-06-20')
  assert.equal(e[0].ext_ref, 'BANKREF-1')
  assert.match(e[0].remittance, /RE-2026-0001/)
  assert.equal(e[0].counterparty, 'Kunde GmbH')
  assert.equal(e[1].direction, 'debit') // a D line
  assert.equal(e[1].amount_cents, 4200)
})

test('parseStatement auto-detects CAMT vs MT940', () => {
  const camtXml = camt([{ ref: 'c1', amount: '10.00', cd: 'CRDT', date: '2026-06-20', ustrd: 'x' }])
  assert.equal(parseStatement(camtXml).length, 1)
  const mt = ':61:2306200620C10,00NTRFNONREF//R1\n:86:?20Test'
  assert.equal(parseStatement(mt).length, 1)
  assert.equal(parseStatement('garbage, not a statement').length, 0)
})

test('an MT940 credit matches an open invoice and books the payment', () => {
  const inv = makeInvoice('MT Kunde', 25000)
  const mt = `:61:2306200620C250,00NTRFNONREF//MTPAY-1\n:86:?20Zahlung ${inv.number}?32MT Kunde`
  const preview = previewStatement(mt)
  const e = preview.entries[0]
  assert.equal(e.suggestion?.document_id, inv.id)
  const res = applyMatches([{ ext_ref: e.ext_ref, booked_on: e.booked_on, amount_cents: e.amount_cents, remittance: e.remittance, document_id: inv.id }])
  assert.equal(res.matched, 1)
  assert.equal(getDocument(inv.id)!.status, 'bezahlt')
})

test('parseCamt053 skips non-booked (pending) entries', () => {
  const xml = `<Document><Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts><NtryDtls><TxDtls><Refs><AcctSvcrRef>p1</AcctSvcrRef></Refs></TxDtls></NtryDtls></Ntry></Document>`
  assert.equal(parseCamt053(xml).length, 0)
})

test('suggestMatch finds the invoice by number in the Verwendungszweck', () => {
  const inv = makeInvoice('Kunde GmbH', 11900)
  const open = openInvoices()
  const entry = { ext_ref: 'x', booked_on: '2026-06-20', amount_cents: 11900, direction: 'credit' as const, remittance: `Ueberweisung ${inv.number} vielen Dank`, counterparty: 'Kunde GmbH' }
  const s = suggestMatch(entry, open)!
  assert.equal(s.document_id, inv.id)
  assert.equal(s.reason, 'number')
  assert.equal(s.amount_ok, true)
})

test('suggestMatch falls back to a unique exact amount when no number matches', () => {
  const inv = makeInvoice('Betrag GmbH', 7777) // unusual amount → unique
  const open = openInvoices()
  const entry = { ext_ref: 'y', booked_on: '2026-06-20', amount_cents: 7777, direction: 'credit' as const, remittance: 'ohne Nummer', counterparty: null }
  const s = suggestMatch(entry, open)!
  assert.equal(s.document_id, inv.id)
  assert.equal(s.reason, 'amount')
})

test('a debit never suggests a match', () => {
  const entry = { ext_ref: 'z', booked_on: '2026-06-20', amount_cents: 5000, direction: 'debit' as const, remittance: 'x', counterparty: null }
  assert.equal(suggestMatch(entry, openInvoices()), null)
})

test('apply records a payment, reconciles the invoice, and is idempotent', () => {
  const inv = makeInvoice('Apply GmbH', 20000)
  const xml = camt([{ ref: 'pay-1', amount: '200.00', cd: 'CRDT', date: '2026-06-22', ustrd: `Rechnung ${inv.number}`, party: 'Apply GmbH' }])
  const preview = previewStatement(xml)
  const e = preview.entries[0]
  assert.equal(e.already_seen, false)
  assert.equal(e.suggestion?.document_id, inv.id)

  const res = applyMatches([{ ext_ref: e.ext_ref, booked_on: e.booked_on, amount_cents: e.amount_cents, remittance: e.remittance, document_id: inv.id }])
  assert.equal(res.matched, 1)
  assert.equal(res.applied, 1)
  assert.equal(getDocument(inv.id)!.status, 'bezahlt') // fully paid → reconciled

  // re-importing the same statement does nothing (dedup by ext_ref)
  const again = previewStatement(xml)
  assert.equal(again.entries[0].already_seen, true)
  const res2 = applyMatches([{ ext_ref: e.ext_ref, amount_cents: e.amount_cents, document_id: inv.id }])
  assert.equal(res2.skipped, 1)
  assert.equal(res2.matched, 0)
})
