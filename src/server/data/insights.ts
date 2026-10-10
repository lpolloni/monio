import "server-only";
import type { Json } from "../supabase/database.types";
import { requireSession } from "./session";

export interface InsightView {
  id: string;
  kind: string;
  severity: "info" | "positive" | "warning";
  params: Record<string, string | number>;
  evidence: Json;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string;
}

export async function getInsightsList(limit = 20): Promise<InsightView[]> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("insights")
    .select("id, kind, severity, params, evidence, period_start, period_end, generated_at")
    .is("dismissed_at", null)
    .order("generated_at", { ascending: false })
    .order("kind", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity as InsightView["severity"],
    params: (r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {}) as Record<string, string | number>,
    evidence: r.evidence,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    generatedAt: r.generated_at,
  }));
}
