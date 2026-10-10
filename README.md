# Monio

Monio is a personal finance and wealth app. You add bank statements or watch-only crypto wallets. Monio reads them, organizes your accounts, transactions, recurring payments and transfers, and shows a calm, explorable picture of your money across banks, countries, currencies and entities (personal, business, shared).

> **Status: development prototype.** Everything here runs against a **local Supabase DEV stack with fictional data**. It is **not production-ready**; see [docs/PROGRESS.md](docs/PROGRESS.md) for the honest status and [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md) for what was and was not verified.

## What it does
- **ADD → INTERPRET → ORGANIZE → EXPLORE.**
  - Import CSV, OFX, XLSX or PDF statements, or connect a BTC or ETH/EVM wallet by public address or xpub.
  - Monio parses the file deterministically, detects the institution, deduplicates, matches transfers, categorizes (rules first, then AI), detects recurring payments and price changes, and generates evidence-backed insights.
- **Home:** a radial "wealth constellation" of institutions around your net worth, plus assets, liabilities, available money, a cash-flow summary and recent activity.
- **Explore:** entities, countries, institutions, accounts and asset groups; account detail with balance history.
- **Activity:** a filterable transaction list, cash flow, net-worth evolution (including the FX effect) and recurring payments.
- **Insights:** deterministic statements, each with its evidence and coverage notes.
- **Smart Inbox:** only the questions Monio cannot answer safely, such as cross-entity transfers, possible duplicates, ambiguous subscriptions and unknown institutions. Each answer is remembered.
- **Multicurrency:**
  - Amounts are decimal strings, never floats.
  - Original amounts are never overwritten; conversion happens at read time using historical rates.
- **Banks:** catalog profiles for Brazil (Nubank, Nubank PJ, XP, Santander) and Italy (BBVA, N26, Revolut, MPS), plus generic CSV, OFX, XLSX and PDF readers.
- **Languages and app:** Portuguese (default), English and Italian; light and dark themes; responsive; installable as a PWA.
- **AI** sits behind a provider interface: `mock` (DEV default), `omlx` (local OpenAI-compatible server) or `cloud`. Cloud is off by default and requires both an env flag and per-user consent.
- **Crypto is watch-only.** Monio never accepts, stores or derives private keys or seed phrases, never signs transactions and never moves funds.

## Stack
Next.js 16 (App Router, Cache Components, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · Radix primitives (shadcn-style, hand-written) · Motion · Lucide · Recharts · use-intl · decimal.js · zod · Supabase (Postgres, Auth, Storage, RLS) · Vitest · Playwright + axe.

## Quick start (DEV)
Requires Node ≥ 22.12 and a running Docker daemon.
```bash
npm install
npm run dev:services   # starts local Supabase in Docker and writes .env.local from `supabase status`
npm run dev:seed       # fictional demo data (refuses non-local URLs)
npm run dev            # http://localhost:3000
```
Sign in with `demo@monio.dev` / `MonioDemo!2026` (fictional DEV user). Supabase Studio is at http://localhost:54323.

On networks that block `public.ecr.aws`, run `export SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.gcr.io` first (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

## Scripts
| Script | Purpose |
|---|---|
| `dev:setup` | `dev:services` + `dev:seed` |
| `dev:services` / `dev:services:stop` / `dev:status` | Local Supabase lifecycle |
| `dev:seed` / `db:reset` / `db:types` | Seed data, re-apply migrations, regenerate DB types |
| `dev` / `build` / `start` | Next.js |
| `lint` / `typecheck` | ESLint / `next typegen && tsc --noEmit` |
| `test` | Unit tests (Vitest) |
| `test:integration` | Integration tests against the real local Supabase (RLS, storage, import pipeline) |
| `test:e2e` | Playwright E2E on desktop, tablet and mobile, with axe accessibility and visual screenshots |
| `worker -- <jobs\|rates\|wallets\|purge\|all>` | Background jobs |

## Documentation
- [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md): rules for coding agents.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design, data model, security model.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, commands, environments, provider switching.
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): phases and decisions.
- [docs/TASKS.md](docs/TASKS.md): task board.
- [docs/PROGRESS.md](docs/PROGRESS.md): current status, known limitations, next steps.
- [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md): what was executed, what passed or failed, and what is mocked.

## Security notes
- Row Level Security is enabled on every table. Composite foreign keys `(id, user_id)` prevent cross-user references.
- 215 integration tests attack isolation, storage, SQL functions and constraints.
- Server-only secrets never use `NEXT_PUBLIC_`. `.env.local` is git-ignored.
- Uploaded documents live in a private bucket under the owner's folder. Parsers treat document text as data, never as instructions.
