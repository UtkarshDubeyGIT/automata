import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/lib/auth/redirects";
import { syncGoogleProfile } from "@/lib/auth/profile-sync";
import { publicUrl } from "@/lib/request";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const dest = safeNext(params.get("next"));

  // Providers report failures on the redirect itself; surface those rather
  // than pretending the code was simply unverifiable.
  const providerError = params.get("error_description") ?? params.get("error");
  if (providerError) {
    console.error("[auth] callback returned an error", { providerError });
    return NextResponse.redirect(publicUrl("/login?notice=link_expired", request));
  }

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Best-effort: a sync failure must never block sign-in.
      if (data.user) {
        try {
          await syncGoogleProfile(supabase, data.user);
        } catch (syncError) {
          console.error("[auth] profile sync failed", syncError);
        }
      }
      return NextResponse.redirect(publicUrl(dest, request));
    }
    console.error("[auth] code exchange failed", { code: error.code, status: error.status });
  }

  return NextResponse.redirect(publicUrl("/login?notice=verify_failed", request));
}
