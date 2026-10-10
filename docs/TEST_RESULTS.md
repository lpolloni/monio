# Test results

_Run on 2026-10-10 in the cloud development sandbox. These results describe the **DEV** environment only._

## Environment
| Component | Version / setup |
|---|---|
| Node / npm | 22.22.0 / 10.9.4 |
| Next.js / React / TypeScript | 16.4.0 / 19.3.0 / 5.9.3 |
| Supabase CLI / Postgres | 2.120.0 / PostgreSQL 17.11 (local Docker stack: Auth, PostgREST, Storage, Kong) |
| Vitest | 5.0.3 |
| Playwright / browser | 1.56.1 / Chromium 141 (headless). No Firefox, WebKit/Safari or real devices. |
| Data | Fictional seed (`npm run dev:seed`) plus throwaway `@test.monio.dev` users created and deleted by the tests |

## Summary
| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 problems |
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Unit | `npm test` | ✅ **660 passed** / 0 failed (37 files) |
| Integration (real local Supabase) | `npm run test:integration` | ✅ **230 passed** / 0 failed (9 files) |
| E2E on the dev server | `npm run test:e2e` | ✅ **124 passed** / 0 failed (desktop 51, tablet 35, mobile 37, setup 1) |
| E2E on the production build (`next start`) | `E2E_BASE_URL=http://localhost:3100 npx playwright test` | ✅ **124 passed** / 0 failed (same suite, same projects) |
| Production build | `npm run build` | ✅ succeeds. All app routes are partially prerendered (static shell + streamed user data). |
| Migrations from scratch | `supabase db reset` | ✅ all 7 migrations applied cleanly |

### Failures found and fixed during the final validation
Each one was fixed, and the suite was then re-run green:
1. **Contrast below WCAG AA** for subtle, positive, negative and warning text in both themes, and on the institution-card glow on mobile. Token values were raised, and the a11y spec now checks light **and** dark.
2. **`aria-prohibited-attr`** on animated amounts. The exact value is now exposed as sr-only text.
3. **Sign-in hydration race.** Text typed before hydration was lost, and a pre-hydration submit could have used GET with credentials in the URL. The form is now uncontrolled, uses POST, and submit stays disabled until hydrated.
4. **Smart Inbox flooding.** Every answer re-ran post-processing and added new "uncategorized" questions, including for transactions still waiting on a transfer decision. A new integration test (`tests/integration/post-process.test.ts`) fails on the old code and passes on the fix.
5. **Production build failure.** `usePathname()` ran outside `<Suspense>` on `/explore/[accountId]`. This was invisible in `next dev` and only `next build` caught it.
6. **Test issues** (not product bugs): a heading selector collided with Next's route announcer, and ESLint was linting generated Playwright reports.

## What each suite covers

### Unit (Vitest, no IO)
- **Money and FX:** decimal arithmetic, rounding, historical FX, inverse rates, triangulation.
- **Portfolio:** assets, liabilities, credit limits not counted as assets, business separation.
- **Analytics:** cash flow (refunds, transfers excluded), net-worth history with the FX effect, deterministic insights with coverage.
- **Transactions and categorization:** transfer and duplicate matching, recurring payments and price changes, fingerprints, categorization rules.
- **Import:** amount and date parsing; CSV, OFX, XLSX and PDF parsers; institution profiles; detection.
- **AI:** schema validation, prompt-injection handling, cloud gating, adapters with **injected fetch**.
- **Crypto:** address, xpub and descriptor validation; private key and seed phrase rejection.
- **Blockchain and market providers:** tested with **injected fetch only**.

### Integration (real local Supabase)
- **Security (215 tests):**
  - row isolation across all user tables, including anonymous visitors
  - storage folder policies
  - SQL functions
  - constraints (private-key material, storage paths)
  - auth: password policy, anonymous sign-in disabled, JWT tampering, crafted filters
  - audit trail and account deletion lifecycle
- **Import pipeline (11 tests):** N26, Revolut, OFX, Nubank PJ, unknown bank and text PDF fixtures; idempotency; rejection of bad files; privacy between users.
- **Post-processing re-runs (3 tests):** bounded uncategorized questions, none while a transfer decision is pending, auto-close and refill.
- **Smoke (1 test):** the stack is up and reference data is present.

### E2E (Playwright + axe)
- **Auth:** redirect to the localized login, a wrong password gives a generic error, sign-in returns to the requested page, sign-out.
- **Money views:**
  - the display currency switch keeps original amounts
  - Explore filters, and credit limits are not counted as assets
  - Activity search, provenance and category correction
  - account settings (rename, new shared entity, exclude from net worth, restore)
  - recurring payments
  - insights with evidence
- **Import:** a fresh user imports statements through the UI. Re-importing is idempotent and unsupported files are rejected.
- **Smart Inbox and Settings:** one-tap answer, language switch, display currency, AI status, delete-data confirmation.
- **Wallets:** a private key or recovery phrase is refused before submit; an EVM address connects (mock chain provider).
- **Navigation, mobile bottom nav, ADD sheet, institution sheet.**
- **Accessibility:** axe WCAG 2 A/AA, with no serious or critical violations on 8 pages × light/dark × desktop/tablet/mobile.
- **Visual:** each page in light and dark on 3 viewports with no horizontal overflow. Screenshots are in `artifacts/screenshots/` (git-ignored).

## Mocks vs. real infrastructure
| Area | In these tests |
|---|---|
| Database, Auth, Storage, RLS | **Real** local Supabase in Docker |
| Next.js server | **Real**: `next dev`, and `next start` on the production build |
| Browser | **Real** headless Chromium |
| AI | **Mock** provider (deterministic). The oMLX and cloud adapters are exercised only with injected `fetch`. |
| Blockchain data | **Mock** provider in E2E. Esplora, EVM RPC and Blockscout adapters only with injected `fetch`. |
| Exchange rates and prices | **Seeded** fictional rates. Frankfurter and CoinGecko adapters only with injected `fetch`. |
| Bank statements | **Fictional fixtures** shaped like each bank's layout, not real exports |

## Not executed (and why)
- **Live AI (oMLX on the LAN or cloud models):** not reachable from the sandbox, and no API key.
- **Live blockchain and market APIs:** the sandbox egress proxy blocks them.
- **Real bank exports:** none were available, and real financial data must not be used as test fixtures.
- **Firefox, WebKit/Safari, real iOS/Android devices, PWA install flow on a device:** not available here.
- **Load, performance and penetration testing by a third party:** out of scope.
- **Staging or production:** intentionally never touched.
