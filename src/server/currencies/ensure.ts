import "server-only";
import { getCurrency, isCatalogCurrency, isIsoCurrency } from "@/domain/money/currencies";
import { createAdminClient } from "../supabase/admin";

/**
 * Makes sure every ISO currency a statement uses has a row in `public.currencies`,
 * which accounts, transactions and exchange rates reference. Only reference data
 * is written (the code, its name and decimals, as ISO defines them); no user,
 * account or amount is involved. The service role is needed because end users
 * may not write this table. Returns the codes that were added.
 */
export async function ensureCurrencies(codes: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()))].filter((c) => isIsoCurrency(c) && !isCatalogCurrency(c));
  if (wanted.length === 0) return [];
  const admin = createAdminClient();
  const rows = wanted.map((code) => {
    const info = getCurrency(code)!;
    return { code, kind: info.kind, name: info.name.slice(0, 80), decimals: info.decimals, display_decimals: info.displayDecimals };
  });
  // Existing rows are left alone: a concurrent import may have added the same code.
  const { error } = await admin.from("currencies").upsert(rows, { onConflict: "code", ignoreDuplicates: true });
  if (error) throw error;
  return wanted;
}
