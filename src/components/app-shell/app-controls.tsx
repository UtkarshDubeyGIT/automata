"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo } from "@/components/logo";
import { SignOutButton } from "@/components/sign-out-button";
import { Avatar } from "@/components/ui/avatar";
import { useCredits } from "@/components/ui/credits";
import { ProgressBar } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/tabs";
import { useTheme, type Theme } from "@/components/theme";
import { cn, compactNumber } from "@/lib/utils";
import { NotificationsBell } from "./notifications-bell";

/**
 * The entire app shell, reduced to two floating clusters.
 *
 * There is no sidebar and no topbar. The sidebar spent 264px on five links,
 * two of which ("Automations" and "Workflows") pointed at the same route and
 * differed only by `?tab=`; the topbar spent 72px on a search box and a
 * "Create automation" button that both merely deep-linked into the tab UI that
 * the workflows page already renders. Everything that was load-bearing — the
 * credits meter, the waiting-runs badge, account actions — moved in here.
 *
 * Note this deliberately does NOT read search params. Dropping the duplicate
 * "Workflows" entry removed the only reason to, which keeps the whole tree out
 * of a Suspense boundary.
 */

const NAV = [
  { href: "/app/workflows", label: "Automations", icon: "automations" },
  { href: "/app/integrations", label: "Integrations", icon: "integrations" },
  { href: "/app/billing", label: "Billing", icon: "billing" },
  { href: "/app/settings", label: "Settings", icon: "settings" },
];

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Shared by both dropdowns: click-outside plus Escape closes. */
export function useDismissable(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * The graph-paper wash behind the automations canvas.
 *
 * It lives up here rather than inside the page because the page renders inside
 * `<main>`, and a backdrop painted there has to go negative-z to sit under its
 * own siblings — which then puts it under the shell's opaque page fill as well,
 * so nothing shows. As a sibling of `<main>` it just needs z-0 against main's
 * z-10, with no negative stacking anywhere.
 */
function GridWash() {
  const pathname = usePathname();
  if (!pathname.startsWith("/app/workflows")) return null;
  return <div aria-hidden className="grid-wash" />;
}

export function AppControls({
  userName,
  userEmail,
  userAvatarUrl,
}: {
  userName: string;
  userEmail?: string;
  userAvatarUrl?: string | null;
}) {
  return (
    <>
      <GridWash />
      {/*
        The controls float over the scrolling page, so content used to slide
        directly under the mark and the avatar and swallow them. This is the
        glass pane that keeps them readable: a blurred strip across the top,
        masked to fade out at its lower edge so it reads as a soft gradient
        rather than a bar with a hard line under it.
      */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-[55] h-20 bg-page/60 backdrop-blur-xl md:h-24 [mask-image:linear-gradient(to_bottom,black_55%,transparent)] [-webkit-mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
      />
      {/* Losing the sidebar lost the only way back to the start of the app. */}
      <div className="fixed left-4 top-4 z-[60] md:left-6 md:top-6">
        <Logo href="/app/workflows" />
      </div>
      <div className="fixed right-4 top-4 z-[60] flex items-center gap-2 md:right-6 md:top-6">
        <NotificationsBell />
        <AccountMenu userName={userName} userEmail={userEmail} userAvatarUrl={userAvatarUrl} />
      </div>
    </>
  );
}

/**
 * Identity, spend, navigation, theme and sign-out — the whole shell in a panel.
 *
 * Sign-out posts the server action through a real <form>: the action clears the
 * session cookies and redirects, and doing that as a normal submission keeps
 * the browser on the redirect rather than leaving a client-side router pointed
 * at a page the user can no longer load.
 */
function AccountMenu({
  userName,
  userEmail,
  userAvatarUrl,
}: {
  userName: string;
  userEmail?: string;
  userAvatarUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrapRef = useDismissable(open, close);
  const pathname = usePathname();
  const { credits, planName, planCredits } = useCredits();
  const { theme, setTheme } = useTheme();

  /**
   * Runs blocked on a decision.
   *
   * A `waiting` run is the one state in the product that nothing resolves on
   * its own — no timer, no retry, nothing short of the 30-day expiry. It is a
   * live count, which is why it stays separate from the unread notification
   * badge on the bell: approving from anywhere must clear this immediately.
   */
  const [waiting, setWaiting] = useState(0);
  const loadWaiting = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows/waiting");
      if (!res.ok) return;
      const data = (await res.json()) as { waiting?: number };
      setWaiting(data.waiting ?? 0);
    } catch {
      // A badge that can't load is a badge that isn't shown.
    }
  }, []);

  useEffect(() => {
    // The first read is deferred into a task of its own rather than run in the
    // effect body, so it never sets state synchronously during the commit.
    let alive = true;
    void (async () => {
      await loadWaiting();
      if (!alive) return;
    })();
    const id = window.setInterval(() => void loadWaiting(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [loadWaiting, pathname]);

  const plan = planName || "Starter";
  const allowance = planCredits || 1000;

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="group relative flex items-center rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <Avatar name={userName} src={userAvatarUrl} size="md" hoverIcon="menu" />
        {waiting > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-page"
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+10px)] z-50 max-h-[calc(100dvh-5rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-card border border-line bg-card shadow-lg"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-[13.5px] font-semibold text-ink">{userName}</div>
            {userEmail && <div className="truncate text-[12.5px] text-ink-subtle">{userEmail}</div>}
          </div>

          {/* The spend meter used to live at the bottom of the sidebar. */}
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Icon name="sparkles" size={16} className="text-brand" />
              <span className="text-[13px] font-semibold text-ink">{plan}</span>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-[13px] text-ink-subtle">Credits</span>
              <span className="font-mono text-[15px] font-semibold tabular-nums text-ink">
                {compactNumber(credits)}
              </span>
            </div>
            <ProgressBar
              value={allowance > 0 ? (credits / allowance) * 100 : 0}
              tone="gradient"
              className="mt-2"
            />
          </div>

          <div className="p-1.5">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  aria-current={active ? "page" : undefined}
                  onClick={close}
                  className={cn(
                    "flex items-center gap-2.5 rounded-control px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                    active
                      ? "bg-brand-subtle text-brand"
                      : "text-ink-muted hover:bg-inset hover:text-ink",
                  )}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                  {item.href === "/app/workflows" && waiting > 0 && (
                    <span
                      title={`${waiting} run${waiting === 1 ? "" : "s"} waiting for your review`}
                      className="ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full bg-brand px-1.5 py-0.5 text-[11px] font-semibold leading-none text-on-brand"
                    >
                      {waiting}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>

          {/*
            Three-way rather than a switch: a boolean can express light and dark
            but has no way back to following the OS once tapped.
          */}
          <div className="border-t border-line px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-ink-subtle">
              <Icon name="sun" size={14} />
              Theme
            </div>
            <Segmented
              items={THEMES}
              value={theme}
              onChange={(id) => setTheme(id as Theme)}
              size="sm"
            />
          </div>

          <div className="border-t border-line p-1.5">
            <SignOutButton menuItem />
          </div>
        </div>
      )}
    </div>
  );
}
