import { expect, test as setup } from "@playwright/test";
import { DEMO } from "./helpers";

setup("sign in as the demo user", async ({ page }) => {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(DEMO.email);
  await page.getByLabel("Password").fill(DEMO.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/en$/);
  await expect(page.getByText("Net worth").first()).toBeVisible();
  await page.context().storageState({ path: "tests/e2e/.auth/demo.json" });
});
