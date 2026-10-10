import { expect, it, vi } from "vitest";
import { categorizeBatch } from "./categorize";
import type { AiService } from "../ai";

const ids = new Map([["health", "health-id"], ["shopping", "shopping-id"]]);
it("uses user rules ahead of recognition and sends only leftovers to AI", async () => {
  const interpretTransactions = vi.fn().mockResolvedValue({ ok: true, data: [] });
  const ai = { interpretTransactions } as unknown as AiService;
  const result = await categorizeBatch([
    { key: "a", description: "FARMACIA AURORA", amount: "-10", currency: "BRL" },
    { key: "b", description: "DROGARIA AURORA", amount: "-10", currency: "BRL" },
    { key: "c", description: "PIX MARIA", amount: "-10", currency: "BRL" },
  ], [{ id: "user-rule", userId: "owner", matchType: "contains", pattern: "FARMACIA", merchant: null, categoryId: "shopping-id", categorySlug: "shopping", direction: "out", priority: 50 }], ids, ai);
  expect(result.results.get("a")).toMatchObject({ categorySlug: "shopping", ruleId: "user-rule" });
  expect(result.results.get("b")).toMatchObject({ categorySlug: "health", source: "rule" });
  expect(interpretTransactions.mock.calls[0]![0]).toHaveLength(1);
  expect(result.results.get("c")?.categoryId).toBeNull();
});
it("keeps different AI contexts separate and learns full descriptions within DB limits", async () => {
  const interpretTransactions = vi.fn().mockImplementation(async (items) => ({ ok: true, data: items.map((item: { id: string }) => ({ id: item.id, category: "shopping", merchant: null, confidence: 0.95, recurring_candidate: false })) }));
  const ai = { interpretTransactions } as unknown as AiService;
  const result = await categorizeBatch([
    { key: "a", description: "PIX ENVIADO PARA MARIA SILVA", amount: "-10", currency: "BRL" },
    { key: "b", description: "PIX ENVIADO PARA MARIA SILVA", amount: "-10", currency: "EUR" },
    { key: "c", description: "X".repeat(130), amount: "-10", currency: "EUR" },
  ], [], ids, ai);
  expect(interpretTransactions.mock.calls[0]![0]).toHaveLength(3);
  expect(result.learned.map((r) => r.pattern)).toEqual(["PIX ENVIADO PARA MARIA SILVA", "PIX ENVIADO PARA MARIA SILVA"]);
  expect(result.results.get("c")?.categorySlug).toBe("shopping");
});
