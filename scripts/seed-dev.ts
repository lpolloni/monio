/**
 * Monio DEV seed — FICTIONAL data only.
 *
 * Creates two demo users in the LOCAL Supabase stack and fills the first with
 * ~14 months of realistic but invented activity across Brazilian and Italian
 * institutions, personal / business / shared ownership, several currencies,
 * card bills, internal and international transfers, subscriptions (one with a
 * price change), a duplicate import, stale sources, loans and watch-only crypto.
 *
 * Imported rows go through the same categorisation (rules → mock AI) and
 * post-processing (transfers, duplicates, recurring, inbox, insights) used by
 * real imports. Deterministic for a given anchor date (SEED_TODAY, default today).
 *
 * Usage: npm run dev:seed   (requires `npm run dev:services`)
 */
import { createClient } from "@supabase/supabase-js";
import { addDaysIso, addMonthsToKey, monthEnd, monthKey } from "@/domain/analytics/periods";
import { detectWatchTarget } from "@/domain/crypto/addresses";
import { D, dec, toPlain, toScale, type DecimalValue } from "@/domain/money/decimal";
import { computeFingerprints } from "@/domain/transactions/normalize";
import { aiConfigFromEnv, createAiService } from "@/server/ai";
import { createBlockchainService } from "@/server/blockchain/service";
import { MOCK_BIP84_ZPUB, MOCK_EVM_RICH } from "@/server/blockchain/providers/fixtures";
import { createMarketDataService } from "@/server/market/service";
import { categorizeBatch, loadRules, persistLearnedRules } from "@/server/processing/categorize";
import { postProcessUser } from "@/server/processing/post-process";
import type { Database } from "@/server/supabase/database.types";
import { dbNumeric } from "@/server/supabase/numeric";
import { deleteUserCompletely } from "@/server/maintenance/purge";
import { ensureAssets, persistWalletSnapshot } from "@/server/wallets/persist";

// ---------------------------------------------------------------------------
// Safety guards
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const appEnv = process.env.APP_ENV ?? "development";
if (appEnv !== "development") {
  console.error(`Refusing to seed: APP_ENV is "${appEnv}". Development seeds never run outside DEV.`);
  process.exit(1);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url) && process.env.SEED_ALLOW_REMOTE_DEV !== "true") {
  console.error("Refusing to seed a non-local Supabase URL. Set SEED_ALLOW_REMOTE_DEV=true only for an isolated DEV project.");
  process.exit(1);
}
if (!serviceKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY missing. Run `npm run dev:env`.");
  process.exit(1);
}

const admin = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const TODAY = process.env.SEED_TODAY ?? new Date().toISOString().slice(0, 10);
export const DEMO_PASSWORD = "MonioDemo!2026";
const DEMO = { email: "demo@monio.dev", name: "Alex Rocha" };
const ISOLATION = { email: "isolation@monio.dev", name: "Isolation Tester" };

