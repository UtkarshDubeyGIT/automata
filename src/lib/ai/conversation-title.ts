const TITLE_STOP_WORDS = new Set([
  "a", "an", "and", "for", "from", "i", "me", "my", "of", "on", "please",
  "send", "the", "to", "with", "you", "your",
]);

/** A readable title when the model is unavailable. Safe to use in the browser. */
export function fallbackConversationTitle(prompt: string): string {
  const words = prompt.match(/[\p{L}\p{N}][\p{L}\p{N}\x27’_-]*/gu) ?? [];
  const selected = words.filter((word) => !TITLE_STOP_WORDS.has(word.toLocaleLowerCase())).slice(0, 5);
  const titleWords = (selected.length ? selected : words.slice(0, 5)).map(
    (word) => word.slice(0, 1).toLocaleUpperCase() + word.slice(1),
  );
  return titleWords.join(" ").slice(0, 56).trim() || "New conversation";
}

/** Keep the model's answer to one compact, displayable line. */
export function normalizeConversationTitle(raw: string): string {
  const title = raw
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/^[\x22\x27“”‘’]+|[\x22\x27“”‘’]+$/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 56)
    .trim();
  return title.toLocaleLowerCase() === "new conversation" ? "" : title;
}
