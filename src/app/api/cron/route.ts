import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sweepDueSchedules } from "@/lib/workflows/schedule-runner";
import { cleanupExpiredRuns } from "@/lib/workflows/retention";

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase server key is not configured." }, { status: 503 });
  try { const [runs, removedRuns] = await Promise.all([sweepDueSchedules(admin), cleanupExpiredRuns(admin)]); return NextResponse.json({ runs, removedRuns }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Schedule sweep failed." }, { status: 500 }); }
}

export const GET = POST;
