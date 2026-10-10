import { after, type NextRequest } from "next/server";
import { getServerEnv } from "@/server/env";
import { receiveUpload, UploadRejectedError } from "@/server/import/intake";
import { describeError, runImportJob } from "@/server/import/pipeline";
import { ensureFiatRates } from "@/server/market/refresh";
import { getAiServiceFor } from "@/server/runtime";
import { createClient, createClientForAccessToken } from "@/server/supabase/server";

/** Room for multipart boundaries and part headers around the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/import — multipart/form-data with one `file` field (`?reprocess=1`
 * imports a file again even if it was already imported).
 *
 * 202 { jobId, documentId, format, alreadyImported: false } — processing continues
 *     after the response (poll GET /api/import/{jobId}).
 * 200 { jobId, documentId, format, alreadyImported: true } — same file already imported.
 * 400 { error: "empty" | "too_large" | "unsupported" | "invalid_request" }
 * 401 { error: "unauthorized" } · 500 { error: "internal" }
 */
export async function POST(request: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (claimsError || typeof userId !== "string") return json({ error: "unauthorized" }, 401);
  // Token for the RLS-scoped client used after the response (cookies are no longer writable then).
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) return json({ error: "unauthorized" }, 401);

  const maxBytes = getServerEnv().IMPORT_MAX_FILE_MB * 1024 * 1024;
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
    return json({ error: "too_large" }, 400);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: "invalid_request" }, 400);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const files = form.getAll("file");
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File)) return json({ error: "invalid_request" }, 400);
  if (file.size === 0) return json({ error: "empty" }, 400);
  if (file.size > maxBytes) return json({ error: "too_large" }, 400);
  const reprocess = request.nextUrl.searchParams.get("reprocess") === "1";

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await receiveUpload(supabase, userId, { bytes, filename: file.name, mimeType: file.type || undefined }, { maxBytes, reprocess });
    const body = { jobId: result.jobId, documentId: result.documentId, format: result.format, alreadyImported: result.alreadyImported };
    if (result.alreadyImported) return json(body, 200);

    const { data: profile, error: profileError } = await supabase.from("profiles").select("ai_cloud_consent").eq("id", userId).maybeSingle();
    if (profileError) throw profileError;
    // Cloud AI only with the user's explicit consent; otherwise rules only (never a silent fallback).
    const ai = getAiServiceFor({ aiCloudConsent: profile?.ai_cloud_consent === true });
    const today = new Date().toISOString().slice(0, 10);
    after(async () => {
      try {
        await runImportJob(createClientForAccessToken(accessToken), userId, result.jobId, { bytes, today, ai, ensureRates: (currencies, from) => ensureFiatRates(currencies, from, today) });
      } catch (error) {
        // runImportJob records its own failures; this only guards unexpected crashes.
        console.error(`[import] background job ${result.jobId} crashed: ${describeError(error)}`);
      }
    });
    return json(body, 202);
  } catch (error) {
    if (error instanceof UploadRejectedError) return json({ error: error.code }, 400);
    console.error(`[import] upload failed: ${describeError(error)}`);
    return json({ error: "internal" }, 500);
  }
}
