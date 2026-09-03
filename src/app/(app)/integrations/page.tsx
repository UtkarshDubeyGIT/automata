"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import {
  PLATFORMS,
  CATALOG_CATEGORIES,
  toolkitLogo,
  platformMeta,
} from "@/lib/social/platforms";
// Types only — erased before the bundler sees them, so this costs nothing.
import type { ConnectMethod, ToolkitSummary } from "@/lib/social/composio";
import { cn } from "@/lib/utils";

type Status = "connected" | "pending";

const CHANNELS = PLATFORMS.filter((p) => p.kind === "channel");

interface ConnectResponse {
  redirectUrl?: string;
  connected: boolean;
  simulated?: boolean;
  needsCredentials?: boolean;
  /** The app would also take a key the user pastes — offer it, don't take it. */
  keyFallback?: boolean;
  error?: string;
}

interface CatalogResponse {
  items: ToolkitSummary[];
  nextCursor: string | null;
  total: number;
}

/** Toolkit logo with a lettermark fallback for apps without one. */
function Logo({ slug, name, size = 44 }: { slug: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span
        className="flex flex-none items-center justify-center rounded-[12px] bg-inset text-[16px] font-semibold text-ink-muted"
        style={{ width: size, height: size }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={toolkitLogo(slug)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      className="flex-none rounded-[12px] border border-line bg-card object-contain p-1.5"
    />
  );
}

export default function IntegrationsPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [pending, setPending] = useState<string | null>(null);
  /** Curated channels we hold a developer app for — those are one tap too. */
  const [ownApps, setOwnApps] = useState<string[]>([]);
  /**
   * Apps the server told us would accept a pasted key after all.
   *
   * Only ever set from a refusal we actually received, so the second press is
   * the user's choice: the button relabels itself to say what it will ask for.
   */
  const [keyOffer, setKeyOffer] = useState<Record<string, boolean>>({});

  // Catalog browser state.
  const [category, setCategory] = useState("all");
  // Seed from ?q= so an Analytics "Connect …" deep link prefills the search.
  const [search, setSearch] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("q") ?? ""),
  );
  const [items, setItems] = useState<ToolkitSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [browsing, setBrowsing] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id per catalog request — a stale response must never clobber a
  // newer one (out-of-order fetches, debounce racing a category click).
  const reqSeq = useRef(0);

  function refreshStatus() {
    return fetch("/api/integrations/connect")
      .then((r) => r.json())
      .then(
        (data: {
          integrations?: { platform: string; status: Status }[];
          ownApps?: string[];
        }) => {
          const next: Record<string, Status> = {};
          for (const row of data.integrations ?? []) next[row.platform] = row.status;
          setStatus(next);
          setOwnApps(data.ownApps ?? []);
        },
      )
      .catch(() => {});
  }

  /**
   * Fetch a page of the catalog and apply it, unless a newer request started
   * meanwhile. Deliberately does NOT raise the spinner: that is a synchronous
   * state write, and the mount effect below has no need of one — `browsing`
   * already starts `true`. Calling it from the effect anyway is what
   * `react-hooks/set-state-in-effect` objects to, and it was objecting to a
   * write that changed nothing.
   */
  function fetchCatalog(opts: { category: string; search: string; cursor?: string }) {
    const seq = ++reqSeq.current;
    const qs = new URLSearchParams();
    if (opts.category !== "all") qs.set("category", opts.category);
    if (opts.search) qs.set("search", opts.search);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return fetch(`/api/integrations/catalog?${qs}`)
      .then((r) => r.json())
      .then((data: CatalogResponse) => {
        if (seq !== reqSeq.current) return; // a newer request superseded this one
        setItems((prev) => (opts.cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
        setTotal(data.total);
      })
      .catch(() => {})
      .finally(() => {
        if (seq === reqSeq.current) setBrowsing(false);
      });
  }

  /** What a search or a category tap calls: show the spinner, then fetch. */
  function browseCatalog(opts: { category: string; search: string; cursor?: string }) {
    setBrowsing(true);
    return fetchCatalog(opts);
  }

  /**
   * A toolkit's display name. Declared ABOVE the mount effect that uses it:
   * a function declaration hoists, so this ran, but the effect then closed
   * over the render-zero `items` — which is empty, so the catalog branch was
   * dead on the one path that called it. Ordering it properly is what
   * `react-hooks/immutability` was asking for, and it makes that readable.
   */
  function prettyName(slug: string): string {
    return (
      platformMeta(slug)?.name ??
      items.find((t) => t.slug === slug)?.name ??
      slug.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  // Initial load; surface the OAuth outcome when returning from Composio.
  useEffect(() => {
    refreshStatus();
    fetchCatalog({ category: "all", search });

    const params = new URLSearchParams(window.location.search);
    const connectedTo = params.get("connected");
    const failed = params.get("error");
    if (connectedTo || failed) {
      window.history.replaceState({}, "", "/integrations");
      if (connectedTo) {
        toast({ title: `${prettyName(connectedTo)} connected` });
      } else {
        toast({
          title: `Couldn't connect ${prettyName(failed!)}`,
          description: "Authorization was cancelled or failed. Try again.",
          tone: "danger",
        });
      }
    }
    return () => {
      // Cancel the pending debounce and invalidate in-flight fetches.
      if (searchTimer.current) clearTimeout(searchTimer.current);
      // `exhaustive-deps` warns that `reqSeq.current` will have changed by the
      // time cleanup runs. It will, and that is exactly what is wanted: the
      // increment has to move whatever the live counter reached, so a response
      // still in the air is discarded. The rule's suggested fix — copy it to a
      // local inside the effect — would capture the mount-time zero and
      // invalidate nothing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      reqSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search + category changes re-query the catalog.
  function onSearch(value: string) {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => browseCatalog({ category, search: value }), 300);
  }

  function onCategory(id: string) {
    // A queued search callback captured the OLD category — cancel it.
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setCategory(id);
    browseCatalog({ category: id, search });
  }

  async function connect(slug: string, name: string, method: ConnectMethod) {
    setPending(slug);
    try {
      const res = await fetch("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "key" says the user pressed a button that told them they'd be asked
        // for one. The server still prefers a proper login where it can reach
        // one, so this widens what's acceptable rather than forcing a form.
        body: JSON.stringify({ platform: slug, mode: method === "key" ? "key" : undefined }),
      });
      const data = (await res.json()) as ConnectResponse;
      if (data.needsCredentials) {
        // The catalog said this one needs a developer app, and it does — but if
        // it would also take a key, say so and relabel the button. Connecting
        // them to a key form they never chose is the downgrade we don't do.
        if (data.keyFallback) {
          setKeyOffer((k) => ({ ...k, [slug]: true }));
          toast({
            title: `${name} has no one-tap login`,
            description: "You can connect it with your own API key instead — press Add key.",
            tone: "warning",
          });
          return;
        }
        toast({
          // The server knows which toolkit it is and exactly which env vars
          // are missing — a generic "add your keys" hides all of that.
          title: `${name} needs its own OAuth app`,
          description: data.error ?? "Add your developer-app credentials, then retry.",
          tone: "warning",
        });
        return;
      }
      if (data.error && !data.redirectUrl) {
        toast({ title: "Connection failed", description: data.error, tone: "danger" });
        return;
      }
      if (data.redirectUrl) {
        // Off to the provider's OAuth screen; we return via the callback.
        //
        // `assign()` rather than `location.href = …`: identical navigation and
        // an identical history entry, but a method call instead of writing to
        // a global, which is what `react-hooks/immutability` refuses. Nothing
        // after this line runs — the document is being replaced.
        window.location.assign(data.redirectUrl);
        return;
      }
      if (data.connected) {
        setStatus((s) => ({ ...s, [slug]: "connected" }));
        toast({
          title: `${name} connected`,
          description: data.simulated ? "Simulated — add COMPOSIO_API_KEY to go live." : undefined,
        });
      }
    } catch {
      toast({ title: "Connection failed", description: "Please try again.", tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  async function disconnect(slug: string, name: string) {
    setPending(slug);
    try {
      await fetch("/api/integrations/connect", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: slug }),
      });
      setStatus((s) => {
        const next = { ...s };
        delete next[slug];
        return next;
      });
      toast({ title: `${name} disconnected` });
    } catch {
      toast({ title: "Couldn't disconnect", description: "Please try again.", tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  const connectedChannels = CHANNELS.filter((c) => status[c.id] === "connected").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        subtitle="Connect your channels and tools."
      />

      <div className="flex items-center gap-2 rounded-control border border-brand-border bg-brand-subtle px-4 py-3 text-[13px] text-brand">
        <Icon name="zap" size={16} />
        <span>
          Connected channels power the Scheduler and let the Agent publish on your behalf.
          <span className="ml-1 font-semibold">{connectedChannels} of {CHANNELS.length} channels live.</span>
        </span>
      </div>

      {/* Curated social channels */}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Social channels</h2>
          <p className="mt-0.5 text-[13px] text-ink-subtle">Where the Agent and Scheduler post.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {CHANNELS.map((ch) => {
            const state = status[ch.id];
            const method = channelMethod(ch.id, ch.managedAuth, ownApps, keyOffer);
            return (
              <Card key={ch.id} className="flex items-center gap-4 p-4" hover>
                <Logo slug={ch.id} name={ch.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-ink">{ch.name}</div>
                  <div className="truncate text-[13px] text-ink-subtle">{ch.description}</div>
                </div>
                <CardActions
                  state={state}
                  pending={pending === ch.id}
                  method={method}
                  onConnect={() => connect(ch.id, ch.name, method)}
                  onDisconnect={() => disconnect(ch.id, ch.name)}
                />
              </Card>
            );
          })}
        </div>
      </section>

      {/* Full Composio catalog */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">All integrations</h2>
            <p className="mt-0.5 text-[13px] text-ink-subtle">
              {total > 0 ? `${total.toLocaleString()} apps` : "Every app"} available through Composio — most popular first.
            </p>
          </div>
          <div className="w-full sm:w-72">
            <Input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search apps…"
            />
          </div>
        </div>

        {/* Category chips */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {CATALOG_CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => onCategory(c.id)}
              className={cn(
                "flex-none rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
                category === c.id
                  ? "border-brand-border bg-brand-subtle text-brand"
                  : "border-line bg-card text-ink-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>

        {items.length === 0 && !browsing ? (
          <Card className="p-8 text-center text-[13px] text-ink-subtle">
            No apps match — try a different search or category.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((t) => {
              const state = status[t.slug];
              const method = keyOffer[t.slug] ? "key" : t.connectVia;
              return (
                <Card key={t.slug} className="flex items-center gap-4 p-4" hover>
                  <Logo slug={t.slug} name={t.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-ink">{t.name}</span>
                      <span className="flex-none font-mono text-[11px] text-ink-muted">
                        {t.toolsCount} tools
                      </span>
                    </div>
                    <div className="truncate text-[13px] text-ink-subtle">
                      {t.description || t.categories.join(", ")}
                    </div>
                  </div>
                  {t.noAuth ? (
                    <Badge>No auth needed</Badge>
                  ) : (
                    <CardActions
                      state={state}
                      pending={pending === t.slug}
                      method={method}
                      onConnect={() => connect(t.slug, t.name, method)}
                      onDisconnect={() => disconnect(t.slug, t.name)}
                    />
                  )}
                </Card>
              );
            })}
          </div>
        )}

        <div className="flex justify-center py-2">
          {browsing ? (
            <span className="text-[13px] text-ink-subtle">Loading apps…</span>
          ) : nextCursor ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => browseCatalog({ category, search, cursor: nextCursor })}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * What a channel card's button should say.
 *
 * Channels are static client data with no live auth schema, so the answer is
 * "one tap if anyone hosts the app" — Composio (`managedAuth`) or us
 * (`ownApps`) — and otherwise a developer app is missing. A channel that turns
 * out to accept a key says so after the first press, via `keyOffer`.
 */
function channelMethod(
  id: string,
  managedAuth: boolean,
  ownApps: string[],
  keyOffer: Record<string, boolean>,
): ConnectMethod {
  if (managedAuth || ownApps.includes(id)) return "managed";
  return keyOffer[id] ? "key" : "own_app";
}

/** What each connect method promises the user. */
const CONNECT_LABEL: Record<ConnectMethod, string> = {
  managed: "Connect",
  // Not "Set up": this one is finishable right now, in about a minute.
  key: "Add key",
  // Honest about the wait — nothing the user types will unblock this one.
  own_app: "Set up",
};

function CardActions({
  state,
  pending,
  method,
  onConnect,
  onDisconnect,
}: {
  state: Status | undefined;
  pending: boolean;
  method: ConnectMethod;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (state === "connected") {
    return (
      <div className="flex flex-none items-center gap-2">
        <Badge tone="success" dot>Connected</Badge>
        <Button variant="ghost" size="sm" loading={pending} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    );
  }
  if (state === "pending") {
    return (
      <div className="flex flex-none items-center gap-2">
        <Badge tone="warning" dot>Pending</Badge>
        <Button variant="primary" size="sm" loading={pending} onClick={onConnect}>
          Finish
        </Button>
      </div>
    );
  }
  return (
    <Button variant="primary" size="sm" loading={pending} onClick={onConnect} className="flex-none">
      {CONNECT_LABEL[method]}
    </Button>
  );
}
