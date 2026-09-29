export interface SpendCategory {
  key: string;
  label: string;
  credits: number;
  count: number;
}

export interface SpendSummary {
  periodLabel: string;
  /** Gross credits charged; always equals the sum of `categories[].credits`. */
  total: number;
  refunded: number;
  categories: SpendCategory[];
}

export interface LedgerSpendRow {
  reason: string;
  delta: number;
  ref?: string | null;
  idem_key?: string | null;
}

export interface WorkflowSpend {
  workflowId: string;
  name: string;
  credits: number;
  charges: SpendCategory[];
}

export interface DetailedSpend extends SpendSummary {
  workflows: WorkflowSpend[];
  standalone: SpendCategory[];
}

const SPEND_CATEGORIES: { key: string; label: string; reasons: string[] }[] = [
  { key: "videos", label: "Videos", reasons: ["video_ugc", "video_shortform", "video_cinematic", "video_avatar", "video_demo"] },
  { key: "images", label: "Images", reasons: ["image_generation"] },
  { key: "workflows", label: "Workflow runs", reasons: ["workflow_run", "workflow_build"] },
];
const OTHER = { key: "other", label: "Other" };
const GRANT_REASONS = new Set(["plan_grant", "signup_bonus"]);

export function summarizeSpend(rows: { reason: string; delta: number }[], periodLabel: string): SpendSummary {
  const buckets = new Map<string, SpendCategory>();
  let refunded = 0;
  for (const row of rows) {
    if (GRANT_REASONS.has(row.reason)) continue;
    if (row.reason === "refund") {
      refunded += Math.max(0, row.delta);
      continue;
    }
    if (row.delta >= 0) continue;
    const category = SPEND_CATEGORIES.find((c) => c.reasons.includes(row.reason)) ?? OTHER;
    const bucket = buckets.get(category.key) ?? { key: category.key, label: category.label, credits: 0, count: 0 };
    bucket.credits += -row.delta;
    bucket.count += 1;
    buckets.set(category.key, bucket);
  }
  const categories = [...SPEND_CATEGORIES.map((c) => c.key), OTHER.key]
    .map((key) => buckets.get(key))
    .filter((c): c is SpendCategory => Boolean(c && c.credits > 0));
  const total = categories.reduce((sum, c) => sum + c.credits, 0);
  return { periodLabel, total, refunded, categories };
}

const REASON_LABELS: Record<string, string> = {
  workflow_run: "Runs",
  workflow_build: "Workflow creation",
  image_generation: "Images",
  video_ugc: "UGC videos",
  video_shortform: "Short videos",
  video_cinematic: "Cinematic videos",
  video_avatar: "Avatar videos",
  video_demo: "Demo videos",
};

/** Infer workflow ownership from durable ledger references, never from a display label. */
export function workflowIdForCharge(row: LedgerSpendRow, runWorkflowIds: ReadonlyMap<string, string>): string | null {
  if (row.reason === "workflow_run") return row.ref ?? runWorkflowIds.get(row.idem_key?.split(":")[1] ?? "") ?? null;
  const parts = row.idem_key?.split(":");
  if (parts?.[0] === "wf" && parts[1]) return runWorkflowIds.get(parts[1]) ?? null;
  return null;
}

export function runIdsForCharges(rows: LedgerSpendRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const parts = row.idem_key?.split(":");
    if (parts?.[0] === "wf" && parts[1]) ids.add(parts[1]);
    if (parts?.[0] === "workflow_run" && parts[1]) ids.add(parts[1]);
  }
  return [...ids];
}

export function summarizeDetailedSpend(
  rows: LedgerSpendRow[],
  periodLabel: string,
  workflowNames: ReadonlyMap<string, string>,
  runWorkflowIds: ReadonlyMap<string, string>,
): DetailedSpend {
  const summary = summarizeSpend(rows, periodLabel);
  const workflows = new Map<string, WorkflowSpend>();
  const standalone = new Map<string, SpendCategory>();
  for (const row of rows) {
    if (row.delta >= 0) continue;
    const workflowId = workflowIdForCharge(row, runWorkflowIds);
    const key = row.reason;
    const label = REASON_LABELS[key] ?? key.replaceAll("_", " ");
    const amount = -row.delta;
    if (workflowId) {
      let workflow = workflows.get(workflowId);
      if (!workflow) {
        workflow = { workflowId, name: workflowNames.get(workflowId) ?? "Deleted automation", credits: 0, charges: [] };
        workflows.set(workflowId, workflow);
      }
      workflow.credits += amount;
      let charge = workflow.charges.find((item) => item.key === key);
      if (!charge) {
        charge = { key, label, credits: 0, count: 0 };
        workflow.charges.push(charge);
      }
      charge.credits += amount;
      charge.count += 1;
    } else {
      const charge = standalone.get(key) ?? { key, label, credits: 0, count: 0 };
      charge.credits += amount;
      charge.count += 1;
      standalone.set(key, charge);
    }
  }
  return {
    ...summary,
    workflows: [...workflows.values()].sort((a, b) => b.credits - a.credits || a.name.localeCompare(b.name)),
    standalone: [...standalone.values()].sort((a, b) => b.credits - a.credits || a.label.localeCompare(b.label)),
  };
}
