import type { Hono, MiddlewareHandler } from 'hono'
import { randomBytes } from 'node:crypto'
import { db, type WebhookEndpointRow, type WebhookDeliveryRow } from '../db'
import { encryptSecret } from '../secrets'
import { audit } from '../audit'
import { WEBHOOK_EVENTS } from './bus'
import { isSafeWebhookUrl, dispatchDue } from './dispatcher'

// Admin-only management of outbound webhook subscriptions. The signing secret is
// generated server-side, stored encrypted, and shown to the operator exactly ONCE
// (mirroring the API-key + settings-secret shown-once posture). List/GET never
// return secret_enc — only a secret_set boolean.

type App = Hono<any> // eslint-disable-line @typescript-eslint/no-explicit-any

function actorOf(c: Parameters<MiddlewareHandler>[0]): string | null {
  return (c.get('user') as { username?: string } | undefined)?.username ?? null
}

function csvEvents(input: unknown): string {
  if (typeof input !== 'string') return '*'
  const list = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((e) => e === '*' || (WEBHOOK_EVENTS as readonly string[]).includes(e))
  return list.length ? [...new Set(list)].join(',') : '*'
}

function publicEndpoint(r: WebhookEndpointRow) {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    active: r.active === 1,
    description: r.description,
    secret_set: !!r.secret_enc,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function registerWebhookRoutes(app: App, requireAdmin: MiddlewareHandler): void {
  // The event catalogue, for the UI's subscription picker.
  app.get('/api/admin/webhooks/events', requireAdmin, (c) => c.json({ events: WEBHOOK_EVENTS }))

  app.get('/api/admin/webhooks', requireAdmin, (c) => {
    const rows = db
      .prepare('SELECT * FROM webhook_endpoints ORDER BY created_at DESC, id DESC')
      .all() as unknown as WebhookEndpointRow[]
    return c.json({ endpoints: rows.map(publicEndpoint) })
  })

  app.post('/api/admin/webhooks', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const url = String(b.url ?? '').trim()
    if (!url) return c.json({ error: 'Ziel-URL fehlt.' }, 400)
    const safe = await isSafeWebhookUrl(url)
    if (!safe.ok) return c.json({ error: safe.detail ?? 'Ziel-URL nicht erlaubt.' }, 400)

    // The signing secret: shown once here, encrypted at rest, never returned again.
    const secret = `whsec_${randomBytes(24).toString('hex')}`
    let secret_enc: string
    try {
      secret_enc = encryptSecret(secret)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const info = db
      .prepare(
        `INSERT INTO webhook_endpoints (url, secret_enc, events, active, description, created_by)
         VALUES (@url, @secret_enc, @events, @active, @description, @created_by)`,
      )
      .run({
        url,
        secret_enc,
        events: csvEvents(b.events),
        active: b.active === false ? 0 : 1,
        description: (b.description as string) ?? null,
        created_by: actorOf(c),
      })
    const id = Number(info.lastInsertRowid)
    audit({ actor: actorOf(c), action: 'webhook.create', entity: 'webhook_endpoint', entityId: id, detail: { url, events: csvEvents(b.events) } })
    const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id) as unknown as WebhookEndpointRow
    // `secret` is included ONLY in this create response.
    return c.json({ endpoint: publicEndpoint(row), secret }, 201)
  })

  app.patch('/api/admin/webhooks/:id', requireAdmin, async (c) => {
    const id = Number(c.req.param('id'))
    const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id) as unknown as
      | WebhookEndpointRow
      | undefined
    if (!row) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const sets: string[] = []
    const params: Record<string, string | number | null> = { id }
    if (typeof b.url === 'string') {
      const safe = await isSafeWebhookUrl(b.url.trim())
      if (!safe.ok) return c.json({ error: safe.detail ?? 'Ziel-URL nicht erlaubt.' }, 400)
      sets.push('url = @url')
      params.url = b.url.trim()
    }
    if ('events' in b) {
      sets.push('events = @events')
      params.events = csvEvents(b.events)
    }
    if ('active' in b) {
      sets.push('active = @active')
      params.active = b.active ? 1 : 0
    }
    if ('description' in b) {
      sets.push('description = @description')
      params.description = (b.description as string) ?? null
    }
    if (!sets.length) return c.json({ endpoint: publicEndpoint(row) })
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = @id`).run(params)
    audit({ actor: actorOf(c), action: 'webhook.update', entity: 'webhook_endpoint', entityId: id, detail: { fields: Object.keys(params).filter((k) => k !== 'id') } })
    const updated = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id) as unknown as WebhookEndpointRow
    return c.json({ endpoint: publicEndpoint(updated) })
  })

  app.delete('/api/admin/webhooks/:id', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    const info = db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(id)
    if (!info.changes) return c.json({ error: 'not found' }, 404)
    audit({ actor: actorOf(c), action: 'webhook.delete', entity: 'webhook_endpoint', entityId: id })
    return c.json({ ok: true })
  })

  app.get('/api/admin/webhooks/:id/deliveries', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    const rows = db
      .prepare(
        `SELECT id, endpoint_id, event, attempts, status, next_attempt_at, response_code, last_error, created_at, updated_at
           FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(id) as unknown as Omit<WebhookDeliveryRow, 'payload'>[]
    return c.json({ deliveries: rows })
  })

  // Re-queue a delivery: reset attempts + status so it gets a fresh retry budget.
  app.post('/api/admin/webhooks/deliveries/:id/redeliver', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    const info = db
      .prepare(
        `UPDATE webhook_deliveries
            SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'),
                last_error = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(id)
    if (!info.changes) return c.json({ error: 'not found' }, 404)
    audit({ actor: actorOf(c), action: 'webhook.redeliver', entity: 'webhook_delivery', entityId: id })
    // Kick the dispatcher so redelivery is prompt (non-blocking, never throws).
    dispatchDue().catch(() => {})
    return c.json({ ok: true })
  })
}
