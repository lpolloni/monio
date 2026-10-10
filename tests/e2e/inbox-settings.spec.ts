import { expect, test } from "@playwright/test";

test("smart inbox resolves a question with one tap", async ({ page }) => {
  await page.goto("/en/inbox");
  const cards = page.locator("article");
  const before = await cards.count();
  expect(before).toBeGreaterThan(0);
  const transfer = cards.filter({ hasText: "transfer between your accounts" }).first();
  await expect(transfer).toBeVisible();
  await transfer.getByRole("button", { name: "Yes, transfer" }).click();
  await expect(page.getByText("Thanks — updated.")).toBeVisible();
  await expect(cards).toHaveCount(before - 1);
});

test("settings: language switch, display currency and AI status", async ({ page }) => {
  await page.goto("/en/settings");
  await expect(page.getByText("Mock (deterministic, development)")).toBeVisible();
  await expect(page.getByText("Environment: DEVELOPMENT")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Allow sending financial data to a cloud AI provider" })).toBeDisabled();
  await page.getByRole("radio", { name: "Italiano" }).click();
  await expect(page).toHaveURL(/\/it\/settings$/);
  await expect(page.getByRole("heading", { name: "Impostazioni" })).toBeVisible();
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page).toHaveURL(/\/en\/settings$/);
});

test("deleting data requires typing DELETE", async ({ page }) => {
  await page.goto("/en/settings");
  const button = page.getByRole("button", { name: "Delete all financial data" });
  await expect(button).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("delete");
  await expect(button).toBeDisabled();
});
