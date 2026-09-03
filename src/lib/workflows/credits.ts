import type { StepType } from "./types";

export interface CreditMeasurement {
  type: StepType | "ai" | "image" | "http_request" | "approval" | "log";
  outcome: "succeeded" | "failed" | "waiting";
  providerCredits?: number;
}

const STANDARD_BILLABLE = new Set<string>(["app_event_trigger", "app_action", "http_request"]);

export function creditCost(measurement: CreditMeasurement): number {
  if (measurement.outcome !== "succeeded") return 0;
  if (measurement.type === "ai" || measurement.type === "image" || measurement.type === "ai_step" || measurement.type === "generate_image") {
    return Math.max(1, Math.ceil(measurement.providerCredits ?? 1));
  }
  return STANDARD_BILLABLE.has(measurement.type) ? 1 : 0;
}
