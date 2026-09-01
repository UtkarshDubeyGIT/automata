"use client";

import { ArrowRight, Clock3 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ServiceIcon } from "@/components/service-icon";
import type { WorkflowTemplate } from "@/lib/workflows/templates";

type TemplateCard = WorkflowTemplate & { appBadges: Array<{ slug: string }> };

export function TemplateGrid({ templates }: { templates: TemplateCard[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  async function instantiateTemplate(templateId: string) {
    setPending(templateId); setNotice("");
    try {
      const response = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId }) });
      const body = await response.json() as { workflow?: { id: string }; error?: string };
      if (!response.ok || !body.workflow) throw new Error(body.error ?? "Template could not be created.");
      router.push(`/app/workflows/${body.workflow.id}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Template could not be created."); setPending(null); }
  }
  return <>{notice ? <p className="auth-alert preview integration-notice" role="status">{notice}</p> : null}<section className="app-template-grid">{templates.map((template) => <article className="app-template-card" key={template.id}><div className="app-template-meta"><span>{template.category}</span><small><Clock3 size={11} />{template.setupMinutes} min setup</small></div><div className="app-template-apps">{template.appBadges.map((app) => <ServiceIcon key={app.slug} slug={app.slug} />)}</div><h2>{template.name}</h2><p>{template.description}</p><footer><span>{Object.keys(template.graph.steps).length} modules</span><button disabled={pending === template.id} onClick={() => instantiateTemplate(template.id)}>{pending === template.id ? "Creating…" : "Use template"}<ArrowRight size={13} /></button></footer></article>)}</section></>;
}
