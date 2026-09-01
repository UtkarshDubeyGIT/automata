import type { ReactNode } from "react";

import Link from "next/link";

import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <Link href="/" className="auth-brand" aria-label="Automata home"><Logo /></Link>
      <section className="auth-card">{children}</section>
      <p className="auth-foot">Real automations. Deliberate approvals. No hidden actions.</p>
    </main>
  );
}
