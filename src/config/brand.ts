export const BRAND = {
  name: process.env.NEXT_PUBLIC_APP_NAME || "Automata",
  repo: "automata",
  tagline: "Tell it once. Watch work move.",
  description: "A visual automation workspace that connects your tools, runs the repetition, and knows when a human should take over.",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@automata.local",
} as const;
