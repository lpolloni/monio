/**
 * Generic heuristic profile for CSV/XLSX exports of banks without a dedicated
 * profile.
 *
 * Columns are identified by multilingual header keywords (en/pt/it/es/de/fr)
 * *and* validated by their content (a "date" column must hold dates, an
 * "amount" column amounts...). Decimal separator and date order are inferred
 * from whole columns. When date + amount (or a debit/credit pair) +
 * description cannot all be identified with confidence, the profile returns no
 * transactions and an `unsupported_layout` warning instead of guessing.
 */
import { inferDecimalSeparator, parseAmount } from "@/domain/import/parse-amount";
import { inferDateOrder, parseDate, type DateOrder } from "@/domain/import/parse-date";
import type { ParseWarning } from "@/domain/import/types";
import { normalizeCurrencyCode } from "@/domain/money/currencies";
import { headerCore } from "../parsers/text";
import { cellAt, columnRate, readTable } from "./table";
import type { ProfileContext, ProfileResult, StatementProfile } from "./types";

type Role =
  | "date"
  | "valueDate"
  | "description"
  | "counterparty"
  | "amount"
  | "debit"
  | "credit"
  | "currency"
  | "valuta"
  | "balance"
  | "id"
  | "status";

const KEYWORDS: Record<Role, string[]> = {
  date: [
    "data", "date", "fecha", "datum", "data contabile", "data operazione", "data registrazione", "data lancamento",
    "data do lancamento", "data movimento", "data mov", "data da transacao", "data transacao", "dt lancamento",
    "dt movimento", "booking date", "transaction date", "posting date", "posted date", "date posted", "trans date",
    "completed date", "date operation", "date de l operation", "date comptable", "buchungstag", "buchungsdatum",
    "fecha operacion", "fecha contable", "fecha movimiento",
  ],
  valueDate: [
    "data valuta", "value date", "fecha valor", "wertstellung", "date de valeur", "date valeur", "data valor",
    "data de valor", "valutadatum",
  ],
  description: [
    "descricao", "descrizione", "description", "descripcion", "concepto", "beschreibung", "verwendungszweck",
    "libelle", "historico", "memo", "details", "detail", "narrative", "causale", "lancamento", "dettagli",
    "dettaglio", "estabelecimento", "title", "transaction description", "buchungstext", "detalhes",
    "descricao do lancamento", "descrizione operazione", "description operation", "libelle operation", "operazione",
    "movimento", "texto", "transaction details", "particulars", "historico do lancamento",
  ],
  counterparty: [
    "payee", "beneficiario", "partner name", "empfanger", "auftraggeber empfanger", "zahlungsempfanger",
    "beguenstigter zahlungspflichtiger", "contraparte", "controparte", "merchant", "favorecido", "destinatario",
    "counterparty", "ordinante", "beneficiaire", "name", "nome",
  ],
  amount: [
    "valor", "importo", "importe", "amount", "betrag", "montant", "quantia", "monto", "transaction amount", "umsatz",
    "valor da transacao", "importo operazione", "valor do lancamento", "net amount", "valor r",
  ],
  debit: [
    "debito", "debit", "dare", "uscite", "uscita", "saida", "saidas", "cargo", "cargos", "soll", "ausgang",
    "withdrawal", "withdrawals", "paid out", "money out", "addebiti", "addebito", "debits", "valor debito",
    "debit amount", "importo dare", "out",
  ],
  credit: [
    "credito", "credit", "avere", "entrate", "entrata", "entrada", "entradas", "abono", "abonos", "haben", "eingang",
    "deposit", "deposits", "paid in", "money in", "accrediti", "accredito", "credits", "valor credito",
    "credit amount", "importo avere", "in",
  ],
  currency: ["moeda", "divisa", "currency", "moneda", "wahrung", "devise", "ccy", "currency code"],
  // Italian "valuta" = currency, German "Valuta" = value date: decided by content.
  valuta: ["valuta"],
  balance: ["saldo", "balance", "solde", "kontostand", "running balance", "saldo contabile", "balance after"],
  id: ["id", "identificador", "transaction id", "id transazione", "id operazione", "fitid", "reference id"],
  status: ["state", "status", "stato", "estado", "situacao"],
};

interface KeywordEntry {
  role: Role;
  keyword: string;
}

const ENTRIES: KeywordEntry[] = (Object.keys(KEYWORDS) as Role[]).flatMap((role) =>
  KEYWORDS[role].map((keyword) => ({ role, keyword })),
);

