# Build progress — autonomous AI-core session

Working log so the build can resume cleanly across turns. Target: the ultimate
AI-native German leads + Rechnungen tool. Branch: `claude/openleads-repo-setup-zphxio`.

## Done & verified (pushed)
- **AI core** (`api/src/ai/*`): OpenAI-compatible provider (open-source/local
  first), copilot agent loop, domain tools, lead intelligence (analyze/outreach),
  NL→invoice. Agent loop tested against a mock model (tool call → DB → answer). ✅
- **DSGVO toolkit** (`api/src/dsgvo.ts`, `audit.ts`): audit log, export, erasure
  (with §147 AO retention), consent ledger, Art. 30 record. ✅
- **EN 16931 validator** (`api/src/validate.ts`) + endpoint; unit-verified. ✅
- **Backups** (`api/src/backup.ts`, `scripts/backup.ts`, `npm run backup`). ✅
- **Web**: KI-Cockpit chat, AI status badge, per-lead AI panel (qualify/outreach/
  DSGVO), validate/backup client. tsc + build clean. ✅
- Docs: ROADMAP, docs/AI.md, docs/COMPLIANCE.md, README repositioned. ✅

## Verification commands
- API: `cd api && npx tsc --noEmit`
- Web: `cd web && npx tsc --noEmit && npm run build`

## Also done & verified (pushed)
- **Document editor UI**: EN 16931 validator panel, NL→invoice box, Settings
  backup download. ✅
- **Dunning (Mahnwesen)**: overdue detection, Mahnstufen, §288 BGB Verzugszinsen
  + €40 Pauschale; endpoints + table + client. Interest math unit-verified. ✅

## Next queue (in priority order)
1. **Mahnwesen UI**: an "Offene Posten" view listing overdue invoices with
   one-click Mahnung (uses api.overdueInvoices/previewDunning/raiseDunning).
2. **AI daily digest** endpoint: prioritised next actions from pipeline +
   recontact dates + overdue invoices (`/api/ai/digest`).
3. **Semantic lead search**: local embeddings (OpenAI-compatible /embeddings).
4. **SMTP send** for approved outreach (gated, opt-out tracked, audited).
5. **XRechnung** profile for B2G + Schematron-style deeper validation.
6. Tests (vitest) for validate/facturx/dunning/agent; CI step to run them.

## Conventions
Dependency-light (Node built-ins + fetch). German UI. Strict TS. Money in cents.
AI never auto-sends. Every personal-data write + AI action → `audit()`.
