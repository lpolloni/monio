/**
 * OFX parser for both OFX 1.x (SGML, leaf tags usually left unclosed) and OFX
 * 2.x (XML). A small linear tokenizer builds a tree; no XML parser, DTD or
 * entity expansion is involved (only the five predefined entities and numeric
 * references are decoded), so external entities / billion-laughs do not apply.
 *
 * Supports several statements per file (STMTRS for bank accounts, CCSTMTRS for
 * credit cards). Amounts keep the OFX sign convention (negative = money out of
 * the account, including card purchases).
 */
import { inferDecimalSeparator, parseAmount, type DecimalSeparator } from "@/domain/import/parse-amount";
import { parseDate } from "@/domain/import/parse-date";
import type { AccountType, ParseContext, ParsedAccount, ParsedTransaction } from "@/domain/import/types";
import { currencyDecimals } from "@/domain/money/currencies";
import { dec, toPlain } from "@/domain/money/decimal";
import { findInstitutionByOfxId } from "../institution-catalog";
import { resolveCurrency, WarningSink } from "./warnings";
import { decodeText, decodeWindows1252, normalizeDescription, sanitizeCell } from "./text";
import type { ParserOutput } from "./types";

export interface OfxNode {
  name: string;
  text?: string;
  children: OfxNode[];
  /** 1-based line of the opening tag. */
  line: number;
}

const AGGREGATES = new Set([
  "OFX", "SIGNONMSGSRSV1", "SONRS", "STATUS", "FI", "BANKMSGSRSV1", "STMTTRNRS", "STMTRS", "BANKACCTFROM",
  "BANKACCTTO", "BANKTRANLIST", "STMTTRN", "LEDGERBAL", "AVAILBAL", "BALLIST", "BAL", "PAYEE", "CURRENCY",
  "ORIGCURRENCY", "CREDITCARDMSGSRSV1", "CCSTMTTRNRS", "CCSTMTRS", "CCACCTFROM", "CCACCTTO", "INVSTMTMSGSRSV1",
  "INVSTMTTRNRS", "INVSTMTRS", "INVACCTFROM", "INVTRANLIST", "INVPOSLIST", "INVBAL", "SECLISTMSGSRSV1", "MKTGINFO",
]);
const MAX_TAGS = 400_000;
const MAX_DEPTH = 32;

const ENTITY = /&(amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/gi;
function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (_m, entity: string) => {
    const e = entity.toLowerCase();
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e === "nbsp") return " ";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

export class OfxTooLargeError extends Error {
  constructor() {
    super("OFX document has too many elements");
    this.name = "OfxTooLargeError";
  }
}

/** Builds the element tree of an OFX 1.x/2.x document. */
export function parseOfxTree(text: string): OfxNode {
  const root: OfxNode = { name: "#root", children: [], line: 0 };
  const stack: OfxNode[] = [root];
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9._]*)[^<>]*>([^<]*)/g;
  let line = 1;
  let scanned = 0;
  let count = 0;
  for (const m of text.matchAll(tag)) {
    if (++count > MAX_TAGS) throw new OfxTooLargeError();
    for (let i = scanned; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    scanned = m.index;
    const name = m[2]!.toUpperCase();
    if (m[1]) {
      // Closing tag: pop up to the matching open aggregate (ignore stray closers of leaves).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const value = sanitizeCell(decodeEntities(m[3] ?? "")).trim();
    const node: OfxNode = { name, children: [], line };
    stack[stack.length - 1]!.children.push(node);
    if (AGGREGATES.has(name) || (!value && !LEAVES.has(name))) {
      if (stack.length < MAX_DEPTH) stack.push(node);
    } else {
      node.text = value;
    }
  }
  return root;
}

const LEAVES = new Set([
  "CODE", "SEVERITY", "MESSAGE", "DTSERVER", "LANGUAGE", "ORG", "FID", "TRNUID", "CURDEF", "BANKID", "BRANCHID",
  "ACCTID", "ACCTTYPE", "ACCTKEY", "DTSTART", "DTEND", "TRNTYPE", "DTPOSTED", "DTUSER", "DTAVAIL", "TRNAMT", "FITID",
  "CORRECTFITID", "CORRECTACTION", "SRVRTID", "CHECKNUM", "REFNUM", "SIC", "PAYEEID", "NAME", "EXTDNAME", "MEMO",
  "CURRATE", "CURSYM", "BALAMT", "DTASOF", "INV401KSOURCE",
]);

function child(node: OfxNode | undefined, name: string): OfxNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function children(node: OfxNode | undefined, name: string): OfxNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

function leaf(node: OfxNode | undefined, name: string): string | undefined {
  const value = child(node, name)?.text;
  return value === undefined || value === "" ? undefined : value;
}

/** All descendants named `name` (does not descend into a match). */
function findAll(node: OfxNode, name: string, out: OfxNode[] = []): OfxNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

function find(node: OfxNode | undefined, name: string): OfxNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const nested = find(c, name);
    if (nested) return nested;
  }
  return undefined;
}

