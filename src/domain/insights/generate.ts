import type { Breakdown, MonthFlow } from "../analytics/cashflow";
import type { NetWorthPoint } from "../analytics/net-worth-history";
import { addDaysIso, addMonthsToKey, isMonthComplete, monthEnd, monthKey, monthStart } from "../analytics/periods";
import { dec, toPlain, toScale } from "../money/decimal";
import type { RecurringSeriesCandidate } from "../transactions/recurring";

export type InsightSeverity = "info" | "positive" | "warning";

export interface InsightDraft {
  kind:
    | "category_spend_change"
    | "subscription_price_change"
    | "upcoming_recurring"
    | "fx_effect"
    | "savings_rate"
    | "negative_cashflow";
  severity: InsightSeverity;
  periodStart?: string;
  periodEnd?: string;
  /** Values interpolated into the translated sentence (strings for amounts). */
  params: Record<string, string | number>;
  /** What the conclusion is derived from (aggregates, ids) — for traceability. */
  evidence: Record<string, unknown>;
  fingerprint: string;
}

export interface InsightInput {
  today: string;
  currency: string;
  /** Latest date for which imported data is available across active accounts. */
  dataCoveredUntil: string | null;
  /** Expense breakdown by category per month key ("YYYY-MM"). */
  categoryExpensesByMonth: Record<string, Breakdown[]>;
  monthlyTotals: MonthFlow[];
  recurring: (RecurringSeriesCandidate & { id?: string })[];
  /** Two or more net-worth points; first = start of comparison window, last = now. */
  netWorthWindow: NetWorthPoint[];
  thresholds?: { minCategoryDelta?: string; minCategoryChangePct?: number };
}

function pct(previous: string, current: string): number | null {
  const p = dec(previous);
  if (p.isZero()) return null;
  return Number(dec(current).minus(p).dividedBy(p.abs()).times(100).toFixed(1));
}

/**
 * Deterministic, evidence-based insights. Every insight carries the numbers it
 * was computed from; nothing is inferred beyond the data. Month comparisons only
 * use complete months (ended and fully covered by imported data).
 */
