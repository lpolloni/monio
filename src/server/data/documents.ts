import "server-only";
import { requireSession } from "./session";

export interface ImportedDocument {
  id: string;
  filename: string;
  format: string | null;
  status: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  transactionCount: number;
}

/** The user's imported files, newest first, with the number of transactions each one brought in. */
export async function getImportedDocuments(limit = 200): Promise<ImportedDocument[]> {
  const { supabase, userId } = await requireSession();
  const { data, error } = await supabase
    .from("documents")
    .select("id, original_filename, detected_format, status, created_at, period_start, period_end")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const counts = await Promise.all(
    (data ?? []).map(async (d) => {
      const { count } = await supabase.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("document_id", d.id);
      return count ?? 0;
    }),
  );
  return (data ?? []).map((d, i) => ({
    id: d.id,
    filename: d.original_filename,
    format: d.detected_format,
    status: d.status,
    createdAt: d.created_at,
    periodStart: d.period_start,
    periodEnd: d.period_end,
    transactionCount: counts[i]!,
  }));
}
