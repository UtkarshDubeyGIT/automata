import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Server-side Supabase client bound to the request cookies.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    env.supabaseUrl || "http://localhost:54321",
    env.supabaseAnonKey || "public-anon-key",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot always write cookies.
          }
        },
      },
    },
  );
}

export const createServerSupabaseClient = createClient;

/**
 * Service-role client that BYPASSES RLS. Server-only.
 */
export function createAdminClient() {
  return createSbClient(
    env.supabaseUrl || "http://localhost:54321",
    env.supabaseServiceKey || env.supabaseAnonKey || "service-key",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
