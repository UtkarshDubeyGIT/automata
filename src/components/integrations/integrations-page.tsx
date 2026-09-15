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
import { setupNotice } from "@/lib/setup-notice";
import { VikunjaConnectDialog } from "@/components/integrations/vikunja-connect-dialog";

type Status = "connected" | "pending" | "disconnected";

const CHANNELS = PLATFORMS.filter((p) => p.kind === "channel");

/**
 * Apps that can never come back from the Composio catalog, because Composio
 * does not have them.
 *
 * Google Business Profile is the whole list. It had no card ANYWHERE on this
 * screen: it is not a curated channel, and the catalog grid is fed by
 * Composio, which returns 404 for every spelling of its slug. So the one
 * integration whose OAuth client we own was also the one integration nobody
 * could find a Connect button for — reachable only from inside a workflow that
 * happened to require it.
 *
 * Described here in the same shape a real toolkit arrives in, so the card
 * renders through exactly the same path as every other one.
 */
const NATIVE_TOOLKITS: Record<string, ToolkitSummary> = {
  vikunja: {
    slug: "vikunja",
    name: "Vikunja",
    description: "Create and track tasks from meeting action items",
    categories: ["project-management", "productivity"],
    managed: false,
    noAuth: false,
    toolsCount: 4,
    connectVia: "key",
  },
  googlebusinessprofile: {
    slug: "googlebusinessprofile",
    name: "Google Business Profile",
    description: "Read and reply to your Google reviews",
    categories: ["marketing"],
    managed: true,
    noAuth: false,
    // Reading reviews and posting an owner reply — the two the engine exposes.
    toolsCount: 2,
    connectVia: "managed",
  },
};

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
function Logo({ slug, name, size = 44, instanceUrl }: { slug: string; name: string; size?: number; instanceUrl?: string }) {
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
      src={toolkitLogo(slug, instanceUrl)}
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
  /** Native apps the server offered this workspace — see NATIVE_TOOLKITS. */
  const [nativeSlugs, setNativeSlugs] = useState<string[]>(["vikunja"]);
  const [vikunjaOpen, setVikunjaOpen] = useState(false);
  const [vikunjaInstanceUrl, setVikunjaInstanceUrl] = useState("");
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
  // Cards for this workspace's own apps, fetched by slug rather than waited
  // for in the popularity pages — see `pinConnected`.
  const [pinned, setPinned] = useState<ToolkitSummary[]>([]);
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
          integrations?: { platform: string; status: string; instanceUrl?: string }[];
          ownApps?: string[];
        }) => {
          const rows = data.integrations ?? [];
          const next: Record<string, Status> = {};
          for (const row of rows) {
            // A row may now say "none". Composio never sends that — its
            // listing simply omits what is not connected — but Google Business
            // Profile has no Composio toolkit, so ABSENCE already means
            // something for it ("this deployment has no Google client, run it
            // in demo mode"). It therefore states "not connected yet"
            // explicitly, and only the three real states belong in this map.
            if (row.status === "connected" || row.status === "pending" || row.status === "disconnected") {
              next[row.platform] = row.status;
            }
          }
          setStatus(next);
          setVikunjaInstanceUrl(rows.find((row) => row.platform === "vikunja")?.instanceUrl ?? "");
          setOwnApps(data.ownApps ?? []);
          // A card for every app the server is willing to connect — which for
          // the native ones is the only signal there is, since they can never
          // appear in a Composio catalog page.
          setNativeSlugs(Array.from(new Set([
            "vikunja",
            ...rows.map((r) => r.platform).filter((p) => p in NATIVE_TOOLKITS),
          ])));
          pinConnected(Object.keys(next));
        },
      )
      .catch(() => {});
  }

  /**
   * Fetch a card for every app this workspace already has a connection to.
   *
   * `catalogRank` can only promote what has been fetched, and the catalog
   * arrives 24 at a time in Composio's popularity order — so an app ranked
   * below the first page had no card to promote. A live Shopify connection
   * showed nothing here until the user searched "shopify" by name, which is
   * precisely the question this page is supposed to answer for them.
   *
   * Asking by slug is what makes it independent of rank. Failures are silent:
   * the pins are an addition to the grid, never a precondition for it.
   */
  function pinConnected(slugs: string[]) {
    if (slugs.length === 0) return;
    fetch(`/api/integrations/catalog?slugs=${encodeURIComponent(slugs.join(","))}`)
      .then((r) => r.json())
      .then((data: CatalogResponse) => setPinned(data.items ?? []))
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
    // Authorization worked and the account still cannot do the job — see the
    // Business Profile callback. Not an error: the grant is real, so a red
    // toast would send the user to reconnect the very same account.
    const warning = params.get("warning");
    if (connectedTo || failed) {
      window.history.replaceState({}, "", "/app/integrations");
      if (connectedTo && warning) {
        toast({
          title: `${prettyName(connectedTo)} connected, but not usable yet`,
          description: warning,
          tone: "warning",
        });
      } else if (connectedTo) {
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

  /** A catalog card's tier — connected first, then by what connecting takes. */
  function catalogRank(t: ToolkitSummary): number {
    return cardRank(status[t.slug], keyOffer[t.slug] ? "key" : t.connectVia, t.noAuth);
  }

  // The workspace's own apps lead the default view. A search or a category is
  // a narrowing the user asked for, and pinning through it would answer a
  // question they didn't ask — so the pins only apply to the unfiltered grid.
  const merged = !search.trim() && category === "all" ? [...pinned, ...items] : items;

  /*
   * Native cards join the same grid rather than getting a section of their
   * own: to the user this is just another app to connect, and the fact that we
   * run its OAuth ourselves is our problem, not theirs.
   *
   * They obey search and category like everything else. Matching is done here
   * because the catalog query goes to Composio, which has never heard of them
   * — leaving it to the server would silently drop them from every filtered
   * view.
   */
  const query = search.trim().toLowerCase();
  const nativeCards = nativeSlugs
    .map((slug) => NATIVE_TOOLKITS[slug])
    .filter((t): t is ToolkitSummary => !!t)
    .filter(
      (t) =>
        (category === "all" || t.categories.includes(category)) &&
        (!query ||
          t.name.toLowerCase().includes(query) ||
          t.slug.includes(query) ||
          t.description.toLowerCase().includes(query)),
    );

  // Web research runs on the app's own Firecrawl key, so there is nothing for
  // a workspace to connect. Offering the Composio toolkit here would invite a
  // second key that no part of the product reads.
  //
  // Built into a fresh array, so sorting it cannot touch the `items` state
  // behind it — the loaded pages stay in the order they arrived, which is what
  // "Load more" appends to. A pinned app that also turns up in a page is kept
  // once, at its pinned position.
  const seen = new Set<string>();
  const catalogItems: ToolkitSummary[] = [];
  for (const toolkit of [...nativeCards, ...merged]) {
    if (toolkit.slug === "firecrawl" || seen.has(toolkit.slug)) continue;
    seen.add(toolkit.slug);
    catalogItems.push(toolkit);
  }
  catalogItems.sort((a, b) => catalogRank(a) - catalogRank(b));

  /** Same ordering for the curated channels. CHANNELS is module-level: copy. */
  const channelCards = [...CHANNELS].sort(
    (a, b) =>
      cardRank(status[a.id], channelMethod(a.id, a.managedAuth, ownApps, keyOffer), false) -
      cardRank(status[b.id], channelMethod(b.id, b.managedAuth, ownApps, keyOffer), false),
  );

  /**
   * Split into "already yours" (connected, mid-connect, or built directly
   * into Automata) vs. "still to discover" — the page leads with the former
   * so a returning user sees what's live before the ~1,400-app catalog.
   */
  // "disconnected" counts as live too: a broken app belongs where the user
  // will see it, not lost in the ~1,400-app catalog below.
  const isLive = (state: Status | undefined) =>
    state === "connected" || state === "pending" || state === "disconnected";
  const connectedChannelCards = channelCards.filter((c) => isLive(status[c.id]));
  const discoverChannelCards = channelCards.filter(
    (c) =>
      !isLive(status[c.id]) &&
      category === "all" &&
      (!query ||
        c.name.toLowerCase().includes(query) ||
        c.id.includes(query) ||
        c.description.toLowerCase().includes(query)),
  );
  const topCatalogItems = catalogItems.filter(
    (t) => t.slug in NATIVE_TOOLKITS || isLive(status[t.slug]),
  );
  const discoverCatalogItems = catalogItems.filter(
    (t) => !(t.slug in NATIVE_TOOLKITS) && !isLive(status[t.slug]),
  );

  async function connect(slug: string, name: string, method: ConnectMethod) {
    if (slug === "vikunja") {
      setVikunjaOpen(true);
      return;
    }
    setPending(slug);
    try {
      const res = await fetch("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "key" says the user pressed a button that told them they'd be asked
        // for one. The server still prefers a proper login where it can reach
        // one, so this widens what's acceptable rather than forcing a form.
        body: JSON.stringify({ platform: slug, returnTo: "/app/integrations", mode: method === "key" ? "key" : undefined }),
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
            description: "You can still connect it with your own API key. Press Add API key to open the secure key form.",
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
          description: data.simulated
            ? setupNotice(
                "Connected in preview mode — live posting isn’t enabled yet.",
                "Simulated — add COMPOSIO_API_KEY to go live.",
              )
            : undefined,
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
      await fetch(slug === "vikunja" ? "/api/integrations/vikunja" : "/api/integrations/connect", {
        method: "DELETE",
        ...(slug === "vikunja" ? {} : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: slug }),
        }),
      });
      setStatus((s) => {
        const next = { ...s };
        delete next[slug];
        return next;
      });
      if (slug === "vikunja") setVikunjaInstanceUrl("");
      toast({ title: `${name} disconnected` });
    } catch {
      toast({ title: "Couldn't disconnect", description: "Please try again.", tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  const connectedChannels = CHANNELS.filter((c) => status[c.id] === "connected").length;

  function ChannelCard(ch: (typeof CHANNELS)[number]) {
    const state = status[ch.id];
    const method = channelMethod(ch.id, ch.managedAuth, ownApps, keyOffer);
    return (
      <Card key={`channel-${ch.id}`} className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-4 p-4 sm:flex" hover>
        <Logo slug={ch.id} name={ch.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink" title={ch.name}>
            {ch.name}
          </div>
          <div className="truncate text-[13px] text-ink-subtle" title={ch.description}>
            {ch.description}
          </div>
        </div>
        <div className="col-span-2 justify-self-end sm:contents">
          <CardActions
            state={state}
            name={ch.name}
            pending={pending === ch.id}
            method={method}
            onConnect={() => connect(ch.id, ch.name, method)}
            onDisconnect={() => disconnect(ch.id, ch.name)}
          />
        </div>
      </Card>
    );
  }

  function CatalogCard(t: ToolkitSummary) {
    const state = status[t.slug];
    const method = keyOffer[t.slug] ? "key" : t.connectVia;
    const meta = t.description || t.categories.join(", ");
    return (
      <Card key={`catalog-${t.slug}`} className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-4 p-4 sm:flex" hover>
        <Logo slug={t.slug} name={t.name} instanceUrl={t.slug === "vikunja" ? vikunjaInstanceUrl : undefined} />
        {/* The name gets the whole first line. Sharing it with the
            tool count cost ~70px that the count would never give
            back — it is `flex-none`, so the name absorbed every
            squeeze and lost. Demoted to the meta line, where it sits
            beside a description that can truncate harmlessly. */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink" title={t.name}>
            {t.name}
          </div>
          <div className="flex items-baseline gap-1.5 text-[13px] text-ink-subtle">
            <span className="flex-none font-mono text-[11px] text-ink-muted">
              {t.toolsCount} tools
            </span>
            {meta ? (
              <>
                <span aria-hidden className="flex-none text-ink-muted">·</span>
                <span className="truncate" title={meta}>{meta}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="col-span-2 justify-self-end sm:contents">
          {t.noAuth ? (
            // `flex-none`: without it the badge is shrinkable and its
            // label wraps to two lines on a narrow card.
            <Badge className="flex-none whitespace-nowrap">No auth needed</Badge>
          ) : (
            <CardActions
              state={state}
              name={t.name}
              pending={pending === t.slug}
              method={method}
              onConnect={() => connect(t.slug, t.name, method)}
              onDisconnect={() => disconnect(t.slug, t.name)}
              onManage={t.slug === "vikunja" ? () => setVikunjaOpen(true) : undefined}
              connectLabel={t.slug === "vikunja" ? "Connect Vikunja" : undefined}
            />
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Integrations"
        subtitle="Connect your channels and tools."
      />

      <div className="flex items-center gap-2 rounded-control border border-brand-border bg-brand-subtle px-4 py-3 text-[13px] text-brand">
        <Icon name="zap" size={16} />
        <span>
          Connected channels power your automations and let Automata publish on your behalf.
          <span className="ml-1 font-semibold">{connectedChannels} of {CHANNELS.length} channels live.</span>
        </span>
      </div>

      {/* Connected + custom — what's already yours */}
      <section className="flex min-w-0 flex-col gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Connected &amp; custom</h2>
          <p className="mt-0.5 text-[13px] text-ink-subtle">Your connected apps, plus the ones built directly into Automata.</p>
        </div>
        {connectedChannelCards.length === 0 && topCatalogItems.length === 0 ? (
          <Card className="p-8 text-center text-[13px] text-ink-subtle">
            Nothing connected yet — pick a channel or app below to get started.
          </Card>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {connectedChannelCards.map(ChannelCard)}
            {topCatalogItems.map(CatalogCard)}
          </div>
        )}
      </section>

      {/* Full Composio catalog — everything not yet connected */}
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">All integrations</h2>
            <p className="mt-0.5 text-[13px] text-ink-subtle">
              {total > 0 ? `${total.toLocaleString()} apps` : "Every app"} available through Composio — not yet connected, most popular first.
            </p>
          </div>
          <div className="w-full sm:w-72">
            <Input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search apps…"
              aria-label="Search integrations"
            />
          </div>
        </div>

        {/* Category chips */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {CATALOG_CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => onCategory(c.id)}
              aria-pressed={category === c.id}
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

        {discoverChannelCards.length === 0 && discoverCatalogItems.length === 0 && !browsing ? (
          <Card className="p-8 text-center text-[13px] text-ink-subtle">
            {search.trim().toLowerCase().includes("firecrawl")
              ? "Web research is built in — Automata can already read the public web, with nothing to connect."
              : "No apps match — try a different search or category."}
          </Card>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {discoverChannelCards.map(ChannelCard)}
            {discoverCatalogItems.map(CatalogCard)}
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
      <VikunjaConnectDialog
        open={vikunjaOpen}
        connected={status.vikunja === "connected"}
        instanceUrl={vikunjaInstanceUrl}
        onOpenChange={setVikunjaOpen}
        onConnected={(url) => {
          setVikunjaInstanceUrl(url);
          setStatus((current) => ({ ...current, vikunja: "connected" }));
          toast({ title: "Vikunja connected", description: "Your API token was verified and stored securely." });
        }}
      />
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

/**
 * Where a card sits in the list.
 *
 * Two questions, in that order: does this workspace already have the app, and
 * if not, what will it take to get it? The catalog arrives in Composio's
 * popularity order, which is a fine tiebreaker but a poor headline — a
 * workspace's own connected apps were scattered among ~1,400 others, so the
 * page never answered "what have I actually got?" without a search.
 *
 * `disconnected` sits right after `connected` — it's a card the workspace
 * already has an opinion about and needs to act on, not a fresh app to
 * discover. `pending` sits after that: a connection the user already started
 * and can finish. `noAuth` sits below the two methods a user can act on: it
 * has no button at all, so promoting it would put dead cards above live ones.
 * `own_app` is last — nothing the user types today will unblock it.
 *
 * `disconnected` uses a fractional tier so the three real methods and their
 * comment above stay untouched.
 *
 * The sort is stable, so within a tier Composio's popularity order survives.
 */
const RANK: Record<ConnectMethod, number> = {
  managed: 2,
  key: 3,
  own_app: 5,
};

function cardRank(
  state: Status | undefined,
  method: ConnectMethod,
  noAuth: boolean,
): number {
  if (state === "connected") return 0;
  if (state === "disconnected") return 0.5;
  if (state === "pending") return 1;
  if (noAuth) return 4;
  return RANK[method];
}

/** What each connect method promises the user. */
const CONNECT_LABEL: Record<ConnectMethod, string> = {
  managed: "Connect",
  // This one is finishable right now, in about a minute.
  key: "Add API key",
  // Honest about the wait — nothing the user types will unblock this one.
  own_app: "Set up app",
};

/**
 * The card's right-hand controls.
 *
 * These share one row with the app's name, and they win that fight: the row is
 * `flex-none` while the name column shrinks. A "Connected" badge next to a
 * "Disconnect" text button ran ~196px, which in a three-column grid left the
 * name about 40px — every connected app read as a single letter ("G", "S").
 *
 * So the destructive action goes icon-only. It keeps its accessible name and a
 * native tooltip, and it is the control on the card least in need of a label:
 * the badge beside it has already said what state this is.
 */
function CardActions({
  state,
  name,
  pending,
  method,
  onConnect,
  onDisconnect,
  onManage,
  connectLabel,
}: {
  state: Status | undefined;
  /** Names the icon-only button for screen readers and on hover. */
  name: string;
  pending: boolean;
  method: ConnectMethod;
  onConnect: () => void;
  onDisconnect: () => void;
  onManage?: () => void;
  connectLabel?: string;
}) {
  if (state === "connected") {
    return (
      <div className="flex flex-none items-center gap-1.5">
        <Badge tone="success" dot>Connected</Badge>
        {onManage ? <Button variant="secondary" size="sm" onClick={onManage}>Manage</Button> : null}
        {/* `Button` rather than `IconButton`: it carries the loading spinner,
            and an icon with no children renders as a compact square. */}
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          loading={pending}
          onClick={onDisconnect}
          aria-label={`Disconnect ${name}`}
          title={`Disconnect ${name}`}
          className="px-2"
        />
      </div>
    );
  }
  if (state === "disconnected") {
    return (
      <div className="flex flex-none items-center gap-2">
        <Badge tone="danger" dot>Disconnected</Badge>
        <Button variant="primary" size="sm" loading={pending} onClick={onConnect}>
          Reconnect
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
      {connectLabel ?? CONNECT_LABEL[method]}
    </Button>
  );
}
