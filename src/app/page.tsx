import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Inbox,
  MousePointer2,
  Pause,
  Play,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { LandingWorkflow } from "@/components/landing-workflow";
import { Logo } from "@/components/logo";
import { ServiceIcon } from "@/components/service-icon";
import { PLANS } from "@/lib/billing/plans";
import { INTEGRATIONS } from "@/lib/integrations/catalog";
import { TEMPLATES } from "@/lib/workflows/templates";

const frequentlyAsked = [
  {
    question: "what is automata?",
    answer:
      "Automata is a visual workspace for connecting the tools your team already uses. Describe a process, start from a template, or build it module by module—then watch every run from one place.",
  },
  {
    question: "will it take actions without asking me?",
    answer:
      "No. AI-created workflows place an approval before external writes unless you explicitly choose unattended execution. You can inspect the exact message, record, or request before it leaves.",
  },
  {
    question: "can I move my Make workflows here?",
    answer:
      "The MVP focuses on rebuilding your highest-value scenarios with familiar triggers, routers, filters, actions, webhooks, and run logs. Template-assisted migration is on the roadmap.",
  },
  {
    question: "does run once use real data?",
    answer:
      "Yes. Run once uses connected accounts and live payloads. Before a write action, Automata shows a clear preflight so a test cannot quietly change production data.",
  },
  {
    question: "which apps work today?",
    answer:
      "The MVP starts with the services teams reach for most: Google Sheets, Gmail, Slack, Notion, HubSpot, Shopify, Telegram, WhatsApp, OpenAI, and generic HTTP and webhook modules.",
  },
];

const deskCards = [
  { className: "desk-card desk-card-sheet", label: "trigger.payload", detail: "new paid order", tone: "#16a46c", mark: "GS", slug: "googlesheets" },
  { className: "desk-card desk-card-approval", label: "approval needed", detail: "message operations?", tone: "#f06f52", mark: "✓", slug: undefined },
  { className: "desk-card desk-card-run", label: "run 2,184", detail: "finished in 2.4s", tone: "#6256d9", mark: "↗", slug: undefined },
];

