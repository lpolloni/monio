import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { computeCashflow, type FlowTransaction } from "@/domain/analytics/cashflow";
import { computeNetWorthHistory } from "@/domain/analytics/net-worth-history";
import { addDaysIso, addMonthsToKey, monthEnd, monthKey, monthStart } from "@/domain/analytics/periods";
import { FxTable } from "@/domain/fx/fx-table";
import type { AccountType } from "@/domain/import/types";
import { generateInsights } from "@/domain/insights/generate";
import { findPossibleDuplicates, matchTransfers, type MatchableTransaction } from "@/domain/transactions/matching";
import { detectRecurring } from "@/domain/transactions/recurring";
import { accountLabel } from "@/lib/institutions";
import type { Json } from "../supabase/database.types";
import { dbNumeric } from "../supabase/numeric";
import type { MonioClient } from "../supabase/server";
import { loadAccounts, loadRates, type AccountRecord } from "../data/finance";
import { loadCategories, loadTransactionsInRange, toFlow, type TransactionRow } from "../data/transactions";

export interface PostProcessOptions {
  today: string;
  /** Transactions just imported: duplicate checks focus on them. Omit for a full scan. */
  scopeTransactionIds?: string[];
  /** Days of history considered for transfers/recurring/insights. */
  historyDays?: number;
  displayCurrency?: string;
}

export interface PostProcessStats {
  transfersLinked: number;
  transferQuestions: number;
  duplicateQuestions: number;
  recurringSeries: number;
  subscriptionQuestions: number;
  uncategorizedQuestions: number;
  staleSources: number;
  insights: number;
}

function hash(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value))).slice(0, 40);
}

async function applyUpdates(db: MonioClient, updates: Record<string, Json>[]) {
  for (let i = 0; i < updates.length; i += 2000) {
    const { error } = await db.rpc("apply_transaction_updates", { p_updates: updates.slice(i, i + 2000) as Json });
    if (error) throw error;
  }
}

const UNCATEGORIZED_BATCH = 8;

