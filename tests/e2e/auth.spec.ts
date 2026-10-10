import { expect, test } from "@playwright/test";
import { DEMO } from "./helpers";

test.describe("authentication", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("redirects anonymous visitors to the localized login page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/(pt|en|it)\/login/);
    await page.goto("/en/activity");
    await expect(page).toHaveURL(/\/en\/login\?next=%2Factivity/);
  });

  test("rejects a wrong password without revealing which field was wrong", async ({ page }) => {
    await page.goto("/en/login");
    await page.getByLabel("Email").fill(DEMO.email);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  });

  test("signs in, returns to the requested page, and signs out", async ({ page }) => {
    await page.goto("/en/insights");
    await page.getByLabel("Email").fill(DEMO.email);
    await page.getByLabel("Password").fill(DEMO.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/insights$/);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/en\/login/);
  });
});
