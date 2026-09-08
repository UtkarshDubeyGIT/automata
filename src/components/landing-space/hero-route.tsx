import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";

import { ToolLogo } from "@/components/tool-logo";

import styles from "./space-landing.module.css";

/* ---------------------------------------------------------------------------
   Hero route — one workflow, told the way Automata tells it.

   Reads top to bottom as a story with an ending: the sentence someone typed,
   the route it became, the moment it stopped to ask, and where to go to build
   your own. A single rail links the steps and a packet travels it on loop,
   the same idea as the orbits behind it, just straightened out.
--------------------------------------------------------------------------- */

const stops = [
  { slug: "googlesheets", name: "Google Sheets", label: "New row lands", detail: "Acme Ltd · 40 seats", state: "done" },
  { slug: "openai", name: "OpenAI", label: "Qualify the lead", detail: "Warm. Budget confirmed.", state: "done" },
] as const;

export function HeroRoute() {
  return (
    <div className={styles.route} data-testid="hero-workflow" aria-label="Example workflow: lead routing">
      <p className={styles.routePrompt}>
        <Sparkles size={13} />
        <span>“When a lead lands in Sheets, qualify it and ask me before it goes into HubSpot.”</span>
      </p>

      <ol className={styles.routeStops}>
        <span className={styles.routeRail} aria-hidden="true" />
        {stops.map((stop) => (
          <li key={stop.slug} className={styles.routeStop}>
            <ToolLogo slug={stop.slug} label={stop.name} size={34} className={styles.stopLogo} />
            <div>
              <b>{stop.label}</b>
              <small>{stop.detail}</small>
            </div>
            <span className={styles.routeDone} aria-label="done" />
          </li>
        ))}

        <li className={`${styles.routeStop} ${styles.routeAsk}`}>
          <span className={styles.routeAskIcon}><ShieldCheck size={16} /></span>
          <div>
            <b>Asks you first</b>
            <small>Create the HubSpot contact and notify #sales?</small>
          </div>
          <button type="button" className={styles.routeApprove}>Approve</button>
        </li>

        <li className={`${styles.routeStop} ${styles.routeNext}`}>
          <ToolLogo slug="hubspot" label="HubSpot" size={34} className={styles.stopLogo} />
          <div>
            <b>Create the contact</b>
            <small>Waits for your answer · 1 credit</small>
          </div>
        </li>
      </ol>

      <Link href="/signup" className={styles.routeCta}>
        <span>Build this in your workspace</span>
        <ArrowRight size={15} />
      </Link>
    </div>
  );
}
