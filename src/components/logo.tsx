import Link from "next/link";

import { BRAND } from "@/config/brand";

/**
 * The Automata mark: an "A" drawn as a node graph, with an arrow leaving the
 * junction node. Strokes and rings are all `currentColor` and the rings are
 * hollow, so the mark reads correctly on any background — white on dark,
 * black on light — without a second asset.
 */
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.37 8.16 7.14 23.84M14.5 8 18 15M20.97 19.71 24.53 24.29M8.55 24.91 16.95 19.09M21.23 15.52 28.25 8.5M23.05 8.5h5.2v5.2" />
      <circle cx="13.25" cy="5.5" r="2.2" />
      <circle cx="6.25" cy="26.5" r="2.2" />
      <circle cx="19.25" cy="17.5" r="2.2" />
      <circle cx="26.25" cy="26.5" r="2.2" />
    </svg>
  );
}

export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link className="inline-flex items-center gap-2.5 font-display text-[19px] font-semibold leading-none tracking-[-0.025em] text-ink" href={href} aria-label={`${BRAND.name} home`}>
      <span className="inline-flex h-8 w-8 items-center" aria-hidden="true">
        <LogoMark />
      </span>
      {!compact && <span>{BRAND.name}</span>}
    </Link>
  );
}
