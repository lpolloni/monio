# Tasks

Cloudflare tunnel auth follow-up (2026-10-10): public login URL https://moniodev.lucaspolloni.com/pt/login responds HTTP 200, private/no-store and Cloudflare DYNAMIC. Replaced ineffective 0.0.0.0 dev-origin entry with the exact public hostname and added that exact host to experimental.serverActions.allowedOrigins, per bundled Next.js reverse-proxy guidance. This permits actions when tunnel Host differs from browser Origin without a wildcard exception. Supabase remains private. Production build/TypeScript passed; remote authentication is not yet verified and requires deploying/restarting the other server with this configuration. No credentials or accounts were submitted.

Private Supabase authentication (2026-10-10): login/signup now use a validated Next.js Server Action and the session-bound publishable-key client; the browser Supabase client/config were removed. Actions return only safe status/error codes, never sessions/tokens. Session cookies use HttpOnly, SameSite=Lax, path=/ and Secure for HTTPS requests indicated by tunnel forwarding/origin headers; proxy refreshes use the same policy. Logout uses the cookie client directly (also works without a profile) and clears the local session. Proxy responses/redirects request private/no-store caching. Next.js same-origin Server Action CSRF checks remain enabled, with no broad allowedOrigins exception. The existing private Supabase endpoint and .env are unchanged; RLS/service-role restrictions are preserved. ESLint, typecheck, production build and all 718 unit tests / 45 files passed. Public Cloudflare tunnel E2E and DB integration were not run; SMTP/email confirmation remains an independent deployment configuration.

PWA completion (2026-10-10): added a persistent browser-install prompt listener and an installation section in Settings, with pt/en/it instructions for Safari/manual installation, installed state and secure-context guidance. Manifest has a stable app ID; existing standalone display and regular/maskable/Apple icons are preserved. Production-only service worker now precaches a generic localized offline screen, keeps navigations network-only and never stores financial pages/API responses. Cache cleanup only removes obsolete Monio caches. Offline static HTML bypasses locale/auth proxy. DEVELOPMENT documents HTTPS/localhost and production-build verification. ESLint, TypeScript in production build, production build and three service-worker privacy/offline regression tests passed. Actual device installation/browser E2E were not run.

Santander automatic-fallback regression fixed (2026-10-10): the user deleted/reimported the source; a NEW document/job again persisted one movement and no balances. Previous targeted repairs did not protect the automatic failure path. `parsePdf` discarded visual recovery whenever AI threw or returned no verified accounts, returning the pre-OCR partial parse. It now parses recovered lines BEFORE the model call and retains that result on both failure paths.

Added a generic positioned account-table reader, using labelled movement/balance columns, account-header geometry, explicit monthly period, dated opening/closing rows and inherited movement dates. It accepts a table only after every printed running balance and the closing balance reconcile; it does not insert date/time continuations or reference-column dashes. Unresolved monetary lines and inconsistent balances refuse this reader. Column labels include movement terminology; no Santander-specific institution/layout branch was added. Reader version bumped to invalidate earlier certification hashes. Full-document AI remains enabled for unconfirmed layouts, but its failure no longer loses source-verified rows or balances.

Verified the actual original both through the PDF parser with injected AI failure and through the full DEV persistence pipeline using a deliberately 1ms REAL HTTP AI deadline. After SHA/identity/source checks, preserved the existing movement ID and account, inserted two missing credits and skipped one existing debit. Persisted three movements, opening 134.50 and closing 2216.02 BRL, exact reconciliation. The current document remains `needs_review` with one AI-failure warning, rather than missing financial data. No unrelated imports were changed; temporary diagnostics and personal sources were removed from the working tree. Typecheck, ESLint and 709 unit tests / 42 files passed; DB integration/E2E were not rerun.

Santander repeat-import correction (2026-10-10): inspected the latest DEV import: one movement, no balance snapshots, 104 warnings, no learned-reader evidence and oMLX enabled. The incomplete interpretation left the UI with a zero balance. AI requests now compact horizontal geometry into coordinate tuples while retaining exact source objects for validation, keep page boundaries in large-document sections, and carry later-page account/period anchors. Sparse statements bounded by 240 lines, 30 monetary lines and 48k compact characters are interpreted as one whole file, avoiding repeated context discovery and section starvation. All lines retain primary coverage. A live oMLX call read the real five-page PDF in one request (~97s), with no skipped sections.

The real response exposed a second issue: it proposed a running balance (32.02) as the remuneration movement (0.02). Validation now reads an unambiguous source-labelled movement column independently of the proposed magnitude, preserves correction provenance and rejects rows without a movement cell. Corrected model amounts cannot certify a learned reader. Fictional regressions cover source-column authority, missing movement cells, full-file coverage, later-page anchors and preserved geometry.

