import { assertPublicUrl } from "@/lib/net/public-url";

/** Fetch an external asset without allowing any redirect into a private network. */
export async function fetchPublicUrl(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = raw;
  let options = { ...init, headers: new Headers(init.headers) };
  // Browser interception may supply the original Host. Let fetch derive it
  // from each destination so a CDN redirect reaches the correct virtual host.
  options.headers.delete("host");
  for (let hop = 0; hop <= 10; hop++) {
    const allowed = await assertPublicUrl(url);
    if (!allowed) throw new Error("Only public HTTP(S) URLs can be fetched");
    const response = await fetch(allowed, { ...options, redirect: "manual" });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    await response.body?.cancel();
    const next = new URL(location, allowed).toString();
    if (new URL(next).origin !== new URL(allowed).origin) {
      options.headers.delete("authorization");
      options.headers.delete("proxy-authorization");
      options.headers.delete("cookie");
    }
    const method = (options.method ?? "GET").toUpperCase();
    if ((response.status === 303 && method !== "HEAD") || ([301, 302].includes(response.status) && method === "POST")) {
      options = { ...options, method: "GET", body: undefined };
      options.headers.delete("content-length");
      options.headers.delete("content-type");
    }
    url = next;
  }
  throw new Error("Too many redirects while fetching a public URL");
}
