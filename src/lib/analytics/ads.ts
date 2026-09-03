export type AnalyticsPeriod = "7d" | "30d" | "90d" | "mtd" | "ytd";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function metaDateArgs(period: AnalyticsPeriod): Record<string, unknown> {
  const until = new Date();
  switch (period) {
    case "7d":
      return { date_preset: "last_7d" };
    case "30d":
      return { date_preset: "last_30d" };
    case "mtd":
      return { date_preset: "this_month" };
    case "90d":
      return {
        time_range: {
          since: ymd(new Date(until.getTime() - 90 * 86_400_000)),
          until: ymd(until),
        },
      };
    case "ytd":
      return {
        time_range: {
          since: ymd(new Date(Date.UTC(until.getUTCFullYear(), 0, 1))),
          until: ymd(until),
        },
      };
  }
}

export function metaObjectId(adAccountId?: string | null): string {
  const id = (adAccountId ?? "").trim();
  if (!id) return "";
  return id.startsWith("act_") ? id : `act_${id}`;
}
