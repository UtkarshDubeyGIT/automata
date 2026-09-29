import type { Metadata } from "next";

export const metadata: Metadata = { title: "Pro access decision", robots: { index: false, follow: false } };

const MESSAGES: Record<string, string> = {
  approved: "Pro access approved. The workspace now has 30 days of complimentary Pro access and 10,000 additional credits.",
  declined: "The Pro access request was declined. The requester will be notified by email.",
  already_pro: "This workspace already has Pro access. No additional credits were granted.",
  unavailable: "The decision could not be saved. Please try the review link again.",
  invalid: "This link is invalid, expired, or has already been used.",
};

export default async function ProAccessResult({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome = "invalid" } = await searchParams;
  return (
    <main className="min-h-screen bg-page px-5 py-16 text-ink">
      <section className="mx-auto max-w-xl rounded-2xl border border-line bg-card p-8 shadow-sm">
        <p className="mb-3 text-sm font-semibold text-brand">Automata · Pro access</p>
        <h1 className="text-2xl font-semibold">Decision result</h1>
        <p className="mt-5 text-ink-muted">{MESSAGES[outcome] ?? MESSAGES.invalid}</p>
      </section>
    </main>
  );
}
