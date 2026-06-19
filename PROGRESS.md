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

## Also done & verified (pushed)
- **Mahnwesen UI** ("Offene Posten" tab): overdue worklist + one-click Mahnung. ✅
- **AI daily digest** (`/api/ai/digest`) + KI-Cockpit "Tages-Briefing". ✅
- **Tests + CI**: 16 Node-test unit tests (totals, validator, dunning, Factur-X);
  CI runs `npm test` for api. ✅

## Also done & verified (pushed)
- **Semantic lead search** (`/api/ai/leads/search`, local embeddings + cosine,
  SQL fallback offline). Verified ranking against a mock embedder. ✅
- **Gated SMTP send** (`/api/ai/outreach/:id/send`): only status=freigegeben,
  Impressum + opt-out auto-appended, audited. 5 composition tests. ✅

## Also done & verified (pushed)
- **Mahnung PDF** (`/api/documents/:id/dunning/pdf`) — printable notice. ✅
- **XRechnung/BR-DE** validation warnings + B2G note (new `notes` field). ✅
- **UI polish**: outreach "Jetzt senden", semantic "KI-Suche", reindex. ✅
- **Full HTTP smoke test** PASSED: login → settings → create → finalize
  (RE-2026-0001) → validate (valid) → invoice PDF 31.9KB → Mahnung PDF 24.2KB →
  backup 135KB → AI status/digest degrade gracefully. ✅

## Next tier (optional, time permitting)
1. **GoBD/DATEV export** (CSV) of invoices for the Steuerberater.
2. More tests: agent/tools, semantic ranking, digest fallback.
3. **Follow-up automation**: AI suggests recontact_at + drafts from pipeline state.
4. Security/hardening pass (rate limiting on /ai/*, input caps).

## Conventions
Dependency-light (Node built-ins + fetch). German UI. Strict TS. Money in cents.
AI never auto-sends. Every personal-data write + AI action → `audit()`.
