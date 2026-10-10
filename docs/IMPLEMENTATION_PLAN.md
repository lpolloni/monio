# Implementation plan

The roadmap follows the product brief's phases. Status per task lives in `TASKS.md`;
narrative status in `PROGRESS.md`.

| Phase | Goal | Key deliverables |
|---|---|---|
| 0 — Environment & architecture | Real DEV backend and a reproducible setup | Next.js 16 scaffold; Docker + Supabase CLI stack; migrations (schema, RLS, storage, reference data); `.env.local` from real credentials; dev scripts; Vitest |
| 1 — Design & foundation | Distinctive, coherent premium UI | OKLCH design tokens (light/dark), typography (Instrument Serif + Geist), responsive shell (floating pill nav / mobile tab bar + ADD), Home wealth constellation, i18n pt/en/it, Motion |
| 2 — Accounts & transactions | Multi-entity, multi-country, multi-currency model | Entities/institutions/accounts/transactions; portfolio & cash-flow domain; Explore + account detail; Activity with filters; FX table |
| 3 — Document import | ADD → INTERPRET → ORGANIZE | Parsers (CSV/OFX/XLSX/PDF), intake + storage, idempotent pipeline, duplicate/transfer detection, categorization, import UI & summary |
| 4 — Intelligence & Smart Inbox | Automation with honest uncertainty | Provider-independent AI (mock/oMLX/cloud), schema validation, learned rules, Smart Inbox questions & resolutions |
| 5 — Crypto | Watch-only wallets | Address/xpub validation with secret detection, chain providers, holdings & on-chain history, valuation |
| 6 — Analytics & polish | Evidence-based insights | Net worth evolution with FX effect, cash flow, breakdowns, subscriptions & price changes, PWA, accessibility, responsive |
| 7 — Validation | Proof, not claims | Lint, typecheck, build, unit, integration (real Supabase), E2E (Playwright + axe) on 3 viewports, docs, PR |

## Decisions
- **Next.js 16 + Cache Components** kept from the scaffold: static shells + streamed user data; locale as root param so translated shells are static.
- **use-intl** (framework-agnostic core of next-intl) instead of next-intl routing, to avoid coupling to request config under Cache Components.
- **decimal.js** for money; NUMERIC read as text from PostgREST.
- **Composite FKs `(id, user_id)`** in addition to RLS for defence in depth.
- **Processing in route handlers + `after()`** with the user's token (RLS still applies); `scripts/worker.ts` (service role, explicit user filters) for queued/retried jobs. No Edge Functions yet (not needed; Edge runtime disabled in the DEV stack to keep it light).
- **Deterministic insights** (no LLM phrasing) so every statement is reproducible and carries its evidence.
- **Rules before AI**; AI answers become rules; cloud AI gated twice (env + user consent).
