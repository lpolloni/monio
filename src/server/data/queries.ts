import "server-only";
import { cache } from "react";
import { FxTable } from "@/domain/fx/fx-table";
import { loadAccounts, loadRates, type AccountRecord } from "./finance";
import { requireSession } from "./session";
import { loadCategories, loadTransactionsInRange } from "./transactions";

/** Request-scoped, session-bound reads (deduplicated per request with React cache). */
export const getAccounts = cache(async (): Promise<AccountRecord[]> => {
  const { supabase, userId } = await requireSession();
  return (await loadAccounts(supabase, userId)).filter((a) => !a.isArchived);
});

export const getFxTable = cache(async (from: string, to: string): Promise<FxTable> => {
  const { supabase } = await requireSession();
  return new FxTable(await loadRates(supabase, from, to));
});

export const getCategories = cache(async () => {
  const { supabase, userId } = await requireSession();
  return loadCategories(supabase, userId);
});

export const getTransactionsInRange = cache(async (from: string, to: string) => {
  const { supabase, userId } = await requireSession();
  return loadTransactionsInRange(supabase, userId, from, to);
});
