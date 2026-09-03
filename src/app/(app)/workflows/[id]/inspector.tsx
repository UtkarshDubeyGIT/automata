"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PLATFORMS, toolkitLogo } from "@/lib/social/platforms";
import {
  HOUR_CHOICES,
  MAX_EVERY_DAYS,
  MAX_EVERY_HOURS,
  nextSlots,
  nodeSpec,
  safeTimeZone,
  scheduleLabel,
  scheduleSpec,
  stepApp,
  webhookSecret,
  WEEKDAY_NAMES,
  WEEKDAY_ORDER,
  type FieldSpec,
} from "@/lib/workflows/blocks";
import { availableRefs, slotLabel } from "@/lib/workflows/edit";
import { edgeSlots, getEdge, orderedStepIds } from "@/lib/workflows/graph";
import {
  webhookEndpointState,
  webhookRotationNeedsConfirmation,
  webhookSampleForSecret,
} from "@/lib/workflows/webhook-fields";
import { TOOLS, TRIGGERS, appLabel, getTool } from "@/lib/workflows/registry";
import type { EdgeRef } from "@/lib/workflows/graph";
import type { StepDef, WorkflowGraph } from "@/lib/workflows/types";
import { StepTile } from "./canvas";

/**
 * Step inspector — the right-hand panel of the visual builder.
 *
 * It is fully generated from the block catalog's `fields`, so a new node type
 * becomes editable the moment it is added to src/lib/workflows/blocks.ts.
 * Templated fields get a data picker listing exactly what upstream steps
 * produce, which is what keeps hand-edited references valid.
 */

