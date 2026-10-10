"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/server/supabase/database.types";
import { publicEnv } from "../public-env";

/** Browser client — used only for authentication flows (sign in / sign up / sign out). */
export function createBrowserSupabase() {
  return createBrowserClient<Database>(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey);
}
