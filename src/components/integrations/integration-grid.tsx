"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { ServiceIcon } from "@/components/service-icon";
import type { IntegrationDefinition } from "@/lib/integrations/catalog";

export function IntegrationGrid({ integrations }: { integrations: IntegrationDefinition[] }) {
  const [connected, setConnected] = useState(new Set<string>());
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/integrations").then(async (response) => {
      const body = await response.json() as { connections?: Array<{ appSlug?: string; app_slug?: string; status: string }> };
      setConnected(new Set((body.connections ?? []).filter((item) => item.status === "connected").map((item) => item.appSlug ?? item.app_slug ?? "")));
    }).catch(() => undefined);
  }, []);

  async function connect(app: string) {
    setPending(app); setNotice("");
    try {
      const response = await fetch("/api/integrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app }) });
      const body = await response.json() as { redirectUrl?: string; error?: string };
      if (!response.ok || !body.redirectUrl) throw new Error(body.error ?? "Connection could not start.");
      window.location.assign(body.redirectUrl);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Connection could not start."); setPending(null); }
  }

  return <>{notice ? <p className="auth-alert preview integration-notice" role="status">{notice}</p> : null}<section className="integration-grid">{integrations.map((integration) => { const isConnected = connected.has(integration.slug); return <article className="integration-card" key={integration.slug}><header><ServiceIcon slug={integration.slug} label={integration.name} />{isConnected && <span><Check size={11} />Connected</span>}</header><h2>{integration.name}</h2><p>{integration.description}</p><div><span>{integration.triggerCount} triggers</span><span>{integration.actionCount} actions</span></div><button disabled={pending === integration.slug} className={isConnected ? "connected" : ""} onClick={() => connect(integration.slug)}>{pending === integration.slug ? "Opening…" : isConnected ? "Reconnect" : "Connect"}</button></article>; })}</section></>;
}
