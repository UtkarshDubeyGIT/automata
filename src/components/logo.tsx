import Link from "next/link";

import { BRAND } from "@/config/brand";

export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link className="inline-flex items-center gap-2.5 font-display text-[19px] font-semibold leading-none tracking-[-0.025em] text-ink" href={href} aria-label={`${BRAND.name} home`}>
      <span className="inline-flex h-8 w-8 items-center text-brand" aria-hidden="true">
        <svg viewBox="0 0 38 28" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <path d="M4 19 13 8l10 8L33 5" />
          <path d="m27.5 4.5 6-.2-.5 6" />
          <circle className="fill-brand" stroke="white" strokeWidth="1.5" cx="4" cy="19" r="3.4" />
          <circle className="fill-indigo-400" stroke="white" strokeWidth="1.5" cx="13" cy="8" r="3.4" />
          <circle className="fill-indigo-800" stroke="white" strokeWidth="1.5" cx="23" cy="16" r="3.4" />
        </svg>
      </span>
      {!compact && <span>{BRAND.name}</span>}
    </Link>
  );
}
