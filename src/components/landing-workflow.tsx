import { ShieldCheck } from "lucide-react";

import { ServiceIcon } from "@/components/service-icon";

const modules = [
  { key: "sheet", label: "New lead", app: "Google Sheets", tone: "green", slug: "googlesheets" },
  { key: "ai", label: "Qualify lead", app: "OpenAI", tone: "blue", slug: "openai" },
  { key: "approval", label: "Human review", app: "Approval", tone: "amber", slug: undefined },
  { key: "hubspot", label: "Create contact", app: "HubSpot", tone: "coral", slug: "hubspot" },
];

export function LandingWorkflow() {
  return (
    <div className="hero-workflow" data-testid="hero-workflow" aria-label="Example lead workflow">
      <div className="canvas-topline">
        <div><span className="live-dot" /> Lead routing · Active</div>
        <span>Last run 18s ago</span>
      </div>
      <div className="workflow-rail" aria-hidden="true">
        <span className="rail-progress" />
        <span className="rail-packet packet-one" />
        <span className="rail-packet packet-two" />
      </div>
      <div className="hero-modules">
        {modules.map((module) => (
          <article className="hero-module" key={module.key}>
            {module.slug ? <ServiceIcon className="module-service-icon" slug={module.slug} label={module.app} /> : <div className={`module-icon ${module.tone}`}><ShieldCheck size={17} /></div>}
            <div>
              <span>{module.app}</span>
              <strong>{module.label}</strong>
            </div>
            <small>{module.key === "approval" ? "Required" : module.key === "hubspot" ? "1 credit" : "Done"}</small>
          </article>
        ))}
      </div>
      <div className="canvas-footer">
        <span>4 modules</span>
        <span>Completed in 2.4s</span>
        <b>3 credits</b>
      </div>
    </div>
  );
}
