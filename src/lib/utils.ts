import { clsx, type ClassValue } from "clsx";

/** Merge class names; thin wrapper so components stay tidy. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** Format large numbers compactly: 24580 -> "24,580", 2_400_000 -> "2.4M". */
export function compactNumber(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }
  return new Intl.NumberFormat("en-US").format(n);
}

/** Relative-ish label for a Date or ISO string. */
export function timeAgo(input: Date | string) {
  const d = typeof input === "string" ? new Date(input) : input;
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}
