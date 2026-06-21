import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-connections-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
await import('./integrations') // registers all adapters
const { available } = await import('./integrations/registry')
const { verifyGcSignature, mapGcEvent } = await import('./integrations/adapters/gocardless')
const { mapDocToLexoffice } = await import('./integrations/adapters/lexoffice')
const { mapDocToSevdesk } = await import('./integrations/adapters/sevdesk')
const { normalizeE164, buildSipgateCallBody } = await import('./integrations/adapters/sipgate')
const { buildAuthorizeUrl, parseIdTokenEmail, scopesFor, GOOGLE_SPEC, MSGRAPH_SPEC } = await import('./integrations/oauth')
const { buildGmailRaw, mapCalendarEvent } = await import('./integrations/adapters/google')
const { buildGraphSendMailBody, mapGraphEvent } = await import('./integrations/adapters/msgraph')
const { createHmac } = await import('node:crypto')
import type { FullDocument } from './documents'

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

function fixtureDoc(over: Partial<FullDocument> = {}): FullDocument {
  const items = [
    { id: 1, document_id: 1, description: 'Webseite', quantity: 1, unit: 'Pauschal', unit_price_cents: 100000, sort: 0 },
    { id: 2, document_id: 1, description: 'Wartung', quantity: 2, unit: 'Monat', unit_price_cents: 5000, sort: 1 },
  ]
  return {
    id: 1, kind: 'rechnung', number: 'RE-2026-0001', lead_id: null, client_name: 'Maler Müller',
    client_address: 'Dorfstr. 2', client_zip: '85435', client_city: 'Erding', client_email: 'k@x.de',
    title: 'Rechnung', intro: null, notes: null, status: 'versendet', issue_date: '2026-06-20', due_date: '2026-07-04',
    small_business: 0, vat_rate: 19, buyer_reference: null, client_type: 'geschaeft', client_vat_id: 'DE123456789',
    created_at: '', updated_at: '', items, totals: { net_cents: 110000, vat_cents: 20900, gross_cents: 130900 }, paid_cents: 0,
    ...over,
  }
}

