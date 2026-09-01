import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const url = new URL("/app/integrations", request.url);
  const app = request.nextUrl.searchParams.get("app");
  if (app) url.searchParams.set("connected", app);
  return NextResponse.redirect(url);
}
