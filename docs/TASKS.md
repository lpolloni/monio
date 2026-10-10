# Tasks

Status legend: **DONE** means implemented and covered by the tests listed in [TEST_RESULTS.md](TEST_RESULTS.md). **IN_PROGRESS** means partly built. **TODO** means not started. **BLOCKED** means it cannot be done in this environment; the reason is given.

## Phase 0 — Environment & architecture
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
| Task | Status | Notes |
|---|---|---|
| Format detection + parsers: CSV, OFX, XLSX, PDF (text layer) | DONE | |
| Institution profiles: Nubank, Nubank PJ, XP, Santander, BBVA, N26, Revolut, MPS + generic | IN_PROGRESS | Built from public layout knowledge and **fictional fixtures**. Not validated against real exports. |
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
| Real oMLX / cloud model verification | BLOCKED | No reachable model server or API key in this sandbox |
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
