"use client";

import * as React from "react";

/**
 * A one-shot confetti burst on a full-screen canvas. Hand-rolled rather than a
 * dependency: the whole effect is ~80 lines and we only need it for the
 * welcome promo.
 *
 * Sits at z-[110] so pieces fall over Dialog (z-[100]); pointer-events are
 * off so the scrim and buttons underneath keep working. Honours
 * prefers-reduced-motion by rendering nothing at all.
 */

const COLORS = ["#6366f1", "#f59e0b", "#ec4899", "#22c55e", "#38bdf8", "#ffffff"];
const DURATION_MS = 2600;
const PIECES = 160;

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  color: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ConfettiBurst({ onDone }: { onDone?: () => void } = {}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  // Only ever mounted client-side (behind an `open` flag), so reading the
  // media query in the initialiser is safe and avoids a wasted first frame.
  const [active, setActive] = React.useState(() => !prefersReducedMotion());

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const size = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);

    const W = window.innerWidth;
    const H = window.innerHeight;
    // Two cannons at the bottom corners firing towards the centre.
    const pieces: Piece[] = Array.from({ length: PIECES }, (_, i) => {
      const left = i % 2 === 0;
      const angle = (left ? -70 : -110) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
      const speed = 11 + Math.random() * 9;
      return {
        x: left ? W * 0.08 : W * 0.92,
        y: H * 0.85,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: COLORS[i % COLORS.length],
      };
    });

    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      const fade = t > DURATION_MS - 600 ? Math.max(0, (DURATION_MS - t) / 600) : 1;
      for (const p of pieces) {
        p.vy += 0.35; // gravity
        p.vx *= 0.99; // drag
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < DURATION_MS) {
        raf = requestAnimationFrame(frame);
      } else {
        setActive(false);
        onDone?.();
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
    // Fire exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!active) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[110] h-full w-full"
    />
  );
}
