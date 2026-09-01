import Link from "next/link";

import { BRAND } from "@/config/brand";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand-mark" href="/" aria-label={`${BRAND.name} home`}>
      <span className="brand-glyph" aria-hidden="true">
        <svg viewBox="0 0 38 28" focusable="false">
          <path className="brand-route" d="M4 19 13 8l10 8L33 5" />
          <path className="brand-arrow" d="m27.5 4.5 6-.2-.5 6" />
          <circle className="brand-node node-start" cx="4" cy="19" r="3.4" />
          <circle className="brand-node node-middle" cx="13" cy="8" r="3.4" />
          <circle className="brand-node node-end" cx="23" cy="16" r="3.4" />
        </svg>
      </span>
      {!compact && <span>{BRAND.name}</span>}
    </Link>
  );
}
