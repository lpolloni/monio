# Monio — Architecture

Monio consolidates bank statements, cards, investments, loans and watch-only crypto
wallets from several countries and currencies into one picture. The core loop is
**ADD → INTERPRET → ORGANIZE → EXPLORE**.

```
Browser (Next.js client components, PWA)
   │  server actions / route handlers (no secrets, no AI keys in the browser)
   ▼
Next.js 16 server (App Router, Cache Components, Node runtime)
   ├─ src/proxy.ts ............ session refresh, locale prefix, auth redirect (UX only)
   ├─ src/server/data/** ...... Data Access Layer (session-verified, RLS-scoped reads)
   ├─ src/server/actions/** ... Server Actions (re-authorize every call)
   ├─ src/app/api/import/** ... upload + job status (processing continues in after())
   ├─ src/server/import/** .... document intake, parsers, import pipeline
   ├─ src/server/processing/**  post-import pipeline (categorize, transfers, duplicates,
   │                            recurring, Smart Inbox, insights)
   ├─ src/server/ai/** ........ provider-independent AI (mock | oMLX | cloud)
   ├─ src/server/blockchain/**  watch-only chain providers (mock | Esplora | EVM RPC | Blockscout)
   └─ src/server/market/** .... exchange rates & prices (mock | Frankfurter | CoinGecko)
   ▼
Supabase (Postgres 17 + Auth + Storage), RLS on every table
   └─ scripts/worker.ts ....... background jobs (queued imports, rates, wallet sync)
```

## Layers and boundaries

| Layer | Location | Rules |
|---|---|---|
| Domain | `src/domain/**` | Pure TypeScript, deterministic, no IO, unit-tested. Money, FX, portfolio, cash flow, net-worth history, fingerprints, duplicates, transfers, recurring, rules, insights, crypto address validation. |
| Infrastructure | `src/server/**` | Server-only IO. Talks to Supabase, storage, AI/chain/market providers. |
| Persistence | `supabase/migrations/**` | Single source of schema truth (tables, constraints, RLS, functions, storage, reference data). |
| UI | `src/app/**`, `src/components/**` | Server Components fetch via the DAL inside `<Suspense>`; Client Components receive serializable view models. No business rules in components. |

## Money and currencies

