"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { todayIso } from "../data/dates";
import { getSession } from "../data/session";
import { postProcessUser } from "../processing/post-process";
import { RemovalBlockedError, removeAccount, removeDocument, type RemovalStats } from "../processing/removal";

type Result = { ok: true } | { ok: false; error: "unauthorized" | "validation" | "not_found" | "failed" };

const AccountSettingsSchema = z.object({
  accountId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  includeInNetWorth: z.boolean(),
  entity: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("existing"), entityId: z.uuid() }),
    z.object({
      mode: z.literal("new"),
      name: z.string().trim().min(1).max(80),
      kind: z.enum(["business", "shared"]),
    }),
  ]),
});

export type AccountSettingsInput = z.input<typeof AccountSettingsSchema>;

/**
 * Renames an account, moves it to another ownership entity (optionally a new
 * business/shared one) and toggles whether it counts towards net worth.
 * Ownership is enforced twice: RLS on every table and the composite
 * `(entity_id, user_id)` foreign key, so another user's entity id is rejected.
 */
export async function updateAccountSettings(input: AccountSettingsInput): Promise<Result> {
  const parsed = AccountSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { accountId, name, includeInNetWorth, entity } = parsed.data;
  const s = await getSession();
  if (!s) return { ok: false, error: "unauthorized" };

  const { data: account } = await s.supabase.from("accounts").select("id, entity_id").eq("id", accountId).eq("user_id", s.userId).maybeSingle();
  if (!account) return { ok: false, error: "not_found" };

  let entityId: string;
  if (entity.mode === "new") {
    const { data: created, error } = await s.supabase
      .from("financial_entities")
      .insert({ user_id: s.userId, name: entity.name, kind: entity.kind })
      .select("id")
      .single();
    if (error || !created) return { ok: false, error: "failed" };
    entityId = created.id;
  } else {
    const { data: existing } = await s.supabase.from("financial_entities").select("id").eq("id", entity.entityId).eq("user_id", s.userId).maybeSingle();
    if (!existing) return { ok: false, error: "not_found" };
    entityId = existing.id;
  }

  const { error } = await s.supabase
    .from("accounts")
    .update({ name, include_in_net_worth: includeInNetWorth, entity_id: entityId })
    .eq("id", accountId)
    .eq("user_id", s.userId);
  if (error) return { ok: false, error: "failed" };

  await s.supabase.rpc("log_user_action", {
    p_action: "account.settings_updated",
    p_target_table: "accounts",
    p_target_id: accountId,
    p_details: { entityChanged: entityId !== account.entity_id, includeInNetWorth },
  });
  // Ownership drives transfer matching and business-income defaults.
  if (entityId !== account.entity_id) await postProcessUser(s.supabase, s.userId, { today: todayIso() });
  refresh();
  return { ok: true };
}

type RemovalResult = { ok: true; removed: RemovalStats } | { ok: false; error: "unauthorized" | "validation" | "not_found" | "busy" | "failed" };

async function runRemoval(kind: "account" | "document", id: string): Promise<RemovalResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "validation" };
  const s = await getSession();
  if (!s) return { ok: false, error: "unauthorized" };
  let removed: RemovalStats;
  try {
    removed = kind === "account" ? await removeAccount(s.supabase, s.userId, id) : await removeDocument(s.supabase, s.userId, id);
  } catch (error) {
    if (error instanceof RemovalBlockedError) return { ok: false, error: error.reason };
    console.error(`[removal] ${kind} removal failed`, error instanceof Error ? error.name : "error");
    return { ok: false, error: "failed" };
  }
  await s.supabase.rpc("log_user_action", {
    p_action: `${kind}.deleted`,
    p_target_table: kind === "account" ? "accounts" : "documents",
    p_target_id: id,
    p_details: { ...removed },
  });
  // Transfers, duplicates, recurring series and insights were derived from the removed rows.
  try {
    await postProcessUser(s.supabase, s.userId, { today: todayIso() });
  } catch (error) {
    console.error("[removal] post-processing failed", error instanceof Error ? error.name : "error");
  }
  refresh();
  return { ok: true, removed };
}

/** Deletes an account, its transactions and the documents that only fed it. Irreversible. */
export async function deleteAccount(accountId: string): Promise<RemovalResult> {
  return runRemoval("account", accountId);
}

/** Deletes an imported document and everything it brought in. Irreversible. */
export async function deleteDocument(documentId: string): Promise<RemovalResult> {
  return runRemoval("document", documentId);
}
