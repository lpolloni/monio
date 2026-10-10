import type { FxTable } from "../fx/fx-table";
import type { AccountType } from "../import/types";
import { dec } from "../money/decimal";
import { descriptionSimilarity, normalizeDescription } from "./normalize";

export interface MatchableTransaction {
  id: string;
  accountId: string;
  accountType: AccountType;
  bookedOn: string;
  amount: string;
  currency: string;
  description: string;
  fingerprint?: string;
  classification?: string;
  duplicateOf?: string | null;
  transferGroupId?: string | null;
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Possible duplicates
// ---------------------------------------------------------------------------

export interface DuplicateCandidate {
  transactionId: string;
  duplicateOfId: string;
  score: number;
  reasons: string[];
}

/**
 * Flags rows that look like the same real-world transaction imported twice with
 * slightly different data (e.g. pending vs posted, different statement layouts).
 * Exact re-imports never get here: they share fingerprints and are skipped.
 * Candidates are reported for confirmation; nothing is deleted automatically.
 */
export function findPossibleDuplicates(
  incoming: MatchableTransaction[],
  existing: MatchableTransaction[],
  options: { maxDayGap?: number; minSimilarity?: number } = {},
): DuplicateCandidate[] {
  const maxGap = options.maxDayGap ?? 3;
  const minSim = options.minSimilarity ?? 0.5;
  const byAccount = new Map<string, MatchableTransaction[]>();
  for (const tx of existing) {
    const list = byAccount.get(tx.accountId) ?? [];
    list.push(tx);
    byAccount.set(tx.accountId, list);
  }
  const results: DuplicateCandidate[] = [];
  const used = new Set<string>();
  for (const tx of incoming) {
    let best: DuplicateCandidate | null = null;
    for (const other of byAccount.get(tx.accountId) ?? []) {
      if (other.id === tx.id || used.has(other.id)) continue;
      if (other.fingerprint && other.fingerprint === tx.fingerprint) continue;
      if (other.currency !== tx.currency || !dec(other.amount).equals(dec(tx.amount))) continue;
      const gap = dayDiff(other.bookedOn, tx.bookedOn);
      if (gap > maxGap) continue;
      const sim = descriptionSimilarity(other.description, tx.description);
      if (sim < minSim) continue;
      const score = 0.5 + 0.3 * sim + 0.2 * (1 - gap / (maxGap + 1));
      if (!best || score > best.score) {
        best = {
          transactionId: tx.id,
          duplicateOfId: other.id,
          score: Math.round(score * 1000) / 1000,
          reasons: [`same amount ${tx.amount} ${tx.currency}`, `${gap} day(s) apart`, `description similarity ${sim.toFixed(2)}`],
        };
      }
    }
    if (best) {
      results.push(best);
      used.add(best.duplicateOfId);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Transfers between the user's own accounts
// ---------------------------------------------------------------------------

const TRANSFER_KEYWORDS = [
  "TRANSFER", "TRANSFERENCIA", "TRANSF", "PIX", "TED", "DOC ", "BONIFICO", "GIROCONTO", "GIRO",
  "TOP UP", "TOP-UP", "TOPUP", "RICARICA", "EXCHANGE", "SEPA", "WISE", "REVOLUT", "N26", "NUBANK",
];
const CARD_PAYMENT_KEYWORDS = [
  "PAGAMENTO DE FATURA", "PAGAMENTO FATURA", "PAGTO FATURA", "PAYMENT THANK YOU", "CARD PAYMENT",
  "PAGAMENTO CARTA", "SALDO CARTA", "ADDEBITO CARTA", "PAGAMENTO RECEBIDO",
];

export interface TransferMatch {
  outgoingId: string;
  incomingId: string;
  kind: "internal_transfer" | "card_payment";
  score: number;
  confidence: "high" | "medium";
  reasons: string[];
}

function hasKeyword(description: string, keywords: string[]): boolean {
  const norm = ` ${normalizeDescription(description)} `;
  return keywords.some((k) => norm.includes(k));
}

/**
 * Pairs an outflow in one account with an inflow in another account of the same
 * user. Exact same-currency amounts within `maxDayGap` days score highest;
 * cross-currency pairs are compared through the FX table with a tolerance (FX
 * spreads/fees). Matching is one-to-one and greedy by score.
 *
 * Conservative by design: "high" matches can be auto-classified; "medium"
 * matches must be confirmed by the user (Smart Inbox).
 */
export function matchTransfers(
  transactions: MatchableTransaction[],
  options: { fx?: FxTable; maxDayGap?: number; fxTolerance?: number } = {},
): TransferMatch[] {
  const maxGap = options.maxDayGap ?? 4;
  const tolerance = options.fxTolerance ?? 0.02;
  const eligible = transactions.filter((t) => !t.duplicateOf && !t.transferGroupId);
  const outs = eligible.filter((t) => dec(t.amount).isNegative());
  const ins = eligible.filter((t) => dec(t.amount).isPositive() && !dec(t.amount).isZero());

  const candidates: TransferMatch[] = [];
  for (const o of outs) {
    const outAbs = dec(o.amount).abs();
    for (const i of ins) {
      if (i.accountId === o.accountId) continue;
      const gap = dayDiff(o.bookedOn, i.bookedOn);
      if (gap > maxGap) continue;
      let amountScore = 0;
      const reasons: string[] = [];
      if (o.currency === i.currency) {
        if (!outAbs.equals(dec(i.amount))) continue;
        amountScore = 1;
        reasons.push("exact amount");
      } else if (options.fx) {
        const converted = options.fx.convert({ amount: outAbs.toString(), currency: o.currency }, i.currency, o.bookedOn);
        if (!converted) continue;
        const diff = dec(converted.amount).minus(dec(i.amount)).abs().dividedBy(dec(i.amount));
        if (diff.greaterThan(tolerance)) continue;
        amountScore = 0.8 - diff.toNumber() * 5; // deviation lowers the score
        reasons.push(`converted amount within ${(diff.toNumber() * 100).toFixed(2)}%`);
      } else {
        continue;
      }
      const isCard = i.accountType === "credit_card";
      const words = isCard ? CARD_PAYMENT_KEYWORDS : TRANSFER_KEYWORDS;
      const outWords = hasKeyword(o.description, words);
      const inWords = hasKeyword(i.description, words);
      const keyword = outWords || inWords;
      // Converted amounts match by coincidence too often: require transfer wording on both sides.
      if (o.currency !== i.currency && !(outWords && inWords)) continue;
      if (keyword) reasons.push("transfer wording");
      reasons.push(gap === 0 ? "same day" : `${gap} day(s) apart`);
      const score = 0.55 * amountScore + 0.25 * (1 - gap / (maxGap + 1)) + (keyword ? 0.2 : 0);
      candidates.push({
        outgoingId: o.id,
        incomingId: i.id,
        kind: isCard ? "card_payment" : "internal_transfer",
        score: Math.round(score * 1000) / 1000,
        confidence: score >= 0.85 && amountScore === 1 && keyword ? "high" : "medium",
        reasons,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const result: TransferMatch[] = [];
  for (const c of candidates) {
    if (c.score < 0.55) continue;
    if (used.has(c.outgoingId) || used.has(c.incomingId)) continue;
    used.add(c.outgoingId);
    used.add(c.incomingId);
    result.push(c);
  }
  return result;
}
