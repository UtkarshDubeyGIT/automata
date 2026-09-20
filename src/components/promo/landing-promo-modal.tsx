"use client";

import Link from "next/link";
import * as React from "react";

import { Button, Dialog, Icon } from "@/components/ui";
import { hasSeen, LANDING_PROMO_KEY, markSeen, WELCOME_BONUS_CREDITS } from "@/lib/promo/welcome-bonus";

import { ConfettiBurst } from "./confetti";
import styles from "./landing-promo-modal.module.css";

// Let visitors orient themselves before the celebration takes over the page.
// Confetti mounts from the same `open` state, so it appears at this moment too.
const OPEN_DELAY_MS = 4_500;

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
        width={400}
        footer={
          <>
            <Button variant="ghost" onClick={close}>Not now</Button>
            <Link
              href="/signup"
              className="inline-flex h-10 items-center gap-2 rounded-control bg-brand px-4 text-[14px] font-medium text-on-brand shadow-[var(--shadow-brand)] transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Create account <Icon name="arrow-right" size={16} />
            </Link>
          </>
        }
      >
        <div className={styles.content}>
          <div className={styles.ornament} aria-hidden="true">
            <Icon name="sparkles" size={18} className={`${styles.sparkle} ${styles.sparkleLeft}`} />
            <Icon name="sparkles" size={14} className={`${styles.sparkle} ${styles.sparkleRight}`} />
            <span className={`${styles.confetti} ${styles.confettiOne}`} />
            <span className={`${styles.confetti} ${styles.confettiTwo}`} />
            <span className={`${styles.confetti} ${styles.confettiThree}`} />
            <span className={`${styles.confetti} ${styles.confettiFour}`} />
            <span className={`${styles.confetti} ${styles.confettiFive}`} />
          </div>
          <div className="relative z-[1] flex flex-col items-center gap-3 py-1 text-center">
            <span className={styles.sparkleBadge}>
              <Icon name="sparkles" size={18} strokeWidth={2} />
            </span>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">New account bonus</p>
            <h2 className="text-[25px] font-semibold leading-tight tracking-[-0.025em] text-ink">
              {bonus} credits to start
            </h2>
            <p className="max-w-[22rem] text-[15px] leading-relaxed text-ink-subtle">
              Build your first workflow. No card required.
            </p>
          </div>
        </div>
      </Dialog>
    </>
  );
}
