import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { db, type ApiKeyRow } from '../db'

// Public API keys. Format: `ol_<prefix>_<secret>` where prefix is 8 hex chars
// (public, indexed for O(1) lookup) and secret is 48 hex chars (24 random bytes
// ≈ 192 bits). The full token is shown ONCE on create and never stored; we keep
// only its SHA-256 digest.
//
// Why SHA-256 and not scrypt (which auth.ts uses for passwords): passwords are
// low-entropy and need a slow KDF to resist brute force. A 192-bit random token
// is already infeasible to brute-force, so a slow KDF buys nothing — and running
// scrypt on every /api/v1 request would be a self-inflicted DoS. We still hash
// (a leaked .db must not yield usable keys) and compare in constant time, the
// same timingSafeEqual discipline as verifyPassword.

export const API_SCOPES = [
  'leads:read',
  'leads:write',
  'documents:read',
  'documents:write',
] as const
export type ApiScope = (typeof API_SCOPES)[number]

export interface AuthedKey {
  id: number
  name: string | null
  prefix: string
  scopes: string[]
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function parseScopes(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Mint a key: returns the FULL token (caller must surface it exactly once). */
export function createApiKey(input: {
  name?: string | null
  scopes: string[]
  createdBy?: string | null
}): { id: number; token: string; prefix: string; name: string | null; scopes: string[] } {
  const prefix = randomBytes(4).toString('hex') // 8 hex chars
  const secret = randomBytes(24).toString('hex') // 48 hex chars
  const token = `ol_${prefix}_${secret}`
  const scopes = input.scopes.filter((s) => (API_SCOPES as readonly string[]).includes(s))
  const info = db
    .prepare(
      `INSERT INTO api_keys (name, prefix, key_hash, scopes, created_by)
       VALUES (@name, @prefix, @key_hash, @scopes, @created_by)`,
    )
    .run({
      name: input.name ?? null,
      prefix,
      key_hash: hashToken(token),
      scopes: scopes.join(','),
      created_by: input.createdBy ?? null,
    })
  return { id: Number(info.lastInsertRowid), token, prefix, name: input.name ?? null, scopes }
}

function touchLastUsed(id: number): void {
  // Fire-and-forget, throttled to ~once/min so reads don't become writes.
  try {
    db.prepare(
      `UPDATE api_keys SET last_used_at = datetime('now')
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= datetime('now', '-1 minute'))`,
    ).run(id)
  } catch {
    /* never break a request on a bookkeeping write */
  }
}

/**
 * Verify a Bearer token. Returns the authed key (with scopes) or null. Fails
 * closed on unknown prefix, revoked key, or hash mismatch; comparison is
 * constant-time. The prefix is NOT secret, so a fast unknown-prefix reject is fine.
 */
export function verifyApiKey(token: string): AuthedKey | null {
  if (typeof token !== 'string' || !token.startsWith('ol_')) return null
  const parts = token.split('_')
  if (parts.length !== 3 || parts[0] !== 'ol' || !parts[1] || !parts[2]) return null
  const row = db.prepare('SELECT * FROM api_keys WHERE prefix = ?').get(parts[1]) as unknown as
    | ApiKeyRow
    | undefined
  if (!row || row.revoked_at) return null
  const expected = Buffer.from(row.key_hash, 'hex')
  const actual = createHash('sha256').update(token).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  touchLastUsed(row.id)
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: parseScopes(row.scopes) }
}

export function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required)
}

/** List keys for the admin UI — never includes key_hash or the plaintext token. */
export function listApiKeys(): Omit<ApiKeyRow, 'key_hash'>[] {
  return db
    .prepare(
      `SELECT id, name, prefix, scopes, created_by, last_used_at, revoked_at, created_at
         FROM api_keys ORDER BY created_at DESC, id DESC`,
    )
    .all() as unknown as Omit<ApiKeyRow, 'key_hash'>[]
}

/** Revoke a key (idempotent). Returns false if the id is unknown. */
export function revokeApiKey(id: number): boolean {
  const info = db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .run(id)
  if (info.changes) return true
  // Already revoked? Still "found" if the row exists.
  return !!db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id)
}
