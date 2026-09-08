import {
  ArrowRight,
  Check,
  Eye,
  History,
  PauseCircle,
  Play,
} from "lucide-react";
import Link from "next/link";

import { AuthOrbits } from "@/components/auth-orbits";
import { LogoMark } from "@/components/logo";
import { ToolLogo } from "@/components/tool-logo";
import { BRAND } from "@/config/brand";
import { PLANS } from "@/lib/billing/plans";
import { INTEGRATIONS } from "@/lib/integrations/catalog";
import { TEMPLATES } from "@/lib/workflows/templates";

import { HeroRoute } from "./hero-route";
import styles from "./space-landing.module.css";
import { ToolWall } from "./tool-wall";

/* ---------------------------------------------------------------------------
   Space landing — a mock direction that grows the sign-in panel into the
   whole public site. Dark sky, orbiting routines, and copy that starts from
   the reader's Tuesday morning rather than from our feature list.

   Every section answers one objection in order: "I'm the glue between my
   tools" → "I don't trust bots" → "I don't have an engineer" → "show me the
   proof" → "what does it cost" → "what's the catch".
--------------------------------------------------------------------------- */

const pains = [
  {
    quote: "I open fourteen tabs before I've done any actual work.",
    title: "You are the integration layer.",
    body: "New row in Sheets, copy to HubSpot, ping Slack, draft the email, wait. Automata watches the trigger and carries the work between your tools, so the tab-hopping stops being your job.",
  },
  {
    quote: "The last bot we set up sent the wrong thing to a customer.",
    title: "Speed without the surprises.",
    body: "Any step that writes to the outside world can stop and ask first. You see the exact message, record, or request, then approve, edit, or reject it. Nothing leaves in the dark.",
  },
  {
    quote: "Every tool has an API. None of them have my afternoon.",
    title: "Built in a sentence, not a sprint.",
    body: "Describe the process in plain language and Automata drafts the route, connects the accounts, and shows you the run. Change what you like on the canvas. No engineer required.",
  },
];

const steps = [
  {
    n: "01",
    title: "Describe it",
    body: "“When a Shopify order lands, summarize it and ask before messaging operations on WhatsApp.” That sentence becomes a draft workflow you can inspect.",
  },
  {
    n: "02",
    title: "Connect your tools",
    body: "Sign into the apps once. Tokens, retries, and rate limits are handled for you, and every module shows its credit cost before it runs.",
  },
  {
    n: "03",
    title: "Review, then let go",
    body: "Run it once on real data with a preflight before any write. When it looks right, turn it on and read the log whenever you want to check.",
  },
];

const proofs = [
  { icon: Eye, title: "Preview every write", body: "Resolved data, shown before it leaves." },
  { icon: History, title: "Trace every run", body: "Inputs, timing, cost, and outcome, kept." },
  { icon: PauseCircle, title: "Pause anything", body: "One switch stops a routine mid-orbit." },
];

const questions = [
  {
    q: "Will it take actions without asking me?",
    a: "Not unless you tell it to. AI-created workflows place an approval before every external write by default. You can relax that per step once a routine has earned your trust.",
  },
  {
    q: "Do I need an engineer to set this up?",
    a: "No. You can build a working routine from a sentence or a template. The canvas is there when you want to shape the details, and webhooks and HTTP modules are there when you want to go deeper.",
  },
  {
    q: "Does “run once” use real data?",
    a: "Yes, on purpose. Test runs use your connected accounts and live payloads so what you review is what will happen. Before a write, Automata shows a preflight so a test cannot quietly change production.",
  },
  {
    q: "What happens when a run fails at 3am?",
    a: "The run is recorded with the exact input and the step that failed. Retries are automatic for transient errors. Anything that needs a human waits in Needs attention until you get to it.",
  },
  {
    q: "Can I bring my Make or Zapier scenarios?",
    a: "Today you rebuild your highest-value ones with familiar triggers, routers, filters, actions, and run logs. Template-assisted migration is on the roadmap.",
  },
];

const planTaglines: Record<string, string> = {
  free: "Learn what should move.",
  pro: "For teams finding their rhythm.",
  team: "Room for serious operations.",
};

function Brand() {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5 font-display text-[19px] font-semibold tracking-[-0.025em] text-white" aria-label={`${BRAND.name} home`}>
      <LogoMark className="h-8 w-8" />
      <span>{BRAND.name}</span>
    </Link>
  );
}

