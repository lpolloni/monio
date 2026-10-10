/** Warning collection and currency resolution shared by all parsers and profiles. */
import type { ParseWarning } from "@/domain/import/types";
import { normalizeCurrencyCode } from "@/domain/money/currencies";

export class WarningSink {
  readonly list: ParseWarning[] = [];
  private readonly onceKeys = new Set<string>();
  add(warning: ParseWarning): void {
    // Bound the number of warnings so a hostile file cannot flood the UI.
    if (this.list.length < 500) this.list.push(warning);
  }
  once(key: string, warning: ParseWarning): void {
    if (this.onceKeys.has(key)) return;
    this.onceKeys.add(key);
    this.add(warning);
  }
}

/** Resolves a currency value from a cell; unknown ISO-like codes are kept with a warning. */
export function resolveCurrency(
  value: string | undefined,
  fallbacks: (string | undefined)[],
  warnings: WarningSink,
  row?: number,
): string {
  const v = (value ?? "").trim();
  if (v) {
    const known = normalizeCurrencyCode(v);
    if (known) return known;
    const upper = v.toUpperCase();
    if (/^[A-Z]{3}$/.test(upper)) {
      warnings.once(`currency:${upper}`, {
        code: "unknown_currency",
        message: `Currency ${upper} is not in the currency catalog; kept as written.`,
        row,
      });
      return upper;
    }
  }
  for (const fallback of fallbacks) {
    const code = fallback ? normalizeCurrencyCode(fallback) : undefined;
    if (code) return code;
  }
  warnings.once("currency:none", {
    code: "unknown_currency",
    message: "The document does not state its currency; transactions are marked XXX until confirmed.",
    row,
  });
  return "XXX";
}
