import type { NextRequest } from "next/server";
import { describeError } from "@/server/import/pipeline";
import { createClient } from "@/server/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/import/{jobId} — status of one of the current user's import jobs.
 *
 * 200 { id, status, stage, progress, stats, errorCode, documentId, filename }
 * 401 { error: "unauthorized" } · 404 { error: "not_found" } · 500 { error: "internal" }
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const supabase = await createClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (claimsError || typeof userId !== "string") return json({ error: "unauthorized" }, 401);

  const { jobId } = await params;
  if (!UUID.test(jobId)) return json({ error: "not_found" }, 404);

  // RLS restricts rows to the signed-in user; the explicit filter keeps intent visible.
  const { data: job, error } = await supabase
    .from("import_jobs")
    .select("id, status, stage, progress, stats, error_code, document_id, document:documents(original_filename)")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error(`[import] status lookup failed: ${describeError(error)}`);
    return json({ error: "internal" }, 500);
  }
  if (!job) return json({ error: "not_found" }, 404);
  const document = Array.isArray(job.document) ? job.document[0] : job.document;
  return json(
    {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      stats: job.stats,
      errorCode: job.error_code,
      documentId: job.document_id,
      filename: document?.original_filename ?? null,
    },
    200,
  );
}
