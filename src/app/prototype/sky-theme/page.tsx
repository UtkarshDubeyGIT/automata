import {
  ArrowRight,
  Bell,
  Blocks,
  Cable,
  Check,
  CircleHelp,
  Clock3,
  FileClock,
  Gauge,
  LayoutTemplate,
  Plus,
  Search,
  Settings,
  Sparkles,
  TriangleAlert,
  Zap,
} from "lucide-react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";
import styles from "./sky-theme.module.css";

// PROTOTYPE: Three full-shell sky-blue directions, switchable with ?variant=A|B|C.
const variants = [
  { key: "A", name: "Clear sky" },
  { key: "B", name: "Blue hour" },
  { key: "C", name: "Open horizon" },
];

const nav = [
  [Gauge, "Dashboard"],
  [Blocks, "Automations"],
  [Cable, "Connections"],
  [LayoutTemplate, "Templates"],
  [FileClock, "Runs"],
] as const;

const bars = [42, 56, 49, 73, 65, 80, 72, 88, 78, 94, 87, 100];
const workflows = [
  ["Daily pipeline digest", "HubSpot → AI → Slack", "8 min ago", "Healthy"],
  ["Shopify order alerts", "Shopify → WhatsApp", "21 min ago", "Healthy"],
  ["Urgent issue triage", "GitHub → AI → Slack", "1 hr ago", "Review"],
] as const;

function Mark() {
  return <span className={styles.mark}><i /><i /><i /></span>;
}

function NavItems() {
  return <>{nav.map(([Icon, label], index) => <button className={index === 0 ? styles.active : ""} key={label}><Icon size={18} /><span>{label}</span></button>)}</>;
}

function MiniChart() {
  return <div className={styles.chart}>{bars.map((height, index) => <i key={index} style={{ height: `${height}%` }}><em style={{ height: index > 8 ? "14%" : "7%" }} /></i>)}</div>;
}

function Metrics() {
  return <div className={styles.metrics}>
    <article><span>Active automations</span><b>12</b><small>↑ 2 this month</small></article>
    <article><span>Runs this month</span><b>1,284</b><small>↑ 18.4%</small></article>
    <article><span>Success rate</span><b>98.7%</b><small>Last 30 days</small></article>
    <article><span>Time returned</span><b>46.2h</b><small>This month</small></article>
  </div>;
}

function WorkflowList() {
  return <div className={styles.workflowList}>{workflows.map(([name, path, time, status], index) => <div key={name}>
    <span className={styles.workflowIcon}><Zap size={15} /></span>
    <span><b>{name}</b><small>{path}</small></span>
    <time>{time}</time>
    <em className={index === 2 ? styles.review : ""}>{status}</em>
    <ArrowRight size={15} />
  </div>)}</div>;
}

function VariantA() {
  return <div className={`${styles.shell} ${styles.clearSky}`}>
    <aside>
      <a className={styles.brand}><Mark /><b>Automata</b></a>
      <nav><NavItems /></nav>
      <div className={styles.asideBottom}><div className={styles.credits}><span>Credits remaining</span><b>31,842</b><i><em /></i></div><button><Settings size={18} /><span>Settings</span></button><button><CircleHelp size={18} /><span>Help</span></button></div>
    </aside>
    <section className={styles.workspace}>
      <header><label><Search size={17} /><input placeholder="Search automations, runs, and apps…" /></label><button className={styles.create}><Plus size={16} />Create automation</button><Bell size={19} /><span className={styles.avatar}>AD</span></header>
      <main>
        <div className={styles.greeting}><span>Monday, 31 August</span><h1>Good morning, Alex</h1><p>Here is what your systems handled while you were away.</p></div>
        <Metrics />
        <div className={styles.mainGrid}><article className={styles.panel}><div className={styles.panelHead}><span><b>Execution pulse</b><small>Module runs over the last 14 days</small></span><button>14 days</button></div><MiniChart /><footer><span><i />Succeeded <b>1,241</b></span><span><i />Failed <b>17</b></span></footer></article><article className={`${styles.panel} ${styles.attention}`}><div className={styles.panelHead}><span><b>Needs attention</b><small>Two decisions are holding work</small></span><strong>2</strong></div><div><Clock3 size={18} /><span><b>Post daily digest?</b><small>8 minutes ago</small></span><button>Review</button></div><div><TriangleAlert size={18} /><span><b>Reconnect HubSpot</b><small>2 hours ago</small></span><button>Fix</button></div></article></div>
        <article className={styles.panel}><div className={styles.panelHead}><span><b>Active automations</b><small>Your most recently active workflows</small></span><button>View all</button></div><WorkflowList /></article>
      </main>
    </section>
  </div>;
}

