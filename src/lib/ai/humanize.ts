/**
 * House style for copy a person will read.
 *
 * Left to itself a language model writes like a language model: em dashes
 * everywhere, an "In today's fast-paced world" opener, "delve" and "testament"
 * and "game-changer" in the middle, and a closing "What do you think? Drop a
 * fire emoji below". `workflows/steps.ts` already records one half of this —
 * four consecutive runs of one automation opened with the same sentence — and
 * the fix there (show the model its own previous output) addressed repetition,
 * not tone.
 *
 * Until now the rules that DO address tone lived as prose inside individual
 * prompts: "no hashtags, no emoji" in `workflows/templates.ts`, "no markdown,
 * no emoji unless the brand uses them" in `./content`, per-channel conventions
 * in `workflows/destination.ts`. There was nowhere to add a banned word once
 * and have every generator respect it. This module is that place.
 *
 * Two halves, deliberately separate:
 *
 *   `humanStyleRules()` is the instruction half, and it is the ONLY lever for
 *   anything that needs a rewrite to fix — rhythm, vocabulary, openers, canned
 *   CTAs. Catching those in code would mean regenerating, and this app spends
 *   no second model call on style: an `ai_step` already retries twice on
 *   provider errors inside a claimed run, and style is not worth the latency
 *   there.
 *
 *   `sanitizeHumanText()` is the guarantee half. It covers only what can be
 *   fixed without rewriting a sentence. Those rules are absolute, so they must
 *   not depend on the model having complied.
 *
 * Dependency-free on purpose, exactly like `./content-vocabulary` — no `env`,
 * no OpenAI client, no Supabase — so a browser picker or a test can import it
 * without mocks.
 */

/**
 * Vocabulary that marks copy as machine-written.
 *
 * Prompt-only. A word cannot be swapped out mechanically without rewriting the
 * sentence around it, so this list is rendered into the prompt and never
 * enforced against output — a brand genuinely in landscaping is allowed to say
 * "landscape". One constant so adding a word is a one-line change every
 * generator picks up.
 */
export const HUMAN_BANNED_WORDS: readonly string[] = [
  "delve",
  "boasts",
  "underscores",
  "showcases",
  "testament",
  "elevate",
  "game-changer",
  "unlock",
  "robust",
  "vibrant",
  "landscape",
];

/** Engagement bait. Prompt-only, for the same reason as the word list. */
const CANNED_CTAS: readonly string[] = [
  "drop a fire emoji",
  "tag a friend",
  "comment below",
  "link in bio",
  "let me know your thoughts",
];

/**
 * Wrap-up filler, stripped when it opens a sentence.
 *
 * Unlike the banned words these are pure scaffolding: delete the phrase,
 * capitalise what follows, and the sentence still says the same thing. Kept
 * narrow on purpose — "ultimately" and "in short" are things people genuinely
 * write, and a false positive here edits a real author's meaning.
 */
const WRAP_UP_FILLER: readonly string[] = [
  "in conclusion",
  "in summary",
  "in closing",
  "to sum up",
  "to summarize",
  "to summarise",
  "to conclude",
  "all in all",
  "at the end of the day",
];

const EM_DASH = "—";

/**
 * The punctuation dashes, not only em and en.
 *
 * Zero tolerance on two codepoints is trivially routed around: a model told
 * "no em dashes" reaches for the horizontal bar, the figure dash, or plain
 * `--`. U+2212 MINUS SIGN is deliberately absent — it is a maths operator, and
 * rewriting "− 5 degrees" as ", 5 degrees" would change what the copy says.
 */
const DASH = "[\\u2012\\u2013\\u2014\\u2015\\u2E3A\\u2E3B]";

/**
 * Spaces and tabs, never a line break.
 *
 * `\s*` was the first version and it was wrong: it swallowed the blank line in
 * "We shipped it—\n\nAnd it worked", collapsing two paragraphs into one. Every
 * channel brief in `workflows/destination.ts` asks for short paragraphs
 * separated by blank lines, and the end of a punchy line is exactly where a
 * model puts a dash — so the sanitizer was undoing the formatting the brief had
 * just asked for.
 */
