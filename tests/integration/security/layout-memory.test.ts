import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, createTestUser, type TestUser } from "../helpers";
import { layoutMemoryStore } from "@/server/import/layout-memory-store";
import type { TableRecipe } from "@/server/import/parsers/layout-memory";

let a: TestUser;
let b: TestUser;
const signature = "a".repeat(64);
const recipe: TableRecipe = { kind: "table", date: 0, description: 1, amount: 2 };
beforeAll(async () => {
  a = await createTestUser("layout-memory-a");
  b = await createTestUser("layout-memory-b");
});
afterAll(async () => { await a?.cleanup(); await b?.cleanup(); });

it("remembers a recipe per user, ignores malformed ones and prevents browser writes", async () => {
  const memory = layoutMemoryStore(a.client, a.id);
  await memory.save(signature, recipe);
  await memory.save(signature, { ...recipe, balance: 3 });
  expect([...(await memory.load("table"))]).toEqual([[signature, { ...recipe, balance: 3 }]]);
  expect((await memory.load("pdf-table")).size).toBe(0);
  expect((await layoutMemoryStore(b.client, b.id).load("table")).size).toBe(0);

  const other = await b.client.from("import_layouts").select("signature");
  expect(other.error).toBeNull();
  expect(other.data).toEqual([]);
  const forged = await a.client.from("import_layouts").insert({ user_id: a.id, signature: "b".repeat(64), kind: "table", recipe: { kind: "table", date: 0, description: 1, amount: 5 } });
  expect(forged.error?.code).toBe("42501");
  const tampered = await a.client.from("import_layouts").update({ recipe: { kind: "table", date: 9, description: 1, amount: 2 } }).eq("user_id", a.id);
  expect(tampered.error?.code).toBe("42501");
  const deleted = await a.client.from("import_layouts").delete().eq("user_id", a.id);
  expect(deleted.error?.code).toBe("42501");
  expect((await anonClient().from("import_layouts").select("signature")).error?.code).toBe("42501");

  await memory.forget(signature);
  expect((await memory.load("table")).size).toBe(0);
});
