/** Leaf paths offered by the webhook variable picker. Arrays stay whole in V1. */
export function payloadFields(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== "object") return prefix ? [prefix] : [];
  if (Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const nested = payloadFields(child, path, depth + 1);
      return nested.length ? nested : [path];
    }
    return [path];
  });
}

/** The token a caller can use now, which differs from the edited draft while live. */
export function webhookEndpointState({
  active,
  draftSecret,
  publishedSecret,
}: {
  active: boolean;
  draftSecret: string;
  publishedSecret: string;
}): { secret: string; pendingPublish: boolean } {
  if (!active) return { secret: draftSecret, pendingPublish: false };
  return {
    secret: publishedSecret,
    pendingPublish: draftSecret !== publishedSecret,
  };
}

export function webhookRotationNeedsConfirmation(active: boolean, publishedSecret: string): boolean {
  return active && publishedSecret.length > 0;
}

export function webhookSampleForSecret(
  sample: { secret?: string; fields?: string[]; receivedAt?: string } | null | undefined,
  displayedSecret: string,
): { fields: string[]; receivedAt: string } | null {
  if (!sample || !sample.fields || !sample.receivedAt) return null;
  if (sample.secret !== displayedSecret) return null;
  return {
    fields: sample.fields,
    receivedAt: sample.receivedAt,
  };
}
