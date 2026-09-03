import { createHash, timingSafeEqual } from "crypto";

/**
 * Compare a presented shared secret against the configured one.
 */
export function secretMatches(presented: string, configured: string | undefined | null): boolean {
  if (!configured) return false;
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}
