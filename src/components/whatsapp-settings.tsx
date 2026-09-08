"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Switch } from "@/components/ui/form";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { setupNotice } from "@/lib/setup-notice";

interface Profile {
  phone_e164: string;
  verified_at: string | null;
  consented_at: string | null;
  enabled: boolean;
  workflow_reminders: boolean;
  general_reminders: boolean;
}

type SetupMode = "sandbox" | "sms" | "unavailable";

export function WhatsAppSettings() {
  const { toast } = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [mode, setMode] = useState<SetupMode>("unavailable");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/whatsapp/profile", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json() as { profile: Profile | null; setupMode: SetupMode };
    setProfile(data.profile);
    setMode(data.setupMode);
    if (data.profile?.phone_e164) setPhone(data.profile.phone_e164);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/whatsapp/profile", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { profile: Profile | null; setupMode: SetupMode } | null) => {
        if (!data) return;
        setProfile(data.profile);
        setMode(data.setupMode);
        if (data.profile?.phone_e164) setPhone(data.profile.phone_e164);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function requestCode() {
    setBusy(true);
    const res = await fetch("/api/whatsapp/verify/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) return toast({ title: "Phone verification failed", description: data.error, tone: "danger" });
    setStage("code");
  }

  async function verify() {
    setBusy(true);
    const res = await fetch("/api/whatsapp/verify/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: mode === "sandbox" ? "sandbox-joined" : code, consent }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) return toast({ title: "Couldn’t verify the phone number", description: data.error, tone: "danger" });
    await load();
    toast({ title: "Phone number verified", tone: "success" });
  }

  async function update(patch: Record<string, boolean>) {
    setBusy(true);
    const res = await fetch("/api/whatsapp/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) return toast({ title: "Couldn’t save WhatsApp settings", description: data.error, tone: "danger" });
    await load();
  }

  async function sendTest() {
    setBusy(true);
    const res = await fetch("/api/whatsapp/test", { method: "POST" });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    toast(res.ok
      ? { title: "Test reminder queued", description: "Delivery status will update from Twilio.", tone: "success" }
      : { title: "Couldn’t send the test", description: data.error, tone: "danger" });
  }

  const verified = Boolean(profile?.verified_at && profile.consented_at);
  return (
    <section className="rounded-card border border-line bg-sunken p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-control bg-success-surface text-success">
          <Icon name="message-circle" size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-ink">WhatsApp</h3>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${verified ? "bg-success-surface text-success" : "bg-inset text-ink-muted"}`}>
              {verified ? "Verified" : "Setup required"}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-subtle">
            Workflow summaries are sent only when a run reaches a WhatsApp node.
          </p>
        </div>
      </div>

      {!verified ? (
        <div className="mt-5 max-w-lg space-y-4">
          <Field label="WhatsApp phone number" hint="Include the country code, for example +919876543210.">
            <Input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+91…" disabled={busy || stage === "code"} />
          </Field>
          {mode === "unavailable" && (
            <div className="rounded-control border border-warning-border bg-warning-surface px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
              {setupNotice(
                "Phone verification isn’t available right now, so WhatsApp reminders can’t be switched on yet.",
                "SMS verification is not configured yet. Add a Twilio Verify Service SID to enable phone confirmation.",
              )}
            </div>
          )}
          {stage === "phone" ? (
            <Button onClick={requestCode} loading={busy} disabled={mode === "unavailable" || !phone.trim()}>
              {mode === "sms" ? "Send SMS code" : "Continue"}
            </Button>
          ) : (
            <>
              {mode === "sandbox" ? (
                <div className="rounded-control border border-warning-border bg-warning-surface px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
                  {setupNotice(
                    "Confirm below to finish connecting this number.",
                    "Join the Twilio WhatsApp Sandbox from its Console page using this phone, then confirm below. Sandbox access is for development only.",
                  )}
                </div>
              ) : (
                <>
                  <div className="rounded-control border border-line bg-inset px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
                    We sent a 6-digit verification code by SMS to confirm you control this number.
                  </div>
                  <Field label="SMS verification code">
                    <Input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={10} />
                  </Field>
                </>
              )}
              <Checkbox checked={consent} onChange={setConsent} label="I agree to receive Automata workflow reminders on WhatsApp." />
              <div className="flex gap-2">
                <Button onClick={verify} loading={busy} disabled={!consent || (mode === "sms" && !code.trim())}>
                  {mode === "sandbox" ? "I joined the Sandbox" : "Verify number and enable"}
                </Button>
                <Button variant="secondary" onClick={() => setStage("phone")} disabled={busy}>Back</Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          <div className="text-[13px] text-ink-muted">{profile?.phone_e164}</div>
          {[
            ["workflowReminders", "Workflow reminders", "Summaries, failures, and approval alerts from workflows that use WhatsApp.", profile?.workflow_reminders],
            ["generalReminders", "General reminders", "Automata reminders that are not tied to a workflow.", profile?.general_reminders],
          ].map(([key, title, description, checked]) => (
            <div key={String(key)} className="flex items-center justify-between gap-4 rounded-control border border-line bg-card px-4 py-3">
              <div><div className="text-[13.5px] font-medium text-ink">{title}</div><div className="text-[12.5px] text-ink-subtle">{description}</div></div>
              <Switch checked={Boolean(checked)} onChange={(value) => update({ [String(key)]: value })} disabled={busy || !profile?.enabled} />
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-2">
            {profile?.enabled ? (
              <>
                <Button variant="secondary" onClick={sendTest} loading={busy} disabled={!profile.workflow_reminders}>Send test reminder</Button>
                <Button variant="ghost" onClick={() => update({ enabled: false, workflowReminders: false, generalReminders: false })} disabled={busy}>Disable WhatsApp</Button>
              </>
            ) : (
              <Button onClick={() => update({ enabled: true })} loading={busy}>Enable WhatsApp</Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