// Deterministic PRNG (mulberry32)
let seedState = 20261010;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
/** Random amount between min and max with 2 decimals, as a decimal string. */
function amt(min: number, max: number): string {
  const cents = Math.round((min + rand() * (max - min)) * 100);
  return toPlain(new D(cents).dividedBy(100));
}
function dayIn(month: string, day: number): string {
  const end = Number(monthEnd(month).slice(8));
  return `${month}-${String(Math.min(day, end)).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
async function resetUser(email: string, name: string): Promise<string> {
  const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const existing = list.users.find((u) => u.email === email);
  if (existing) await deleteUserCompletely(admin, existing.id);
  const { data, error: createError } = await admin.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: name, locale: "pt", primary_currency: "EUR", fictional: true },
  });
  if (createError || !data.user) throw createError ?? new Error("user not created");
  return data.user.id;
}

// ---------------------------------------------------------------------------
// Exchange rates (global reference data, source "mock")
// ---------------------------------------------------------------------------
async function seedRates() {
  const market = createMarketDataService({ provider: "mock" });
  const from = addDaysIso(TODAY, -440);
  const daily = [
    { base: "EUR", quote: "USD" },
    { base: "EUR", quote: "BRL" },
    { base: "BTC", quote: "USD" },
    { base: "ETH", quote: "USD" },
  ];
  const weekly = ["USDC", "USDT", "DAI", "POL", "LINK", "UNI", "ARB", "OP", "WBTC"].map((base) => ({ base, quote: "USD" }));
  const quotes = [...(await market.historical(daily, from, TODAY))];
  const weeklyQuotes = (await market.historical([...weekly, { base: "EURC", quote: "EUR" }], from, TODAY)).filter(
    (q) => new Date(`${q.asOf}T00:00:00Z`).getUTCDay() === 1 || q.asOf === TODAY,
  );
  quotes.push(...weeklyQuotes);
  for (let i = 0; i < quotes.length; i += 1000) {
    const { error } = await admin.from("exchange_rates").upsert(
      quotes.slice(i, i + 1000).map((q) => ({ base: q.base, quote: q.quote, as_of: q.asOf, rate: dbNumeric(q.rate), source: q.source })),
      { onConflict: "base,quote,as_of,source" },
    );
    if (error) throw error;
  }
  console.log(`  rates: ${quotes.length} observations (${from} → ${TODAY})`);
}

// ---------------------------------------------------------------------------
// Demo user data
// ---------------------------------------------------------------------------
interface SeedAccount {
  key: string;
  institution: string | null;
  name: string;
  type: Database["public"]["Tables"]["accounts"]["Insert"]["type"];
  currency: string;
  entity: "personal" | "business" | "shared";
  mask?: string;
  creditLimit?: string;
  syncedDaysAgo: number;
  /** Balance today (or at the stale date). */
  balance?: string;
  /** Country where the account is used (not the institution's headquarters). */
  country: string;
}

const ACCOUNTS: SeedAccount[] = [
  { key: "nu", institution: "nubank", name: "Conta Nubank", type: "checking", currency: "BRL", entity: "personal", mask: "4821", syncedDaysAgo: 2, balance: "8452.37", country: "BR" },
  { key: "nucard", institution: "nubank", name: "Nubank Ultravioleta", type: "credit_card", currency: "BRL", entity: "personal", mask: "7712", creditLimit: "15000", syncedDaysAgo: 2, country: "BR" },
  { key: "pj", institution: "nubank-pj", name: "Conta PJ Lumen", type: "checking", currency: "BRL", entity: "business", mask: "0453", syncedDaysAgo: 3, balance: "42810.55", country: "BR" },
  { key: "xp", institution: "xp", name: "XP Investimentos", type: "investment", currency: "BRL", entity: "personal", mask: "9930", syncedDaysAgo: 9, country: "BR" },
  { key: "santander", institution: "santander-br", name: "Conta Santander", type: "checking", currency: "BRL", entity: "personal", mask: "1187", syncedDaysAgo: 46, balance: "3120.80", country: "BR" },
  { key: "carloan", institution: "santander-br", name: "Financiamento Veículo", type: "loan", currency: "BRL", entity: "personal", syncedDaysAgo: 46, country: "BR" },
  { key: "bbva", institution: "bbva-it", name: "Conto BBVA", type: "checking", currency: "EUR", entity: "personal", mask: "6604", syncedDaysAgo: 1, balance: "6784.12", country: "IT" },
  { key: "n26", institution: "n26", name: "N26 Main", type: "checking", currency: "EUR", entity: "personal", mask: "2290", syncedDaysAgo: 1, balance: "2151.48", country: "IT" },
  { key: "n26space", institution: "n26", name: "Space Viaggi", type: "savings", currency: "EUR", entity: "personal", syncedDaysAgo: 1, balance: "4250.00", country: "IT" },
  { key: "reveur", institution: "revolut", name: "Revolut EUR", type: "checking", currency: "EUR", entity: "personal", mask: "5512", syncedDaysAgo: 0, balance: "1432.90", country: "IT" },
  { key: "revusd", institution: "revolut", name: "Revolut USD", type: "checking", currency: "USD", entity: "personal", syncedDaysAgo: 0, balance: "862.15", country: "IT" },
  { key: "mps", institution: "mps", name: "Conto Casa MPS", type: "checking", currency: "EUR", entity: "shared", mask: "3307", syncedDaysAgo: 5, balance: "4208.66", country: "IT" },
  { key: "mortgage", institution: "mps", name: "Mutuo Casa", type: "mortgage", currency: "EUR", entity: "shared", syncedDaysAgo: 5, country: "IT" },
  { key: "home", institution: null, name: "Casa Milano", type: "other", currency: "EUR", entity: "shared", syncedDaysAgo: 40, balance: "312000.00", country: "IT" },
];

interface SeedTx {
  account: string;
  date: string;
  description: string;
  amount: string;
  original?: { amount: string; currency: string };
}

function generateTransactions(months: string[]): SeedTx[] {
  const txs: SeedTx[] = [];
  const add = (account: string, date: string, description: string, amount: string, original?: SeedTx["original"]) => {
    if (date > TODAY) return;
    txs.push({ account, date, description, amount, original });
  };
  const staleCutoff = addDaysIso(TODAY, -46);
  let cardCycle: DecimalValue = new D(0);
  months.forEach((m, idx) => {
    const monthsAgo = months.length - 1 - idx;
    // --- Italy: salary, rent/mortgage, everyday life -------------------------
    const salary = m.endsWith("-12") ? "5120.00" : "3450.00";
    add("bbva", dayIn(m, 27), "BONIFICO STIPENDIO AURORA TECH SRL", salary);
    add("bbva", dayIn(m, 1), "GIROCONTO A CONTO CASA MPS", "-1100");
    add("mps", dayIn(m, 1), "GIROCONTO DA BBVA CONTO PERSONALE", "1100");
    add("bbva", dayIn(m, 2), "BONIFICO A N26 MAIN", "-900");
    add("n26", dayIn(m, 2), "Bonifico da BBVA Transfer", "900");
    add("mps", dayIn(m, 5), "RATA MUTUO N. 00123 CASA", "-820.00");
    if (idx % 2 === 0) add("mps", dayIn(m, 16), "A2A ENERGIA BOLLETTA LUCE GAS", `-${amt(78, 142)}`);
    add("mps", dayIn(m, 19), "FASTWEB SPA ADDEBITO SDD", "-29.95");
    if (idx % 3 === 0) add("mps", dayIn(m, 22), "CONDOMINIO VIA SOLARI 14", "-120.00");
    for (let i = 0; i < 6; i++) {
      add("n26", dayIn(m, 2 + Math.floor(rand() * 26)), pick(["ESSELUNGA MILANO", "CONAD CITY", "LIDL ITALIA", "CARREFOUR MARKET"]), `-${amt(16, 96)}`);
    }
    add("n26", dayIn(m, 3), "ATM MILANO ABBONAMENTO MENSILE", "-39.00");
    add("n26", dayIn(m, 12), "ILIAD ITALIA", "-9.99");
    add("n26", dayIn(m, 15), "APPLE.COM/BILL ICLOUD", "-2.99");
    for (let i = 0; i < 3; i++) {
      add("n26", dayIn(m, 4 + Math.floor(rand() * 24)), pick(["TRATTORIA DA MARIO", "SUSHI KOI MILANO", "BAR PASTICCERIA COVA", "PIZZERIA DA ZERO"]), `-${amt(8, 62)}`);
    }
    if (rand() < 0.5) add("n26", dayIn(m, 20), "FARMACIA SAN MARCO", `-${amt(9, 48)}`);
    if (rand() < 0.6) add("n26", dayIn(m, 24), "AMAZON EU SARL", `-${amt(14, 120)}`);
    add("n26", dayIn(m, 6), "Transfer to Revolut", "-300");
    add("reveur", dayIn(m, 6), "Top-up by *2290 N26", "300");
    add("n26", dayIn(m, 28), "Space Viaggi transfer", "-250");
    add("n26space", dayIn(m, 28), "From Main account transfer", "250");
    // Revolut: subscriptions (Netflix price change two months ago), travel
    add("reveur", dayIn(m, 9), "Netflix.com", monthsAgo <= 1 ? "-15.99" : "-13.99");
    add("reveur", dayIn(m, 18), "Spotify", "-11.99");
    if (rand() < 0.35) add("reveur", dayIn(m, 13), "RYANAIR", `-${amt(48, 185)}`);
    if (m.endsWith("-07") || m.endsWith("-08")) add("reveur", dayIn(m, 10), "BOOKING.COM HOTEL", `-${amt(210, 460)}`);
    if (rand() < 0.5) add("reveur", dayIn(m, 21), "Uber Eats", `-${amt(18, 42)}`);
    add("revusd", dayIn(m, 21), "OpenAI *ChatGPT Plus", "-20.00");
    add("revusd", dayIn(m, 11), "GITHUB INC", "-4.00");
    if (idx % 3 === 1) {
      add("reveur", dayIn(m, 14), "Exchanged to USD", "-92.40");
      add("revusd", dayIn(m, 14), "Exchanged from EUR", "100.00");
    }
    // --- Brazil: personal ----------------------------------------------------
    add("pj", dayIn(m, 5), "TRANSFERENCIA ENVIADA PRO-LABORE ALEX ROCHA", "-6000.00");
    add("nu", dayIn(m, 5), "Transferência recebida Lumen Design Ltda", "6000.00");
    add("nu", dayIn(m, 15), "Aplicação XP Investimentos", "-1500.00");
    if (rand() < 0.4) add("nu", dayIn(m, 18), "Pix recebido Maria Rocha", amt(150, 400));
    add("nu", dayIn(m, 28), "Rendimento da conta", amt(8, 22));
    if (idx % 4 === 2) {
      add("nu", dayIn(m, 9), "Pix enviado Wise Brasil", "-2000.00");
      add("reveur", dayIn(m, 11), "Payment from WISE EUROPE SA", toScale(dec("2000").dividedBy(6.18).times(0.992), 2));
    }
    // Card purchases; the bill is paid on day 10 of the following month.
    const cardPurchases: [string, string][] = [
      ["PAG*NETFLIX", monthsAgo <= 1 ? "-44.90" : "-39.90"],
      ["SPOTIFY BR", "-21.90"],
      ["AMAZON PRIME BR", "-19.90"],
    ];
    for (let i = 0; i < 4; i++) cardPurchases.push([pick(["IFOOD *RESTAURANTE", "IFOOD *MERCADO"]), `-${amt(32, 96)}`]);
    for (let i = 0; i < 4; i++) cardPurchases.push(["UBER *TRIP", `-${amt(14, 46)}`]);
    cardPurchases.push(["PAO DE ACUCAR", `-${amt(85, 320)}`], ["DROGASIL", `-${amt(22, 90)}`], ["POSTO IPIRANGA", `-${amt(150, 240)}`]);
    if (rand() < 0.6) cardPurchases.push(["MERCADOLIVRE*VENDEDOR", `-${amt(45, 290)}`]);
    const days = [3, 6, 8, 11, 12, 14, 17, 19, 21, 23, 25, 26, 27, 28];
    cardPurchases.forEach(([desc, value], i) => {
      const d = dayIn(m, days[i % days.length]! + (desc.startsWith("PAG*NETFLIX") ? 0 : 0));
      add("nucard", d, desc, value);
      if (d <= TODAY) cardCycle = cardCycle.plus(dec(value).abs());
    });
    if (monthsAgo === 2) {
      // The same purchase exported twice with slightly different text (pending vs posted).
      add("nucard", dayIn(m, 14), "AMAZON MKTPLACE PMTS", "-129.90");
      add("nucard", dayIn(m, 15), "Amazon Mktplace", "-129.90");
    }
    if (idx > 0) {
      const billDate = dayIn(m, 10);
      const bill = toScale(cardCycle.times(0.97), 2); // part of the cycle paid in full
      add("nu", billDate, "Pagamento de fatura", `-${bill}`);
      add("nucard", billDate, "Pagamento recebido", bill);
      cardCycle = new D(0);
    }
    // --- Brazil: business (Nubank PJ) ------------------------------------------
    add("pj", dayIn(m, 8), "PIX RECEBIDO CLIENTE ALFA SERVICOS LTDA", amt(9500, 14200));
    if (rand() < 0.4) add("pj", dayIn(m, 17), "TED RECEBIDA BETA COMERCIO SA", amt(2500, 6800));
    add("pj", dayIn(m, 12), "ADOBE *CREATIVE CLOUD", "-275.00");
    add("pj", dayIn(m, 13), "GOOGLE *WORKSPACE LUMEN", "-70.00");
    add("pj", dayIn(m, 20), "DARF SIMPLES NACIONAL", `-${amt(1100, 1650)}`);
    // --- Brazil: Santander (stale: nothing after the last statement) ----------
    if (dayIn(m, 12) <= staleCutoff) add("santander", dayIn(m, 12), "PARCELA FINANCIAMENTO VEICULO 18/48", "-1850.00");
    if (dayIn(m, 7) <= staleCutoff) add("santander", dayIn(m, 7), "TED RECEBIDA ALUGUEL APTO PINHEIROS", "2400.00");
    if (dayIn(m, 25) <= staleCutoff) add("santander", dayIn(m, 25), "TARIFA PACOTE SERVICOS", "-45.90");
  });
  // One foreign-currency card purchase (charged in BRL, original in USD).
  const lastMonth = months[months.length - 2]!;
  add("nucard", dayIn(lastMonth, 16), "STEAMGAMES.COM", "-112.45", { amount: "-19.99", currency: "USD" });
  return txs.sort((a, b) => a.date.localeCompare(b.date));
}

async function seedDemoUser(userId: string) {
  const { data: personal } = await admin.from("financial_entities").select("id").eq("user_id", userId).eq("kind", "personal").single();
  const { data: biz } = await admin.from("financial_entities").insert({ user_id: userId, name: "Lumen Design Ltda", kind: "business", country: "BR" }).select("id").single();
  const { data: shared } = await admin.from("financial_entities").insert({ user_id: userId, name: "Casa Milano", kind: "shared", country: "IT" }).select("id").single();
  if (!personal || !biz || !shared) throw new Error("entities not created");
  const entityId = { personal: personal.id, business: biz.id, shared: shared.id };

  const { data: institutions } = await admin.from("institutions").select("id, slug, country").is("owner_id", null);
  const instBySlug = new Map((institutions ?? []).map((i) => [i.slug, i]));

  const accountIds = new Map<string, string>();
  const accountType = new Map<string, string>();
  for (const a of ACCOUNTS) {
    const inst = a.institution ? instBySlug.get(a.institution) : undefined;
    const { data, error } = await admin
      .from("accounts")
      .insert({
        user_id: userId,
        entity_id: entityId[a.entity],
        institution_id: inst?.id ?? null,
        name: a.name,
        type: a.type,
        currency: a.currency,
        country: a.country,
        account_mask: a.mask ?? null,
        credit_limit: a.creditLimit ? dbNumeric(a.creditLimit) : null,
        last_synced_at: new Date(Math.min(Date.parse(`${addDaysIso(TODAY, -a.syncedDaysAgo)}T09:30:00Z`), Date.now() - 45 * 60_000)).toISOString(),
        sync_source: a.type === "other" ? "manual" : "seed",
      })
      .select("id")
      .single();
    if (error) throw error;
    accountIds.set(a.key, data.id);
    accountType.set(a.key, a.type);
  }
  await admin.from("liability_details").insert([
    { user_id: userId, account_id: accountIds.get("carloan")!, original_principal: dbNumeric("72000"), interest_rate_apr: dbNumeric("1.49"), monthly_payment: dbNumeric("1850"), started_on: "2025-04-12", maturity_on: "2029-03-12" },
    { user_id: userId, account_id: accountIds.get("mortgage")!, original_principal: dbNumeric("160000"), interest_rate_apr: dbNumeric("3.15"), monthly_payment: dbNumeric("820"), started_on: "2021-06-05", maturity_on: "2046-06-05" },
  ]);

  // Transactions --------------------------------------------------------------
  const currentKey = monthKey(TODAY);
  const months = Array.from({ length: 14 }, (_, i) => addMonthsToKey(currentKey, i - 13));
  const generated = generateTransactions(months);

  const ai = createAiService(aiConfigFromEnv({ ...process.env, AI_PROVIDER: "mock" }));
  const rules = await loadRules(admin, userId);
  const { data: categories } = await admin.from("categories").select("id, slug").is("user_id", null);
  const systemCategoryIds = new Map((categories ?? []).map((c) => [c.slug, c.id]));
  const { results, learned } = await categorizeBatch(
    generated.map((t, i) => ({
      key: String(i),
      description: t.description,
      amount: t.amount,
      currency: ACCOUNTS.find((a) => a.key === t.account)!.currency,
      bookedOn: t.date,
      accountType: accountType.get(t.account),
    })),
    rules,
    systemCategoryIds,
    ai,
  );
  await persistLearnedRules(admin, userId, learned);

  const byAccount = new Map<string, { tx: SeedTx; index: number }[]>();
  generated.forEach((tx, index) => {
    const list = byAccount.get(tx.account) ?? [];
    list.push({ tx, index });
    byAccount.set(tx.account, list);
  });
  let inserted = 0;
  for (const [key, list] of byAccount) {
    const account = ACCOUNTS.find((a) => a.key === key)!;
    const fps = computeFingerprints(list.map(({ tx }) => ({ bookedOn: tx.date, amount: tx.amount, currency: account.currency, description: tx.description })));
    const rows = list.map(({ tx, index }, i) => {
      const cat = results.get(String(index));
      return {
        user_id: userId,
        account_id: accountIds.get(key)!,
        booked_on: tx.date,
        description_original: tx.description,
        merchant: cat?.merchant ?? null,
        amount: dbNumeric(tx.amount),
        currency: account.currency,
        original_amount: tx.original ? dbNumeric(tx.original.amount) : null,
        original_currency: tx.original?.currency ?? null,
        category_id: cat?.categoryId ?? null,
        category_source: cat?.source ?? null,
        category_confidence: cat?.confidence ?? null,
        fingerprint: fps[i]!,
        source: "seed" as const,
        extraction: "exact" as const,
        raw: { fictional: true },
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from("transactions").insert(rows.slice(i, i + 500));
      if (error) throw error;
    }
    inserted += rows.length;
  }
  console.log(`  transactions: ${inserted}`);

  // Balance snapshots, consistent with the transactions --------------------------
  const balanceRows: Database["public"]["Tables"]["account_balances"]["Insert"][] = [];
  for (const a of ACCOUNTS) {
    const id = accountIds.get(a.key)!;
    const asOfLatest = addDaysIso(TODAY, -a.syncedDaysAgo);
    const snapshotDates = [...months.map((m) => monthEnd(m)).filter((d) => d < asOfLatest), asOfLatest];
    const txs = byAccount.get(a.key)?.map((x) => x.tx) ?? [];
    let latest: DecimalValue;
    if (a.type === "credit_card") {
      // Current card debt = purchases since the last bill payment.
      const lastPayment = [...txs].reverse().find((t) => !t.amount.startsWith("-"))?.date ?? "0000-00-00";
      latest = txs.filter((t) => t.date > lastPayment && t.date <= asOfLatest).reduce((s, t) => s.plus(dec(t.amount)), new D(0));
    } else if (a.type === "investment") {
      latest = dec("418540.22");
    } else if (a.type === "loan") {
      latest = dec("-48230.00");
    } else if (a.type === "mortgage") {
      latest = dec("-128410.00");
    } else {
      latest = dec(a.balance ?? "0");
    }
    for (const date of snapshotDates) {
      let value: DecimalValue;
      if (a.type === "investment") {
        const monthsBack = Math.round((Date.parse(asOfLatest) - Date.parse(date)) / (30.4 * 86_400_000));
        value = latest.minus(new D(1500).times(monthsBack)).times(new D(1).minus(new D(monthsBack).times(0.006))).plus(new D(Math.round((rand() - 0.5) * 240000)).dividedBy(100));
      } else if (a.type === "other") {
        const monthsBack = Math.round((Date.parse(asOfLatest) - Date.parse(date)) / (30.4 * 86_400_000));
        value = latest.minus(new D(900).times(monthsBack));
      } else if (a.type === "loan" || a.type === "mortgage") {
        const monthsBack = Math.round((Date.parse(asOfLatest) - Date.parse(date)) / (30.4 * 86_400_000));
        value = latest.minus(new D(a.type === "loan" ? 1480 : 560).times(monthsBack));
      } else {
        // balance(date) = latest − Σ amounts after date
        const after = txs.filter((t) => t.date > date && t.date <= asOfLatest).reduce((s, t) => s.plus(dec(t.amount)), new D(0));
        value = latest.minus(after);
      }
      balanceRows.push({ user_id: userId, account_id: id, as_of: date, balance: dbNumeric(toScale(value, 2)), currency: a.currency, source: "seed" });
    }
  }
  const { error: balError } = await admin.from("account_balances").insert(balanceRows);
  if (balError) throw balError;
  console.log(`  balance snapshots: ${balanceRows.length}`);

  // Watch-only wallets (mock provider, fictional balances on public test identifiers) --
  const chain = createBlockchainService({ provider: "mock", now: () => new Date(`${TODAY}T08:00:00Z`) });
  const wallets = [
    { input: MOCK_BIP84_ZPUB, label: "Cold storage", currency: "BTC" },
    { input: MOCK_EVM_RICH, label: "DeFi wallet", currency: "ETH" },
  ];
  for (const w of wallets) {
    const detected = detectWatchTarget(w.input);
    if (!detected.ok) throw new Error(`invalid seed wallet: ${detected.error}`);
    const { data: account } = await admin
      .from("accounts")
      .insert({ user_id: userId, entity_id: entityId.personal, name: w.label, type: "crypto_wallet", currency: w.currency, sync_source: "blockchain" })
      .select("id")
      .single();
    const { data: wallet } = await admin
      .from("crypto_wallets")
      .insert({
        user_id: userId,
        account_id: account!.id,
        family: detected.target.family,
        watch_kind: detected.target.kind,
        public_identifier: detected.target.identifier,
        label: w.label,
      })
      .select("id")
      .single();
    const snapshot = await chain.snapshot(detected.target);
    const assetIds = await ensureAssets(admin, snapshot);
    await persistWalletSnapshot(admin, assetIds, { userId, walletId: wallet!.id, accountId: account!.id, snapshot, asOf: TODAY });
    // Fictional accumulation history: smaller holdings in earlier months.
    const history = months.slice(0, -1).flatMap((m, i) =>
      snapshot.holdings.map((h) => {
        const factor = new D(0.62).plus(new D(i).times(0.03));
        return {
          user_id: userId,
          wallet_id: wallet!.id,
          asset_id: assetIds.get(`${h.network}|${h.contractAddress ? h.contractAddress.toLowerCase() : "native"}`)!,
          as_of: monthEnd(m),
          quantity: dbNumeric(toPlain(dec(h.quantity).times(D.min(factor, 1)).toDecimalPlaces(8))),
        };
      }),
    );
    if (history.length) await admin.from("wallet_holdings").upsert(history, { onConflict: "wallet_id,asset_id,as_of", ignoreDuplicates: true });
    console.log(`  wallet ${w.label}: ${snapshot.holdings.length} assets, ${snapshot.transactions.length} on-chain tx`);
  }

  // Same post-processing as real imports ------------------------------------------
  const stats = await postProcessUser(admin, userId, { today: TODAY });
  console.log("  post-processing:", stats);
}

async function seedIsolationUser(userId: string) {
  const { data: personal } = await admin.from("financial_entities").select("id").eq("user_id", userId).eq("kind", "personal").single();
  const { data: inst } = await admin.from("institutions").select("id").eq("slug", "wise").is("owner_id", null).single();
  const { data: account } = await admin
    .from("accounts")
    .insert({ user_id: userId, entity_id: personal!.id, institution_id: inst?.id ?? null, name: "Wise EUR", type: "checking", currency: "EUR", sync_source: "seed", last_synced_at: new Date().toISOString() })
    .select("id")
    .single();
  const rows = [
    { d: addDaysIso(TODAY, -3), desc: "ISOLATION TEST GROCERIES", a: "-42.10" },
    { d: addDaysIso(TODAY, -2), desc: "ISOLATION TEST SALARY", a: "1000.00" },
  ];
  const fps = computeFingerprints(rows.map((r) => ({ bookedOn: r.d, amount: r.a, currency: "EUR", description: r.desc })));
  await admin.from("transactions").insert(
    rows.map((r, i) => ({ user_id: userId, account_id: account!.id, booked_on: r.d, description_original: r.desc, amount: dbNumeric(r.a), currency: "EUR", fingerprint: fps[i]!, source: "seed" as const })),
  );
  await admin.from("account_balances").insert({ user_id: userId, account_id: account!.id, as_of: TODAY, balance: dbNumeric("957.90"), currency: "EUR", source: "seed" });
}

async function main() {
  console.log(`Seeding Monio DEV (fictional data), anchor date ${TODAY}`);
  await seedRates();
  const demoId = await resetUser(DEMO.email, DEMO.name);
  console.log(`- ${DEMO.email}`);
  await seedDemoUser(demoId);
  const isoId = await resetUser(ISOLATION.email, ISOLATION.name);
  console.log(`- ${ISOLATION.email}`);
  await seedIsolationUser(isoId);
  console.log(`Done. Sign in with ${DEMO.email} / ${DEMO_PASSWORD}`);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
