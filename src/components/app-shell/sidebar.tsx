"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo } from "@/components/logo";
import { ProductIcon, type ProductIconName } from "@/components/ui/product-icon";

const workspaceNavigation = [
  { href: "/app", label: "Dashboard", icon: "dashboard" },
  { href: "/app/workflows", label: "Automations", icon: "blocks" },
  { href: "/app/runs", label: "Runs", icon: "history" },
  { href: "/app/approvals", label: "Needs attention", icon: "inbox" },
] satisfies Array<{ href: string; label: string; icon: ProductIconName }>;

const libraryNavigation = [
  { href: "/app/integrations", label: "Connections", icon: "cable" },
  { href: "/app/templates", label: "Templates", icon: "template" },
] satisfies Array<{ href: string; label: string; icon: ProductIconName }>;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="app-sidebar simple-sidebar">
      <div className="simple-sidebar-logo">
        <Logo />
      </div>

      <Link className="sidebar-primary-action" href="/app/workflows">
        <ProductIcon name="plus" size={17} />
        <span>New automation</span>
      </Link>

      <SidebarSection label="Workspace" items={workspaceNavigation} pathname={pathname} />
      <SidebarSection label="Library" items={libraryNavigation} pathname={pathname} />

      <div className="simple-sidebar-bottom">
        <Link className="simple-usage" href="/app/billing">
          <span>Credits remaining</span>
          <strong>31,842</strong>
          <i aria-hidden="true"><span /></i>
        </Link>
        <nav aria-label="Workspace and support">
          <Link className={pathname.startsWith("/app/settings") ? "active" : ""} href="/app/settings">
            <ProductIcon name="settings" />
            <span>Settings</span>
          </Link>
          <a href="mailto:support@automata.local">
            <ProductIcon name="help" />
            <span>Help</span>
          </a>
        </nav>
        <button className="sidebar-account" type="button" aria-label="Open account menu">
          <span>AD</span>
          <div><b>Alex Dubey</b><small>Workspace owner</small></div>
        </button>
      </div>
    </aside>
  );
}

function SidebarSection({ label, items, pathname }: {
  label: string;
  items: Array<{ href: string; label: string; icon: ProductIconName }>;
  pathname: string;
}) {
  return (
    <section className="sidebar-nav-section">
      <span className="sidebar-section-label">{label}</span>
      <nav className="simple-sidebar-nav" aria-label={label}>
        {items.map((item) => {
          const active = item.href === "/app"
            ? pathname === "/app"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <Link className={active ? "active" : ""} href={item.href as Route} key={item.href}>
              <ProductIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </section>
  );
}