/** Role suggested by a header's wording (the longest matching keyword wins). */
export function roleOfHeader(header: string): Role | undefined {
  const h = headerCore(header);
  if (!h) return undefined;
  let best: { role: Role; strength: number } | undefined;
  for (const { role, keyword } of ENTRIES) {
    let strength = 0;
    if (h === keyword) strength = 1000 + keyword.length;
    else if (keyword.length > 3 && (h.startsWith(`${keyword} `) || h.endsWith(` ${keyword}`) || h.includes(` ${keyword} `))) {
      strength = keyword.length;
    }
    if (strength && (!best || strength > best.strength)) best = { role, strength };
  }
  return best?.role;
}

const isDate = (v: string) => parseDate(v, "DMY") !== null || parseDate(v, "MDY") !== null;
const isAmount = (v: string) => parseAmount(v) !== null;
const hasLetters = (v: string) => /\p{L}.*\p{L}/u.test(v);
const isCurrencyCode = (v: string) => normalizeCurrencyCode(v) !== undefined || /^[A-Z]{3}$/.test(v.trim());

export interface GenericMapping {
  date: number;
  valueDate?: number;
  description: number;
  counterparty?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  currency?: number;
  balance?: number;
  id?: number;
  status?: number;
}

function coverage(rows: readonly string[][], col: number): number {
  if (!rows.length) return 0;
  return rows.filter((r) => cellAt(r, col) !== "").length / rows.length;
}

/**
 * Maps header roles to columns, validating each against the data below it.
 * Returns undefined unless date, description and amount (or debit + credit)
 * are all identified.
 */
export function analyzeColumns(headers: readonly string[], dataRows: readonly string[][]): GenericMapping | undefined {
  const rows = dataRows.filter((r) => r.some((c) => c.trim())).slice(0, 200);
  if (!rows.length) return undefined;
  const byRole = new Map<Role, number[]>();
  headers.forEach((h, col) => {
    const role = roleOfHeader(h);
    if (role) byRole.set(role, [...(byRole.get(role) ?? []), col]);
  });
  const cols = (role: Role) => byRole.get(role) ?? [];
  const pick = (candidates: number[], test: (v: string) => boolean, minRate = 0.8, minCoverage = 0.5) => {
    let best: { col: number; rate: number } | undefined;
    for (const col of candidates) {
      const rate = columnRate(rows, col, test);
      if (rate >= minRate && coverage(rows, col) >= minCoverage && (!best || rate > best.rate)) best = { col, rate };
    }
    return best?.col;
  };

  const date = pick(cols("date"), isDate);
  if (date === undefined) return undefined;
  const valuta = cols("valuta");
  const valueDate = pick([...cols("valueDate"), ...valuta].filter((c) => c !== date), isDate, 0.8, 0);
  const currency = pick([...cols("currency"), ...valuta], isCurrencyCode, 0.8, 0);

  const debitCol = pick(cols("debit"), isAmount, 0.8, 0);
  const creditCol = pick(cols("credit"), isAmount, 0.8, 0);
  const amountCol = pick(cols("amount"), isAmount);
  let amount: number | undefined;
  let debit: number | undefined;
  let credit: number | undefined;
  if (amountCol !== undefined) {
    amount = amountCol;
  } else if (debitCol !== undefined && creditCol !== undefined) {
    const covered = rows.filter((r) => cellAt(r, debitCol) || cellAt(r, creditCol)).length / rows.length;
    if (covered < 0.5) return undefined;
    debit = debitCol;
    credit = creditCol;
  } else {
    return undefined;
  }

  const used = new Set([date, valueDate, amount, debit, credit, currency].filter((c) => c !== undefined));
  const description =
    pick(cols("description").filter((c) => !used.has(c)), hasLetters, 0.5) ??
    pick(cols("counterparty").filter((c) => !used.has(c)), hasLetters, 0.5);
  if (description === undefined) return undefined;
  const counterparty = cols("counterparty").find((c) => c !== description && !used.has(c));
  const balance = pick(cols("balance").filter((c) => !used.has(c)), isAmount, 0.8, 0);
  const id = cols("id").find((c) => !used.has(c) && c !== description);
  const status = cols("status").find((c) => !used.has(c) && c !== description);

  return { date, valueDate, description, counterparty, amount, debit, credit, currency, balance, id, status };
}

/** Currency named in a header ("Valor (R$)", "Importo EUR") — never guessed. */
export function currencyFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const paren = /\(([^)]{1,8})\)/.exec(header);
  if (paren) {
    const code = normalizeCurrencyCode(paren[1]);
    if (code) return code;
  }
  for (const token of header.match(/R\$|US\$|€|£|\b[A-Z]{3}\b/g) ?? []) {
    const code = normalizeCurrencyCode(token);
    if (code) return code;
  }
  return undefined;
}

