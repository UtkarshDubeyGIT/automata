"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { toolkitLogo } from "@/lib/social/platforms";

/**
 * Vikunja has no OAuth app, so "Connect" can never be a one-tap redirect —
 * this form (instance URL + API token) is the only way to finish. Shared
 * between the dedicated Integrations page and the "Accounts this automation
 * uses" panel (`connect-apps.tsx`) so both surfaces open the same dialog
 * instead of one of them dead-ending in a toast that says "press Connect
 * again" with nothing further to press.
 */
export function VikunjaConnectDialog({
  open,
  connected,
  instanceUrl,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  /** Swaps the copy to "Manage" / "Update connection" for an existing link. */
  connected: boolean;
  /** The workspace's saved instance URL, if any — prefills the form. */
  instanceUrl: string;
  onOpenChange: (open: boolean) => void;
  /** Fired with the verified, normalized instance URL once the token is saved. */
  onConnected: (instanceUrl: string) => void;
}) {
  const [url, setUrl] = useState(instanceUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // Tracks the `open` this render's state belongs to. Reset during render
  // rather than in an effect: an effect would run after the closed dialog's
  // stale form painted for one frame, and would cascade a second render.
  const [openFor, setOpenFor] = useState(open);
  if (open !== openFor) {
    setOpenFor(open);
    if (open) {
      setUrl(instanceUrl);
      setToken("");
      setError("");
    }
  }

  if (!open) return null;

  async function save() {
    setPending(true);
    setError("");
    try {
      const res = await fetch("/api/integrations/vikunja", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceUrl: url, token }),
      });
      const data = (await res.json()) as { connected?: boolean; instanceUrl?: string; error?: string };
      if (!res.ok || !data.connected) {
        setError(data.error ?? "Vikunja could not be connected.");
        return;
      }
      onConnected(data.instanceUrl ?? url.trim().replace(/\/+$/, ""));
      onOpenChange(false);
    } catch {
      setError("Vikunja could not be reached. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onMouseDown={() => onOpenChange(false)}
    >
      <Card
        className="w-full max-w-md p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vikunja-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <VikunjaLogo instanceUrl={url} />
          <div className="min-w-0 flex-1">
            <h2 id="vikunja-dialog-title" className="text-[18px] font-semibold text-ink">
              {connected ? "Manage Vikunja" : "Connect Vikunja"}
            </h2>
            <p className="mt-1 text-[13px] text-ink-subtle">
              Enter your deployed Vikunja app URL and an API token. The connection is encrypted and scoped to this workspace.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2">
          <label htmlFor="vikunja-instance-url" className="text-[13px] font-medium text-ink">
            Vikunja app URL
          </label>
          <Input
            id="vikunja-instance-url"
            type="url"
            autoComplete="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://tasks.example.com"
          />
          <label htmlFor="vikunja-token" className="text-[13px] font-medium text-ink">
            API token
          </label>
          <Input
            id="vikunja-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={connected ? "Paste a replacement token" : "Paste your Vikunja API token"}
          />
          {error ? (
            <p className="text-[12px] text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {url.trim().startsWith("https://") ? (
            <a
              className="text-[12px] font-medium text-brand hover:underline"
              href={`${url.trim().replace(/\/+$/, "")}/user/settings/api-tokens`}
              target="_blank"
              rel="noreferrer"
            >
              Get an API token from this Vikunja instance
            </a>
          ) : null}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!url.trim() || !token.trim()} onClick={save}>
            {connected ? "Update connection" : "Connect Vikunja"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function VikunjaLogo({ instanceUrl }: { instanceUrl: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span
        className="flex flex-none items-center justify-center rounded-[12px] bg-inset text-[16px] font-semibold text-ink-muted"
        style={{ width: 48, height: 48 }}
      >
        V
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={toolkitLogo("vikunja", instanceUrl)}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      onError={() => setBroken(true)}
      className="flex-none rounded-[12px] border border-line bg-card object-contain p-1.5"
    />
  );
}
