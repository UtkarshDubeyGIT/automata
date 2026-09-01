"use client";

import {
  Blocks,
  Cable,
  ChevronDown,
  CircleHelp,
  CreditCard,
  FileClock,
  Gauge,
  LayoutTemplate,
  Plus,
  Settings,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo } from "@/components/logo";

const railNav = [
  { href: "/app", label: "Org", icon: Gauge },
  { href: "/app/workflows", label: "Automations", icon: Blocks },
  { href: "/app/integrations", label: "Connections", icon: Cable },
  { href: "/app/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/app/runs", label: "Runs", icon: FileClock },
];

type ContextItem = { href: string; label: string; icon: typeof Gauge; badge?: string };

function contextFor(pathname: string): { title: string; eyebrow: string; items: ContextItem[]; utility?: ContextItem[] } {
  if (pathname.startsWith("/app/workflows") || pathname.startsWith("/app/runs") || pathname.startsWith("/app/approvals")) {
    return {
      title: "Automations",
      eyebrow: "Build & monitor",
      items: [
        { href: "/app/workflows", label: "Automation home", icon: Blocks },
        { href: "/app/runs", label: "Run history", icon: FileClock },
        { href: "/app/approvals", label: "Needs attention", icon: ShieldCheck, badge: "2" },
      ],
      utility: [
        { href: "/app/templates", label: "Browse templates", icon: LayoutTemplate },
        { href: "/app/integrations", label: "Manage connections", icon: Cable },
      ],
    };
  }
  if (pathname.startsWith("/app/templates")) {
    return {
      title: "Templates",
      eyebrow: "Quick starts",
      items: [
        { href: "/app/templates", label: "Public templates", icon: LayoutTemplate },
        { href: "/app/workflows", label: "My automations", icon: Blocks },
      ],
    };
  }
  if (pathname.startsWith("/app/integrations")) {
    return {
      title: "Connections",
      eyebrow: "Apps & endpoints",
      items: [
        { href: "/app/integrations", label: "Installed apps", icon: Cable },
        { href: "/app/integrations#webhooks", label: "Webhooks", icon: Webhook },
      ],
      utility: [{ href: "/app/settings", label: "Connection settings", icon: Settings }],
    };
  }
  if (pathname.startsWith("/app/billing")) {
    return {
      title: "Plan & usage",
      eyebrow: "Account",
      items: [
        { href: "/app/billing", label: "Credit usage", icon: Gauge },
        { href: "/app/billing#plan", label: "Subscription", icon: CreditCard },
      ],
    };
  }
  return {
    title: "Organization",
    eyebrow: "Acme Operations",
    items: [
      { href: "/app", label: "Dashboard", icon: Gauge },
      { href: "/app/members", label: "Members", icon: Users },
      { href: "/app/settings", label: "Workspace settings", icon: Settings },
    ],
    utility: [{ href: "/app/billing", label: "Usage & billing", icon: CreditCard }],
  };
}

export function Sidebar() {
  const pathname = usePathname();
  const context = contextFor(pathname);

  return (
    <aside className="app-sidebar">
      <div className="app-icon-rail">
        <div className="rail-logo"><Logo compact /></div>
        <nav aria-label="Product areas">
          {railNav.map((item) => {
            const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href) || (item.href === "/app/workflows" && pathname.startsWith("/app/approvals"));
            return <Link className={active ? "active" : ""} href={item.href as Route} key={item.href} title={item.label}><item.icon size={20} /><span>{item.label}</span></Link>;
          })}
        </nav>
        <Link className="rail-help" href="mailto:support@automata.local" title="Help"><CircleHelp size={19} /><span>Help</span></Link>
      </div>

      <div className="app-context-panel">
        <button className="context-workspace">
          <span>AO</span>
          <div><b>Acme Operations</b><small>Team plan</small></div>
          <ChevronDown size={14} />
        </button>
        <header><small>{context.eyebrow}</small><h2>{context.title}</h2></header>
        {context.title === "Automations" ? <Link className="context-create" href="/app/workflows"><Plus size={15} />Create automation</Link> : null}
        <nav className="context-nav" aria-label={`${context.title} navigation`}>
          {context.items.map((item) => {
            const active = item.href.includes("#") ? false : item.href === "/app" ? pathname === "/app" : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return <Link className={active ? "active" : ""} href={item.href as Route} key={item.href}><item.icon size={15} /><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</Link>;
          })}
        </nav>
        {context.utility?.length ? <><div className="context-divider" /><span className="context-label">Utilities</span><nav className="context-nav">{context.utility.map((item) => <Link href={item.href as Route} key={item.href}><item.icon size={15} /><span>{item.label}</span></Link>)}</nav></> : null}
        <div className="context-bottom">
          <div className="context-credit"><span><b>31,842</b><small>credits left</small></span><em>79%</em><i><span style={{ width: "79%" }} /></i></div>
          <button className="context-user"><span>AD</span><div><b>Alex Dubey</b><small>alex@acme.co</small></div><ChevronDown size={14} /></button>
        </div>
      </div>
    </aside>
  );
}
