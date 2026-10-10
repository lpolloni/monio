# Monio — agent instructions

Personal finance & wealth app. Next.js 16 (App Router, Cache Components, Turbopack) + Supabase.
Read `docs/PROGRESS.md` and `docs/TASKS.md` first; update them after each meaningful task.

## Non-negotiables
- **Money is never a JS float.** Amounts are signed decimal strings; arithmetic via `src/domain/money/decimal.ts` (decimal.js). Read NUMERIC columns as text (`amount:amount::text`); write with `dbNumeric()`.
- **Originals are preserved.** Conversions happen at read time (`FxTable`), never stored over source amounts.
- **AI never invents** transactions/amounts. Rules first, AI (mock in DEV) only for leftovers, every output schema-validated (`src/server/ai`).
- **Watch-only crypto.** Never accept/store private keys or seed phrases (`detectWatchTarget` rejects them).
- **Security:** RLS on every table, composite FKs `(id, user_id)`; service role only in `src/server/supabase/admin.ts` callers (reference data, seed, worker) and always filtered by `user_id`.
- Never connect to production; seeds refuse non-local URLs. Test data is fictional.

## Layout
- `src/domain/**` — pure, deterministic, unit-tested logic (no IO).
- `src/server/**` — server-only IO: `data/` (loaders + session-bound queries), `processing/` (post-import pipeline), `import/` (parsers), `ai/`, `blockchain/`, `market/`, `wallets/`, `actions/` (Server Actions).
- `src/app/[locale]/**` — routes (locale root param pt/en/it). `(app)/` is the authenticated shell.
- `src/components/**` — UI (`ui/` primitives, `shell/`, feature folders). Client components receive serializable view models.
- `supabase/migrations/` — the only source of schema truth. `scripts/` — dev tooling, seed, worker.

## Next.js 16 specifics
- Bundled docs: `node_modules/next/dist/docs/`. `middleware` is now `src/proxy.ts`.
- Cache Components: request data (`cookies()`, session) only inside `<Suspense>`; `getSession()` calls `connection()` first.
- Translations: server `getT()` (`src/i18n/server.ts`), client `useTranslations()` (use-intl). Add keys to `en.ts` first; `pt.ts`/`it.ts` are type-checked against it.

## Commands
`npm run dev:services` (Supabase via Docker) · `npm run dev:seed` · `npm run dev` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run test:integration` · `npm run test:e2e` · `npm run build`.
Restricted network: `export SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.gcr.io` before `dev:services`.
