/** Full-document AI fallback. Proposals are pointers into source text, never trusted facts. */
import type { ParsedAccount, ParsedStatement, ParsedTransaction, ParseWarning } from "@/domain/import/types";
import { parseAmount } from "@/domain/import/parse-amount";
import { parseDate } from "@/domain/import/parse-date";
import { dec, sum, toPlain } from "@/domain/money/decimal";
import { isKnownCurrency } from "@/domain/money/currencies";
import type { DocumentBatch, DocumentLine } from "@/server/ai/document-contract";
import { amountTokensInLine, dateCandidatesInLine, fiatCurrenciesInText } from "@/server/ai/statement-validation";
import { findInstitutionByText } from "../institution-catalog";
import { fold, normalizeDescription } from "./text";
import type { ParserOutput } from "./types";

export interface DocumentAiResult { batches: DocumentBatch[]; skippedLines: number[] }
export type PdfDocumentAssist = (lines: DocumentLine[]) => Promise<DocumentAiResult>;
const compact = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");
const summary = /^(saldo|balance|opening|closing|total|subtotal|limite|minimum payment|pagamento minimo)\b/;
const debit = /\b(debit|debits|debito|debitos|saidas|uscite|dare|withdrawal|withdrawals|money out|sent|enviada|enviado|pagamento|payment|compra|purchase|aplicacao)\b/;
const credit = /\b(remuneracao|rendimento|recebido|recebidos|credit|credits|credito|creditos|entradas|entrate|avere|deposit|deposits|money in|received|recebida|recebido|refund|resgate)\b/;

