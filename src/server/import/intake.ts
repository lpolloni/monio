/**
 * Upload intake: validates an uploaded statement, stores the ORIGINAL bytes in
 * the private `documents` bucket (one folder per user) and queues an import job.
 *
 * Idempotency: the same file (same SHA-256) uploaded twice by the same user maps
 * to the same `documents` row; when its latest import already finished, the
 * caller is told `alreadyImported` instead of importing it again (unless the
 * user explicitly asks to re-process it).
 *
 * Document content is never logged. Works with a user-scoped (RLS) client; every
 * query is also filtered by user id.
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentFormat } from "@/domain/import/types";
import type { MonioClient } from "../supabase/server";
import { detectFormat } from "./detect-format";
import { MAX_DOCUMENT_BYTES } from "./parse-document";

export const DOCUMENTS_BUCKET = "documents";
export const MAX_FILENAME_CHARS = 120;

export type UploadRejectionCode = "empty" | "too_large" | "unsupported";

/** The upload was refused before anything was stored. Safe to show (no content). */
export class UploadRejectedError extends Error {
  readonly code: UploadRejectionCode;
  constructor(code: UploadRejectionCode) {
    super(
      code === "empty"
        ? "The uploaded file is empty."
        : code === "too_large"
          ? "The uploaded file exceeds the maximum allowed size."
          : "The uploaded file is not a supported statement format.",
    );
    this.name = "UploadRejectedError";
    this.code = code;
  }
}

/** Content type stored for each DETECTED format (the browser-provided type is never trusted). */
export const CANONICAL_MIME_TYPES: Readonly<Record<DocumentFormat, string>> = {
  csv: "text/csv",
  ofx: "application/x-ofx",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const DEFAULT_EXTENSION: Readonly<Record<DocumentFormat, string>> = { csv: "csv", ofx: "ofx", pdf: "pdf", xlsx: "xlsx" };

// C0/C1 controls, DEL, bidi overrides/isolates, zero-width and BOM characters.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function splitExtension(name: string): { stem: string; ext: string } {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (!match || match.index === 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, match.index), ext: match[0] };
}

/** Truncates by code points, keeping the extension. */
function truncateKeepingExtension(name: string, max: number): string {
  if ([...name].length <= max) return name;
  const { stem, ext } = splitExtension(name);
  const room = Math.max(1, max - [...ext].length);
  return `${[...stem].slice(0, room).join("").trimEnd()}${ext}`;
}

/**
 * Display-safe file name: no directories (both separators), no control/bidi
 * characters, whitespace collapsed, no leading dots, ≤ 120 characters
 * (extension kept). Falls back to `document.<ext>` when nothing is left.
 */
export function sanitizeFilename(input: string, format?: DocumentFormat): string {
  const base = (input ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .trim();
  const fallback = `document.${format ? DEFAULT_EXTENSION[format] : "bin"}`;
  if (!cleaned) return fallback;
  return truncateKeepingExtension(cleaned, MAX_FILENAME_CHARS);
}

/**
 * Storage object name derived from the display name. Supabase Storage only
 * accepts a restricted ASCII key alphabet, so accents are stripped and anything
 * else becomes "_".
 */
export function storageObjectName(displayName: string, format: DocumentFormat): string {
  const { stem, ext } = splitExtension(displayName);
  const safeStem =
    stem
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "") || "document";
  // splitExtension only yields ASCII alphanumeric extensions.
  return truncateKeepingExtension(`${safeStem}${ext || `.${DEFAULT_EXTENSION[format]}`}`, MAX_FILENAME_CHARS);
}

function isBlank(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // whitespace, NUL or UTF-8/UTF-16 BOM bytes (same rule as the parser)
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0xef && b !== 0xbb && b !== 0xbf && b !== 0xfe && b !== 0xff && b !== 0x00) {
      return false;
    }
  }
  return true;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface UploadInput {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
}

export interface UploadOptions {
  /** Maximum accepted size in bytes (clamped to the parser limit). */
  maxBytes: number;
  /** Import again even when the same file was already imported. */
  reprocess?: boolean;
}

export interface UploadResult {
  documentId: string;
  jobId: string;
  format: DocumentFormat;
  /** True when this exact file was already imported; `jobId` is that import's job. */
  alreadyImported: boolean;
}

