import type { Hono, MiddlewareHandler } from 'hono'
import { createHash } from 'node:crypto'
import { db, type IntegrationConnectionRow } from '../db'
import { audit } from '../audit'
import { rateLimit } from '../ratelimit'
import { getDocument } from '../documents'
import { addPayment, paidCents } from '../payments'
import { emit } from '../webhooks/bus'
import {
  available,
  listConnections,
  getConnection,
  saveConnection,
  activate,
  deleteConnection,
  adapterById,
  resolveActiveByProvider,
  setStatus,
} from './registry'
import type { IntegrationCategory, PaymentProvider } from './types'

// /api/integrations/* — management routes are admin-only; the inbound provider
// webhook receiver is intentionally UNAUTHENTICATED and gated SOLELY by the
// adapter's signature verification (an inbound webhook can't carry a session).

type App = Hono<any> // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_WEBHOOK_BODY = 1_000_000 // 1 MB cap on inbound bodies

function actorOf(c: Parameters<MiddlewareHandler>[0]): string | null {
  return (c.get('user') as { username?: string } | undefined)?.username ?? null
}

function publicConnection(r: IntegrationConnectionRow) {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(r.config)
  } catch {
    /* keep {} */
  }
  return {
    id: r.id,
    category: r.category,
    provider: r.provider,
    label: r.label,
    active: r.active === 1,
    status: r.status,
    status_detail: r.status_detail,
    config, // only non-secret fields ever land here
    credentials_set: !!r.credentials_enc,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function registerIntegrationRoutes(app: App, requireAdmin: MiddlewareHandler): void {
  // --- catalogue: provider definitions + their config form schema -----------
  app.get('/api/integrations/providers', requireAdmin, (c) => {
    const providers = available().map((d) => ({
      category: d.category,
      provider: d.provider,
      label: d.label,
      configSchema: d.configSchema,
    }))
    return c.json({ providers })
  })

  // --- configured connections -----------------------------------------------
  app.get('/api/integrations/connections', requireAdmin, (c) => {
    return c.json({ connections: listConnections().map(publicConnection) })
  })

  app.post('/api/integrations/connections', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const category = String(b.category ?? '') as IntegrationCategory
    const provider = String(b.provider ?? '')
    const def = available(category).find((d) => d.provider === provider)
    if (!def) return c.json({ error: 'Unbekannter Anbieter.' }, 400)

    // Split the submitted `fields` into non-secret config and encrypted secrets,
    // driven by the definition's schema. Empty values are ignored (so an update
    // that omits a secret keeps the stored one).
    const fields = (b.fields && typeof b.fields === 'object' ? b.fields : {}) as Record<string, unknown>
    const config: Record<string, unknown> = {}
    const secrets: Record<string, string> = {}
    for (const f of def.configSchema) {
      const v = fields[f.key]
      if (v === undefined || v === null || v === '') continue
      if (f.secret) secrets[f.key] = String(v)
      else config[f.key] = f.type === 'number' ? Number(v) : f.type === 'boolean' ? !!v : String(v)
    }
    try {
      const id = saveConnection({
        category,
        provider,
        label: (b.label as string) ?? null,
        config,
        secrets: Object.keys(secrets).length ? secrets : undefined,
        actor: actorOf(c),
      })
      return c.json({ connection: publicConnection(getConnection(id)!) }, 201)
    } catch (e) {
      // encryptSecret throws the German SETTINGS_KEY error in prod — surface it.
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.post('/api/integrations/connections/:id/activate', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    if (!activate(id, actorOf(c))) return c.json({ error: 'not found' }, 404)
    return c.json({ connection: publicConnection(getConnection(id)!) })
  })

  app.post('/api/integrations/connections/:id/probe', requireAdmin, async (c) => {
    const id = Number(c.req.param('id'))
    const adapter = adapterById(id)
    if (!adapter) return c.json({ error: 'not found' }, 404)
    const result = await adapter.probe()
    setStatus(id, result.ok ? 'ok' : 'error', result.detail ?? null)
    audit({ actor: actorOf(c), action: 'integration.probe', entity: 'integration', entityId: id, detail: { ok: result.ok } })
    return c.json({ probe: result, connection: publicConnection(getConnection(id)!) })
  })

  app.delete('/api/integrations/connections/:id', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteConnection(id, actorOf(c))) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })

  // --- inbound provider webhook receiver (UNAUTHENTICATED, signature-gated) --
  app.post(
    '/api/integrations/webhooks/:provider',
    rateLimit({ windowMs: 60_000, max: 120 }),
    async (c) => {
      const provider = c.req.param('provider')
      const resolved = resolveActiveByProvider(provider)
      if (!resolved) return c.json({ error: 'Kein aktiver Anbieter.' }, 404)
      const { adapter, connection } = resolved
      if (adapter.category !== 'payment') {
        return c.json({ error: 'Webhook für diese Kategorie nicht unterstützt.' }, 400)
      }
      const pay = adapter as PaymentProvider

      // Read the RAW body BEFORE parsing — the signature is over these exact bytes.
      const rawBody = await c.req.text()
      if (rawBody.length > MAX_WEBHOOK_BODY) return c.json({ error: 'Body zu groß.' }, 413)
      const headers = c.req.header() as Record<string, string>

      // Fail closed: a bad/absent signature (incl. unset secret) is rejected.
      if (!pay.verifyWebhook(rawBody, headers)) {
        return c.json({ error: 'Signaturprüfung fehlgeschlagen.' }, 400)
      }

      const parsed = pay.parseWebhook(rawBody)
      // Idempotency key: the provider's event id, or a deterministic hash of the
      // raw body when it supplies none. SQLite treats NULL as DISTINCT in a UNIQUE
      // index, so a null id would silently bypass dedup and let a redelivered
      // partial-payment event double-apply — the hash fallback closes that.
      const externalId =
        parsed.external_id && parsed.external_id.trim()
          ? parsed.external_id
          : `sha256:${createHash('sha256').update(rawBody).digest('hex')}`

      // Idempotency: UNIQUE(provider, external_id). A replay is a no-op 200.
      try {
        db.prepare(
          `INSERT INTO integration_events (category, provider, external_id, type, payload, signature_ok)
           VALUES (?, ?, ?, ?, ?, 1)`,
        ).run(connection.category, provider, externalId, parsed.type, rawBody)
      } catch {
        return c.json({ ok: true, duplicate: true })
      }
      const eventId = Number(
        (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
      )

      // Apply the side effect: a paid invoice → record the payment (idempotent via
      // the event dedup above). Amounts are validated as positive integer cents,
      // exactly like the manual payment route — a float/negative is ignored.
      let result: Record<string, unknown> = { applied: false }
      if (parsed.paid && parsed.document_id) {
        const doc = getDocument(parsed.document_id)
        const amount = Math.round(Number(parsed.amount_cents))
        if (
          doc &&
          doc.kind === 'rechnung' &&
          doc.number &&
          doc.status !== 'bezahlt' &&
          doc.status !== 'storniert' &&
          Number.isFinite(amount) &&
          amount > 0
        ) {
          const payment = addPayment(doc.id, {
            amount_cents: amount,
            paid_on: null,
            method: 'Stripe',
            note: `${provider} ${parsed.external_id ?? ''}`.trim(),
          })
          emit('payment.recorded', {
            document_id: doc.id,
            amount_cents: amount,
            paid_total_cents: paidCents(doc.id),
            source: provider,
          })
          result = { applied: true, payment_id: payment.id, document_id: doc.id }
        } else {
          result = { applied: false, reason: 'Rechnung nicht zahlbar oder Betrag ungültig.' }
        }
      }
      db.prepare("UPDATE integration_events SET processed = 1, result = ? WHERE id = ?").run(
        JSON.stringify(result),
        eventId,
      )
      audit({ actor: provider, action: 'integration.webhook', entity: 'integration_event', entityId: eventId, detail: { provider, type: parsed.type, external_id: externalId, ...result } })
      return c.json({ ok: true, ...result })
    },
  )
}
