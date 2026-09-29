import type { Metadata } from "next";
import { canReviewRequest, reviewRequest } from "@/lib/billing/pro-access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review Pro access", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ReviewProAccess({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const request = await reviewRequest(token);
  const actionable = canReviewRequest(request);
  return (
    <main className="min-h-screen bg-page px-5 py-16 text-ink">
      <section className="mx-auto max-w-xl rounded-2xl border border-line bg-card p-8 shadow-sm">
        <p className="mb-3 text-sm font-semibold text-brand">Automata · Pro access</p>
        <h1 className="text-2xl font-semibold">Review Pro access request</h1>
        {actionable ? (
          <>
            <p className="mt-5 text-ink-muted"><strong>{request.requester_email}</strong> requested 30 days of complimentary Pro access for <strong>{request.workspace_name}</strong>.</p>
            <p className="mt-2 text-sm text-ink-subtle">Approval adds 10,000 credits once. No payment is collected. Access expires 30 days after approval.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <form action="/api/billing/pro-access/decision" method="post">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="decision" value="approved" />
                <button className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-on-brand" type="submit">Approve Pro access</button>
              </form>
              <form action="/api/billing/pro-access/decision" method="post">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="decision" value="declined" />
                <button className="rounded-lg border border-line px-5 py-2.5 font-semibold" type="submit">Decline</button>
              </form>
            </div>
          </>
        ) : <p className="mt-5 text-ink-muted">This review link is invalid, expired, or has already been used.</p>}
      </section>
    </main>
  );
}