test('catalogue includes every shipped adapter', () => {
  const ids = available().map((d) => `${d.category}:${d.provider}`)
  for (const id of [
    'payment:stripe', 'payment:gocardless', 'accounting:vies', 'accounting:lexoffice', 'accounting:sevdesk',
    'mail:smtp', 'mail:google', 'mail:microsoft', 'calendar:google', 'calendar:microsoft', 'telephony:sipgate',
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`)
  }
})

test('GoCardless webhook signature: plain HMAC, fails closed', () => {
  const secret = 'gc_whsec'
  const body = JSON.stringify({ events: [{ id: 'EV1', resource_type: 'payments', action: 'confirmed', metadata: { document_id: '7' } }] })
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  assert.equal(verifyGcSignature(secret, body, sig), true)
  assert.equal(verifyGcSignature(secret, body + ' ', sig), false) // tamper
  assert.equal(verifyGcSignature('', body, sig), false) // unset secret
  assert.equal(verifyGcSignature(secret, body, null), false) // no header

  const parsed = mapGcEvent(JSON.parse(body))
  assert.equal(parsed.external_id, 'EV1')
  assert.equal(parsed.paid, true)
  assert.equal(parsed.document_id, 7)
})

test('lexoffice mapper: cents→EUR, §19 → vatfree + 0% + remark', () => {
  const std = mapDocToLexoffice(fixtureDoc())
  assert.equal(std.lineItems[0].unitPrice.netAmount, 1000) // 100000 cents → 1000.00 €
  assert.equal(std.lineItems[0].unitPrice.taxRatePercentage, 19)
  assert.equal(std.taxConditions.taxType, 'net')

  const klein = mapDocToLexoffice(fixtureDoc({ small_business: 1 }))
  assert.equal(klein.taxConditions.taxType, 'vatfree')
  assert.equal(klein.lineItems[0].unitPrice.taxRatePercentage, 0)
  assert.match(klein.remark ?? '', /§ ?19/)
})

test('sevDesk mapper: price in euros, taxRate 19 / 0', () => {
  const std = mapDocToSevdesk(fixtureDoc(), { contactId: '42' })
  assert.equal(std.invoice.contact.id, '42')
  assert.equal(std.invoicePosSave[0].price, 1000)
  assert.equal(std.invoicePosSave[0].taxRate, 19)
  const klein = mapDocToSevdesk(fixtureDoc({ small_business: 1 }), { contactId: '42' })
  assert.equal(klein.invoicePosSave[0].taxRate, 0)
})

test('sipgate E.164 normalisation + call body', () => {
  assert.equal(normalizeE164('0049 30 1234567'), '+49301234567')
  assert.equal(normalizeE164('030 1234567'), '+49301234567')
  assert.equal(normalizeE164('+44 20 7946 0958'), '+442079460958')
  assert.throws(() => normalizeE164('abc'), /Ungültige Zielrufnummer/)
  const body = buildSipgateCallBody({ to: '030 1234567' }, { deviceId: 'e0', callerId: '+493000' })
  assert.deepEqual(body, { deviceId: 'e0', caller: 'e0', callee: '+49301234567', callerId: '+493000' })
})

test('OAuth authorize URLs are well-formed (pure)', () => {
  const g = new URL(buildAuthorizeUrl(GOOGLE_SPEC, { clientId: 'cid', redirectUri: 'https://crm/cb', scope: scopesFor('google', 'mail'), state: 'st8' }))
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(g.searchParams.get('response_type'), 'code')
  assert.equal(g.searchParams.get('access_type'), 'offline')
  assert.equal(g.searchParams.get('prompt'), 'consent')
  assert.equal(g.searchParams.get('redirect_uri'), 'https://crm/cb')
  assert.equal(g.searchParams.get('state'), 'st8')
  assert.match(g.searchParams.get('scope') ?? '', /gmail\.send/)

  const m = new URL(buildAuthorizeUrl(MSGRAPH_SPEC, { clientId: 'cid', redirectUri: 'https://crm/cb', scope: scopesFor('microsoft', 'calendar'), state: 's', tenant: 'mytenant' }))
  assert.ok(m.pathname.startsWith('/mytenant/'))
  assert.match(m.searchParams.get('scope') ?? '', /Calendars\.ReadWrite/)
  assert.match(m.searchParams.get('scope') ?? '', /offline_access/)
  // default tenant 'common'
  const m2 = new URL(buildAuthorizeUrl(MSGRAPH_SPEC, { clientId: 'c', redirectUri: 'r', scope: ['openid'], state: 's' }))
  assert.ok(m2.pathname.startsWith('/common/'))
})

test('parseIdTokenEmail decodes the JWT payload, null on garbage', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'inhaber@firma.de' }), 'utf8').toString('base64url')
  assert.equal(parseIdTokenEmail(`h.${payload}.sig`), 'inhaber@firma.de')
  assert.equal(parseIdTokenEmail('not-a-jwt'), null)
  assert.equal(parseIdTokenEmail(null), null)
})

test('Gmail/Graph mail + calendar builders are well-formed (pure)', () => {
  const raw = buildGmailRaw({ to: 'k@x.de', from: 'me@firma.de', subject: 'Rechnung RE-1 — Grüße', text: 'Hallo' })
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  assert.match(decoded, /To: k@x\.de/)
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/) // umlaut subject is RFC2047-encoded
  assert.match(decoded, /\r\n\r\nHallo$/)

  const gcal = mapCalendarEvent({ title: 'Rückruf', start: '2026-06-21T09:00:00Z', end: '2026-06-21T09:30:00Z', attendees: ['k@x.de'] })
  assert.equal(gcal.summary, 'Rückruf')
  assert.equal(gcal.start.dateTime, '2026-06-21T09:00:00Z')
  assert.deepEqual(gcal.attendees, [{ email: 'k@x.de' }])

  const gm = buildGraphSendMailBody({ to: 'k@x.de', subject: 'Hi', text: 'Body' })
  assert.equal(gm.message.toRecipients[0].emailAddress.address, 'k@x.de')
  assert.equal(gm.message.body.contentType, 'Text')

  const gev = mapGraphEvent({ title: 'Termin', start: '2026-06-21T09:00:00Z', end: '2026-06-21T10:00:00Z' })
  assert.equal(gev.start.timeZone, 'UTC')
  assert.equal(gev.start.dateTime, '2026-06-21T09:00:00') // no trailing Z, UTC tz
})
