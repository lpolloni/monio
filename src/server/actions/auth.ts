"use server";

import { z } from "zod";
import { LOCALES } from "@/i18n/config";
import { createClient } from "@/server/supabase/server";

const inputSchema = z.object({
  mode: z.enum(["signin", "signup"]),
  email: z.email().trim().max(254),
  password: z.string().min(1).max(1024),
  name: z.string().trim().max(80),
  locale: z.enum(LOCALES),
}).superRefine((value, ctx) => {
  if (value.mode === "signup" && value.password.length < 8) {
    ctx.addIssue({ code: "custom", path: ["password"], message: "Password too short" });
  }
});

type AuthResult = { ok: true; confirmationRequired: boolean } | {
  ok: false; error: "invalidCredentials" | "confirmationEmailError" | "signupError" | "genericError";
};

/** Never return Supabase sessions, tokens or internal error details to the browser. */
export async function authenticate(input: unknown): Promise<AuthResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "genericError" };
  const { mode, email, password, name, locale } = parsed.data;
  try {
    const supabase = await createClient();
    const result = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { display_name: name || undefined, locale } } });
    if (result.error) {
      const error = result.error.message === "Error sending confirmation email" ? "confirmationEmailError"
        : result.error.code === "invalid_credentials" ? "invalidCredentials"
        : mode === "signup" ? "signupError" : "genericError";
      return { ok: false, error };
    }
    return { ok: true, confirmationRequired: mode === "signup" && !result.data.session };
  } catch {
    return { ok: false, error: mode === "signup" ? "signupError" : "genericError" };
  }
}
