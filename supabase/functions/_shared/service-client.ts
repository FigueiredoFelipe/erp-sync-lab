import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// Service-role client for Edge Functions; the key is provided by the Supabase runtime.
export function serviceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}
