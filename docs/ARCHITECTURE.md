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

### Unknown layouts and the layout memory

A file is read by the first of these that reads it without leftovers; a model is the last resort and never the source of a value.

1. **Known readers** — institution profiles (CSV/XLSX), OFX, and the PDF readers (Nubank grouped, signed ledger, reconciled amount/balance table, line parser).
2. **Structure readers for layouts nobody wrote a profile for** — `parsers/pdf-table.ts` reads any PDF table whose header row names its columns, in any order (date not required at the start of the line, trailing currency symbols, wrapped details, value-date lines, named sub-accounts, repeated page furniture, printed opening/closing or running balances). `inferMappingFromBalances` (CSV/XLSX) finds the columns of a table with unknown header words when one column is provably the running balance of another.
3. **Layout memory** (`import_layouts`, `parsers/layout-memory.ts`) — recipes learned from earlier imports of the same user: a column mapping per CSV/XLSX header row, or the column positions (and issuer name) of a PDF table header no keyword list recognizes. A matching file is read deterministically from the recipe.
4. **Model, once** — CSV/XLSX: `proposeTableColumns` receives the header row and up to 8 sample rows and answers with column indexes only; the mapping is rejected unless the columns really hold dates, text and amounts, and every value is then read from the file by the table engine. PDF: the full-document interpretation (below); `learnPdfTable` derives the table columns from its source-verified movements and keeps the recipe only if replaying it on the same document reads all of them again, with anything extra proven by the printed balances. Whatever worked is saved to the layout memory, so the next file of that layout needs no model.

A PDF is `sourceVerified` — and never sent to a model — when nothing was left unread and every account with movements closes on its printed opening/closing balance (or it is a running-balance table, or a learned layout read without leftovers). Recipes are per user under RLS (authenticated read-only; only the import worker writes, after job/document ownership and the original's SHA-256 were verified) and hold structure only: no amounts, account identifiers or document text other than a learned PDF layout's issuer name. A recipe is not trusted blindly: the content checks and balance reconciliation run on every file, and a recipe that stops fitting is dropped and relearned.

Sparse PDFs (at most 240 lines, 30 monetary lines, 48k compact characters) use one coherent full-file AI request; larger PDFs use bounded sections respecting page boundaries, with shared account/period anchors from later pages. Wire geometry uses `[x, width, text]` tuples; source validation retains original precision/objects. A labelled movement/balance table constrains monetary extraction to its movement cell, with provenance for corrected model magnitudes. Such corrections block reader certification.

PDF failure retention: recovered text is deterministically parsed before calling document AI. An AI timeout or empty verified result retains the recovered parse, never the pre-OCR partial parse. Generic positioned monthly account tables may recover inherited dates/amounts and dated balances only with printed intermediate and closing reconciliation; mismatches or unexplained monetary content keep the layout on the reviewable fallback path.
