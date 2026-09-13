"use client";

import * as React from "react";

import { Button, Dialog } from "@/components/ui";
import { useCredits } from "@/components/ui/credits";
import { APP_WELCOME_KEY, hasSeen, markSeen, WELCOME_BONUS_CREDITS } from "@/lib/promo/welcome-bonus";

import { ConfettiBurst } from "./confetti";

const OPEN_DELAY_MS = 400;

/**
 * The in-app congratulations for a first-time user. `eligible` comes from the
 * server (workspace age) so an existing customer on a new browser never sees
 * it; the localStorage flag makes sure a new one sees it exactly once.
 */
export function WelcomeBonusModal({ eligible }: { eligible: boolean }) {
  const [open, setOpen] = React.useState(false);
  const { credits, refresh } = useCredits();
  const bonus = WELCOME_BONUS_CREDITS.toLocaleString();

  React.useEffect(() => {
    if (!eligible || hasSeen(APP_WELCOME_KEY)) return;
    // The bonus lands via a DB trigger right after sign-up; make sure the
    // balance we show is the post-bonus one.
    void refresh();
    // Let the page paint first so the dialog rises over real content. The
    // flag is written when it opens, not here, so StrictMode's double effect
    // run in dev doesn't mark it seen before it was ever shown.
    const id = window.setTimeout(() => {
      markSeen(APP_WELCOME_KEY);
      setOpen(true);
    }, OPEN_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [eligible, refresh]);

  const close = React.useCallback(() => setOpen(false), []);

  return (
    <>
      {open && <ConfettiBurst />}
      <Dialog
        open={open}
        onClose={close}
        width={460}
        footer={
          <Button onClick={close} iconRight="arrow-right">Start building</Button>
        }
      >
        <div className="flex flex-col items-center py-4 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">Welcome gift</p>
          {/* The number is the whole point of the dialog, so it is the hero —
              not a card under a paragraph. */}
          <p className="mt-3 font-display text-[56px] font-semibold leading-none tracking-[-0.03em] text-ink">
            {Math.max(credits, WELCOME_BONUS_CREDITS).toLocaleString()}
            <span className="ml-2 text-[18px] font-medium tracking-normal text-ink-subtle">credits</span>
          </p>
          <h2 className="mt-6 text-[22px] font-semibold tracking-[-0.01em] text-ink">Congratulations! 🎉</h2>
          <p className="mt-1.5 max-w-[24rem] text-[15px] leading-relaxed text-ink-subtle">
            Your {bonus} credits are ready — have fun automating your workflows.
          </p>
        </div>
      </Dialog>
    </>
  );
}
