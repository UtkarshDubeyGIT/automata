"use client";

import { Check, Clock3, ExternalLink, Inbox, X } from "lucide-react";
import { useState } from "react";

export interface ApprovalItem {
  id: string;
  workflow: string;
  prompt: string;
  preview: unknown;
  requestedAt: string;
}

export function ApprovalInbox({ initial }: { initial: ApprovalItem[] }) {
  const [items, setItems] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  async function decide(id: string, decision: "approved" | "rejected") {
    if (id.startsWith("preview-")) { setNotice("Connect Supabase to make approval decisions."); return; }
    setPending(id); setNotice("");
    try {
      const response = await fetch(`/api/approvals/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Decision could not be saved.");
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Decision could not be saved."); }
    finally { setPending(null); }
  }
  return <section><div className="approval-tabs"><button className="active">Waiting <b>{items.length}</b></button><button>Decided</button></div>{notice ? <p className="auth-alert preview integration-notice" role="status">{notice}</p> : null}{items.map((approval) => <article className="approval-inbox-card" key={approval.id}><header><div className="approval-app-icon"><Inbox size={17} /></div><div><b>{approval.workflow}</b><small><Clock3 size={10} />Requested {new Date(approval.requestedAt).toLocaleString()}</small></div><span>Waiting</span></header><div className="approval-inbox-body"><div className="approval-action-line"><span><small>Decision</small><b>{approval.prompt}</b></span><span><small>Run state</small><b>Paused safely</b></span><span><small>After approval</small><b>Resume live run</b></span></div><blockquote>{typeof approval.preview === "string" ? approval.preview : JSON.stringify(approval.preview)}</blockquote><a href="/app/runs">Open run history <ExternalLink size={12} /></a></div><footer><button disabled={pending === approval.id} onClick={() => decide(approval.id, "rejected")}><X size={14} />Reject</button><button disabled={pending === approval.id} className="approve" onClick={() => decide(approval.id, "approved")}><Check size={14} />{pending === approval.id ? "Continuing…" : "Approve and continue"}</button></footer></article>)}{items.length === 0 ? <div className="empty-state"><Check size={22} /><b>Nothing is waiting</b><span>Automata will put external actions here when a workflow needs your decision.</span></div> : null}</section>;
}
