"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { toolkitLogo } from "@/lib/social/platforms";
import {
  INTEGRATION_RETURN_CHANNEL,
  type IntegrationReturnMessage,
} from "@/lib/social/oauth-return";
import {
  connectionsOf,
  unconnected,
  type AppConnection,
  type IntegrationRow,
  type RequiredApp,
} from "@/lib/workflows/apps";

/**
 * "Accounts this automation uses" — one row per third-party service, each
 * saying plainly whether this workspace has it, with the way to fix it right
 * there.
 *
 * Shared on purpose by all three places an automation is created or edited
 * (the AI chat preview, the template gallery, the editor), because they used
 * to disagree: the chat showed connect rows, templates showed nothing at all,
 * and the editor — the screen you spend the most time on — never mentioned
 * connections in its life. So "is this thing actually wired up?" was answered
 * by switching the automation on and reading a failed run: `steps.ts` throws
 * "<app> is not connected" at the first action that needs it, which is the
 * latest possible moment to find out and the only one that costs a run.
 *
 * The hook is separate from the panel so a parent can GATE on the answer —
 * `unconnected()` is what disables "Save workflow" and "Create automation".
 */

export function useAppConnections(apps: RequiredApp[]) {
  const [rows, setRows] = useState<IntegrationRow[] | null>(null);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const alive = useRef(true);
  const inFlight = useRef<Promise<{ rows: IntegrationRow[] | null; live: boolean }> | null>(null);
  /**
   * Apps a refusal told us would accept a pasted key.
   *
   * A ref, not state: nothing renders from it, and re-rendering the whole
   * builder because one app answered differently would be noise.
   */
  const keyOffer = useRef<Set<string>>(new Set());
  /**
   * The same answer, readable synchronously.
   *
   * `resolve()` has to be able to say "wait for the first fetch, then tell me"
   * to a caller that is deciding whether to open a dialog, and React state is
   * not available to it until the next render.
   */
  const latest = useRef<{ rows: IntegrationRow[] | null; live: boolean }>({
    rows: null,
    live: true,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const res = await fetch("/api/integrations/connect");
        const data = (await res.json()) as { integrations?: IntegrationRow[]; live?: boolean };
        // An install with no COMPOSIO_API_KEY simulates every action (steps.ts),
        // so no row from it can honestly be called a live connection.
        latest.current = { rows: data.integrations ?? [], live: data.live !== false };
        if (alive.current) {
          setRows(latest.current.rows);
          setLive(latest.current.live);
        }
      } catch {
        // Leave whatever we have; `unknown` never blocks, and a later poll may
        // succeed. Blanking the rows here would turn a flaky network into
        // "nothing you own is connected".
      }
      return latest.current;
    })();
    inFlight.current = request.finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, []);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    // Nothing to ask about — an edit-mode chat message, a graph with no
    // third-party steps — so don't ask.
    if (!apps.length) return;
    // Deferred a tick so state lands asynchronously, not during render.
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [apps.length, load]);

  const connections = useMemo(() => connectionsOf(apps, rows, live), [apps, rows, live]);
  const missing = useMemo(() => unconnected(connections), [connections]);

  /**
   * State for a subset of apps, waiting for the first fetch if it hasn't
   * landed. This is what a "create this template" click asks before deciding
   * whether to prompt — answering "unknown" in that window would create the
   * automation the prompt exists to hold back.
   */
  const resolve = useCallback(
    async (subset: RequiredApp[]): Promise<AppConnection[]> => {
      const state = latest.current.rows ? latest.current : await load();
      return connectionsOf(subset, state.rows, state.live);
    },
    [load],
  );

  // While an OAuth tab is open (status "pending"), poll for ~2 minutes so the
  // row flips to Connected without the user coming back to press anything.
  const hasPending = connections.some((c) => c.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    let polls = 0;
    const timer = setInterval(() => {
      if (++polls > 30) {
        clearInterval(timer);
        return;
      }
      void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [hasPending, load]);

  const mark = useCallback((platform: string, status: string) => {
    const next = withStatus(latest.current.rows, platform, status);
    latest.current = { ...latest.current, rows: next };
    if (alive.current) setRows(next);
  }, []);

  // The OAuth tab reports back over a same-origin BroadcastChannel, so the
  // original workflow page keeps its in-memory chat and preview intact.
  useEffect(() => {
    if (!apps.length || typeof window.BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel(INTEGRATION_RETURN_CHANNEL);
    const onMessage = (event: MessageEvent<IntegrationReturnMessage>) => {
      const data = event.data;
      if (
        !data ||
        data.type !== "zidaneai:integration-complete" ||
        typeof data.platform !== "string" ||
        !apps.some((app) => app.app === data.platform)
      ) {
        return;
      }
      if (data.connected) mark(data.platform, "connected");
      void load().then(() => {
        // A status request that was already in flight can have started before
        // OAuth finished. Re-apply the verified success after it settles so a
        // stale response cannot briefly put the row back into pending.
        if (data.connected) mark(data.platform, "connected");
      });
    };
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, [apps, load, mark]);

  const connect = useCallback(
    async (app: RequiredApp) => {
      if (busy || app.simulated) return;
      setBusy(app.app);
      try {
        const res = await fetch("/api/integrations/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: app.app,
            // Come back to the automation being built, not to Integrations —
            // the whole point is not to lose the half-made thing on screen.
            returnTo: window.location.pathname + window.location.search,
            returnMode: "popup",
            // Set only by a previous refusal that said a key would work, so
            // the second press is a choice the user has been told about.
            mode: keyOffer.current.has(app.app) ? "key" : undefined,
          }),
        });
        const data = (await res.json()) as {
          connected?: boolean;
          redirectUrl?: string;
          needsCredentials?: boolean;
          keyFallback?: boolean;
          error?: string;
        };
        if (data.needsCredentials) {
          if (data.keyFallback) {
            keyOffer.current.add(app.app);
            toast({
              title: `${app.label} has no one-tap login`,
              description: "Press Connect again to use your own API key instead.",
              tone: "warning",
            });
            return;
          }
          toast({
            title: `${app.label} needs its own OAuth app`,
            description: data.error ?? "Add your developer-app credentials, then retry.",
            tone: "warning",
          });
          return;
        }
        if (data.redirectUrl) {
          // A new tab, not a navigation: this is called from a page holding
          // unsaved work (a chat preview, an edited canvas).
          window.open(data.redirectUrl, "_blank", "noopener");
          mark(app.app, "pending");
          toast({
            title: `Finish connecting ${app.label}`,
            description: "Complete the sign-in in the new tab — this updates automatically.",
          });
          return;
        }
        if (data.connected) {
          mark(app.app, "connected");
          toast({ title: `${app.label} connected` });
          return;
        }
        toast({ title: `Couldn't connect ${app.label}`, description: data.error, tone: "danger" });
      } catch {
        toast({ title: `Couldn't connect ${app.label}`, tone: "danger" });
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [busy, mark, toast],
  );

  return { connections, missing, busy, connect, refresh, resolve };
}

function withStatus(
  rows: IntegrationRow[] | null,
  platform: string,
  status: string,
): IntegrationRow[] {
  const rest = (rows ?? []).filter((r) => r.platform !== platform);
  return [...rest, { platform, status }];
}

export function ConnectApps({
  connections,
  busy,
  onConnect,
  title = "Accounts this automation uses",
  note,
}: {
  connections: AppConnection[];
  busy: string | null;
  onConnect: (app: RequiredApp) => void;
  title?: string;
  /** Optional line under the header — what the missing ones cost. */
  note?: string;
}) {
  if (!connections.length) return null;
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div className="border-b border-line bg-inset/60 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Icon name="plug" size={13} className="text-ink-muted" />
          <span className="text-[12px] font-semibold text-ink">{title}</span>
        </div>
        {note && <p className="mt-1 text-[12px] leading-snug text-ink-subtle">{note}</p>}
      </div>
      {connections.map((app, i) => (
        <div
          key={app.app}
          className={cn("flex items-center gap-3 px-3.5 py-2.5", i > 0 && "border-t border-line")}
        >
          <AppLogo app={app.app} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{app.label}</span>
          <AppStatus app={app} busy={busy === app.app} onConnect={() => onConnect(app)} />
        </div>
      ))}
    </div>
  );
}

/** Healthy connections take up no canvas space, but remain inspectable. */
export function ConnectedAppIcons({ connections }: { connections: AppConnection[] }) {
  if (!connections.length) return null;
  return (
    <div
      className="flex flex-none items-center gap-1"
      aria-label={`${connections.length} connected ${connections.length === 1 ? "tool" : "tools"}`}
    >
      {connections.map((app) => (
        <span
          key={app.app}
          tabIndex={0}
          aria-label={`${app.label} connected`}
          className="group relative rounded-[7px] outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          <AppLogo app={app.app} size="sm" />
          <span
            aria-hidden="true"
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card bg-success"
          />
          <span
            role="tooltip"
            className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-[7px] bg-ink px-2 py-1 text-[11px] font-medium text-card opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus:opacity-100"
          >
            {app.label} connected
          </span>
        </span>
      ))}
    </div>
  );
}

function AppStatus({
  app,
  busy,
  onConnect,
}: {
  app: AppConnection;
  busy: boolean;
  onConnect: () => void;
}) {
  if (app.status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-success">
        <Icon name="check-circle" size={14} />
        Connected
      </span>
    );
  }
  if (app.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
        <Icon name="refresh" size={13} className="animate-spin" />
        Authorizing…
      </span>
    );
  }
  // Nothing can connect this one, so offering a button would be a lie — and
  // pressing it used to produce a green "Connected" for an account that does
  // not exist.
  if (app.status === "simulated") {
    return (
      <span
        title={`No live ${app.label} connection is available — steps against it produce realistic results without reaching ${app.label}.`}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-inset px-2 py-0.5 text-[11.5px] font-semibold text-ink-muted"
      >
        <Icon name="info" size={12} />
        Demo mode
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant={app.status === "none" ? "secondary" : "ghost"}
      loading={busy}
      disabled={app.status === "unknown"}
      onClick={onConnect}
    >
      Connect
    </Button>
  );
}

function AppLogo({ app, size = "md" }: { app: string; size?: "sm" | "md" }) {
  const [broken, setBroken] = useState(false);
  const dimensions = size === "sm" ? "h-6 w-6 rounded-[7px]" : "h-7 w-7 rounded-[8px]";
  if (broken) {
    return (
      <span className={cn("flex flex-none items-center justify-center bg-brand-subtle text-brand", dimensions)}>
        <Icon name="plug" size={size === "sm" ? 12 : 14} />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={toolkitLogo(app)}
      alt=""
      width={size === "sm" ? 24 : 28}
      height={size === "sm" ? 24 : 28}
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn("flex-none border border-line bg-card object-contain p-0.5", dimensions)}
    />
  );
}

/** "Gmail and Slack" — for the sentence that says what is still missing. */
export function appList(apps: RequiredApp[]): string {
  const names = apps.map((a) => a.label);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
