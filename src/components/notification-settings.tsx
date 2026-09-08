"use client";

import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * The off switch for notifications.
 *
 * notifyWorkspace() has always consulted `notification_preferences`, but
 * nothing ever wrote to it, so every toggle it honoured was unreachable. That
 * was harmless while nothing produced notifications; it stops being harmless
 * the moment failures start sending email.
 *
 * Self-contained, like WhatsAppSettings beside it, rather than folded into the
 * page's shared settings state: this is a different table, keyed per user
 * rather than per workspace, and /api/settings only accepts string fields.
 */

interface Prefs {
  inApp: boolean;
  email: boolean;
  events: { approval: boolean; failure: boolean };
}

const DEFAULTS: Prefs = { inApp: true, email: true, events: { approval: true, failure: true } };

/**
 * Only the kinds something actually emits today. The stored jsonb also carries
 * `connection` and `credits`, which nothing produces yet — a toggle that
 * demonstrably does nothing is worse than one that isn't there. The PATCH
 * merges, so those keys survive untouched.
 */
const KINDS = [
  { id: "failure", label: "Run failures", hint: "A workflow run could not complete." },
  { id: "approval", label: "Approvals", hint: "A run is paused waiting for your decision." },
] as const;

export function NotificationSettings() {
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/notifications/preferences");
        if (!res.ok) return;
        const data = (await res.json()) as Prefs;
        if (!cancelled) setPrefs({ ...DEFAULTS, ...data, events: { ...DEFAULTS.events, ...data.events } });
      } catch {
        // Keep the permissive defaults on screen; saving still works.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: "Couldn't save", description: data?.error, tone: "danger" });
        return;
      }
      toast({ title: "Notification settings saved", tone: "success" });
    } catch {
      toast({ title: "Couldn't save", description: "Please try again.", tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Switch
          checked={prefs.inApp}
          onChange={(v) => setPrefs((p) => ({ ...p, inApp: v }))}
          disabled={loading}
          label={<span className="text-[14px] text-ink">Show notifications in the app</span>}
        />
        <Switch
          checked={prefs.email}
          onChange={(v) => setPrefs((p) => ({ ...p, email: v }))}
          disabled={loading}
          label={<span className="text-[14px] text-ink">Email me about failures</span>}
        />
      </div>

      <div className="border-t border-line pt-4">
        <p className="mb-3 text-[13px] font-medium text-ink-subtle">Notify me about</p>
        <div className="flex flex-col gap-3">
          {KINDS.map((kind) => (
            <Switch
              key={kind.id}
              checked={prefs.events[kind.id]}
              onChange={(v) => setPrefs((p) => ({ ...p, events: { ...p.events, [kind.id]: v } }))}
              disabled={loading}
              label={
                <span className="flex flex-col">
                  <span className="text-[14px] text-ink">{kind.label}</span>
                  <span className="text-[12.5px] text-ink-subtle">{kind.hint}</span>
                </span>
              }
            />
          ))}
        </div>
      </div>

      <div>
        <Button loading={saving} disabled={loading} onClick={save}>
          Save notification settings
        </Button>
      </div>
    </div>
  );
}
