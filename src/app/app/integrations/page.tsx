import { Search, ShieldCheck, Star } from "lucide-react";

import { IntegrationGrid } from "@/components/integrations/integration-grid";
import { INTEGRATIONS } from "@/lib/integrations/catalog";

export default function IntegrationsPage() {
  return <main className="app-page catalog-page">
    <header className="page-title-row connections-title"><div><span className="page-kicker">Workspace</span><h1>Connections</h1><p>Connect the services Automata can read from and act on.</p></div><span className="security-note"><ShieldCheck size={15} />Credentials never reach the browser</span></header>
    <div className="connections-search-row"><label><Search size={19} /><input aria-label="Search integrations" placeholder="Search integrations" /></label></div>
    <div className="catalog-toolbar integrations-toolbar"><div>{["All", "Connected", "Google", "Communication", "Data", "Sales"].map((category, index) => <button className={index === 0 ? "active" : ""} key={category}>{category}</button>)}</div></div>
    <section className="connections-catalog" aria-labelledby="available-connections-heading">
      <header className="catalog-section-heading"><div><Star size={21} /><h2 id="available-connections-heading">Available connections</h2></div><span>{INTEGRATIONS.length} verified services</span></header>
      <IntegrationGrid integrations={INTEGRATIONS} />
    </section>
  </main>;
}