const SP = "[^\\S\\r\\n]*";

/**
 * The house style block, for a system prompt.
 *
 * Worded as a CEILING, never a floor, so it composes with the stricter rules
 * already in play rather than fighting them: `workflows/destination.ts`'s
 * Reddit brief bans emoji outright and `workflows/templates.ts`'s LinkedIn
 * instruction says "no emoji", and "at most two" must not read as permission
 * next to either. Hence the subordination line at the top, and hence "only if
 * the brand already uses them".
 *
 * `closeOnQuestion` is the one rule that is not universal. Ending on a question
 * is right for a LinkedIn post and wrong for a Slack ops alert, a review reply,
 * or an `ai_step` whose output feeds another step — `workflows/templates.ts`
 * has a WhatsApp order alert that explicitly forbids a call to action, and a
 * mandatory question would break it. Callers turn it on only for a real post.
 */
export function humanStyleRules(opts?: { closeOnQuestion?: boolean }): string {
  const lines = [
    "--- HOW TO WRITE ---",
    "These are typing mechanics, not voice. Where the brand context or the channel",
    "conventions above say something different, they win.",
    "",
    "Rhythm: vary sentence length deliberately. No two consecutive sentences may be",
    "the same length. Short fragments are good. Three medium sentences in a row are",
    "the single clearest tell that a machine wrote something.",
    `Dashes: never use an em dash (${EM_DASH}), an en dash (–), or "--". Use a period or a comma.`,
    "Emoji: at most two in the whole piece, only face or hand emoji, and only if the",
    "brand already uses them. Zero is usually right. No decorative symbols.",
    "Opening: never open with a significance statement. Not \"In today's fast-paced",
    "world\", not \"In an era of\", not \"More than ever\". Open on something concrete.",
    "Closing: never close with wrap-up filler. Not \"In conclusion\", not \"To sum up\",",
    "not \"At the end of the day\".",
    `Never use these words: ${HUMAN_BANNED_WORDS.join(", ")}.`,
    "Never use the constructions \"it's not just X, it's Y\" or \"not only ... but also\".",
    `No engagement bait: no ${CANNED_CTAS.map((c) => `"${c}"`).join(", no ")}.`,
  ];
  if (opts?.closeOnQuestion) {
    lines.push(
      "End on a real question, or on a direct address to one reader — something a",
      "specific person would actually answer. Not a template call to action.",
    );
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Clean the rules that must hold whatever the model returned.
 *
 * Idempotent, and tested to be: callers may hand back text that has already
 * been through here (`./content` sanitizes carousel slides before
 * `renderCarousel` re-joins them).
 *
 * Model output ONLY. Never run this over text a person typed — the same rule
 * `workflows/repair.ts`'s `stripPlaceholders` follows, and for the same reason:
 * silently rewriting an author's own punctuation is not a guard rail, it is a
 * bug.
 */
export function sanitizeHumanText(text: string): string {
  if (!text) return text;
  return clean(text, { left: MAX_EMOJI });
}

/**
 * Sanitize the pieces of ONE post that happen to be stored separately.
 *
 * Carousel slides are the case this exists for. "At most two emoji" is a
 * property of the post, and a carousel is one post — running each heading and
 * body through `sanitizeHumanText` would hand every field its own budget and
 * let a ten-slide carousel through with forty emoji. Dashes and filler are
 * per-string either way; only the emoji budget is shared.
 */
export function sanitizeHumanParts(parts: readonly string[]): string[] {
  const budget = { left: MAX_EMOJI };
  return parts.map((part) => (part ? clean(part, budget) : part));
}

/**
 * Sanitize the prose inside a parsed JSON result, leaving its shape alone.
 *
 * This is the path that actually ships. Eleven of the twelve `ai_step` nodes in
 * `workflows/templates.ts` are `output: "json"` — including the flagship daily
 * LinkedIn post, which drafts into `{ text }` and publishes
 * `{{steps.draft_post.result.text}}`. Sanitizing only text mode would have
 * cleaned almost nothing a user ever sees.
 *
 * A leaf is treated as prose only when it contains whitespace. That one test
 * keeps ids, slugs, enum values ("positive"), single tokens and URLs out of
 * reach without having to guess which schema keys hold copy — guessing by key
 * name breaks silently the first time someone names a field `copy`. The whole
 * object shares one emoji budget, because one `ai_step` result is one message.
 */
export function sanitizeHumanJson<T>(value: T): T {
  return walk(value, { left: MAX_EMOJI }) as T;
}

function walk(value: unknown, budget: { left: number }): unknown {
  if (typeof value === "string") return isProse(value) ? clean(value, budget) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, budget));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, budget)]),
    );
  }
  return value;
}

