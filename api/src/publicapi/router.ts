import type { Hono, MiddlewareHandler, Context } from 'hono'
import { db, DOC_KINDS, type LeadRow } from '../db'
import { audit } from '../audit'
import { rateLimit } from '../ratelimit'
import { getDocument, getSettings, replaceItems, type DocItemInput } from '../documents'
import { insertLead, applyLeadUpdate } from '../leads'
import { addPayment, paidCents } from '../payments'
import { buildDashboard } from '../dashboard'
import { resolve } from '../integrations/registry'
import type { PaymentProvider } from '../integrations/types'
import { emit } from '../webhooks/bus'
import {
  API_SCOPES,
  type AuthedKey,
  verifyApiKey,
  hasScope,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from './keys'

// The public, versioned API surface. Two disjoint auth schemes:
//   • /api/v1/*  — Bearer `ol_...` API keys ONLY (never the session cookie),
//     scope-checked per route, rate-limited per key, cursor-paginated.
//   • /api/admin/api-keys — session admin only (requireAdmin), where keys are
//     minted/revoked. A scoped key can never reach key management.

type App = Hono<any> // eslint-disable-line @typescript-eslint/no-explicit-any

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function authedKey(c: Context): AuthedKey {
  return c.get('apiKey') as AuthedKey
}

function adminName(c: Parameters<MiddlewareHandler>[0]): string | null {
  return (c.get('user') as { username?: string } | undefined)?.username ?? null
}

/** Per-route scope guard. 403 (German) when the key lacks the scope. */
function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const k = c.get('apiKey') as AuthedKey | undefined
    if (!k || !hasScope(k.scopes, scope)) {
      return c.json({ error: `Fehlende Berechtigung (Scope: ${scope}).` }, 403)
    }
    await next()
  }
}

