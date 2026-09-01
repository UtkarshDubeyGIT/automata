import { Search, ShieldCheck } from "lucide-react";

import { IntegrationGrid } from "@/components/integrations/integration-grid";
import { INTEGRATIONS } from "@/lib/integrations/catalog";

export default function IntegrationsPage() {
  return <main className="app-page catalog-page">
    <header className="page-title-row"><div><span className="page-kicker">Workspace</span><h1>Connections</h1><p>Accounts are isolated to this workspace and handled through Composio.</p></div><span className="security-note"><ShieldCheck size={15} />Credentials never reach the browser</span></header>
    <div className="catalog-toolbar integrations-toolbar"><label><Search size={16} /><input placeholder="Search 13 verified services" /></label><div>{["All", "Connected", "Google", "Communication", "Data", "Sales"].map((category, index) => <button className={index === 0 ? "active" : ""} key={category}>{category}</button>)}</div></div>
    <IntegrationGrid integrations={INTEGRATIONS} />
  </main>;
}
