import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { getLocale } from "@/i18n/server";
import { createClient } from "../supabase/server";

export interface Session {
  userId: string;
  email: string | null;
  supabase: Awaited<ReturnType<typeof createClient>>;
}

/**
 * Data Access Layer entry point: verifies the session JWT (getClaims validates
 * the signature) once per request. Every data function starts here.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  // Session checks depend on the current time (token expiry): always request-time.
  await connection();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (error || typeof sub !== "string") return null;
  const email = typeof data?.claims?.email === "string" ? data.claims.email : null;
  return { userId: sub, email, supabase };
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }
  return session;
}

export interface Profile {
  id: string;
  displayName: string | null;
  locale: "pt" | "en" | "it";
  primaryCurrency: string;
  includeBusiness: boolean;
  aiCloudConsent: boolean;
}

export const getProfile = cache(async (): Promise<Profile> => {
  const { supabase, userId } = await requireSession();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, locale, primary_currency, include_business_in_net_worth, ai_cloud_consent")
    .eq("id", userId)
    .single();
  if (error || !data) throw new Error("Profile not found");
  return {
    id: data.id,
    displayName: data.display_name,
    locale: data.locale as Profile["locale"],
    primaryCurrency: data.primary_currency,
    includeBusiness: data.include_business_in_net_worth,
    aiCloudConsent: data.ai_cloud_consent,
  };
});
