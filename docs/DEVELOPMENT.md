# Development guide

## Prerequisites
- Node.js ≥ 22.12, npm 10
- Docker (daemon running) for the local Supabase DEV stack
- ~4 GB free RAM, ~6 GB disk for Supabase images
- Optional: Chromium for E2E (`/opt/pw-browsers` in the cloud sandbox; locally `npx playwright install chromium`)

## First run
```bash
npm install
npm run dev:services     # docker check → supabase start → writes .env.local from `supabase status`
npm run dev:seed         # fictional demo data (refuses non-local URLs and APP_ENV=production)
npm run dev              # http://localhost:3000  → demo@monio.dev / MonioDemo!2026
```
`npm run dev:setup` runs services + seed in one go.

### Restricted networks (cloud sandboxes)
If `public.ecr.aws` is blocked, pull Supabase images from Google's Docker Hub mirror:
```bash
export SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.gcr.io
npm run dev:services     # also re-tags kong/mailpit/postgrest from their upstream images on the mirror
```
If the Docker daemon is not running in a root VM: `dockerd > /tmp/dockerd.log 2>&1 &`.

## Commands
| Command | What it does |
|---|---|
| `npm run dev:services` / `dev:services:stop` | Start/stop Supabase (Postgres, Auth, PostgREST, Storage, Studio :54323, Mailpit :54324) |
| `npm run dev:status` | `supabase status` |
| `npm run dev:env` | Regenerate `.env.local` from the running stack |
| `npm run dev:seed` | Recreate the demo users and fictional data |
| `npm run db:reset` | Re-apply all migrations + seed |
| `npm run db:types` | Regenerate `src/server/supabase/database.types.ts` |
| `npm run worker -- <jobs\|rates\|wallets\|purge\|all>` | Background jobs (queued imports, rates refresh, wallet sync, orphaned-document purge) |
| `npm run lint` / `typecheck` / `test` | ESLint, `next typegen && tsc`, Vitest unit tests |
| `npm run test:integration` | Vitest against the real local Supabase (RLS, storage, import) |
| `npm run test:e2e` | Playwright (desktop/tablet/mobile, axe accessibility) |
| `npm run build` | Production build |
| `node scripts/generate-icons.mjs` | Regenerate PWA icons |

## Conventions
- Read `CLAUDE.md` (non-negotiables) and `docs/ARCHITECTURE.md`.
- New user-visible text: add the key to `src/i18n/messages/en.ts`, then `pt.ts` and `it.ts` (type-checked).
- New table: migration with RLS policies + composite FKs `(id, user_id)`, then `npm run db:types`.
- Money: decimal strings + `src/domain/money/decimal.ts`; never `Number()` for amounts except chart geometry.
- Server data: add loaders in `src/server/data/*` (pure, `userId` explicit) and session-bound getters in `queries.ts`.
- Tests next to code (`*.test.ts`); integration tests in `tests/integration/`; E2E in `tests/e2e/`.

## Environments
- **DEV**: local Supabase, `APP_ENV=development`, mock AI/blockchain/rates, fictional data.
- **STG/PROD** (future): separate Supabase projects (possibly self-hosted). Apply migrations with
  `supabase db push` against the target explicitly; build the app per environment because
  `NEXT_PUBLIC_*` values are embedded at build time. Never run `dev:seed` there (it refuses).

## Switching providers
- AI: `AI_PROVIDER=omlx`, `AI_BASE_URL=http://<lan-host>:8000/v1`, `AI_MODEL=...` (OpenAI-compatible).
  Cloud: `AI_PROVIDER=cloud`, `AI_CLOUD_FLAVOR=openai|openrouter|anthropic|generic`, `AI_API_KEY`,
  `AI_ALLOW_CLOUD_DOCUMENTS=true` + per-user consent in Settings.
- Blockchain: `BLOCKCHAIN_PROVIDER=live` (Esplora/mempool.space, public EVM RPC, Blockscout).
- Rates: `EXCHANGE_RATE_PROVIDER=live` (Frankfurter + CoinGecko), then `npm run worker -- rates`.