export default function LandingPage() {
  return (
    <main className="marketing-shell automata-site">
      <nav className="world-nav">
        <div className="world-nav-links" aria-label="Primary navigation">
          <Logo />
          <a href="#product">product</a>
          <a href="#templates">templates</a>
          <a href="#pricing">pricing</a>
          <a href="#questions">questions</a>
        </div>
        <div className="world-nav-symbol"><Logo compact /></div>
        <div className="world-nav-actions">
          <Link href="/login">sign in</Link>
          <Link className="world-get-started" href="/signup">get automata <ArrowRight size={15} /></Link>
        </div>
      </nav>

      <section className="world-hero" id="product">
        <div className="desk-grid" aria-hidden="true" />
        <span className="desk-scribble scribble-one">{`{ ᴗ_ᴗ }`}</span>
        <span className="desk-scribble scribble-two">one less tab →</span>
        <span className="desk-scribble scribble-three">↳ still moving</span>
        <div className="desk-inbox inbox-one"><span><Inbox size={29} /></span>email inbox</div>
        <div className="desk-inbox done-one"><span><Check size={27} /></span>done</div>
        {deskCards.map((card) => (
          <article className={card.className} key={card.label}>
            <div className="mini-window-bar"><i /><i /><i /><span>automata</span></div>
            <div className="desk-card-body">
              {card.slug ? <ServiceIcon slug={card.slug} label="Google Sheets" /> : <b style={{ background: card.tone }}>{card.mark}</b>}
              <div><small>{card.label}</small><strong>{card.detail}</strong></div>
            </div>
          </article>
        ))}

        <div className="hero-center">
          <span className="hero-orbit"><i /> live automations, under your control</span>
          <h1>tell it once.<br /><em>watch work move.</em></h1>
          <p>Automata connects your tools, runs the repetition, and knows when a human should take over.</p>
          <div className="world-hero-actions">
            <Link className="aqua-button" href="/signup"><WandSparkles size={18} /> build for free</Link>
            <Link className="glass-button" href="/app/workflows/daily-pipeline-digest"><Play size={16} fill="currentColor" /> see a real run</Link>
          </div>
          <small>No card. Real run logs. Your first workflow in minutes.</small>
          <div className="hero-playground">
            <p><b>These are the services you can play with.</b> Make something useful, get things done, and give yourself the time back.</p>
            <div aria-label="Available integrations">
              {INTEGRATIONS.map((integration) => <ServiceIcon key={integration.slug} slug={integration.slug} label={integration.name} />)}
            </div>
            <span>Automation should feel so easy it becomes unavoidable.</span>
          </div>
        </div>

        <div className="hero-product-window">
          <div className="product-window-bar">
            <div className="window-lights"><i /><i /><i /></div>
            <span>lead-routing.auto</span>
            <div className="window-status"><i /> running</div>
          </div>
          <LandingWorkflow />
        </div>
      </section>

      <section className="manifesto-section">
        <span className="section-capsule">THE WORKING THEORY</span>
        <div className="folder-arc folder-arc-left" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, index) => <i key={index} />)}
        </div>
        <div className="folder-arc folder-arc-right" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, index) => <i key={index} />)}
        </div>
        <article className="notes-window">
          <div className="notes-titlebar"><span><i /><i /><i /></span><b>workflow notes</b><em>⌁</em></div>
          <div className="notes-copy">
            <p>most teams do not need more software.</p>
            <p>they need the software they already have to <mark>hand work to each other without dropping it.</mark></p>
            <p>so automata gives every process a visible beginning, a clear path, and a human place to pause.</p>
            <p>less tab-passing. fewer mystery bots.<br />more work that actually arrives done.<span className="type-caret" /></p>
            <footer><div><span>AU</span><p><b>the Automata team</b><small>building calmer operations</small></p></div><strong>automata</strong></footer>
          </div>
        </article>
        <span className="manifesto-sticker sticker-bolt">↯</span>
        <span className="manifesto-sticker sticker-mail">you&apos;ve got a run</span>
      </section>

      <section className="ways-section">
        <header className="world-section-heading">
          <span className="section-capsule">THREE WAYS IN</span>
          <h2>start where your idea is.</h2>
          <p>Plain language, a proven recipe, or a blank canvas all become the same inspectable workflow.</p>
        </header>
        <div className="ways-desktop">
          <article className="way-window way-prompt">
            <div className="mini-window-bar"><i /><i /><i /><span>describe it</span></div>
            <div className="way-content">
              <Sparkles size={22} />
              <h3>Say what should happen.</h3>
              <blockquote>“When a Shopify order lands, summarize it and ask before messaging operations on WhatsApp.”</blockquote>
              <span className="prompt-result"><i /> draft ready to inspect <ChevronRight size={15} /></span>
            </div>
          </article>
          <article className="way-window way-canvas">
            <div className="mini-window-bar"><i /><i /><i /><span>draw it</span></div>
            <div className="mini-canvas actual-canvas-preview">
              <Image priority src="/automata-workflow-canvas.png" alt="The live Automata workflow canvas showing a scheduled HubSpot pipeline digest, an AI writing step, human approval, and a Slack action" width={830} height={767} sizes="(max-width: 760px) 100vw, 46vw" />
            </div>
            <div className="way-caption"><MousePointer2 size={18} /><div><h3>Shape the route.</h3><p>Every trigger, decision, and action stays visible.</p></div></div>
          </article>
          <article className="way-window way-template">
            <div className="mini-window-bar"><i /><i /><i /><span>start proven</span></div>
            <div className="way-content">
              <div className="little-apps"><ServiceIcon slug="googlesheets" /><ServiceIcon slug="openai" /><ServiceIcon slug="whatsapp" /></div>
              <h3>Borrow the good parts.</h3>
              <p>Start with a verified recipe, connect your accounts, and change only what makes it yours.</p>
              <Link href="/app/templates">open templates <ArrowRight size={15} /></Link>
            </div>
          </article>
        </div>
      </section>

      <section className="template-library" id="templates">
        <header className="library-header">
          <div><span className="section-capsule">QUICK STARTS</span><h2>steal our best workflows.</h2></div>
          <div className="library-search">⌕ &nbsp; search by app or outcome <kbd>⌘ K</kbd></div>
        </header>
        <div className="library-chrome">
          <aside>
            <strong>templates</strong>
            <span className="active">popular now</span>
            <span>sales</span><span>operations</span><span>marketing</span><span>support</span>
            <hr />
            <Link href="/app/templates">view all <ArrowRight size={14} /></Link>
          </aside>
          <div className="public-template-grid">
            {TEMPLATES.slice(0, 8).map((template, index) => (
              <Link href={`/app/templates?template=${template.id}`} className="public-template-card" key={template.id}>
                <div className="app-stack">
                  {(template.apps ?? (template.app ? [template.app] : [])).map((slug) => {
                    const app = INTEGRATIONS.find((item) => item.slug === slug);
                    return <ServiceIcon key={slug} slug={slug} label={app?.name} />;
                  })}
                  {index === 1 && <b>AI</b>}
                </div>
                <h3>{template.name}</h3>
                <p>{template.description}</p>
                <footer><span>{template.setupMinutes ?? 4} min setup</span><ArrowRight size={15} /></footer>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="control-world">
        <header className="world-section-heading control-heading">
          <span className="section-capsule">HUMAN BY DESIGN</span>
          <h2>fast does not mean reckless.</h2>
          <p>When a workflow reaches a consequential action, Automata can put the decision back where it belongs.</p>
        </header>
        <div className="control-stage">
          <span className="control-route route-left">AI drafts</span>
          <span className="control-route route-right">then the run continues</span>
          <article className="approval-window">
            <div className="mini-window-bar"><i /><i /><i /><span>approval required</span></div>
            <div className="approval-window-body">
              <div className="approval-meta"><ServiceIcon slug="slack" label="Slack" /><div><small>post to Slack</small><b>#sales-daily</b></div><em>waiting for you</em></div>
              <blockquote>Pipeline moved by 12% this week. Three deals need an owner response today…</blockquote>
              <dl><div><dt>workspace</dt><dd>Acme operations</dd></div><div><dt>cost after approval</dt><dd>1 credit</dd></div></dl>
              <div className="approval-window-actions"><button>reject</button><button>edit</button><button>approve &amp; continue <ArrowRight size={15} /></button></div>
            </div>
          </article>
          <div className="control-proof proof-left"><ShieldCheck size={20} /><span><b>Preview every write</b>Resolved data, before it leaves.</span></div>
          <div className="control-proof proof-right"><Clock3 size={20} /><span><b>Trace every run</b>Inputs, timing, cost, outcome.</span></div>
        </div>
      </section>

      <section className="pricing-world" id="pricing">
        <div className="pricing-clouds" aria-hidden="true" />
        <header className="world-section-heading pricing-heading">
          <span className="section-capsule">PLANS</span>
          <h2>pay for work that runs.</h2>
          <p>Flow controls are free. App, API, and AI modules show their credit cost clearly.</p>
          <div className="billing-toggle"><span>monthly</span><span>yearly</span><em>save 20%</em></div>
        </header>
        <div className="world-pricing-grid">
          {Object.values(PLANS).map((plan) => (
            <article className={`world-price-window ${plan.id === "pro" ? "popular" : ""}`} key={plan.id}>
              {plan.id === "pro" && <span className="popular-label">most useful</span>}
              <div className="mini-window-bar"><i /><i /><i /><span>{plan.name.toLowerCase()}.plan</span></div>
              <div className="world-price-body">
                <h3>{plan.name.toLowerCase()}</h3>
                <p>{plan.id === "free" ? "learn what should move." : plan.id === "pro" ? "for teams finding their rhythm." : "room for serious operations."}</p>
                <div className="world-price"><b>${plan.monthlyPrice}</b><span>/ month</span></div>
                <small>{plan.monthlyCredits.toLocaleString()} credits included</small>
                <Link className={plan.id === "pro" ? "aqua-button" : "glass-button"} href="/signup">{plan.id === "free" ? "start free" : `get ${plan.name.toLowerCase()}`}</Link>
                <hr />
                <ul>
                  <li><Check size={15} />{plan.activeWorkflowLimit ?? "Unlimited"} active automations</li>
                  <li><Check size={15} />{plan.memberLimit} {plan.memberLimit === 1 ? "member" : "members"}</li>
                  <li><Check size={15} />{plan.retentionDays}-day run history</li>
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="faq-world" id="questions">
        <header><span className="section-capsule">QUESTIONS, ANSWERED</span><h2>frequently asked<br />before automating.</h2><p>The things worth knowing about control, live data, and getting started.</p></header>
        <div className="faq-list">
          {frequentlyAsked.map((item, index) => (
            <details key={item.question} open={index === 0}>
              <summary><span>0{index + 1}</span>{item.question}<i>+</i></summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
        <span className="faq-doodle">pause<br /><Pause size={24} fill="currentColor" /><br />when it matters</span>
      </section>

      <section className="final-world-cta">
        <span className="section-capsule">YOUR FIRST RUN</span>
        <h2>there is probably a task<br />you should never do again.</h2>
        <Link className="aqua-button" href="/signup">build that one first <ArrowRight size={18} /></Link>
      </section>

      <footer className="world-footer">
        <div className="footer-columns">
          <div><b>product</b><a href="#product">how it works</a><a href="#templates">templates</a><a href="#pricing">pricing</a><Link href="/signup">try it</Link></div>
          <div><b>resources</b><a href="#questions">questions</a><Link href="/privacy">privacy</Link><Link href="/terms">terms</Link><a href="mailto:support@automata.local">support</a></div>
          <div><b>connect</b><a href="mailto:support@automata.local">email</a><span>changelog soon</span><span>community soon</span></div>
          <div><b>the short version</b><p>Automata moves repetitive work between your tools—and puts you back in charge when judgment matters.</p></div>
        </div>
        <div className="footer-wordmark" aria-label="Automata">
          <span>automata</span>
          <div className="footer-flow" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span />{Array.from({ length: 8 }).map((_, index) => <i key={index} />)}</div>
        </div>
        <small>© 2026 Automata. Built for work that should keep moving.</small>
      </footer>
    </main>
  );
}
