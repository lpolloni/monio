import "server-only";
import { createAdminClient } from "../supabase/admin";
import type { Json } from "../supabase/database.types";
import type { MonioClient } from "../supabase/server";
import { LayoutRecipeSchema, type LayoutKind, type LayoutMemory, type LayoutRecipe } from "./parsers/layout-memory";

const MAX_RECIPES = 200;

/**
 * Layout memory of one user. Reads go through the caller's client (the
 * session's RLS, or the worker's service role filtered by user id). Writes
 * need worker privileges — a browser must not be able to plant a recipe — so
 * they use the admin client, only after the import pipeline has verified the
 * job, the document owner and the original's hash, and always scoped to that
 * user id.
 */
export function layoutMemoryStore(db: MonioClient, userId: string): LayoutMemory {
  const writer = () => createAdminClient();
  return {
    async load<K extends LayoutKind>(kind: K) {
      const { data, error } = await db
        .from("import_layouts")
        .select("signature, recipe")
        .eq("user_id", userId)
        .eq("kind", kind)
        .order("updated_at", { ascending: false })
        .limit(MAX_RECIPES);
      if (error) throw error;
      const recipes = new Map<string, Extract<LayoutRecipe, { kind: K }>>();
      for (const row of data ?? []) {
        // Stored recipes are data: anything that is not a well-formed recipe of this kind is ignored.
        const parsed = LayoutRecipeSchema.safeParse(row.recipe);
        if (parsed.success && parsed.data.kind === kind) recipes.set(row.signature, parsed.data as Extract<LayoutRecipe, { kind: K }>);
      }
      return recipes;
    },
    async save(signature, recipe) {
      const { error } = await writer()
        .from("import_layouts")
        .upsert(
          { user_id: userId, signature, kind: recipe.kind, recipe: recipe as unknown as Json, updated_at: new Date().toISOString() },
          { onConflict: "user_id,signature" },
        );
      if (error) throw error;
    },
    async forget(signature) {
      const { error } = await writer().from("import_layouts").delete().eq("user_id", userId).eq("signature", signature);
      if (error) throw error;
    },
  };
}
