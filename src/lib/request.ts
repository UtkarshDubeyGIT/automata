/**
 * The trust boundary: reading a request body, and deciding what origin the
 * browser gets sent back to, without letting either decide the response code.
 */

import { env } from "@/lib/env";

/**
 * The origin to build browser-facing absolute URLs against.
 *
 * Behind the Caddy proxy, Next reports `request.url` as the container's own
 * address — `https://localhost:3000` — so `new URL(path, request.url)` sends
 * the browser to a host that only exists inside Docker. Every redirect and
 * OAuth callback therefore hangs off the configured public URL, and falls back
 * to the request only when nothing is configured (tests, one-off scripts).
 *
 * Deliberately not read from the Host or X-Forwarded-Host header: those are
 * attacker-controlled, and a host-header injection here would rewrite where an
 * auth code or an OAuth callback lands.
 */
export function publicOrigin(request?: Request): string | undefined {
  const configured = env.appUrl.trim();
  if (configured) {
    // APP_HOST is a bare hostname in deployment; NEXT_PUBLIC_APP_URL carries a scheme.
    const withScheme = /^https?:\/\//.test(configured) ? configured : `https://${configured}`;
    try {
      return new URL(withScheme).origin;
    } catch {
      // Fall through to the request rather than booting with a broken base.
    }
  }
  return request?.url;
}

/** `new URL(path, ...)` against the public origin. */
export function publicUrl(path: string, request?: Request): URL {
  return new URL(path, publicOrigin(request));
}

export async function jsonBody<T extends object>(req: Request): Promise<T | null> {
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : "";
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;
}

export function count(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

export function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
