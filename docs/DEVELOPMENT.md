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

## PWA installation

Use `npm run build` then `npm start` to verify the service worker (registered only in production builds).
Open Monio on HTTPS or `http://localhost:3000`, then Settings → Install Monio.
Chromium offers an install button when eligible; Safari on iPhone/iPad uses Share → Add to Home Screen.
Plain HTTP LAN IP addresses are not secure contexts and cannot install the service worker; use trusted HTTPS for mobile LAN testing.
The app uses standalone display, existing regular/maskable/Apple icons, and a stable manifest ID.
Only public static assets and a generic pt/en/it offline page enter Cache Storage. Pages, API responses,
financial data and authentication responses are never cached by the service worker. Offline navigation
shows a reconnect screen; balances/imports still require internet. Existing tabs may need a reload after an update.

## Private Supabase behind a public Monio tunnel

The browser calls Monio Server Actions for login/signup/logout. Only the Monio server contacts
the private Supabase URL; no public Supabase hostname is required. Existing NEXT_PUBLIC_SUPABASE_*
variable names are retained for compatibility but are consumed only on the server.
Keep the server on the Supabase LAN/VPN. Tunnel forwarding must preserve the public host and
X-Forwarded-Proto=https so Server Action origin checks and Secure session cookies work.
Do not expose the origin directly to untrusted traffic that can spoof forwarding headers.
Do not configure Cloudflare Cache Everything for authenticated pages or APIs.
Use Cloudflare rate limiting on login POST requests alongside Supabase Auth limits; distributed
application rate limiting is not added by this change. SMTP and confirmation links must be configured
separately; existing email confirmation links must return to the public Monio origin rather than a private API.
Rebuild/restart Monio after updating code. Existing sessions may need a fresh login.
