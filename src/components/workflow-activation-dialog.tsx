"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";

/** A final, explicit handoff before a paused automation starts running live. */
export function WorkflowActivationDialog({
  open,
  name,
  externalActions,
  onClose,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  name: string;
  externalActions: string[];
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const hasExternalActions = externalActions.length > 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start this automation?"
      subtitle={`“${name}” will begin running on its trigger or schedule.`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button icon="play" onClick={onConfirm} loading={busy}>
            Start automation
          </Button>
        </>
      }
    >
      {hasExternalActions ? (
        <div className="rounded-control border border-warning-border bg-warning-surface px-3.5 py-3 text-[13px] text-ink">
          <div className="flex items-center gap-2 font-semibold text-warning">
            <Icon name="info" size={15} />
            This automation can take actions outside Automata.
          </div>
          <ul className="mt-2 space-y-1 pl-5 text-ink-subtle">
            {externalActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-subtle">
          No external messages or provider writes are currently configured.
        </p>
      )}
    </Dialog>
  );
}