- Amounts are **signed decimal strings** everywhere (`-39.90`), arithmetic via `decimal.js`
  (`src/domain/money/decimal.ts`, 50 significant digits, banker's rounding). JS numbers are
  used only to *draw* charts and size shapes.
- Postgres stores `NUMERIC(38,18)`; reads cast to text (`amount:amount::text`), writes send
  strings (`dbNumeric()` only adapts the generated `number` type).
- Every transaction keeps its original amount/currency (and the foreign original for card
  purchases abroad). Conversions are computed at read time by `FxTable`
  (`src/domain/fx/fx-table.ts`): latest rate on/before the date, inverse and USD/EUR
  triangulation, stale-rate flags, never extrapolation. Crypto assets are priced as currencies.
- FX appreciation is never income: cash flow only counts booked transactions; the
  net-worth history also computes a *constant-rate* series so the FX effect is visible.

## Financial model

- `financial_entities` (personal | business | shared) → `accounts` (checking, savings,
  credit_card, investment, loan, mortgage, crypto_wallet, cash, other) → `transactions`.
  Institutions are a shared catalog (examples, not limits) plus user-defined rows.
- **Net worth** = assets − liabilities, personal + shared by default; business entities are
  reported separately unless the user includes them. Credit limits are informational only.
  **Available** = positive balances of checking/savings/cash.
- **Cash flow** excludes internal transfers, card bill payments, investment moves and FX
  exchanges (and any transfer-kind category), duplicates, pending rows and (by default)
  business entities. Refunds offset expenses.
- **Balances** are statement snapshots (`account_balances`) with a source and date; the UI
  shows freshness and states that imported balances are not real time.

## Import pipeline

1. `POST /api/import` — validate size/type (magic bytes), SHA-256, idempotent `documents`
   row (same file ⇒ same document), store the original in the private `documents` bucket
   under `{user_id}/…`, create an `import_jobs` row; respond `202` and continue in `after()`
   with an RLS-scoped client built from the user's access token.
2. Parse (`parseDocument`): CSV/XLSX profiles (Nubank, Nubank PJ, N26, Revolut, BBVA, MPS,
   XP, Santander Brasil) + generic multilingual parser, OFX 1.x/2.x, PDF text with a
   deterministic line parser plus known grouped layouts. Generic/unknown or incomplete text
   PDFs use full-document AI interpretation: numbered lines, pages and horizontal positions,
   with shared administrative context and overlapping bounded sections. Each proposed field
   cites its source; dates, amounts, descriptions, direction, currency, account and issuer are
   checked before merging. Totals are not transactions; deterministic movements are retained
   on conflicts. Skipped/rejected sections and balance discrepancies require review. Unknown/incomplete mixed PDFs up to 20 pages receive local OCR to fill empty text regions;
   native glyphs remain authoritative. Language data is packaged locally and images are not uploaded
   for OCR. Calendar-month headers and explicitly labeled balances ground inherited dates. Fully
   scanned PDFs remain unsupported by the automatic flow; oversized visual recovery is skipped.
3. Identify institution and accounts (hash of the full identifier + last 4 only; never the
   full number); source-verified issuers outside the catalog become private institutions with
   stable per-user keys. Normalize, fingerprint (`computeFingerprints`, FITID when present), insert
   with `ON CONFLICT (account_id, fingerprint) DO NOTHING` ⇒ re-imports are idempotent.
4. Categorize: user rules → system rules → AI for leftovers (applied only above a confidence
   threshold; high-confidence answers become user rules so the pattern is not asked again).
5. Post-process (`postProcessUser`): transfer matching (one-to-one, exact or FX-tolerant;
   personal↔business and uncertain pairs become one Smart Inbox question per account pair,
   remembered), possible duplicates, recurring series and subscription price changes,
   uncategorized/stale-source questions, deterministic insights with evidence. It re-runs after
   Smart Inbox answers and account-ownership changes, so it is bounded: at most 8 open
   uncategorized questions, none for transactions still awaiting a transfer decision, and
   questions that no longer apply are closed automatically (`resolution.decision = "auto"`).
6. Job stats drive the "Import completed — N transactions organized…" summary.

## AI

`src/server/ai` exposes `createAiService(config)` with `interpretTransactions` and
`proposeStatementRows` and `interpretDocument`. Modes: `mock` (deterministic fixtures, default in DEV), `omlx`
(OpenAI-compatible local server, private-network hosts only), `cloud` (OpenAI / OpenRouter /
generic / Anthropic adapter). Every response is validated with strict zod schemas; the model
never sees instructions from documents as instructions (data is delimited and sanitized),
cannot add amounts, and failures are typed results (the app keeps working on rules).
Cloud use requires `AI_ALLOW_CLOUD_DOCUMENTS=true` **and** per-user consent; there is no
automatic fallback. Confidence values are simulated in mock mode and labelled as such.
Full-document interpretation uses `AI_DOCUMENT_TIMEOUT_MS` (default 120 seconds per section),
a four-minute total budget and at most 64 sections. Unprocessed lines are reported, never
silently dropped. oMLX document requests use JSON schema and disable long reasoning; monetary
strings copied in source formatting are parsed to canonical decimal strings and checked
against the source. The mock reports unresolved lines rather than simulating document comprehension.

## Crypto (watch-only)

`detectWatchTarget` validates Bitcoin addresses (P2PKH/P2SH/bech32/bech32m), xpub/ypub/zpub
(and descriptors) and EVM addresses (EIP-55), and **rejects** private keys (WIF, xprv, raw
hex) and recovery phrases before anything is stored. Providers only perform read calls.
Holdings are snapshotted per day (`wallet_holdings`), on-chain transfers stored idempotently,
values derived from market prices; profit/loss is not computed without cost basis.

## Security

- RLS on all 21 tables; user-owned tables use `user_id = auth.uid()` policies; children
  reference parents through composite FKs `(id, user_id)`, so cross-user references fail even
  with the service role. Reference data is read-only for users.
- Private storage bucket with per-user folder policies and a MIME allow-list.
- Service role only in `scripts/` (seed, worker) and reference-data upserts; always filtered
  by `user_id`. The browser only ever holds the publishable key and the user's session.
- Hardening migration (`…0700_security_hardening.sql`): ownership triggers for categories,
  institutions and inbox transaction ids; invoker-scoped `record_rule_hits`; a constraint that
  rejects private-key material in watched identifiers; storage paths pinned to the owner's
  folder; bounded `log_user_action`; TRUNCATE/TRIGGER/REFERENCES revoked from API roles.
- Retention: `npm run worker -- purge` removes stored documents whose rows were deleted
  (`src/server/maintenance/purge.ts`); it is not scheduled automatically yet.
- Audit log (append-only for users) for category/classification changes, deletions, consent
  changes and inbox decisions. `delete_my_financial_data()` + storage cleanup for erasure.
- Security headers, static-only service worker, `X-Frame-Options: DENY`.

## Rendering (Next.js 16)

Cache Components is enabled: pages render a static shell (navigation, headings,
translations from the `[locale]` root param) and stream user data inside `<Suspense>`.
`getSession()` calls `connection()` and `getClaims()` (JWT verified) once per request
(`react.cache`). Mutations are Server Actions that re-check the session and call
`refresh()`.

## Environments

DEV (local Supabase via Docker, fictional data, mock providers) · STG/PROD (future,
independent Supabase — possibly self-hosted). All configuration is external
(`.env.example`); `NEXT_PUBLIC_*` values are embedded at build time, so build per
environment and run migrations explicitly (`supabase db push`/`migration up`) — changing
env vars never migrates a database.

### Persistent PDF learning

Real document AI is the interpretation path for a previously unconfirmed PDF layout. `pdf-learning.ts` certifies a bounded existing reader only after two distinct source files agree with complete validated AI interpretations. The signature binds reader version, issuer and column geometry. `pdf_reader_evidence` is private per user with authenticated read-only RLS; only the worker writes confirmations. Inline processing retains session RLS for financial writes and uses a scoped privileged learning writer only after validating job ownership, document ownership and original SHA-256. Evidence contains hashes, never PDF text, account identifiers, monetary values or generated code. Reuse re-reads the new file and requires complete account metadata, period bounds, opening/closing reconciliation and no unexplained monetary lines. Drift or failed agreement returns to AI; partial responses cannot train. Missing learning infrastructure also falls back to AI. Unsupported recipe families retain full-document AI rather than unsafe automatic promotion.

Sparse PDFs (at most 240 lines, 30 monetary lines, 48k compact characters) use one coherent full-file AI request; larger PDFs use bounded sections respecting page boundaries, with shared account/period anchors from later pages. Wire geometry uses `[x, width, text]` tuples; source validation retains original precision/objects. A labelled movement/balance table constrains monetary extraction to its movement cell, with provenance for corrected model magnitudes. Such corrections block reader certification.
