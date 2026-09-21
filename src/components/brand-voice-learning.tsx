"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";

interface VoiceProfile {
  id: string;
  version: number;
  status: "candidate" | "accepted" | "disabled" | "deleted";
  guidance: string;
  confidence?: number;
  source_refs?: Array<{ sourceType: string; authorId: string; observedAt: string }>;
  sample_count?: number;
}

interface Connection {
  app_slug?: string;
  appSlug?: string;
  provider_account_id?: string;
  accountId?: string;
  display_name?: string;
  displayName?: string;
  status?: string;
}

interface Props {
  website?: string;
  disabled?: boolean;
}

export function BrandVoiceLearning({ website, disabled }: Props) {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [sourceType, setSourceType] = useState<"gmail" | "slack">("slack");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accountId, setAccountId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [authorId, setAuthorId] = useState("");
  const [text, setText] = useState("");
  const [samples, setSamples] = useState<Array<Record<string, string>>>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const [voiceResponse, integrationsResponse] = await Promise.all([
      fetch("/api/brand/voice"),
      fetch("/api/integrations"),
    ]);
    const data = (await voiceResponse.json().catch(() => ({}))) as { profiles?: VoiceProfile[] };
    const integrations = (await integrationsResponse.json().catch(() => ({}))) as { connections?: Connection[] };
    if (voiceResponse.ok) setProfiles(data.profiles ?? []);
    if (integrationsResponse.ok) {
      const next = (integrations.connections ?? []).filter((connection) => connection.status === "connected");
      setConnections(next);
      const first = next.find((connection) => (connection.app_slug ?? connection.appSlug) === sourceType);
      if (!accountId && first) setAccountId(first.provider_account_id ?? first.accountId ?? "");
    }
  }, [accountId, sourceType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function addSample() {
    if (!accountId.trim() || !sourceId.trim() || !authorId.trim() || !text.trim()) return;
    setSamples((current) => [
      ...current,
      { sourceType, accountId: accountId.trim(), sourceId: sourceId.trim(), authorId: authorId.trim(), createdAt: new Date().toISOString(), text: text.trim() },
    ].slice(0, 100));
    setSourceId("");
    setAuthorId("");
    setText("");
  }

  const sourceConnections = connections.filter((connection) => (connection.app_slug ?? connection.appSlug) === sourceType);

  async function learn() {
    setLoading(true);
    try {
      const response = await fetch("/api/brand/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website, samples }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast({ title: "Couldn’t learn the voice", description: data.error, tone: "danger" });
        return;
      }
      setSamples([]);
      toast({ title: "Voice candidate ready", description: "Review it below before it affects generation.", tone: "success" });
      await load();
    } catch {
      toast({ title: "Couldn’t reach the server", tone: "danger" });
    } finally {
      setLoading(false);
    }
  }

  async function act(id: string, action: "accept" | "disable" | "delete") {
    setLoading(true);
    try {
      const response = await fetch("/api/brand/voice", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast({ title: "Couldn’t update the voice", description: data.error, tone: "danger" });
        return;
      }
      await load();
      toast({ title: action === "accept" ? "Voice accepted" : action === "disable" ? "Voice disabled" : "Voice deleted", tone: "success" });
    } finally {
      setLoading(false);
    }
  }

  const candidate = profiles.find((profile) => profile.status === "candidate");
  const accepted = profiles.find((profile) => profile.status === "accepted");
  return (
    <div className="mt-8 max-w-2xl border-t border-line pt-6">
      <div className="text-[13px] font-semibold text-ink">Learn from selected channel samples</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-subtle">
        Add up to 100 samples from the last 90 days. We strip signatures and quoted replies, keep provenance only, and wait for your approval.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Field label="Source" htmlFor="voice-source">
          <Select id="voice-source" value={sourceType} disabled={disabled || loading} onChange={(event) => {
            const next = event.target.value as "gmail" | "slack";
            setSourceType(next);
            const first = connections.find((connection) => (connection.app_slug ?? connection.appSlug) === next);
            setAccountId(first?.provider_account_id ?? first?.accountId ?? "");
          }}>
            <option value="slack">Slack</option>
            <option value="gmail">Gmail</option>
          </Select>
        </Field>
        <Field label="Connected account" htmlFor="voice-account">
          <Select id="voice-account" value={accountId} disabled={disabled || loading || !sourceConnections.length} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">{sourceConnections.length ? "Choose an account" : `Connect ${sourceType} first`}</option>
            {sourceConnections.map((connection) => {
              const id = connection.provider_account_id ?? connection.accountId ?? "";
              return <option key={id} value={id}>{connection.display_name ?? connection.displayName ?? id}</option>;
            })}
          </Select>
        </Field>
        <Field label="Channel/message id" htmlFor="voice-source-id">
          <Input id="voice-source-id" value={sourceId} disabled={disabled || loading} onChange={(event) => setSourceId(event.target.value)} placeholder="#brand or message id" />
        </Field>
        <Field label="Author id" htmlFor="voice-author-id">
          <Input id="voice-author-id" value={authorId} disabled={disabled || loading} onChange={(event) => setAuthorId(event.target.value)} placeholder="selected author" />
        </Field>
      </div>
      <Field label="Selected sample" htmlFor="voice-sample" hint="Paste one message body; quoted replies and signatures are removed automatically.">
        <Textarea id="voice-sample" rows={3} value={text} disabled={disabled || loading} onChange={(event) => setText(event.target.value)} placeholder="Paste a representative message…" />
      </Field>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={disabled || loading || !accountId.trim() || !text.trim() || !sourceId.trim() || !authorId.trim()} onClick={addSample}>Add sample ({samples.length}/100)</Button>
        <Button loading={loading} disabled={disabled || loading || (!samples.length && !website)} onClick={learn}>Create reviewable candidate</Button>
      </div>
      {!!samples.length && <p className="mt-2 text-[12px] text-ink-subtle">{samples.length} selected sample{samples.length === 1 ? "" : "s"} queued; source bodies are not saved by the server.</p>}
      {candidate && (
        <div className="mt-5 rounded-card border border-brand-border bg-brand-subtle/30 p-4">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-brand">Candidate v{candidate.version}</div>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{candidate.guidance}</p>
          <p className="mt-2 text-[12px] text-ink-subtle">{candidate.sample_count ?? 0} sanitized samples · confidence {Math.round((candidate.confidence ?? 0) * 100)}%</p>
          <div className="mt-3 flex gap-2">
            <Button loading={loading} onClick={() => void act(candidate.id, "accept")}>Accept</Button>
            <Button variant="secondary" disabled={loading} onClick={() => void act(candidate.id, "delete")}>Delete</Button>
          </div>
        </div>
      )}
      {accepted && (
        <div className="mt-4 rounded-card border border-line bg-card p-4">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">Accepted workspace voice v{accepted.version}</div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink">{accepted.guidance}</p>
          <Button className="mt-3" variant="secondary" disabled={loading} onClick={() => void act(accepted.id, "disable")}>Disable learned voice</Button>
        </div>
      )}
    </div>
  );
}