export function SpaceLanding() {
  const plans = Object.values(PLANS);

  return (
    <main className={styles.page}>
      <div className={styles.stars} aria-hidden="true" />
      <div className={styles.starsNear} aria-hidden="true" />

      {/* ---- Nav ---------------------------------------------------------- */}
      <header className="relative z-20 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <Brand />
        <nav className="hidden items-center gap-8 text-[14px] text-[var(--ink-muted)] md:flex" aria-label="Primary">
          <a className="hover:text-white" href="#why">Why</a>
          <a className="hover:text-white" href="#how">How it works</a>
          <a className="hover:text-white" href="#templates">Templates</a>
          <a className="hover:text-white" href="#pricing">Pricing</a>
          <a className="hover:text-white" href="#faq">FAQ</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link className="hidden text-[14px] text-[var(--ink-muted)] hover:text-white sm:inline" href="/login">Sign in</Link>
          <Link className={`${styles.primary} !min-h-10 !px-4 text-[14px]`} href="/signup">Start free <ArrowRight size={15} /></Link>
        </div>
      </header>

      {/* ---- Hero --------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden" id="top">
        <div className={styles.nebula} aria-hidden="true" />
        <AuthOrbits
          focus={{ x: 0.72, y: 0.42, scale: 1.25 }}
          mask="linear-gradient(to bottom, #000 0%, #000 60%, rgba(0,0,0,0.4) 85%, transparent 100%)"
          className="opacity-60 lg:opacity-100"
        />
        <div className="relative z-10 mx-auto grid w-full max-w-6xl gap-14 px-6 pb-24 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pb-36 lg:pt-24">
          <div>
            <p className={`${styles.eyebrow} ${styles.rise}`}><i /> Live automations, under your control</p>
            <h1 className={`${styles.display} ${styles.rise} mt-6 text-[clamp(46px,7vw,88px)]`}>
              Tell it once.<br /><em>Watch work move.</em>
            </h1>
            <p className={`${styles.rise} mt-7 max-w-[34rem] text-[18px] leading-[1.6] text-[var(--ink-muted)]`}>
              Your tools don&apos;t talk to each other, so you do the talking: copy this, paste that, ping someone, wait.{" "}
              {BRAND.name} connects them, runs the repetition, and stops to ask when a human should decide.
            </p>
            <div className={`${styles.rise} mt-9 flex flex-wrap items-center gap-3`}>
              <Link className={styles.primary} href="/signup">Start free, no card <ArrowRight size={17} /></Link>
              <Link className={styles.ghost} href="/app/workflows/daily-pipeline-digest"><Play size={15} fill="currentColor" /> Watch a real run</Link>
            </div>
            <ul className={`${styles.rise} mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-[var(--ink-subtle)]`}>
              <li className="inline-flex items-center gap-2"><Check size={13} /> {PLANS.free.monthlyCredits.toLocaleString()} free credits a month</li>
              <li className="inline-flex items-center gap-2"><Check size={13} /> Approval before every write</li>
              <li className="inline-flex items-center gap-2"><Check size={13} /> First workflow in minutes</li>
            </ul>
          </div>
          <div className="lg:justify-self-end lg:w-full lg:max-w-[520px]">
            <HeroRoute />
          </div>
        </div>

        <div className="relative z-10 pb-10">
          <ToolWall />
        </div>
      </section>

      {/* ---- Pain points -------------------------------------------------- */}
      <section className="relative mx-auto w-full max-w-6xl px-6 py-24" id="why">
        <div className="max-w-2xl">
          <p className={styles.eyebrow}>Sound familiar?</p>
          <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.6vw,56px)]`}>Most teams don&apos;t need more software. <em>They need less glue work.</em></h2>
        </div>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {pains.map((pain) => (
            <article key={pain.title} className={`${styles.card} flex flex-col p-7`}>
              <p className={styles.quote}>{pain.quote}</p>
              <div className="mt-auto pt-10">
                <div className={styles.horizon} />
                <h3 className="mt-6 font-display text-[17px] font-semibold tracking-[-0.015em] text-white">{pain.title}</h3>
                <p className="mt-2.5 text-[14.5px] leading-[1.65] text-[var(--ink-muted)]">{pain.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ---- How it works ------------------------------------------------- */}
      <section className="relative mx-auto w-full max-w-6xl px-6 py-24" id="how">
        <div className={styles.horizon} />
        <div className="grid gap-12 pt-20 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className={styles.eyebrow}>Launch sequence</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.2vw,52px)]`}>Three steps. <em>Then it just runs.</em></h2>
            <p className="mt-6 max-w-md text-[16px] leading-[1.65] text-[var(--ink-muted)]">Plain language, a proven template, or a blank canvas all become the same inspectable workflow. Start wherever your idea is.</p>
            <Link className={`${styles.ghost} mt-8`} href="/signup">Build your first routine <ArrowRight size={15} /></Link>
          </div>
          <ol className="grid gap-4">
            {steps.map((step) => (
              <li key={step.n} className={`${styles.card} grid gap-5 p-6 sm:grid-cols-[auto_1fr] sm:items-start`}>
                <span className={styles.stepNumber}>{step.n}</span>
                <div>
                  <h3 className="font-display text-[19px] font-semibold tracking-[-0.02em] text-white">{step.title}</h3>
                  <p className="mt-2 text-[15px] leading-[1.65] text-[var(--ink-muted)]">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- Human by design ---------------------------------------------- */}
      <section className="relative isolate overflow-hidden py-28" id="control">
        <AuthOrbits
          focus={{ x: 0.5, y: 0.5, scale: 1.1 }}
          mask="radial-gradient(60% 70% at 50% 50%, #000 30%, transparent 100%)"
          className="opacity-50"
        />
        <div className="relative z-10 mx-auto w-full max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className={`${styles.eyebrow} justify-center`}>Human by design</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.6vw,56px)]`}>Fast does not mean <em>reckless.</em></h2>
            <p className="mt-6 text-[16.5px] leading-[1.65] text-[var(--ink-muted)]">When a routine reaches a consequential action, {BRAND.name} can put the decision back where it belongs: with you. Every write shows the resolved data first. Every run leaves a trail you can read.</p>
          </div>
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            {proofs.map(({ icon: Icon, title, body }) => (
              <div key={title} className={`${styles.card} p-6`}>
                <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--line-strong)] text-white"><Icon size={18} /></span>
                <h3 className="mt-5 font-display text-[17px] font-semibold tracking-[-0.015em] text-white">{title}</h3>
                <p className="mt-1.5 text-[14.5px] text-[var(--ink-muted)]">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Templates ---------------------------------------------------- */}
      <section className="relative mx-auto w-full max-w-6xl px-6 py-24" id="templates">
        <div className={styles.horizon} />
        <div className="flex flex-col gap-6 pt-20 md:flex-row md:items-end md:justify-between">
          <div className="max-w-xl">
            <p className={styles.eyebrow}>Proven routes</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.2vw,52px)]`}>Steal our best <em>workflows.</em></h2>
            <p className="mt-5 text-[16px] leading-[1.65] text-[var(--ink-muted)]">Start from a routine that already works, connect your accounts, and change only what makes it yours.</p>
          </div>
          <Link className={`${styles.ghost} self-start md:self-auto`} href="/app/templates">Browse all templates <ArrowRight size={15} /></Link>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.slice(0, 6).map((template) => {
            const apps = template.apps ?? (template.app ? [template.app] : []);
            return (
              <Link key={template.id} href={`/app/templates?template=${template.id}`} className={`${styles.card} ${styles.cardLink} flex flex-col p-6`}>
                <div className="flex items-center gap-2">
                  {apps.slice(0, 4).map((slug) => {
                    const app = INTEGRATIONS.find((item) => item.slug === slug);
                    return <ToolLogo key={slug} slug={slug} label={app?.name} size={30} className={styles.appMark} />;
                  })}
                </div>
                <h3 className="mt-6 font-display text-[17px] font-semibold tracking-[-0.015em] text-white">{template.name}</h3>
                <p className="mt-2 line-clamp-3 text-[14px] leading-[1.6] text-[var(--ink-muted)]">{template.description}</p>
                <footer className="mt-auto flex items-center justify-between pt-6 font-mono text-[11.5px] text-[var(--ink-subtle)]">
                  <span>{template.setupMinutes ?? 4} min setup</span>
                  <ArrowRight size={14} />
                </footer>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ---- Pricing ------------------------------------------------------ */}
      <section className="relative mx-auto w-full max-w-6xl px-6 py-24" id="pricing">
        <div className={styles.horizon} />
        <div className="mx-auto max-w-2xl pt-20 text-center">
          <p className={`${styles.eyebrow} justify-center`}>Plans</p>
          <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.6vw,56px)]`}>Pay for work <em>that runs.</em></h2>
          <p className="mt-5 text-[16px] leading-[1.65] text-[var(--ink-muted)]">Flow controls are free. App, API, and AI modules show their credit cost before they run, so the bill is never a surprise.</p>
        </div>
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {plans.map((plan) => {
            const popular = plan.id === "pro";
            return (
              <article key={plan.id} className={`${styles.card} ${popular ? styles.popular : ""} flex flex-col p-7`}>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-[20px] font-semibold tracking-[-0.02em] text-white">{plan.name}</h3>
                  {popular && <span className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-white">most useful</span>}
                </div>
                <p className="mt-1.5 text-[14px] text-[var(--ink-muted)]">{planTaglines[plan.id]}</p>
                <div className="mt-7 flex items-baseline gap-1.5">
                  <span className="font-display text-[44px] font-semibold tracking-[-0.04em] text-white">${plan.monthlyPrice}</span>
                  <span className="text-[14px] text-[var(--ink-subtle)]">/ month</span>
                </div>
                <p className="mt-1 font-mono text-[12px] text-[var(--ink-subtle)]">{plan.monthlyCredits.toLocaleString()} credits included</p>
                <Link className={`${popular ? styles.primary : styles.ghost} mt-7`} href="/signup">{plan.id === "free" ? "Start free" : `Get ${plan.name}`}</Link>
                <ul className="mt-7 grid gap-3 text-[14px] text-[var(--ink-muted)]">
                  <li className="flex items-center gap-2.5"><Check size={14} className="text-white" /> {plan.activeWorkflowLimit ?? "Unlimited"} active automations</li>
                  <li className="flex items-center gap-2.5"><Check size={14} className="text-white" /> {plan.memberLimit} {plan.memberLimit === 1 ? "member" : "members"}</li>
                  <li className="flex items-center gap-2.5"><Check size={14} className="text-white" /> {plan.retentionDays}-day run history</li>
                  <li className="flex items-center gap-2.5"><Check size={14} className="text-white" /> Approvals and preflight on every plan</li>
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      {/* ---- FAQ ---------------------------------------------------------- */}
      <section className="relative mx-auto w-full max-w-6xl px-6 py-24" id="faq">
        <div className={styles.horizon} />
        <div className="grid gap-12 pt-20 lg:grid-cols-[0.7fr_1.3fr]">
          <div>
            <p className={styles.eyebrow}>Before you automate</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.2vw,52px)]`}>The questions <em>worth asking.</em></h2>
            <p className="mt-5 max-w-sm text-[16px] leading-[1.65] text-[var(--ink-muted)]">Control, live data, failures, and moving in from other tools.</p>
          </div>
          <div className={styles.faq}>
            {questions.map((item, index) => (
              <details key={item.q} open={index === 0}>
                <summary><span>0{index + 1}</span>{item.q}<i>+</i></summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Final CTA ---------------------------------------------------- */}
      <section className="relative isolate overflow-hidden py-36">
        <AuthOrbits
          focus={{ x: 0.5, y: 0.55, scale: 1.4 }}
          mask="linear-gradient(to bottom, transparent 0%, #000 25%, #000 75%, transparent 100%)"
          className="opacity-70"
        />
        <div className="relative z-10 mx-auto max-w-3xl px-6 text-center">
          <p className={`${styles.eyebrow} justify-center`}>Your first run</p>
          <h2 className={`${styles.display} mt-6 text-[clamp(38px,5.6vw,72px)]`}>There is probably a task you should <em>never do again.</em></h2>
          <p className="mt-6 text-[17px] text-[var(--ink-muted)]">Build that one first. It takes minutes, and you can watch every run.</p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link className={styles.primary} href="/signup">Start free, no card <ArrowRight size={17} /></Link>
            <Link className={styles.ghost} href="/login">Sign in</Link>
          </div>
        </div>
      </section>

      {/* ---- Footer ------------------------------------------------------- */}
      <footer className="relative mx-auto w-full max-w-6xl px-6 pb-10">
        <div className={styles.horizon} />
        <div className="grid gap-10 pt-12 text-[14px] text-[var(--ink-muted)] md:grid-cols-4">
          <div className="flex flex-col gap-3"><b className="text-white">Product</b><a href="#how">How it works</a><a href="#templates">Templates</a><a href="#pricing">Pricing</a><Link href="/signup">Try it</Link></div>
          <div className="flex flex-col gap-3"><b className="text-white">Resources</b><a href="#faq">Questions</a><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href={`mailto:${BRAND.supportEmail}`}>Support</a></div>
          <div className="flex flex-col gap-3"><b className="text-white">Connect</b><a href={`mailto:${BRAND.supportEmail}`}>Email</a><span className="text-[var(--ink-subtle)]">Changelog soon</span><span className="text-[var(--ink-subtle)]">Community soon</span></div>
          <div><b className="text-white">The short version</b><p className="mt-3 leading-[1.6]">{BRAND.description}</p></div>
        </div>
        <div className="mt-16 overflow-hidden" aria-hidden="true"><div className={styles.wordmark}>{BRAND.name.toLowerCase()}</div></div>
        <small className="mt-6 block text-[12.5px] text-[var(--ink-subtle)]">© 2026 {BRAND.name}. Built for work that should keep moving.</small>
      </footer>
    </main>
  );
}
