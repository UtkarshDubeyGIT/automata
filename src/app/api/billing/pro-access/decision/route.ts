import { NextResponse, type NextRequest } from "next/server";
import { notifyProAccessDecision, reviewTokenHash, validReviewToken, type ProAccessRequest } from "@/lib/billing/pro-access";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { publicUrl } from "@/lib/request";

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  const decision = String(form?.get("decision") ?? "");
  const resultUrl = publicUrl("/pro-access/result", request);
  if (!validReviewToken(token) || !["approved", "declined"].includes(decision)) {
    resultUrl.searchParams.set("outcome", "invalid");
    return NextResponse.redirect(resultUrl, { status: 303 });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    resultUrl.searchParams.set("outcome", "unavailable");
    return NextResponse.redirect(resultUrl, { status: 303 });
  }
  const { data, error } = await admin.rpc("decide_pro_access", {
    p_token_hash: reviewTokenHash(token), p_decision: decision,
  });
  if (error) {
    console.error("[pro-access] decision failed", error);
    resultUrl.searchParams.set("outcome", "unavailable");
    return NextResponse.redirect(resultUrl, { status: 303 });
  }
  const outcome = String((data as { outcome?: string } | null)?.outcome ?? "invalid");
  const requestId = (data as { request_id?: string } | null)?.request_id;
  if (requestId && (outcome === "approved" || outcome === "declined")) {
    const { data: row } = await admin.from("pro_access_requests").select("*").eq("id", requestId).maybeSingle();
    if (row) await notifyProAccessDecision(row as ProAccessRequest);
  }
  resultUrl.searchParams.set("outcome", outcome);
  return NextResponse.redirect(resultUrl, { status: 303 });
}
