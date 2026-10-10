import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const DEMO = { email: "demo@monio.dev", password: "MonioDemo!2026" };
export const FIXTURES = "tests/fixtures/statements";

/** Signs up a brand-new user through the UI (fresh, empty financial data). */
export async function signUpFreshUser(page: Page): Promise<string> {
  const email = `e2e-${randomUUID().slice(0, 8)}@test.monio.dev`;
  await page.context().clearCookies();
  await page.goto("/en/login");
  await page.getByRole("radio", { name: "Create account" }).click();
  await page.getByLabel("Your name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(`Pw-${randomUUID()}`);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL(/\/en$/);
  return email;
}

/** Waits for streamed content and scrolls so viewport-triggered animations run. */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 700) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

/** The page must never scroll horizontally. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(1);
}
