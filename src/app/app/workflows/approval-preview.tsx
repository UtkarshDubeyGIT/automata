"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { toolkitLogo } from "@/lib/social/platforms";
import { cn } from "@/lib/utils";
import type {
  ApprovalPreview as ApprovalPreviewData,
  PreviewAction,
  PreviewDraft,
  PreviewGrounding,
} from "@/lib/workflows/types";

/**
 * What you are actually approving.
 *
 * Every approval in the product used to be a prompt over two buttons —
 * "Approve this before it goes out?" — with the post itself nowhere on screen.
 * The words, the picture and the account were all known by then; nothing
 * carried them to the person being asked. This renders them: the copy as it
 * will be published, the image as it will appear, and the destination beside
 * it, with what rejecting does instead.
 *
 * The shape comes from src/lib/workflows/preview.ts, so the Automations
 * attention card and a workflow's own run list describe one decision
 * identically — the two places a person can approve the same run.
 */

/** Longer than this and the post is folded until asked for. */
const CLAMP_CHARS = 420;

export function ApprovalPreview({
  preview,
  className,
}: {
  preview: ApprovalPreviewData | null | undefined;
  className?: string;
}) {
  if (!preview) return null;

  // The post text is usually the draft, referenced — showing both would print
  // the same paragraph twice under two headings. The drafts are the fallback
  // for when the action itself carries nothing readable (a branch in the way,
  // or an action whose wording is written after the decision).
  const showsContent = preview.actions.some((a) => a.body || a.imageUrl || a.videoUrl);
  const drafts = showsContent ? [] : preview.drafts;

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div className="text-[13px] font-medium text-ink">{preview.summary}</div>

      {preview.actions.map((action) => (
        <ActionCard key={action.stepId} action={action} />
      ))}

      {drafts.map((draft) => (
        <DraftCard key={draft.stepId} draft={draft} />
      ))}

      {preview.conditional && (
        <Note icon="git-branch">
          A condition decides what happens after this, so the exact next step
          depends on the data this run is carrying.
        </Note>
      )}

      {preview.grounding && <Grounding grounding={preview.grounding} />}

      {preview.simulated && (
        <div className="flex items-start gap-2 rounded-[10px] border border-warning-border bg-warning-surface px-3 py-2 text-[12px] leading-relaxed text-warning">
          <Icon name="info" size={14} className="mt-0.5 flex-none" />
          <span>
            This was drafted with preview data, not a live AI key — the run will
            refuse to publish it even if you approve.
          </span>
        </div>
      )}

      <div className="text-[12px] leading-relaxed text-ink-subtle">{preview.onReject}</div>
    </div>
  );
}

function ActionCard({ action }: { action: PreviewAction }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <AppMark app={action.app} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
          {action.label}
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        {action.videoUrl && <Clip url={action.videoUrl} />}
        {action.imageUrl && <Picture url={action.imageUrl} />}
        {action.body ? (
          <Body text={action.body} />
        ) : action.unresolved ? (
          <p className="text-[12.5px] leading-relaxed text-ink-subtle">
            The wording is written by a step that runs after this decision, so
            there is nothing to read yet.
          </p>
        ) : null}
        {action.fields.length > 0 && <Fields action={action} />}
      </div>
    </div>
  );
}

function DraftCard({ draft }: { draft: PreviewDraft }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-brand-subtle text-brand">
          <Icon
            name={draft.videoUrl ? "video" : draft.imageUrl && !draft.text ? "image" : "wand"}
            size={13}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
          {draft.title}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        {draft.videoUrl && <Clip url={draft.videoUrl} />}
        {draft.imageUrl && <Picture url={draft.imageUrl} />}
        {draft.text && <Body text={draft.text} />}
      </div>
    </div>
  );
}

/** The content itself — folded when it is long, never summarised. */
function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CLAMP_CHARS;
  const shown = long && !open ? `${text.slice(0, CLAMP_CHARS).trimEnd()}…` : text;
  return (
    <div>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-muted">{shown}</p>
      {long && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-[12px] font-medium text-brand transition-colors hover:underline"
        >
          {open ? "Show less" : "Show the whole thing"}
        </button>
      )}
    </div>
  );
}

