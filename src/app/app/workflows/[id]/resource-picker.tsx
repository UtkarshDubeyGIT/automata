"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Field, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { pickerStatus, type ResourceChoice } from "@/lib/workflows/resource-options";
import { resourceValue, selectedResourceId, type ResourceBinding, type ResourceKind } from "@/lib/workflows/resources";

const LABELS: Record<ResourceKind, string> = {
  slack_channel: "Slack channel",
  google_calendar: "Calendar",
  ga4_property: "Google Analytics property",
  business_location: "Business location",
  search_console_site: "Search Console property",
  linear_team: "Linear team",
  linear_project: "Linear project",
  linkedin_organization: "LinkedIn page",
};

const APP: Record<ResourceKind, string> = {
  slack_channel: "slack",
  google_calendar: "googlecalendar",
  ga4_property: "google_analytics",
  business_location: "googlebusinessprofile",
  search_console_site: "google_search_console",
  linear_team: "linear",
  linear_project: "linear",
  linkedin_organization: "linkedin",
};

interface Page {
  choices: ResourceChoice[];
  nextCursor: string | null;
  error?: string;
}

interface Props {
  binding: ResourceBinding;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  parent?: string;
  required?: boolean;
  workflowChoices?: Array<{ value: string; label: string }>;
}

export function ResourcePicker({ binding, label, value, onChange, parent = "", required, workflowChoices = [] }: Props) {
  const id = useId();
  const [choices, setChoices] = useState<ResourceChoice[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [disconnected, setDisconnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const params = new URLSearchParams({ kind: binding.kind });
    if (parent) params.set("parent", parent);
    Promise.resolve().then(() => {
      if (!alive) return null;
      setLoading(true);
      setError("");
      setDisconnected(false);
      setChoices([]);
      setNextCursor(null);
      return fetch(`/api/integrations/resources?${params}`, { signal: controller.signal });
    })
      .then(async (response) => {
        if (!response) return null;
        const data = await response.json() as Page;
        if (!response.ok) {
          if (alive) setDisconnected(response.status === 409);
          throw new Error(data.error || "Could not load choices.");
        }
        return data;
      })
      .then((data) => {
        if (!alive || !data) return;
        setChoices(data.choices ?? []);
        setNextCursor(data.nextCursor ?? null);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : "Could not load choices.");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
    // A saved value changing must not trigger a provider refetch.
  }, [binding.kind, parent, retry]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ kind: binding.kind, cursor: nextCursor });
      if (parent) params.set("parent", parent);
      const response = await fetch(`/api/integrations/resources?${params}`);
      const data = await response.json() as Page;
      if (!response.ok) throw new Error(data.error || "Could not load more choices.");
      setChoices((current) => {
        const seen = new Set(current.map((choice) => choice.value));
        return [...current, ...(data.choices ?? []).filter((choice) => !seen.has(choice.value))];
      });
      setNextCursor(data.nextCursor ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load more choices.");
    } finally {
      setLoadingMore(false);
    }
  }

  const isReference = /^\{\{steps\./.test(value);
  const selected = isReference ? value : selectedResourceId(binding, value);
  const known = choices.some((choice) => choice.value === selected) ||
    workflowChoices.some((choice) => choice.value === selected) ||
    (binding.kind === "google_calendar" && selected === "primary");
  const status = pickerStatus({ loading, error, disconnected, choices, selected, nextCursor,
    extraChoices: [...workflowChoices, ...(binding.kind === "google_calendar" ? [{ value: "primary" }] : [])] });
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term
      ? choices.filter((choice) => `${choice.label} ${choice.secondary ?? ""} ${choice.value}`.toLowerCase().includes(term))
      : choices;
  }, [choices, query]);
  const title = label ?? LABELS[binding.kind];

  return (
    <Field label={<span>{title}{required ? <span className="ml-1 text-[11px] font-normal text-ink-subtle">required</span> : null}</span>}
      htmlFor={id} error={error || undefined}>
      {choices.length > 12 && (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={`Filter ${title.toLowerCase()} choices`}
          placeholder={`Filter ${title.toLowerCase()}…`}
          className="mb-2 h-9 w-full rounded-control border border-line bg-card px-3 text-[13px] text-ink"
        />
      )}
      <Select id={id} value={selected} disabled={loading || (!!error && choices.length === 0)}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next.startsWith("{{steps.") ? next : resourceValue(binding, next));
        }}>
        <option value="">{loading ? `Loading ${title.toLowerCase()}…` : `Choose ${title.toLowerCase()}…`}</option>
        {binding.kind === "google_calendar" && <option value="primary">Primary calendar</option>}
        {selected && !known && <option value={selected}>{nextCursor || loading ? `Saved choice: ${value}` : `Saved choice unavailable: ${value}`}</option>}
        {selected && known && !visible.some((choice) => choice.value === selected) && choices.some((choice) => choice.value === selected) && (
          <option value={selected}>{choices.find((choice) => choice.value === selected)?.label}</option>
        )}
        {visible.map((choice) => <option key={choice.value} value={choice.value}>
          {choice.label}{choice.secondary ? ` · ${choice.secondary}` : ""}
        </option>)}
        {workflowChoices.length > 0 && <optgroup label="From earlier step">
          {workflowChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </optgroup>}
      </Select>
      {nextCursor && <Button type="button" size="sm" variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
        {loadingMore ? "Loading…" : "Load more choices"}
      </Button>}
      {error && <div className="flex items-center gap-3 text-[12px]">
        <button type="button" onClick={() => setRetry((count) => count + 1)} className="font-medium text-brand hover:underline">Retry</button>
        {disconnected && <a href={`/app/integrations?q=${APP[binding.kind]}`} className="font-medium text-brand hover:underline">{error.includes("Multiple") ? "Manage connections" : "Connect integration"}</a>}
      </div>}
      {status === "empty" && <p className="text-[12px] text-ink-subtle">No available choices in this connected account.</p>}
      {status === "stale" && <p className="text-[12px] text-warning">The saved choice is no longer in the available list. Choose another or retry.</p>}
    </Field>
  );
}
