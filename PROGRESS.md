# Changelog / progress notes

A running log of what's landed, so picking the work back up is easy. Newest first.

## Latest

- **Integrations foundation** — the substrate the integration roadmap rides on,
  three coupled subsystems, all dependency-light + idiom-matched (docs:
  `docs/INTEGRATIONS.md`):
  - **Integrations module** (`api/src/integrations/`): a per-category adapter
    interface (`PaymentProvider`, `AccountingProvider`, `MailProvider`,
    `EnrichmentProvider`, `CalendarProvider`, `TelephonyProvider`), an encrypted
    connection store (`integration_connections`, credentials AES-256-GCM via
    `secrets.ts`), a registry (`register`/`available`/`resolve`/`saveConnection`/
    `activate`), and **three real reference adapters**: Stripe (Checkout via
    `fetch`, no SDK; base URL pinned to `api.stripe.com`), VIES (free EU USt-IdNr.
    validation), and SMTP (wraps the existing mailer, keeping its UWG §7 / opt-out
    gates). Admin routes under `/api/integrations/*` + an **unauthenticated,
    signature-gated inbound webhook receiver** (`/api/integrations/webhooks/:provider`)
    that records a Stripe payment against the invoice in `metadata.document_id`,
    idempotent via `integration_events UNIQUE(provider, external_id)`.
  - **Public API** (`api/src/publicapi/`): scoped `ol_<prefix>_<secret>` keys,
    SHA-256-hashed at rest (the token is 192-bit random — no slow KDF, no
    per-request DoS), shown once, revocable. A versioned `/api/v1/*` Bearer surface
    (disjoint from the session cookie), scope-checked (`leads:read|write`,
    `documents:read|write`), rate-limited per key, cursor-paginated, over
    leads + documents. Admin key CRUD under `/api/admin/api-keys`.
  - **Outbound webhooks** (`api/src/webhooks/`): a non-throwing `emit(event)` bus
    that enqueues `webhook_deliveries`, hooked into lead create / stage change /
    document create + finalize / payment record + delete. An in-process dispatcher
    (same `setInterval(...).unref()` idiom as the recurring scheduler) signs each
    delivery Stripe-style (`Webhook-Signature: t=..,v1=..`, HMAC-SHA256 over
    `${t}.${body}`), POSTs with a timeout, retries with exponential backoff
    (30s→6h, 6 attempts) then dead-letters, and **SSRF-guards** every target on
    each attempt (HTTPS-only, private/loopback/link-local/metadata IPs rejected,
    redirects not followed). Admin endpoint CRUD + deliveries + redeliver.
  - `insertLead`/`applyLeadUpdate`/`normalizeTags` were extracted from `index.ts`
    into a shared `leads.ts` so the public API reuses one implementation (and
    webhook events fire from one place). Set `WEBHOOKS_DISABLE=1` to turn the
    dispatcher off, `WEBHOOKS_ALLOW_HTTP=1` for dev.
  - **Web UI** (`web/src/components/integrations/IntegrationsView.tsx`): a new
    admin-only **Integrationen** tab (hidden for members) with three sections —
    connect/activate/probe providers (forms rendered from each adapter's
    `configSchema`), mint/revoke API keys (token shown once), and subscribe/manage
    webhooks (signing secret shown once, deliveries + redeliver). Reuses the
    existing Settings idioms (write-only secrets, `items-table` mobile cards).
    Verified in-browser: key + webhook creation, the one-time reveals, and the
    SSRF guard rejecting a private target all work end-to-end.
  - New offline tests: `webhooks.test.ts`, `publicapi.test.ts`,
    `integrations.test.ts` (signature round-trip, SSRF range coverage, emit
    fan-out, backoff, key mint/verify/scope/revoke, Stripe webhook verify, VIES
    mapper). **61 API tests green**; typecheck clean; boot + e2e verified.
- Scraper page is back, now with a **GUI run button** (`api/src/scrape.ts` +
  `POST /api/scraper/run`, recovered after commit 760d379 had stripped it). It
  spawns the scraper as a one-shot child process, fire-and-poll: the panel watches
  `/api/scraper/status` (now carries `run` state + `reachable` + `service_token_configured`)
  for live progress and the final result. A **Testlauf** (`--dry-run`, offline
  fixtures) runs the whole pipeline with no Anthropic cost. Config (region/raster/
  limits) lives on the dedicated Scraper page. New tab in the suite nav.
  - The API now **auto-wires the CRM connection** into the spawned scraper —
    injects its own `SERVICE_TOKEN` as `CRM_SERVICE_TOKEN` (name mismatch was the
    "CRM_SERVICE_TOKEN fehlt" error) plus `CRM_API_URL`. No `scraper/.env` needed
    for the CRM side; the only bootstrap requirement is `SERVICE_TOKEN` in `api/.env`.
  - **Discovery model + API key are now GUI-settable** (`scraper_model` plain,
    `scraper_ai_api_key` encrypted like the other secrets) and injected into the
    run, so a live run needs no `scraper/.env` at all. The model is selectable
    (any Claude model — not pinned to Sonnet); the page text is model-neutral.
- Kanban: columns now flex to share the board width (`flex: 1 1 0; min-width:150px`)
  so all eight stages — including `verloren` — fit on screen by default instead of
  requiring a horizontal scroll.