function Picture({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-sunken px-3 py-2 text-[12px] text-ink-subtle">
        <Icon name="image" size={14} className="flex-none" />
        <span className="truncate">An image is attached, but it could not be loaded here.</span>
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="group relative block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="The image this run would publish"
        loading="lazy"
        onError={() => setBroken(true)}
        className="max-h-[260px] w-full rounded-[10px] border border-line object-cover"
      />
      <span className="absolute right-2 top-2 hidden items-center gap-1 rounded-full bg-ink/70 px-2 py-1 text-[11px] font-medium text-page group-hover:inline-flex">
        <Icon name="external-link" size={11} />
        Full size
      </span>
    </a>
  );
}

/**
 * The clip itself, playable.
 *
 * A link saying "video.mp4" is not a preview of a video — approving one
 * without watching it is the same act of blind trust this whole card exists to
 * end. It is muted and unautoplayed on purpose: several of these can share a
 * screen, and a card that starts talking when it renders is worse than one
 * that waits to be asked.
 */
function Clip({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-sunken px-3 py-2 text-[12px] text-ink-subtle">
        <Icon name="video" size={14} className="flex-none" />
        <span className="truncate">A video is attached, but it could not be played here.</span>
      </div>
    );
  }
  return (
    <video
      src={url}
      controls
      muted
      playsInline
      preload="metadata"
      onError={() => setBroken(true)}
      className="max-h-[320px] w-full rounded-[10px] border border-line bg-ink/5 object-contain"
    />
  );
}

/**
 * Who this was written for.
 *
 * The grounding was always silent: the same step produced a draft about this
 * specific business or a generic one depending on whether a profile could be
 * read, and both arrived looking identical. Saying which happened is the
 * difference between approving copy and approving copy you have checked is
 * yours — and when it did NOT happen, this is the only warning that the words
 * about to be published are about nobody in particular.
 */
function Grounding({ grounding }: { grounding: PreviewGrounding }) {
  const what =
    grounding.kinds.length === 1
      ? { copy: "written", image: "pictured", video: "filmed" }[grounding.kinds[0]]
      : "made";
  if (!grounding.applied) {
    return (
      <div className="flex items-start gap-2 rounded-[10px] border border-warning-border bg-warning-surface px-3 py-2 text-[12px] leading-relaxed text-warning">
        <Icon name="info" size={14} className="mt-0.5 flex-none" />
        <span>
          No brand profile was readable when this ran, so it was {what} generically rather
          than for your business. Fill in Settings → Brand and the next run will be specific.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-subtle">
      <Icon name="check" size={13} className="mt-0.5 flex-none text-brand" />
      <span>
        {grounding.brand
          ? `${what.charAt(0).toUpperCase()}${what.slice(1)} for ${grounding.brand}, from your brand profile.`
          : `${what.charAt(0).toUpperCase()}${what.slice(1)} from your brand profile.`}
      </span>
    </div>
  );
}

/** Where it lands: the channel, the recipient, the subject line. */
function Fields({ action }: { action: PreviewAction }) {
  return (
    <dl className="flex flex-col gap-1 border-t border-line pt-2.5">
      {action.fields.map((field) => (
        <div key={field.label} className="flex items-baseline gap-2 text-[12px]">
          <dt className="flex-none text-ink-subtle">{field.label}</dt>
          <dd className="min-w-0 flex-1 truncate text-right font-medium text-ink-muted">
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ icon, children }: { icon: "git-branch"; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[10px] bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-subtle">
      <Icon name={icon} size={14} className="mt-0.5 flex-none" />
      <span>{children}</span>
    </div>
  );
}

function AppMark({ app }: { app: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!app || broken) {
    return (
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-brand-subtle text-brand">
        <Icon name="send" size={13} />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={toolkitLogo(app)}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      onError={() => setBroken(true)}
      className="h-6 w-6 flex-none rounded-[7px] border border-line bg-card object-contain p-0.5"
    />
  );
}
