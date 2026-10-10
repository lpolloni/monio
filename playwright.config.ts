import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The cloud sandbox ships Chromium at /opt/pw-browsers; locally Playwright's own browser is used.
const sandboxChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1, // tests share the seeded demo user and mutate it
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, storageState: "tests/e2e/.auth/demo.json" },
    },
    {
      name: "tablet",
      dependencies: ["setup"],
      testMatch: /(visual|navigation|a11y)\.spec\.ts/,
      use: { viewport: { width: 834, height: 1194 }, hasTouch: true, deviceScaleFactor: 2, storageState: "tests/e2e/.auth/demo.json" },
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      testMatch: /(visual|navigation|a11y|mobile)\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, storageState: "tests/e2e/.auth/demo.json" },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: `${baseURL}/en/login`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
