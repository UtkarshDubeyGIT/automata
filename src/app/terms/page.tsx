import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/logo";
import { publicPageMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = publicPageMetadata({
  title: "Terms of Service",
  description: "Read the terms for using Automata, including your responsibilities for connected accounts, workflow instructions, data, and automated actions.",
  path: "/terms",
});

export default function TermsPage() {
  return (
    <main className="legal-page theme-light">
      <Logo />
      <article>
        <span>Effective 31 August 2026</span>
        <h1>Terms of Service</h1>
        <p>Automata lets you create and run workflows across connected services. You are responsible for the accounts, data, instructions, and recipients you use in those workflows.</p>
        <h2>Use Automata safely</h2>
        <p>Do not use Automata for illegal, abusive, deceptive, destructive, or unauthorized activity. Approval steps can prevent mistakes, but they do not replace your review of a workflow.</p>
        <h2>Private beta</h2>
        <p>Automata is currently a private beta. Availability, limits, and integrations may change as the service is tested.</p>
        <Link href="/">Return home</Link>
      </article>
    </main>
  );
}
