#!/usr/bin/env node
// Starts / stops the local Supabase DEV stack.
//
//   node scripts/dev-services.mjs start   # docker check, image prep, supabase start
//   node scripts/dev-services.mjs stop
//
// Restricted networks: set SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.gcr.io when the
// default registry (public.ecr.aws) is unreachable. Three images are not published
// under supabase/* on that mirror; they are pulled from their upstream repositories
// on the same mirror and re-tagged (they are the images Supabase itself mirrors).

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const command = process.argv[2] ?? "start";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
}

function dockerReady() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MIRROR_FALLBACKS = {
  "supabase/kong:2.8.1": "library/kong:2.8.1",
  "supabase/mailpit:v1.31.3": "axllent/mailpit:v1.31.3",
  "supabase/postgrest:v16.4": "postgrest/postgrest:v16.4",
};

function prepareMirrorImages(registry) {
  for (const [target, upstream] of Object.entries(MIRROR_FALLBACKS)) {
    const targetRef = `${registry}/${target}`;
    try {
      execFileSync("docker", ["image", "inspect", targetRef], { stdio: "ignore" });
      continue;
    } catch {
      // not present locally
    }
    console.log(`Preparing ${targetRef} from ${registry}/${upstream}`);
    run("docker", ["pull", `${registry}/${upstream}`]);
    run("docker", ["tag", `${registry}/${upstream}`, targetRef]);
  }
}

if (command === "start") {
  if (!dockerReady()) {
    console.error(
      "Docker daemon is not reachable. Start Docker (or `dockerd &` as root in a VM) and retry.",
    );
    process.exit(1);
  }
  const registry = process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY;
  if (registry === "mirror.gcr.io") prepareMirrorImages(registry);
  run("npx", ["supabase", "start"]);
  run("node", ["scripts/dev-env.mjs"]);
} else if (command === "stop") {
  run("npx", ["supabase", "stop"]);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
