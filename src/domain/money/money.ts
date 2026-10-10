import { currencyDecimals } from "./currencies";
import { D, dec, toPlain, toScale, type DecimalInput, type DecimalValue } from "./decimal";

/** A monetary amount in a specific currency. `amount` is a signed decimal string. */
export interface Money {
  amount: string;
  currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} with ${b} without an explicit conversion`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(amount: DecimalInput, currency: string): Money {
  return { amount: toPlain(amount), currency: currency.toUpperCase() };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(dec(a.amount).plus(dec(b.amount)), a.currency);
}

export function sumMoney(values: Money[], currency: string): Money {
  let total: DecimalValue = new D(0);
  for (const v of values) {
    if (v.currency !== currency) throw new CurrencyMismatchError(currency, v.currency);
    total = total.plus(dec(v.amount));
  }
  return money(total, currency);
}

export function negateMoney(m: Money): Money {
  return money(dec(m.amount).negated(), m.currency);
}

export function isNegative(m: Money): boolean {
  return dec(m.amount).isNegative() && !dec(m.amount).isZero();
}

/** Rounds to the currency's native precision (cents for fiat, satoshis for BTC...). */
export function roundToCurrency(m: Money): Money {
  return { amount: toScale(m.amount, currencyDecimals(m.currency)), currency: m.currency };
}