Targeted DEV repair verified the original SHA-256, re-extracted all 138 lines (exact text match), verified account identity and the existing movement, aligned its dedup fingerprint only if necessary, and reprocessed with the captured real interpretation. Verified three movements (-102.50, +0.02, +2184.00 BRL), opening 134.50 and closing 2216.02, exact reconciliation, same account and original transaction ID; inserted two, skipped one. One document review item remains for discarded continuation/FX-quotation lines (three warnings). No unrelated imports were changed. Temporary scripts/personal source data were not committed. Typecheck, ESLint and 704 unit tests passed; DB integration/E2E were not rerun.

Persistent PDF reader learning (2026-10-10): real-AI imports now interpret unseen/unconfirmed layouts even when a native reader recognizes them. Worker-only, user-scoped `pdf_reader_evidence` stores structural/version hashes and distinct original-file hashes; no text, financial values, model code or account identifiers. Two independently source-validated, fully covered interpretations must agree with the bounded native reader on identity, type, currency, period, balances and every movement, with opening/closing reconciliation. Subsequent matching uploads re-extract current values and repeat integrity/content checks before skipping document AI. New monetary content, conflicts and incomplete interpretation prevent promotion or invalidate matching evidence; database-learning failures fall back to AI. Column geometry/issuer/reader changes produce a different signature. Known complete native layouts avoid unnecessary OCR during training. Uppercase Portuguese date connectors are now accepted by AI source validation.

Scope: this certifies existing Nubank grouped and generic amount/balance table readers; it does not generate a new arbitrary parser from model output. Unknown layouts without a safe reader remain on document AI. Automated compilation of additional declarative layout recipes and user-confirmed learning for documents without opening/closing reconciliation remain TODO. Originals and previous imports are unchanged.

Migration 008 was applied individually to the configured LAN DEV database (existing migration history is still unreconciled). SQL checks with rolled-back fictional users verified tenant isolation, authenticated insert/delete denial and anonymous read denial. Added repeatable integration coverage for distinct originals, ownership, permissions and invalidation; the localhost-only integration suite was not run against LAN. Unit verification: 701 tests / 41 files; typecheck, ESLint and production build passed.

XP digital-account PDF correction (2026-10-10): verified a real locally supplied export with four reverse-ordered movements, an explicit `De: … Até: …` period and a final available balance. The generic parser previously inferred debit conventions from the last value (running balance), rejected unsigned credits and missed the colon-delimited period/closing label. Amount-column sign conventions, checking/digital account headers, source account identity, time prefixes and available-final-balance labels are now handled. Fully verified amount/balance tables use `pdf-column-statement`, avoiding unnecessary document AI while ambiguous/unknown layouts retain AI fallback. Fictional regression tests cover the layout and ensure a negative running balance cannot establish movement direction.

Targeted DEV repair: matched the local PDF SHA-256 and existing account identity, verified all three existing movements against source date/amount/currency, aligned only their dedup fingerprints, then ran a user-scoped reprocessing worker. Preserved original IDs/descriptions/raw data and financial values; inserted only the missing movement, skipped three duplicates, created no accounts. Verified four persisted transactions, period 2026-07-12 through 2026-10-10, one closing balance 3.79 BRL dated 2026-10-10, document `processed` and no open document review items. Resolved the obsolete incomplete-document question after successful verification. Personal sources and the temporary repair worker were not committed.

Santander completion verification (2026-10-10): observed the authenticated live import from `identifying` through `categorizing` to `needs_review` / 100%, finished at 15:31:41 UTC after ~4m25s. Persisted stats: Santander Brasil, one account, three organized transactions, zero duplicates, 28 warnings and one open review item. OCR completed in ~4.5s; document AI consumed its four-minute budget. Added section-level AI logs and awaited progress callbacks updating the job from 25% toward 34% between sections, so multi-section work is visible. Typecheck, ESLint and all 693 tests / 40 files passed, including callback ordering. No manual repair/re-import of this successful job was performed.

Santander stalled-import fix (2026-10-10): Next/Turbopack turned `require.resolve()` for the external OCR language into a module identifier, causing ENOENT before AI and a pending Tesseract initialization. Use the language package's runtime `langPath`, preflight its file, reject worker errors and bound initialization to 20 seconds. Verified OCR initialization inside a real Next dev route (temporary probe removed). UI polling now covers the ten-minute processing window and exits with an explicit wait-expired message. Released only the affected stuck job at `identifying` as failed so re-upload can retry; no transactions were deleted or changed.

