"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * Route-level error boundary for Automations.
 *
 * The pages handle their own fetch failures; this catches everything else — a
 * render that throws, a chunk that fails to load — so the tab shows a sentence
 * and a retry rather than the app's blank fallback.
 */
export default function WorkflowsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on the server-side stack, so it has to
    // reach somewhere a person can read it.
    console.error("[workflows] render failed:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <Icon name="info" size={28} className="text-danger" />
      <div>
        <div className="text-[15px] font-semibold text-ink">Automations couldn&apos;t load</div>
        <p className="mt-1 max-w-[420px] text-[13.5px] text-ink-subtle">
          {error.message || "Something went wrong rendering this page."}
          {error.digest ? ` (${error.digest})` : ""}
        </p>
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
