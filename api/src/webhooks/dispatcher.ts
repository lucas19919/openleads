import { lookup } from 'node:dns/promises'
import { lookup as lookupCb, type LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { db, type WebhookDeliveryRow, type WebhookEndpointRow } from '../db'
import { decryptSecret } from '../secrets'
import { signPayload } from './sign'

// Outbound webhook delivery worker. Mirrors the recurring-invoice scheduler at
// the bottom of index.ts: a setTimeout warmup + an unref'd setInterval, gated by
// an env opt-out (WEBHOOKS_DISABLE=1), each tick wrapped so it never throws into
// the timer. A single-flight guard means overlapping ticks can't double-deliver.
//
// Security posture (from the design red-team):
//   • The connection is PINNED to a validated IP: the request's custom DNS lookup
//     resolves, rejects loopback/private/link-local/CGNAT/ULA/metadata addresses,
//     and connects to that exact address. Because the same resolution that
//     validates is the one we connect to, a DNS-rebind (TOCTOU) can't swap in an
//     internal address between check and connect.
//   • We use node:http(s) directly, which does NOT follow redirects, so a 3xx is
//     simply a failed delivery — closing the redirect-to-metadata SSRF vector.
//   • A per-request timeout bounds slow endpoints, and response bodies are drained
//     and discarded (never read or stored), so a malicious endpoint can't echo the
//     signing secret back into our DB.

const MAX_ATTEMPTS = 6 // dead-letter after this many failed tries
const BASE_BACKOFF_S = 30
const MAX_BACKOFF_S = 6 * 60 * 60 // 6h
const POST_TIMEOUT_MS = 8000
const BATCH = 20

/** Exponential backoff (seconds) for the Nth attempt (N >= 1), capped at 6h. */
export function backoffSeconds(attempts: number): number {
  const n = Math.max(1, attempts)
  return Math.min(MAX_BACKOFF_S, BASE_BACKOFF_S * 2 ** (n - 1))
}

function isBlockedIpv4(ip: string): boolean {
  const o = ip.split('.').map((p) => Number(p))
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = o
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a >= 224) return true // multicast (224/4) + reserved (240/4) + broadcast
  return false
}

function isBlockedIpv6(ip: string): boolean {
  const x = ip.toLowerCase()
  if (x === '::1' || x === '::') return true // loopback / unspecified
  if (/^fe[89ab]/.test(x)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(x)) return true // fc00::/7 unique-local
  if (x.startsWith('ff')) return true // multicast
  return false
}

/** True if an address is in a range we must never deliver to (SSRF guard). */
export function isBlockedIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i) // IPv4-mapped IPv6
  if (mapped) return isBlockedIpv4(mapped[1])
  if (ip.includes(':')) return isBlockedIpv6(ip)
  return isBlockedIpv4(ip)
}

export interface UrlCheck {
  ok: boolean
  detail?: string
}

/**
 * SSRF guard. Rejects non-https (unless WEBHOOKS_ALLOW_HTTP=1 for dev), URLs that
 * carry credentials, and any hostname that resolves to a private/local/metadata
 * address. Run on EVERY delivery attempt, not cached.
 */
export async function isSafeWebhookUrl(rawUrl: string): Promise<UrlCheck> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, detail: 'Ungültige URL.' }
  }
  const allowHttp = process.env.WEBHOOKS_ALLOW_HTTP === '1'
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    return { ok: false, detail: 'Nur HTTPS-Ziele sind erlaubt.' }
  }
  if (u.username || u.password) {
    return { ok: false, detail: 'URL darf keine Zugangsdaten enthalten.' }
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(u.hostname, { all: true })
  } catch {
    return { ok: false, detail: 'DNS-Auflösung des Ziels fehlgeschlagen.' }
  }
  if (addrs.length === 0) return { ok: false, detail: 'Ziel ist nicht auflösbar.' }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      return { ok: false, detail: `Ziel-IP ${a.address} ist nicht erlaubt (privat/lokal/Metadaten).` }
    }
  }
  return { ok: true }
}

