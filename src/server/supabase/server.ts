import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getServerEnv } from "../env";
import type { Database } from "./database.types";

export type MonioClient = ReturnType<typeof createSupabaseClient<Database>>;

/**
 * Supabase client bound to the signed-in user's session cookies. Every query runs
 * with the user's JWT, so Row Level Security applies. Use in Server Components,
 * Server Actions and Route Handlers.
 */
export async function createClient() {
  const env = getServerEnv();
  const cookieStore = await cookies();
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}

/**
 * Client authenticated with an explicit user access token (still RLS-enforced).
 * Used for work that continues after the response is sent (e.g. import
 * processing inside `after()`), where request cookies are no longer writable.
 */
export function createClientForAccessToken(accessToken: string) {
  const env = getServerEnv();
  return createSupabaseClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
