"use client";

import { useState } from "react";

import { toolkitLogo } from "@/lib/social/platforms";

/**
 * The app logo, everywhere.
 *
 * One source of truth for "what does Gmail look like in this product": the
 * real, full-colour brand mark from Composio's logo CDN, keyed by toolkit
 * slug, with a lettermark for the handful of apps that have no logo on file.
 *
 * Deliberately stateless in appearance — no hover, no grayscale, no tint. A
 * logo means "this step touches this app", and that reads the same on a
 * marketing page, a template card, and a canvas node. Chrome (plate, border,
 * radius) belongs to the caller through `className`.
 */
export function ToolLogo({
  slug,
  label,
  size,
  className = "",
}: {
  slug: string;
  label?: string;
  /** Rendered size in px. Omit to let the caller's CSS size it. */
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const dimensions = size ? { width: size, height: size } : undefined;

  if (broken) {
    return (
      <span
        className={`inline-grid flex-none place-items-center font-semibold uppercase ${className}`}
        style={dimensions}
        aria-hidden="true"
      >
        {slug.slice(0, 2)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={toolkitLogo(slug)}
      alt=""
      title={label}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className={`flex-none object-contain ${className}`}
      style={dimensions}
    />
  );
}
