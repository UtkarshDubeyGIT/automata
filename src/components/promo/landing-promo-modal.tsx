"use client";

import Link from "next/link";
import * as React from "react";

import { Button, Dialog, Icon } from "@/components/ui";
import { hasSeen, LANDING_PROMO_KEY, markSeen, WELCOME_BONUS_CREDITS } from "@/lib/promo/welcome-bonus";

import { ConfettiBurst } from "./confetti";

const OPEN_DELAY_MS = 1200;

/**
 * First-visit teaser on the landing page. The "seen" flag is written the
 * moment the dialog opens, so a reload counts as a dismissal — the promo gets
 * one shot at the visitor's attention, not one per page load. (Writing it in
 * the timer rather than the effect body also survives StrictMode's
 * double-invoked effects in dev.)
 */
export function LandingPromoModal() {
  const [open, setOpen] = React.useState(false);
  const bonus = WELCOME_BONUS_CREDITS.toLocaleString();

  React.useEffect(() => {
    if (hasSeen(LANDING_PROMO_KEY)) return;
    const id = window.setTimeout(() => {
      markSeen(LANDING_PROMO_KEY);
      setOpen(true);
    }, OPEN_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  const close = React.useCallback(() => setOpen(false), []);

  return (
    <>
      {open && <ConfettiBurst />}
      <Dialog
        open={open}
        onClose={close}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={close}>Maybe later</Button>
            <Link
              href="/signup"
              className="inline-flex h-10 items-center gap-2 rounded-control bg-brand px-4 text-[14px] font-medium text-on-brand shadow-[var(--shadow-brand)] hover:bg-brand-hover"
            >
              Claim {bonus} credits <Icon name="arrow-right" size={16} />
            </Link>
          </>
        }
      >
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-subtle text-brand">
            <Icon name="sparkles" size={26} />
          </span>
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-brand">New-joiner bonus</p>
          <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">
            Welcome gift: {bonus} free credits
          </h2>
          <p className="max-w-[30rem] text-[15px] leading-relaxed text-ink-subtle">
            Sign up today and start with {bonus} credits to build and run your first automations — no card needed.
          </p>
        </div>
      </Dialog>
    </>
  );
}