Status legend: **DONE** means implemented and covered by the tests listed in [TEST_RESULTS.md](TEST_RESULTS.md). **IN_PROGRESS** means partly built. **TODO** means not started. **BLOCKED** means it cannot be done in this environment; the reason is given.

## Phase 0 — Environment & architecture
Signup follow-up (2026-10-10): fix LAN Auth SMTP or enable DEV `ENABLE_EMAIL_AUTOCONFIRM=true` and recreate Auth. Actual signup returns HTTP 500 "Error sending confirmation email"; UI messages and pending-confirmation handling corrected. Full signup verification awaits server configuration repair.

API endpoint reconciliation (2026-10-10): corrected `.env` Supabase API port to `8000`; verified the endpoint recognizes `profiles`. Pending: restart the app and verify signup/signin using a session issued by the corrected endpoint.

Follow-up (2026-10-10): verify/apply the seven migrations on the configured LAN DEV Supabase and refresh its PostgREST schema cache (`profiles` currently returns `PGRST205`). Then check the signup bootstrap trigger and any users created before migrations. Diagnosis and clearer profile lookup errors are implemented; remote database repair remains pending.

Direct verification is blocked by database authentication (`28P01`); correct the DEV database connection credentials and use `sslmode=disable` for this endpoint before checking migration history. No database changes were made.

Resolved connection follow-up: DEV Supavisor works on port `5432` with `postgres.your-tenant-id`; `.env` database URL corrected. `profiles` and signup trigger exist there; CLI migration history does not. Reconcile app API port `54321` (missing table) with port `8000` (table recognized) and inspect schema compatibility before applying migrations.

| Task | Status | Notes |
|---|---|---|
| Next.js 16 scaffold (App Router, Cache Components, Turbopack, TS strict) | DONE | |
| Supabase DEV stack via CLI + Docker (`dev:services`, mirror registry fallback) | DONE | ECR/GHCR blocked here, so images come from `mirror.gcr.io` |
| `.env.local` generated from the running stack; `.env.example` documented | DONE | `.env.local` is git-ignored |
| Migrations: schema, RLS, storage bucket, reference data, processing functions, hardening | DONE | 7 migrations; verified by `supabase db reset` |
| Deterministic fictional seed (`dev:seed`) with an isolation user | DONE | Refuses non-local URLs and `APP_ENV=production` |
| Generated DB types (`db:types`) | DONE | |
| Vitest unit + integration configs; Playwright config with 3 viewports | DONE | |

## Phase 1 — Design & foundation
| Task | Status | Notes |
|---|---|---|
| OKLCH design tokens, light/dark, WCAG AA text contrast | DONE | Contrast checked by axe in E2E |
| Typography (Geist + Instrument Serif), motion system (Motion, reduced-motion aware) | DONE | |
| App shell: floating top nav (desktop), bottom tab bar (mobile), ADD action, user/settings menu | DONE | |
| Home wealth constellation + summary panel; mobile bottom sheet | DONE | |
| i18n pt (default) / en / it with type-checked message catalogs | DONE | Locale is a root route param |
| PWA: manifest, icons, static-only service worker, security headers | DONE | The service worker never caches financial data |

## Phase 2 — Accounts & transactions
| Task | Status | Notes |
|---|---|---|
| Entities (personal/business/shared), institutions, accounts, balances, transactions model | DONE | Composite FKs `(id, user_id)` |
| Portfolio domain: assets vs liabilities, liquidity, credit limits not counted as assets, business separation | DONE | Unit-tested |
| Multicurrency FX table (historical, inverse, triangulation), display-currency switch | DONE | Originals never overwritten |
| Explore (entity/type filters, institutions, accounts) + account detail with balance history | DONE | |
| Activity: search, filters, transaction provenance, category correction (+ remember as rule) | DONE | |
| Account settings: rename, change ownership entity, create a business/shared entity, include/exclude from net worth | DONE | Account detail → "Account settings"; E2E-covered |
| Manual accounts and balances (e.g. cash, property) without a document | TODO | Accounts come from imports, wallets and the seed only |
| Entity management page (rename/delete entities) | TODO | Entities can be created from account settings only |

## Phase 3 — Document import
2026-10-10 Santander follow-up: DONE — bounded local OCR supplements missing outlined headers in mixed PDFs; source validation handles month/year periods, inherited dates, reference-column placeholders, stable account columns and explicit dated balances. Real export/parser replay recovered all three checking movements and reconciled balances. Existing imports require explicit reprocessing; DB integration/E2E not rerun. Fully scanned import remains TODO.

