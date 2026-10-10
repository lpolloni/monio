import { expect, test } from "@playwright/test";

test("mobile: bottom navigation and ADD sheet", async ({ page }) => {
  await page.goto("/en");
  const nav = page.getByRole("navigation", { name: "Main navigation" }).filter({ visible: true });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add to Monio" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: /Import document/ }).click();
  await expect(page).toHaveURL(/\/en\/import$/);
});

test("mobile: institution details open as a bottom sheet", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("button", { name: /^Revolut:/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Revolut EUR")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
