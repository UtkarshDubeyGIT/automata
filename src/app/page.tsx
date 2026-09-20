import type { Metadata } from "next";

import { SpaceLanding } from "@/components/landing-space/space-landing";
import { BRAND } from "@/config/brand";

export const metadata: Metadata = {
  title: "AI workflow automation with human approval",
  description: "Automata is a visual automation workspace for AI-assisted workflows that connect your tools, run repetitive work, and keep consequential actions reviewable.",
  alternates: {
    canonical: "/",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: BRAND.name,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: "Automata is a visual automation workspace that connects tools, runs repetitive work, and keeps consequential actions reviewable.",
      featureList: [
        "AI-assisted workflow building from plain language",
        "Connected-tool automations and templates",
        "Human approval before consequential external actions",
        "Inspectable run history and preflight previews",
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What can I delegate to an AI agent?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Automata can research, synthesize, and draft with live context from connected tools before routing a useful result to the next workflow step.",
          },
        },
        {
          "@type": "Question",
          name: "Can the agent make decisions on its own?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "You set the boundaries for what an agent can handle, where it can send results, and which decisions require your review.",
          },
        },
        {
          "@type": "Question",
          name: "Will Automata take actions without asking me?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "AI-created workflows place an approval before every external write by default, and you can adjust that per step when a routine has earned your trust.",
          },
        },
      ],
    },
  ],
};

/**
 * Landing page mock: the space-themed direction drawn from the sign-in panel.
 *
 * To switch back to the previous landing, swap the import for
 * `ClassicLanding` from "@/components/landing-classic". Both stay side by
 * side until one is chosen; the classic one is viewable at
 * /prototype/landing-classic in the meantime.
 */
export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <SpaceLanding />
    </>
  );
}
