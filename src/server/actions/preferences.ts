"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DISPLAY_CURRENCIES } from "@/domain/money/currencies";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { getSession } from "../data/session";

type ActionResult = { ok: true } | { ok: false; error: "unauthorized" | "validation" | "failed" };

async function session() {
  const s = await getSession();
  if (!s) return null;
  return s;
}

export async function setDisplayCurrency(currency: string): Promise<ActionResult> {
  const parsed = z.enum(DISPLAY_CURRENCIES).safeParse(currency);
  if (!parsed.success) return { ok: false, error: "validation" };
  const s = await session();
  if (!s) return { ok: false, error: "unauthorized" };
  const { error } = await s.supabase.from("profiles").update({ primary_currency: parsed.data }).eq("id", s.userId);
  if (error) return { ok: false, error: "failed" };
  refresh();
  return { ok: true };
}

export async function setIncludeBusiness(include: boolean): Promise<ActionResult> {
  const s = await session();
  if (!s) return { ok: false, error: "unauthorized" };
  const { error } = await s.supabase
    .from("profiles")
    .update({ include_business_in_net_worth: include === true })
    .eq("id", s.userId);
  if (error) return { ok: false, error: "failed" };
  refresh();
  return { ok: true };
}

export async function setAiCloudConsent(consent: boolean): Promise<ActionResult> {
  const s = await session();
  if (!s) return { ok: false, error: "unauthorized" };
  const { error } = await s.supabase.from("profiles").update({ ai_cloud_consent: consent === true }).eq("id", s.userId);
  if (error) return { ok: false, error: "failed" };
  await s.supabase.rpc("log_user_action", {
    p_action: consent ? "ai.cloud_consent_granted" : "ai.cloud_consent_revoked",
    p_target_table: "profiles",
    p_target_id: s.userId,
    p_details: {},
  });
  refresh();
  return { ok: true };
}

export async function updateDisplayName(name: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(80).safeParse(name);
  if (!parsed.success) return { ok: false, error: "validation" };
  const s = await session();
  if (!s) return { ok: false, error: "unauthorized" };
  const { error } = await s.supabase.from("profiles").update({ display_name: parsed.data }).eq("id", s.userId);
  if (error) return { ok: false, error: "failed" };
  refresh();
  return { ok: true };
}

/** Persists the language choice (cookie for routing + profile); the client navigates to the new locale. */
export async function setLocalePreference(locale: Locale): Promise<ActionResult> {
  const parsed = z.enum(LOCALES).safeParse(locale);
  if (!parsed.success) return { ok: false, error: "validation" };
  const store = await cookies();
  store.set(LOCALE_COOKIE, parsed.data, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  const s = await session();
  if (s) await s.supabase.from("profiles").update({ locale: parsed.data }).eq("id", s.userId);
  return { ok: true };
}

export async function signOut(locale: Locale): Promise<void> {
  const s = await session();
  if (s) await s.supabase.auth.signOut();
  redirect(`/${LOCALES.includes(locale) ? locale : "pt"}/login`);
}
