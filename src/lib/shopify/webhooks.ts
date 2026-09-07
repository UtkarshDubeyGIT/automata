import { verifyWebhookHmac } from "@/lib/shopify/oauth";

/**
 * The shared front half of every Shopify compliance webhook.
 *
 * Two of Shopify's automated review checks land on these routes — "Provides
 * mandatory compliance webhooks" and "Verifies webhooks with HMAC signatures"
 * — and the second is tested by sending a DELIBERATELY BAD signature and
 * expecting `401`. An endpoint that answers 200 to everything fails review
 * even though it looks like it works.
 *
 * The body is read as TEXT, always. The signature covers the exact bytes
 * Shopify sent, so a handler that reaches for `req.json()` first has already
 * lost them — re-serializing changes key order and whitespace, and the digest
 * never matches again. This is the single most common way this check fails.
 */

export interface CompliancePayload {
  shop_domain?: string;
  shop_id?: number;
  customer?: { id?: number; email?: string };
  orders_requested?: number[];
  orders_to_redact?: number[];
  data_request?: { id?: number };
}

export type VerifiedWebhook =
  | { ok: true; payload: CompliancePayload; shop: string }
  | { ok: false };

export async function readVerifiedWebhook(req: Request): Promise<VerifiedWebhook> {
  const raw = await req.text();
  if (!verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"))) return { ok: false };

  try {
    const payload = JSON.parse(raw) as CompliancePayload;
    // The header is the authority on which store this is: it is covered by the
    // signature we just checked, and the body field is merely a copy.
    const shop = req.headers.get("x-shopify-shop-domain") ?? payload.shop_domain ?? "";
    return { ok: true, payload, shop };
  } catch {
    // A verified body that isn't JSON is Shopify changing shape, not an
    // intruder. Refusing it would make Shopify retry forever.
    return { ok: false };
  }
}
