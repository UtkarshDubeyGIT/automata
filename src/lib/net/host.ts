/**
 * Host comparison, for deciding whether a URL is "the workspace's own site".
 *
 * Deliberately dependency-free so the client can import it too — `public-url.ts`
 * next door pulls in `node:dns`/`node:net` because it is a security boundary,
 * and this is only string handling.
 */

/** Lowercased, `www.`-stripped hostname, or "" when the input is not a URL. */
export function siteHost(raw?: string | null): string {
  const t = (raw ?? "").trim();
  if (!t || t.length > 300) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // A bare word is a search term, not a site. This is also what keeps a
    // half-typed domain from reading as a host — see the Video Generator's
    // prompt signature, which re-suggests on every change of this value.
    return host.includes(".") ? host : "";
  } catch {
    return "";
  }
}

/**
 * Do two URLs denote the same site?
 *
 * Subdomain-tolerant in both directions: plenty of products live at `app.acme.com`
 * while the brand's recorded website is `acme.com`, and treating a customer's own
 * app as a stranger's would be exactly the wrong answer. Anchored on a dot, so
 * `evil-acme.com` does not pass as `acme.com`.
 *
 * An empty or unreadable side never matches — a workspace that has not recorded
 * a website of its own does not get to "own" whatever was handed to it.
 */
export function sameSite(a?: string | null, b?: string | null): boolean {
  const ha = siteHost(a);
  const hb = siteHost(b);
  if (!ha || !hb) return false;
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
}

/**
 * Second-level suffixes that are part of the address, not the name — so the
 * brand word in `acme.co.uk` is "acme" and not "co". Not a public suffix list:
 * this only has to be good enough to name a company, and a wrong answer here
 * costs a slightly-off name rather than a wrong site.
 */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/**
 * The brand word in a hostname: "atlassian" from `atlassian.com`, and also from
 * `app.atlassian.com` and `atlassian.co.uk`.
 *
 * Taking the FIRST label would answer "app" for every product that lives on a
 * subdomain, which is a name no one would recognise.
 */
export function brandWord(raw?: string | null): string {
  const labels = siteHost(raw).split(".").filter(Boolean);
  if (labels.length < 2) return "";
  labels.pop(); // the TLD
  if (labels.length > 1 && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 1])) labels.pop();
  return labels[labels.length - 1] ?? "";
}
