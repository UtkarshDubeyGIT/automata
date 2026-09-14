"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon, IconTile, type IconName } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { useCredits } from "@/components/ui/credits";
import { cn } from "@/lib/utils";
import {
  tileColors,
  type ResponseSegment,
  type Workflow,
  type WorkflowGroup,
} from "@/lib/data/workflows";
import type { BuildOutput } from "@/lib/workflows/builder";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { unconnected } from "@/lib/workflows/apps";
import { appList, ConnectApps, useAppConnections } from "@/components/connect-apps";
import { BrandGap, useBrandReadiness } from "@/components/brand-readiness";
import { pollWorkflowBuild, requestWorkflowBuild } from "@/lib/workflows/build-request";
import { requestWorkflowCreation } from "@/lib/workflows/create-request";

/**
 * Shared AI chat panel — the third way to build, alongside the template
 * gallery and the visual canvas.
 *
 * Two modes over the same UI:
 *   "build" (list page)  — a prompt designs a NEW workflow, previewed inline
 *                          and saved on confirmation.
 *   "edit"  (editor page) — a prompt changes the workflow ON the canvas. The
 *                          result is handed straight to the editor as unsaved
 *                          changes, so an AI edit and a hand edit are the same
 *                          thing and can be mixed freely.
 */

export interface ChatSuggestion {
  icon: IconName;
  label: string;
  desc: string;
  prompt: string;
}

interface UserMsg {
  role: "user";
  text: string;
}

interface AssistantMsg {
  role: "assistant";
  paragraphs: ResponseSegment[][];
  preview?: WorkflowGroup[];
  /** Full server build used to render the preview. */
  build?: BuildOutput;
  /** Durable server row used to save without trusting the client preview. */
  buildId?: string;
  /** True once saved or discarded — hides the action row. */
  dismissed?: boolean;
}

type Msg = UserMsg | AssistantMsg;

/** What an AI edit hands back to the editor page. */
export interface AppliedEdit {
  graph: WorkflowGraph;
  name: string;
  description: string;
}

