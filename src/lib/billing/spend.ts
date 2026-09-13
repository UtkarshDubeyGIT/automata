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
