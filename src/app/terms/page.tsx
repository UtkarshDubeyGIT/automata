import Link from "next/link";

import { Logo } from "@/components/logo";

export default function TermsPage() {
  return <main className="legal-page theme-light"><Link href="/"><Logo /></Link><article><span>Effective 31 August 2026</span><h1>Terms of Service</h1><p>Automata lets customers design and run workflows across connected services. You remain responsible for the accounts, data, instructions, and recipients used in those workflows.</p><h2>Safe use</h2><p>Do not use Automata for illegal, abusive, deceptive, destructive, or unauthorized activity. Approval gates reduce accidental actions but do not replace your review of workflow configuration.</p><h2>Beta service</h2><p>The MVP is provided as a private beta. Availability, limits, and integrations may change while the product is being validated.</p><Link href="/">Return home</Link></article></main>;
}
