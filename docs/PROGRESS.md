# Progress

Persistent PDF reader learning (2026-10-10): real-AI imports now interpret unseen/unconfirmed layouts even when a native reader recognizes them. Worker-only, user-scoped `pdf_reader_evidence` stores structural/version hashes and distinct original-file hashes; no text, financial values, model code or account identifiers. Two independently source-validated, fully covered interpretations must agree with the bounded native reader on identity, type, currency, period, balances and every movement, with opening/closing reconciliation. Subsequent matching uploads re-extract current values and repeat integrity/content checks before skipping document AI. New monetary content, conflicts and incomplete interpretation prevent promotion or invalidate matching evidence; database-learning failures fall back to AI. Column geometry/issuer/reader changes produce a different signature. Known complete native layouts avoid unnecessary OCR during training. Uppercase Portuguese date connectors are now accepted by AI source validation.

Scope: this certifies existing Nubank grouped and generic amount/balance table readers; it does not generate a new arbitrary parser from model output. Unknown layouts without a safe reader remain on document AI. Automated compilation of additional declarative layout recipes and user-confirmed learning for documents without opening/closing reconciliation remain TODO. Originals and previous imports are unchanged.

Migration 008 was applied individually to the configured LAN DEV database (existing migration history is still unreconciled). SQL checks with rolled-back fictional users verified tenant isolation, authenticated insert/delete denial and anonymous read denial. Added repeatable integration coverage for distinct originals, ownership, permissions and invalidation; the localhost-only integration suite was not run against LAN. Unit verification: 701 tests / 41 files; typecheck, ESLint and production build passed.

XP digital-account PDF correction (2026-10-10): verified a real locally supplied export with four reverse-ordered movements, an explicit `De: … Até: …` period and a final available balance. The generic parser previously inferred debit conventions from the last value (running balance), rejected unsigned credits and missed the colon-delimited period/closing label. Amount-column sign conventions, checking/digital account headers, source account identity, time prefixes and available-final-balance labels are now handled. Fully verified amount/balance tables use `pdf-column-statement`, avoiding unnecessary document AI while ambiguous/unknown layouts retain AI fallback. Fictional regression tests cover the layout and ensure a negative running balance cannot establish movement direction.

Targeted DEV repair: matched the local PDF SHA-256 and existing account identity, verified all three existing movements against source date/amount/currency, aligned only their dedup fingerprints, then ran a user-scoped reprocessing worker. Preserved original IDs/descriptions/raw data and financial values; inserted only the missing movement, skipped three duplicates, created no accounts. Verified four persisted transactions, period 2026-07-12 through 2026-10-10, one closing balance 3.79 BRL dated 2026-10-10, document `processed` and no open document review items. Resolved the obsolete incomplete-document question after successful verification. Personal sources and the temporary repair worker were not committed.

Santander completion verification (2026-10-10): observed the authenticated live import from `identifying` through `categorizing` to `needs_review` / 100%, finished at 15:31:41 UTC after ~4m25s. Persisted stats: Santander Brasil, one account, three organized transactions, zero duplicates, 28 warnings and one open review item. OCR completed in ~4.5s; document AI consumed its four-minute budget. Added section-level AI logs and awaited progress callbacks updating the job from 25% toward 34% between sections, so multi-section work is visible. Typecheck, ESLint and all 693 tests / 40 files passed, including callback ordering. No manual repair/re-import of this successful job was performed.

Santander stalled-import fix (2026-10-10): Next/Turbopack turned `require.resolve()` for the external OCR language into a module identifier, causing ENOENT before AI and a pending Tesseract initialization. Use the language package's runtime `langPath`, preflight its file, reject worker errors and bound initialization to 20 seconds. Verified OCR initialization inside a real Next dev route (temporary probe removed). UI polling now covers the ten-minute processing window and exits with an explicit wait-expired message. Released only the affected stuck job at `identifying` as failed so re-upload can retry; no transactions were deleted or changed.

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
- **Santander consolidated PDF correction (2026-10-10):** inspected a real five-page export locally. Native extraction omitted outlined headings and yielded one of three account movements. Unknown/incomplete text PDFs now receive bounded local visual text recovery (up to 20 pages), using packaged Portuguese OCR data; native glyphs and money remain authoritative. Calendar-month periods, inherited movement dates, reference-column dashes, account-column identity and explicit dated balance references are validated. Replaying real local oMLX proposals through the full PDF parser recovered the three checking movements, one stable Santander account and both reconciled balances. Some proposals remain rejected/reviewable; model output is not universally reliable. Personal source files and temporary diagnostics were not committed, and existing database imports were not changed. ESLint, typecheck, 690 unit tests and production build passed; DB integration/E2E were not rerun.

