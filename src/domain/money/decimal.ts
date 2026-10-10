import Decimal from "decimal.js";

/**
 * Decimal arithmetic for every monetary calculation in Monio.
 *
 * Amounts travel through the system as decimal strings (e.g. "-39.90",
 * "0.000123450000000000") and are only turned into Decimal instances for
 * arithmetic. JavaScript numbers are never used for money.
 */
export const D = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -50,
  toExpPos: 50,
});

export type DecimalValue = InstanceType<typeof D>;
export type DecimalInput = string | DecimalValue | bigint;

const DECIMAL_STRING = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_STRING.test(value.trim());
}

export function dec(value: DecimalInput): DecimalValue {
  if (typeof value === "bigint") return new D(value.toString());
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_STRING.test(trimmed)) {
      throw new TypeError(`Invalid decimal string: "${value}"`);
    }
    return new D(trimmed);
  }
  return value;
}

export const ZERO = new D(0);

export function sum(values: Iterable<DecimalInput>): DecimalValue {
  let total = ZERO;
  for (const v of values) total = total.plus(dec(v));
  return total;
}

/** Canonical string without exponent and without trailing zeros ("12.50" -> "12.5"). */
export function toPlain(value: DecimalInput): string {
  const d = dec(value);
  if (d.isZero()) return "0";
  return d.toFixed();
}

/** Fixed-scale string using banker's rounding, e.g. toScale("1.005", 2) -> "1.00". */
export function toScale(value: DecimalInput, decimals: number): string {
  return dec(value).toFixed(decimals, Decimal.ROUND_HALF_EVEN);
}

export function abs(value: DecimalInput): DecimalValue {
  return dec(value).abs();
}

export function negate(value: DecimalInput): DecimalValue {
  return dec(value).negated();
}

export function compare(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  return dec(a).comparedTo(dec(b)) as -1 | 0 | 1;
}

export function equals(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).equals(dec(b));
}

/** Converts integer base units (satoshis, wei) into a decimal string. */
export function fromBaseUnits(units: bigint | string, decimals: number): string {
  return toPlain(dec(typeof units === "bigint" ? units : units).dividedBy(new D(10).pow(decimals)));
}

/** Percentage change from previous to current, or null when previous is zero. */
export function percentChange(previous: DecimalInput, current: DecimalInput): DecimalValue | null {
  const p = dec(previous);
  if (p.isZero()) return null;
  return dec(current).minus(p).dividedBy(p.abs()).times(100);
}
