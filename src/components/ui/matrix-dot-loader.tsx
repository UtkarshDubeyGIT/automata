"use client";

import { useEffect, useState, type CSSProperties } from "react";

const GRID_SIZE = 5;
const DOT_COUNT = GRID_SIZE * GRID_SIZE;

const SPIRAL = [
  0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 6, 7, 8,
  13, 18, 17, 16, 11, 12,
];
const SCATTER = [
  12, 2, 18, 6, 23, 0, 14, 9, 21, 4, 16, 11, 7, 24, 1, 19, 5, 22, 8,
  15, 3, 20, 10, 17, 13,
];

const VARIANTS = [
  "spiral-in",
  "spiral-out",
  "orbit",
  "diagonal",
  "bloom",
  "scatter",
] as const;

type MatrixVariant = (typeof VARIANTS)[number];
type OrderedVariant = Exclude<MatrixVariant, "diagonal" | "bloom">;

const ORDER: Record<OrderedVariant, readonly number[]> = {
  "spiral-in": SPIRAL,
  "spiral-out": [...SPIRAL].reverse(),
  orbit: SPIRAL.slice(0, 16),
  scatter: SCATTER,
};

function dotDelay(variant: MatrixVariant, cell: number): number {
  const row = Math.floor(cell / GRID_SIZE);
  const col = cell % GRID_SIZE;

  if (variant === "diagonal") return (row + col) * 190;
  if (variant === "bloom") {
    return Math.max(Math.abs(row - 2), Math.abs(col - 2)) * 310;
  }

  const step = ORDER[variant].indexOf(cell);
  return step * (variant === "orbit" ? 130 : variant === "scatter" ? 104 : 100);
}

/** One random pattern per mounted agent busy state. */
export function MatrixDotLoader() {
  const [variant, setVariant] = useState<MatrixVariant | null>(null);

  useEffect(() => {
    // Choose after hydration; the initial grid stays still until a variant is set.
    const selected = VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
    const frame = requestAnimationFrame(() => setVariant(selected));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <span className="t-matrix" data-variant={variant ?? undefined} aria-hidden="true">
      {Array.from({ length: DOT_COUNT }, (_, cell) => {
        const innerOrbitDot = variant === "orbit" && !ORDER.orbit.includes(cell);
        return (
          <i
            key={cell}
            className={innerOrbitDot ? "is-inner" : undefined}
            style={
              variant && !innerOrbitDot
                ? ({ "--matrix-delay": `${dotDelay(variant, cell)}ms` } as CSSProperties)
                : undefined
            }
          />
        );
      })}
    </span>
  );
}
