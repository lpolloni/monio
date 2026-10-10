import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settle } from "./helpers";

const PAGES = ["/en", "/en/explore", "/en/activity", "/en/insights", "/en/inbox", "/en/settings", "/en/import", "/en/connect-wallet"];

for (const path of PAGES) {
  test(`no serious accessibility violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    await settle(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const summary = serious.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`);
    expect(summary, summary.join("\n")).toEqual([]);
  });
}
