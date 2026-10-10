import { getCurrency } from "@/domain/money/currencies";
import { INTL_TAGS, type Locale } from "@/i18n/config";

type SignDisplay = "auto" | "always" | "exceptZero" | "never";

export interface MoneyFormatOptions {
  compact?: boolean;
  signDisplay?: SignDisplay;
  /** Override fraction digits (defaults to the currency's display precision). */
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
}

const CRYPTO_SYMBOLS: Record<string, string> = { BTC: "₿", ETH: "Ξ" };

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return new Intl.NumberFormat(INTL_TAGS[locale], options);
}

/** Formats a decimal string exactly (Intl.NumberFormat accepts numeric strings). */
function formatDecimalString(nf: Intl.NumberFormat, amount: string): string {
  try {
    return nf.format(amount as Intl.StringNumericLiteral);
  } catch {
    return nf.format(Number(amount));
  }
}

export function formatMoney(amount: string, currency: string, locale: Locale, options: MoneyFormatOptions = {}): string {
  const info = getCurrency(currency);
  const isFiat = !info || info.kind === "fiat";
  const digits = options.maximumFractionDigits ?? info?.displayDecimals ?? 2;
  const minDigits = Math.min(options.minimumFractionDigits ?? (isFiat ? digits : 0), digits);
  if (isFiat && /^[A-Z]{3}$/.test(currency)) {
    const nf = numberFormat(locale, {
      style: "currency",
      currency,
      notation: options.compact ? "compact" : "standard",
      maximumFractionDigits: options.compact ? 1 : digits,
      minimumFractionDigits: options.compact ? 0 : minDigits,
      signDisplay: options.signDisplay ?? "auto",
    });
    return formatDecimalString(nf, amount);
  }
  const nf = numberFormat(locale, {
    notation: options.compact ? "compact" : "standard",
    maximumFractionDigits: options.compact ? 2 : digits,
    minimumFractionDigits: options.compact ? 0 : minDigits,
    signDisplay: options.signDisplay ?? "auto",
  });
  const symbol = CRYPTO_SYMBOLS[currency];
  const n = formatDecimalString(nf, amount);
  return symbol ? `${symbol} ${n}` : `${n} ${currency}`;
}

export function formatNumber(value: string | number, locale: Locale, maximumFractionDigits = 2): string {
  const nf = numberFormat(locale, { maximumFractionDigits });
  return typeof value === "number" ? nf.format(value) : formatDecimalString(nf, value);
}

export function formatPercent(value: number, locale: Locale, options: { signDisplay?: SignDisplay; digits?: number } = {}): string {
  return numberFormat(locale, {
    style: "percent",
    maximumFractionDigits: options.digits ?? 1,
    signDisplay: options.signDisplay ?? "auto",
  }).format(value / 100);
}

function parseIsoDate(date: string): Date {
  return new Date(date.length === 10 ? `${date}T00:00:00Z` : date);
}

export function formatDate(
  date: string,
  locale: Locale,
  style: "short" | "medium" | "long" | "dayMonth" | "weekday" = "medium",
): string {
  const d = parseIsoDate(date);
  const options: Intl.DateTimeFormatOptions =
    style === "short"
      ? { day: "2-digit", month: "2-digit", year: "2-digit" }
      : style === "long"
        ? { day: "numeric", month: "long", year: "numeric" }
        : style === "dayMonth"
          ? { day: "numeric", month: "short" }
          : style === "weekday"
            ? { weekday: "long", day: "numeric", month: "long" }
            : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat(INTL_TAGS[locale], { ...options, timeZone: "UTC" }).format(d);
}

export function formatMonth(key: string, locale: Locale, style: "short" | "long" = "short"): string {
  const d = parseIsoDate(`${key}-01`);
  return new Intl.DateTimeFormat(INTL_TAGS[locale], {
    month: style === "long" ? "long" : "short",
    year: style === "long" ? "numeric" : "2-digit",
    timeZone: "UTC",
  }).format(d);
}

/** "3 days ago", "in 2 days" — coarse, for freshness indicators. */
export function formatRelative(iso: string, now: Date, locale: Locale): string {
  const then = parseIsoDate(iso).getTime();
  const diffSec = Math.round((then - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(INTL_TAGS[locale], { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(diffSec / 86_400), "day");
  if (abs < 86_400 * 365) return rtf.format(Math.round(diffSec / (86_400 * 30)), "month");
  return rtf.format(Math.round(diffSec / (86_400 * 365)), "year");
}

export type Freshness = "fresh" | "aging" | "stale" | "unknown";

export function freshnessOf(iso: string | null, now: Date): Freshness {
  if (!iso) return "unknown";
  const days = (now.getTime() - parseIsoDate(iso).getTime()) / 86_400_000;
  if (days <= 7) return "fresh";
  if (days <= 30) return "aging";
  return "stale";
}
