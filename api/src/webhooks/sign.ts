import { createHmac, timingSafeEqual } from 'node:crypto'

// Webhook payload signing — the contract the docs teach subscribers to verify.
// Stripe-style: the signature binds a unix timestamp AND the raw body, so signing
// the body alone (replayable) is impossible and the timestamp is tamper-evident.
// Header shape:  Webhook-Signature: t=<unixSeconds>,v1=<hex hmac>
// where hmac = HMAC-SHA256(secret, `${t}.${body}`)  — the same primitive auth.ts
// uses for sessions. Pure functions: no DB, no network, fully offline-testable.

const SIG_VERSION = 'v1'

/** HMAC-SHA256(secret, `${t}.${body}`) as lowercase hex. */
export function computeSignature(secret: string, body: string, tSeconds: number): string {
  return createHmac('sha256', secret).update(`${tSeconds}.${body}`).digest('hex')
}

/** Build the `t=..,v1=..` header value for an outbound delivery. */
export function signPayload(secret: string, body: string, tSeconds: number): string {
  return `t=${tSeconds},${SIG_VERSION}=${computeSignature(secret, body, tSeconds)}`
}

/** Parse a `t=..,v1=..` header into its parts (tolerant of ordering/spacing). */
export function parseSignatureHeader(header: string): { t: number | null; v1: string | null } {
  let t: number | null = null
  let v1: string | null = null
  for (const part of header.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim())
    if (k === 't') {
      const n = Number(v)
      if (Number.isFinite(n)) t = n
    } else if (k === SIG_VERSION && v) {
      v1 = v
    }
  }
  return { t, v1 }
}

/**
 * Verify an inbound signature against the RAW body bytes. Fails closed: an unset
 * secret, a malformed header, a stale timestamp (outside tolerance), or a
 * mismatching HMAC all return false. Comparison is constant-time over equal-length
 * buffers, exactly like verifyPassword/readSession.
 */
export function verifySignature(
  secret: string | null | undefined,
  body: string,
  header: string | null | undefined,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!secret || !header) return false
  const { t, v1 } = parseSignatureHeader(header)
  if (t === null || !v1) return false
  const tolerance = opts.toleranceSeconds ?? 300 // 5 minutes
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > tolerance) return false
  const expected = computeSignature(secret, body, t)
  const a = Buffer.from(v1, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
