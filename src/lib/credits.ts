import { createAdminClient } from "@/lib/supabase/server";

export const CREDIT_COST = {
  content_variation: 1,
  image_generation: 5,
  video_ugc: 40,
  video_shortform: 25,
  video_cinematic: 60,
  video_avatar: 35,
  video_demo: 30,
  viral_angle: 3,
  viral_query: 2,
  analytics_query: 1,
  trend_refresh: 5,
  brand_research: 10,
  workflow_run: 2,
  workflow_build: 3,
  goal_plan: 5,
} as const;

export type BillableReason = keyof typeof CREDIT_COST;
export type CreditReason = BillableReason | "plan_grant" | "signup_bonus" | "refund" | "video_row_insert_failed";

export const PRICE_LABEL: Record<BillableReason, string> = {
  content_variation: "Per content variation",
  image_generation: "Per generated image",
  video_ugc: "UGC video (30s)",
  video_shortform: "Short-form video (30s)",
  video_cinematic: "Cinematic video (30s)",
  video_avatar: "Avatar video (30s)",
  video_demo: "Product demo video",
  viral_angle: "Viral angle breakdown",
  viral_query: "Viral intelligence question",
  analytics_query: "Analytics question",
  trend_refresh: "Trend refresh",
  brand_research: "Brand research",
  workflow_run: "Workflow run",
  workflow_build: "Workflow build",
  goal_plan: "Goal plan",
};

export function priceBook(): { reason: BillableReason; label: string; credits: number }[] {
  return (Object.keys(CREDIT_COST) as BillableReason[]).map((reason) => ({
    reason,
    label: PRICE_LABEL[reason],
    credits: CREDIT_COST[reason],
  }));
}

export function quote(reason: BillableReason, quantity = 1): number {
  return CREDIT_COST[reason] * Math.max(1, Math.round(quantity));
}

export async function getBalance(workspaceId: string): Promise<number> {
  const db = createAdminClient();
  if (!db) return 0;
  const { data, error } = await db
    .from("credit_ledger")
    .select("delta")
    .eq("workspace_id", workspaceId);
  if (error || !data) return 0;
  return data.reduce((sum: number, r: { delta: number }) => sum + r.delta, 0);
}

export type SpendOutcome = "charged" | "duplicate" | "insufficient" | "error";

export interface SpendResult {
  ok: boolean;
  outcome: SpendOutcome;
  balance: number;
  cost: number;
}

export async function spendCredits(
  workspaceId: string,
  amount: number,
  reason: CreditReason,
  ref?: string,
  idemKey?: string,
): Promise<SpendResult> {
  const cost = Math.abs(Math.round(amount));
  const db = createAdminClient();
  if (!db) {
    return { ok: true, outcome: "charged", balance: 1000, cost };
  }

  if (cost === 0) {
    return { ok: true, outcome: "charged", balance: await getBalance(workspaceId), cost };
  }

  const { data: row, error } = await db
    .from("credit_ledger")
    .insert({
      workspace_id: workspaceId,
      delta: -cost,
      reason,
      ref: ref ?? null,
      ...(idemKey ? { idem_key: idemKey } : {}),
    })
    .select("id")
    .single();

  if (error || !row) {
    if (idemKey && isDuplicateKey(error)) {
      return { ok: true, outcome: "duplicate", balance: await getBalance(workspaceId), cost };
    }
    return { ok: false, outcome: "error", balance: await getBalance(workspaceId), cost };
  }

  const balance = await getBalance(workspaceId);
  if (balance < 0) {
    await db.from("credit_ledger").insert({
      workspace_id: workspaceId,
      delta: cost,
      reason: "refund",
      ref: `reversal:${(row as { id: number }).id}`,
      ...(idemKey ? { idem_key: `reversal:${idemKey}` } : {}),
    });
    return { ok: false, outcome: "insufficient", balance: balance + cost, cost };
  }

  return { ok: true, outcome: "charged", balance, cost };
}

export async function grantCredits(
  workspaceId: string,
  amount: number,
  reason: CreditReason,
  ref?: string,
  idemKey?: string,
): Promise<void> {
  const db = createAdminClient();
  if (!db) return;
  const { error } = await db.from("credit_ledger").insert({
    workspace_id: workspaceId,
    delta: Math.abs(amount),
    reason,
    ref: ref ?? null,
    ...(idemKey ? { idem_key: idemKey } : {}),
  });
  if (error && !isDuplicateKey(error)) {
    throw new Error(`Could not record ${reason} of ${Math.abs(amount)} credits: ${error.message}`);
  }
}

export function isDuplicateKey(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || /duplicate key value/i.test(error.message ?? "");
}
