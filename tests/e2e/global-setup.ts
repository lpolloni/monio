import { execFileSync } from "node:child_process";

/** Resets the fictional demo data so every E2E run starts from the same state. */
export default function globalSetup() {
  if (process.env.E2E_SKIP_SEED === "1") return;
  execFileSync("npm", ["run", "dev:seed"], { stdio: "inherit" });
}
