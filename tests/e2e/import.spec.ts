import { expect, test } from "@playwright/test";
import { FIXTURES, signUpFreshUser } from "./helpers";

test.describe("document import (fresh user, real pipeline)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("imports statements, is idempotent, and rejects unsupported files", async ({ page }) => {
    await signUpFreshUser(page);
    await expect(page.getByRole("heading", { name: "Let's build your financial picture" })).toBeVisible();

    await page.goto("/en/import");
    await page.getByTestId("import-input").setInputFiles([`${FIXTURES}/n26.csv`, `${FIXTURES}/nubank-card.ofx`]);
    const summary = page.getByTestId("import-summary");
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toContainText("Import completed.");
    await expect(summary).toContainText(/\d+ transactions organized/);
    await expect(summary).toContainText(/\d+ accounts? identified/);

    await page.goto("/en/activity?period=all");
    await expect(page.getByText(/\d+ transactions/).first()).toBeVisible();

    // Same file again: recognized by its fingerprint, nothing duplicated.
    await page.goto("/en/import");
    await page.getByTestId("import-input").setInputFiles(`${FIXTURES}/n26.csv`);
    await expect(page.getByText("This file was already imported.")).toBeVisible({ timeout: 30_000 });

    // Unsupported content is refused before storage.
    await page.getByTestId("import-input").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) });
    await expect(page.getByText("This file type isn't supported. Use PDF, CSV, OFX or XLSX.")).toBeVisible({ timeout: 30_000 });

    await page.goto("/en");
    await expect(page.getByRole("group", { name: "Your institutions arranged around your net worth" })).toBeVisible();
  });
});
