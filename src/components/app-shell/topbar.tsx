import Link from "next/link";

import { ProductIcon } from "@/components/ui/product-icon";

export function Topbar() {
  return (
    <header className="app-topbar">
      <label className="global-search">
        <ProductIcon name="search" size={16} />
        <input aria-label="Search" placeholder="Search automations, runs, and apps…" />
        <kbd>⌘ K</kbd>
      </label>
      <div className="topbar-actions">
        <Link className="topbar-create" href="/app/workflows"><ProductIcon name="plus" size={16} /><span>Create automation</span></Link>
        <a className="topbar-help" href="mailto:support@automata.local"><ProductIcon name="help" size={17} /><span>Help</span></a>
        <button aria-label="Notifications"><ProductIcon name="bell" /><b>2</b></button>
        <button className="topbar-avatar" aria-label="Account menu">AD</button>
      </div>
    </header>
  );
}
