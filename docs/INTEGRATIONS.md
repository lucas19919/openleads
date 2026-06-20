# OpenLeads integrations, public API & webhooks

This is the foundation the integration roadmap rides on: a per-category **adapter
interface** for third-party providers, a **public REST API** (scoped, keyed), and
**outbound webhooks** so other systems react to OpenLeads events. All three follow
the house rules — dependency-light (`fetch` + Node built-ins), strict TypeScript,
German user-facing strings, money in integer cents, every state change `audit()`-ed,
and secrets encrypted at rest with the same AES-256-GCM as `secrets.ts`.

```
                ┌─────────────────────────────────────────────┐
  integrators ──┤  /api/v1/*   (Bearer ol_ keys, scoped)        │── leads, documents
                └─────────────────────────────────────────────┘
                ┌─────────────────────────────────────────────┐
  your systems ◀┤  outbound webhooks (HMAC-signed, retried)    │◀── emit(event)
                └─────────────────────────────────────────────┘
                ┌─────────────────────────────────────────────┐
  providers   ──┤  integrations/ adapters (Stripe, VIES, SMTP) │── inbound webhooks
                └─────────────────────────────────────────────┘
```

---

## 1. Integration adapters

An integration is a small adapter that implements one **category** interface from
[`api/src/integrations/types.ts`](../api/src/integrations/types.ts):
`PaymentProvider`, `AccountingProvider`, `MailProvider`, `EnrichmentProvider`,
`CalendarProvider`, `TelephonyProvider`. Each extends `IntegrationAdapter` (a
`probe()` self-test that drives the status badge).

Connections live in `integration_connections`: non-secret settings in a plaintext
`config` JSON column, credentials in `credentials_enc` (AES-256-GCM ciphertext).
Only one connection per category is `active` at a time; `resolve(category)` builds
the live adapter fresh on each call (so a Settings change takes effect without a
restart — the same getter-based posture as the SMTP mailer).

### Authoring a new adapter

1. Implement the category interface as a class.
2. Export a `ProviderDefinition` declaring a `configSchema` (the UI renders a form
   from it; fields with `secret: true` are stored encrypted and never returned).
3. `register()` it in [`api/src/integrations/index.ts`](../api/src/integrations/index.ts).

```ts
// api/src/integrations/adapters/acme.ts
import type { EnrichmentProvider, ProviderDefinition, ResolvedConnection } from '../types'

class AcmeAdapter implements EnrichmentProvider {
  readonly category = 'enrichment' as const
  readonly provider = 'acme'
  private readonly apiKey: string
  constructor(conn: ResolvedConnection) { this.apiKey = conn.secrets.api_key ?? '' }
  async probe() { return this.apiKey ? { ok: true } : { ok: false, detail: 'API-Key fehlt.' } }
  async enrichByDomain(domain: string) {
    const res = await fetch(`https://api.acme.example/lookup?d=${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error('Acme nicht erreichbar.')
    const j = await res.json()
    return { company: j.name ?? null, phone: j.phone ?? null }
  }
}

export const acmeDefinition: ProviderDefinition<EnrichmentProvider> = {
  category: 'enrichment',
  provider: 'acme',
  label: 'Acme Data',
  configSchema: [{ key: 'api_key', label: 'API-Key', type: 'string', secret: true, required: true }],
  build: (conn) => new AcmeAdapter(conn),
}
```

**Rules of thumb.** Credential-bearing adapters must use a **hardcoded base URL**
(never an operator-supplied one — an attacker could redirect the credential).
Resolve credentials lazily per call; never cache a decrypted secret at module
load. Verify inbound webhooks over the **raw body** before parsing.

### Shipped reference adapters

| Category | Provider | Notes |
|---|---|---|
| `payment` | `stripe` | Checkout sessions via `fetch` (no SDK). Webhook signature verify + parse are pure. Base URL pinned to `api.stripe.com`. |
| `accounting` | `vies` | Free EU VAT-id validation. No credentials. |
| `mail` | `smtp` | Wraps the existing mailer — preserves the UWG §7 / opt-out gates. |

The remaining categories are interface-only stubs for the roadmap to fill in.

### Admin endpoints (session admin only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/integrations/providers` | Catalogue + config form schemas |
| GET | `/api/integrations/connections` | Configured connections (credentials redacted to a `credentials_set` boolean) |
| POST | `/api/integrations/connections` | Create/update (`{category, provider, label, fields}`) |
| POST | `/api/integrations/connections/:id/activate` | Make it the live adapter for its category |
| POST | `/api/integrations/connections/:id/probe` | Run `probe()`, persist status |
| DELETE | `/api/integrations/connections/:id` | Remove |

