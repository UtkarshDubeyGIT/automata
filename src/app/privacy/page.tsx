import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/logo";
import { publicPageMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = publicPageMetadata({
  title: "Privacy Policy",
  description: "Learn what Automata stores about your account, workspace, workflows, connected services, and run history, and how you can manage or delete that data.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <main className="legal-page theme-light">
      <Logo />
      <article>
        <span>Effective 31 August 2026</span>
        <h1>Privacy Policy</h1>
        <p>Automata stores the account, workspace, workflow, connection details, and run records needed to provide the service. Connected service credentials are encrypted and never sent back to your browser.</p>
        <h2>How long we keep data</h2>
        <p>Run logs are kept for 7, 30, or 90 days, depending on your plan. Secrets are removed from logs. Workspace owners can request deletion. We may keep limited billing records when the law requires it.</p>
        <h2>Your choices</h2>
        <p>You can disconnect services, clear workflow history, export workspace data, or delete your workspace. Contact the address in product settings to request access to or deletion of your data.</p>
        <Link href="/">Return home</Link>
      </article>
    </main>
  );
}
