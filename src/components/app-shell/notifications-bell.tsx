"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useDismissable } from "./app-controls";

export interface NotificationItem {
  id: string;
  kind: "approval" | "failure" | "connection" | "credits";
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Kind → glyph. Failures should not look like approvals at a glance. */
const KIND_ICON: Record<string, string> = {
  approval: "check",
  failure: "alert",
  connection: "integrations",
  credits: "sparkles",
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The bell, backed by the `notifications` table that has existed since the MVP
 * migration and — until now — was never written to or read from.
 *
 * The unread count here is deliberately NOT the same number as the waiting-runs
 * badge on the account menu. This is an event log: entries stay unread until
 * someone opens them. That one is current state: it clears the moment anybody
 * approves the run. Merging them would mean a teammate's approval leaves your
 * badge stuck, or that reading a notice resurrects a count that is no longer true.
 */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrapRef = useDismissable(open, close);
  const router = useRouter();
  const pathname = usePathname();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = (await res.json()) as { items?: NotificationItem[]; unread?: number };
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      // Never let a failed poll break the screen the bell happens to sit on.
    }
  }, []);

  // Same cadence as the waiting badge: on mount, on navigation, and a slow
  // heartbeat for the case where something lands while the user sits still.
  useEffect(() => {
    // The first read is deferred into a task of its own rather than run in the
    // effect body, so it never sets state synchronously during the commit.
    let alive = true;
    void (async () => {
      await load();
      if (!alive) return;
    })();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [load, pathname]);

  const markRead = useCallback(async (body: { id?: string; all?: boolean }) => {
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Optimistic state below already reflects it; the next poll reconciles.
    }
  }, []);

  function openItem(item: NotificationItem) {
    if (!item.readAt) {
      setItems((list) =>
        list.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)),
      );
      setUnread((n) => Math.max(0, n - 1));
      void markRead({ id: item.id });
    }
    close();
    // The href is written by the producer and points at the specific run.
    if (item.href) router.push(item.href);
  }

  function markAll() {
    setItems((list) => list.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnread(0);
    void markRead({ all: true });
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        className="relative flex h-10 w-10 flex-none items-center justify-center rounded-control bg-card/80 text-ink-muted shadow-xs backdrop-blur transition-colors hover:bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger px-1 py-0.5 text-[10px] font-bold leading-none text-on-brand ring-2 ring-page">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+10px)] z-50 flex max-h-[calc(100dvh-5rem)] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-card border border-line bg-card shadow-lg"
        >
          <div className="flex flex-none items-center justify-between border-b border-line px-4 py-3">
            <span className="text-[13.5px] font-semibold text-ink">Notifications</span>
            {unread > 0 && (
              <button
                onClick={markAll}
                className="text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-ink-subtle">
                Nothing needs you right now.
              </p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  role="menuitem"
                  onClick={() => openItem(item)}
                  className={cn(
                    "flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-inset",
                    !item.readAt && "bg-brand-subtle/40",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full",
                      item.kind === "failure"
                        ? "bg-danger-surface text-danger"
                        : "bg-inset text-ink-muted",
                    )}
                  >
                    <Icon name={KIND_ICON[item.kind] ?? "bell"} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "truncate text-[13.5px] text-ink",
                          item.readAt ? "font-medium" : "font-semibold",
                        )}
                      >
                        {item.title}
                      </span>
                      <span className="ml-auto flex-none text-[11.5px] text-ink-subtle">
                        {timeAgo(item.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-ink-muted">
                      {item.body}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