export function registerPublicApiRoutes(app: App, requireAdmin: MiddlewareHandler): void {
  // --- Bearer-key authentication for the whole /api/v1 surface --------------
  app.use('/api/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const key = token ? verifyApiKey(token) : null
    if (!key) return c.json({ error: 'Ungültiger oder fehlender API-Schlüssel.' }, 401)
    c.set('apiKey', key)
    await next()
  })
  // Rate-limit per key (keyed by the non-secret prefix), after auth so the key id
  // is known. The in-memory limiter's IP default is spoofable; keying by the key
  // makes the limit meaningful per integrator.
  app.use(
    '/api/v1/*',
    rateLimit({ windowMs: 60_000, max: 120, key: (c) => `k:${(c.get('apiKey') as AuthedKey | undefined)?.prefix ?? 'anon'}` }),
  )

  // Smoke test for integrators: echo the authed key's identity + scopes.
  app.get('/api/v1/auth/test', (c) => {
    const k = authedKey(c)
    return c.json({ ok: true, name: k.name, prefix: k.prefix, scopes: k.scopes })
  })

  // --- leads ----------------------------------------------------------------
  app.get('/api/v1/leads', requireScope('leads:read'), (c) => {
    const limit = clamp(Number(c.req.query('limit')) || 50, 1, 100)
    const cursor = Number(c.req.query('cursor')) || 0
    const rows = (
      cursor > 0
        ? db.prepare('SELECT * FROM leads WHERE id < ? ORDER BY id DESC LIMIT ?').all(cursor, limit)
        : db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as LeadRow[]
    const next_cursor = rows.length === limit ? rows[rows.length - 1].id : null
    return c.json({ data: rows, next_cursor })
  })

  app.get('/api/v1/leads/:id', requireScope('leads:read'), (c) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(c.req.param('id'))) as
      | unknown as LeadRow | undefined
    if (!lead) return c.json({ error: 'not found' }, 404)
    return c.json({ data: lead })
  })

  app.post('/api/v1/leads', requireScope('leads:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const actor = `api:${authedKey(c).prefix}`
    const r = insertLead({ ...b, source: (b.source as string) ?? 'api' }, actor)
    audit({ actor, action: 'lead.create', entity: 'lead', entityId: r.id, detail: { deduped: !!r.deduped } })
    return r.deduped ? c.json({ data: { id: r.id }, deduped: true }) : c.json({ data: { id: r.id } }, 201)
  })

  app.patch('/api/v1/leads/:id', requireScope('leads:write'), async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const actor = `api:${authedKey(c).prefix}`
    try {
      const lead = applyLeadUpdate(id, b, actor)
      if (!lead) return c.json({ error: 'not found' }, 404)
      audit({ actor, action: 'lead.update', entity: 'lead', entityId: id, detail: { fields: Object.keys(b) } })
      return c.json({ data: lead })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // --- documents ------------------------------------------------------------
  app.get('/api/v1/documents', requireScope('documents:read'), (c) => {
    const limit = clamp(Number(c.req.query('limit')) || 50, 1, 100)
    const cursor = Number(c.req.query('cursor')) || 0
    const kind = c.req.query('kind')
    const filtered = kind && DOC_KINDS.includes(kind as never)
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filtered) {
      clauses.push('kind = ?')
      params.push(kind as string)
    }
    if (cursor > 0) {
      clauses.push('id < ?')
      params.push(cursor)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    params.push(limit)
    const ids = db
      .prepare(`SELECT id FROM documents ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as unknown as { id: number }[]
    const data = ids.map((r) => getDocument(r.id))
    const next_cursor = ids.length === limit ? ids[ids.length - 1].id : null
    return c.json({ data, next_cursor })
  })

  app.get('/api/v1/documents/:id', requireScope('documents:read'), (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({ data: doc })
  })

  app.post('/api/v1/documents', requireScope('documents:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const kind = String(b.kind ?? '')
    if (!DOC_KINDS.includes(kind as never)) return c.json({ error: 'invalid kind' }, 400)
    const s = getSettings()
    const info = db
      .prepare(
        `INSERT INTO documents
          (kind, lead_id, client_name, client_address, client_zip, client_city,
           client_email, client_type, title, intro, notes, small_business, vat_rate)
         VALUES
          (@kind, @lead_id, @client_name, @client_address, @client_zip, @client_city,
           @client_email, @client_type, @title, @intro, @notes, @small_business, @vat_rate)`,
      )
      .run({
        kind,
        lead_id: b.lead_id != null ? Number(b.lead_id) : null,
        client_name: (b.client_name as string) ?? null,
        client_address: (b.client_address as string) ?? null,
        client_zip: (b.client_zip as string) ?? null,
        client_city: (b.client_city as string) ?? null,
        client_email: (b.client_email as string) ?? null,
        client_type: b.client_type === 'privat' ? 'privat' : 'geschaeft',
        title: (b.title as string) ?? (kind === 'rechnung' ? 'Rechnung' : 'Angebot'),
        intro: (b.intro as string) ?? null,
        notes: (b.notes as string) ?? null,
        small_business: s.small_business,
        vat_rate: s.vat_rate,
      })
    const id = Number(info.lastInsertRowid)
    if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
    const actor = `api:${authedKey(c).prefix}`
    audit({ actor, action: 'document.create', entity: 'document', entityId: id, detail: { kind } })
    emit('document.created', { id, kind })
    return c.json({ data: getDocument(id) }, 201)
  })

  // Create a hosted payment link for an invoice's OPEN amount (via active provider).
  app.post('/api/v1/documents/:id/payment-link', requireScope('documents:write'), async (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (doc.kind !== 'rechnung' || !doc.number) {
      return c.json({ error: 'Zahlungslink nur für ausgestellte Rechnungen.' }, 400)
    }
    const open = doc.totals.gross_cents - doc.paid_cents
    if (open <= 0) return c.json({ error: 'Rechnung ist bereits vollständig bezahlt.' }, 409)
    const pay = resolve('payment') as PaymentProvider | null
    if (!pay) return c.json({ error: 'Kein aktiver Zahlungsanbieter konfiguriert.' }, 400)
    const actor = `api:${authedKey(c).prefix}`
    try {
      const link = await pay.createPaymentLink(
        { amount_cents: open, currency: 'eur', description: `${doc.title ?? 'Rechnung'} ${doc.number}`, document_id: doc.id, customer_email: doc.client_email },
        { actor },
      )
      audit({ actor, action: 'invoice.payment_link', entity: 'document', entityId: doc.id, detail: { amount_cents: open, provider: pay.provider } })
      return c.json({ data: link })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  // Record a payment against an invoice (settling flips it to 'bezahlt').
  app.post('/api/v1/documents/:id/payments', requireScope('payments:write'), async (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (doc.kind !== 'rechnung' || !doc.number) {
      return c.json({ error: 'Zahlungen nur für ausgestellte Rechnungen.' }, 400)
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const amount = Math.round(Number(b.amount_cents))
    if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
    const actor = `api:${authedKey(c).prefix}`
    const payment = addPayment(doc.id, {
      amount_cents: amount,
      paid_on: (b.paid_on as string) ?? null,
      method: (b.method as string) ?? null,
      note: (b.note as string) ?? null,
    })
    audit({ actor, action: 'invoice.payment', entity: 'document', entityId: doc.id, detail: { amount_cents: amount, paid_total_cents: paidCents(doc.id) } })
    emit('payment.recorded', { document_id: doc.id, amount_cents: amount, paid_total_cents: paidCents(doc.id), source: 'api' })
    return c.json({ data: { payment, document: getDocument(doc.id) } }, 201)
  })

  // Pipeline + invoice KPIs (read-only dashboard data).
  app.get('/api/v1/stats/pipeline', requireScope('stats:read'), (c) => {
    return c.json({ data: buildDashboard() })
  })

  // --- API key management (session admin only) ------------------------------
  app.get('/api/admin/api-keys', requireAdmin, (c) => c.json({ keys: listApiKeys() }))

  app.post('/api/admin/api-keys', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { name?: string; scopes?: unknown }
    const scopes = Array.isArray(b.scopes) ? b.scopes.map(String) : []
    const invalid = scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s))
    if (invalid.length) return c.json({ error: `Unbekannte Scopes: ${invalid.join(', ')}` }, 400)
    if (!scopes.length) return c.json({ error: 'Mindestens ein Scope ist erforderlich.' }, 400)
    const created = createApiKey({ name: b.name ?? null, scopes, createdBy: adminName(c) })
    audit({ actor: adminName(c), action: 'apikey.create', entity: 'api_key', entityId: created.id, detail: { name: created.name, scopes: created.scopes, prefix: created.prefix } })
    // The full token is returned ONLY here, once.
    return c.json({ key: { id: created.id, name: created.name, prefix: created.prefix, scopes: created.scopes }, token: created.token }, 201)
  })

  app.delete('/api/admin/api-keys/:id', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    if (!revokeApiKey(id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: adminName(c), action: 'apikey.revoke', entity: 'api_key', entityId: id })
    return c.json({ ok: true })
  })
}
