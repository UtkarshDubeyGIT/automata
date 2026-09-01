import { Bell, CircleHelp, Plus, Search } from "lucide-react";
import Link from "next/link";

export function Topbar() {
  return (
    <header className="app-topbar">
      <label className="global-search"><Search size={16} /><input aria-label="Search" placeholder="Search automations, runs, and apps…" /><kbd>⌘ K</kbd></label>
      <div className="topbar-actions"><Link className="topbar-create" href="/app/workflows"><Plus size={16} />Create automation</Link><a className="topbar-help" href="mailto:support@automata.local"><CircleHelp size={17} />Help</a><button aria-label="Notifications"><Bell size={18} /><b>2</b></button><button className="topbar-avatar" aria-label="Account menu">AD</button></div>
    </header>
  );
}
