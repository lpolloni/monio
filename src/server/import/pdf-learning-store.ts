import "server-only";
import { createAdminClient } from "../supabase/admin";
import type { MonioClient } from "../supabase/server";
import type { PdfLearningStore } from "./parsers/pdf-learning";

/** The worker supplies its existing scoped client; no additional privileged client is created. */
export function pdfLearningStore(db: MonioClient, userId: string, documentHash: string): PdfLearningStore {
  return {
    async confirmations(layout) {
      const { data, error } = await db.from("pdf_reader_evidence").select("document_hash").eq("user_id", userId).eq("layout_hash", layout).limit(2);
      if (error) throw error;
      return data.length;
    },
    async confirm(layout) {
      // Retain only the two independent documents needed for promotion.
      const { data, error: readError } = await db.from("pdf_reader_evidence").select("document_hash").eq("user_id", userId).eq("layout_hash", layout).limit(2);
      if (readError) throw readError;
      if (data.length >= 2) return;
      const { error } = await db.from("pdf_reader_evidence").upsert({ user_id: userId, layout_hash: layout, document_hash: documentHash }, { onConflict: "user_id,layout_hash,document_hash", ignoreDuplicates: true });
      if (error) throw error;
    },
    async invalidate(layout) {
      const { error } = await db.from("pdf_reader_evidence").delete().eq("user_id", userId).eq("layout_hash", layout);
      if (error) throw error;
    },
  };
}

/**
 * Background import worker only, AFTER job/document ownership and original SHA verification.
 * The inline worker keeps financial writes under the session's RLS; certification alone
 * needs worker privileges because browsers must never be able to forge confirmations.
 * Privileged operations remain explicitly filtered by the already-verified user id.
 */
export function workerPdfLearningStore(db: MonioClient, userId: string, documentHash: string): PdfLearningStore {
  const scoped = pdfLearningStore(db, userId, documentHash);
  const writer = () => pdfLearningStore(createAdminClient(), userId, documentHash);
  return {
    confirmations: scoped.confirmations,
    confirm: layout => writer().confirm(layout),
    invalidate: layout => writer().invalidate(layout),
  };
}
