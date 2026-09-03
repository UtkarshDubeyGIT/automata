/**
 * Post-auth destinations arrive as a `?next=` query parameter, which anyone
 * can write. Only same-origin paths are honoured.
 */
export function safeNext(value: string | null | undefined, fallback = "/app"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  return value;
}
