/** Generic multi-line ledger: history column wraps above/below a dated signed value. */
import { parseAmount } from "@/domain/import/parse-amount";
import { parseDate } from "@/domain/import/parse-date";
import { dec } from "@/domain/money/decimal";
import type { ParsedAccount, ParsedTransaction, ParseWarning } from "@/domain/import/types";
import { INSTITUTIONS, findInstitutionByText, getInstitution } from "../institution-catalog";
import { fold, normalizeDescription } from "./text";
import type { PdfLine } from "./pdf";
import type { DocumentParseContext, ParserOutput } from "./types";

export function parseSignedLedger(lines: PdfLine[], ctx: DocumentParseContext): ParserOutput | undefined {
  const header = lines.find(l => /\b(dia|data|date)\b/.test(fold(l.text)) && /\b(historico|description|descricao)\b/.test(fold(l.text)) && /\b(valor|amount|importo)\b/.test(fold(l.text)));
  const history = header?.items.find(i => /^(historico|description|descricao)$/.test(fold(i.text)));
  const value = header?.items.find(i => /^(valor|amount|importo)$/.test(fold(i.text)));
  if (!header || !history || !value || history.x >= value.x) return undefined;
  const preamble = lines.filter(l => l.line < header.line).map(l => l.text).join("\n");
  const compressed = /(?:per[ií]odo|period)\s*:\s*(\d{1,2})\s*(?:a|até|to|-)\s*(\d{1,2})\/(\d{2})\/(\d{4})/i.exec(preamble);
  const start = compressed && parseDate(`${compressed[1]}/${compressed[3]}/${compressed[4]}`);
  const end = compressed && parseDate(`${compressed[2]}/${compressed[3]}/${compressed[4]}`);
  const identity = /ag[eê]ncia\s*:\s*([\d.-]+)\s+conta\s*:\s*([\d.-]+)/i.exec(preamble);
  if (!start || !end || start > end || !identity) return undefined;
  const positionsStart = lines.findIndex(l => /^(aplicacoes financeiras|investment positions|posizioni investimenti)$/.test(fold(l.text)));
  const positions = positionsStart >= 0 ? lines.slice(positionsStart + 1) : [];
  const ownProducts = positions.map(l => fold(l.text)).join("\n");
  const branded = INSTITUTIONS.filter(i => i.ownedProductAliases?.some(alias => ownProducts.includes(alias)));
  const match = findInstitutionByText(preamble);
  const institution = match ? getInstitution(match.slug) : branded.length === 1 ? branded[0] : undefined;
  const warnings: ParseWarning[] = [];
  const explicitCurrency = /\b(BRL|EUR|USD|GBP|CHF)\b|R\$/.exec(preamble + " " + header.text)?.[0];
  const currency = (explicitCurrency === "R$" ? "BRL" : explicitCurrency) ?? institution?.defaultCurrency ?? ctx.fallbackCurrency;
  if (!currency) return undefined;
  if (!explicitCurrency && !institution) warnings.push({ code: "unknown_currency", message: "Ledger currency uses the user's default; verify it against the source." });
  const account: ParsedAccount = { key: "checking", type: "checking", currency, transactions: [],
    identifier: `bank:${institution?.slug ?? "unconfirmed"}:${identity[2]!.replace(/\D/g, "")}`, identifierMask: identity[2]!.replace(/\D/g, "").slice(-4),
  };
  let pending: PdfLine[] = [];
  let previous: ParsedTransaction | undefined;
  let running = dec("0");
  let closed = false;
  const append = (part: PdfLine[]) => {
    if (!previous || !part.length) return;
    previous.description = normalizeDescription(previous.description + " " + part.map(l => l.text).join(" ")).slice(0, 1000);
    previous.raw.description_lines += "," + part.map(l => l.line).join(",");
    previous.raw.continuation = part.map(l => l.text).join("\n");
  };
  for (const line of lines.filter(l => l.line > header.line && (positionsStart < 0 || l.line < lines[positionsStart]!.line))) {
    const text = fold(line.text);
    if (/^(extrato de conta|cliente:|periodo:|lancamentos$|dia lote|data lote)/.test(text)) continue;
    const dateText = /^\d{2}\/\d{2}\/\d{4}\b/.exec(line.text)?.[0];
    const date = dateText && parseDate(dateText);
    if (!date) {
      const cells = line.items.filter(i => i.x >= history.x - 3 && i.x < value.x - 30);
      if (cells.length && !/\d[.,]\d{2}\s*\([+-]\)/.test(line.text)) pending.push(line);
      else if (/\d[.,]\d{2}\s*\([+-]\)/.test(line.text)) warnings.push({ code: "row_unreadable", row: line.line, message: "Signed ledger value has no supported booked date." });
      continue;
    }
    const money = line.items.filter(i => i.x >= value.x - 100 && /\d[.,]\d{2}\s*\([+-]\)\s*$/.test(i.text));
    if (money.length !== 1) { warnings.push({ code: "missing_amount", row: line.line, message: "Ledger row has no unique signed amount." }); continue; }
    const amount = parseAmount(money[0]!.text)?.amount;
    if (amount === undefined) continue;
    const own = line.items.filter(i => i.x >= history.x - 3 && i.x < money[0]!.x - 5).map(i => i.text).join(" ").trim();
    let description = own;
    let evidence = [line.line];
    if (!description && pending.length) {
      const title = pending.pop()!;
      description = title.text; evidence = [title.line, line.line];
    }
    append(pending); pending = [];
    const label = fold(description).replace(/\s+/g, "");
    if (/^(saldoanterior|openingbalance)$/.test(label)) {
      if (account.transactions.length || account.openingBalance) return undefined;
      account.openingBalance = { amount, asOf: date }; running = dec(amount); previous = undefined; continue;
    }
    if (/^(saldododia|dailybalance|saldo|closingbalance)$/.test(label)) {
      if (!running.equals(amount)) warnings.push({ code: "balance_mismatch", row: line.line, message: "Ledger movements do not reconcile with a printed balance." });
      if (label === "saldo" || label === "closingbalance") { account.closingBalance = { amount, asOf: date }; closed = true; }
      previous = undefined; continue;
    }
    if (!description || !account.openingBalance || date < start || date > end || closed) {
      warnings.push({ code: "row_unreadable", row: line.line, message: "Ledger movement lacks a valid history, period or opening balance." }); continue;
    }
    previous = { bookedOn: date, description, amount, currency, sourceRow: line.line, extraction: "heuristic", raw: {
      line: line.text, amount: money[0]!.text, page: String(line.page), description_lines: evidence.join(","),
    } };
    account.transactions.push(previous); running = running.plus(amount);
  }
  append(pending);
  if (!account.transactions.length || !account.openingBalance || !closed) return undefined;
  const accounts: ParsedAccount[] = [account];
  for (const line of positions) {
    const m = /^(.+?)\s+(\d[\d.,]*[.,]\d{2})$/.exec(line.text);
    const amount = m ? parseAmount(m[2])?.amount : undefined;
    if (!m || amount === undefined) { warnings.push({ code: "row_unreadable", row: line.line, message: "Investment summary position could not be read." }); continue; }
    const name = normalizeDescription(m[1]!);
    accounts.push({ key: `position:${fold(name)}`, type: "investment", currency, name, identifier: `${account.identifier}:position:${fold(name)}`, closingBalance: { amount, asOf: end }, transactions: [] });
  }
  return { statement: { format: "pdf", profile: "pdf-signed-ledger", accounts, warnings }, statedPeriod: { start, end }, institutionText: preamble,
    ...(institution ? { profileInstitution: { slug: institution.slug, weak: !match, evidence: match ? "Issuer in ledger header" : "Branded positions in the holder's investment summary; confirm issuer" } } : {}),
  };
}
