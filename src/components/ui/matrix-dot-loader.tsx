"use client";

import { useEffect, useState, type CSSProperties } from "react";

const GRID_SIZE = 4;
const DOT_COUNT = GRID_SIZE * GRID_SIZE;

const SPIRAL = [
  0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4, 5, 6, 10, 9,
];
const SCATTER = [10, 1, 14, 3, 8, 5, 12, 0, 15, 2, 9, 6, 13, 4, 11, 7];

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
  orbit: SPIRAL.slice(0, 12),
  scatter: SCATTER,
};

function dotDelay(variant: MatrixVariant, cell: number): number {
  const row = Math.floor(cell / GRID_SIZE);
  const col = cell % GRID_SIZE;

  if (variant === "diagonal") return (row + col) * 190;
  if (variant === "bloom") {
    return Math.max(Math.abs(row - 1.5), Math.abs(col - 1.5)) * 310;
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
