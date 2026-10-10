import { afterAll, beforeAll, expect, it } from "vitest";
import { adminClient, anonClient, createTestUser, type TestUser } from "../helpers";
import { pdfLearningStore, workerPdfLearningStore } from "@/server/import/pdf-learning-store";

let a: TestUser;
let b: TestUser;
const layout = "a".repeat(64);
beforeAll(async () => {
  a = await createTestUser("pdf-learning-a");
  b = await createTestUser("pdf-learning-b");
});
afterAll(async () => { await a?.cleanup(); await b?.cleanup(); });

it("counts distinct originals, scopes evidence and prevents browser certification", async () => {
  const admin = adminClient();
  const first = workerPdfLearningStore(a.client, a.id, "1".repeat(64));
  await first.confirm(layout);
  await first.confirm(layout);
  expect(await first.confirmations(layout)).toBe(1);
  await pdfLearningStore(admin, a.id, "2".repeat(64)).confirm(layout);
  expect(await first.confirmations(layout)).toBe(2);
  expect(await pdfLearningStore(admin, b.id, "3".repeat(64)).confirmations(layout)).toBe(0);
  const own = await a.client.from("pdf_reader_evidence").select("document_hash");
  expect(own.error).toBeNull();
  expect(own.data).toHaveLength(2);
  const other = await b.client.from("pdf_reader_evidence").select("document_hash");
  expect(other.error).toBeNull();
  expect(other.data).toEqual([]);
  const forged = await a.client.from("pdf_reader_evidence").insert({ user_id: a.id, layout_hash: layout, document_hash: "4".repeat(64) });
  expect(forged.error?.code).toBe("42501");
  const deleted = await a.client.from("pdf_reader_evidence").delete().eq("user_id", a.id);
  expect(deleted.error?.code).toBe("42501");
  expect((await anonClient().from("pdf_reader_evidence").select("document_hash")).error?.code).toBe("42501");
  await first.invalidate(layout);
  expect(await first.confirmations(layout)).toBe(0);
});
