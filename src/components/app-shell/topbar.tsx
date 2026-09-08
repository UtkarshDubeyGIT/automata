"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import { signOut as signOutAction } from "@/app/(auth)/actions";

export function Topbar({
  userName,
  userEmail,
  onAsk,
}: {
  userName: string;
  userEmail?: string;
  onAsk?: () => void;
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <header className="flex h-[72px] flex-none items-center gap-3 border-b border-line bg-card/80 px-4 md:gap-4 md:px-6 backdrop-blur">
      <form role="search" className="relative max-w-xl flex-1" onSubmit={(event) => {
        event.preventDefault();
        const query = searchRef.current?.value.trim() ?? "";
        router.push(`/app/workflows?tab=workflows${query ? `&q=${encodeURIComponent(query)}` : ""}`);
      }}>
        <Icon
          name="search"
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle"
        />
        <input
          ref={searchRef}
          aria-label="Search workflows"
          placeholder="Search workflows…"
          className="h-10 w-full rounded-control border border-line bg-sunken pl-10 pr-16 text-[14px] text-ink placeholder:text-ink-subtle focus:border-focus focus:bg-card focus:outline-none focus:ring-[3px] focus:ring-[color:rgba(23,23,23,0.32)]"
        />
        <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-line bg-card px-1.5 py-0.5 font-mono text-[11px] text-ink-subtle">
          ⌘K
        </kbd>
      </form>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden sm:block">
          <Button
            size="md"
            icon="plus"
            onClick={onAsk ?? (() => router.push("/app/workflows?tab=create"))}
          >
            Create automation
          </Button>
        </div>
        <Link
          href="/app/workflows?tab=attention"
          aria-label="Needs your attention"
          title="Needs your attention"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-control text-ink-muted hover:bg-inset"
        >
          <Icon name="bell" size={18} />
        </Link>
        <AccountMenu userName={userName} userEmail={userEmail} />
      </div>
    </header>
  );
}

/**
 * The avatar is the only account affordance in the shell, so it has to be the
 * one that signs you out — burying sign-out at the bottom of Settings is how
 * people end up clearing cookies instead.
 *
 * Sign-out posts the server action through a real <form>: the action clears
 * the session cookies and redirects, and doing that as a normal submission
 * keeps the browser on the redirect rather than leaving a client-side router
 * pointed at a page the user can no longer load.
 */
function AccountMenu({ userName, userEmail }: { userName: string; userEmail?: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:rgba(23,23,23,0.32)]"
      >
        <Avatar name={userName} size="md" status="online" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+10px)] z-50 w-60 overflow-hidden rounded-card border border-line bg-card shadow-lg"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-[13.5px] font-semibold text-ink">{userName}</div>
            {userEmail && (
              <div className="truncate text-[12.5px] text-ink-subtle">{userEmail}</div>
            )}
          </div>
          <div className="p-1.5">
            <Link
              href="/app/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-[13.5px] font-medium text-ink-muted transition-colors hover:bg-inset hover:text-ink"
            >
              <Icon name="settings" size={16} />
              Settings
            </Link>
            <Link
              href="/app/billing"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-[13.5px] font-medium text-ink-muted transition-colors hover:bg-inset hover:text-ink"
            >
              <Icon name="billing" size={16} />
              Billing
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13.5px] font-medium text-danger transition-colors hover:bg-danger-surface"
              >
                <Icon name="logout" size={16} />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