/** Currency stated in preamble text ("Divisa: EUR", "Moeda: BRL"). */
export function currencyFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /(?:currency|moeda|divisa|valuta|moneda|w[äa]hrung|devise)\s*[:\-]?\s*(R\$|US\$|€|£|[A-Z]{3})\b/i.exec(text.slice(0, 5000));
  return m ? normalizeCurrencyCode(m[1]) : undefined;
}

const SKIPPED_STATES = /^(declined|reverted|failed|cancel+ed|rejected|recusad[ao]|cancelad[ao]|estornad[ao]|rifiutat[ao]|annullat[ao])$/i;
const PENDING_STATES = /^(pending|pendente|in sospeso|em processamento|processing|authorized|autorizzat[ao])$/i;

function unsupported(message: string): ProfileResult {
  return { accounts: [], warnings: [{ code: "unsupported_layout", message }] };
}

export const genericProfile: StatementProfile = {
  id: "generic",
  label: "Generic table (heuristic)",
  matches(headers, sampleRows) {
    return analyzeColumns(headers, sampleRows) ? 0.5 : 0;
  },
  parse(rows, ctx: ProfileContext) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const data = rows.slice(ctx.headerRowIndex + 1);
    const mapping = analyzeColumns(headers, data);
    if (!mapping) {
      return unsupported(
        "Could not identify date, description and amount columns with confidence; no transactions were imported.",
      );
    }
    const warnings: ParseWarning[] = [];
    const stringValues = (col: number | undefined) =>
      col === undefined
        ? []
        : data
            .map((row, i) => ({ value: cellAt(row, col), numeric: ctx.numericCell?.(ctx.headerRowIndex + 1 + i, col) }))
            .filter((v) => v.value && !v.numeric)
            .map((v) => v.value);

    const amountSamples = [mapping.amount, mapping.debit, mapping.credit, mapping.balance].flatMap(stringValues);
    const decimal = inferDecimalSeparator(amountSamples);
    if (!decimal && amountSamples.some((v) => /^[^.,]*\d[.,]\d{3}(?!\d)[^.,]*$/.test(v.replace(/\s/g, "")))) {
      warnings.push({
        code: "ambiguous_decimal_separator",
        message: 'Amounts like "1.234" could use either decimal separator; they were read as thousands.',
      });
    }

    // Dates in the preamble ("Período: 01/03/2026 a 31/03/2026") also prove the order.
    const preambleDates = (ctx.preamble ?? "").slice(0, 5000).match(/\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b/g) ?? [];
    const dateSamples = [...stringValues(mapping.date), ...preambleDates];
    const fallbackOrder: DateOrder = "DMY";
    const order = inferDateOrder(dateSamples, fallbackOrder);
    const proven = inferDateOrder(dateSamples, "YMD") !== "YMD";
    if (!proven && dateSamples.some((v) => /^(\d{1,2})[/.\-](\d{1,2})[/.\-]\d{2,4}/.test(v) && isAmbiguousDayMonth(v))) {
      warnings.push({
        code: "ambiguous_date_order",
        message: "Dates could be day/month or month/day; read as day/month.",
      });
    }

    const amountHeader = headers[mapping.amount ?? mapping.debit ?? mapping.credit ?? -1];
    const headerCurrency = currencyFromHeader(amountHeader) ?? currencyFromText(ctx.preamble);
    const result = readTable(rows, ctx, {
      date: mapping.date,
      valueDate: mapping.valueDate,
      dateOrder: order,
      decimal,
      amount:
        mapping.amount !== undefined
          ? { kind: "signed", col: mapping.amount }
          : { kind: "split", debitCol: mapping.debit, creditCol: mapping.credit },
      description: (row) => cellAt(row.cells, mapping.description) || cellAt(row.cells, mapping.counterparty),
      counterparty: (row) => cellAt(row.cells, mapping.counterparty) || undefined,
      externalId: mapping.id,
      balance: mapping.balance,
      currencyCol: mapping.currency,
      currency: headerCurrency,
      // One account per currency when the export mixes currencies.
      account: mapping.currency !== undefined ? (_row, currency) => ({ key: currency }) : undefined,
      skip: (row) => {
        const state = cellAt(row.cells, mapping.status);
        return state && SKIPPED_STATES.test(state)
          ? { reason: `Row skipped: state "${state.slice(0, 30)}" (not booked).`, warn: true }
          : undefined;
      },
      pending: (row) => PENDING_STATES.test(cellAt(row.cells, mapping.status)),
      extraction: "heuristic",
    });
    return { accounts: result.accounts, warnings: [...warnings, ...result.warnings] };
  },
};

function isAmbiguousDayMonth(value: string): boolean {
  const m = /^(\d{1,2})[/.\-](\d{1,2})/.exec(value.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= 12 && b <= 12 && a !== b;
}