### Inbound provider webhooks

`POST /api/integrations/webhooks/:provider` is **unauthenticated** and gated solely
by the adapter's signature check over the raw body. A Stripe `checkout.session.completed`
/ `payment_intent.succeeded` whose `metadata.document_id` points at an open invoice
records a payment (idempotent — events are deduped by `(provider, external_id)`).
Configure Stripe to send to `https://crm.example.com/api/integrations/webhooks/stripe`
and set the connection's `webhook_secret` to your `whsec_…`.

---

## 2. Public API (`/api/v1`)

Server-to-server REST authed by an API key. **Disjoint from the session cookie:**
`/api/v1/*` accepts only `Authorization: Bearer ol_…`, and the session app never
accepts API keys.

### Keys

Mint under **Settings → API keys** (admin). The full key `ol_<prefix>_<secret>` is
shown **once** — store it. Only its SHA-256 digest is kept; revocation is immediate.

| Scope | Grants |
|---|---|
| `leads:read` | `GET /api/v1/leads`, `GET /api/v1/leads/:id` |
| `leads:write` | `POST /api/v1/leads`, `PATCH /api/v1/leads/:id` |
| `documents:read` | `GET /api/v1/documents`, `GET /api/v1/documents/:id` |
| `documents:write` | `POST /api/v1/documents` |

Requests are rate-limited per key (120/min). List endpoints are cursor-paginated:
`?limit=<=100&cursor=<id>` → `{ data: [...], next_cursor }` (id-descending; pass
`next_cursor` back as `cursor`).

```bash
# smoke test
curl -H "Authorization: Bearer ol_xxx_yyy" https://crm.example.com/api/v1/auth/test

# create a lead (fires the lead.created webhook)
curl -X POST https://crm.example.com/api/v1/leads \
  -H "Authorization: Bearer ol_xxx_yyy" -H 'content-type: application/json' \
  -d '{"company":"Acme GmbH","website":"acme.de","trade":"Maler"}'

# page through leads
curl -H "Authorization: Bearer ol_xxx_yyy" "https://crm.example.com/api/v1/leads?limit=50&cursor=1234"
```

---

## 3. Outbound webhooks

Subscribe an HTTPS endpoint and OpenLeads POSTs a signed JSON envelope when an
event fires. Manage under **Settings → Webhooks** (admin); the signing secret
(`whsec_…`) is shown **once** at creation.

### Events

`lead.created` · `lead.stage_changed` · `document.created` · `document.finalized`
· `payment.recorded` · `payment.deleted`. Subscribe to specific events (CSV) or `*`.

### Envelope & delivery

```json
{ "event": "lead.created", "created_at": "2026-06-20T10:00:00.000Z", "data": { "id": 42, "lead": { … } } }
```

Headers: `Webhook-Signature: t=<unix>,v1=<hex>` and `Webhook-Id: <delivery id>`.
Delivery is retried with exponential backoff (30s → 6h cap, 6 attempts) then
dead-lettered; redeliver any from the deliveries list. Targets are **SSRF-guarded**
on every attempt (HTTPS only; private/loopback/link-local/metadata addresses
rejected; redirects are not followed), so an endpoint on a private network is
refused by design.

### Verifying a delivery (Node)

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(rawBody, header, secret, toleranceS = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(parts.v1 ?? '', 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

// Express: app.post('/hook', express.raw({type:'*/*'}), (req,res) => {
//   if (!verify(req.body.toString('utf8'), req.get('Webhook-Signature'), process.env.WHSEC)) return res.sendStatus(400)
//   ... res.sendStatus(200)
// })
```

Verify over the **raw bytes** — re-serializing parsed JSON changes the signature.

---

## Configuration

| Env var | Effect |
|---|---|
| `SETTINGS_KEY` | Required in production to store any integration credential or webhook secret (already used by `secrets.ts`). |
| `WEBHOOKS_DISABLE=1` | Turn the outbound dispatcher off. |
| `WEBHOOKS_ALLOW_HTTP=1` | Allow plain-HTTP webhook targets (dev only — still blocks private IPs). |
