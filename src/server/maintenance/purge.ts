import type { MonioClient } from "../supabase/server";

const BUCKET = "documents";

/** Lists every object path under a folder of the private documents bucket (recursive). */
async function listAll(admin: MonioClient, prefix: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Folders have no id/metadata in Storage listings.
      if (entry.id === null) out.push(...(await listAll(admin, path, depth + 1)));
      else out.push(path);
    }
    if (data.length < 1000) break;
  }
  return out;
}

/** Removes every stored document of one user (Storage API; SQL cannot delete objects). */
export async function purgeUserDocuments(admin: MonioClient, userId: string): Promise<number> {
  const paths = await listAll(admin, userId);
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
  return paths.length;
}

/**
 * Account erasure: stored originals first, then the auth user (which cascades to
 * every database row through foreign keys).
 */
export async function deleteUserCompletely(admin: MonioClient, userId: string): Promise<void> {
  await purgeUserDocuments(admin, userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw error;
}

/**
 * Sweeper for documents whose owner no longer exists (e.g. a user deleted directly
 * through the Auth admin API). Folder names are user ids.
 */
export async function purgeOrphanedDocuments(admin: MonioClient): Promise<{ folders: number; objects: number }> {
  const { data: top, error } = await admin.storage.from(BUCKET).list("", { limit: 1000 });
  if (error) throw error;
  let folders = 0;
  let objects = 0;
  for (const entry of top ?? []) {
    if (entry.id !== null || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const { data } = await admin.auth.admin.getUserById(entry.name);
    if (data?.user) continue;
    folders++;
    objects += await purgeUserDocuments(admin, entry.name);
  }
  return { folders, objects };
}
