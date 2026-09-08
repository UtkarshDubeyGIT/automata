import { normalizeWebsite, type BrandProfile, type BrandKit, type WebsiteAnalysis } from "@/lib/brand";
import { siteHost, brandWord } from "@/lib/net/host";

/**
 * The brand a product demo is ABOUT, when that is not the workspace's own site.
 *
 * A demo is the one video kind whose subject is chosen per request: Playwright
 * records whatever URL was typed. Everything downstream, though, was grounded in
 * the workspace brand profile — so recording a competitor's site produced a
 * faithful walkthrough of THEIR product narrated as if it were YOURS, with your
 * domain on the end card and your name force-repaired into the captions.
 *
 * The fix is a substitution rather than a new parameter: `addVoiceover` takes a
 * single `profile`, and that one value feeds the script writer's brand block,
 * the canonical spellings the captions are repaired against, the end card and
 * the caption styling. Hand it a profile describing the recorded site and every
 * one of those is corrected at once.
 *
 * What the workspace still contributes is its VOICE — the language decision, the
 * tone, the writing rules typed into Settings. Those are how the user writes,
 * not who they are, and they should survive. Its IDENTITY never crosses over:
 * no company, no website, no description, no ICP, no goals, no CTA.
 */

/**
 * The company name, from the domain.
 *
 * `WebsiteAnalysis` has no company field — it describes what a product does, not
 * what it is called — and the visual kit carries no name either. The domain word
 * is therefore the only name available without changing what onboarding stores.
 * It is right for `atlassian.com` and weak for an acronym domain; a weak name is
 * still enormously better than a confidently wrong one.
 */
export function subjectName(url: string): string {
  const word = brandWord(url);
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Build the subject profile for a demo of someone else's site.
 *
 * Pure and synchronous on purpose: it runs inside the block that owns the credit
 * refund, where anything that can throw would refund a demo that already exists.
 *
 * `analysis: null` is not a failure mode needing a flag — it IS the neutral
 * degrade. The profile then carries a name, a domain, the captured look and the
 * workspace's voice, and nothing else, so `brandContext` states only who the
 * clip is about and `canonicalTerms` protects only that spelling. What it must
 * never do is fall back to the workspace dossier, which is the original bug.
 */
export function buildDemoSubject(input: {
  /** The URL that was actually recorded — post-redirect where known. */
  url: string;
  /** A fresh reading of THAT url, or null when it could not be read. */
  analysis: WebsiteAnalysis | null;
  /** The kit read off the same page during capture. */
  brandKit?: BrandKit | null;
  /** Voice donor only. Never an identity donor. */
  workspace: BrandProfile | null;
}): BrandProfile {
  const { url, analysis, brandKit, workspace } = input;
  return {
    company: subjectName(url) || undefined,
    website: normalizeWebsite(url),
    analysis: analysis ?? undefined,
    brandKit: brandKit ?? undefined,
    // Voice, carried across. `language` is the workspace's explicit decision;
    // with the subject's own `analysis` in place, `narrationLanguage` then falls
    // through to the language the RECORDED site is written in rather than to the
    // user's — which is the right order for both.
    language: workspace?.language,
    tone: workspace?.tone,
    voiceGuidelines: workspace?.voiceGuidelines,
    // Everything else is deliberately absent:
    //  - `productType` is a slug keyed into PRODUCT_TYPE_LABEL, while
    //    `analysis.productType` is free text ("B2B SaaS"). Copying one into the
    //    other reads as a label lookup miss, not as a product type.
    //  - `cta` outranks the generated call to action on the end card, so a
    //    workspace CTA would put "Start your free trial" on a stranger's card.
    //  - `icp`, `goals`, `research`, `assets` are the user's business, not the
    //    demoed product's.
  };
}

/**
 * Ground the narration concept in what is actually on screen.
 *
 * The client no longer seeds a third-party demo's prompt from the saved brand,
 * but a stored prompt from before this change — or any API caller — can still
 * arrive naming the wrong company. The subject profile alone usually wins that
 * argument; saying it in the concept line too costs nothing and removes the
 * argument. Used only for the narration call: `videos.prompt` keeps the user's
 * own words, because that is what the history list shows back to them.
 */
export function demoNarrationPrompt(userPrompt: string, subject: BrandProfile): string {
  const host = siteHost(subject.website);
  const named = [subject.company, host ? `(${host})` : ""].filter(Boolean).join(" ");
  if (!named) return userPrompt;
  const lead = `Screen recording walkthrough of ${named}. Describe what is on screen.`;
  const rest = (userPrompt ?? "").trim();
  return rest ? `${lead} ${rest}` : lead;
}