/**
 * Prose has spaces, or a dash joining two words. An id, a slug and an enum
 * value have neither.
 *
 * The dash half matters: "shipped\u2014it works" is one whitespace-free token by
 * the naive test and is exactly the construction being hunted. A slug uses
 * hyphens, never an em dash, so nothing structural is caught by it.
 */
function isProse(value: string): boolean {
  if (/^\s*(https?:\/\/|www\.)\S+\s*$/.test(value)) return false;
  return /\s/.test(value) || new RegExp(DASH).test(value);
}

function clean(text: string, budget: { left: number }): string {
  return capEmoji(stripWrapUpFiller(replaceDashes(text)), budget);
}

/**
 * Every dash to a period or a comma.
 *
 * Zero tolerance, with exactly one exception: dashes inside a URL are left
 * alone. A post carrying a broken link is a worse outcome than a post carrying
 * one dash nobody will read, and a model does not write prose inside a URL.
 */
function replaceDashes(input: string): string {
  const urls: string[] = [];
  // Private-use sentinel, so a URL cannot be touched by the passes below and
  // nothing in real copy can collide with the placeholder.
  const SENTINEL = "";
  let s = input.replace(/https?:\/\/\S+|www\.\S+/g, (m) => {
    urls.push(m);
    return `${SENTINEL}${urls.length - 1}${SENTINEL}`;
  });

  const re = (body: string, flags = "g") => new RegExp(body, flags);

  // A spaced "--" is the same tell wearing a different hat. Spaced only, so a
  // CLI flag ("--watch") and a double-barrelled identifier survive untouched.
  s = s.replace(/(^|[^\S\r\n])-{2,3}(?=[^\S\r\n])/g, `$1${EM_DASH}`);
  // A numeric range is a range, not a clause break. "2020-2024" must not become
  // "2020, 2024", which says something different.
  s = s.replace(re(`(\\d)${SP}${DASH}${SP}(\\d)`), "$1-$2");
  // A dash opening a line is a bullet, not punctuation.
  s = s.replace(re(`^${SP}${DASH}[ \\t]+`, "gm"), "- ");
  s = s.replace(re(`${DASH}{2,}`), EM_DASH);
  // Nothing after it on the line: it was decoration, and a comma there reads as
  // a typo. The line break itself survives.
  s = s.replace(re(`${SP}${DASH}${SP}$`, "gm"), "");
  s = s.replace(re(`^${SP}${DASH}${SP}`, "gm"), "");
  // Already punctuated on one side: drop the dash rather than double up.
  s = s.replace(re(`([,.;:!?])${SP}${DASH}${SP}`), "$1 ");
  s = s.replace(re(`${SP}${DASH}${SP}([,.;:!?])`), "$1");
  // What follows opens with a capital, so it stands alone as a sentence.
  // `\p{Lu}` rather than [A-Z] because `brandContext` emits a content language
  // and non-English output is supported. Scripts without case (Japanese, Thai,
  // Arabic) never match and fall through to the comma, which is the right
  // default for them.
  s = s.replace(re(`${SP}${DASH}${SP}(?=\\p{Lu})`, "gu"), ". ");
  s = s.replace(re(`${SP}${DASH}${SP}`), ", ");

  s = s
    .replace(/,[^\S\r\n]*,+/g, ",")
    .replace(/,[^\S\r\n]*([.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[^\S\r\n]*,[^\S\r\n]*$/gm, "");

  return s.replace(re(`${SENTINEL}(\\d+)${SENTINEL}`), (_, i: string) => urls[Number(i)]);
}

/** Strip "In conclusion, " and friends where they open a sentence. */
function stripWrapUpFiller(input: string): string {
  const alternatives = WRAP_UP_FILLER.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // Sentence start = string start, after terminal punctuation, or after a
  // newline. The second capture is the first surviving word, which is then
  // capitalised so the sentence still opens correctly.
  const re = new RegExp(`(^|[.!?][^\\S\\r\\n]+|\\n[^\\S\\r\\n]*)(?:${alternatives})\\s*,?\\s*(\\p{L})`, "giu");

  // Looped, because stripping one filler can expose another ("In conclusion, to
  // sum up, we shipped"), and this function has to be idempotent.
  let s = input;
  for (let pass = 0; pass < WRAP_UP_FILLER.length; pass++) {
    const next = s.replace(re, (_m, lead: string, first: string) => `${lead}${first.toUpperCase()}`);
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Faces and hands only, two at most.
 *
 * Ranges rather than a literal list so a new Unicode release cannot silently
 * widen the whitelist: an unrecognised codepoint falls outside every range and
 * is stripped, which is the safe direction.
 */
const ALLOWED_EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f600, 0x1f64f], // Emoticons: faces, plus the gesture people
  [0x1f446, 0x1f450], // hand gestures
  [0x270a, 0x270d], // fist, raised hand, victory, writing hand
  [0x1f590, 0x1f590], // splayed hand
  [0x1f596, 0x1f596], // vulcan salute  (0x1f595 is deliberately NOT here)
  [0x1f918, 0x1f91f], // horns, call me, handshake, fingers crossed
  [0x1f90c, 0x1f90c], // pinched fingers
  [0x1f90f, 0x1f90f], // pinching hand
  [0x1f932, 0x1f933], // palms up, selfie
  [0x1f910, 0x1f917], // zipper-mouth through hugging face
  [0x1f920, 0x1f92f], // cowboy through exploding head
  [0x1f970, 0x1f97a], // smiling with hearts through pleading face
  [0x1f9d0, 0x1f9d0], // monocle
  [0x2639, 0x263a], // frowning and smiling face, below the Emoticons floor
  [0x1fae0, 0x1fae6], // melting, saluting, peeking  (0x1fae7 bubbles is not a face)
  [0x1fae8, 0x1fae8], // shaking face
  [0x1faf0, 0x1faf8], // the newer hand block
];

const MAX_EMOJI = 2;

function isAllowedEmoji(grapheme: string): boolean {
  const base = grapheme.codePointAt(0);
  if (base === undefined) return false;
  return ALLOWED_EMOJI_RANGES.some(([lo, hi]) => base >= lo && base <= hi);
}

function capEmoji(input: string, budget: { left: number }): string {
  // Built with `new RegExp` and not a literal: tsconfig targets ES2022 and tsc
  // rejects the `v` flag on a literal (TS1501), while the constructor is not
  // checked. `\p{RGI_Emoji}` and NOT `\p{Extended_Pictographic}` because the
  // latter matches neither keycaps (1 + VS16 + U+20E3) nor flags (regional
  // indicator pairs) — both would have sailed straight past the whitelist,
  // uncounted and unstripped. It also leaves the trademark, copyright and
  // registered signs alone, which Extended_Pictographic would have deleted from
  // brand copy.
  const emoji = new RegExp("\\p{RGI_Emoji}", "gv");
  // Whole graphemes in, whole graphemes out. Never rebuilt from the base
  // codepoint: that would turn the face-exhaling emoji back into a plain face
  // and quietly drop a skin-tone modifier the brand chose.
  const out = input.replace(emoji, (match) => {
    if (!isAllowedEmoji(match) || budget.left <= 0) return "";
    budget.left--;
    return match;
  });
  // Removing one can leave a double space or a space before punctuation.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "");
}
