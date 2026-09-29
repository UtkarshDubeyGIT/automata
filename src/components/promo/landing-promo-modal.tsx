"use client";

import Link from "next/link";
import * as React from "react";

import { Button, Dialog, Icon } from "@/components/ui";
import { hasSeen, LANDING_PROMO_KEY, markSeen, WELCOME_BONUS_CREDITS } from "@/lib/promo/welcome-bonus";

import { ConfettiBurst } from "./confetti";
import styles from "./landing-promo-modal.module.css";

// Wait until visitors have had time to read and have scrolled into the page.
// Confetti mounts from the same `open` state, so it appears with the dialog.
const OPEN_DELAY_MS = 20_000;
const SCROLL_THRESHOLD = 0.25;

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
    let delayElapsed = false;
    let scrolledEnough = false;
    let opened = false;

    const checkScroll = () => {
      const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollableHeight > 0 && window.scrollY / scrollableHeight >= SCROLL_THRESHOLD) {
        scrolledEnough = true;
        window.removeEventListener("scroll", checkScroll);
        maybeOpen();
      }
    };

    const maybeOpen = () => {
      if (opened || !delayElapsed || !scrolledEnough) return;
      opened = true;
      markSeen(LANDING_PROMO_KEY);
      setOpen(true);
      window.removeEventListener("scroll", checkScroll);
    };

    checkScroll();
    if (!scrolledEnough) window.addEventListener("scroll", checkScroll, { passive: true });

    const id = window.setTimeout(() => {
      delayElapsed = true;
      maybeOpen();
    }, OPEN_DELAY_MS);

    return () => {
      window.clearTimeout(id);
      window.removeEventListener("scroll", checkScroll);
    };
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
            <span className={`${styles.sparkle} ${styles.sparkleOne}`} />
            <span className={`${styles.sparkle} ${styles.sparkleTwo}`} />
            <span className={`${styles.sparkle} ${styles.sparkleThree}`} />
            <span className={`${styles.sparkle} ${styles.sparkleFour}`} />
            <span className={`${styles.sparkle} ${styles.sparkleFive}`} />
            <span className={`${styles.sparkle} ${styles.sparkleSix}`} />
            <span className={`${styles.sparkle} ${styles.sparkleSeven}`} />
            <span className={`${styles.sparkle} ${styles.sparkleEight}`} />
            <span className={`${styles.confetti} ${styles.confettiOne}`} />
            <span className={`${styles.confetti} ${styles.confettiTwo}`} />
            <span className={`${styles.confetti} ${styles.confettiThree}`} />
            <span className={`${styles.confetti} ${styles.confettiFour}`} />
            <span className={`${styles.confetti} ${styles.confettiFive}`} />
          </div>
          <div className="relative z-[1] flex flex-col items-center gap-3 py-1 text-center">
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