const ACCOUNT_TYPES: Record<string, AccountType> = {
  CHECKING: "checking",
  SAVINGS: "savings",
  MONEYMRKT: "savings",
  CD: "savings",
  CREDITLINE: "loan",
};

function mask(identifier: string): string {
  const alnum = identifier.replace(/[^A-Za-z0-9]/g, "");
  return alnum.slice(-4);
}

function decodeOfx(bytes: Uint8Array): string {
  const head = decodeWindows1252(bytes.subarray(0, 1024));
  const declaresUtf8 = /ENCODING\s*:\s*UTF-?8|encoding\s*=\s*["']utf-?8/i.test(head);
  const declares1252 = /CHARSET\s*:\s*(1252|ISO-?8859-?1|LATIN-?1)/i.test(head);
  if (declares1252 && !declaresUtf8) return decodeWindows1252(bytes);
  return decodeText(bytes).text;
}

export function parseOfx(bytes: Uint8Array, ctx: ParseContext = {}): ParserOutput {
  const text = decodeOfx(bytes);
  const root = parseOfxTree(text);
  const warnings = new WarningSink();

  const fi = find(root, "FI");
  const org = leaf(fi, "ORG");
  const fid = leaf(fi, "FID");
  const statements = [...findAll(root, "STMTRS"), ...findAll(root, "CCSTMTRS")].sort((a, b) => a.line - b.line);
  const firstBankId = statements.map((s) => leaf(child(s, "BANKACCTFROM"), "BANKID")).find(Boolean);

  // OFX mandates "." decimals, but some banks emit ","; infer from the whole file.
  const amountSamples = findAll(root, "STMTTRN").flatMap((t) => leaf(t, "TRNAMT") ?? []);
  const decimal: DecimalSeparator = inferDecimalSeparator(amountSamples) ?? ".";

  const accounts: ParsedAccount[] = [];
  let periodStart: string | undefined;
  let periodEnd: string | undefined;

  statements.forEach((stmt, index) => {
    const isCard = stmt.name === "CCSTMTRS";
    const from = child(stmt, isCard ? "CCACCTFROM" : "BANKACCTFROM");
    const acctId = leaf(from, "ACCTID");
    const acctType = leaf(from, "ACCTTYPE")?.toUpperCase();
    const currency = resolveCurrency(leaf(stmt, "CURDEF"), [ctx.fallbackCurrency], warnings);
    const tranList = child(stmt, "BANKTRANLIST");
    const start = parseDate(leaf(tranList, "DTSTART") ?? "");
    const end = parseDate(leaf(tranList, "DTEND") ?? "");
    if (start && (!periodStart || start < periodStart)) periodStart = start;
    if (end && (!periodEnd || end > periodEnd)) periodEnd = end;

    const account: ParsedAccount = {
      key: statements.length === 1 ? "default" : `${isCard ? "card" : "account"}-${index + 1}`,
      type: isCard ? "credit_card" : acctType ? (ACCOUNT_TYPES[acctType] ?? "other") : undefined,
      currency,
      transactions: [],
    };
    if (acctId) {
      account.identifier = acctId;
      account.identifierMask = mask(acctId);
    }

    for (const trn of children(tranList, "STMTTRN")) {
      const tx = readTransaction(trn, currency, decimal, warnings);
      if (tx) account.transactions.push(tx);
    }

    const ledger = child(stmt, "LEDGERBAL") ?? child(stmt, "AVAILBAL");
    const balAmt = parseAmount(leaf(ledger, "BALAMT"), decimal);
    const balDate = parseDate(leaf(ledger, "DTASOF") ?? "") ?? end;
    if (balAmt && balDate) account.closingBalance = { amount: balAmt.amount, asOf: balDate };
    accounts.push(account);
  });

  if (!statements.length) {
    warnings.add({
      code: "unsupported_layout",
      message: findAll(root, "INVSTMTRS").length
        ? "OFX investment statements are not supported; no transactions were imported."
        : "No bank or credit card statement found in the OFX file.",
    });
  }

  const match = findInstitutionByOfxId(org, fid, firstBankId);
  return {
    statement: { format: "ofx", accounts, warnings: warnings.list, profile: "ofx" },
    institutionText: org,
    ofxInstitution: match ? { ...match, name: org } : undefined,
    statedPeriod: periodStart && periodEnd && periodStart <= periodEnd ? { start: periodStart, end: periodEnd } : undefined,
  };
}

function readTransaction(trn: OfxNode, accountCurrency: string, decimal: DecimalSeparator, warnings: WarningSink): ParsedTransaction | undefined {
  const raw: Record<string, string> = {};
  for (const c of trn.children) if (c.text !== undefined) raw[c.name] = c.text;
  const payee = child(trn, "PAYEE");
  const payeeName = leaf(payee, "NAME");
  if (payeeName) raw["PAYEE.NAME"] = payeeName;

  const bookedOn = parseDate(leaf(trn, "DTPOSTED") ?? "");
  if (!bookedOn) {
    warnings.add({
      code: leaf(trn, "DTPOSTED") ? "row_unreadable" : "missing_date",
      message: "OFX transaction without a readable DTPOSTED; skipped.",
      row: trn.line,
    });
    return undefined;
  }
  const amountRaw = leaf(trn, "TRNAMT");
  const parsed = amountRaw ? parseAmount(amountRaw, decimal) : null;
  if (!parsed) {
    warnings.add({
      code: amountRaw ? "row_unreadable" : "missing_amount",
      message: "OFX transaction without a readable TRNAMT; skipped.",
      row: trn.line,
    });
    return undefined;
  }

  const name = leaf(trn, "NAME") ?? payeeName ?? "";
  const memo = leaf(trn, "MEMO") ?? "";
  let description: string;
  if (!name || memo.toLowerCase().includes(name.toLowerCase())) description = memo || name;
  else if (!memo || name.toLowerCase().includes(memo.toLowerCase())) description = name;
  else description = `${name} - ${memo}`;

  const tx: ParsedTransaction = {
    bookedOn,
    description: normalizeDescription(description || leaf(trn, "TRNTYPE") || ""),
    amount: parsed.amount,
    currency: accountCurrency,
    sourceRow: trn.line,
    raw,
    extraction: "exact",
  };
  const valueOn = parseDate(leaf(trn, "DTAVAIL") ?? leaf(trn, "DTUSER") ?? "");
  if (valueOn) tx.valueOn = valueOn;
  const fitid = leaf(trn, "FITID");
  if (fitid) tx.externalId = fitid.slice(0, 255);
  if (payeeName || name) tx.counterparty = normalizeDescription(payeeName ?? name);

  // <CURRENCY>: amount is in CURSYM; CURRATE converts to the account currency.
  // <ORIGCURRENCY>: amount already in the account currency; CURSYM was the original.
  const currencyAgg = child(trn, "CURRENCY");
  const origAgg = child(trn, "ORIGCURRENCY");
  const agg = currencyAgg ?? origAgg;
  if (agg) {
    const sym = resolveCurrency(leaf(agg, "CURSYM"), [], warnings, trn.line);
    const rateParsed = parseAmount(leaf(agg, "CURRATE"), decimal);
    const rate = rateParsed && !dec(rateParsed.amount).isZero() ? dec(rateParsed.amount) : undefined;
    if (sym !== "XXX" && sym !== accountCurrency) {
      if (currencyAgg) {
        if (rate) {
          tx.originalAmount = parsed.amount;
          tx.originalCurrency = sym;
          tx.amount = toPlain(dec(parsed.amount).times(rate).toDecimalPlaces(currencyDecimals(accountCurrency)));
        } else {
          // No rate: keep the amount as written, in its own currency.
          tx.currency = sym;
        }
      } else {
        tx.originalCurrency = sym;
        if (rate) tx.originalAmount = toPlain(dec(parsed.amount).dividedBy(rate).toDecimalPlaces(currencyDecimals(sym)));
      }
    }
  }
  return tx;
}
