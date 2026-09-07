import { NextResponse } from "next/server";
import { readVerifiedWebhook } from "@/lib/shopify/webhooks";
import { normalizeShop } from "@/lib/shopify/oauth";
import { deleteInstall, readInstall } from "@/lib/shopify/installs";
import { socialProvider } from "@/lib/social/composio";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * All three mandatory compliance webhooks, on ONE endpoint.
 *
 * WHY ONE ROUTE AND NOT THREE. Shopify's new Dev Dashboard has no field for
 * these URLs — the section simply does not exist — so they are declared in
 * `shopify.app.toml` and pushed with `shopify app deploy`. A TOML subscription
 * block carries a list of `compliance_topics` and a SINGLE `uri`, so the shape
 * of the config decides the shape of the code. An earlier version of this had
 * a route per topic; nothing could point at them.
 *
 * The topic arrives in `X-Shopify-Topic`, which is covered by the signature we
 * verify first — so it is safe to branch on, unlike the request body.
 *
 * Two of Shopify's automated review checks land here: "Provides mandatory
 * compliance webhooks" and "Verifies webhooks with HMAC signatures". The
 * second is tested by sending a DELIBERATELY BAD signature and requiring 401,
 * so an endpoint that cheerfully answers 200 fails review while looking, in
 * every manual test, like it works.
 */
export async function POST(req: Request) {
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const result = await readVerifiedWebhook(req);
  if (!result.ok) {
    return NextResponse.json({ error: "Unverified webhook." }, { status: 401 });
  }

  const { payload, shop } = result;

  switch (topic) {
    /*
     * A shopper asked their store for a copy of what this app holds on them.
     *
     * WHAT ZIDANEAI ACTUALLY HOLDS: no per-shopper record. Store data is read
     * live through Composio when a workflow runs and is never copied into a
     * customer table; `external_metrics` keeps aggregates, not people. The one
     * place a shopper's details can persist incidentally is `workflow_runs.log`,
     * which stores a run's tool output verbatim. So this logs the identifiers a
     * human needs to search that — Shopify allows 30 days to answer — rather
     * than silently claiming there is nothing to look at.
     */
    case "customers/data_request":
      console.log(
        "[shopify/compliance] data_request",
        JSON.stringify({
          shop,
          requestId: payload.data_request?.id ?? null,
          customerId: payload.customer?.id ?? null,
          orders: payload.orders_requested?.length ?? 0,
        }),
      );
      return NextResponse.json({ received: true });

    /*
     * Erase one shopper. There is no per-shopper row to delete, for the reason
     * above, so an acknowledgement is the honest answer rather than a delete
     * that touches nothing and looks thorough in a diff. If a future feature
     * ever caches order or customer rows, THIS is the branch that has to grow
     * a real deletion — not a new endpoint.
     */
    case "customers/redact":
      console.log(
        "[shopify/compliance] customers_redact",
        JSON.stringify({
          shop,
          customerId: payload.customer?.id ?? null,
          orders: payload.orders_to_redact?.length ?? 0,
        }),
      );
      return NextResponse.json({ received: true });

    /*
     * The store uninstalled ZidaneAI 48 hours ago. This is the one compliance
     * topic where we genuinely hold something, and three things go in the order
     * that fails safely:
     *
     *   1. the Composio connected account, where the live access token sits —
     *      leaving it keeps a revoked store reachable;
     *   2. our encrypted copy of the token in `shopify_installs`;
     *   3. the cached `integrations` row, so the screen stops claiming a
     *      connection.
     *
     * A FAILURE RETURNS 500 ON PURPOSE. `src/app/api/AGENTS.md` says provider
     * webhooks should prefer 200 so the provider doesn't back off, which is
     * right for a charge that cannot be retried into existence and exactly
     * wrong for an erasure: Shopify's retry is the only thing that finishes the
     * job, and a 200 over a failed delete is the one lie here with a legal cost.
     */
    case "shop/redact": {
      const target = normalizeShop(shop);
      if (!target) {
        // Signed by Shopify but naming no store we can act on. Retrying will
        // not improve it, so this is an acknowledged no-op.
        console.error("[shopify/compliance] shop_redact with no usable shop domain");
        return NextResponse.json({ received: true });
      }

      try {
        const install = await readInstall(target);

        // `entityId` IS the workspace id for any signed-in workspace — see
        // `resolveRequestContext` in `lib/workspace.ts`. A webhook has no
        // session, so the stored workspace is the only way back to the account.
        if (install?.workspaceId) {
          await socialProvider.disconnectPlatform(install.workspaceId, "shopify");
          await createAdminClient()
            .from("integrations")
            .update({ status: "disconnected", connected_account_id: null })
            .eq("workspace_id", install.workspaceId)
            .eq("platform", "shopify");
        }

        await deleteInstall(target);
      } catch (err) {
        console.error("[shopify/compliance] shop_redact failed:", err);
        return NextResponse.json({ error: "Erasure failed." }, { status: 500 });
      }

      console.log("[shopify/compliance] shop_redact", JSON.stringify({ shop: target }));
      return NextResponse.json({ received: true });
    }

    default:
      // Verified as Shopify's, but a topic this endpoint was not registered
      // for. A 4xx would make Shopify retry a delivery nobody wants.
      console.warn("[shopify/compliance] unexpected topic:", topic);
      return NextResponse.json({ received: true });
  }
}
