import type { Metadata } from "next";

import { SpaceLanding, questions } from "@/components/landing-space/space-landing";
import { BRAND } from "@/config/brand";
import { SITE_URL } from "@/config/seo";

const pageTitle = "AI workflow automation for operators and developers";
const pageDescription = "Automata helps solo operators, developers, and small teams connect their tools, describe recurring work, and build AI-assisted workflows with review before consequential actions.";

export const metadata: Metadata = {
  // The homepage is in the same segment as the root layout, so Next.js does
  // not apply the root title template to it.
  title: `${pageTitle} | ${BRAND.name}`,
  description: pageDescription,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: `${SITE_URL}/`,
    siteName: BRAND.name,
    title: `${pageTitle} | ${BRAND.name}`,
    description: pageDescription,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Automata AI workflow automation for operators and developers" }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${pageTitle} | ${BRAND.name}`,
    description: pageDescription,
    images: ["/opengraph-image"],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: BRAND.name,
      url: SITE_URL,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: pageDescription,
      featureList: [
        "AI-assisted workflow building from plain language",
        "Connected-tool automations and templates",
        "Human approval before consequential external actions",
        "Inspectable run history and preflight previews",
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: questions.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};

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
