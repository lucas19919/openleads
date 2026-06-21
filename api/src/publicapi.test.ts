import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-publicapi-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { createApiKey, verifyApiKey, hasScope, listApiKeys, revokeApiKey, API_SCOPES } =
  await import('./publicapi/keys')

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

test('minted key has the ol_ format, verifies, and is hashed at rest', () => {
  const { id, token } = createApiKey({ name: 'Zapier', scopes: ['leads:read', 'leads:write'], createdBy: 'admin' })
  assert.match(token, /^ol_[0-9a-f]{8}_[0-9a-f]{48}$/)

  const authed = verifyApiKey(token)
  assert.ok(authed)
  assert.equal(authed!.id, id)
  assert.deepEqual(authed!.scopes, ['leads:read', 'leads:write'])

  // The plaintext token is never stored — only its SHA-256 digest.
  const row = db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(id) as { key_hash: string }
  assert.notEqual(row.key_hash, token)
  assert.match(row.key_hash, /^[0-9a-f]{64}$/)
})

test('verify rejects garbage, tampered, and unknown-prefix tokens', () => {
  const { token } = createApiKey({ scopes: ['leads:read'] })
  assert.equal(verifyApiKey('garbage'), null)
  assert.equal(verifyApiKey('ol_deadbeef_' + '0'.repeat(48)), null) // unknown prefix
  assert.equal(verifyApiKey(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')), null) // tampered secret
})

test('unknown scopes are dropped at mint time', () => {
  const { token } = createApiKey({ scopes: ['leads:read', 'bogus:scope', 'documents:write'] })
  const authed = verifyApiKey(token)!
  assert.deepEqual(authed.scopes, ['leads:read', 'documents:write'])
  assert.equal(hasScope(authed.scopes, 'leads:read'), true)
  assert.equal(hasScope(authed.scopes, 'leads:write'), false)
})

test('listApiKeys never leaks the hash; revoke fails closed', () => {
  const { id, token } = createApiKey({ name: 'temp', scopes: ['documents:read'] })
  const listed = listApiKeys()
  const mine = listed.find((k) => k.id === id)!
  assert.ok(mine)
  assert.ok(!('key_hash' in mine), 'key_hash must not be returned')
  assert.ok(mine.prefix.length === 8)

  assert.ok(verifyApiKey(token)) // works before revoke
  assert.equal(revokeApiKey(id), true)
  assert.equal(verifyApiKey(token), null) // rejected immediately after revoke
})

test('scope vocabulary is the documented set', () => {
  assert.deepEqual(
    [...API_SCOPES],
    ['leads:read', 'leads:write', 'documents:read', 'documents:write', 'payments:write', 'stats:read'],
  )
})
