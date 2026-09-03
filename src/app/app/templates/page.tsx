import { ArrowRight, Search, Sparkles } from "lucide-react";
import Link from "next/link";

import { TemplateGrid } from "@/components/workflow/template-grid";
import { TEMPLATES } from "@/lib/workflows/templates";

export default function TemplatesPage() {
  return <main className="app-page catalog-page">
    <header className="page-title-row"><div><span className="page-kicker">Quick starts</span><h1>Templates</h1><p>Begin with a verified process, then make every module yours.</p></div></header>
    <section className="catalog-hero"><div><Sparkles size={20} /><span><b>Describe what should move</b><small>AI can draft a workflow using only verified modules.</small></span></div><Link className="button button-primary" href="/app/workflows/new">Build with AI <ArrowRight size={16} /></Link></section>
    <div className="catalog-toolbar"><label><Search size={16} /><input placeholder="Search templates or apps" /></label><div>{["All", "Lead management", "Communication", "Data sync", "Commerce", "Content"].map((category, index) => <button className={index === 0 ? "active" : ""} key={category}>{category}</button>)}</div></div>
    <TemplateGrid templates={TEMPLATES.map((template) => ({ ...template, appBadges: (template.apps ?? (template.app ? [template.app] : [])).map((slug: string) => ({ slug })) }))} />
  </main>;
}
