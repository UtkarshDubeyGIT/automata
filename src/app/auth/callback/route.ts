import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/lib/auth/redirects";
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
    return NextResponse.redirect(new URL("/login?notice=link_expired", request.url));
  }

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(dest, request.url));
    console.error("[auth] code exchange failed", { code: error.code, status: error.status });
  }

  return NextResponse.redirect(new URL("/login?notice=verify_failed", request.url));
}
