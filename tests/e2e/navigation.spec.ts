import { expect, test } from "@playwright/test";
import { settle } from "./helpers";

test("home shows the consolidated picture and navigation works", async ({ page }, testInfo) => {
  await page.goto("/en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("€");
  await expect(page.getByRole("group", { name: "Your institutions arranged around your net worth" })).toBeVisible();
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await settle(page);

  const nav = page.getByRole("navigation", { name: "Main navigation" }).filter({ visible: true }).first();
  await nav.getByRole("link", { name: "Explore" }).click();
  await expect(page).toHaveURL(/\/en\/explore$/);
  await expect(page.getByRole("heading", { name: "Explore" })).toBeVisible();

  await nav.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/en\/activity/);
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

  await nav.getByRole("link", { name: "Insights" }).click();
  await expect(page.getByRole("heading", { name: "Insights" })).toBeVisible();
  await expect(page.getByText("Net worth evolution")).toBeVisible();

  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Smart Inbox" })).toBeVisible();

  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("navigation", { name: "Main navigation" }).filter({ visible: true })).toHaveCount(1);
  }
});

test("selecting an institution reveals its accounts", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("button", { name: /^Nubank:/ }).click();
  const panel = page.getByRole("dialog").or(page.locator("main"));
  await expect(panel.getByText("Conta Nubank").first()).toBeVisible();
  await expect(panel.getByText("Nubank Ultravioleta").first()).toBeVisible();
});
