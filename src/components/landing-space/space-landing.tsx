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
import { LandingPromoModal } from "@/components/promo/landing-promo-modal";
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
   whole public site. Dark sky, orbiting routines, and copy that starts with
   the outcome the reader wants, rather than the workflow they would have to
   build by hand.

   Every section answers one objection in order: "why should I use an agent?"
   → "will I still be in control?" → "how does it get built?" → "what does
   it cost?" → "what should I ask before delegating?".
--------------------------------------------------------------------------- */

const pains = [
  {
    quote: "I know the outcome. I don't want to draw every box.",
    title: "Start with the work, not the workflow.",
    body: "Describe the result and the tools involved. The AI builder drafts a workflow you can inspect, without making you wire every trigger and field by hand.",
  },
  {
    quote: "Most of our work needs judgment, not another if/then.",
    title: "Give the messy middle to an agent.",
    body: "Give an agent context from your tools so it can research, summarize, and draft before the workflow moves on.",
  },
  {
    quote: "We have better things to do than maintain every automation.",
    title: "Keep the outcome. Lose the upkeep.",
    body: "When a process changes, describe what changed. Update the route and use run history and approvals to understand each run.",
  },
];

const steps = [
  {
    n: "01",
    title: "Name the outcome",
    body: "“When a new demo request arrives, research the company, qualify it, and prepare a Slack brief for sales.” Say what good looks like. No node diagram required.",
  },
  {
    n: "02",
    title: "Let the AI builder map it",
    body: "Automata chooses the trigger, connected tools, AI steps, and approvals, then gives you a workflow to inspect and refine.",
  },
  {
    n: "03",
    title: "Give it boundaries, then go",
    body: "Review the proposed route once. Decide where the agent can act alone and where it must pause. Then it runs the routine for you.",
  },
];

const proofs = [
  { icon: Eye, title: "Set the guardrails", body: "Choose the actions that need your approval before they happen." },
  { icon: History, title: "See the full context", body: "Preview resolved data, agent outputs, and downstream impact before you approve." },
  { icon: PauseCircle, title: "Improve without rebuilding", body: "Every run is traceable, so a better instruction or route is simple to change." },
];

export const questions = [
  {
    q: "What can I delegate to an AI agent?",
    a: "Delegate work that needs context before action: research a company, qualify a lead, turn meeting notes into tasks, or draft a message. An agent can use live context from connected tools, then pass its result to the next workflow step.",
  },
  {
    q: "How is this different from a standard automation?",
    a: "A standard automation follows a fixed path. Automata can add AI steps to interpret information and route the result through a dependable workflow.",
  },
  {
    q: "Can the agent make decisions on its own?",
    a: "It can classify, summarize, and route work using the context you provide. You decide what it can handle, where results go, and which decisions need your review.",
  },
  {
    q: "Will it take actions without asking me?",
    a: "AI-created workflows put an approval before every external write by default. You can change that for individual steps when you are ready.",
  },
  {
    q: "Do I need an engineer to set this up?",
    a: "No. Describe a job and its outcome in plain language. Automata creates a draft to inspect; the canvas and technical modules are available when you want more control.",
  },
  {
    q: "Does “run once” use real data?",
    a: "Yes. Test runs use your connected accounts and live payloads. Automata shows a preflight before a write so a test does not quietly change production data.",
  },
  {
    q: "What happens when a run fails at 3am?",
    a: "Run history records the input and failed step. Automata retries temporary errors; anything needing a person waits in Needs attention.",
  },
];

