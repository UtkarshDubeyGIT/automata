import Link from "next/link";

import { Logo } from "@/components/logo";

export default function PrivacyPage() {
  return <main className="legal-page"><Link href="/"><Logo /></Link><article><span>Effective 31 August 2026</span><h1>Privacy Policy</h1><p>Automata stores the account, workspace, workflow, connection metadata, and execution records needed to provide the service. Connected-provider credentials are encrypted and never returned to the browser.</p><h2>Data retention</h2><p>Detailed run logs are retained for 7, 30, or 90 days according to plan. Secrets are redacted from logs. Workspace owners can request deletion; minimal billing records may be retained where legally required.</p><h2>Your choices</h2><p>You can disconnect integrations, purge workflow history, export workspace data, or delete your workspace. Contact the address in product settings for access or deletion requests.</p><Link href="/">Return home</Link></article></main>;
}
