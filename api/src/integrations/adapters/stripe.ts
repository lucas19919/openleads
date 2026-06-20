import type {
  ConfigFieldSchema,
  IntegrationContext,
  ParsedPaymentEvent,
  PaymentLink,
  PaymentProvider,
  ProbeResult,
  ProviderDefinition,
  ResolvedConnection,
} from '../types'
import { verifySignature } from '../../webhooks/sign'

// Stripe payment adapter — fetch only, no SDK (dependency-light). The base URL is
// HARDCODED to api.stripe.com: the secret key must never be sent to an
// operator-supplied host, so unlike the AI base_url this is not configurable.
//
// verifyWebhook/parseWebhook are PURE (no network) and use the same HMAC-SHA256
// primitive as the rest of the codebase, so they are unit-tested offline by
// signing a body with a known secret and asserting the round-trip.

const STRIPE_BASE = 'https://api.stripe.com'
const TIMEOUT_MS = 12_000

const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  { key: 'secret_key', label: 'Stripe Secret Key (sk_...)', type: 'string', secret: true, required: true, placeholder: 'sk_live_...' },
  { key: 'webhook_secret', label: 'Webhook Signing Secret (whsec_...)', type: 'string', secret: true, placeholder: 'whsec_...' },
  { key: 'success_url', label: 'Erfolgs-URL (nach Zahlung)', type: 'string', required: true, placeholder: 'https://...' },
  { key: 'cancel_url', label: 'Abbruch-URL', type: 'string', placeholder: 'https://...' },
]

class StripeAdapter implements PaymentProvider {
  readonly category = 'payment' as const
  readonly provider = 'stripe'
  private readonly secretKey: string
  private readonly webhookSecret: string
  private readonly successUrl: string
  private readonly cancelUrl: string

  constructor(conn: ResolvedConnection) {
    this.secretKey = conn.secrets.secret_key ?? ''
    this.webhookSecret = conn.secrets.webhook_secret ?? ''
    this.successUrl = String(conn.config.success_url ?? '')
    this.cancelUrl = String(conn.config.cancel_url ?? this.successUrl)
  }

  private async call(path: string, body?: URLSearchParams): Promise<unknown> {
    if (!this.secretKey) throw new Error('Stripe: Secret Key nicht konfiguriert.')
    let res: Response
    try {
      res = await fetch(`${STRIPE_BASE}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('Stripe ist nicht erreichbar.')
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    if (!res.ok) throw new Error(`Stripe-Fehler: ${json?.error?.message ?? res.status}`)
    return json
  }

  async probe(): Promise<ProbeResult> {
    if (!this.secretKey) return { ok: false, detail: 'Secret Key nicht konfiguriert.' }
    try {
      await this.call('/v1/balance')
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  async createPaymentLink(
    input: {
      amount_cents: number
      currency: string
      description?: string
      document_id?: number
      customer_email?: string | null
    },
    _ctx: IntegrationContext,
  ): Promise<PaymentLink> {
    if (!this.successUrl) throw new Error('Stripe: Erfolgs-URL (success_url) nicht konfiguriert.')
    if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) {
      throw new Error('Betrag (Cent) muss eine positive Ganzzahl sein.')
    }
    const form = new URLSearchParams()
    form.set('mode', 'payment')
    form.set('success_url', this.successUrl)
    form.set('cancel_url', this.cancelUrl || this.successUrl)
    form.set('line_items[0][quantity]', '1')
    form.set('line_items[0][price_data][currency]', (input.currency || 'eur').toLowerCase())
    form.set('line_items[0][price_data][unit_amount]', String(input.amount_cents))
    form.set('line_items[0][price_data][product_data][name]', input.description || 'Rechnung')
    if (input.document_id != null) form.set('metadata[document_id]', String(input.document_id))
    if (input.customer_email) form.set('customer_email', input.customer_email)
    const s = (await this.call('/v1/checkout/sessions', form)) as {
      id: string
      url: string
      status?: string
    }
    return {
      id: s.id,
      url: s.url,
      amount_cents: input.amount_cents,
      currency: (input.currency || 'eur').toLowerCase(),
      status: s.status ?? 'open',
    }
  }

  // Stripe's scheme is HMAC-SHA256 over `${t}.${rawBody}` with the whsec secret —
  // identical to our own webhook signature, so we reuse verifySignature(). Fails
  // closed when the webhook secret is unset.
  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean {
    const header = headers['stripe-signature'] ?? headers['Stripe-Signature']
    return verifySignature(this.webhookSecret, rawBody, header)
  }

  parseWebhook(rawBody: string): ParsedPaymentEvent {
    let evt: {
      id?: string
      type?: string
      data?: { object?: Record<string, unknown> }
    }
    try {
      evt = JSON.parse(rawBody)
    } catch {
      return { external_id: null, type: 'unparseable' }
    }
    const obj = evt.data?.object ?? {}
    const type = evt.type ?? 'unknown'
    const paid =
      type === 'checkout.session.completed' ||
      type === 'payment_intent.succeeded' ||
      obj.payment_status === 'paid'
    const amount = Number(obj.amount_total ?? obj.amount_received ?? obj.amount ?? NaN)
    const docId = Number((obj.metadata as Record<string, unknown> | undefined)?.document_id ?? NaN)
    return {
      external_id: evt.id ?? null,
      type,
      paid,
      amount_cents: Number.isFinite(amount) ? amount : undefined,
      currency: typeof obj.currency === 'string' ? obj.currency : undefined,
      document_id: Number.isFinite(docId) ? docId : null,
    }
  }
}

export const stripeDefinition: ProviderDefinition<PaymentProvider> = {
  category: 'payment',
  provider: 'stripe',
  label: 'Stripe',
  configSchema: CONFIG_SCHEMA,
  build: (conn) => new StripeAdapter(conn),
}