export function BuilderChat({
  placeholder,
  placeholders,
  suggestions,
  onSaved,
  onRunTest,
  inputRef,
  mode = "build",
  variant = "panel",
  workflowId,
  graph,
  onEdited,
  navigationPending = false,
}: {
  placeholder: string;
  /**
   * Example prompts, shown one at a time in the empty prompt box and rotated.
   * A static placeholder can only describe one thing you might type; the point
   * of this box is that it accepts almost anything, and the fastest way to say
   * so is to show a few of them.
   */
  placeholders?: string[];
  suggestions: ChatSuggestion[];
  onSaved: (workflow: Workflow) => void;
  context?: "list" | "detail";
  onRunTest?: () => void;
  /** Lets the right column focus the prompt textarea ("New automation", "Add a step"). */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** "edit" rewrites the open workflow instead of designing a new one. */
  mode?: "build" | "edit";
  /**
   * "panel" is the 400px column beside the canvas. "hero" is the Automations
   * create tab, where the composer is the whole screen and owns its width.
   */
  variant?: "panel" | "hero";
  workflowId?: string;
  /** The canvas's CURRENT graph, unsaved edits included — the edit basis. */
  graph?: WorkflowGraph | null;
  onEdited?: (edit: AppliedEdit) => void;
  /** A saved workflow is being opened; keep this conversation immutable. */
  navigationPending?: boolean;
}) {
  const hero = variant === "hero";
  const { toast } = useToast();
  const { refresh: refreshCredits } = useCredits();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Drop in-flight builds superseded by a newer prompt or a reset. */
  const seqRef = useRef(0);
  /** React state updates later; this closes same-frame double saves. */
  const savingRef = useRef(false);

  useEffect(() => () => {
    // A save may finish after a tab change has unmounted this chat.
    seqRef.current++;
  }, []);

  const setTa = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      if (inputRef) inputRef.current = el;
    },
    [inputRef],
  );

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, building]);

  const submit = useCallback(
    async (raw: string) => {
      // Detail-page special: the "Test this workflow" suggestion runs, not builds.
      if (raw === "__TEST__") {
        onRunTest?.();
        return;
      }
      const t = raw.trim();
      if (!t) {
        taRef.current?.focus();
        return;
      }
      if (building || navigationPending) return;
      const seq = ++seqRef.current;
      setMessages((prev) => [...prev, { role: "user", text: t }]);
      setInput("");
      setBuilding(true);
      const fail = (message: string) => {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", paragraphs: [[{ t: message }]] },
        ]);
      };
      try {
        if (mode === "edit" && workflowId) {
          let res: Response;
          try {
            res = await fetch(`/api/workflows/${workflowId}/edit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instruction: t, graph: graph ?? undefined }),
              signal: AbortSignal.timeout(60_000),
            });
          } catch (fetchErr) {
            if (seq !== seqRef.current) return;
            const isTimeout =
              fetchErr instanceof Error &&
              (fetchErr.name === "TimeoutError" || fetchErr.name === "AbortError");
            fail(
              isTimeout
                ? "The edit request timed out — try a simpler change or use the Create tab to build a new automation."
                : "Couldn't connect to the server — check that the app is running, then try again.",
            );
            return;
          }

          const data = (await res.json().catch(() => null)) as {
            edit?: {
              graph: WorkflowGraph;
              name: string;
              description: string;
              response: ResponseSegment[][];
              groups: WorkflowGroup[];
            };
            error?: string;
          } | null;

          if (seq !== seqRef.current) return;
          if (!data) {
            fail(
              res.status === 504 || res.status === 502
                ? "The editor timed out designing the change — try rephrasing with fewer steps or build from scratch in the Create tab."
                : "The server returned an unreadable response — please try again.",
            );
            return;
          }

          if (!res.ok || !data.edit) {
            fail(data.error ?? "I couldn't apply that change — try describing it differently.");
            return;
          }
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              paragraphs: data.edit!.response,
              preview: data.edit!.groups,
              dismissed: true,
            },
          ]);
          onEdited?.({
            graph: data.edit.graph,
            name: data.edit.name,
            description: data.edit.description,
          });
          return;
        }

        const started = await requestWorkflowBuild(t);
        void refreshCredits();
        if (seq !== seqRef.current) return;
        if (started.kind === "unknown") {
          fail("I couldn't reach the builder — check that the app is running, then try again.");
          return;
        }
        if (started.kind === "insufficient_credits") {
          fail(`This build needs ${started.cost} credits, but you have ${started.balance}.`);
          return;
        }
        if (started.kind === "refused") {
          fail(started.message ?? "I couldn't queue that workflow build.");
          return;
        }

        let job = started.job;
        while (job.status === "queued" || job.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          if (seq !== seqRef.current) return;
          const polled = await pollWorkflowBuild(job.id);
          if (polled.kind === "retry") continue;
          if (polled.kind === "refused") {
            fail(polled.message ?? "I couldn't read the build status — please try again.");
            return;
          }
          job = polled.job;
        }
        void refreshCredits();
        if (job.status === "failed" || !job.build) {
          fail(job.error ?? "I couldn't design that workflow — try rephrasing the request.");
          return;
        }
        const build = job.build;
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            paragraphs: build.response,
            preview: build.groups,
            build,
            buildId: job.id,
          },
        ]);
      } catch {
        if (seq !== seqRef.current) return;
        fail(
          mode === "edit"
            ? "I couldn't reach the editor — check that the app is running, then try again."
            : "The builder hit an unexpected error — try again.",
        );
      } finally {
        if (seq === seqRef.current) setBuilding(false);
      }
    },
    [building, navigationPending, onRunTest, mode, workflowId, graph, onEdited, refreshCredits],
  );

  const reset = useCallback(() => {
    // A create POST may already have committed even if its fetch is aborted.
    if (savingRef.current || navigationPending) return;
    seqRef.current++;
    setMessages([]);
    setInput("");
    setBuilding(false);
    setSaving(false);
  }, [navigationPending]);

  async function save(msg: AssistantMsg, index: number) {
    if (!msg.build || !msg.buildId || savingRef.current || navigationPending) return;
    const seq = seqRef.current;
    savingRef.current = true;
    setSaving(true);
    let keepLocked = false;
    try {
      const outcome = await requestWorkflowCreation(`chat:${msg.buildId}`, { buildId: msg.buildId });
      if (seq !== seqRef.current) return;
      if (outcome.kind === "unknown") {
        toast({
          title: "Couldn't confirm the save",
          description: "Try again — the retry will not create a duplicate.",
          tone: "warning",
        });
        return;
      }
      if (outcome.kind === "refused") {
        toast({ title: "Couldn't save the workflow", description: outcome.message, tone: "danger" });
        return;
      }
      setMessages((prev) =>
        prev.map((m, i) =>
          i === index && m.role === "assistant" ? { ...m, dismissed: true } : m,
        ),
      );
      // router.push returns before the destination commits. Keep the save lock
      // until this component unmounts so the old screen cannot submit again.
      keepLocked = true;
      onSaved(outcome.workflow);
    } finally {
      if (!keepLocked) {
        savingRef.current = false;
        if (seq === seqRef.current) setSaving(false);
      }
    }
  }

  function discard(index: number) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index && m.role === "assistant" ? { ...m, dismissed: true } : m,
      ),
    );
  }

  // Only the newest *unsaved build* shows its action row — an applied edit has
  // already landed on the canvas, so there is nothing to confirm.
  const lastPreviewIndex = messages.reduce(
    (last, m, i) => (m.role === "assistant" && m.build && m.preview?.length ? i : last),
    -1,
  );

  const promptBox = (
    <PromptBox
      value={input}
      onChange={setInput}
      onSubmit={() => void submit(input)}
      placeholder={placeholder}
      placeholders={placeholders}
      building={building}
      disabled={navigationPending}
      taRef={setTa}
      hero={hero}
    />
  );

  /** The transcript — identical in both variants, only its frame differs. */
  const conversation = (
    <>
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className="text-[13px] font-semibold text-ink">New conversation</span>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          aria-label="Start fresh"
          disabled={saving || navigationPending}
          onClick={reset}
        >
          Start fresh
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4"
      >
        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div
              key={i}
              className="max-w-[85%] self-end rounded-[12px] rounded-br-[4px] bg-inset px-3.5 py-2 text-[14px] text-ink"
            >
              {msg.text}
            </div>
          ) : (
            <AssistantMessage
              key={i}
              msg={msg}
              showActions={i === lastPreviewIndex && !msg.dismissed}
              saving={saving}
              onSave={() => void save(msg, i)}
              onDiscard={() => discard(i)}
            />
          ),
        )}

        {building && (
          <div className="flex gap-3">
            <AssistantAvatar />
            <div className="flex items-center gap-2 text-[14px] text-ink-subtle">
              <Icon name="sparkles" size={15} className="animate-pulse text-brand" />
              {mode === "edit" ? "Updating your workflow…" : "Designing your workflow…"}
            </div>
          </div>
        )}
      </div>

      <div className="mx-4 mb-4 mt-auto">{promptBox}</div>
    </>
  );

  // Hero: the composer IS the screen. No card around the empty state — the
  // prompt box carries its own edge, so the page stays quiet until you type.
  if (hero) {
    return (
      <div className="mx-auto w-full max-w-[820px]">
        {messages.length === 0 ? (
          <>
            <div className="text-center">
              <h1 className="font-display text-[34px] font-semibold leading-tight tracking-[-0.03em] text-ink">
                What should run itself?
              </h1>
              <p className="mx-auto mt-2.5 max-w-[540px] text-[15.5px] leading-relaxed text-ink-subtle">
                Describe it in plain English. Nothing goes live until you switch it on.
              </p>
            </div>

            <div className="mt-5">{promptBox}</div>

            {suggestions.length > 0 && (
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                {suggestions.map((row) => (
                  <button
                    key={row.label}
                    disabled={navigationPending}
                    onClick={() => void submit(row.prompt)}
                    className="flex items-start gap-3 rounded-card border border-line bg-card px-4 py-3.5 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-brand-border hover:shadow-sm"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-brand-subtle text-brand">
                      <Icon name={row.icon} size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-semibold text-ink">
                        {row.label}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-subtle">
                        {row.desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <Card className="flex max-h-[calc(100vh-15rem)] min-h-[460px] w-full flex-col overflow-hidden p-0">
            {conversation}
          </Card>
        )}
      </div>
    );
  }

  return (
    <Card className="flex h-full min-h-0 w-full flex-none flex-col overflow-hidden p-0">
      {messages.length === 0 ? (
        <div data-ai-chat-empty className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line px-5 py-4 pr-12">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-brand-subtle text-brand">
              <Icon name="sparkles" size={17} />
            </div>
            <div className="min-w-0 text-left">
              <h2 className="text-[15px] font-semibold text-ink">Edit with AI</h2>
              <p className="mt-0.5 truncate text-[12px] text-ink-subtle">
                Describe a change and preview it on the canvas.
              </p>
            </div>
          </div>

          <div className="px-4 pt-4">{promptBox}</div>

          {suggestions.length > 0 && (
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 text-left">
              <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                <Icon name="sparkles" size={12} />
                Try a prompt
              </div>
              <div className="mt-2 grid gap-2">
                {suggestions.map((row) => (
                  <button
                    key={row.label}
                    onClick={() => void submit(row.prompt)}
                    className="group flex w-full gap-3 rounded-[10px] border border-line bg-card px-3 py-2.5 text-left transition-[border-color,background-color] hover:border-brand-border hover:bg-brand-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-inset text-ink-muted transition-colors group-hover:bg-card group-hover:text-brand">
                      <Icon name={row.icon} size={14} />
                    </span>
                    <span className="min-w-0">
                      <strong className="block text-[13px] font-semibold leading-snug text-ink">
                        {row.label}
                      </strong>
                      <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-ink-subtle">
                        {row.desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        conversation
      )}
    </Card>
  );
}

/** How long one hint holds, and how long it takes to cross-fade to the next. */
const HINT_HOLD_MS = 3400;
const HINT_FADE_MS = 400;

/**
 * The hint currently on show, and whether it is faded in.
 *
 * Only runs while there is something to rotate and the box is still empty —
 * once someone is typing, their own text is the only thing that should move.
 * Reduced-motion holds the first hint instead of cycling: the animation is the
 * decoration, the examples are the content.
 */
function useRotatingHint(items: string[], enabled: boolean) {
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(true);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  const count = items.length;

  // Type one character during the fade-out and the cycle stops with the hint
  // still faded; delete it and the box would sit blank for a whole cycle
  // before the next one arrived. Re-entering the empty state starts visible.
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    if (enabled && !shown) setShown(true);
  }

  useEffect(() => {
    if (!enabled || count < 2) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let fade: number | undefined;
    const cycle = window.setInterval(() => {
      setShown(false);
      fade = window.setTimeout(() => {
        setIndex((i) => (i + 1) % count);
        setShown(true);
      }, HINT_FADE_MS);
    }, HINT_HOLD_MS + HINT_FADE_MS);

    return () => {
      window.clearInterval(cycle);
      if (fade !== undefined) window.clearTimeout(fade);
    };
  }, [enabled, count]);

  return { text: items[index] ?? "", shown };
}

function PromptBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  placeholders,
  building,
  disabled = false,
  taRef,
  hero = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  placeholders?: string[];
  building: boolean;
  disabled?: boolean;
  taRef: (el: HTMLTextAreaElement | null) => void;
  /** Roomier type, softer edge — the composer as the centrepiece of a screen. */
  hero?: boolean;
}) {
  const rotating = (placeholders?.length ?? 0) > 0;
  const empty = value.length === 0;
  const hint = useRotatingHint(placeholders ?? [], empty);

  return (
    <div
      className={cn(
        "border border-line bg-card transition focus-within:border-brand focus-within:ring-[3px] focus-within:ring-ring",
        hero ? "rounded-[18px] shadow-sm" : "rounded-[16px]",
      )}
    >
      <div className="relative">
        <textarea
          ref={taRef}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          // The rotating hint is drawn over the box instead, because a real
          // placeholder cannot fade. Keep the description on the control so it
          // still reaches anyone who never sees the animation.
          placeholder={rotating ? "" : placeholder}
          aria-label={placeholder}
          className={cn(
            "w-full resize-none bg-transparent px-4 pt-3.5 text-ink placeholder:text-ink-subtle focus:outline-none",
            hero ? "text-[15.5px] leading-relaxed" : "text-[14px]",
          )}
        />
        {rotating && empty && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-4 top-3.5 truncate text-ink-subtle transition-opacity motion-reduce:transition-none",
              hero ? "text-[15.5px] leading-relaxed" : "text-[14px]",
              hint.shown ? "opacity-100" : "opacity-0",
            )}
            style={{ transitionDuration: `${HINT_FADE_MS}ms` }}
          >
            {hint.text}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        {hero ? (
          <span className="pl-1 text-[12px] text-ink-subtle">
            <kbd className="font-sans font-medium">Enter</kbd> to build
          </span>
        ) : (
          <span className="pl-1 text-[11.5px] text-ink-subtle">
            <kbd className="font-sans font-medium">Enter</kbd> to update
          </span>
        )}
        <Button
          size="sm"
          icon="send"
          aria-label="Build"
          onClick={onSubmit}
          loading={building}
          disabled={disabled}
          className="ml-auto"
        />
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-brand-subtle text-brand">
      <Icon name="sparkles" size={16} />
    </span>
  );
}

function AssistantMessage({
  msg,
  showActions,
  saving,
  onSave,
  onDiscard,
}: {
  msg: AssistantMsg;
  showActions: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const steps = (msg.preview ?? []).flatMap((g) => g.steps);
  /**
   * The accounts this preview needs, with live state. Held per message so a
   * second build in the same conversation asks about its own apps, and so
   * connecting one here can enable this message's Save button without a
   * round-trip through the parent.
   */
  const apps = useMemo(() => msg.build?.requiredApps ?? [], [msg.build]);
  const { connections, missing, busy, connect, resolve, mark } = useAppConnections(apps);
  /**
   * Unlike the accounts above this never blocks Save. A missing connection
   * means every run stops at the first step that needs it; a thin brand
   * profile only means the writing is general, and refusing to build over
   * that would be refusing to build for a workspace on its first day.
   */
  const { readiness } = useBrandReadiness();
  const { toast } = useToast();

  /**
   * Saving is what CREATES the automation, so the accounts are checked here
   * and not only by the disabled state above: the button is live for the
   * moment between this message appearing and the first status fetch landing,
   * and "we hadn't asked yet" must not be the reason something gets built.
   */
  async function guardedSave() {
    const blocked = unconnected(await resolve(apps));
    if (blocked.length) {
      toast({
        title: `Connect ${appList(blocked)} first`,
        description: "This automation can't run a single step without it.",
        tone: "warning",
      });
      return;
    }
    onSave();
  }

  return (
    <div className="flex gap-3">
      <AssistantAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {msg.paragraphs.map((segs, i) => (
          <p key={i} className="text-[14px] leading-relaxed text-ink-muted">
            {segs.map((sg, j) =>
              sg.b ? (
                <strong key={j} className="font-semibold text-ink">
                  {sg.t}
                </strong>
              ) : (
                <span key={j}>{sg.t}</span>
              ),
            )}
          </p>
        ))}

        {steps.length > 0 && (
          <div className="overflow-hidden rounded-card border border-line">
            {steps.map((step, i) => {
              const tc = tileColors(step.tile);
              return (
                <div
                  key={i}
                  className={cn(
                    "flex items-center gap-3 px-3.5 py-2.5",
                    i > 0 && "border-t border-line",
                  )}
                >
                  <span className="w-4 font-mono text-[11px] text-ink-subtle">{i + 1}</span>
                  <IconTile name={step.icon} bg={tc.bg} fg={tc.fg} size={30} iconSize={15} />
                  <span className="flex-1 truncate text-[13.5px] text-ink">{step.title}</span>
                  {step.kind === "hil" && (
                    <span className="rounded-full border border-brand-border bg-brand-subtle px-2 py-0.5 text-[11px] font-semibold text-brand">
                      Review
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!msg.dismissed && apps.length > 0 && (
          <ConnectApps
            connections={connections}
            busy={busy}
            onConnect={connect}
            onConnected={(app) => mark(app.app, "connected")}
            note={
              missing.length
                ? `Connect ${appList(missing)} before saving. We'll open each provider in a new tab and bring you back here; runs stop until the connection is ready.`
                : undefined
            }
          />
        )}

        {!msg.dismissed && (
          <BrandGap readiness={readiness} needed={msg.build?.needsBrand ?? false} />
        )}

        {showActions && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon="save"
              loading={saving}
              disabled={missing.length > 0}
              onClick={() => void guardedSave()}
            >
              Save workflow
            </Button>
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              Discard
            </Button>
            {missing.length > 0 && (
              <span className="text-[12px] text-ink-subtle">
                Waiting on {appList(missing)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
