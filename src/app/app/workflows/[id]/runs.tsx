"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { nodeSpec } from "@/lib/workflows/blocks";
import type {
  ApprovalPreview as ApprovalPreviewData,
  StepType,
} from "@/lib/workflows/types";
import { ApprovalPreview } from "../approval-preview";

/**
 * Run history with the per-step journal expanded inline — the engine already
 * records exactly what every step produced, so a failed run can be read like a
 * transcript instead of a status code.
 */

export interface JournalEntryView {
  stepId: string;
  type: StepType;
  title: string;
  at: string;
  output: Record<string, unknown>;
}

export interface RunEntry {
  id: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  label: string;
  time: string;
  startedAt?: string;
  error?: string | null;
  /** The step that stopped the run, from log.failed — never in the journal. */
  failedStepId?: string | null;
  /** Set while the run is suspended waiting for a person. */
  pending?: {
    stepId: string;
    prompt: string;
    /** What the decision is about — the post, the picture, the destination. */
    preview?: ApprovalPreviewData | null;
  } | null;
  /**
   * Set while the run is parked on machine work, such as a video render or
   * Firecrawl research job.
   *
   * The sibling of `pending` and deliberately not merged with it: this one
   * offers no buttons, because there is nothing to decide. It exists so a run
   * sitting at "waiting" for eight minutes explains itself instead of looking
   * stuck.
   */
  awaiting?: { kind: string; operation?: string; note: string; since: string } | null;
  journal?: JournalEntryView[];
}