function hasMagnitude(amount: string, text: string): boolean {
  // Account numbers, dates and integer reference numbers are not money evidence.
  return /\d[.,]\d{2}(?!\d)/.test(text) && amountTokensInLine(text).some(t => t.values.some(v => dec(v).abs().equals(dec(amount).abs())));
}
function monthPeriod(text: string): { start: string; end: string } | undefined {
  const m = /^\s*([A-Za-zÀ-ÿ]{3,12})\s*[/-]\s*(\d{4})\s*$/.exec(text);
  if (!m) return undefined;
  const start = parseDate(`1 ${m[1]} ${m[2]}`);
  if (!start) return undefined;
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return { start, end: d.toISOString().slice(0, 10) };
}
function hasPeriodDate(value: string, text: string): boolean {
  const p = monthPeriod(text);
  return hasDate(value, text) || !!p && (p.start === value || p.end === value);
}
function hasDate(value: string, text: string, period?: ParsedStatement["period"]): boolean {
  if (parseDate(value) !== value) return false;
  const dates = dateCandidatesInLine(text);
  if (dates.full.size) return dates.full.has(value);
  return !!period && value >= period.start && value <= period.end && dates.partial.has(value.slice(5));
}
function hasBalanceDate(value: string, text: string, period?: ParsedStatement["period"]): boolean {
  if (hasDate(value, text, period) || hasPeriodDate(value, text)) return true;
  if (!period) return false;
  const previous = new Date(`${period.start}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return value === previous.toISOString().slice(0, 10) && dateCandidatesInLine(text).partial.has(value.slice(5));
}
function isSummaryLine(text: string): boolean {
  const t = fold(text);
  return summary.test(t) || /\b(total de (entradas|saidas)|opening balance|closing balance|saldo (inicial|anterior|final|atual)|subtotal)\b/.test(t);
}
function withoutAmount(text: string, amount: string): string {
  return text.replace(/(?:R\$|US\$|EUR|BRL|USD|€|£)?\s*[-+]?\d[\d.,'’]*\d|[-+]?\d/g, token => {
    const parsed = parseAmount(token);
    return parsed && dec(parsed.amount).abs().equals(dec(amount).abs()) ? " " : token;
  });
}
function directionIn(text: string): "in" | "out" | undefined {
  const t = fold(text);
  if (/\b(remuneracao|rendimento)\b/.test(t)) return "in";
  if (debit.test(t) && !credit.test(t)) return "out";
  if (credit.test(t) && !debit.test(t)) return "in";
  return undefined;
}
function directionSupported(amount: string, amountLine: DocumentLine, evidence: DocumentLine, all: Map<number, DocumentLine>): boolean {
  const negative = dec(amount).isNegative();
  // A dash in an empty document/reference column is not a monetary minus.
  const signText = amountLine.items.length ? amountLine.items.filter((item, i, items) =>
    !(/^[-−–—]$/.test(item.text) && items[i + 1] && items[i + 1]!.x - item.x - item.width > 12)
  ).map(item => item.text).join(" ") : amountLine.text;
  const matching = amountTokensInLine(signText).filter(t => t.values.some(v => dec(v).abs().equals(dec(amount).abs())));
  if (matching.some(t => t.negative)) return negative; // Never reverse an explicit sign.
  const explicit = new RegExp(`\\+\\s*(?:R\\$\\s*)?\\d`).test(amountLine.text);
  if (explicit) return !negative;
  const ownDirection = directionIn(amountLine.text);
  if (ownDirection) return negative === (ownDirection === "out");
  // A directional header is evidence only if this amount is beneath that column.
  const columns = evidence.items.flatMap(item => {
    const direction = directionIn(item.text);
    return direction ? [{ center: item.x + item.width / 2, direction }] : [];
  });
  if (columns.some(c => c.direction === "in") && columns.some(c => c.direction === "out")) {
    const items = amountLine.items.filter(item => hasMagnitude(amount, item.text));
    if (items.length !== 1) return false;
    const center = items[0]!.x + items[0]!.width / 2;
    const nearest = [...columns].sort((a, b) => Math.abs(a.center - center) - Math.abs(b.center - center))[0]!;
    return Math.abs(nearest.center - center) < 80 && negative === (nearest.direction === "out");
  }
  if (evidence.line > amountLine.line || amountLine.line - evidence.line > 120) return false;
  const direction = directionIn(evidence.text);
  if (!direction || negative !== (direction === "out")) return false;
  // A later section heading overrides an earlier direction; the model cannot cite stale context.
  for (const line of all.values()) {
    if (line.line <= evidence.line || line.line >= amountLine.line) continue;
    if (/\b(total|debit|credit|entradas|saidas|money in|money out)\b/.test(fold(line.text))) {
      const next = directionIn(line.text);
      if (next && next !== direction) return false;
    }
  }
  return true;
}

export function needsDocumentAi(output: ParserOutput): boolean {
  const st = output.statement;
  return st.profile === "pdf-lines" || st.profile === "pdf-card-lines" ||
    st.accounts.every(a => !a.transactions.length) ||
    st.warnings.some(w => ["row_unreadable", "balance_mismatch", "unsupported_layout"].includes(w.code)) ||
    st.accounts.some(a => a.openingBalance && a.closingBalance &&
      !dec(a.openingBalance.amount).plus(sum(a.transactions.map(t => t.amount))).equals(a.closingBalance.amount));
}

/** Validate all batches before merging. Conflicting proposals for one source amount are rejected. */
export function validateDocumentInterpretation(result: DocumentAiResult): ParserOutput {
  const warnings: ParseWarning[] = result.skippedLines.map(row => ({ code: "row_unreadable", row, message: "Document section could not be interpreted by AI." }));
  const warn = (row: number | undefined, message: string) => warnings.push({ code: "ai_rejected_row", ...(row ? { row } : {}), message });
  const accounts = new Map<string, ParsedAccount>();
  const monthPeriods = [...new Map(result.batches.flatMap(b => b.lines).flatMap(l => {
    const p = monthPeriod(l.text);
    return p ? [[p.start, p] as const] : [];
  })).values()];
  let period: ParsedStatement["period"] = monthPeriods.length === 1 ? monthPeriods[0] : undefined;
  let institutionText: string | undefined;
  const txProposals: { account: ParsedAccount; tx: ParsedTransaction; amountLine: number }[] = [];
  const counts = new Map<number, number>();
  // All movement references form a protected region: metadata may not come from counterparties.
  const refs = result.batches.flatMap(b => b.proposal.accounts.flatMap(a => a.transactions.flatMap(t => [t.line, t.amountLine, ...t.descriptionLines])));
  const firstMovement = refs.length ? Math.min(...refs) : Infinity;
  const lastMovement = refs.length ? Math.max(...refs) : -Infinity;
  for (const batch of result.batches) {
    const source = new Map(batch.lines.map(l => [l.line, l]));
    const primary = new Set(batch.primaryLines);
    const p = batch.proposal;
    for (const row of p.unparsedLines) if (primary.has(row) && source.has(row) && !isSummaryLine(source.get(row)!.text) && /\d[.,]\d{2}(?!\d)/.test(source.get(row)!.text) && (dateCandidatesInLine(source.get(row)!.text).full.size || dateCandidatesInLine(source.get(row)!.text).partial.size || directionIn(source.get(row)!.text))) warnings.push({ code: "row_unreadable", row, message: "AI could not interpret this document line." });
    const proposedPeriod = p.period;
    if (proposedPeriod) {
      const start = source.get(proposedPeriod.startLine), end = source.get(proposedPeriod.endLine);
      if (!start || !end || !hasPeriodDate(proposedPeriod.start, start.text) || !hasPeriodDate(proposedPeriod.end, end.text) || proposedPeriod.start > proposedPeriod.end) warn(undefined, "Statement period is not supported by the source.");
      else if (period && (period.start !== proposedPeriod.start || period.end !== proposedPeriod.end)) warn(undefined, "AI returned conflicting statement periods.");
      else period = { start: proposedPeriod.start, end: proposedPeriod.end };
    }
    if (p.institution) {
      const evidence = source.get(p.institution.line);
      if (!evidence || (evidence.line >= firstMovement && evidence.line <= lastMovement) || !compact(evidence.text).includes(compact(p.institution.name))) warn(p.institution.line, "Issuer is not grounded in an administrative header or footer.");
      else if (institutionText && compact(institutionText) !== compact(p.institution.name)) warn(p.institution.line, "AI returned conflicting issuers.");
      else institutionText = p.institution.name;
    }
    for (const a of p.accounts) {
      const currencySource = source.get(a.currencyLine);
      if (!isKnownCurrency(a.currency) || !currencySource || !fiatCurrenciesInText(currencySource.text).has(a.currency)) { warn(a.currencyLine, "Account currency is not supported by the source."); continue; }
      let identifier: string | undefined;
      if (a.identifier) {
        const evidence = a.identifierLine ? source.get(a.identifierLine) : undefined;
        if (!evidence || evidence.line >= firstMovement || !/\b(iban|conta|account|conto|cuenta)\b/.test(fold(evidence.text + " " + (source.get(evidence.line - 1)?.text ?? ""))) || !compact(evidence.text).includes(compact(a.identifier))) warn(a.identifierLine ?? undefined, "Holder account identifier is not supported by its header.");
        else {
          // A model may copy the whole agency/account row; use the labeled account column.
          const header = source.get(evidence.line - 1);
          const column = header?.items.find(i => /\b(conta|account|iban|conto|cuenta)\b/.test(fold(i.text)));
          const cell = column && evidence.items.filter(i => i.x >= column.x - 3).map(i => i.text).join("");
          identifier = (cell && (compact(cell).includes(compact(a.identifier)) || compact(a.identifier).includes(compact(cell))) ? cell : a.identifier).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
        }
      }
      const key = `${identifier ?? a.key}|${a.type}|${a.currency}`;
      let account = accounts.get(key);
      if (!account) {
        account = { key, type: a.type, currency: a.currency, transactions: [], ...(identifier ? { identifier, identifierMask: identifier.slice(-4) } : {}) };
        accounts.set(key, account);
      }
      for (const kind of ["openingBalance", "closingBalance"] as const) {
        const balance = a[kind];
        if (!balance) continue;
        let amountSource = source.get(balance.amountLine), dateSource = source.get(balance.dateLine);
        // Resolve an incorrect model pointer only to an explicit balance with the same value/date.
        const labeled = batch.lines.filter(l => /\bsaldo (em|de conta corrente em)\b/.test(fold(l.text)) && hasMagnitude(balance.amount, l.text) && hasBalanceDate(balance.asOf, l.text, period));
        if (labeled.length && (!amountSource || !/\bsaldo\b/.test(fold(amountSource.text)))) {
          amountSource = labeled[0]; dateSource = labeled[0];
        }
        const amountOnly = amountSource && /^(?:(?:R\$|US\$|€|£|[A-Z]{3})\s*)?[-+()]?[\d.,'’ ]+\)?$/.test(amountSource.text);
        const labelText = amountOnly ? batch.lines.filter(l => l.line < balance.amountLine && balance.amountLine - l.line <= 2).map(l => fold(l.text)).join(" ") : fold(amountSource?.text ?? "");
        const label = kind === "openingBalance" ? /\b(saldo (inicial|anterior)|opening balance|previous balance|saldo iniziale)\b/ : /\b(saldo (final|atual|finale)|closing balance|ending balance|new balance)\b/;
        if (!amountSource || !dateSource || (!label.test(labelText) && !(period && /\bsaldo (em|de conta corrente em)\b/.test(labelText) && (kind === "openingBalance" ? balance.asOf <= period.start : balance.asOf === period.end))) || !hasMagnitude(balance.amount, amountSource.text) || !hasBalanceDate(balance.asOf, dateSource.text, period) || amountTokensInLine(amountSource.text).some(t => t.negative && t.values.some(v => dec(v).abs().equals(dec(balance.amount).abs()))) !== dec(balance.amount).isNegative()) { warn(balance.amountLine, "Balance is not supported by its amount, date and label."); continue; }
        if (account[kind] && (account[kind]!.amount !== toPlain(balance.amount) || account[kind]!.asOf !== balance.asOf)) warn(balance.amountLine, "AI returned conflicting balances.");
        else account[kind] = { amount: toPlain(balance.amount), asOf: balance.asOf };
      }
      for (const t of a.transactions) {
        if (!primary.has(t.amountLine)) continue;
        counts.set(t.amountLine, (counts.get(t.amountLine) ?? 0) + 1);
        const origin = source.get(t.line), amountSource = source.get(t.amountLine), direction = source.get(t.directionLine);
        let dateSource = source.get(t.dateLine);
        if (dateSource && period && !dateCandidatesInLine(dateSource.text).full.size && !dateCandidatesInLine(dateSource.text).partial.size) {
          const previous = batch.lines.filter(l => l.line < t.amountLine && t.amountLine - l.line <= 12 && l.page === amountSource?.page && (dateCandidatesInLine(l.text).full.size || dateCandidatesInLine(l.text).partial.size)).at(-1);
          if (previous && hasDate(t.date, previous.text, period) && !isSummaryLine(previous.text)) dateSource = previous;
        }
        const descriptions = [...new Set(t.descriptionLines)].sort((x, y) => x - y).map(n => source.get(n));
        const originalDescriptionText = normalizeDescription(descriptions.map(l => l?.text ?? "").join(" "));
        const descriptionText = normalizeDescription(descriptions.map(l => l?.line === t.amountLine ? withoutAmount(l.text, t.amount) : l?.text ?? "").join(" "));
        if (!origin || !amountSource || !dateSource || !direction || descriptions.some(l => !l) ||
          descriptions.some(l => Math.abs(l!.line - t.line) > 12) || Math.abs(t.amountLine - t.line) > 12 ||
          dateSource.line > t.amountLine || (dateSource.text.match(/\b\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}\b/g)?.length ?? 0) > 1 || /\b(period|periodo|vencimento|due date|issued|gerado)\b/.test(fold(dateSource.text)) ||
          !hasDate(t.date, dateSource.text, period) || (period && (t.date < period.start || t.date > period.end)) ||
          !hasMagnitude(t.amount, amountSource.text) || !directionSupported(t.amount, amountSource, direction, source) ||
          (!descriptionText.includes(normalizeDescription(t.description)) && !originalDescriptionText.includes(normalizeDescription(t.description))) ||
          isSummaryLine(t.description) || isSummaryLine(amountSource.text)) {
          warn(t.line, "Transaction is not supported by its source date, description, amount and direction."); continue;
        }
        txProposals.push({ account, amountLine: t.amountLine, tx: {
          bookedOn: t.date, description: normalizeDescription(t.description), amount: toPlain(t.amount), currency: a.currency,
          sourceRow: t.line, extraction: "ai", raw: { line: origin.text, page: String(origin.page), amount_line: amountSource.text, date_line: dateSource.text, description_lines: descriptions.map(l => l!.text).join("\n"), evidence_lines: [t.line, t.amountLine, dateSource.line, t.directionLine, ...t.descriptionLines].join(",") },
        } });
      }
    }
  }
  for (const p of txProposals) {
    if (counts.get(p.amountLine) !== 1) warn(p.tx.sourceRow, "Conflicting transaction proposals reference the same source amount.");
    else p.account.transactions.push(p.tx);
  }
  if (![...accounts.values()].some(a => a.transactions.length)) warnings.push({ code: "row_unreadable", message: "Document AI found no source-verified movements; review the original document." });
  const match = institutionText ? findInstitutionByText(institutionText) : undefined;
  // Namespace non-IBAN account numbers by the verified issuer, so identical numbers at two banks never collide.
  for (const account of accounts.values()) if (account.identifier && !/^[A-Z]{2}\d{2}/.test(account.identifier)) {
    if (institutionText) {
      const header = result.batches.flatMap(b => b.lines).filter(l => l.line < firstMovement).map(l => l.text).join(" ");
      const branch = /ag[eê]ncia\s*:?[ ]*(\d+)/i.exec(header)?.[1];
      account.identifier = match && ["nubank", "nubank-pj"].includes(match.slug) && branch
        ? `nubank:${branch}:${account.identifier.replace(/\D/g, "")}`
        : `bank:${match?.slug ?? compact(institutionText)}:${account.identifier}`;
    }
    else { delete account.identifier; delete account.identifierMask; warn(undefined, "Account number has no verified issuer."); }
  }
  return { statement: { format: "pdf", profile: "ai-pdf-document", accounts: [...accounts.values()], warnings }, institutionText, documentInstitution: institutionText, statedPeriod: period };
}

/** Never overwrite a deterministic movement with a conflicting model proposal. */
export function mergeDocumentInterpretation(original: ParserOutput, interpreted: ParserOutput): ParserOutput {
  const st = original.statement;
  const accounts = st.accounts.map(a => ({ ...a, transactions: [...a.transactions] }));
  const resolvedLines = new Set(interpreted.statement.accounts.flatMap(a => a.transactions.flatMap(t => (t.raw.evidence_lines ?? "").split(",").map(Number))));
  const warnings = [...st.warnings.filter(w => !(w.row && resolvedLines.has(w.row) && ["row_unreadable", "missing_date", "missing_amount"].includes(w.code))), ...interpreted.statement.warnings];
  // A generic parser has only one bucket. If the model discovers several
  // accounts, distribute overlapping source rows instead of retaining that
  // bucket alongside the same movements in the identified accounts.
  if (["pdf-lines", "pdf-card-lines"].includes(st.profile) && interpreted.statement.accounts.length > 1) {
    const split = interpreted.statement.accounts.map(a => ({ ...a, transactions: [...a.transactions] }));
    for (const originalAccount of accounts) {
      const unmatched: ParsedTransaction[] = [];
      for (const tx of originalAccount.transactions) {
        const matches = split.flatMap(a => a.transactions.filter(t => t.sourceRow === tx.sourceRow || t.raw.evidence_lines?.split(",").includes(String(tx.sourceRow))).map(t => ({ a, t })));
        if (matches.length === 1) {
          const { a, t } = matches[0]!;
          if (tx.bookedOn !== t.bookedOn || !dec(tx.amount).equals(t.amount) || tx.currency !== t.currency) warnings.push({ code: "ai_rejected_row", row: tx.sourceRow, message: "AI conflicts with a deterministic transaction; original retained." });
          a.transactions[a.transactions.indexOf(t)] = tx;
        } else unmatched.push(tx);
      }
      if (unmatched.length) {
        split.push({ ...originalAccount, transactions: unmatched, openingBalance: undefined, closingBalance: undefined });
        warnings.push({ code: "row_unreadable", message: "Some deterministic movements could not be assigned to a verified account." });
      }
    }
    return { ...original, institutionText: interpreted.institutionText ?? original.institutionText,
      documentInstitution: interpreted.documentInstitution, statedPeriod: original.statedPeriod ?? interpreted.statedPeriod,
      statement: { ...st, profile: "pdf-with-document-ai", accounts: split, warnings } };
  }
  for (const proposed of interpreted.statement.accounts) {
    let target = accounts.find(a => a.identifier && a.identifier === proposed.identifier);
    if (!target && accounts.length === 1 && interpreted.statement.accounts.length === 1 && accounts[0]!.currency === proposed.currency && (!accounts[0]!.type || accounts[0]!.type === proposed.type)) target = accounts[0];
    if (!target) { accounts.push(proposed); continue; }
    // Preserve reliable identities from known parsers, while filling missing metadata.
    target.identifier ??= proposed.identifier;
    target.identifierMask ??= proposed.identifierMask;
    target.type ??= proposed.type;
    target.openingBalance ??= proposed.openingBalance;
    target.closingBalance ??= proposed.closingBalance;
    for (const tx of proposed.transactions) {
      const same = target.transactions.find(t => t.sourceRow === tx.sourceRow || tx.raw.evidence_lines?.split(",").includes(String(t.sourceRow)) || t.raw.evidence_lines?.split(",").includes(String(tx.sourceRow)));
      if (same) {
        if (same.bookedOn !== tx.bookedOn || !dec(same.amount).equals(tx.amount) || same.currency !== tx.currency) warnings.push({ code: "ai_rejected_row", row: tx.sourceRow, message: "AI conflicts with a deterministic transaction; original retained." });
        continue;
      }
      target.transactions.push(tx);
    }
  }
  return { ...original, institutionText: interpreted.institutionText ?? original.institutionText,
    documentInstitution: interpreted.documentInstitution ?? original.documentInstitution,
    statedPeriod: original.statedPeriod ?? interpreted.statedPeriod,
    statement: { ...st, profile: "pdf-with-document-ai", accounts, warnings } };
}