2026-10-10: full-document AI interpretation for generic/unknown and incomplete text PDFs is implemented. It preserves positioned source context, validates every financial proposal, reuses private unknown issuers, preserves deterministic results and flags incomplete work for review. A real oMLX test through the PDF parser passed on a fictional unknown layout. Database integration regressions were added but remain unexecuted here (the suite requires localhost; the available stack is on the LAN). Existing imports still require explicit reprocessing.

| Task | Status | Notes |
|---|---|---|
| Format detection + parsers: CSV, OFX, XLSX, PDF (text layer) | DONE | |
| Full-document AI fallback for unknown/incomplete text PDFs | DONE | Source-verified metadata/movements; bounded overlapping sections; fail-safe deterministic merge; live fictional oMLX test passed. Mixed text/outlined PDFs have bounded local recovery; fully scanned import remains separate. |
| Institution profiles: Nubank, Nubank PJ, XP, Santander, BBVA, N26, Revolut, MPS + generic | IN_PROGRESS | Nubank personal-account grouped PDF layout corrected and checked locally against two real monthly exports (31 + 4 movements, balanced, same account identity); fictional regression tests added. Other layouts still need real-export validation. |
| Intake: hashing, file-level dedupe, private storage under the owner's folder, size/MIME limits | DONE | |
| Pipeline: accounts, idempotent transactions (fingerprints), balances, job status, summary | DONE | |
| Duplicate detection, transfer matching (one-to-one, cross-currency with wording), cross-entity questions | DONE | |
| Recurring + subscriptions + price-change detection | DONE | |
| Import UI: drag & drop, multi-file queue, progress, summary | DONE | |
| Scanned (image-only) PDF OCR | TODO | Only an "unsupported layout" warning today |

## Phase 4 — Intelligence & Smart Inbox
| Task | Status | Notes |
|---|---|---|
| AI provider abstraction: mock / oMLX (OpenAI-compatible) / cloud / disabled; strict zod schemas | DONE | |
| Cloud gating: env flag + per-user consent; no automatic cloud fallback | DONE | |
| Rules first, AI for leftovers, confident answers learned as rules | DONE | AI confidence values are labeled simulated |
| Real oMLX / cloud model verification | IN_PROGRESS | Live LAN oMLX full-document test passed on a fictional unknown-bank PDF (~21 seconds, source-verified output). Cloud models and broader bank layouts remain unverified. |
| Smart Inbox: transfer pairs, duplicates, uncategorized, subscriptions, unknown institution, stale sources | DONE | |
| Evidence-based, coverage-aware insights | DONE | Deterministic text, no LLM phrasing |

## Phase 5 — Crypto
| Task | Status | Notes |
|---|---|---|
| Watch-target detection (BTC address/xpub/descriptor, EVM address) rejecting private keys and seed phrases | DONE | Also enforced by a DB constraint |
| Providers: Esplora (BTC), EVM JSON-RPC, Blockscout; mock for DEV | DONE | Live providers tested only with injected fetch |
| Holdings + on-chain history persistence, valuation with market prices | DONE | |
| Live blockchain / market-data verification | BLOCKED | The sandbox egress proxy blocks public chain and price APIs |

## Phase 6 — Analytics & polish
| Task | Status | Notes |
|---|---|---|
| Net worth evolution incl. FX effect (constant-rate series) | DONE | |
| Cash flow (income, expenses, refunds offset), category breakdowns, period selector | DONE | |
| Responsive layouts: desktop, tablet, mobile | DONE | Screenshots in E2E |
| Accessibility: axe WCAG 2 A/AA with no serious or critical violations on 8 pages × 3 viewports | DONE | See TEST_RESULTS |
| Budgets / goals | TODO | Not in the MVP scope |

## Phase 7 — Validation & delivery
| Task | Status | Notes |
|---|---|---|
| Lint, typecheck, unit, integration, E2E, production build | DONE | Results in TEST_RESULTS.md |
| Security suite (RLS isolation, storage, SQL functions, constraints, audit) | DONE | 215 tests |
| Docs: README, CLAUDE, AGENTS, ARCHITECTURE, DEVELOPMENT, PLAN, TASKS, PROGRESS, TEST_RESULTS | DONE | |
| Pull request to `main` (no merge) | BLOCKED | The repository has no `main` branch; see PROGRESS.md for the one-line fix |
| Scheduled worker runs (imports retry, rates, wallets, orphaned-document purge) | TODO | `npm run worker -- all` exists; nothing schedules it |
| STG / PROD environments | TODO | Out of scope. Never touched. |