export interface InspectorProps {
  graph: WorkflowGraph;
  stepId: string;
  gaps: string[];
  workflowId: string;
  active: boolean;
  publishedSecret: string;
  onPatch: (patch: Record<string, unknown>) => void;
  onChangeTrigger: () => void;
  onUseWebhook: () => void;
  onRewire: (edge: EdgeRef, target: string | null) => void;
  onAddCase: (value: string) => void;
  onRemoveCase: (value: string) => void;
  onRenameCase: (from: string, to: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function Inspector(props: InspectorProps) {
  const { graph, stepId, gaps } = props;
  const step = graph.steps[stepId];
  const spec = step ? nodeSpec(step.type) : undefined;

  if (!step || !spec) return null;

  const app = stepApp(step);
  const isGithub = app === "github";
  const isSlack = step.type === "social_post" && String(step.platform) === "slack";

  return (
    <aside className="flex h-full min-h-0 w-full flex-none flex-col overflow-hidden rounded-card border border-line bg-card shadow-xs">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <StepTile step={step} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink">
            {isSlack ? "Slack Direct Message" : spec.label}
          </div>
          <div className="truncate font-mono text-[11px] text-ink-subtle">{stepId}</div>
        </div>
        <button
          onClick={props.onClose}
          aria-label="Close"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] text-ink-muted transition-colors hover:bg-inset hover:text-ink"
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {gaps.length > 0 && (
          <div className="rounded-card border border-warning-border bg-warning-surface px-3 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-warning">
              <Icon name="info" size={13} />
              Before this can run
            </div>
            <ul className="ml-4 list-disc text-[12.5px] leading-relaxed text-ink-muted">
              {gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}

        {spec.trigger && (
          <div className="rounded-card border border-brand-border bg-brand-subtle px-3 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <Icon name="zap" size={16} className="flex-none text-brand sm:mt-1" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-ink">This starts your automation</div>
                <p className="mt-1 text-[12px] leading-snug text-ink-subtle">
                  {step.type === "webhook_trigger"
                    ? "Your app sends a POST request to the webhook URL below."
                    : "Choose how this automation should begin."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {step.type !== "webhook_trigger" && (
                  <Button type="button" size="sm" icon="webhook" onClick={props.onUseWebhook}>
                    Use webhook instead
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  icon="refresh"
                  onClick={props.onChangeTrigger}
                >
                  Change trigger
                </Button>
              </div>
            </div>
          </div>
        )}

        {isSlack ? (
          <SlackStepFields graph={graph} stepId={stepId} step={step} onPatch={props.onPatch} />
        ) : (
          spec.fields
            .filter((f) => visible(f, step as Record<string, unknown>))
            .flatMap((f) => {
              // One repository control, not three. On a GitHub trigger the
              // dropdown IS the owner+repo pair, so those two text fields are
              // replaced outright; on a GitHub action it owns the same two keys
              // inside the arguments grid when the tool accepts owner/repo.
              if (isGithub && (f.key === "watch_owner" || f.key === "watch_repo")) {
                return f.key === "watch_owner"
                  ? [<GithubRepoField key="github-repo" step={step} onPatch={props.onPatch} />]
                  : [];
              }
              const toolSpec = step.type === "app_action" ? getTool(String(step.tool ?? "")) : undefined;
              const hasRepoArgs = isGithub && (
                step.type === "app_event_trigger" ||
                (toolSpec ? (toolSpec.required.includes("owner") || toolSpec.required.includes("repo") || toolSpec.argHint.includes('"owner"') || toolSpec.argHint.includes('"repo"')) : false)
              );
              const googleSheetKeys = toolSpec?.app === "googlesheets"
                ? googleSheetDestinationKeys(toolSpec.argHint)
                : [];
              const pickers = f.key === "arguments"
                ? [
                    hasRepoArgs ? (
                      <GithubRepoField key="github-repo" step={step} onPatch={props.onPatch} />
                    ) : null,
                    googleSheetKeys.length > 0 ? (
                      <GoogleSheetsDestinationField
                        key="google-sheets-destination"
                        step={step}
                        keys={googleSheetKeys}
                        onPatch={props.onPatch}
                      />
                    ) : null,
                  ].filter(Boolean)
                : [];
              const hiddenKeys = [
                ...(hasRepoArgs ? GITHUB_REPO_ARGS : []),
                ...googleSheetKeys,
              ];
              const field =
                f.kind === "cases" ? (
                  <CasesField key={f.key} {...props} />
                ) : f.kind === "schedule" ? (
                  <ScheduleField key={f.key} step={step} onPatch={props.onPatch} />
                ) : step.type === "app_action" && f.key === "arguments" ? (
                  <ActionArgumentsField
                    key={f.key}
                    graph={graph}
                    stepId={stepId}
                    step={step}
                    hiddenKeys={hiddenKeys}
                    onChange={(arguments_) => props.onPatch({ arguments: arguments_ })}
                  />
                ) : (
                  <StepField
                    key={f.key}
                    field={f}
                    graph={graph}
                    stepId={stepId}
                    value={(step as Record<string, unknown>)[f.key]}
                    hiddenKeys={hiddenKeys.length > 0 ? hiddenKeys : undefined}
                    onChange={(v) => {
                      if (step.type === "app_action" && f.key === "tool") {
                        const nextTool = getTool(String(v));
                        props.onPatch({ tool: v, ...(nextTool ? { title: toolHeadline(nextTool.desc) } : {}) });
                        return;
                      }
                      props.onPatch({ [f.key]: v });
                    }}
                  />
                );
              return [...pickers, field];
            })
        )}

        {step.type === "webhook_trigger" && (
          <WebhookPanel
            workflowId={props.workflowId}
            secret={String(step.secret ?? "")}
            active={props.active}
            publishedSecret={props.publishedSecret}
            sampleFields={Array.isArray(step.sample_fields) ? step.sample_fields as string[] : []}
            onGenerate={(secret) => props.onPatch({ secret, sample_fields: [] })}
            onSample={(fields) => props.onPatch({ sample_fields: fields })}
          />
        )}

        {/* The AI compiler often hangs the paths straight off the ai_step that
            produced the value instead of adding a separate branch node. Those
            paths must be just as editable, so surface the same controls here. */}
        {step.cases && step.type !== "branch" && (
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <Field
              label="Branch on"
              hint="A key from this step's JSON result. Each value below takes its own path."
            >
              <Input
                value={String(step.branch_on ?? "")}
                placeholder="category"
                onChange={(e) => props.onPatch({ branch_on: e.target.value })}
                className="text-[13.5px]"
              />
            </Field>
            <CasesField {...props} />
          </div>
        )}

        <Routing {...props} />

      </div>

      {graph.start !== stepId && (
        <div className="border-t border-line px-4 py-3">
          <Button variant="ghost" size="sm" icon="trash" onClick={props.onDelete}>
            Delete this step
          </Button>
        </div>
      )}
    </aside>
  );
}

function visible(field: FieldSpec, step: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const value = String(step[field.showIf.key] ?? "");
  const { equals } = field.showIf;
  // A list is how a field says "any of these", which is what the trigger
  // cadence needs: shown for the trigger slugs that can only be polled, hidden
  // for every one that can push. A blank value matches neither, so a field
  // gated this way stays hidden until the sibling is actually chosen.
  return Array.isArray(equals) ? equals.includes(value) : value === equals;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function StepField({
  field,
  graph,
  stepId,
  value,
  hiddenKeys,
  onChange,
}: {
  field: FieldSpec;
  graph: WorkflowGraph;
  stepId: string;
  value: unknown;
  /** keyvalue only: entries another control already owns, so they aren't editable twice. */
  hiddenKeys?: readonly string[];
  onChange: (value: unknown) => void;
}) {
  // Every control gets a real id so its <label> actually labels it — the
  // inspector is otherwise a wall of unnamed inputs to a screen reader.
  const fieldId = useId();
  const label = (
    <span className="flex items-center gap-1.5">
      {field.label}
      {field.required && <span className="text-[11px] font-normal text-ink-subtle">required</span>}
    </span>
  );

  switch (field.kind) {
    case "textarea":
      return (
        <Field label={label} hint={field.hint} htmlFor={fieldId}>
          <TemplateInput
            multiline
            id={fieldId}
            graph={graph}
            stepId={stepId}
            templated={field.templated}
            value={String(value ?? "")}
            placeholder={field.placeholder}
            onChange={onChange}
          />
        </Field>
      );

    case "text":
      return (
        <Field label={label} hint={field.hint} htmlFor={fieldId}>
          <TemplateInput
            id={fieldId}
            graph={graph}
            stepId={stepId}
            templated={field.templated}
            value={String(value ?? "")}
            placeholder={field.placeholder}
            onChange={onChange}
          />
        </Field>
      );

    case "number":
      return (
        <Field label={label} hint={field.hint} htmlFor={fieldId}>
          <Input
            id={fieldId}
            type="number"
            value={value === undefined || value === null ? "" : String(value)}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </Field>
      );

    case "select": {
      const current = String(value ?? "");
      if (field.source === "tools") {
        return (
          <ToolPickerField
            field={field}
            value={current}
            onChange={(next) => onChange(next)}
          />
        );
      }
      const choices = resolveChoices(field, graph, stepId);
      const selected = choices.find((c) => c.value === current);
      return (
        <Field label={label} hint={selected?.hint ?? field.hint} htmlFor={fieldId}>
          <Select id={fieldId} value={current} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    }

    case "list":
      return (
        <Field label={label} hint={field.hint} htmlFor={fieldId}>
          <ListEditor
            id={fieldId}
            values={Array.isArray(value) ? (value as string[]) : []}
            placeholder={field.placeholder}
            onChange={onChange}
          />
        </Field>
      );

    case "keyvalue":
      return (
        <Field label={label} hint={field.hint}>
          <KeyValueEditor
            graph={graph}
            stepId={stepId}
            templated={field.templated}
            hiddenKeys={hiddenKeys}
            keyLabel={field.keyLabel ?? "key"}
            valueLabel={field.valueLabel ?? "value"}
            value={(value as Record<string, unknown>) ?? {}}
            onChange={onChange}
          />
        </Field>
      );

    default:
      return null;
  }
}

type ToolFilter = "all" | "read" | "write" | `app:${string}`;

const MAX_ACTION_RESULTS = 72;

/**
 * The action catalog used to be a native select. That works for a handful of
 * choices, but becomes an unreadable wall once the connected app catalog grows
 * into the hundreds. Keep the field compact and move discovery into a dialog
 * with search, intent filters, and app filters.
 */
function ToolPickerField({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  const selected = value ? TOOLS[value] : undefined;

  const apps = useMemo(
    () =>
      [...new Set(Object.values(TOOLS).map((tool) => tool.app))].sort((a, b) =>
        appLabel(a).localeCompare(appLabel(b)),
      ),
    [],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = Object.entries(TOOLS).filter(([slug, tool]) => {
      if (filter === "read" && tool.kind !== "read") return false;
      if (filter === "write" && tool.kind !== "write") return false;
      if (filter.startsWith("app:") && tool.app !== filter.slice(4)) return false;
      if (!q) return true;
      return `${slug} ${appLabel(tool.app)} ${tool.desc}`.toLowerCase().includes(q);
    });

    // Keep the initial dialog quick to scan while search still exposes the
    // complete catalog. The selected action stays visible when filtering.
    matching.sort(([a], [b]) => Number(b === value) - Number(a === value));
    return matching.slice(0, MAX_ACTION_RESULTS);
  }, [filter, query, value]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function showPicker() {
    setQuery("");
    setFilter("all");
    setOpen(true);
  }

  function pick(slug: string) {
    onChange(slug);
    setOpen(false);
  }

  return (
    <>
      <Field htmlFor={fieldId} label={
        <span className="flex items-center gap-1.5">
          {field.label}
          {field.required && <span className="text-[11px] font-normal text-ink-subtle">required</span>}
        </span>
      } hint={selected ? `${appLabel(selected.app)} · ${selected.kind === "read" ? "reads data" : "performs an action"}` : field.hint}>
        <button
          id={fieldId}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={showPicker}
          className={cn(
            "flex h-11 w-full items-center gap-3 rounded-control border border-line bg-card px-3.5 text-left",
            "transition-[border-color,box-shadow] duration-150 hover:border-line-strong",
            "focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[color:rgba(74,69,209,0.32)]",
          )}
        >
          {selected ? <ToolLogo app={selected.app} size={24} /> : <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-inset text-ink-subtle"><Icon name="plug" size={14} /></span>}
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", selected ? "text-ink" : "text-ink-disabled")}>
            {selected ? `${appLabel(selected.app)} — ${toolHeadline(selected.desc)}` : "Choose an app action…"}
          </span>
          <Icon name="chevron-down" size={16} className="flex-none text-ink-subtle" />
        </button>
      </Field>

      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-[color:rgba(13,14,21,0.52)] p-3 backdrop-blur-[2px] sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="action-picker-title"
            aria-describedby="action-picker-description"
            className="flex max-h-[min(820px,calc(100vh-24px))] w-full max-w-[920px] flex-col overflow-hidden rounded-modal border border-line bg-card shadow-xl sm:max-h-[min(820px,calc(100vh-48px))]"
          >
            <div className="flex items-start gap-3 border-b border-line px-4 py-4 sm:gap-4 sm:px-6 sm:py-5">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-[12px] bg-brand-subtle text-brand">
                <Icon name="plug" size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="action-picker-title" className="font-display text-[20px] font-semibold tracking-[-0.02em] text-ink">
                  Choose an app action
                </h2>
                <p id="action-picker-description" className="mt-1 text-[13.5px] text-ink-subtle">
                  Search by app or what you want to do. You can configure the arguments after adding it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close action picker"
                className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] text-ink-muted transition-colors hover:bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              >
                <Icon name="x" size={18} />
              </button>
            </div>

            <div className="border-b border-line px-4 py-3.5 sm:px-6">
              <div className="relative">
                <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search actions — send, create, read, Slack…"
                  aria-label="Search app actions"
                  className="h-12 w-full rounded-control border border-brand bg-card pl-10 pr-4 text-[14px] text-ink outline-none ring-[3px] ring-[color:rgba(74,69,209,0.2)] placeholder:text-ink-disabled"
                />
              </div>
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Filter actions">
                <ActionFilterChip active={filter === "all"} onClick={() => setFilter("all")}>All actions</ActionFilterChip>
                <ActionFilterChip active={filter === "read"} onClick={() => setFilter("read")}>Read data</ActionFilterChip>
                <ActionFilterChip active={filter === "write"} onClick={() => setFilter("write")}>Take action</ActionFilterChip>
                <span className="mx-1 h-7 w-px flex-none bg-line" aria-hidden="true" />
                {apps.map((app) => (
                  <ActionFilterChip key={app} active={filter === `app:${app}`} onClick={() => setFilter(`app:${app}`)}>
                    {appLabel(app)}
                  </ActionFilterChip>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3.5 sm:px-6">
              <p className="text-[12px] font-medium text-ink-subtle">
                {query || filter !== "all" ? `${results.length}${results.length === MAX_ACTION_RESULTS ? "+" : ""} matching actions` : `${Object.keys(TOOLS).length} actions available`}
              </p>
              {selected && <p className="truncate text-[12px] text-brand">Current: {toolHeadline(selected.desc)}</p>}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
              {results.length === 0 ? (
                <div className="rounded-card border border-dashed border-line-strong px-5 py-12 text-center">
                  <Icon name="search" size={24} className="mx-auto text-ink-disabled" />
                  <p className="mt-3 text-[14px] font-medium text-ink">No actions found</p>
                  <p className="mt-1 text-[12.5px] text-ink-subtle">Try a different app, verb, or search term.</p>
                </div>
              ) : (
                <div className="grid gap-2 lg:grid-cols-2">
                  {results.map(([slug, tool]) => (
                    <button
                      key={slug}
                      type="button"
                      onClick={() => pick(slug)}
                      className={cn(
                        "group flex min-h-[72px] min-w-0 items-start gap-3 rounded-card border bg-card p-3 text-left transition-[border-color,background-color,box-shadow]",
                        slug === value ? "border-brand bg-brand-subtle ring-1 ring-brand-border" : "border-line hover:border-line-strong hover:bg-sunken",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand",
                      )}
                    >
                      <ToolLogo app={tool.app} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-semibold leading-snug text-ink">{toolHeadline(tool.desc)}</span>
                        <span className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-subtle">
                          <span className="truncate">{appLabel(tool.app)}</span>
                          <span aria-hidden="true">·</span>
                          <span className={cn("font-semibold", tool.kind === "read" ? "text-warning" : "text-success")}>
                            {tool.kind === "read" ? "Reads data" : "Takes action"}
                          </span>
                        </span>
                      </span>
                      {slug === value && <Icon name="check" size={16} className="mt-0.5 flex-none text-brand" />}
                    </button>
                  ))}
                </div>
              )}
              {results.length === MAX_ACTION_RESULTS && (
                <p className="mt-3 text-center text-[11.5px] text-ink-subtle">Refine your search to see more actions.</p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function ActionFilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 flex-none items-center rounded-full px-3 text-[12px] font-medium transition-colors",
        active ? "bg-brand text-white" : "bg-inset text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ToolLogo({ app, size }: { app: string; size: number }) {
  const [broken, setBroken] = useState(false);
  return !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={toolkitLogo(app)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      className="flex-none rounded-[9px] border border-line bg-card object-contain p-1"
      style={{ width: size, height: size }}
    />
  ) : (
    <span className="flex flex-none items-center justify-center rounded-[9px] bg-inset text-ink-subtle" style={{ width: size, height: size }}>
      <Icon name="plug" size={Math.max(14, Math.round(size * 0.55))} />
    </span>
  );
}

function toolHeadline(desc: string): string {
  const first = desc.split(/\.\s|\sNOTE:/)[0].trim();
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

function resolveChoices(
  field: FieldSpec,
  graph: WorkflowGraph,
  stepId: string,
): { value: string; label: string; hint?: string }[] {
  if (field.choices) return field.choices;
  switch (field.source) {
    case "triggers":
      return Object.entries(TRIGGERS).map(([slug, t]) => ({
        value: slug,
        label: `${appLabel(t.app)} — ${t.desc}`,
        hint: `Event fields: ${Object.keys(t.event).join(", ")}`,
      }));
    case "tools":
      return Object.entries(TOOLS).map(([slug, t]) => ({
        value: slug,
        label: `${appLabel(t.app)} — ${t.desc}`,
        hint: `Arguments: ${t.argHint}`,
      }));
    case "platforms":
      return PLATFORMS.filter((p) => p.id !== "youtube" && p.id !== "tiktok").map((p) => ({
        value: p.id,
        label: p.name,
        hint: p.description,
      }));
    case "steps":
      // Only upstream steps can be a data source — matching what validation allows.
      return availableRefs(graph, stepId).map((g) => ({ value: g.stepId, label: g.title }));
    default:
      return [];
  }
}

/**
 * The two argument keys the repo dropdown fills on a GitHub `app_action`, so
 * the arguments grid below it can leave them out.
 */
const GITHUB_REPO_ARGS = ["owner", "repo"] as const;

type GoogleSheetDestinationKey = "spreadsheet_id" | "sheet_name" | "ranges";

function googleSheetDestinationKeys(argHint: string): GoogleSheetDestinationKey[] {
  try {
    const hint = JSON.parse(argHint) as Record<string, unknown>;
    if (!("spreadsheet_id" in hint)) return [];
    return [
      "spreadsheet_id",
      ...(typeof hint.sheet_name === "string" ? (["sheet_name"] as const) : []),
      ...(Array.isArray(hint.ranges) ? (["ranges"] as const) : []),
    ];
  } catch {
    return [];
  }
}

interface GithubRepoOption {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
}

/**
 * The repository control for a GitHub trigger or action: one searchable
 * dropdown over the workspace's connected account, and nothing else.
 *
 * It stands IN PLACE of the owner + repo text fields, not above them — those
 * were two boxes that had to agree with each other and with a real repo, and
 * the button that filled them was a third thing to find. Picking
 * "vercel/next.js" is the whole interaction. There is deliberately no
 * type-it-yourself fallback: a hand-typed owner/repo is exactly the thing that
 * silently doesn't match anything the connected account can actually see.
 *
 * Renders nothing for any other app, so it's cheap to anchor unconditionally.
 */
// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Local YYYY-MM-DD, which is what an interval's start date is written as. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "in 20 hours" — the line an alarm gives you the moment you set one. */
function untilPhrase(when: Date, from: Date): string {
  const mins = Math.max(0, Math.round((when.getTime() - from.getTime()) / 60_000));
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in ${Math.round(hours / 24)} days`;
}

function formatRun(when: Date, timeZone: string): string {
  return when.toLocaleString(undefined, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The whole schedule as one control, laid out like a phone alarm: the time
 * first and large, the days as circles you tap, and one line saying when it
 * next runs.
 *
 * It is a bespoke control rather than five generic fields for the same reason
 * `cases` is: a schedule is one idea to a person but five keys on the step, and
 * a row of inputs lets you pick a weekday for an hourly schedule — a setting
 * that does nothing, sitting next to one that does.
 *
 * Two shapes, one switch between them: days of the week, or an interval. Every
 * day is written as the interval `daily/1` rather than seven ticked days, so
 * "every day" has exactly one representation in a saved graph; the circles
 * still show all seven, because that is what it means.
 */
function ScheduleField({
  step,
  onPatch,
}: {
  step: StepDef;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [zone, setZone] = useState<string | null>(null);
  const hourId = useId();
  const startId = useId();
  const spec = scheduleSpec(step);

  // Schedules fire in the WORKSPACE's zone (see the sweep), not the browser's.
  // Previewing in the wrong one would promise times that never happen, so the
  // dates wait for the real answer rather than guessing locally.
  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: { timezone?: string }) => alive && setZone(safeTimeZone(d.timezone)))
      .catch(() => alive && setZone("UTC"));
    return () => {
      alive = false;
    };
  }, []);

  const onDays = spec.unit === "week" || (spec.unit === "day" && spec.every === 1);
  const selected = spec.unit === "week" ? spec.weekdays : WEEKDAY_ORDER;

  const runs = useMemo(
    () => (zone ? nextSlots(step, new Date(), 5, zone) : []),
    [step, zone],
  );

  /**
   * Every write names every schedule key, setting the ones that do not apply to
   * undefined so `updateStep` deletes them. A leftover `weekdays` under a daily
   * cadence is exactly the silent mis-fire this feature exists to end.
   */
  function writeDays(days: number[]) {
    onPatch(
      days.length === 7
        ? { cadence: "daily", every: 1, weekdays: undefined, weekday: undefined, start: undefined }
        : {
            cadence: "weekly",
            weekdays: [...days].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b)),
            every: undefined,
            weekday: undefined,
            start: undefined,
          },
    );
  }

  function writeInterval(every: number, unit: "day" | "hour") {
    onPatch(
      unit === "hour"
        ? { cadence: "hourly", every, weekdays: undefined, weekday: undefined, start: undefined }
        : {
            cadence: "daily",
            every,
            start: spec.start ?? todayIso(),
            weekdays: undefined,
            weekday: undefined,
          },
    );
  }

  function toggleDay(day: number) {
    const next = new Set(selected);
    // One day has to stay chosen: zero days is a schedule that never runs.
    if (next.has(day)) {
      if (next.size === 1) return;
      next.delete(day);
    } else next.add(day);
    writeDays([...next]);
  }

  const intervalUnit = spec.unit === "hour" ? "hour" : "day";
  const min = intervalUnit === "hour" ? 1 : 2;
  const max = intervalUnit === "hour" ? MAX_EVERY_HOURS : MAX_EVERY_DAYS;
  const [clock, meridiem] = (HOUR_CHOICES[spec.hour]?.label ?? "9:00 AM").split(" ");

  return (
    <div role="group" aria-label="Repeats" className="flex flex-col gap-5">
      {spec.unit !== "hour" && (
        <div className="relative pt-1 text-center">
          <div className="font-display text-[42px] font-semibold leading-none tracking-[-0.035em] text-ink">
            {clock}
            <span className="ml-2 text-[18px] font-medium text-ink-subtle">{meridiem}</span>
          </div>
          <label htmlFor={hourId} className="sr-only">
            Time of day
          </label>
          <select
            id={hourId}
            value={spec.hour}
            onChange={(e) => onPatch({ hour: Number(e.target.value) })}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            {HOUR_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {onDays ? (
        <div className="flex justify-between gap-1.5">
          {WEEKDAY_ORDER.map((day) => {
            const on = selected.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={WEEKDAY_NAMES[day]}
                onClick={() => toggleDay(day)}
                className={cn(
                  // flex-none, not flex-1: a stretched day is an oval, and the
                  // whole point of the row is that it reads as seven circles.
                  "flex h-9 w-9 flex-none items-center justify-center rounded-full border text-[12.5px] font-semibold transition-colors",
                  on
                    ? "border-brand bg-brand text-white"
                    : "border-line bg-card text-ink-muted hover:border-line-strong hover:bg-sunken",
                )}
              >
                {WEEKDAY_NAMES[day].charAt(0)}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              aria-label="Less often"
              disabled={spec.every <= min}
              onClick={() => writeInterval(Math.max(min, spec.every - 1), intervalUnit)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-[18px] leading-none text-ink transition-colors hover:bg-sunken disabled:opacity-35"
            >
              &minus;
            </button>
            <span className="min-w-12 text-center font-display text-[26px] font-semibold tabular-nums text-ink">
              {spec.every}
            </span>
            <button
              type="button"
              aria-label="More often"
              disabled={spec.every >= max}
              onClick={() => writeInterval(Math.min(max, spec.every + 1), intervalUnit)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-[18px] leading-none text-ink transition-colors hover:bg-sunken disabled:opacity-35"
            >
              +
            </button>
            {/* The unit word is the days/hours switch — no extra control for it. */}
            <button
              type="button"
              onClick={() =>
                intervalUnit === "day"
                  ? writeInterval(Math.min(spec.every, MAX_EVERY_HOURS), "hour")
                  : writeInterval(Math.max(spec.every, 2), "day")
              }
              className="border-b border-dashed border-line-strong pb-0.5 text-[13.5px] text-ink-subtle transition-colors hover:border-brand hover:text-brand"
            >
              {intervalUnit === "hour" ? "hours" : "days"}
            </button>
          </div>

          {intervalUnit === "day" && (
            <div className="flex items-center justify-center gap-2 text-[12px] text-ink-subtle">
              <label htmlFor={startId}>starting</label>
              <input
                id={startId}
                type="date"
                value={spec.start ?? todayIso()}
                onChange={(e) => onPatch({ start: e.target.value || todayIso() })}
                className="rounded-sm border border-line bg-card px-2 py-1 text-[12px] text-ink"
              />
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => (onDays ? writeInterval(2, "day") : writeDays([...WEEKDAY_ORDER]))}
        className="mx-auto text-[12.5px] font-semibold text-brand hover:underline"
      >
        {onDays ? "Every few days ›" : "‹ Days of the week"}
      </button>

      <details className="-mx-4 border-t border-line bg-sunken px-4 pb-3 pt-3 text-center">
        <summary className="cursor-pointer list-none text-[12.5px] text-ink-muted marker:content-none">
          <span className="block text-[14px] font-semibold text-ink">{scheduleLabel(step)}</span>
          {runs.length > 0 && (
            <span className="mt-0.5 inline-block">next {untilPhrase(runs[0], new Date())}</span>
          )}
        </summary>
        {zone && (
          <ul className="mt-3 flex flex-col gap-1.5 text-left text-[12.5px] text-ink-muted">
            {runs.map((run) => (
              <li key={run.toISOString()}>{formatRun(run, zone)}</li>
            ))}
            <li className="pt-1 text-[11.5px] text-ink-subtle">Times shown in {zone}</li>
          </ul>
        )}
      </details>
    </div>
  );
}

interface SlackUserOption {
  id: string;
  name: string;
  realName?: string;
  isBot?: boolean;
}

interface SlackChannelOption {
  id: string;
  name: string;
  private?: boolean;
}

function SlackChannelField({ step, onPatch }: { step: StepDef; onPatch: (patch: Record<string, unknown>) => void }) {
  const [channels, setChannels] = useState<SlackChannelOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const options = (step.options as Record<string, unknown>) ?? {};
  const selected = String(options.channel ?? "");

  useEffect(() => {
    let alive = true;
    fetch("/api/integrations/slack/channels")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return res.json() as Promise<{ channels?: SlackChannelOption[] }>;
      })
      .then((data) => alive && setChannels(data.channels ?? []))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  return (
    <Field label={<span>Channel <span className="text-[11px] font-normal text-ink-subtle">required</span></span>}
      hint="Private channels appear only when the Slack app has access."
      error={failed ? "Couldn't load Slack channels. Reconnect Slack and try again." : undefined}>
      <Select value={selected} onChange={(event) => {
        const next: Record<string, unknown> = { ...options, channel: event.target.value };
        delete next.dmUser;
        delete next.dm_user;
        onPatch({ options: next });
      }}>
        <option value="">{channels ? "Choose a channel…" : "Loading channels…"}</option>
        {(channels ?? []).map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.private ? "Private: " : "#"}{channel.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function SlackDmField({
  step,
  onPatch,
}: {
  step: StepDef;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [users, setUsers] = useState<SlackUserOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const fieldId = useId();

  const options = (step.options as Record<string, unknown>) ?? {};
  const selectedDmUser = String(options.dmUser ?? options.dm_user ?? "");

  const selectedUser = useMemo(() => {
    if (!users) return null;
    return users.find((u) => u.id === selectedDmUser);
  }, [users, selectedDmUser]);

  const selectedDisplay = selectedUser
    ? selectedUser.realName && selectedUser.realName !== selectedUser.name
      ? `${selectedUser.realName} (@${selectedUser.name})`
      : `@${selectedUser.name}`
    : selectedDmUser
      ? selectedDmUser
      : "";

  const matches = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    return q
      ? users.filter(
          (u) =>
            u.name.toLowerCase().includes(q) ||
            (u.realName && u.realName.toLowerCase().includes(q)) ||
            u.id.toLowerCase().includes(q),
        )
      : users;
  }, [users, query]);

  function write(userId: string) {
    const nextOptions: Record<string, unknown> = { ...options, dmUser: userId };
    delete nextOptions.channel;
    delete nextOptions.dm_user;
    onPatch({ options: nextOptions });
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setOpen(true);
    if (users || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch("/api/integrations/slack/users");
      const data = (await res.json()) as { users?: SlackUserOption[] };
      setUsers(data.users ?? []);
    } catch {
      setFailed(true);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  const label = (
    <span className="flex items-center gap-1.5">
      Send to (Slack DM)
      <span className="text-[11px] font-normal text-ink-subtle">required</span>
    </span>
  );

  return (
    <Field
      label={label}
      hint="Choose which Slack team member will receive this direct message."
      error={failed ? "Couldn't load Slack users — try again." : undefined}
    >
      <div className="relative">
        <button
          id={fieldId}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          className={cn(
            "flex h-10 w-full items-center gap-2 rounded-control border border-line bg-card px-3.5 text-left",
            "transition-[border-color,box-shadow] duration-150",
            "focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[color:rgba(74,69,209,0.32)]",
          )}
        >
          <span
            className={cn(
              "flex-1 truncate text-[13.5px]",
              selectedDisplay ? "font-medium text-ink" : "text-ink-disabled",
            )}
          >
            {selectedDisplay || "Choose a Slack team member…"}
          </span>
          <Icon
            name={loading ? "refresh" : open ? "chevron-up" : "chevron-down"}
            size={16}
            className={cn("flex-none text-ink-subtle", loading && "animate-spin")}
          />
        </button>

        {open && (
          <div className="absolute left-0 top-full z-20 mt-1.5 flex max-h-[300px] w-full min-w-[280px] flex-col rounded-card border border-line bg-card shadow-lg">
            {loading ? (
              <p className="px-3 py-3 text-[12.5px] text-ink-subtle">Loading team members…</p>
            ) : users && users.length > 0 ? (
              <>
                <div className="border-b border-line p-1.5">
                  <Input
                    autoFocus
                    leftIcon="search"
                    value={query}
                    placeholder="Filter team members…"
                    aria-label="Filter team members"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setOpen(false);
                      if (e.key === "Enter" && matches.length === 1) {
                        e.preventDefault();
                        write(matches[0].id);
                        setOpen(false);
                      }
                    }}
                    className="h-9 text-[13px]"
                  />
                </div>
                <div role="listbox" className="flex-1 overflow-y-auto p-1.5">
                  {matches.length === 0 ? (
                    <p className="px-2.5 py-3 text-[12.5px] text-ink-subtle">
                      No team member matches “{query.trim()}”.
                    </p>
                  ) : (
                    matches.map((u) => {
                      const isSelected = u.id === selectedDmUser;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => {
                            write(u.id);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-inset",
                            isSelected && "bg-inset",
                          )}
                        >
                          <div className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-surface text-[11px] font-semibold text-brand">
                            {u.name.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-ink">
                              {u.realName || u.name}
                            </div>
                            <div className="truncate font-mono text-[11px] text-ink-subtle">
                              @{u.name} · {u.id}
                            </div>
                          </div>
                          {isSelected && (
                            <Icon name="check" size={13} className="flex-none text-brand" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <p className="px-3 py-3 text-[12.5px] leading-relaxed text-ink-subtle">
                No Slack users found. Check that Slack is connected under{" "}
                <a href="/integrations?q=slack" className="text-brand underline">
                  Integrations
                </a>
                .
              </p>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}

function SlackStepFields({
  graph,
  stepId,
  step,
  onPatch,
}: {
  graph: WorkflowGraph;
  stepId: string;
  step: StepDef;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const titleId = useId();
  const stageId = useId();
  const instructionId = useId();

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Step name"
        hint="Shown on the card. Verb-led reads best — “Draft the reply”."
        htmlFor={titleId}
      >
        <Input
          id={titleId}
          value={String(step.title ?? "")}
          placeholder="Post the digest to Slack"
          onChange={(e) => onPatch({ title: e.target.value })}
          className="text-[13.5px]"
        />
      </Field>

      <Field
        label="Stage"
        hint="Consecutive steps sharing a stage are grouped in summaries."
        htmlFor={stageId}
      >
        <Select
          id={stageId}
          value={String(step.stage ?? "Publish")}
          onChange={(e) => onPatch({ stage: e.target.value })}
        >
          <option value="Draft">Draft</option>
          <option value="Process">Process</option>
          <option value="Approve">Approve</option>
          <option value="Publish">Publish</option>
          <option value="Notify">Notify</option>
          <option value="Finish">Finish</option>
        </Select>
      </Field>

      <SlackChannelField step={step} onPatch={onPatch} />

      <Field
        label={
          <span className="flex items-center gap-1.5">
            Message
            <span className="text-[11px] font-normal text-ink-subtle">required</span>
          </span>
        }
        hint="Write the Slack message and insert values captured by the incoming webhook."
        htmlFor={instructionId}
      >
        <TemplateInput
          multiline
          id={instructionId}
          graph={graph}
          stepId={stepId}
          templated
          value={String(step.text ?? step.instruction ?? "")}
          placeholder="{{trigger.data.meeting.title}}\n\n{{trigger.data.summary}}"
          onChange={(value) => onPatch({ text: value, instruction: undefined })}
        />
      </Field>
    </div>
  );
}

function GithubRepoField({
  step,
  onPatch,
}: {
  step: StepDef;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [repos, setRepos] = useState<GithubRepoOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const fieldId = useId();

  // The trigger keeps the target in watch_owner/watch_repo, the action in its
  // arguments object. Everything below reads and writes through this pair.
  const isTrigger = step.type === "app_event_trigger";
  const args = (step.arguments as Record<string, unknown>) ?? {};
  const owner = String((isTrigger ? step.watch_owner : args.owner) ?? "");
  const name = String((isTrigger ? step.watch_repo : args.repo) ?? "");
  const selected = owner && name ? `${owner}/${name}` : "";

  const matches = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  }, [repos, query]);

  const toolSpec = step.type === "app_action" ? getTool(String(step.tool ?? "")) : undefined;
  const hasRepo = isTrigger || (toolSpec ? (toolSpec.required.includes("owner") || toolSpec.required.includes("repo") || toolSpec.argHint.includes('"owner"') || toolSpec.argHint.includes('"repo"')) : false);

  if (stepApp(step) !== "github" || !hasRepo) return null;

  function write(nextOwner: string, nextName: string) {
    if (isTrigger) onPatch({ watch_owner: nextOwner, watch_repo: nextName });
    else onPatch({ arguments: { ...args, owner: nextOwner, repo: nextName } });
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setOpen(true);
    // Fetched on first open rather than on mount: most visits to this
    // inspector are to edit something else, and the route is a live call out
    // to the provider.
    if (repos || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch("/api/integrations/github/repos");
      const data = (await res.json()) as { repos?: GithubRepoOption[] };
      setRepos(data.repos ?? []);
    } catch {
      setFailed(true);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  const label = (
    <span className="flex items-center gap-1.5">
      Repository
      <span className="text-[11px] font-normal text-ink-subtle">required</span>
    </span>
  );

  return (
    <Field label={label} error={failed ? "Couldn't load repositories — try again." : undefined}>
      <div className="relative">
        <button
          id={fieldId}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          className={cn(
            "flex h-10 w-full items-center gap-2 rounded-control border border-line bg-card px-3.5 text-left",
            "transition-[border-color,box-shadow] duration-150",
            "focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[color:rgba(74,69,209,0.32)]",
          )}
        >
          <span
            className={cn(
              "flex-1 truncate font-mono text-[13.5px]",
              selected ? "text-ink" : "text-ink-disabled",
            )}
          >
            {selected || "Select a repository…"}
          </span>
          <Icon
            name={loading ? "refresh" : open ? "chevron-up" : "chevron-down"}
            size={16}
            className={cn("flex-none text-ink-subtle", loading && "animate-spin")}
          />
        </button>

        {open && (
          <div className="absolute left-0 top-full z-20 mt-1.5 flex max-h-[300px] w-full min-w-[280px] flex-col rounded-card border border-line bg-card shadow-lg">
            {loading ? (
              <p className="px-3 py-3 text-[12.5px] text-ink-subtle">Loading repositories…</p>
            ) : repos && repos.length > 0 ? (
              <>
                <div className="border-b border-line p-1.5">
                  <Input
                    autoFocus
                    leftIcon="search"
                    value={query}
                    placeholder="Filter repositories…"
                    aria-label="Filter repositories"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setOpen(false);
                      // Enter on a filter that leaves exactly one repo is the
                      // fast path: type "next", press Enter, done.
                      if (e.key === "Enter" && matches.length === 1) {
                        e.preventDefault();
                        write(matches[0].owner, matches[0].name);
                        setOpen(false);
                      }
                    }}
                    className="h-9 text-[13px]"
                  />
                </div>
                <div role="listbox" className="flex-1 overflow-y-auto p-1.5">
                  {matches.length === 0 ? (
                    <p className="px-2.5 py-3 text-[12.5px] text-ink-subtle">
                      No repository matches “{query.trim()}”.
                    </p>
                  ) : (
                    matches.map((r) => (
                      <button
                        key={r.fullName}
                        type="button"
                        role="option"
                        aria-selected={r.fullName === selected}
                        onClick={() => {
                          write(r.owner, r.name);
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-inset"
                      >
                        <span className="flex-1 truncate font-mono text-[12px] text-ink">
                          {r.fullName}
                        </span>
                        {r.private && (
                          <span className="flex-none text-[10.5px] text-ink-subtle">private</span>
                        )}
                        {r.fullName === selected && (
                          <Icon name="check" size={13} className="flex-none text-brand" />
                        )}
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <p className="px-3 py-3 text-[12.5px] leading-relaxed text-ink-subtle">
                No repositories came back. Check that GitHub is connected under{" "}
                <a href="/integrations?q=github" className="text-brand underline">
                  Integrations
                </a>
                .
              </p>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}

interface GoogleSpreadsheetOption {
  id: string;
  name: string;
}

interface GoogleSheetOption {
  id: string;
  title: string;
}

function rangeSheetName(value: unknown): string {
  const first = Array.isArray(value) ? String(value[0] ?? "") : "";
  return first.split("!")[0]?.replace(/^'|'$/g, "") ?? "";
}

function sheetRange(title: string): string {
  const safe = title.includes(" ") ? `'${title.replaceAll("'", "''")}'` : title;
  return `${safe}!A1:Z1000`;
}

/** One connected-account choice replaces spreadsheet_id + sheet_name/ranges. */
function GoogleSheetsDestinationField({
  step,
  keys,
  onPatch,
}: {
  step: StepDef;
  keys: GoogleSheetDestinationKey[];
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const args = (step.arguments as Record<string, unknown>) ?? {};
  const spreadsheetId = String(args.spreadsheet_id ?? "");
  const selectedSheet = keys.includes("sheet_name")
    ? String(args.sheet_name ?? "")
    : rangeSheetName(args.ranges);
  const needsSheet = keys.includes("sheet_name") || keys.includes("ranges");
  const [spreadsheets, setSpreadsheets] = useState<GoogleSpreadsheetOption[] | null>(null);
  const [sheetResult, setSheetResult] = useState<{ spreadsheetId: string; items: GoogleSheetOption[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const sheets = sheetResult?.spreadsheetId === spreadsheetId ? sheetResult.items : null;
  const loadingSpreadsheets = spreadsheets === null;
  const loadingSheets = !!spreadsheetId && needsSheet && sheets === null;

  useEffect(() => {
    let alive = true;
    fetch("/api/integrations/google-sheets")
      .then(async (response) => {
        if (!response.ok) throw new Error("spreadsheet list failed");
        return response.json() as Promise<{ spreadsheets?: GoogleSpreadsheetOption[] }>;
      })
      .then((data) => {
        if (alive) setSpreadsheets(data.spreadsheets ?? []);
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
          setSpreadsheets([]);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!spreadsheetId || !needsSheet) return;
    let alive = true;
    fetch(`/api/integrations/google-sheets?spreadsheetId=${encodeURIComponent(spreadsheetId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("sheet list failed");
        return response.json() as Promise<{ sheets?: GoogleSheetOption[] }>;
      })
      .then((data) => {
        if (alive) setSheetResult({ spreadsheetId, items: data.sheets ?? [] });
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
          setSheetResult({ spreadsheetId, items: [] });
        }
      });
    return () => {
      alive = false;
    };
  }, [needsSheet, spreadsheetId]);

  function write(next: Record<string, unknown>) {
    onPatch({ arguments: { ...args, ...next } });
  }

  function chooseSpreadsheet(id: string) {
    const clear: Record<string, unknown> = { spreadsheet_id: id };
    if (keys.includes("sheet_name")) clear.sheet_name = "";
    if (keys.includes("ranges")) clear.ranges = [];
    write(clear);
  }

  function chooseSheet(title: string) {
    if (keys.includes("sheet_name")) write({ sheet_name: title });
    else if (keys.includes("ranges")) write({ ranges: [sheetRange(title)] });
  }

  const hasSpreadsheetChoices = (spreadsheets?.length ?? 0) > 0;
  const hasSheetChoices = (sheets?.length ?? 0) > 0;

  return (
    <div className="rounded-card border border-line bg-sunken p-3.5">
      <div className="mb-3 flex items-center gap-2.5">
        <ToolLogo app="googlesheets" size={30} />
        <div>
          <div className="text-[13.5px] font-semibold text-ink">Where should this run?</div>
          <div className="text-[11.5px] text-ink-subtle">Choose from the connected Google Sheets account.</div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Field label="Spreadsheet" error={failed ? "Couldn't load Google Sheets. You can enter the ID below." : undefined}>
          {loadingSpreadsheets ? (
            <div className="flex h-10 items-center gap-2 rounded-control border border-line bg-card px-3.5 text-[13px] text-ink-subtle">
              <Icon name="refresh" size={14} className="animate-spin" /> Loading spreadsheets…
            </div>
          ) : hasSpreadsheetChoices ? (
            <Select value={spreadsheetId} onChange={(event) => chooseSpreadsheet(event.target.value)}>
              <option value="">Choose a spreadsheet…</option>
              {spreadsheetId && !spreadsheets?.some((item) => item.id === spreadsheetId) && (
                <option value={spreadsheetId}>Current spreadsheet</option>
              )}
              {spreadsheets?.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </Select>
          ) : (
            <Input
              value={spreadsheetId}
              placeholder="Paste the spreadsheet ID"
              onChange={(event) => chooseSpreadsheet(event.target.value)}
            />
          )}
        </Field>

        {needsSheet && spreadsheetId && (
          <Field label="Sheet">
            {loadingSheets ? (
              <div className="flex h-10 items-center gap-2 rounded-control border border-line bg-card px-3.5 text-[13px] text-ink-subtle">
                <Icon name="refresh" size={14} className="animate-spin" /> Loading sheets…
              </div>
            ) : hasSheetChoices ? (
              <Select value={selectedSheet} onChange={(event) => chooseSheet(event.target.value)}>
                <option value="">Choose a sheet…</option>
                {selectedSheet && !sheets?.some((item) => item.title === selectedSheet) && (
                  <option value={selectedSheet}>{selectedSheet}</option>
                )}
                {sheets?.map((item) => (
                  <option key={item.id} value={item.title}>{item.title}</option>
                ))}
              </Select>
            ) : (
              <Input
                value={selectedSheet}
                placeholder="Enter the sheet name"
                onChange={(event) => chooseSheet(event.target.value)}
              />
            )}
          </Field>
        )}
      </div>
    </div>
  );
}

/**
 * A text field that knows about {{steps.…}} references: the data picker
 * inserts one at the caret, so users never have to type a path by hand.
 */
function TemplateInput({
  id,
  graph,
  stepId,
  templated,
  value,
  placeholder,
  multiline,
  onChange,
}: {
  id?: string;
  graph: WorkflowGraph;
  stepId: string;
  templated?: boolean;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const groups = useMemo(
    () => (templated ? availableRefs(graph, stepId) : []),
    [graph, stepId, templated],
  );

  function insert(reference: string) {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, at)}${reference}${value.slice(at)}`;
    onChange(next);
    setPickerOpen(false);
    // Restore focus with the caret just after what we inserted.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      const pos = at + reference.length;
      node.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      {multiline ? (
        <Textarea
          id={id}
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[92px] text-[13.5px]"
        />
      ) : (
        <Input
          id={id}
          ref={ref as React.RefObject<HTMLInputElement>}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="text-[13.5px]"
        />
      )}

      {templated && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-inset px-2.5 py-1 text-[11.5px] font-medium text-ink-muted transition-colors hover:text-ink"
          >
            <Icon name="database" size={12} />
            Insert data
            <Icon name={pickerOpen ? "chevron-up" : "chevron-down"} size={12} />
          </button>

          {pickerOpen && (
            <div className="absolute left-0 top-full z-20 mt-1.5 max-h-[280px] w-full min-w-[280px] overflow-y-auto rounded-card border border-line bg-card p-1.5 shadow-lg">
              {groups.length === 0 ? (
                <p className="px-2.5 py-3 text-[12.5px] text-ink-subtle">
                  No earlier step produces data yet. Add a step above this one first.
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.stepId} className="mb-1.5 last:mb-0">
                    <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                      {group.title}
                    </div>
                    {group.paths.map((p) => (
                      <button
                        key={p.ref}
                        type="button"
                        onClick={() => insert(p.ref)}
                        className="flex w-full flex-col rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-inset"
                      >
                        <span className="font-mono text-[11.5px] text-ink">{p.ref}</span>
                        <span className="text-[11.5px] text-ink-subtle">{p.label}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ListEditor({
  id,
  values,
  placeholder,
  onChange,
}: {
  id?: string;
  values: string[];
  placeholder?: string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setDraft("");
  }
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full bg-inset px-2.5 py-1 text-[12px] text-ink"
            >
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="text-ink-subtle transition-colors hover:text-danger"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          placeholder={placeholder ?? "Add…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="text-[13.5px]"
        />
        <Button size="sm" variant="secondary" icon="plus" aria-label="Add" onClick={add} />
      </div>
    </div>
  );
}

interface DataChoice {
  ref: string;
  step: string;
  label: string;
}

function dataChoices(graph: WorkflowGraph, stepId: string): DataChoice[] {
  return availableRefs(graph, stepId).flatMap((group) =>
    group.paths.map((path) => ({ ref: path.ref, step: group.title, label: path.label })),
  );
}

function humanArgumentLabel(key: string): string {
  const words = key
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  const label = words.replace(/\bid\b/g, "ID").replace(/\burl\b/g, "URL");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function exactDataReference(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\{\{steps\.[^.]+\..+\}\}$/.test(text) ? text : "";
}

function argumentExamples(argHint: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argHint);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Required app inputs, expressed as choices rather than provider parameters. */
function ActionArgumentsField({
  graph,
  stepId,
  step,
  hiddenKeys,
  onChange,
}: {
  graph: WorkflowGraph;
  stepId: string;
  step: StepDef;
  hiddenKeys: readonly string[];
  onChange: (value: Record<string, unknown>) => void;
}) {
  const tool = getTool(String(step.tool ?? ""));
  const value = (step.arguments as Record<string, unknown>) ?? {};
  if (!tool) return null;
  const examples = argumentExamples(tool.argHint);
  const required = tool.required.filter((key) => !hiddenKeys.includes(key));
  if (required.length === 0) return null;
  const choices = dataChoices(graph, stepId);

  function setArgument(key: string, next: unknown) {
    onChange({ ...value, [key]: next });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[13px] font-semibold text-ink">What should this action use?</div>
        <div className="mt-0.5 text-[11.5px] text-ink-subtle">Choose existing workflow data whenever it is available.</div>
      </div>
      {required.map((key) =>
        tool.app === "googlesheets" && key === "values" ? (
          <SheetValuesField
            key={key}
            value={value[key]}
            choices={choices}
            onChange={(next) => setArgument(key, next)}
          />
        ) : (
          <ArgumentValueField
            key={key}
            argumentKey={key}
            value={value[key]}
            example={examples[key]}
            choices={choices}
            onChange={(next) => setArgument(key, next)}
          />
        ),
      )}
    </div>
  );
}

function ArgumentValueField({
  argumentKey,
  value,
  example,
  choices,
  onChange,
}: {
  argumentKey: string;
  value: unknown;
  example: unknown;
  choices: DataChoice[];
  onChange: (value: unknown) => void;
}) {
  const reference = exactDataReference(value);
  const isEmail = /(^|_)(email|recipient|to|cc|bcc)($|_)/i.test(argumentKey);
  const usefulChoices = isEmail
    ? choices.filter((choice) => /email|sender|recipient|(^|\W)from(\W|$)|(^|\W)to(\W|$)/i.test(`${choice.ref} ${choice.label}`))
    : choices;
  const [manual, setManual] = useState(!reference && value !== undefined && value !== null && String(value) !== "");
  const label = argumentKey === "recipient_email" ? "Recipient" : humanArgumentLabel(argumentKey);
  const placeholder =
    typeof example === "string" && example && !example.includes("{{")
      ? `For example: ${example}`
      : isEmail
        ? "name@company.com"
        : `Enter ${label.toLowerCase()}`;

  if (typeof example === "boolean" && usefulChoices.length === 0) {
    return (
      <Field label={label}>
        <Select value={String(value ?? example)} onChange={(event) => onChange(event.target.value === "true")}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      </Field>
    );
  }

  if (typeof example === "number" && usefulChoices.length === 0) {
    return (
      <Field label={label}>
        <Input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={String(example)}
          onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        />
      </Field>
    );
  }

  if (usefulChoices.length === 0) {
    return (
      <Field label={label}>
        {argumentKey === "body" ? (
          <Textarea value={String(value ?? "")} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <Input type={isEmail ? "email" : "text"} value={String(value ?? "")} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        )}
      </Field>
    );
  }

  return (
    <Field label={label} hint={reference ? "Uses data from an earlier step." : undefined}>
      <Select
        value={reference || (manual ? "__manual" : "")}
        onChange={(event) => {
          if (event.target.value === "__manual") {
            setManual(true);
            if (reference) onChange("");
          } else {
            setManual(false);
            onChange(event.target.value);
          }
        }}
      >
        <option value="">Choose {label.toLowerCase()}…</option>
        {Array.from(new Set(usefulChoices.map((choice) => choice.step))).map((step) => (
          <optgroup key={step} label={step}>
            {usefulChoices.filter((choice) => choice.step === step).map((choice) => (
              <option key={choice.ref} value={choice.ref}>{choice.label}</option>
            ))}
          </optgroup>
        ))}
        <option value="__manual">Enter manually…</option>
      </Select>
      {manual && (
        argumentKey === "body" ? (
          <Textarea value={String(value ?? "")} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <Input type={isEmail ? "email" : "text"} value={String(value ?? "")} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        )
      )}
    </Field>
  );
}

function rowsFromValue(value: unknown): unknown[][] {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(Array.isArray)
      ? (value as unknown[][])
      : [value];
  }
  if (typeof value === "string" && !exactDataReference(value)) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return rowsFromValue(parsed);
    } catch {
      // A legacy literal stays as one visible cell instead of disappearing.
    }
    if (value) return [[value]];
  }
  return [[""]];
}

function SheetValuesField({
  value,
  choices,
  onChange,
}: {
  value: unknown;
  choices: DataChoice[];
  onChange: (value: unknown) => void;
}) {
  const reference = exactDataReference(value);
  const [buildRows, setBuildRows] = useState(!reference);
  const rows = rowsFromValue(value);
  const width = Math.max(1, ...rows.map((row) => row.length));

  function writeCell(rowIndex: number, columnIndex: number, next: unknown) {
    const rebuilt: unknown[][] = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
    rebuilt[rowIndex][columnIndex] = next;
    onChange(rebuilt);
  }

  return (
    <Field label="Data to write" hint="Each row is appended to the selected sheet.">
      {choices.length > 0 && (
        <Select
          value={reference || (buildRows ? "__build" : "")}
          onChange={(event) => {
            if (event.target.value === "__build") {
              setBuildRows(true);
              if (reference) onChange([[""]]);
            } else {
              setBuildRows(false);
              onChange(event.target.value);
            }
          }}
        >
          <option value="">Choose workflow data…</option>
          {Array.from(new Set(choices.map((choice) => choice.step))).map((step) => (
            <optgroup key={step} label={step}>
              {choices.filter((choice) => choice.step === step).map((choice) => (
                <option key={choice.ref} value={choice.ref}>{choice.label}</option>
              ))}
            </optgroup>
          ))}
          <option value="__build">Build a row from fields…</option>
        </Select>
      )}

      {(choices.length === 0 || buildRows) && (
        <div className="flex flex-col gap-2.5 rounded-card border border-line bg-sunken p-2.5">
          {rows.map((row, rowIndex) => (
            <div key={rowIndex} className="rounded-[10px] border border-line bg-card p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Row {rowIndex + 1}</span>
                {rows.length > 1 && (
                  <button type="button" aria-label={`Remove row ${rowIndex + 1}`} onClick={() => onChange(rows.filter((_, index) => index !== rowIndex))} className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] text-ink-subtle hover:bg-inset hover:text-danger">
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                {Array.from({ length: width }, (_, columnIndex) => (
                  <div key={columnIndex} className="min-w-0">
                    <div className="mb-1 text-[10.5px] font-medium text-ink-subtle">Column {spreadsheetColumnLabel(columnIndex)}</div>
                    <SheetCellField
                      value={row[columnIndex] ?? ""}
                      choices={choices}
                      onChange={(next) => writeCell(rowIndex, columnIndex, next)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="secondary" icon="plus" onClick={() => onChange([...rows, Array(width).fill("")])}>Add row</Button>
            <Button size="sm" variant="secondary" icon="plus" onClick={() => onChange(rows.map((row) => [...row, ""]))}>Add column</Button>
          </div>
        </div>
      )}
    </Field>
  );
}

function spreadsheetColumnLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

function SheetCellField({ value, choices, onChange }: { value: unknown; choices: DataChoice[]; onChange: (value: unknown) => void }) {
  const reference = exactDataReference(value);
  const [manual, setManual] = useState(!reference && String(value ?? "") !== "");
  if (choices.length === 0 || manual) {
    return (
      <div className="flex flex-col gap-1">
        <Input value={String(value ?? "")} placeholder="Value" onChange={(event) => onChange(event.target.value)} className="h-9 text-[12.5px]" />
        {choices.length > 0 && <button type="button" onClick={() => { setManual(false); onChange(""); }} className="text-left text-[10.5px] font-medium text-brand">Choose workflow data</button>}
      </div>
    );
  }
  return (
    <Select
      value={reference}
      onChange={(event) => {
        if (event.target.value === "__manual") {
          setManual(true);
          onChange("");
        } else onChange(event.target.value);
      }}
      className="h-9 text-[12.5px]"
    >
      <option value="">Choose data…</option>
      {choices.map((choice) => <option key={choice.ref} value={choice.ref}>{choice.step} — {choice.label}</option>)}
      <option value="__manual">Enter manually…</option>
    </Select>
  );
}

function KeyValueEditor({
  graph,
  stepId,
  templated,
  hiddenKeys,
  keyLabel,
  valueLabel,
  value,
  onChange,
}: {
  graph: WorkflowGraph;
  stepId: string;
  templated?: boolean;
  /** Kept in the value, kept off the screen — a dedicated control edits these. */
  hiddenKeys?: readonly string[];
  keyLabel: string;
  valueLabel: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(value).filter(([k]) => !hiddenKeys?.includes(k));

  function setValueFor(key: string, next: string) {
    onChange({ ...value, [key]: next });
  }
  function rename(from: string, to: string) {
    if (!to.trim() || from === to) return;
    const rebuilt: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) rebuilt[k === from ? to : k] = v;
    onChange(rebuilt);
  }
  function remove(key: string) {
    const rebuilt = { ...value };
    delete rebuilt[key];
    onChange(rebuilt);
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-card border border-line p-2">
          <div className="mb-1.5 flex items-center gap-2">
            <Input
              defaultValue={k}
              aria-label={keyLabel}
              onBlur={(e) => rename(k, e.target.value.trim())}
              className="h-8 flex-1 font-mono text-[12px]"
            />
            <button
              type="button"
              aria-label={`Remove ${k}`}
              onClick={() => remove(k)}
              className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] text-ink-subtle transition-colors hover:bg-inset hover:text-danger"
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
          <TemplateInput
            graph={graph}
            stepId={stepId}
            templated={templated}
            value={typeof v === "string" ? v : JSON.stringify(v ?? "")}
            placeholder={valueLabel}
            onChange={(next) => setValueFor(k, next)}
          />
        </div>
      ))}

      <div className="flex gap-2">
        <Input
          value={newKey}
          placeholder={`Add ${keyLabel}…`}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (newKey.trim()) {
                onChange({ ...value, [newKey.trim()]: "" });
                setNewKey("");
              }
            }
          }}
          className="h-9 text-[13px]"
        />
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          aria-label={`Add ${keyLabel}`}
          onClick={() => {
            if (!newKey.trim()) return;
            onChange({ ...value, [newKey.trim()]: "" });
            setNewKey("");
          }}
        />
      </div>
    </div>
  );
}

/** Branch paths: each named case, where it goes, and how to add/remove one. */
function CasesField({ graph, stepId, onAddCase, onRemoveCase, onRenameCase, onRewire }: InspectorProps) {
  const step = graph.steps[stepId];
  const cases = (step.cases as Record<string, string | null>) ?? {};
  const [draft, setDraft] = useState("");
  const options = orderedStepIds(graph).filter((id) => id !== stepId);

  return (
    <Field
      label="Paths"
      hint="One path per value the step above can produce. Anything unmatched takes the fallback."
    >
      <div className="flex flex-col gap-2">
        {Object.entries(cases).map(([value, target]) => (
          <div key={value} className="rounded-card border border-line p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <Input
                defaultValue={value}
                aria-label="Path value"
                onBlur={(e) => onRenameCase(value, e.target.value.trim())}
                className="h-8 flex-1 text-[13px]"
              />
              <button
                type="button"
                aria-label={`Remove path ${value}`}
                onClick={() => onRemoveCase(value)}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] text-ink-subtle transition-colors hover:bg-inset hover:text-danger"
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
            <StepSelect
              value={target}
              options={options}
              graph={graph}
              onChange={(next) => onRewire({ from: stepId, slot: `case:${value}` }, next)}
            />
          </div>
        ))}

        <div className="flex gap-2">
          <Input
            value={draft}
            placeholder="Add a path value…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (draft.trim()) {
                  onAddCase(draft.trim());
                  setDraft("");
                }
              }
            }}
            className="h-9 text-[13px]"
          />
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            aria-label="Add path"
            onClick={() => {
              if (!draft.trim()) return;
              onAddCase(draft.trim());
              setDraft("");
            }}
          />
        </div>
      </div>
    </Field>
  );
}

/**
 * Where each of this step's outgoing connections leads. Case slots are
 * omitted because they're editable (with add/remove) in the Paths section.
 */
function Routing({ graph, stepId, onRewire }: InspectorProps) {
  const step = graph.steps[stepId];
  const slots = edgeSlots(step).filter((s) => !s.startsWith("case:"));
  const options = orderedStepIds(graph).filter((id) => id !== stepId);
  const showFail = step.type === "filter";

  if (!slots.length && !showFail) return null;

  return (
    <div className="border-t border-line pt-4">
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">
        Then
      </div>
      <div className="flex flex-col gap-2.5">
        {slots.map((slot) => (
          <Field key={slot} label={<span className="text-[12.5px]">{slotLabel(slot)}</span>}>
            <StepSelect
              value={getEdge(step, slot)}
              options={options}
              graph={graph}
              onChange={(next) => onRewire({ from: stepId, slot }, next)}
            />
          </Field>
        ))}
        {showFail && !slots.includes("on_fail") && (
          <Field
            label={<span className="text-[12.5px]">Doesn&apos;t match</span>}
            hint="Leave as “End the run” to quietly skip this item."
          >
            <StepSelect
              value={null}
              options={options}
              graph={graph}
              onChange={(next) => onRewire({ from: stepId, slot: "on_fail" }, next)}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

function StepSelect({
  value,
  options,
  graph,
  onChange,
}: {
  value: string | null;
  options: string[];
  graph: WorkflowGraph;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={cn("h-9 text-[13px]", !value && "text-ink-muted")}
    >
      <option value="">End the run here</option>
      {options.map((id) => (
        <option key={id} value={id}>
          {String(graph.steps[id]?.title ?? id)}
        </option>
      ))}
    </Select>
  );
}

/**
 * The public URL an external system POSTs to, plus its token. The origin is
 * read through useSyncExternalStore so it stays empty during SSR and fills in
 * on the client without a hydration mismatch.
 */
const subscribeNoop = () => () => {};

function WebhookPanel({
  workflowId,
  secret,
  active,
  publishedSecret,
  sampleFields,
  onGenerate,
  onSample,
}: {
  workflowId: string;
  secret: string;
  active: boolean;
  publishedSecret: string;
  sampleFields: string[];
  onGenerate: (secret: string) => void;
  onSample: (fields: string[]) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sample, setSample] = useState<{ fields: string[]; receivedAt: string } | null>(null);
  const acceptSample = useEffectEvent((fields: string[]) => {
    if (fields.join("\n") !== sampleFields.join("\n")) onSample(fields);
  });
  const origin = useSyncExternalStore(
    subscribeNoop,
    () => window.location.origin,
    () => "",
  );

  const endpoint = webhookEndpointState({ active, draftSecret: secret, publishedSecret });
  const url = endpoint.secret ? `${origin}/hooks/${workflowId}.${endpoint.secret}` : "";

  function regenerate() {
    if (
      webhookRotationNeedsConfirmation(active, publishedSecret) &&
      !window.confirm(
        "Create a replacement webhook URL?\n\nThe current endpoint stays live until you publish. Publishing the replacement will invalidate the URL in your app.",
      )
    ) return;
    setSample(null);
    onGenerate(webhookSecret());
  }

  useEffect(() => {
    if (!endpoint.secret) return;
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(`/api/workflows/${workflowId}`);
        const data = (await res.json()) as { triggerSample?: { secret?: string; fields?: string[]; receivedAt?: string } | null };
        const nextSample = webhookSampleForSecret(data.triggerSample, endpoint.secret);
        if (alive) {
          setSample(nextSample);
          if (nextSample) acceptSample(nextSample.fields);
        }
      } catch { /* Keep waiting; the editor's own load error handles auth/network failures. */ }
    };
    void check();
    const timer = window.setInterval(check, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [endpoint.secret, workflowId]);

  return (
    <Field
      label="Custom webhook endpoint"
      hint="Copy this URL into your app's webhook settings and send an HTTP POST with JSON. While paused it captures test data only; when active it starts a run."
    >
      <div className="flex flex-col gap-2">
        <div className="break-all rounded-card border border-line bg-inset px-3 py-2 font-mono text-[11.5px] text-ink-muted">
          {url || (endpoint.pendingPublish
            ? "Publish these changes before an endpoint can receive requests."
            : "Create a webhook URL below to connect your app.")}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={copied ? "check" : "copy"}
            disabled={!url}
            onClick={() => {
              void navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? "Copied" : "Copy endpoint"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            onClick={regenerate}
          >
            {secret ? "Regenerate URL" : "Create a webhook URL"}
          </Button>
        </div>
        {endpoint.pendingPublish && url && (
          <div className="rounded-card border border-warning-border bg-warning-surface px-3 py-2 text-[12px] text-warning">
            The endpoint above is still live. Publish these changes to activate the replacement URL.
          </div>
        )}
        <div className={cn("rounded-card border px-3 py-2.5 text-[12px]", sample ? "border-success-border bg-success-surface text-success" : "border-line bg-sunken text-ink-subtle")}>
          {sample
            ? `Test payload received · ${sample.fields.length} fields detected`
            : "Waiting for test data… Send a POST while this automation is paused."}
        </div>
      </div>
    </Field>
  );
}