async function upsertInbox(
  db: MonioClient,
  userId: string,
  items: {
    kind: string;
    dedupe_key: string;
    priority: number;
    payload: { [key: string]: Json | undefined };
    transaction_ids?: string[];
    account_id?: string | null;
    document_id?: string | null;
    recurring_series_id?: string | null;
  }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const { data, error } = await db
    .from("inbox_items")
    .upsert(
      items.map((i) => ({ ...i, user_id: userId, transaction_ids: i.transaction_ids ?? [] })),
      { onConflict: "user_id,dedupe_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Runs after every import (and on the dev seed): reconciles transfers, flags
 * possible duplicates, detects recurring payments, raises Smart Inbox questions
 * for anything uncertain and regenerates insights. Idempotent: inbox items are
 * keyed by stable dedupe keys and series/insights by fingerprints.
 *
 * Works with a user-scoped (RLS) client; every query is also filtered by user id
 * so it is equally safe with the service-role client used by the worker/seed.
 */
export async function postProcessUser(db: MonioClient, userId: string, options: PostProcessOptions): Promise<PostProcessStats> {
  const today = options.today;
  const historyDays = options.historyDays ?? 400;
  const from = addDaysIso(today, -historyDays);
  const stats: PostProcessStats = {
    transfersLinked: 0,
    transferQuestions: 0,
    duplicateQuestions: 0,
    recurringSeries: 0,
    subscriptionQuestions: 0,
    uncategorizedQuestions: 0,
    staleSources: 0,
    insights: 0,
  };

  const { data: profile } = await db.from("profiles").select("primary_currency, include_business_in_net_worth").eq("id", userId).single();
  const displayCurrency = options.displayCurrency ?? profile?.primary_currency ?? "EUR";
  const includeBusiness = profile?.include_business_in_net_worth ?? false;

  const [accounts, categories, rates] = await Promise.all([
    loadAccounts(db, userId).then((list) => list.filter((a) => !a.isArchived)),
    loadCategories(db, userId),
    loadRates(db, addDaysIso(from, -10), today),
  ]);
  const fx = new FxTable(rates);
  const accountById = new Map(accounts.map((a) => [a.accountId, a]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const systemCategory = new Map(categories.filter((c) => c.isSystem).map((c) => [c.slug, c.id]));
  let transactions = (await loadTransactionsInRange(db, userId, from, today)).filter((t) => accountById.has(t.accountId));

  const matchable = (t: TransactionRow): MatchableTransaction => ({
    id: t.id,
    accountId: t.accountId,
    accountType: (accountById.get(t.accountId)?.type ?? "other") as AccountType,
    bookedOn: t.bookedOn,
    amount: t.amount,
    currency: t.currency,
    description: t.description,
    classification: t.classification,
    duplicateOf: t.duplicateOf,
    transferGroupId: t.transferGroupId,
  });

  // 1. Transfers between own accounts.
  // Decisions the user already gave for an account pair (Smart Inbox) are reused.
  const { data: pairDecisions } = await db
    .from("inbox_items")
    .select("dedupe_key, resolution")
    .eq("user_id", userId)
    .eq("kind", "transfer_match")
    .eq("status", "resolved")
    .like("dedupe_key", "transfer_pair:%");
  const decisionByPair = new Map(
    (pairDecisions ?? []).map((d) => {
      const r = d.resolution as { decision?: string } | null;
      return [d.dedupe_key, r?.decision ?? null] as const;
    }),
  );
  const transferCandidates = transactions.filter((t) => t.classification === "regular" && !t.transferGroupId && !t.duplicateOf);
  const matches = matchTransfers(transferCandidates.map(matchable), { fx });
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const updates: Record<string, Json>[] = [];
  const questions: Parameters<typeof upsertInbox>[2] = [];
  const askedPairs = new Set<string>();
  // Transactions waiting for the user's transfer decision are not asked about again (e.g. as uncategorized).
  const awaitingTransferDecision = new Set<string>();
  for (const m of matches) {
    const out = txById.get(m.outgoingId)!;
    const inc = txById.get(m.incomingId)!;
    const outAcc = accountById.get(out.accountId);
    const inAcc = accountById.get(inc.accountId);
    // Money between personal and business is income/expense for each side unless the user says otherwise.
    // Personal <-> shared household moves stay within the user's own wealth.
    const crossEntity = (outAcc?.entityKind === "business") !== (inAcc?.entityKind === "business");
    const pairKey = `transfer_pair:${out.accountId}:${inc.accountId}`;
    const decision = decisionByPair.get(pairKey);
    if (decision === "not_transfer") {
      // Money between personal and business that the user says is not a transfer is
      // income on the personal side and an expense on the business side.
      if (crossEntity) {
        for (const [t, acc] of [
          [out, outAcc],
          [inc, inAcc],
        ] as const) {
          if (t.categoryId) continue;
          const slug = t.amount.startsWith("-") ? (acc?.entityKind === "business" ? "business_expenses" : "other_expense") : acc?.entityKind === "business" ? "business_income" : "salary";
          const categoryId = systemCategory.get(slug);
          if (!categoryId) continue;
          updates.push({ id: t.id, category_id: categoryId, category_source: "user", category_confidence: 0.9 });
        }
      }
      continue;
    }
    if ((m.confidence === "high" && !crossEntity) || decision === "transfer") {
      const group = crypto.randomUUID();
      const slug = m.kind === "card_payment" ? "card_payment" : "internal_transfer";
      for (const [self, other] of [
        [out, inc],
        [inc, out],
      ] as const) {
        updates.push({
          id: self.id,
          classification: m.kind,
          transfer_group_id: group,
          counterpart_transaction_id: other.id,
          category_id: systemCategory.get(slug) ?? null,
          category_source: decision === "transfer" ? "user" : "rule",
          category_confidence: decision === "transfer" ? 1 : 0.95,
        });
      }
      stats.transfersLinked++;
    } else {
      awaitingTransferDecision.add(out.id).add(inc.id);
      // One question per account pair; the answer is remembered for future matches.
      if (askedPairs.has(pairKey)) continue;
      askedPairs.add(pairKey);
      questions.push({
        kind: "transfer_match",
        dedupe_key: pairKey,
        priority: 70,
        transaction_ids: [out.id, inc.id],
        payload: {
          outgoingId: out.id,
          incomingId: inc.id,
          outAccountId: out.accountId,
          inAccountId: inc.accountId,
          outAmount: out.amount.replace("-", ""),
          outCurrency: out.currency,
          inAmount: inc.amount,
          inCurrency: inc.currency,
          fromAccount: accountLabel(outAcc?.institutionName, outAcc?.name),
          toAccount: accountLabel(inAcc?.institutionName, inAcc?.name),
          date: out.bookedOn,
          kind: m.kind,
          score: m.score,
          reasons: m.reasons,
          crossEntity,
        },
      });
      stats.transferQuestions++;
    }
  }

  // 2. Possible duplicates (focused on newly imported rows when a scope is given).
  const scope = options.scopeTransactionIds ? new Set(options.scopeTransactionIds) : null;
  const incoming = transactions.filter((t) => !t.duplicateOf && (!scope || scope.has(t.id))).map(matchable);
  const fingerprintless = transactions.filter((t) => !t.duplicateOf).map(matchable);
  const dupes = findPossibleDuplicates(incoming, fingerprintless);
  const seenPairs = new Set<string>();
  for (const d of dupes) {
    const key = [d.transactionId, d.duplicateOfId].sort().join(":");
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const tx = txById.get(d.transactionId)!;
    questions.push({
      kind: "possible_duplicate",
      dedupe_key: `duplicate:${key}`,
      priority: 60,
      transaction_ids: [d.transactionId, d.duplicateOfId],
      account_id: tx.accountId,
      payload: {
        transactionId: d.transactionId,
        duplicateOfId: d.duplicateOfId,
        description: tx.merchant ?? tx.description,
        amount: tx.amount,
        currency: tx.currency,
        date: tx.bookedOn,
        score: d.score,
        reasons: d.reasons,
      },
    });
    stats.duplicateQuestions++;
  }

  await applyUpdates(db, updates);
  // Reflect classification changes locally for the next steps.
  for (const u of updates) {
    const t = txById.get(String(u.id));
    if (!t) continue;
    if (typeof u.classification === "string") t.classification = u.classification;
    if (typeof u.transfer_group_id === "string") t.transferGroupId = u.transfer_group_id;
    if ("category_id" in u) t.categoryId = (u.category_id as string | null) ?? t.categoryId;
  }
  transactions = [...txById.values()];

  // 3. Recurring payments.
  const recurring = detectRecurring(
    transactions.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      bookedOn: t.bookedOn,
      amount: t.amount,
      currency: t.currency,
      description: t.description,
      merchant: t.merchant,
      categorySlug: t.categoryId ? (categoryById.get(t.categoryId)?.slug ?? null) : null,
      classification: t.classification,
      duplicateOf: t.duplicateOf,
    })),
    { asOf: today },
  );
  const fingerprints = recurring.map((s) => hash(`series|${s.key}`));
  const { data: existingSeries } = fingerprints.length
    ? await db.from("recurring_series").select("id, fingerprint, status").eq("user_id", userId).in("fingerprint", fingerprints)
    : { data: [] as { id: string; fingerprint: string; status: string }[] };
  const existingByFp = new Map((existingSeries ?? []).map((s) => [s.fingerprint, s]));
  const seriesIds: (string | undefined)[] = [];
  const recurringUpdates: Record<string, Json>[] = [];
  for (const [i, s] of recurring.entries()) {
    const fp = fingerprints[i]!;
    const lastTx = txById.get(s.transactionIds[s.transactionIds.length - 1]!);
    const row = {
      user_id: userId,
      account_id: s.accountId,
      merchant: s.merchant.slice(0, 80),
      category_id: lastTx?.categoryId ?? null,
      cadence: s.cadence,
      average_amount: dbNumeric(s.averageAmount),
      last_amount: dbNumeric(s.lastAmount),
      currency: s.currency,
      first_seen_on: s.firstSeenOn,
      last_seen_on: s.lastSeenOn,
      next_expected_on: s.nextExpectedOn,
      occurrences: s.occurrences,
      is_subscription: s.isSubscription,
      detection_confidence: s.confidence,
      fingerprint: fp,
    };
    const existing = existingByFp.get(fp);
    let id: string | undefined = existing?.id;
    if (existing) {
      const { error } = await db.from("recurring_series").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      const { data, error } = await db.from("recurring_series").insert(row).select("id").single();
      if (error) throw error;
      id = data.id;
      const slug = lastTx?.categoryId ? categoryById.get(lastTx.categoryId)?.slug : null;
      // Clear subscriptions (subscription category) need no question; ask only when ambiguous.
      if (s.isSubscription && s.confidence >= 0.7 && slug !== "subscriptions") {
        questions.push({
          kind: "subscription_candidate",
          dedupe_key: `subscription:${fp}`,
          priority: 40,
          recurring_series_id: id,
          account_id: s.accountId,
          payload: { seriesId: id, merchant: s.merchant, amount: s.lastAmount, currency: s.currency, cadence: s.cadence },
        });
        stats.subscriptionQuestions++;
      }
    }
    seriesIds.push(id);
    for (const txId of s.transactionIds) {
      if (txById.get(txId)?.recurringSeriesId !== id) recurringUpdates.push({ id: txId, recurring_series_id: id ?? null });
    }
  }
  await applyUpdates(db, recurringUpdates);
  stats.recurringSeries = recurring.length;

  // 4a. Deterministic default: uncategorized money coming into a business account is business income.
  const defaults: Record<string, Json>[] = [];
  const businessIncomeId = systemCategory.get("business_income");
  for (const t of transactions) {
    if (t.categoryId || t.classification !== "regular" || t.amount.startsWith("-")) continue;
    if (accountById.get(t.accountId)?.entityKind !== "business" || !businessIncomeId) continue;
    defaults.push({ id: t.id, category_id: businessIncomeId, category_source: "default", category_confidence: 0.6 });
    t.categoryId = businessIncomeId;
  }
  await applyUpdates(db, defaults);

  // 4b. Uncategorized expenses worth asking about (largest first, a handful at a time).
  // Questions that no longer apply (categorized meanwhile) are closed; at most
  // UNCATEGORIZED_BATCH stay open so re-runs never flood the inbox.
  const { data: askedUncategorized } = await db
    .from("inbox_items")
    .select("id, status, transaction_ids")
    .eq("user_id", userId)
    .eq("kind", "uncategorized")
    .limit(5000);
  const alreadyAsked = new Set<string>();
  const obsolete: string[] = [];
  let openUncategorized = 0;
  for (const item of askedUncategorized ?? []) {
    const txId = item.transaction_ids[0];
    if (txId) alreadyAsked.add(txId);
    if (item.status !== "open") continue;
    const tx = txId ? txById.get(txId) : undefined;
    if (!tx || tx.categoryId || tx.classification !== "regular" || tx.duplicateOf) obsolete.push(item.id);
    else openUncategorized++;
  }
  if (obsolete.length) {
    const { error } = await db
      .from("inbox_items")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution: { decision: "auto", reason: "no_longer_applies" } })
      .in("id", obsolete)
      .eq("user_id", userId);
    if (error) throw error;
  }
  const uncategorized = transactions
    .filter((t) => !t.categoryId && t.classification === "regular" && !t.duplicateOf && t.amount.startsWith("-"))
    .filter((t) => (!scope || scope.has(t.id)) && !alreadyAsked.has(t.id) && !awaitingTransferDecision.has(t.id))
    .sort((a, b) => Number(a.amount) - Number(b.amount)) // ordering only
    .slice(0, Math.max(0, UNCATEGORIZED_BATCH - openUncategorized));
  for (const t of uncategorized) {
    questions.push({
      kind: "uncategorized",
      dedupe_key: `uncategorized:${t.id}`,
      priority: 30,
      transaction_ids: [t.id],
      account_id: t.accountId,
      payload: { transactionId: t.id, description: t.description, amount: t.amount, currency: t.currency, date: t.bookedOn },
    });
    stats.uncategorizedQuestions++;
  }

  // 5. Outdated sources (imported balances older than 30 days).
  const staleLimit = addDaysIso(today, -30);
  for (const a of accounts) {
    if (a.type === "crypto_wallet") continue;
    const last = (a.lastSyncedAt ?? a.balanceAsOf ?? "").slice(0, 10);
    if (last && last < staleLimit) {
      questions.push({
        kind: "stale_source",
        dedupe_key: `stale:${a.accountId}:${last}`,
        priority: 20,
        account_id: a.accountId,
        payload: { account: accountLabel(a.institutionName, a.name), date: last },
      });
      stats.staleSources++;
    }
  }

  await upsertInbox(db, userId, questions);

  // 6. Insights (deterministic, evidence-based).
  stats.insights = await regenerateInsights(db, userId, {
    today,
    displayCurrency,
    includeBusiness,
    accounts,
    transactions,
    fx,
    recurring: recurring.map((s, i) => ({ ...s, id: seriesIds[i] })),
    categoryById,
  });
  return stats;
}