export function Runs({
  runs,
  onReplay,
  onDecide,
}: {
  runs: RunEntry[];
  /** Mark this run's steps on the canvas and switch to it. */
  onReplay?: (run: RunEntry) => void;
  /** Approve or reject a run that is waiting on a person. */
  onDecide?: (run: RunEntry, decision: "approve" | "reject") => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[620px] rounded-card border border-line bg-card px-6 py-12 text-center shadow-xs">
        <Icon name="activity" size={24} className="mx-auto mb-3 text-ink-subtle" />
        <div className="text-[14.5px] font-semibold text-ink">No runs yet</div>
        <p className="mt-1 text-[13px] text-ink-subtle">
          Press Run to try it once and see every step&apos;s output here.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[620px] flex-col gap-2">
      {runs.map((run) => {
        const open = openId === run.id;
        return (
          <div
            key={run.id}
            className="overflow-hidden rounded-card border border-line bg-card shadow-xs"
          >
            <button
              onClick={() => setOpenId(open ? null : run.id)}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-inset"
            >
              <StatusIcon status={run.status} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">{run.label}</div>
                {run.error ? (
                  <div className="line-clamp-2 text-[12.5px] text-danger">{run.error}</div>
                ) : (
                  <div className="text-[12.5px] text-ink-subtle">
                    {run.journal?.length ?? 0} step{(run.journal?.length ?? 0) === 1 ? "" : "s"}
                  </div>
                )}
              </div>
              <span className="flex-none text-[12.5px] text-ink-subtle">{run.time}</span>
              <Icon
                name={open ? "chevron-up" : "chevron-down"}
                size={15}
                className="flex-none text-ink-subtle"
              />
            </button>

            {run.status === "waiting" && run.pending && onDecide && (
              <Approval run={run} onDecide={onDecide} />
            )}

            {run.status === "waiting" && run.awaiting && (
              <div className="flex items-start gap-2 border-t border-line bg-inset/60 px-4 py-3">
                <Icon name="hourglass" size={15} className="mt-0.5 flex-none text-brand" />
                <p className="text-[12.5px] leading-relaxed text-ink-muted">
                  {run.awaiting.note} The run picks itself back up when {run.awaiting.kind === "firecrawl" ? "Firecrawl finishes" : "the video is ready"} —
                  nothing to do here.
                </p>
              </div>
            )}

            {open && (
              <div className="border-t border-line bg-inset/50 px-4 py-3">
                {(run.journal ?? []).length === 0 ? (
                  <p className="py-2 text-[12.5px] text-ink-subtle">
                    This run recorded no steps{run.error ? " before it failed." : "."}
                  </p>
                ) : (
                  <>
                    <ol className="flex flex-col gap-2">
                      {(run.journal ?? []).map((entry, i) => (
                        <JournalRow key={`${entry.stepId}-${i}`} index={i + 1} entry={entry} />
                      ))}
                    </ol>
                    {onReplay && (
                      <button
                        onClick={() => onReplay(run)}
                        className="mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand transition-colors hover:underline"
                      >
                        <Icon name="sliders" size={13} />
                        Show this run on the canvas
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusIcon({ status }: { status: RunEntry["status"] }) {
  const map = {
    completed: { icon: "check-circle", className: "text-success" },
    failed: { icon: "x", className: "text-danger" },
    waiting: { icon: "hand", className: "text-brand" },
    running: { icon: "refresh", className: "animate-spin text-ink-subtle" },
    // Claimed and paid for, but not yet driven. Deliberately NOT the spinner:
    // "queued" and "running" are different promises and only one of them means
    // something is happening right now.
    queued: { icon: "clock", className: "text-ink-subtle" },
  } as const;
  const m = map[status] ?? map.running;
  return <Icon name={m.icon} size={17} className={cn("flex-none", m.className)} />;
}

/**
 * The decision row. It shows the draft the run is about to act on rather than
 * just asking — approving something you cannot see is not approval.
 *
 * It used to show `summarize()` of the last journal entry, which is the right
 * instinct pointed at the wrong object: the last entry is whatever step
 * happened to run before the pause, and the thing being approved is what runs
 * AFTER it — with its template references resolved, its picture attached and
 * its destination named. `preview` is that; the summarised draft below is the
 * fallback for a run that stopped before previews existed.
 */
function Approval({
  run,
  onDecide,
}: {
  run: RunEntry;
  onDecide: (run: RunEntry, decision: "approve" | "reject") => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const preview = run.pending?.preview;
  const draft = preview
    ? ""
    : summarize((run.journal ?? [])[(run.journal ?? []).length - 1]?.output ?? {});

  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    setBusy(decision);
    try {
      await onDecide(run, decision);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-line bg-brand-subtle/40 px-4 py-3">
      <div className="flex items-start gap-2">
        <Icon name="hand" size={15} className="mt-0.5 flex-none text-brand" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">{run.pending?.prompt}</div>
          {preview && <ApprovalPreview preview={preview} className="mt-2" />}
          {draft && (
            <p className="mt-1 whitespace-pre-wrap rounded-[8px] bg-card px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-muted">
              {draft}
            </p>
          )}
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => void decide("approve")}
              disabled={busy !== null}
              className="rounded-[8px] bg-brand px-3 py-1.5 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              onClick={() => void decide("reject")}
              disabled={busy !== null}
              className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-60"
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function JournalRow({ index, entry }: { index: number; entry: JournalEntryView }) {
  const [open, setOpen] = useState(false);
  const preview = summarize(entry.output);
  return (
    <li className="rounded-card border border-line bg-card px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 w-4 flex-none text-center font-mono text-[11px] text-ink-subtle">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-ink">{entry.title}</span>
            <span className="flex-none rounded-full bg-inset px-1.5 py-0.5 text-[10.5px] text-ink-subtle">
              {nodeSpec(entry.type)?.label ?? entry.type}
            </span>
          </div>
          {preview && (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-muted">
              {preview}
            </p>
          )}
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex-none text-[11.5px] text-ink-subtle transition-colors hover:text-ink"
        >
          {open ? "Hide" : "Raw"}
        </button>
      </div>
      {open && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-[8px] bg-inset p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
          {JSON.stringify(entry.output, null, 2)}
        </pre>
      )}
    </li>
  );
}

/** The most human-readable thing in a step's output. */
function summarize(output: Record<string, unknown>): string {
  if (!output) return "";
  for (const key of ["text", "message", "reply"]) {
    if (typeof output[key] === "string" && output[key]) return String(output[key]);
  }
  const result = output.result;
  if (result && typeof result === "object") {
    const values = Object.values(result as Record<string, unknown>).filter(
      (v) => typeof v === "string" && v,
    );
    if (values.length) return values.join(" · ");
  }
  if (output.event && typeof output.event === "object") {
    return Object.entries(output.event as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");
  }
  if (typeof output.passed === "boolean") {
    return output.passed ? "Condition matched — continuing" : "Condition didn't match — run stopped";
  }
  if (output.decision) return `Decision: ${String(output.decision)}`;
  if (output.successful) return "Completed successfully";
  return "";
}
