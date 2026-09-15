import type { IconName } from "@/components/ui/icon";
import type { Persona } from "@/lib/brand";

/**
 * The seven tint slots declared in globals.css. Deliberately NOT the `TILE`
 * palette from src/lib/data/workflows.ts: that one spends two of its six slots
 * on `--success` and `--danger`, so a persona card rendered in it would read as
 * a status rather than a choice.
 */
export type OnboardTint = "amber" | "rose" | "blue" | "green" | "violet" | "teal" | "slate";

export function tintColors(tint: OnboardTint): { bg: string; fg: string } {
  return { bg: `var(--onboard-${tint})`, fg: `var(--onboard-${tint}-fg)` };
}

export interface PersonaOption {
  id: Persona;
  label: string;
  description: string;
  icon: IconName;
  tint: OnboardTint;
}

export const PERSONAS: readonly PersonaOption[] = [
  { id: "founder", label: "Founder", description: "Building a company", icon: "rocket", tint: "amber" },
  { id: "freelancer", label: "Freelancer", description: "Independent client work", icon: "user", tint: "teal" },
  { id: "marketer", label: "Marketer", description: "Growth and campaigns", icon: "megaphone", tint: "rose" },
  { id: "developer", label: "Developer", description: "Building software", icon: "code", tint: "blue" },
  { id: "creator", label: "Creator", description: "Audience and content", icon: "video", tint: "violet" },
  { id: "professional", label: "Professional", description: "In-house at a company", icon: "briefcase", tint: "slate" },
  { id: "student", label: "Student", description: "Learning and side projects", icon: "notebook", tint: "green" },
] as const;

export interface ToneOption {
  id: string;
  label: string;
  description: string;
  /**
   * What actually lands in `brand_profile.tone`.
   *
   * `brandContext()` renders this verbatim as `Brand Voice: <value>`, so a bare
   * slug like "punchy" would be most of what the model has to go on. The
   * sentence gives it something to act on, and stays under the 200-character
   * limit the settings form enforces so it remains editable there afterwards.
   */
  value: string;
  icon: IconName;
  tint: OnboardTint;
}

export const TONES: readonly ToneOption[] = [
  { id: "punchy", label: "Punchy", description: "Short, bold, high energy", value: "Punchy — short sentences, bold claims, high energy, no preamble.", icon: "zap", tint: "amber" },
  { id: "warm", label: "Warm", description: "Friendly, human, conversational", value: "Warm — friendly and human, conversational, speaks to one person.", icon: "heart", tint: "rose" },
  { id: "technical", label: "Technical", description: "Precise, detailed, no fluff", value: "Technical — precise and specific, correct terminology, no filler.", icon: "crosshair", tint: "blue" },
  { id: "polished", label: "Polished", description: "Professional and considered", value: "Polished — professional and considered, clearly structured.", icon: "check-circle", tint: "slate" },
  { id: "playful", label: "Playful", description: "Witty, casual, light", value: "Playful — witty and casual, a light touch, plain words.", icon: "sparkles", tint: "violet" },
  { id: "candid", label: "Candid", description: "Direct, no marketing speak", value: "Candid — direct and honest, plain-spoken, no marketing speak or hype.", icon: "message-circle", tint: "teal" },
] as const;

/** Suggestions for `brand_profile.audience`, which stays a free-text field. */
export const AUDIENCES: readonly string[] = [
  "Developers",
  "Founders",
  "Marketers",
  "Consumers",
  "Executives",
  "Small businesses",
  "Students",
] as const;

export function toneByValue(value: string | undefined): ToneOption | undefined {
  return value ? TONES.find((t) => t.value === value) : undefined;
}
