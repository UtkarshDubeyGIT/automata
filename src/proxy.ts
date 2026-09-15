import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { getSupabasePublicConfig } from "@/lib/supabase/config";

const AUTH_ROUTES = new Set(["/login", "/signup", "/forgot-password"]);

export async function proxy(request: NextRequest) {
  const config = getSupabasePublicConfig();
  if (!config) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  // `/onboarding` sits outside `/app` so it can render full-bleed, free of the
  // product shell's padded wrapper and fixed control cluster. It still needs
  // the same signed-in guard, so it counts as a product route here.
  const isProductRoute =
    request.nextUrl.pathname.startsWith("/app") || request.nextUrl.pathname.startsWith("/onboarding");
  // /reset-password is deliberately absent: arriving there means holding a
  // recovery session, which counts as signed in, so bouncing it to /app would
  // make the reset link impossible to use.
  const isAuthRoute = AUTH_ROUTES.has(request.nextUrl.pathname);

  if (!signedIn && isProductRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  if (signedIn && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/onboarding", "/login", "/signup", "/forgot-password"],
};
