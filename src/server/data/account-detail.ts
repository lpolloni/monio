import "server-only";
import { dailyBalances, fillDaily } from "@/domain/analytics/balance-series";
import { addDaysIso } from "@/domain/analytics/periods";
import type { EntityKind } from "@/domain/accounts/classification";
import { computePortfolio } from "@/domain/portfolio/portfolio";
import { todayIso } from "./dates";
import type { AccountRecord } from "./finance";
import { getAccounts, getCategories, getFxTable } from "./queries";
import { getProfile, requireSession } from "./session";
import { loadAccountMovements, queryActivity } from "./transactions";

export interface AccountDetail {
  account: AccountRecord;
  currency: string;
  value: string | null;
  /** End-of-day balance on every day of the known history: statement balances walked through the movements. */
  balances: { date: string; balance: string; value: string | null }[];
  transactions: {
    id: string;
    bookedOn: string;
    description: string;
    merchant: string | null;
    amount: string;
    currency: string;
    converted: string | null;
    categorySlug: string | null;
    classification: string;
    status: string;
    duplicateOf: string | null;
  }[];
  transactionCount: number;
  documents: { id: string; filename: string; format: string | null; createdAt: string; status: string }[];
  liability: { principal: string | null; rate: string | null; monthly: string | null; maturity: string | null } | null;
  holdings: { symbol: string; name: string; network: string | undefined; quantity: string; value: string | null; isStablecoin: boolean }[];
  chainTransactions: { hash: string; network: string; direction: string; quantity: string; symbol: string; time: string; classification: string }[];
  entities: { id: string; name: string; kind: EntityKind }[];
}

export async function getAccountDetail(accountId: string): Promise<AccountDetail | null> {
  const [{ supabase, userId }, profile] = await Promise.all([requireSession(), getProfile()]);
  const accounts = await getAccounts();
  const account = accounts.find((a) => a.accountId === accountId);
  if (!account) return null;
  const today = todayIso();
  const historyFrom = addDaysIso(today, -430);
  const fx = await getFxTable(historyFrom, today);
  const currency = profile.primaryCurrency;
  const portfolio = computePortfolio([account], fx, currency, today, { includeBusiness: true });
  const valued = portfolio.accounts[0];

  const [{ data: balances }, movements, activity, categories, { data: liability }, { data: entities }] = await Promise.all([
    supabase
      .from("account_balances")
      .select("as_of, balance:balance::text, currency, source")
      .eq("account_id", accountId)
      .order("as_of", { ascending: true })
      .limit(500),
    account.wallet ? [] : loadAccountMovements(supabase, accountId, account.currency),
    queryActivity(supabase, { accountIds: [accountId], limit: 40, offset: 0 }),
    getCategories(),
    supabase
      .from("liability_details")
      .select("original_principal:original_principal::text, interest_rate_apr:interest_rate_apr::text, monthly_payment:monthly_payment::text, maturity_on")
      .eq("account_id", accountId)
      .maybeSingle(),
    supabase.from("financial_entities").select("id, name, kind").eq("user_id", userId).order("created_at", { ascending: true }),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, c.slug]));
  const snapshots = (balances ?? []).filter((b) => b.currency === account.currency).map((b) => ({ asOf: b.as_of, balance: b.balance }));

  const docIds = [...new Set(activity.rows.map((r) => r.documentId).filter((d): d is string => !!d))];
  const { data: documents } = docIds.length
    ? await supabase.from("documents").select("id, original_filename, detected_format, created_at, status").in("id", docIds)
    : { data: [] as { id: string; original_filename: string; detected_format: string | null; created_at: string; status: string }[] };

  let holdings: AccountDetail["holdings"] = [];
  let chainTransactions: AccountDetail["chainTransactions"] = [];
  if (account.wallet) {
    holdings = account.wallet.holdings.map((h) => ({
      symbol: h.symbol,
      name: h.name,
      network: h.network,
      quantity: h.quantity,
      value: fx.convert({ amount: h.quantity, currency: h.currency }, currency, today)?.amount ?? null,
      isStablecoin: h.isStablecoin,
    }));
    const { data: chainTx } = await supabase
      .from("blockchain_transactions")
      .select("tx_hash, network, direction, quantity:quantity::text, block_time, classification, asset:crypto_assets(symbol)")
      .eq("wallet_id", account.wallet.id)
      .eq("user_id", userId)
      .order("block_time", { ascending: false })
      .limit(30);
    chainTransactions = (chainTx ?? []).map((t) => {
      const asset = Array.isArray(t.asset) ? t.asset[0] : t.asset;
      return { hash: t.tx_hash, network: t.network, direction: t.direction, quantity: t.quantity, symbol: asset?.symbol ?? "", time: t.block_time, classification: t.classification };
    });
  }

  return {
    account,
    currency,
    value: valued?.value ?? null,
    balances: fillDaily(dailyBalances(snapshots, movements), historyFrom).map((b) => ({
      date: b.date,
      balance: b.balance,
      value: fx.convert({ amount: b.balance, currency: account.currency }, currency, b.date)?.amount ?? null,
    })),
    transactions: activity.rows.map((r) => ({
      id: r.id,
      bookedOn: r.bookedOn,
      description: r.description,
      merchant: r.merchant,
      amount: r.amount,
      currency: r.currency,
      converted: r.currency === currency ? null : (fx.convert({ amount: r.amount, currency: r.currency }, currency, r.bookedOn)?.amount ?? null),
      categorySlug: r.categoryId ? (categoryById.get(r.categoryId) ?? null) : null,
      classification: r.classification,
      status: r.status,
      duplicateOf: r.duplicateOf,
    })),
    transactionCount: activity.total,
    documents: (documents ?? []).map((d) => ({ id: d.id, filename: d.original_filename, format: d.detected_format, createdAt: d.created_at, status: d.status })),
    liability: liability
      ? { principal: liability.original_principal, rate: liability.interest_rate_apr, monthly: liability.monthly_payment, maturity: liability.maturity_on }
      : null,
    holdings,
    chainTransactions,
    entities: (entities ?? []).map((e) => ({ id: e.id, name: e.name, kind: e.kind as EntityKind })),
  };
}