export function generateInsights(input: InsightInput): InsightDraft[] {
  const out: InsightDraft[] = [];
  const minDelta = dec(input.thresholds?.minCategoryDelta ?? "25");
  const minPct = input.thresholds?.minCategoryChangePct ?? 20;

  // 1. Category spending: last complete month vs. the one before.
  const currentKey = monthKey(input.today);
  let lastComplete: string | null = null;
  for (let k = addMonthsToKey(currentKey, -1), i = 0; i < 3; i++, k = addMonthsToKey(k, -1)) {
    if (isMonthComplete(k, input.today, input.dataCoveredUntil)) {
      lastComplete = k;
      break;
    }
  }
  if (lastComplete) {
    const prevKey = addMonthsToKey(lastComplete, -1);
    const current = input.categoryExpensesByMonth[lastComplete] ?? [];
    const previous = input.categoryExpensesByMonth[prevKey] ?? [];
    if (current.length > 0 && previous.length > 0) {
      const prevMap = new Map(previous.map((b) => [b.key, b]));
      const changes = current
        .filter((b) => b.key !== "uncategorized" && prevMap.has(b.key))
        .map((b) => {
          const prev = prevMap.get(b.key)!;
          return { key: b.key, current: b.amount, previous: prev.amount, delta: dec(b.amount).minus(dec(prev.amount)), pct: pct(prev.amount, b.amount) };
        })
        .filter((c) => c.pct !== null && Math.abs(c.pct) >= minPct && c.delta.abs().greaterThanOrEqualTo(minDelta))
        .sort((a, b) => b.delta.abs().comparedTo(a.delta.abs()))
        .slice(0, 2);
      for (const c of changes) {
        const increased = c.delta.isPositive();
        out.push({
          kind: "category_spend_change",
          severity: increased ? "warning" : "positive",
          periodStart: monthStart(lastComplete),
          periodEnd: monthEnd(lastComplete),
          params: {
            category: c.key,
            direction: increased ? "up" : "down",
            changePct: Math.abs(c.pct!),
            current: toScale(c.current, 2),
            previous: toScale(c.previous, 2),
            currency: input.currency,
            month: lastComplete,
            previousMonth: prevKey,
          },
          evidence: { month: lastComplete, previousMonth: prevKey, current: c.current, previous: c.previous, currency: input.currency },
          fingerprint: `category_spend_change|${lastComplete}|${c.key}`,
        });
      }
    }

    // 2. Savings rate / negative cash flow for the last complete month.
    const totals = input.monthlyTotals.find((m) => m.month === lastComplete);
    if (totals && dec(totals.income).isPositive()) {
      const rate = Number(dec(totals.net).dividedBy(dec(totals.income)).times(100).toFixed(1));
      if (dec(totals.net).isNegative()) {
        out.push({
          kind: "negative_cashflow",
          severity: "warning",
          periodStart: monthStart(lastComplete),
          periodEnd: monthEnd(lastComplete),
          params: { month: lastComplete, net: toScale(totals.net, 2), currency: input.currency },
          evidence: { ...totals, currency: input.currency },
          fingerprint: `negative_cashflow|${lastComplete}`,
        });
      } else if (rate >= 10) {
        out.push({
          kind: "savings_rate",
          severity: rate >= 20 ? "positive" : "info",
          periodStart: monthStart(lastComplete),
          periodEnd: monthEnd(lastComplete),
          params: { month: lastComplete, rate, net: toScale(totals.net, 2), currency: input.currency },
          evidence: { ...totals, currency: input.currency },
          fingerprint: `savings_rate|${lastComplete}`,
        });
      }
    }
  }

  // 3. Subscription price changes (latest charge vs. the previous one).
  for (const s of input.recurring) {
    if (!s.isSubscription || !s.previousAmount || !s.lastChange) continue;
    const change = Number(dec(s.lastChange).times(100).toFixed(1));
    if (Math.abs(change) < 1) continue;
    out.push({
      kind: "subscription_price_change",
      severity: change > 0 ? "warning" : "positive",
      periodEnd: s.lastSeenOn,
      params: {
        merchant: s.merchant,
        previous: toScale(s.previousAmount, 2),
        current: toScale(s.lastAmount, 2),
        currency: s.currency,
        changePct: change,
      },
      evidence: { seriesKey: s.key, seriesId: s.id ?? null, transactionIds: s.transactionIds.slice(-2) },
      fingerprint: `subscription_price_change|${s.key}|${s.lastSeenOn}`,
    });
  }

  // 4. Recurring payments expected in the next 7 days.
  const horizon = addDaysIso(input.today, 7);
  const upcoming = input.recurring.filter((s) => s.nextExpectedOn >= input.today && s.nextExpectedOn <= horizon);
  if (upcoming.length > 0) {
    const byCurrency = new Map<string, string>();
    for (const s of upcoming) byCurrency.set(s.currency, toPlain(dec(byCurrency.get(s.currency) ?? "0").plus(dec(s.lastAmount))));
    out.push({
      kind: "upcoming_recurring",
      severity: "info",
      periodStart: input.today,
      periodEnd: horizon,
      params: { count: upcoming.length, days: 7, merchants: upcoming.slice(0, 3).map((s) => s.merchant).join(", ") },
      evidence: {
        series: upcoming.map((s) => ({ key: s.key, id: s.id ?? null, nextExpectedOn: s.nextExpectedOn, amount: s.lastAmount, currency: s.currency })),
        totalsByCurrency: Object.fromEntries(byCurrency),
      },
      fingerprint: `upcoming_recurring|${input.today}`,
    });
  }

  // 5. Exchange-rate effect on wealth over the window.
  const first = input.netWorthWindow[0];
  const last = input.netWorthWindow[input.netWorthWindow.length - 1];
  if (first && last && first !== last) {
    const total = dec(last.netWorth).minus(dec(first.netWorth));
    // Holdings change valued at constant (final) rates; the remainder is FX.
    const holdingsEffect = dec(last.netWorthAtConstantRates).minus(dec(first.netWorthAtConstantRates));
    const fxEffect = total.minus(holdingsEffect);
    const base = dec(last.netWorth).abs();
    if (!base.isZero() && fxEffect.abs().dividedBy(base).greaterThanOrEqualTo(0.005) && !total.isZero() && fxEffect.isPositive() === total.isPositive()) {
      out.push({
        kind: "fx_effect",
        severity: total.isPositive() ? "positive" : "warning",
        periodStart: first.date,
        periodEnd: last.date,
        params: {
          currency: input.currency,
          direction: total.isPositive() ? "up" : "down",
          total: toScale(total.abs(), 2),
          fxEffect: toScale(fxEffect.abs(), 2),
          share: Math.min(100, Number(fxEffect.abs().dividedBy(total.abs()).times(100).toFixed(0))),
        },
        evidence: { from: first, to: last },
        fingerprint: `fx_effect|${first.date}|${last.date}|${input.currency}`,
      });
    }
  }

  return out;
}
