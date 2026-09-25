"use client";

import { useEffect, useRef, type CSSProperties } from "react";

const DOT_COUNT = 16;
const DEFAULT_CYCLE_MS = 1200;

/** Small, accessible-as-decoration Matrix dot loader for inline busy states. */
export function MatrixDotLoader() {
  const loaderRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader) return;

    const configuredCycle = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--matrix-cycle"),
    );
    const cycle = configuredCycle || DEFAULT_CYCLE_MS;

    loader.querySelectorAll<HTMLElement>("i").forEach((dot, index) => {
      dot.style.setProperty("--d", String(Math.round((index % 4) * (cycle / 10))));
    });
  }, []);

  return (
    <span ref={loaderRef} className="t-matrix" data-variant="scan" aria-hidden="true">
      {Array.from({ length: DOT_COUNT }, (_, index) => (
        <i
          key={index}
          style={{ "--d": Math.round((index % 4) * (DEFAULT_CYCLE_MS / 10)) } as CSSProperties}
        />
      ))}
    </span>
  );
}
