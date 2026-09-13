/**
 * The new-joiner promotion: every fresh account starts with a credit bonus.
 *
 * The credits themselves are granted by the `sync_runtime_workspace` trigger
 * (reason `signup_bonus`) the moment a workspace is created; nothing here
 * touches the ledger. This module only decides *whether to celebrate* — the
 * landing-page teaser and the in-app congratulations dialog both read from it.
 *
 * "Seen" state lives in localStorage on purpose (product decision: no
 * migration for a promo). Because that can't distinguish a brand-new account
 * from an old one on a new browser, the in-app dialog is additionally gated
 * by workspace age via `isNewWorkspace`.
 */

export const WELCOME_BONUS_CREDITS = 1_000;

export const LANDING_PROMO_KEY = "automata:promo:landing-seen";
export const APP_WELCOME_KEY = "automata:promo:welcome-seen";

/** How long after sign-up an account still counts as "first-time". */
export const NEW_WORKSPACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function hasSeen(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    // Storage blocked (private mode, disabled cookies): treat as seen so we
    // never nag a visitor we can't remember.
    return true;
  }
}

export function markSeen(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Nothing to do; hasSeen() will report true on this browser anyway.
  }
}

export function isNewWorkspace(
  createdAt: string | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = NEW_WORKSPACE_WINDOW_MS,
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  const age = now - created;
  return age >= 0 && age <= maxAgeMs;
}
