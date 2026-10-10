import { expect, test } from "@playwright/test";

test.describe("watch-only wallets", () => {
  test("refuses private keys and recovery phrases before anything is sent", async ({ page }) => {
    await page.goto("/en/connect-wallet");
    const input = page.getByLabel("Public address or extended public key");
    // Well-known example key from the Bitcoin wiki (public documentation, not funds).
    await input.fill("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ");
    await expect(page.getByText(/looks like a PRIVATE key/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Start watching" })).toBeDisabled();
    await input.fill("abandon ability able about above absent absorb abstract absurd abuse access accident");
    await expect(page.getByText(/looks like a recovery phrase/)).toBeVisible();
  });

  test("connects an EVM address and discovers assets (mock provider)", async ({ page }) => {
    await page.goto("/en/connect-wallet");
    await page.getByRole("radio", { name: /Ethereum & EVM/ }).click();
    // Public test address; balances come from fictional mock fixtures.
    await page.getByLabel("Public address or extended public key").fill("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    await expect(page.getByText(/Valid EVM address/)).toBeVisible();
    await page.getByLabel("Name (optional)").fill("E2E watch wallet");
    await page.getByRole("button", { name: "Start watching" }).click();
    await expect(page).toHaveURL(/\/en\/explore\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "E2E watch wallet" })).toBeVisible();
    await expect(page.getByText("Read-only. No signing, no transfers, ever.").first()).toBeVisible();
  });
});

test("unknown account ids show a not-found state", async ({ page }) => {
  await page.goto("/en/explore/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
