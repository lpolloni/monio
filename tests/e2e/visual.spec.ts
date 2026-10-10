import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, settle } from "./helpers";

const PAGES: [string, string][] = [
  ["home", "/en"],
  ["explore", "/en/explore"],
  ["activity", "/en/activity"],
  ["insights", "/en/insights"],
  ["inbox", "/en/inbox"],
  ["settings", "/en/settings"],
  ["import", "/en/import"],
  ["wallet", "/en/connect-wallet"],
];

for (const theme of ["dark", "light"] as const) {
  for (const [name, path] of PAGES) {
    test(`${name} renders without overflow (${theme})`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(path);
      await settle(page);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-${theme}-${name}.png`, fullPage: true });
    });
  }
}

test("login page renders without overflow", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: testInfo.project.use.viewport ?? undefined });
  const page = await context.newPage();
  await page.goto("/pt/login");
  await expect(page.getByRole("heading", { name: "Seu dinheiro, vivo." })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-login.png`, fullPage: true });
  await context.close();
});
