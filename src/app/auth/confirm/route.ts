import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/lib/auth/redirects";
import { publicUrl } from "@/lib/request";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const OTP_TYPES = new Set<EmailOtpType>(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

/**
 * Email-link confirmation.
 *
 * Unlike /auth/callback (which exchanges a PKCE `code` and therefore only works
 * in the browser that started the flow), this verifies a `token_hash` and so
 * works when the link is opened anywhere — the phone mail app being the normal
 * case. Templates in supabase/templates/ point here.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const rawType = params.get("type");
  const dest = safeNext(params.get("next"));

  const type = rawType && OTP_TYPES.has(rawType as EmailOtpType) ? (rawType as EmailOtpType) : null;

  if (!tokenHash || !type) {
    return NextResponse.redirect(publicUrl("/login?notice=verify_failed", request));
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    return NextResponse.redirect(publicUrl("/login?notice=link_expired", request));
  }

  return NextResponse.redirect(publicUrl(dest, request));
}