- Dashboard: KPI cards use `auto-fit` (was `auto-fill`) so they stretch to fill the
  row on a wide monitor instead of leaving a ragged empty trailing column.
- Mobile: the whole web app is now phone-friendly (verified at 320–375px, no
  horizontal overflow on any view). Data tables (Leads, Rechnungen, Mahnungen,
  Serien, Team) and the invoice line-item/payments editors collapse from
  horizontal-scroll into labelled stacked cards under 720px via per-`<td>`
  `data-label` + a CSS card transform; the 7 nav tabs wrap (all visible) instead
  of clipping; tap targets are ≥44px and form controls 16px (no iOS zoom); the
  lead drawer is a full-screen sheet; safe-area insets (notch) and a scrollable
  modal/dashboard 2-up. All mobile rules are in `@media (max-width:720px)` and
  ordered after their base rules. Audited + adversarially reviewed via subagents.
- Generalisation + new modules (make OpenLeads useful beyond a single Munich
  operator):
  - **Payments**: `payments` table; per-invoice recording with partial payments,
    auto-flips status to `bezahlt` when settled (reopens on reversal). Dunning now
    accrues interest on the *outstanding* amount, and the €40 §288(5) Pauschale is
    B2B-only via a new `client_type` (Geschäft/Privat) flag on documents.
  - **Serienrechnungen** (recurring invoices): template + cadence (monatlich /
    quartalsweise / jährlich) emits a draft Rechnung each period via an in-process
    scheduler (6h) or on demand; never auto-finalised or sent.
  - **Dashboard** ("Übersicht", default tab): open/overdue/paid totals, 12-month
    revenue bars, pipeline-by-stage, conversion.
  - **Multi-user**: `admin`/`member` roles, user management UI (admin-only),
    lead assignment dropdown. `requireAdmin` guard on user routes.
  - **Hardcoding cleanup**: scraper model is `SCRAPER_MODEL`-overridable; region is
    a setting (no baked "Großraum München"); town/region defaults neutralised; the
    scraper raster is editable under Settings → Lead-Scraper.
  - New unit tests: `payments.test.ts`, `recurring.test.ts`, plus dunning coverage
    for partial-payment interest and the B2C no-Pauschale rule. 47 API tests green.
- Leads: replaced the old Wiedervorlage (follow-up date) with a `Rückruf`
  pipeline stage, and added free-form tags on leads (chips on cards + the table,
  editable in the drawer, searchable).
- Workflows: rebuilt the static three-card screen into a routine builder. You
  pick a target (stage / qualification / tags / score / "not yet evaluated" etc.)
  and chain steps from a palette — scrape, qualify, draft outreach, move stage,
  set priority, tag, note. Routines run on demand or on a schedule (hourly /
  daily / weekly) via an in-process scheduler. Scrape runs first in a routine so
  fresh leads flow into the following steps. Outreach steps still only produce
  drafts.

## v1

The first complete, hardened version. 33 API unit tests green, full HTTP smoke
test green, all packages typecheck, web builds.

What's in it:

- **AI core** (`api/src/ai/*`): OpenAI-compatible provider (open/local first),
  copilot agent loop, domain tools, lead intelligence (analyze / outreach),
  NL→invoice. Agent loop tested against a mock model.
- **Lead pipeline**: scraper (Claude web search) + staleness scoring, CRM kanban
  and table, stages, notes, `.xlsx` import, dedupe by domain. Per-lead AI
  qualification and outreach drafting.
- **Semantic lead search** (`/api/ai/leads/search`): local embeddings + cosine,
  with a SQL fallback when the model is offline.
- **Invoicing**: Angebote / Rechnungen, gapless numbering, ZUGFeRD / Factur-X
  PDF/A-3 (§19 UStG aware), built-in EN 16931 validator, Käuferreferenz /
  Leitweg-ID (BT-10) for B2G.
- **Mahnwesen** ("Offene Posten"): overdue detection, Mahnstufen, §288 BGB
  Verzugszinsen + €40 Pauschale, printable Mahnung PDF.
- **GoBD / DATEV export**: invoice journal + booking CSV, date-ranged, with
  configurable SKR03 accounts.
- **Gated SMTP send**: only fires for status `freigegeben`, appends Impressum +
  opt-out, audited.
- **AI daily digest** (`/api/ai/digest`) surfaced in the copilot as a
  Tages-Briefing.
- **DSGVO toolkit** (`dsgvo.ts`, `audit.ts`): audit log, export, erasure (with
  §147 AO retention), consent ledger, Art. 30 record.
- **Backups** (`backup.ts`, `scripts/backup.ts`, `npm run backup`).
- **Security pass**: CSV formula-injection neutralised; the API fails closed if
  `SESSION_SECRET` is unset in production (verified by a boot refusal); in-memory
  rate limit on `/api/ai/*` (30/min/user) and 8k input caps. Container
  HEALTHCHECK on `/api/health`.

## Checking it builds

- API: `cd api && npx tsc --noEmit && npm test`
- Web: `cd web && npx tsc --noEmit && npm run build`

## Conventions

Dependency-light (Node built-ins + `fetch`). German UI. Strict TypeScript. Money
in cents. The AI never auto-sends. Every personal-data write and every AI action
goes through `audit()`.
