/**
 * Storage bucket `documents`: private, one folder per user (`<uid>/...`), restricted MIME types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, anonClient, createTestUser, type TestUser } from "../helpers";
import { rand } from "./fixtures";

const BUCKET = "documents";
const CSV = "date,description,amount\n2026-03-01,FICTIONAL GROCER,-23.45\n";

let A: TestUser;
let B: TestUser;
let aPath: string;

const csvBlob = (text = CSV) => new Blob([text], { type: "text/csv" });

async function purge(prefix: string) {
  const store = adminClient().storage.from(BUCKET);
  const { data } = await store.list(prefix, { limit: 1000 });
  if (data?.length) await store.remove(data.map((o) => `${prefix}/${o.name}`));
}

async function adminCanDownload(path: string): Promise<string | null> {
  const { data } = await adminClient().storage.from(BUCKET).download(path);
  return data ? await data.text() : null;
}

beforeAll(async () => {
  A = await createTestUser("sec-sto-a");
  B = await createTestUser("sec-sto-b");
  aPath = `${A.id}/statement-${rand()}.csv`;
  const { error } = await A.client.storage.from(BUCKET).upload(aPath, csvBlob(), { contentType: "text/csv" });
  if (error) throw error;
});

afterAll(async () => {
  if (A) await purge(A.id);
  if (B) await purge(B.id);
  await A?.cleanup();
  await B?.cleanup();
});

describe("bucket configuration", () => {
  it("is private, size-limited and MIME-restricted", async () => {
    const { data, error } = await adminClient().storage.getBucket(BUCKET);
    expect(error).toBeNull();
    expect(data?.public).toBe(false);
    expect(data?.file_size_limit).toBe(15 * 1024 * 1024);
    expect([...(data?.allowed_mime_types ?? [])].sort()).toEqual(
      ["application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/x-ofx", "text/csv"].sort(),
    );
  });

  it("users cannot list, read, create or reconfigure buckets", async () => {
    const list = await A.client.storage.listBuckets();
    expect(list.data ?? []).toEqual([]);
    expect((await A.client.storage.getBucket(BUCKET)).data).toBeNull();
    expect((await A.client.storage.updateBucket(BUCKET, { public: true })).error).not.toBeNull();
    expect((await A.client.storage.createBucket(`evil-${rand()}`, { public: true })).error).not.toBeNull();
    expect((await adminClient().storage.getBucket(BUCKET)).data?.public).toBe(false);
  });
});

describe("owner access", () => {
  it("A can upload into its own folder and download the object", async () => {
    const { data, error } = await A.client.storage.from(BUCKET).download(aPath);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(CSV);
  });

  it("A can list its own folder", async () => {
    const { data, error } = await A.client.storage.from(BUCKET).list(A.id);
    expect(error).toBeNull();
    expect(data?.map((o) => `${A.id}/${o.name}`)).toContain(aPath);
  });

  it("objects are write-once for users: A cannot overwrite even its own object (no UPDATE policy)", async () => {
    const { error } = await A.client.storage.from(BUCKET).upload(aPath, csvBlob("overwritten"), { contentType: "text/csv", upsert: true });
    expect(error).not.toBeNull();
    expect(await adminCanDownload(aPath)).toBe(CSV);
  });
});

describe("cross-user access", () => {
  it("A cannot upload into B's folder, the bucket root or a shared prefix", async () => {
    for (const path of [`${B.id}/planted-${rand()}.csv`, `planted-${rand()}.csv`, `shared/planted-${rand()}.csv`]) {
      const { error } = await A.client.storage.from(BUCKET).upload(path, csvBlob(), { contentType: "text/csv" });
      expect(error, path).not.toBeNull();
    }
    const { data } = await adminClient().storage.from(BUCKET).list(B.id);
    expect(data ?? []).toEqual([]);
  });

  it("path traversal out of the own folder is rejected", async () => {
    for (const path of [`${A.id}/../${B.id}/traversal.csv`, `${A.id}/%2e%2e/${B.id}/traversal.csv`]) {
      const { error } = await A.client.storage.from(BUCKET).upload(path, csvBlob(), { contentType: "text/csv" });
      expect(error, path).not.toBeNull();
    }
    const { data } = await adminClient().storage.from(BUCKET).list(B.id);
    expect(data ?? []).toEqual([]);
  });

  it("B cannot download, sign, or list A's objects", async () => {
    const store = B.client.storage.from(BUCKET);
    const dl = await store.download(aPath);
    expect(dl.data).toBeNull();
    expect(dl.error).not.toBeNull();
    const signed = await store.createSignedUrl(aPath, 60);
    expect(signed.data).toBeNull();
    const list = await store.list(A.id);
    expect(list.data ?? []).toEqual([]);
    const root = await store.list("");
    expect((root.data ?? []).map((o) => o.name)).not.toContain(A.id);
  });

  it("B cannot delete, overwrite, move or copy A's objects", async () => {
    const store = B.client.storage.from(BUCKET);
    const removed = await store.remove([aPath]);
    expect(removed.data ?? []).toEqual([]);
    const overwrite = await store.upload(aPath, csvBlob("evil"), { contentType: "text/csv", upsert: true });
    expect(overwrite.error).not.toBeNull();
    const moved = await store.move(aPath, `${B.id}/moved.csv`);
    expect(moved.error).not.toBeNull();
    const copied = await store.copy(aPath, `${B.id}/copied.csv`);
    expect(copied.error).not.toBeNull();
    expect(await adminCanDownload(aPath)).toBe(CSV);
    expect((await adminClient().storage.from(BUCKET).list(B.id)).data ?? []).toEqual([]);
  });

  it("A cannot copy its own object into B's folder", async () => {
    const { error } = await A.client.storage.from(BUCKET).copy(aPath, `${B.id}/gift.csv`);
    expect(error).not.toBeNull();
    expect((await adminClient().storage.from(BUCKET).list(B.id)).data ?? []).toEqual([]);
  });
});

describe("content restrictions", () => {
  it.each(["text/html", "image/svg+xml", "application/javascript", "application/octet-stream", "application/x-msdownload"])(
    "rejects MIME type %s",
    async (type) => {
      const path = `${A.id}/blocked-${rand()}`;
      const { error } = await A.client.storage.from(BUCKET).upload(path, new Blob(["<script>alert(1)</script>"], { type }), { contentType: type });
      expect(error).not.toBeNull();
      expect(await adminCanDownload(path)).toBeNull();
    },
  );

  it.each(["text/csv", "application/pdf", "application/x-ofx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])(
    "accepts MIME type %s",
    async (type) => {
      const { error } = await A.client.storage.from(BUCKET).upload(`${A.id}/allowed-${rand()}`, new Blob(["fictional"], { type }), { contentType: type });
      expect(error).toBeNull();
    },
  );

  it("rejects objects above the 15 MiB limit", async () => {
    const big = new Blob([new Uint8Array(15 * 1024 * 1024 + 1).fill(0x61)], { type: "text/csv" });
    const path = `${A.id}/too-big-${rand()}.csv`;
    const { error } = await A.client.storage.from(BUCKET).upload(path, big, { contentType: "text/csv" });
    expect(error).not.toBeNull();
    expect(await adminCanDownload(path)).toBeNull();
  });
});

describe("public and anonymous access", () => {
  it("the public URL of a private object does not serve it", async () => {
    const { publicUrl } = A.client.storage.from(BUCKET).getPublicUrl(aPath).data;
    const res = await fetch(publicUrl);
    expect(res.ok).toBe(false);
    expect(await res.text()).not.toContain("FICTIONAL GROCER");
  });

  it("the authenticated object URL requires a session", async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${aPath}`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
    });
    expect(res.ok).toBe(false);
  });

  it("anon cannot download, list or upload", async () => {
    const store = anonClient().storage.from(BUCKET);
    expect((await store.download(aPath)).data).toBeNull();
    expect((await store.list(A.id)).data ?? []).toEqual([]);
    expect((await store.createSignedUrl(aPath, 60)).data).toBeNull();
    const up = await store.upload(`${A.id}/anon-${rand()}.csv`, csvBlob(), { contentType: "text/csv" });
    expect(up.error).not.toBeNull();
  });

  it("a signed URL created by the owner is scoped to that object only", async () => {
    const { data } = await A.client.storage.from(BUCKET).createSignedUrl(aPath, 60);
    expect(data?.signedUrl).toBeTruthy();
    const ok = await fetch(data!.signedUrl);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(CSV);
    // Re-using the token for another path must fail.
    const other = data!.signedUrl.replace(encodeURIComponent(A.id), encodeURIComponent(B.id)).replace(A.id, B.id);
    const bad = await fetch(other);
    expect(bad.ok).toBe(false);
  });
});