// Custom DNS lookup that VALIDATES then PINS: it resolves, rejects if any address
// is blocked, and hands net.connect a single validated address. Because this is
// the resolution the socket actually connects to, there is no rebind window
// between validation and connect.
const pinningLookup: LookupFunction = (hostname, options, callback) => {
  lookupCb(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0)
    const list = Array.isArray(addresses) ? addresses : []
    if (list.length === 0) return callback(new Error('not resolvable'), '', 0)
    const blocked = list.find((a) => isBlockedIp(a.address))
    if (blocked) return callback(new Error(`blocked address ${blocked.address}`), '', 0)
    callback(null, list[0].address, list[0].family)
  })
}

/**
 * POST a signed webhook body. Uses node:http(s) directly (no redirect following)
 * with the pinning lookup, a timeout, and a drained/discarded response body.
 * Resolves with the HTTP status; rejects on transport/timeout error.
 */
function postWebhook(
  urlStr: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const reqFn = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = reqFn(
      urlStr,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: pinningLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0
        res.resume() // drain + discard — never read the body (no secret echo)
        res.on('end', () => resolve({ status }))
        res.on('error', () => resolve({ status }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Webhook-Versand.')))
    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

function markDelivered(row: WebhookDeliveryRow, code: number): void {
  db.prepare(
    `UPDATE webhook_deliveries
        SET status = 'delivered', attempts = ?, response_code = ?, last_error = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(row.attempts + 1, code, row.id)
}

function recordFailure(row: WebhookDeliveryRow, code: number | null, detail: string): void {
  const attempts = row.attempts + 1
  const err = detail.slice(0, 300) // bounded; never the response body or a secret
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE webhook_deliveries
          SET status = 'failed', attempts = ?, response_code = ?, last_error = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(attempts, code, err, row.id)
  } else {
    db.prepare(
      `UPDATE webhook_deliveries
          SET attempts = ?, response_code = ?, last_error = ?,
              next_attempt_at = datetime('now', ?), updated_at = datetime('now')
        WHERE id = ?`,
    ).run(attempts, code, err, `+${backoffSeconds(attempts)} seconds`, row.id)
  }
}

async function deliverOne(row: WebhookDeliveryRow): Promise<void> {
  const ep = db
    .prepare('SELECT * FROM webhook_endpoints WHERE id = ?')
    .get(row.endpoint_id) as unknown as WebhookEndpointRow | undefined
  if (!ep || ep.active !== 1) {
    recordFailure(row, null, 'Endpunkt deaktiviert oder gelöscht.')
    return
  }
  const secret = decryptSecret(ep.secret_enc)
  if (!secret) {
    recordFailure(row, null, 'Signaturgeheimnis nicht entschlüsselbar (SETTINGS_KEY?).')
    return
  }
  const safe = await isSafeWebhookUrl(ep.url)
  if (!safe.ok) {
    recordFailure(row, null, safe.detail ?? 'Ziel nicht erlaubt.')
    return
  }
  const t = Math.floor(Date.now() / 1000)
  try {
    const { status } = await postWebhook(
      ep.url,
      row.payload,
      {
        'content-type': 'application/json',
        'webhook-signature': signPayload(secret, row.payload, t),
        'webhook-id': String(row.id),
        'user-agent': 'OpenLeads-Webhooks/1',
      },
      POST_TIMEOUT_MS,
    )
    if (status >= 200 && status < 300) markDelivered(row, status)
    else recordFailure(row, status || null, `HTTP ${status || 'redirect'}`) // 3xx not followed
  } catch (e) {
    recordFailure(row, null, (e as Error).message)
  }
}

let running = false

/** Deliver all due, pending deliveries. Single-flight; never throws. */
export async function dispatchDue(): Promise<void> {
  if (running) return
  running = true
  try {
    const due = db
      .prepare(
        `SELECT * FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= datetime('now')
          ORDER BY id LIMIT ${BATCH}`,
      )
      .all() as unknown as WebhookDeliveryRow[]
    for (const row of due) {
      try {
        await deliverOne(row)
      } catch (e) {
        console.warn('webhook delivery error:', (e as Error).message)
      }
    }
  } finally {
    running = false
  }
}

/** Start the in-process dispatcher (idempotent-ish; call once at boot). */
export function startWebhookDispatcher(): void {
  const tick = () => {
    dispatchDue().catch((e) => console.warn('webhook dispatcher error:', (e as Error).message))
  }
  setTimeout(tick, 5_000).unref() // warmup shortly after boot
  setInterval(tick, 10_000).unref() // then every 10s
}
