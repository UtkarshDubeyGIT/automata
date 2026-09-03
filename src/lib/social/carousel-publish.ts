import { linkedinAuthorUrn } from "./composio";
import { renderCarouselPdf, type CarouselBrand } from "./carousel-pdf";
import { linkedinConnectedAccountId, publishCarousel } from "./linkedin-document";
import type { CarouselSlide } from "@/lib/ai/content";
import type { PostResult } from "./composio";

/**
 * Publishing a carousel, end to end.
 *
 * Kept out of `composio.ts` on purpose. That module is imported by client
 * components for its channel metadata, so anything it references — even behind
 * a dynamic import — is pulled into the browser bundle, and this path reaches
 * Playwright. Everything here is server-only and stays that way; the publisher
 * is the only caller.
 *
 * The split is also honest about what is happening: every other channel is a
 * Composio tool call, and this one is a direct conversation with LinkedIn
 * because their document API is not in the toolkit.
 */
export async function publishLinkedInCarousel(input: {
  entityId: string;
  slides: CarouselSlide[];
  /** Flattened slide text — the post's commentary above the document. */
  text: string;
  title: string;
  brand?: CarouselBrand;
  /** Post as a company page rather than the member. */
  pageId?: string;
}): Promise<PostResult> {
  const connectedAccountId = await linkedinConnectedAccountId(input.entityId);
  if (!connectedAccountId) {
    return {
      ok: false,
      error: "No active LinkedIn connection — reconnect the account to publish carousels.",
    };
  }

  const author = await linkedinAuthorUrn(input.entityId, input.pageId);
  if (!author) return { ok: false, error: "Could not resolve LinkedIn author id" };

  const pdf = await renderCarouselPdf(input.slides, input.brand ?? {});
  const { id } = await publishCarousel({
    connectedAccountId,
    author,
    commentary: input.text,
    pdf,
    // LinkedIn rejects an over-long document title outright.
    title: input.title.slice(0, 100) || "Carousel",
  });
  return { ok: true, externalId: id || undefined };
}
