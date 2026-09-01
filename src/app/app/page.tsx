import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, Clock3, MoreHorizontal, Play, Plus, TriangleAlert, Zap } from "lucide-react";
import Link from "next/link";

const automations = [
  { name: "Daily pipeline digest", detail: "HubSpot → AI → Approval → Slack", runs: "148", success: "99.3%", last: "8 min ago", status: "Active", tone: "blue" },
  { name: "Shopify order alerts", detail: "Shopify → Format → WhatsApp", runs: "86", success: "100%", last: "21 min ago", status: "Active", tone: "green" },
  { name: "Urgent issue triage", detail: "GitHub → AI → Filter → Slack", runs: "41", success: "97.6%", last: "1 hr ago", status: "Active", tone: "dark" },
  { name: "Lead capture", detail: "Webhook → HubSpot → Slack", runs: "312", success: "98.9%", last: "2 hrs ago", status: "Needs setup", tone: "coral" },
];

const runs = [
  { name: "Daily pipeline digest", time: "09:00:02", duration: "2.8s", credits: 3, status: "Succeeded" },
  { name: "Shopify order alerts", time: "08:47:21", duration: "1.4s", credits: 2, status: "Succeeded" },
  { name: "Urgent issue triage", time: "08:15:43", duration: "4.1s", credits: 3, status: "Waiting" },
  { name: "Lead capture", time: "07:54:10", duration: "0.9s", credits: 1, status: "Failed" },
];

export default function DashboardPage() {
  return (
    <main className="app-page dashboard-page">
      <header className="page-title-row">
        <div><span className="page-kicker">Monday, 31 August</span><h1>Good morning, Alex</h1><p>Here is what your systems handled while you were away.</p></div>
        <Link className="button button-primary" href="/app/workflows/new"><Plus size={17} />Create automation</Link>
      </header>

      <section className="metric-grid" aria-label="Automation summary">
        <article><span>Active automations</span><div><b>12</b><small className="up"><ArrowUpRight size={13} />2 this month</small></div><i className="metric-spark spark-blue" /></article>
        <article><span>Runs this month</span><div><b>1,284</b><small className="up"><ArrowUpRight size={13} />18.4%</small></div><i className="metric-spark spark-green" /></article>
        <article><span>Success rate</span><div><b>98.7%</b><small className="down"><ArrowDownRight size={13} />0.2%</small></div><i className="metric-spark spark-amber" /></article>
        <article><span>Time returned</span><div><b>46.2h</b><small>this month</small></div><i className="metric-spark spark-coral" /></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel activity-panel">
          <header className="panel-header"><div><h2>Execution pulse</h2><p>Module runs over the last 14 days</p></div><button>14 days</button></header>
          <div className="activity-chart" aria-label="Execution activity chart">
            {[38, 52, 46, 71, 63, 78, 68, 83, 75, 91, 84, 96, 88, 100].map((height, index) => <i key={index} style={{ height: `${height}%` }}><em style={{ height: index > 9 ? "18%" : "9%" }} /></i>)}
          </div>
          <div className="chart-axis"><span>18 Aug</span><span>22 Aug</span><span>26 Aug</span><span>31 Aug</span></div>
          <footer><span><i className="legend blue" />Succeeded <b>1,241</b></span><span><i className="legend coral" />Failed <b>17</b></span><span><i className="legend amber" />Waiting <b>26</b></span></footer>
        </article>
        <article className="panel attention-panel">
          <header className="panel-header"><div><h2>Needs attention</h2><p>Two decisions are holding work</p></div><span className="attention-count">2</span></header>
          <div className="attention-item"><span className="attention-icon"><Clock3 size={17} /></span><div><b>Post daily pipeline digest?</b><small>Daily pipeline digest · 8 min ago</small></div><Link href="/app/approvals">Review</Link></div>
          <div className="attention-item"><span className="attention-icon warning"><TriangleAlert size={17} /></span><div><b>Reconnect HubSpot</b><small>Lead capture paused · 2 hrs ago</small></div><Link href="/app/integrations">Fix</Link></div>
          <Link className="panel-link" href="/app/approvals">Open approval inbox <ArrowRight size={15} /></Link>
        </article>
      </section>

      <section className="panel workflows-panel">
        <header className="panel-header"><div><h2>Active automations</h2><p>Your most recently active workflows</p></div><Link href="/app/workflows">View all <ArrowRight size={14} /></Link></header>
        <div className="workflow-table">
          <div className="workflow-table-head"><span>Automation</span><span>Runs</span><span>Success</span><span>Last run</span><span>Status</span><span /></div>
          {automations.map((workflow) => <Link className="workflow-row" href="/app/workflows/daily-pipeline-digest" key={workflow.name}>
            <div className="workflow-name"><i className={workflow.tone}><Zap size={16} /></i><span><b>{workflow.name}</b><small>{workflow.detail}</small></span></div>
            <span>{workflow.runs}</span><span>{workflow.success}</span><span>{workflow.last}</span><span><em className={workflow.status === "Active" ? "status-active" : "status-warning"}>{workflow.status}</em></span><MoreHorizontal size={17} />
          </Link>)}
        </div>
      </section>

      <section className="panel runs-panel">
        <header className="panel-header"><div><h2>Recent runs</h2><p>Every execution, outcome, and credit</p></div><Link href="/app/runs">Open history <ArrowRight size={14} /></Link></header>
        <div className="run-list">
          {runs.map((run) => <div className="run-row" key={`${run.name}-${run.time}`}><i className={`run-state ${run.status.toLowerCase()}`}>{run.status === "Succeeded" ? <Check size={14} /> : run.status === "Waiting" ? <Clock3 size={14} /> : <TriangleAlert size={14} />}</i><div><b>{run.name}</b><small>Today at {run.time}</small></div><span>{run.duration}</span><span>{run.credits} credits</span><em>{run.status}</em><button aria-label={`Open ${run.name} run`}><Play size={14} /></button></div>)}
        </div>
      </section>
    </main>
  );
}
