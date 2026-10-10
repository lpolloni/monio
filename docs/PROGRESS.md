# Progress

_Last updated: 2026-10-10 (autonomous build session)._

## Summary
Monio runs end to end on a **local Supabase DEV stack** with fictional data:
- sign up or sign in
- import statements (CSV, OFX, XLSX, text PDF) through the real pipeline
- watch BTC and EVM wallets (mock chain provider in DEV)
- explore the consolidated picture across entities, countries, institutions and currencies
- answer Smart Inbox questions
- read evidence-backed insights

Every layer has automated tests. [TEST_RESULTS.md](TEST_RESULTS.md) lists exactly what ran and what did not.

**This is a development build, not a production-ready product.** The limitations below are real.

## What works (verified)
- **Backend:**
  - 7 migrations covering 21 tables. RLS is on every table, with composite ownership FKs, a private storage bucket, an audit log, processing functions and a hardening pass.
  - Verified with `supabase db reset` and 216 security and pipeline integration tests against the real local stack.
- **Money:** decimal-safe arithmetic and historical FX with triangulation. Original amounts are never overwritten. The display-currency switch converts at read time.
- **Import:**
  - Format detection and 8 institution profiles plus generic parsers.
  - Idempotent fingerprints, file-level dedupe, transfer matching (including cross-currency and cross-entity questions), duplicates, recurring payments and price changes.
  - Rules-first categorization with AI (mock) for leftovers. Learned rules. An import summary.
- **Smart Inbox:** one question per account pair for transfers; duplicates, subscriptions, unknown institutions, stale sources, and bounded uncategorized questions that close themselves when no longer relevant.
- **UI:**
  - Screens: Home constellation, Explore, account detail (with account settings: rename, ownership entity, net-worth toggle), Activity (list, cash flow, net worth with FX effect, recurring), Insights, Inbox, Settings, Import and Connect wallet.
  - pt, en and it; light and dark themes; desktop, tablet and mobile; PWA.
  - Axe finds no serious or critical WCAG A/AA violations on 8 pages × 3 viewports.
- **Crypto:** watch-only validation rejects private keys and seed phrases in the UI, the server and a DB constraint. Holdings and history are persisted and valued.

## Known limitations (honest list)
1. **Bank profiles were built from public layout knowledge and fictional fixtures.** They have not been validated against real exports from Nubank, Nubank PJ, XP, Santander, BBVA, N26, Revolut or MPS. Expect adjustments when real files are tried.
2. **External providers were not reachable from this sandbox.** That covers live blockchain (Esplora, EVM RPC, Blockscout), market data (Frankfurter, CoinGecko) and AI (oMLX, cloud). Their adapters are tested with injected `fetch` only; DEV uses mock providers.
3. **Scanned PDFs (images) are not OCR'd.** They produce an "unsupported layout" warning.
4. Loan instalments are counted as expenses. Principal and interest are not split.
5. A long import running in a route handler uses the user's token. If it expires mid-job, the job stays queued and `npm run worker -- jobs` reclaims it.
6. Parser warning messages may quote a short fragment of a document line (only counts are persisted in job stats; full documents are never logged).
7. `npm run worker -- purge` (orphaned documents) and `rates`/`wallets` refreshes exist but **nothing schedules them**.
8. Supabase Edge Functions are not used. Processing runs in Next.js route handlers plus the worker script.
9. Auth configuration is DEV-grade: email confirmation is off locally, there is no MFA and no rate-limit tuning.
10. There is no UI yet for manual accounts or balances (cash, property), or for renaming or deleting entities.
11. AI confidence values in mock mode are simulated and labelled as such.

## Infrastructure notes (this session)
- The Docker daemon was started manually. `public.ecr.aws`/GHCR returned 403 and Docker Hub returned 429, so Supabase images came from `mirror.gcr.io` (`SUPABASE_INTERNAL_IMAGE_REGISTRY`) and kong/mailpit/postgrest were re-tagged (automated in `scripts/dev-services.mjs`).
- The shadcn registry was blocked, so the shadcn-style components were written by hand on Radix primitives.
- Nothing touched staging or production. No production credentials exist.

## Next steps (suggested)
1. Validate each bank profile against a real (personal, never committed) export and adjust it. Add anonymized fixtures.
2. Point `AI_PROVIDER=omlx` at a LAN oMLX server and run the AI contract tests live.
3. Schedule `npm run worker -- all` (cron or Supabase scheduled function) and add alerting.
4. Add manual accounts and balances, an entity management page, and OCR for scanned PDFs.
5. Prepare STG (separate Supabase project) with migrations applied through CI. Add MFA and auth rate limits.