- **Full-document PDF AI fallback (2026-10-10):** known layouts run first; generic/unknown or incomplete PDFs now send all extracted text, page numbers and horizontal text positions to the configured real AI in bounded sections with shared header/footer and overlapping context. Strict schemas plus source references validate issuer, account, currency, period, balances and movements; formatted money is normalized to decimal strings, never floats. Deterministic movements survive failures/conflicts, and unresolved, rejected or skipped sections produce review items. Verified unknown issuers become private, RLS-scoped institutions with stable keys across months. No cloud fallback or consent bypass; mock does not pretend to interpret documents. oMLX document requests use JSON schema and disable long reasoning, with a separate 120-second section timeout (`AI_DOCUMENT_TIMEOUT_MS`) and a four-minute document budget / 64-section cap; anything unprocessed is reported. Live local oMLX + the actual PDF parsing entry point successfully interpreted a fictional unknown-bank PDF in ~21 seconds with no validation warnings. Fully scanned PDFs remain unsupported by the automatic import flow; mixed text/outlined statements now have bounded local recovery. Existing imports were not changed.
- **Nubank account PDF correction (2026-10-10):** verified locally against the user's September and October PDFs, without committing personal documents or modifying stored imports. The previous generic parser returned zero transactions and picked recipient bank names / issuer CNPJ as institution evidence. A dedicated grouped-layout parser now reads daily dates and directions, wrapped movements across pages, balances, and a stable branch/account identity; holder CPF/CNPJ determines personal versus business. Both PDFs resolve to Nubank with the same account identity, extract 31 and 4 movements respectively, and reconcile all daily totals and opening/closing balances with zero warnings. ESLint, typecheck and all 664 unit tests pass. Added a local-only integration regression for concurrent monthly imports sharing one persisted account; not executed here because the available Supabase is on the LAN and the suite requires localhost. Existing incorrect imports remain unchanged.
- **Backend:**
  - 7 migrations covering 21 tables. RLS is on every table, with composite ownership FKs, a private storage bucket, an audit log, processing functions and a hardening pass.
  - Verified with `supabase db reset` and 230 integration tests (215 security, 15 pipeline and smoke) against the real local stack.
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
Signup diagnosis (2026-10-10): corrected LAN API has signup enabled and `mailer_autoconfirm=false`. A fictional DEV signup reproduced HTTP 500 `unexpected_failure`, "Error sending confirmation email". Server SMTP/configuration must be fixed, or DEV email autoconfirm enabled on the server. The form now distinguishes confirmation-email failures, signup failures, and successful signup awaiting confirmation. Remote SSH access is unavailable; server configuration remains unchanged.

API endpoint fix (2026-10-10): `.env` now uses `http://192.168.68.150:8000` instead of `:54321`, after repeat read-only checks confirmed only `:8000` recognizes `profiles`. Restart Next.js and authenticate against this endpoint to verify signup end to end. Anonymous SELECT denial on `:8000` is expected for private profiles; authenticated access remains to be verified.

Diagnostic on 2026-10-10: the configured LAN Supabase responds to Auth health checks, but an anonymous, read-only `profiles` query returns HTTP 404 / `PGRST205` (table absent from the schema cache). Signup cannot enter the app until that instance exposes the migrated schema. No remote schema or user records were changed. Profile loading now distinguishes database failures from a missing profile; WebCrypto warnings are separate from this database error.

Direct migration verification was attempted with read-only SQL: the database endpoint requires `sslmode=disable`, then rejects the configured credentials (`28P01`, including a check with the direct `postgres` username). Migration history and trigger presence remain unverified until DEV database credentials are corrected.

Follow-up: the supplied password works with Supavisor at port `5432`, username `postgres.your-tenant-id`, and `sslmode=disable`; `.env` database URL was corrected. This database has `public.profiles` and `on_auth_user_created`, but no `supabase_migrations.schema_migrations` history. API port `54321` still returns `PGRST205`, whereas port `8000` recognizes `profiles` and denies anonymous SELECT (`42501`). The app API endpoint still needs reconciliation with the intended installation; do not blindly reapply migrations over the existing schema.

1. **Most bank profiles were built from public layout knowledge and fictional fixtures.** Nubank personal-account PDF parsing has now been checked against two real monthly exports locally; other Nubank layouts, Nubank PJ, XP, Santander, BBVA, N26, Revolut and MPS still need real-export validation. Personal documents are never committed.
2. **External providers were not reachable from this sandbox.** That covers live blockchain (Esplora, EVM RPC, Blockscout), market data (Frankfurter, CoinGecko) and AI (oMLX, cloud). Their adapters are tested with injected `fetch` only; DEV uses mock providers.
3. **Fully scanned PDFs (images) remain unsupported by automatic import.** They produce an "unsupported layout" warning.
4. Loan instalments are counted as expenses. Principal and interest are not split.
5. A long import running in a route handler uses the user's token. If it expires mid-job, the job stays queued and `npm run worker -- jobs` reclaims it.
6. Parser warning messages may quote a short fragment of a document line (only counts are persisted in job stats; full documents are never logged).
7. `npm run worker -- purge` (orphaned documents) and `rates`/`wallets` refreshes exist but **nothing schedules them**.
8. Supabase Edge Functions are not used. Processing runs in Next.js route handlers plus the worker script.
9. Auth configuration is DEV-grade: email confirmation is off locally, there is no MFA and no rate-limit tuning.
10. There is no UI yet for manual accounts or balances (cash, property), or for renaming or deleting entities.
11. AI confidence values in mock mode are simulated and labelled as such.

## Delivery status
- All work is on the branch `claude/exciting-einstein-olrd0c` (pushed).
- **The pull request to `main` could not be opened:** the GitHub repository has no `main` branch (this branch became the default when it was first pushed). Creating or pushing to `main` was out of bounds for this session. To open the PR, create `main` from the first commit and open the PR from this branch:
  ```bash
  git push origin 2781469:refs/heads/main   # main = initial scaffold commit
  # then open a PR: base main ← head claude/exciting-einstein-olrd0c
  ```
- The repository is **public**. No secrets are committed (`.env.local` is ignored; `.env.example` holds placeholders only).

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
