"use client";

import * as React from "react";

import { Button, Dialog, Icon } from "@/components/ui";
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
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-subtle text-brand">
            <Icon name="sparkles" size={26} />
          </span>
          <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">
            Congratulations! 🎉
          </h2>
          <p className="max-w-[30rem] text-[15px] leading-relaxed text-ink-subtle">
            Here are your {bonus} credits. Have fun building your automations or have fun automating your workflows.
          </p>
          <div className="mt-2 rounded-card border border-brand-border bg-brand-subtle px-6 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">Your balance</p>
            <p className="mt-1 font-display text-[34px] font-semibold tracking-[-0.02em] text-ink">
              {Math.max(credits, WELCOME_BONUS_CREDITS).toLocaleString()}
              <span className="ml-1.5 text-[15px] font-medium text-ink-subtle">credits</span>
            </p>
          </div>
        </div>
      </Dialog>
    </>
  );
}
