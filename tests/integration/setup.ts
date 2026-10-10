import { existsSync } from "node:fs";
import path from "node:path";

// Integration tests talk to the real local Supabase DEV stack.
const envFile = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Integration tests need a running Supabase DEV stack and .env.local (npm run dev:services).");
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
  throw new Error("Integration tests only run against a local Supabase URL.");
}