const planTaglines: Record<string, string> = {
  free: "Learn what should move.",
  pro: "For teams finding their rhythm.",
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
  const supportDomain = BRAND.supportEmail.split("@")[1] ?? "";
  const hasPublicSupportEmail =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(BRAND.supportEmail) &&
    !/\.(?:local|internal)$/i.test(supportDomain);

  return (
    <main className={styles.page}>
      <LandingPromoModal />
      <div className={styles.stars} aria-hidden="true" />
      <div className={styles.starsNear} aria-hidden="true" />

      {/* ---- Nav ---------------------------------------------------------- */}
      <header className="relative z-20 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <Brand />
        <nav className="hidden items-center gap-8 text-[14px] text-[var(--ink-muted)] md:flex" aria-label="Primary">
          <a className="hover:text-white" href="#why">Why Automata</a>
          <a className="hover:text-white" href="#how">AI builder</a>
          <a className="hover:text-white" href="#templates">Starting points</a>
          <a className="hover:text-white" href="#pricing">Pricing</a>
          <a className="hover:text-white" href="#faq">FAQ</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link className="hidden text-[14px] text-[var(--ink-muted)] hover:text-white sm:inline" href="/login">Sign in</Link>
          <Link className={`${styles.primary} !min-h-10 !px-4 text-[14px]`} href="/signup">Try the AI builder <ArrowRight size={15} /></Link>
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
        <div className="relative z-10 mx-auto grid w-full max-w-6xl gap-14 px-6 pb-24 pt-10 lg:grid-cols-[1.4fr_0.8fr] lg:items-center lg:pb-36 lg:pt-20">
          <div>
            <h1 className={`${styles.display} ${styles.rise} text-[clamp(38px,7vw,52px)] lg:text-[clamp(44px,3.4vw,50px)]`}>
              Describe the outcome.<br /><em>Automata builds the work.</em>
            </h1>
            <p className={`${styles.rise} mt-6 max-w-xl text-[17px] leading-[1.65] text-[var(--ink-muted)]`}>
              Automata is an AI workflow automation builder for solo operators, developers, and small teams. Connect your tools, describe the work, and review consequential actions before they run.
            </p>
            <div className={`${styles.rise} mt-9 flex flex-wrap items-center gap-3`}>
              <Link className={styles.primary} href="/signup">Put an agent to work <ArrowRight size={17} /></Link>
              <Link className={styles.ghost} href="#how"><Play size={15} fill="currentColor" /> See how the AI builder works</Link>
            </div>
            <ul className={`${styles.rise} mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-[var(--ink-subtle)]`}>
              <li className="inline-flex items-center gap-2"><Check size={13} /> Start from an outcome, not a canvas</li>
              <li className="inline-flex items-center gap-2"><Check size={13} /> AI builder drafts the workflow</li>
              <li className="inline-flex items-center gap-2"><Check size={13} /> Approvals where you decide</li>
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
          <p className={styles.eyebrow}>Why Automata</p>
          <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.6vw,56px)]`}>Let Automata handle recurring work <em>across your tools.</em></h2>
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
            <p className={styles.eyebrow}>From intent to action</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.2vw,52px)]`}>From a plain language request <em>to a workflow you can inspect.</em></h2>
            <p className="mt-6 max-w-md text-[16px] leading-[1.65] text-[var(--ink-muted)]">Describe the goal and the tools involved. The AI builder creates a draft you can review and adjust before it runs.</p>
            <Link className={`${styles.ghost} mt-8`} href="/signup">Tell the AI builder what to do <ArrowRight size={15} /></Link>
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
            <p className={`${styles.eyebrow} justify-center`}>Autonomy on your terms</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.6vw,56px)]`}>Give agents context. <em>Set their limits.</em></h2>
            <p className="mt-6 text-[16.5px] leading-[1.65] text-[var(--ink-muted)]">{BRAND.name} gives agents context from your tools. You choose which actions need approval and can review every run.</p>
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
            <p className={styles.eyebrow}>Start with a result</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.2vw,52px)]`}>Start with a template <em>you can make your own.</em></h2>
            <p className="mt-5 text-[16px] leading-[1.65] text-[var(--ink-muted)]">Choose a starting point, describe what should change, and adjust the workflow for your needs.</p>
          </div>
          <Link className={`${styles.ghost} self-start md:self-auto`} href="/app/templates">See agent-ready starts <ArrowRight size={15} /></Link>
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
                <footer className="mt-auto flex items-center justify-between pt-6 font-mono text-[13px] text-[var(--ink-subtle)]">
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
          <p className={`${styles.eyebrow} justify-center`}>Built to earn its place</p>
          <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.6vw,56px)]`}>Start free. <em>Request more room.</em></h2>
          <p className="mt-5 text-[16px] leading-[1.65] text-[var(--ink-muted)]">Pro is currently invite only. Approved workspaces receive 30 complimentary days and 10,000 credits once. No payment is collected.</p>
        </div>
        <div className="mx-auto mt-14 grid max-w-3xl gap-4 md:grid-cols-2">
          {plans.map((plan) => {
            const popular = plan.id === "pro";
            return (
              <article key={plan.id} className={`${styles.card} ${popular ? styles.popular : ""} flex flex-col p-7`}>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-[20px] font-semibold tracking-[-0.02em] text-white">{plan.name}</h3>
                  {popular && <span className="rounded-full border border-white/20 px-2.5 py-1 font-mono text-[12px] uppercase tracking-[0.12em] text-white">invite only</span>}
                </div>
                <p className="mt-1.5 text-[14px] text-[var(--ink-muted)]">{planTaglines[plan.id]}</p>
                <div className="mt-7 flex items-baseline gap-1.5">
                  <span className={`font-display font-semibold tracking-[-0.04em] text-white ${popular ? "text-[clamp(27px,3vw,40px)]" : "text-[44px]"}`}>{popular ? "Complimentary" : `$${plan.monthlyPrice}`}</span>
                  {popular ? null : <span className="text-[14px] text-[var(--ink-subtle)]">/ month</span>}
                </div>
                <p className="mt-1 font-mono text-[13px] text-[var(--ink-subtle)]">{plan.monthlyCredits.toLocaleString()} {popular ? "credits once with approval" : "credits included"}</p>
                <Link className={`${popular ? styles.primary : styles.ghost} mt-7`} href={popular ? "/app/billing" : "/signup"}>{popular ? "Request Pro access" : "Start free"}</Link>
                <ul className="mt-7 grid gap-3 text-[14px] text-[var(--ink-muted)]">
                  <li className="flex items-center gap-2.5"><Check size={14} className="text-white" /> {plan.activeWorkflowLimit ?? "Unlimited"} active automations</li>
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
            <p className={styles.eyebrow}>Before you delegate</p>
            <h2 className={`${styles.display} mt-5 text-[clamp(34px,4.2vw,52px)]`}>Common questions about <em>AI workflow automation.</em></h2>
            <p className="mt-5 max-w-sm text-[16px] leading-[1.65] text-[var(--ink-muted)]">What to delegate, how the agent gets context, and where you stay in control.</p>
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
          <p className={`${styles.eyebrow} justify-center`}>Let the agent take the first pass</p>
          <h2 className={`${styles.display} mt-6 text-[clamp(38px,5.6vw,72px)]`}>Stop building workflows.<br /><em>Start moving work.</em></h2>
          <p className="mt-6 text-[17px] text-[var(--ink-muted)]">Name one outcome you want off your plate. The AI builder will make the route, and you decide where it should pause.</p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link className={styles.primary} href="/signup">Build with AI <ArrowRight size={17} /></Link>
            <Link className={styles.ghost} href="/login">Sign in</Link>
          </div>
        </div>
      </section>

      {/* ---- Footer ------------------------------------------------------- */}
      <footer className="relative mx-auto w-full max-w-6xl px-6 pb-10">
        <div className={styles.horizon} />
        <div className={`grid gap-10 pt-12 text-[14px] text-[var(--ink-muted)] ${hasPublicSupportEmail ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
          <div className="flex flex-col gap-3"><b className="text-white">Product</b><a href="#how">AI builder</a><a href="#templates">Starting points</a><a href="#pricing">Pricing</a><Link href="/signup">Try it</Link></div>
          <div className="flex flex-col gap-3"><b className="text-white">Resources</b><a href="#faq">Questions</a><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link>{hasPublicSupportEmail && <a href={`mailto:${BRAND.supportEmail}`}>Support</a>}</div>
          {hasPublicSupportEmail && <div className="flex flex-col gap-3"><b className="text-white">Connect</b><a href={`mailto:${BRAND.supportEmail}`}>Email</a></div>}
          <div><b className="text-white">The short version</b><p className="mt-3 leading-[1.6]">Define the outcome. Automata builds a trusted path to it.</p></div>
        </div>
        <div className="mt-16 overflow-hidden" aria-hidden="true"><div className={styles.wordmark}>{BRAND.name.toLowerCase()}</div></div>
        <small className="mt-6 block text-[13px] text-[var(--ink-subtle)]">© 2026 {BRAND.name}. Built for teams who want outcomes, not workflows.</small>
      </footer>
    </main>
  );
}
