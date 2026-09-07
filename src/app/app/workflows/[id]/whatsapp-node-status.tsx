"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";

type State = "loading" | "setup" | "disabled" | "ready";
type Profile = {
  verified_at?: string | null;
  consented_at?: string | null;
  enabled?: boolean;
  workflow_reminders?: boolean;
};

function useWhatsAppState(): State {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/whatsapp/profile", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { profile?: Profile } | null) => {
        if (cancelled) return;
        const profile = data?.profile;
        if (!profile?.verified_at || !profile.consented_at) setState("setup");
        else if (!profile.enabled || !profile.workflow_reminders) setState("disabled");
        else setState("ready");
      })
      .catch(() => { if (!cancelled) setState("setup"); });
    return () => { cancelled = true; };
  }, []);

  return state;
}

export function WhatsAppNodeAlert({ onClick }: { onClick: () => void }) {
  const state = useWhatsAppState();
  if (state === "loading" || state === "ready") return null;

  return (
    <button
      type="button"
      aria-label="WhatsApp configuration needed"
      title="WhatsApp setup is required before this workflow can run"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="nodrag nopan pointer-events-auto mt-1 inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-surface px-2 py-1 text-[10px] font-semibold text-warning shadow-xs transition-colors hover:border-warning"
    >
      <Icon name="info" size={11} />
      Configuration needed
    </button>
  );
}

export function WhatsAppNodeStatus() {
  const state = useWhatsAppState();

  const copy = state === "ready"
    ? "1 verified recipient. The message is queued when this run reaches this node."
    : state === "disabled"
      ? "Workflow reminders are disabled in Notifications settings."
      : state === "setup"
        ? "WhatsApp setup is required before this node can send."
        : "Checking the WhatsApp recipient…";
  return (
    <div className={`rounded-card border px-3 py-2.5 ${state === "ready" ? "border-success-border bg-success-surface" : "border-warning-border bg-warning-surface"}`}>
      <div className="flex items-start gap-2">
        <Icon name={state === "ready" ? "check-circle" : "info"} size={14} className="mt-0.5 flex-none" />
        <div className="text-[12.5px] leading-relaxed text-ink-muted">
          {copy}{" "}
          {state !== "ready" && <Link href="/settings" className="font-medium text-brand hover:underline">Open settings</Link>}
        </div>
      </div>
    </div>
  );
}
