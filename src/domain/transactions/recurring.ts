import { D, dec, toPlain } from "../money/decimal";
import { normalizeDescription } from "./normalize";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export interface RecurringInput {
  id: string;
  accountId: string;
  bookedOn: string;
  amount: string;
  currency: string;
  description: string;
  merchant?: string | null;
  categorySlug?: string | null;
  classification?: string;
  duplicateOf?: string | null;
}

export interface RecurringSeriesCandidate {
  key: string;
  accountId: string;
  merchant: string;
  currency: string;
  cadence: Cadence;
  transactionIds: string[];
  occurrences: number;
  firstSeenOn: string;
  lastSeenOn: string;
  nextExpectedOn: string;
  averageAmount: string;
  lastAmount: string;
  previousAmount: string | null;
  /** Relative change of the latest amount vs. the previous one (e.g. 0.1 = +10%). */
  lastChange: string | null;
  isSubscription: boolean;
  confidence: number;
}

const CADENCES: { cadence: Cadence; days: number; tolerance: number; minOccurrences: number }[] = [
  { cadence: "weekly", days: 7, tolerance: 1.5, minOccurrences: 4 },
  { cadence: "monthly", days: 30.4, tolerance: 4, minOccurrences: 3 },
  { cadence: "quarterly", days: 91.3, tolerance: 8, minOccurrences: 3 },
  { cadence: "yearly", days: 365, tolerance: 12, minOccurrences: 2 },
];

const SUBSCRIPTION_CATEGORIES = new Set(["subscriptions", "telecom", "utilities", "insurance", "housing"]);

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + Math.round(days) * 86_400_000).toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, dim));
  return target.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Groups outflows by merchant (or description stem) and detects regular cadences. */
export function detectRecurring(transactions: RecurringInput[], options: { asOf?: string } = {}): RecurringSeriesCandidate[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const tx of transactions) {
    if (tx.duplicateOf) continue;
    if (tx.classification && tx.classification !== "regular") continue;
    if (!dec(tx.amount).isNegative()) continue;
    const label = tx.merchant?.trim() || normalizeDescription(tx.description).split(" ").slice(0, 3).join(" ");
    if (!label) continue;
    const key = `${tx.accountId}|${label.toUpperCase()}|${tx.currency}`;
    const list = groups.get(key) ?? [];
    list.push(tx);
    groups.set(key, list);
  }

  const out: RecurringSeriesCandidate[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.bookedOn.localeCompare(b.bookedOn));
    const intervals: number[] = [];
    for (let i = 1; i < list.length; i++) intervals.push(dayNumber(list[i]!.bookedOn) - dayNumber(list[i - 1]!.bookedOn));
    if (intervals.some((d) => d === 0)) {
      // Same-day repeats are not a cadence; drop exact same-day duplicates from the analysis.
      continue;
    }
    const med = median(intervals);
    const match = CADENCES.find((c) => Math.abs(med - c.days) <= c.tolerance);
    if (!match || list.length < match.minOccurrences) continue;
    const regular = intervals.filter((d) => Math.abs(d - match.days) <= match.tolerance * 1.5).length / intervals.length;
    if (regular < 0.7) continue;

    const amounts = list.map((t) => dec(t.amount).abs());
    const avg = amounts.reduce((a, b) => a.plus(b), new D(0)).dividedBy(amounts.length);
    const maxDev = amounts.reduce((m, a) => D.max(m, a.minus(avg).abs().dividedBy(avg)), new D(0));
    if (maxDev.greaterThan(0.35)) continue; // amounts too irregular to be a recurring payment

    const last = list[list.length - 1]!;
    const prev = list.length > 1 ? list[list.length - 2]! : null;
    const lastAmount = dec(last.amount).abs();
    const prevAmount = prev ? dec(prev.amount).abs() : null;
    const change = prevAmount && !prevAmount.isZero() ? lastAmount.minus(prevAmount).dividedBy(prevAmount) : null;

    const nextExpectedOn =
      match.cadence === "monthly"
        ? addMonths(last.bookedOn, 1)
        : match.cadence === "quarterly"
          ? addMonths(last.bookedOn, 3)
          : match.cadence === "yearly"
            ? addMonths(last.bookedOn, 12)
            : addDays(last.bookedOn, 7);

    const category = last.categorySlug ?? null;
    const confidence = Math.min(0.99, 0.5 + 0.1 * Math.min(list.length, 4) + (regular - 0.7) * 0.5 - maxDev.toNumber() * 0.3);
    out.push({
      key,
      accountId: last.accountId,
      merchant: last.merchant?.trim() || normalizeDescription(last.description).split(" ").slice(0, 3).join(" "),
      currency: last.currency,
      cadence: match.cadence,
      transactionIds: list.map((t) => t.id),
      occurrences: list.length,
      firstSeenOn: list[0]!.bookedOn,
      lastSeenOn: last.bookedOn,
      nextExpectedOn,
      averageAmount: toPlain(avg.toDecimalPlaces(8)),
      lastAmount: toPlain(lastAmount),
      previousAmount: prevAmount ? toPlain(prevAmount) : null,
      lastChange: change ? toPlain(change.toDecimalPlaces(4)) : null,
      isSubscription: !!category && SUBSCRIPTION_CATEGORIES.has(category) && match.cadence !== "weekly",
      confidence: Math.round(confidence * 1000) / 1000,
    });
  }
  const asOf = options.asOf;
  return out
    .filter((s) => !asOf || dayNumber(asOf) - dayNumber(s.lastSeenOn) <= (s.cadence === "yearly" ? 400 : 75))
    .sort((a, b) => a.nextExpectedOn.localeCompare(b.nextExpectedOn));
}
