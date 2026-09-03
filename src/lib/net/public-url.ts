import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * Validate a user-supplied URL before the server fetches it or points a
 * browser at it.
 *
 * Several routes take a URL from the request body and then act on it with the
 * server's own network position: /api/brand/extract and /api/onboarding/analyze
 * launch Chromium at it, /api/video/generate records it. `normalizeUrl` only
 * ever checked that the hostname contained a dot, which "169.254.169.254" and
 * "db.internal.corp" both do — so anything that could reach those routes could
 * read the cloud metadata endpoint or sweep the private network, and have the
 * result uploaded into a public storage bucket.
 *
 * The hostname is not enough on its own: a public name can resolve to a
 * private address, deliberately (rebinding) or by accident (split-horizon
 * DNS). So the name is resolved and EVERY address it answers with has to be
 * public. Failing closed is the right default here — a site we cannot resolve
 * is one we cannot scan anyway.
 *
 * Note this also blocks localhost, so scanning a site served from the dev
 * machine is refused. That is the intended trade: the guard cannot tell a
 * developer's own server from the metadata endpoint.
 */

/** Hostnames that never denote a public site, regardless of what DNS says. */
const BLOCKED_HOST = /(^|\.)(localhost|local|internal|intranet|localdomain)$/i;

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  // Anything that is not four clean octets is refused rather than guessed at.
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local — the cloud metadata range
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  // Strip any zone index ("fe80::1%eth0") before matching.
  const s = ip.toLowerCase().split("%")[0];
  // Every "::"-prefixed address is a special or deprecated range: loopback
  // (::1), unspecified (::), IPv4-compatible (::a.b.c.d) and IPv4-mapped
  // (::ffff:...). Refusing the whole prefix is safer than matching each form,
  // because the URL parser rewrites some of them before we ever see them —
  // "::ffff:127.0.0.1" arrives canonicalized as "::ffff:7f00:1", which a
  // dotted-quad pattern misses. Globally routable IPv6 is 2000::/3, so nothing
  // legitimate starts this way.
  if (s.startsWith("::")) return true;
  if (/^f[cd]/.test(s)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // not an address we can reason about
}

/**
 * Returns the canonical URL when it is safe to fetch, or null when it is not.
 * Callers should treat null as "refuse this request", not "try anyway".
 */
export async function assertPublicUrl(raw?: string | null): Promise<string | null> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const withProto = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withProto);
  } catch {
    return null;
  }

  // http(s) only. file:, gopher: and friends are how a fetch turns into a
  // local file read or a protocol-smuggling primitive.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Credentials in the URL are never needed here and confuse the origin.
  if (u.username || u.password) return null;

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_HOST.test(host)) return null;

  // A literal address skips DNS but still has to be public.
  if (net.isIP(host)) return isPrivateAddress(host) ? null : u.toString();

  // A name has to look like a name, then resolve entirely to public space.
  if (!host.includes(".")) return null;
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return null;
    if (addrs.some((a) => isPrivateAddress(a.address))) return null;
  } catch {
    return null; // unresolvable — nothing to scan
  }

  return u.toString();
}
