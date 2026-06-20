import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-webhooks-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { emit, endpointWantsEvent } = await import('./webhooks/bus')
const { signPayload, verifySignature, computeSignature } = await import('./webhooks/sign')
const { isBlockedIp, isSafeWebhookUrl, backoffSeconds } = await import('./webhooks/dispatcher')

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

test('signature round-trips and rejects tamper/replay/no-secret', () => {
  const secret = 'whsec_test'
  const body = JSON.stringify({ event: 'lead.created', data: { id: 1 } })
  const t = Math.floor(Date.now() / 1000)
  const header = signPayload(secret, body, t)
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/)
  assert.equal(verifySignature(secret, body, header), true)

  // wrong secret / tampered body / stale timestamp / missing secret all fail
  assert.equal(verifySignature('whsec_other', body, header), false)
  assert.equal(verifySignature(secret, body + 'x', header), false)
  assert.equal(verifySignature(secret, body, header, { toleranceSeconds: 0, now: t + 10 }), false)
  assert.equal(verifySignature(null, body, header), false)
  assert.equal(verifySignature(secret, body, null), false)
  // computeSignature is the stable primitive
  assert.equal(computeSignature(secret, body, t).length, 64)
})

test('SSRF guard blocks loopback/private/link-local/metadata, allows public', async () => {
  // pure range check
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`)
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`)
  }
  // URL-level checks (IP literals resolve to themselves — no network needed)
  assert.equal((await isSafeWebhookUrl('http://example.com/hook')).ok, false) // not https
  assert.equal((await isSafeWebhookUrl('https://user:pass@1.1.1.1/hook')).ok, false) // userinfo
  assert.equal((await isSafeWebhookUrl('https://127.0.0.1/hook')).ok, false) // loopback
  assert.equal((await isSafeWebhookUrl('https://10.0.0.1/hook')).ok, false) // private
  assert.equal((await isSafeWebhookUrl('https://[::1]/hook')).ok, false) // v6 loopback
  assert.equal((await isSafeWebhookUrl('https://1.1.1.1/hook')).ok, true) // public
})

test('emit() fans out only to active, subscribed endpoints', () => {
  assert.equal(endpointWantsEvent('*', 'lead.created'), true)
  assert.equal(endpointWantsEvent('lead.created,payment.recorded', 'lead.created'), true)
  assert.equal(endpointWantsEvent('payment.recorded', 'lead.created'), false)

  const ins = db.prepare(
    "INSERT INTO webhook_endpoints (url, secret_enc, events, active) VALUES (?, 'ct', ?, ?)",
  )
  const wantLead = Number(ins.run('https://a.example/h', 'lead.created', 1).lastInsertRowid)
  const wantPay = Number(ins.run('https://b.example/h', 'payment.recorded', 1).lastInsertRowid)
  const wantAll = Number(ins.run('https://c.example/h', '*', 1).lastInsertRowid)
  const inactive = Number(ins.run('https://d.example/h', '*', 0).lastInsertRowid)

  emit('lead.created', { id: 42 })

  const got = db
    .prepare('SELECT endpoint_id FROM webhook_deliveries WHERE event = ?')
    .all('lead.created') as unknown as { endpoint_id: number }[]
  const ids = got.map((r) => r.endpoint_id).sort((a, b) => a - b)
  assert.deepEqual(ids, [wantLead, wantAll].sort((a, b) => a - b))
  assert.ok(!ids.includes(wantPay))
  assert.ok(!ids.includes(inactive))

  // the enqueued body is the canonical envelope, stored verbatim for signing
  const row = db.prepare('SELECT payload, status FROM webhook_deliveries WHERE endpoint_id = ?').get(wantLead) as { payload: string; status: string }
  const env = JSON.parse(row.payload)
  assert.equal(env.event, 'lead.created')
  assert.equal(env.data.id, 42)
  assert.equal(row.status, 'pending')
})

test('backoff grows exponentially and is capped at 6h', () => {
  assert.equal(backoffSeconds(1), 30)
  assert.equal(backoffSeconds(2), 60)
  assert.equal(backoffSeconds(3), 120)
  assert.equal(backoffSeconds(20), 6 * 60 * 60) // capped at 6h
})
