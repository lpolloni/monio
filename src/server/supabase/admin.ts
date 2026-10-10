import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "../env";
import type { Database } from "./database.types";

/**
 * Service-role client. BYPASSES Row Level Security — use only for:
 *  - global reference data (exchange rates, crypto asset catalog),
 *  - auth administration (account deletion),
 * and always scope user data explicitly by user_id. Never expose to the browser.
 */
export function createAdminClient() {
  const env = getServerEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
