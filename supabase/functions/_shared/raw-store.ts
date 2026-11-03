import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

// Writes one raw ERPNext document to the private `raw` bucket (overwrite: the path is per version).
export function rawPutter(client: SupabaseClient): (path: string, json: string) => Promise<void> {
  return async (path, json) => {
    const { error } = await client.storage
      .from("raw")
      .upload(path, new Blob([json], { type: "application/json" }), { upsert: true, contentType: "application/json" });
    if (error) throw new Error(`raw upload ${path} failed: ${error.message}`);
  };
}