async function regenerateInsights(
  db: MonioClient,
  userId: string,
  ctx: {
    today: string;
    displayCurrency: string;
    includeBusiness: boolean;
    accounts: AccountRecord[];
    transactions: TransactionRow[];
    fx: FxTable;
    recurring: Parameters<typeof generateInsights>[0]["recurring"];
    categoryById: Map<string, Awaited<ReturnType<typeof loadCategories>>[number]>;
  },
): Promise<number> {
  const accountById = new Map(ctx.accounts.map((a) => [a.accountId, a]));
  const flows: FlowTransaction[] = ctx.transactions.map((t) => toFlow(t, accountById, ctx.categoryById));
  const current = monthKey(ctx.today);
  const lastMonth = addMonthsToKey(current, -1);
  const months = [addMonthsToKey(current, -3), addMonthsToKey(current, -2), lastMonth];
  // Data coverage per account: the latest statement/import date we hold for it.
  const coverage = new Map<string, string>();
  for (const t of ctx.transactions) if (t.bookedOn > (coverage.get(t.accountId) ?? "")) coverage.set(t.accountId, t.bookedOn);
  for (const a of ctx.accounts) {
    const synced = (a.lastSyncedAt ?? "").slice(0, 10);
    if (synced > (coverage.get(a.accountId) ?? "")) coverage.set(a.accountId, synced);
  }
  // Month comparisons only use accounts whose data covers the whole compared period;
  // an outdated source would otherwise look like a drop in spending.
  const activeAccounts = [...new Set(flows.filter((f) => f.bookedOn >= monthStart(months[0]!)).map((f) => f.accountId))];
  const covered = new Set(activeAccounts.filter((id) => (coverage.get(id) ?? "") >= monthEnd(lastMonth)));
  const excluded = activeAccounts.filter((id) => !covered.has(id));
  const comparableFlows = flows.filter((f) => covered.has(f.accountId));
  const categoryExpensesByMonth: Record<string, { key: string; amount: string; count: number }[]> = {};
  const monthlyTotals = [];
  for (const m of months) {
    const cf = computeCashflow(comparableFlows, ctx.fx, ctx.displayCurrency, {
      from: monthStart(m),
      to: monthEnd(m),
      includeBusiness: ctx.includeBusiness,
    });
    categoryExpensesByMonth[m] = cf.expensesByCategory;
    monthlyTotals.push(...cf.byMonth);
  }
  const dataCoveredUntil = covered.size > 0 ? monthEnd(lastMonth) : null;
  const coverageEvidence = {
    accountsCompared: covered.size,
    accountsExcludedForIncompleteData: excluded.map((id) => {
      const a = accountById.get(id);
      return { id, name: accountLabel(a?.institutionName, a?.name), coveredUntil: coverage.get(id) ?? null };
    }),
  };

  // Net worth 30 days ago vs today from balance snapshots and holdings.
  const accountIds = ctx.accounts.map((a) => a.accountId);
  const { data: balances } = accountIds.length
    ? await db
        .from("account_balances")
        .select("account_id, as_of, balance:balance::text, currency")
        .eq("user_id", userId)
        .in("account_id", accountIds)
        .gte("as_of", addDaysIso(ctx.today, -400))
        .order("as_of", { ascending: true })
        .limit(5000)
    : { data: [] as { account_id: string; as_of: string; balance: string; currency: string }[] };
  const holdings = ctx.accounts.flatMap((a) =>
    (a.holdings ?? []).map((h) => ({ accountId: a.accountId, asOf: "1970-01-01", currency: h.currency, quantity: h.quantity })),
  );
  const window = computeNetWorthHistory(
    ctx.accounts.map((a) => ({ accountId: a.accountId, entityKind: a.entityKind, includeInNetWorth: a.includeInNetWorth, isCrypto: a.type === "crypto_wallet" })),
    (balances ?? []).map((b) => ({ accountId: b.account_id, asOf: b.as_of, balance: b.balance, currency: b.currency })),
    holdings,
    ctx.fx,
    ctx.displayCurrency,
    [addDaysIso(ctx.today, -30), ctx.today],
    { includeBusiness: ctx.includeBusiness },
  );

  const drafts = generateInsights({
    today: ctx.today,
    currency: ctx.displayCurrency,
    dataCoveredUntil,
    categoryExpensesByMonth,
    monthlyTotals,
    recurring: ctx.recurring,
    netWorthWindow: window,
    coverageEvidence,
  });
  if (drafts.length === 0) return 0;
  const { error } = await db.from("insights").upsert(
    drafts.map((d) => ({
      user_id: userId,
      kind: d.kind,
      severity: d.severity,
      period_start: d.periodStart ?? null,
      period_end: d.periodEnd ?? null,
      params: d.params as { [key: string]: Json },
      evidence: d.evidence as { [key: string]: Json },
      fingerprint: d.fingerprint,
      generated_at: new Date().toISOString(),
    })),
    { onConflict: "user_id,fingerprint" },
  );
  if (error) throw error;
  return drafts.length;
}
