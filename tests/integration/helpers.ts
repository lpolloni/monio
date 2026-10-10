import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/supabase/database.types";

export type TestClient = SupabaseClient<Database>;

export function adminClient(): TestClient {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(): TestClient {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  /** Client signed in as this user (RLS applies). */
  client: TestClient;
  accessToken: string;
  /** Default personal entity created by the signup trigger. */
  personalEntityId: string;
  cleanup: () => Promise<void>;
}

/** Creates a throwaway confirmed user and signs in with the publishable key. */
export async function createTestUser(label = "it"): Promise<TestUser> {
  const admin = adminClient();
  const email = `${label}-${randomUUID().slice(0, 8)}@test.monio.dev`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: label } });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const client = anonClient();
  const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !session.session) throw signInError ?? new Error("signIn failed");
  const { data: entity } = await client.from("financial_entities").select("id").eq("kind", "personal").single();
  return {
    id: data.user.id,
    email,
    password,
    client,
    accessToken: session.session.access_token,
    personalEntityId: entity!.id,
    cleanup: async () => {
      await admin.auth.admin.deleteUser(data.user.id);
    },
  };
}