/** Validates an upload without touching storage. Throws UploadRejectedError. */
export function validateUpload(file: UploadInput, maxBytes: number): DocumentFormat {
  const bytes = file.bytes;
  if (!bytes || bytes.length === 0 || isBlank(bytes)) throw new UploadRejectedError("empty");
  if (bytes.length > Math.min(maxBytes, MAX_DOCUMENT_BYTES)) throw new UploadRejectedError("too_large");
  const format = detectFormat(bytes, file.filename ?? "", file.mimeType);
  if (!format) throw new UploadRejectedError("unsupported");
  return format;
}

const FINISHED_OK = new Set(["completed", "needs_review"]);
const IN_FLIGHT = new Set(["queued", "processing"]);

function storageStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  const value = Number(e.statusCode ?? e.status);
  return Number.isFinite(value) ? value : undefined;
}

async function uploadOriginal(db: MonioClient, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  // Only ever called for a path that has no object yet: the bucket has no UPDATE
  // policy, so overwriting an existing object would be refused by RLS.
  const { error } = await db.storage.from(DOCUMENTS_BUCKET).upload(path, bytes, { contentType, upsert: true, cacheControl: "0" });
  if (!error) return;
  const status = storageStatus(error);
  if (status === 413) throw new UploadRejectedError("too_large");
  if (status === 415) throw new UploadRejectedError("unsupported");
  throw error;
}

async function createJob(db: MonioClient, userId: string, documentId: string): Promise<string> {
  const { data, error } = await db
    .from("import_jobs")
    .insert({ user_id: userId, document_id: documentId, status: "queued", stage: "received", progress: 0 })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

interface ExistingDocument {
  id: string;
  storage_path: string;
}

async function findDocument(db: MonioClient, userId: string, sha256: string): Promise<ExistingDocument | null> {
  const { data, error } = await db.from("documents").select("id, storage_path").eq("user_id", userId).eq("sha256", sha256).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Receives an upload: validates it, stores the original under
 * `${userId}/${documentId}/${safeName}`, and queues an import job.
 */
export async function receiveUpload(db: MonioClient, userId: string, file: UploadInput, opts: UploadOptions): Promise<UploadResult> {
  const format = validateUpload(file, opts.maxBytes);
  const bytes = file.bytes;
  const sha256 = sha256Hex(bytes);
  const contentType = CANONICAL_MIME_TYPES[format];
  const displayName = sanitizeFilename(file.filename, format);

  let existing = await findDocument(db, userId, sha256);

  if (!existing) {
    const documentId = randomUUID();
    const storagePath = `${userId}/${documentId}/${storageObjectName(displayName, format)}`;
    const { error } = await db.from("documents").insert({
      id: documentId,
      user_id: userId,
      storage_path: storagePath,
      original_filename: displayName,
      mime_type: contentType,
      size_bytes: bytes.length,
      sha256,
      detected_format: format,
      status: "uploaded",
    });
    if (error) {
      // A concurrent upload of the same file won the race: continue with its row.
      if (error.code !== "23505") throw error;
      existing = await findDocument(db, userId, sha256);
      if (!existing) throw error;
    } else {
      try {
        await uploadOriginal(db, storagePath, bytes, contentType);
      } catch (uploadError) {
        // Never keep a document row whose original is missing.
        await db.from("documents").delete().eq("id", documentId).eq("user_id", userId);
        throw uploadError;
      }
      const jobId = await createJob(db, userId, documentId);
      return { documentId, jobId, format, alreadyImported: false };
    }
  }

  // Same file seen before.
  const { data: latest, error: jobError } = await db
    .from("import_jobs")
    .select("id, status")
    .eq("user_id", userId)
    .eq("document_id", existing.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobError) throw jobError;
  if (latest && IN_FLIGHT.has(latest.status)) {
    // Already queued or running: never start a parallel import of the same file.
    return { documentId: existing.id, jobId: latest.id, format, alreadyImported: false };
  }
  if (latest && FINISHED_OK.has(latest.status) && !opts.reprocess) {
    return { documentId: existing.id, jobId: latest.id, format, alreadyImported: true };
  }

  // Retry after a failure, or explicit re-processing: make sure the original is stored.
  // exists() resolves false for a missing object and throws on other failures.
  const { data: present } = await db.storage.from(DOCUMENTS_BUCKET).exists(existing.storage_path);
  if (!present) await uploadOriginal(db, existing.storage_path, bytes, contentType);
  const jobId = await createJob(db, userId, existing.id);
  return { documentId: existing.id, jobId, format, alreadyImported: false };
}
