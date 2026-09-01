import type { StepType } from "./types";

export interface CreditMeasurement {
  type: StepType;
  outcome: "succeeded" | "failed" | "waiting";
  providerCredits?: number;
}

const STANDARD_BILLABLE = new Set<StepType>(["app_event_trigger", "app_action", "http_request"]);

export function creditCost(measurement: CreditMeasurement): number {
  if (measurement.outcome !== "succeeded") return 0;
  if (measurement.type === "ai" || measurement.type === "image") {
    return Math.max(1, Math.ceil(measurement.providerCredits ?? 1));
  }
  return STANDARD_BILLABLE.has(measurement.type) ? 1 : 0;
}
