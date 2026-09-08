import type { BrandProfile } from "@/lib/brand";

/**
 * The spellings that must survive the pipeline intact.
 *
 * A brand name passes through three models before it reaches the screen: the
 * script writer types it, TTS pronounces it, and Whisper transcribes what TTS
 * said in order to time the captions. Each one is an opportunity to get it
 * wrong, and the third is the worst — it is guessing at audio we generated from
 * text we still had. The first real run captioned a brand as "ZDANE AI" and
 * burned it into the video.
 *
 * Timing genuinely has to come from the transcription. The WORDS do not: they
 * are known, and for the handful that identify the customer — company, product,
 * domain, call to action — they are known exactly. So those are repaired
 * against the workspace record rather than trusted from any model.
 */

/** Canonical strings for a workspace, longest first so "Acme Cloud" beats "Acme". */
export function canonicalTerms(profile: BrandProfile | null | undefined): string[] {
  if (!profile) return [];
  const out = new Set<string>();

  const add = (v: string | undefined | null) => {
    const t = (v ?? "").trim();
    // One- and two-letter tokens are not identities; matching them would
    // rewrite ordinary words.
    if (t.length >= 3 && t.length <= 60) out.add(t);
  };

  add(profile.company);
  add(profile.analysis?.productType);
  add(profile.cta);

  // The domain, in the form a person would say and read.
  const site = (profile.website ?? "").trim();
  if (site) {
    try {
      const u = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
      const host = u.hostname.replace(/^www\./, "");
      add(host);
      // The bare brand word out of the domain, which is what a narrator says.
      add(host.split(".")[0]);
    } catch {
      /* not a URL we can read */
    }
  }

  return [...out].sort((a, b) => b.length - a.length);
}

/** Letters and digits only — the comparable core of a token. */
function core(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Levenshtein distance, capped: we only care whether it is small.
 * Bails out as soon as the best possible result exceeds `max`.
 */
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * How much misspelling to forgive, by term length.
 *
 * Short names get no latitude at all — at three or four letters, an edit
 * distance of one is a different word, not a typo. Longer names get one or two,
 * which is the range real transcription errors land in ("Zdane" for "Zidane",
 * "Acme Cloud" for "AcmeCloud").
 */
function tolerance(term: string): number {
  const n = core(term).length;
  if (n <= 5) return 0;
  if (n <= 9) return 1;
  return 2;
}

/**
 * Repair canonical spellings in `text`.
 *
 * Works over word RUNS, not single words, because a multi-word name is exactly
 * what gets split: "ZidaneAI" is spoken as two syllables and comes back as two
 * tokens. Each canonical term is matched against every run of the same word
 * count, comparing on letters only so punctuation and casing do not block it.
 *
 * Longest terms are applied first (see `canonicalTerms`), so a specific name
 * wins over a shorter one contained in it.
 */
export function repairTerms(text: string, terms: string[]): string {
  if (!text || terms.length === 0) return text;
  // Whitespace is normalised on the way out, so plain word tokens are enough.
  const words = text.trim().split(/\s+/);

  /**
   * Words a term has already claimed — whether it corrected them or found them
   * already correct.
   *
   * Without this a shorter term re-matches text a longer one just fixed and
   * overwrites it with less. Measured: "northwindfeild.co" was correctly
   * repaired to "northwindfield.co" by the domain term, and then the bare brand
   * word "northwindfield" matched that result within tolerance and replaced it,
   * silently deleting the TLD. Longest-first ordering only helps if the first
   * match is also the last one.
   */
  const locked = new Array<boolean>(words.length).fill(false);

  for (const term of terms) {
    const termCore = core(term);
    if (!termCore) continue;
    const span = term.trim().split(/\s+/).length;
    const tol = tolerance(term);

    for (let i = 0; i + span <= words.length; i++) {
      if (!words[i]) continue;
      let claimed = false;
      for (let k = i; k < i + span; k++) if (locked[k]) claimed = true;
      if (claimed) continue;

      const runCore = core(words.slice(i, i + span).join(" "));
      if (!runCore) continue;

      // Already exactly right: lock it so no shorter term can rewrite it.
      if (runCore === termCore) {
        for (let k = i; k < i + span; k++) locked[k] = true;
        continue;
      }
      // Much longer than the term means a different phrase that merely starts
      // the same way, not a misspelling of it.
      if (Math.abs(runCore.length - termCore.length) > tol) continue;
      if (!withinDistance(runCore, termCore, tol)) continue;

      // Keep any trailing punctuation the run ended on.
      const tail = words[i + span - 1].match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";
      words[i] = term + tail;
      for (let k = i + 1; k < i + span; k++) words[k] = "";
      for (let k = i; k < i + span; k++) locked[k] = true;
    }
  }

  return words.filter(Boolean).join(" ");
}
