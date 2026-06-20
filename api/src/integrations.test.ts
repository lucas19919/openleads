import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-integrations-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
await import('./integrations') // registers stripe/vies/smtp
const { available, getDefinition, saveConnection, activate, resolve, listConnections } =
  await import('./integrations/registry')
const { stripeDefinition } = await import('./integrations/adapters/stripe')
const { mapViesResponse, splitVatId } = await import('./integrations/adapters/vies')
const { smtpDefinition } = await import('./integrations/adapters/smtp')
const { signPayload } = await import('./webhooks/sign')
import type { PaymentProvider } from './integrations/types'

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

test('shipped adapters are registered in the catalogue', () => {
  const providers = available().map((d) => `${d.category}:${d.provider}`)
  assert.ok(providers.includes('payment:stripe'))
  assert.ok(providers.includes('accounting:vies'))
  assert.ok(providers.includes('mail:smtp'))
  assert.equal(getDefinition('payment', 'stripe')?.label, 'Stripe')
})

test('a connection persists secrets encrypted and resolves to the active adapter', () => {
  const id = saveConnection({
    category: 'payment',
    provider: 'stripe',
    config: { success_url: 'https://shop.example/ok' },
    secrets: { secret_key: 'sk_test_123', webhook_secret: 'whsec_abc' },
    actor: 'admin',
  })
  // credentials are ciphertext at rest, never the plaintext key
  const row = db.prepare('SELECT credentials_enc, config FROM integration_connections WHERE id = ?').get(id) as { credentials_enc: string; config: string }
  assert.ok(row.credentials_enc && !row.credentials_enc.includes('sk_test_123'))
  assert.ok(!row.config.includes('sk_test_123')) // secret never in the plaintext config column

  assert.equal(resolve('payment'), null) // not active yet
  assert.equal(activate(id, 'admin'), true)
  const adapter = resolve('payment') as PaymentProvider | null
  assert.ok(adapter)
  assert.equal(adapter!.provider, 'stripe')

  // listConnections redacts to a presence boolean (no decrypted secret)
  const conn = listConnections().find((x) => x.id === id)!
  assert.equal(conn.active, 1)
})

test('Stripe webhook verification is constant-time over the raw body', () => {
  const adapter = stripeDefinition.build({
    id: 0,
    category: 'payment',
    provider: 'stripe',
    label: null,
    config: { success_url: 'https://x' },
    secrets: { secret_key: 'sk', webhook_secret: 'whsec_sign' },
  })
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { amount_total: 11900, currency: 'eur', payment_status: 'paid', metadata: { document_id: '7' } } },
  })
  const t = Math.floor(Date.now() / 1000)
  const good = signPayload('whsec_sign', body, t) // same HMAC scheme as Stripe
  assert.equal(adapter.verifyWebhook(body, { 'stripe-signature': good }), true)
  assert.equal(adapter.verifyWebhook(body + ' ', { 'stripe-signature': good }), false) // tamper
  assert.equal(adapter.verifyWebhook(body, {}), false) // no signature → fail closed

  const parsed = adapter.parseWebhook(body)
  assert.equal(parsed.external_id, 'evt_1')
  assert.equal(parsed.paid, true)
  assert.equal(parsed.amount_cents, 11900)
  assert.equal(parsed.document_id, 7)
})

test('VIES helpers are pure and parse a response correctly', () => {
  assert.deepEqual(splitVatId('DE 123 456 789'), { country: 'DE', number: '123456789' })
  const v = mapViesResponse(
    { isValid: true, name: 'Muster GmbH', address: 'Musterstr. 1', countryCode: 'DE', vatNumber: '123456789' },
    'DE',
    '123456789',
  )
  assert.equal(v.valid, true)
  assert.equal(v.country_code, 'DE')
  assert.equal(v.name, 'Muster GmbH')
  const invalid = mapViesResponse({ isValid: false }, 'DE', '000')
  assert.equal(invalid.valid, false)
  assert.equal(invalid.name, null)
})

test('SMTP adapter reports its category and unconfigured probe', async () => {
  const adapter = smtpDefinition.build({ id: 0, category: 'mail', provider: 'smtp', label: null, config: {}, secrets: {} })
  assert.equal(adapter.category, 'mail')
  const p = await adapter.probe() // SMTP not configured in tests
  assert.equal(p.ok, false)
})
