import { chatJSON } from "./openai";
import { runFirecrawl, FirecrawlError } from "@/lib/integrations/firecrawl";
import { assertPublicUrl } from "@/lib/net/public-url";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import type { WebsiteAnalysis } from "@/lib/brand";

/**
 * Fetch a website's content and distill it into a structured brand/product
 * profile the agents can write from.
 *
 * Scrape path: Firecrawl (FIRECRAWL_API_KEY) for clean markdown from JS-heavy
 * sites; otherwise a plain fetch with tag stripping. Extraction runs through
 * OpenAI either way.
 */
export async function analyzeWebsite(rawUrl: string): Promise<WebsiteAnalysis | null> {
  const url = await assertPublicUrl(rawUrl);
  if (!url) return null;

  const text = (await scrapeWithFirecrawl(url)) ?? (await scrapePlain(url));
  if (!text || text.length < 100) return null;

  const system = `You analyze a company's website and return a JSON brand profile.
Be specific and concrete — pull real product names, real claims, real audience signals from the text.
Return strict JSON:
{
 "description": "1-2 sentence plain description of what the product is and does",
 "productType": "e.g. B2B SaaS, mobile app, e-commerce, agency",
 "valueProps": ["up to 5 core value propositions, short"],
 "features": ["up to 6 named features/capabilities"],
 "voice": "brand voice in a short phrase (e.g. 'plain-spoken, confident, founder-to-founder')",
 "language": "the language the site is WRITTEN IN, as an English name (e.g. 'English', 'Spanish', 'German'). Judge it from the body copy, not from the domain or the company name",
 "targetAudience": "who this is clearly for",
 "brandColors": ["hex or color names if inferable, else []"],
 "keywords": ["up to 10 recurring on-brand words/phrases"],
 "pricingModel": "pricing model if visible, else ''",
 "socialProof": "notable customers/metrics/testimonials if visible, else ''"
}`;

  try {
    const out = await chatJSON<WebsiteAnalysis>(
      [
        { role: "system", content: system },
        { role: "user", content: `Website: ${url}\n\nContent:\n${text.slice(0, 14_000)}` },
      ],
      { temperature: 0.2, maxTokens: 900 },
    );
    if (out && (out.description || out.valueProps?.length)) return out;
    return null;
  } catch {
    return null;
  }
}

async function scrapeWithFirecrawl(url: string): Promise<string | null> {
  try {
    const result = await runFirecrawl(
      { operation: "scrape", url },
      { timeoutMs: 90_000 },
    );
    return result.kind === "result" ? result.text ?? null : null;
  } catch (error) {
    // The onboarding contract is deliberately best-effort: an absent or
    // temporarily unavailable server key falls through to the existing plain
    // fetch path. The adapter still owns all provider errors and never leaks
    // the key into this layer.
    if (error instanceof FirecrawlError) return null;
    return null;
  }
}

/** No-key fallback: fetch the page and strip tags to readable text. */
async function scrapePlain(url: string): Promise<string | null> {
  try {
    const res = await fetchPublicUrl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZidaneAI/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return null;
  }
}