function VariantB() {
  return <div className={`${styles.shell} ${styles.blueHour}`}>
    <aside>
      <a className={styles.brand}><Mark /><b>Automata</b></a>
      <span className={styles.navLabel}>Workspace</span><nav><NavItems /></nav>
      <div className={styles.asideBottom}><div className={styles.bluePlan}><Sparkles size={18} /><span><b>Team plan</b><small>31,842 credits left</small></span></div><button><Settings size={18} /><span>Settings</span></button><span className={styles.user}><i>AD</i><span><b>Alex Dubey</b><small>Acme Operations</small></span></span></div>
    </aside>
    <section className={styles.workspace}>
      <header><span className={styles.mobileBrand}><Mark />Automata</span><label><Search size={17} /><input placeholder="Find anything…" /></label><CircleHelp size={18} /><Bell size={18} /><span className={styles.avatar}>AD</span></header>
      <main>
        <div className={styles.commandHero}><span><small>Monday, 31 August</small><h1>Your operations are on track.</h1><p>1,284 runs completed this month with a 98.7% success rate.</p></span><button><Plus size={17} />New automation</button></div>
        <div className={styles.blueGrid}><article className={styles.pulseCard}><div className={styles.panelHead}><span><b>Live execution pulse</b><small>Last 14 days</small></span><em>● Systems healthy</em></div><strong>1,284 <small>runs this month</small></strong><MiniChart /></article><article className={styles.statsStack}><div><span>Time returned</span><b>46.2 hours</b><small>Equivalent to 5.8 workdays</small></div><div><span>Needs attention</span><b>2 decisions</b><button>Review now <ArrowRight size={14} /></button></div></article></div>
        <div className={styles.focusRow}><article><span className={styles.sectionTitle}><b>Active work</b><button>All automations</button></span><WorkflowList /></article><aside className={styles.activityFeed}><span className={styles.sectionTitle}><b>Now</b><small>Live</small></span><div><Check size={15} /><span><b>Pipeline digest sent</b><small>8 min ago · 3 credits</small></span></div><div><Check size={15} /><span><b>Order alert delivered</b><small>21 min ago · 2 credits</small></span></div><div><Clock3 size={15} /><span><b>Triage waiting for review</b><small>1 hr ago · no charge</small></span></div></aside></div>
      </main>
    </section>
  </div>;
}

function VariantC() {
  return <div className={`${styles.shell} ${styles.horizon}`}>
    <header className={styles.horizonHeader}><a className={styles.brand}><Mark /><b>Automata</b></a><nav><NavItems /></nav><span className={styles.horizonActions}><Search size={18} /><Bell size={18} /><i>AD</i></span></header>
    <main>
      <section className={styles.horizonIntro}><span><small>Monday, 31 August</small><h1>Good morning, Alex.</h1><p>Your systems returned <b>46.2 hours</b> to the team this month.</p></span><button><Plus size={17} />Create automation</button></section>
      <section className={styles.horizonBand}><div><span>Runs this month</span><b>1,284</b><small>18.4% more than July</small></div><div><span>Success rate</span><b>98.7%</b><small>Across 12 automations</small></div><div><span>Waiting on you</span><b>2</b><small>One approval, one connection</small></div></section>
      <section className={styles.horizonBody}><article className={styles.horizonPulse}><span className={styles.panelHead}><span><b>Work moving through Automata</b><small>A clear view of the last 14 days</small></span><button>View run history</button></span><MiniChart /></article><article className={styles.nextDecision}><small>Next decision</small><Clock3 size={22} /><h2>Post daily pipeline digest?</h2><p>Prepared 8 minutes ago from 14 updated HubSpot deals.</p><span><button>Review draft</button><button>Approve</button></span></article></section>
      <section className={styles.horizonWorkflows}><span className={styles.sectionTitle}><b>Running quietly</b><button>Manage automations <ArrowRight size={14} /></button></span><WorkflowList /></section>
    </main>
  </div>;
}

export default async function SkyThemePrototype({ searchParams }: { searchParams: Promise<{ variant?: string }> }) {
  const requested = (await searchParams).variant?.toUpperCase();
  const current = variants.some((variant) => variant.key === requested) ? requested! : "A";
  return <><div className={styles.prototype}>{current === "A" ? <VariantA /> : current === "B" ? <VariantB /> : <VariantC />}</div><PrototypeSwitcher variants={variants} current={current} /></>;
}
