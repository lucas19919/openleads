# OpenLeads

A small, **self-hostable suite for local web-agency / freelancer sales** — from
finding a prospect to sending a compliant invoice. Three modules behind one
login:

- **Leads** — an AI scraper finds local businesses with *outdated* websites,
  scores how outdated they are, and drops them into a CRM pipeline (kanban +
  table, stages, notes, callback dates, `.xlsx` import). Dedupes by domain.
- **Rechnungen** — build **Angebote** and **Rechnungen** with line items and
  download a print-ready PDF. A finalised invoice is a **ZUGFeRD / Factur-X
  e-invoice** (PDF/A-3 with embedded EN 16931 XML), Kleinunternehmer **§19 UStG**
  aware, with gapless sequential numbering.
- **Scraper** — a control panel for the search raster (trades × towns), the
  staleness threshold, and run limits, plus a status readout.

> The UI is **German** and the invoicing targets **German** tax rules
> (§19 UStG, ZUGFeRD). It's built for the DACH market.

## Why it exists

Most small agencies pay for a CRM *and* an invoicing SaaS. OpenLeads is one
self-hosted tool you own outright, with the lead → invoice flow joined up. It is
intentionally dependency-light: it runs on Node's built-in SQLite (no native
build step), a tiny Hono API, a Vite/React app, and pure-JS PDF generation.

## Stack

| Part      | Tech                                                              |
|-----------|------------------------------------------------------------------|
| `api/`    | [Hono](https://hono.dev) + Node built-in SQLite (`node:sqlite`)  |
| `web/`    | React 19 + Vite (vanilla CSS)                                     |
| `scraper/`| Node + `@anthropic-ai/sdk` (Claude web search)                   |
| PDF       | `pdfkit` → PDF/A-3 + Factur-X (no native deps)                    |
| Auth      | scrypt password hash + HMAC signed-cookie sessions (no deps)     |

## Quick start (development)

Requires **Node 22.5+** (for `node:sqlite`); Node 24 recommended.

```bash
# 1) API  (http://127.0.0.1:8787)
cd api
npm install
cp .env.example .env          # set SESSION_SECRET + SERVICE_TOKEN
npm run seed -- <user> <pw>   # create the login
npm run dev

# 2) Web  (http://127.0.0.1:5180, proxies /api to the API)
cd ../web
npm install
npm run dev

# 3) Scraper (optional, needs ANTHROPIC_API_KEY)
cd ../scraper
npm install
cp .env.example .env          # set CRM_API_URL, CRM_SERVICE_TOKEN, ANTHROPIC_API_KEY
npm run dry-run               # offline fixtures (no Claude / network)
npm start                     # live run
```

`node:sqlite` prints an `ExperimentalWarning` on boot — that's expected.

## Configuration

| Variable          | Where       | Purpose                                          |
|-------------------|-------------|--------------------------------------------------|
| `SESSION_SECRET`  | api         | signs session cookies (long random string)       |
| `SERVICE_TOKEN`   | api+scraper | bearer token the scraper uses to post leads      |
| `ANTHROPIC_API_KEY` | scraper   | Claude API key for discovery / scoring           |
| `DB_PATH`         | api         | SQLite file location (default `./data/leads.db`) |
| `WEB_ORIGIN`      | api         | CORS origin in dev                               |

The scraper's search raster, staleness threshold and run limits are edited in
the **Scraper** tab and stored in the DB; the scraper reads them at the start of
each live run (CLI flags > saved config > built-in defaults).

## Deployment

One Docker image holds the built web app, the API that serves it, and the
scraper. See [deploy/DEPLOY.md](deploy/DEPLOY.md) for an nginx + Docker Compose
walkthrough. The SQLite DB lives in a named volume so it survives image updates.

## e-Invoices (ZUGFeRD / Factur-X)

A finalised Rechnung embeds the structured **EN 16931** Cross Industry Invoice
XML (`factur-x.xml`) into a **PDF/A-3**, so tools like lexoffice / sevDesk /
DATEV read the line items and totals automatically. Kleinunternehmer invoices
use tax category `E` (§19); others category `S` at the configured rate.

> ⚠️ Validate output with the official ZUGFeRD validator / Mustang / veraPDF
> before relying on it for tax purposes. The targeted profile is EN 16931.

## License

[MIT](LICENSE) — © 2026 Lucas Reimers.

## Disclaimer

OpenLeads is provided as-is. It is **not** tax or legal advice; verify invoice
output and your bookkeeping obligations with your Steuerberater. When scraping,
respect the law and target websites' terms.
