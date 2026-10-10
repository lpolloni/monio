/**
 * Browser-safe configuration. Only NEXT_PUBLIC_* values belong here; Next.js
 * inlines them at build time, so each variable must be referenced literally.
 * A build made for one environment keeps that environment's public URLs —
 * rebuild per environment (DEV / STG / PROD).
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
} as const;

export function assertPublicEnv(): void {
  const missing: string[] = [];
  if (!publicEnv.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publicEnv.supabasePublishableKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing public environment variables: ${missing.join(", ")}. Run \`npm run dev:env\`.`);
  }
}
