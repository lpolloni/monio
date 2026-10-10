import { expect, test } from "@playwright/test";

test.describe("money views", () => {
  test("switching the display currency re-renders totals without touching originals", async ({ page }) => {
    await page.goto("/en");
    const hero = page.getByRole("heading", { level: 1 });
    await expect(hero).toContainText("€");
    await page.getByRole("radio", { name: "BRL" }).first().click();
    await expect(hero).toContainText("R$", { timeout: 20_000 });
    await page.goto("/en/activity?q=Netflix&period=all");
    // Original amounts stay in their own currency.
    await expect(page.getByText("-€15.99").first()).toBeVisible();
    await page.goto("/en");
    await page.getByRole("radio", { name: "EUR" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("€", { timeout: 20_000 });
  });

  test("explore filters by type and shows credit limits as non-assets", async ({ page }) => {
    await page.goto("/en/explore");
    await page.getByRole("radio", { name: "Cards" }).click();
    await expect(page.getByText("Nubank Ultravioleta")).toBeVisible();
    await expect(page.getByText(/not counted as an asset/)).toBeVisible();
    await expect(page.getByText("Conto BBVA")).toHaveCount(0);
    await page.getByText("Nubank Ultravioleta").click();
    await expect(page).toHaveURL(/\/en\/explore\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Nubank Ultravioleta" })).toBeVisible();
  });

  test("activity search, transaction provenance and category correction", async ({ page }) => {
    await page.goto("/en/activity?period=all");
    await page.getByPlaceholder("Search merchant or description").fill("Spotify");
    await expect(page).toHaveURL(/q=Spotify/);
    const rows = page.locator("main button").filter({ hasText: "Spotify" });
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Provenance")).toBeVisible();
    await expect(sheet.getByText(/Demo data — fictional/)).toBeVisible();
    await sheet.getByRole("button", { name: "Entertainment" }).click();
    await expect(page.getByText("Category updated. Monio will remember this.")).toBeVisible();
  });

  test("account settings: rename, move to a new shared entity, exclude from net worth, then restore", async ({ page }) => {
    await page.goto("/en/explore");
    await page.getByText("Revolut EUR").first().click();
    await expect(page).toHaveURL(/\/en\/explore\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Revolut EUR" })).toBeVisible();

    await page.getByRole("button", { name: "Account settings" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Account name").fill("Revolut Travel");
    await dialog.getByRole("radio", { name: /New business or shared entity/ }).check();
    await dialog.getByLabel("Entity name").fill("Trip fund");
    await dialog.getByRole("radio", { name: "Shared", exact: true }).click();
    await dialog.getByRole("switch", { name: "Count in net worth" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Revolut Travel" })).toBeVisible();
    await expect(page.getByText("Not in net worth")).toBeVisible();
    await expect(page.getByText("Trip fund").first()).toBeVisible();

    await page.getByRole("button", { name: "Account settings" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Account name").fill("Revolut EUR");
    await dialog.getByRole("radio", { name: /^Personal/ }).check();
    await dialog.getByRole("switch", { name: "Count in net worth" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Revolut EUR" })).toBeVisible();
    await expect(page.getByText("Not in net worth")).toHaveCount(0);
  });

  test("recurring payments list detected subscriptions", async ({ page }) => {
    await page.goto("/en/activity?tab=recurring");
    await expect(page.getByText("Netflix").first()).toBeVisible();
    await expect(page.getByText("Subscription").first()).toBeVisible();
  });

  test("insights show evidence-backed observations", async ({ page }) => {
    await page.goto("/en/insights");
    await expect(page.getByText(/Netflix changed its price/).first()).toBeVisible();
    await page.getByRole("button", { name: "Evidence" }).first().click();
    await expect(page.locator("pre").first()).toBeVisible();
  });
});
