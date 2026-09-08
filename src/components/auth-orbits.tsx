"use client";

import * as React from "react";

/* ---------------------------------------------------------------------------
   Auth brand panel — orbiting routines

   A workflow is a set of steps that come round again and again, so the panel
   draws them literally: tilted orbits, each one a routine, each marker a step,
   each travelling pulse a run moving through it.

   Deliberately hand-rolled on a 2D canvas rather than pulled in from a 3D
   library — a login page should not download a WebGL runtime to show an
   ornament. Everything that can be computed once is: the ring geometry is two
   basis vectors per orbit, and the segment angles never change, so their sines
   and cosines live in a table built at mount. A frame is a few hundred adds,
   ~40 sprite blits, and ~40 strokes.

   Smoothness is the point, so nothing in here steps: depth is stroked as a
   gradient of alpha bands rather than a near/far split with a visible seam,
   every light breathes on its own slow sine, and the whole scene ramps up from
   nothing on an exponential so it never pops in.
--------------------------------------------------------------------------- */

type Vec3 = { x: number; y: number; z: number };
type RGB = readonly [number, number, number];

const SILVER: RGB = [216, 216, 222];
const ASH: RGB = [244, 244, 247];
const SLATE: RGB = [158, 158, 168];
const PULSE: RGB = [255, 255, 255];

/** The orbit paths themselves stay dark grey; only the lights on them are white. */
const TRACK: RGB = [124, 124, 134];

/**
 * One orbit = one routine. Tilts stay clear of ±π/2, where a ring collapses to
 * an edge-on streak, and no two share a plane.
 */
const RINGS = [
  { radius: 1.42, tiltX: 1.24, tiltZ: 0.22, speed: 0.085, steps: 7, tone: SLATE },
  { radius: 1.3, tiltX: -0.78, tiltZ: 1.08, speed: -0.07, steps: 6, tone: SLATE },
  { radius: 1.18, tiltX: -1.05, tiltZ: -0.62, speed: 0.125, steps: 6, tone: SILVER },
  { radius: 0.98, tiltX: 0.92, tiltZ: -0.88, speed: 0.165, steps: 5, tone: ASH },
  { radius: 0.76, tiltX: -1.18, tiltZ: 0.74, speed: -0.215, steps: 4, tone: SILVER },
  { radius: 0.56, tiltX: 1.06, tiltZ: -0.3, speed: 0.28, steps: 3, tone: ASH },
] as const;

const CAMERA = 3.9; // eye distance in scene units; larger = flatter perspective
const TAU = Math.PI * 2;

/** Points per orbit path, and how many alpha steps the depth gradient uses. */
const SEGMENTS = 90;
const BANDS = 7;

function rotateX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

function rotateZ(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
}

function rotateY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

/** Screen position of the point at angle `a` on a ring spanned by u and v. */
function project(
  u: Vec3,
  v: Vec3,
  a: number,
  r: number,
  cx: number,
  cy: number,
  scale: number,
) {
  const ca = Math.cos(a) * r;
  const sa = Math.sin(a) * r;
  const k = CAMERA / (CAMERA - (u.z * ca + v.z * sa));
  return {
    x: cx + (u.x * ca + v.x * sa) * k * scale,
    y: cy + (u.y * ca + v.y * sa) * k * scale,
  };
}

/** Soft radial dot, rendered once per colour and then blitted with drawImage. */
function makeGlow(tone: RGB): HTMLCanvasElement {
  const size = 64;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const g = sprite.getContext("2d");
  if (!g) return sprite;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const [r, gr, b] = tone;
  grad.addColorStop(0, `rgba(${r},${gr},${b},1)`);
  grad.addColorStop(0.32, `rgba(${r},${gr},${b},0.45)`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return sprite;
}

type OrbitsFocus = {
  /** Centre of the system as a fraction of the host width (0–1). */
  x?: number;
  /** Centre of the system as a fraction of the host height (0–1). */
  y?: number;
  /** Multiplier on the default ring size. */
  scale?: number;
};

const DEFAULT_MASK =
  "linear-gradient(to bottom, #000 0%, #000 52%, rgba(0,0,0,0.35) 78%, transparent 96%)";

export function AuthOrbits({
  focus,
  mask = DEFAULT_MASK,
  className = "",
}: {
  focus?: OrbitsFocus;
  /** CSS mask-image over the canvas; pass `null` for none. */
  mask?: string | null;
  className?: string;
} = {}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const fx = focus?.x ?? 0.52;
  const fy = focus?.y ?? 0.34;
  const fs = focus?.scale ?? 1;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // The path angles are the same every frame on every ring, so their sines
    // and cosines are a table rather than 1,000 trig calls a frame.
    const COS = new Float32Array(SEGMENTS);
    const SIN = new Float32Array(SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * TAU;
      COS[i] = Math.cos(a);
      SIN[i] = Math.sin(a);
    }

    // Per-ring geometry that never changes: the two orthonormal vectors whose
    // span is the orbit plane. Every point on the ring is a blend of the two.
    const rings = RINGS.map((ring) => ({
      ...ring,
      u: rotateZ(rotateX({ x: 1, y: 0, z: 0 }, ring.tiltX), ring.tiltZ),
      v: rotateZ(rotateX({ x: 0, y: 1, z: 0 }, ring.tiltX), ring.tiltZ),
      phase: Math.random() * TAU,
      // The run currently travelling this routine, plus where it started.
      pulse: Math.random() * TAU,
      steplights: Array.from({ length: ring.steps }, (_, i) => ({
        offset: (i / ring.steps) * TAU,
        // Each light breathes on its own slow, prime-ish period so the set
        // never falls into a visible collective rhythm.
        rate: 0.34 + ((i * 7 + ring.steps * 3) % 11) * 0.052,
        seed: Math.random() * TAU,
      })),
    }));

    const glows = new Map<RGB, HTMLCanvasElement>();
    for (const tone of [SILVER, ASH, SLATE, PULSE]) glows.set(tone, makeGlow(tone));

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      // Cap the ratio: past 2x the extra pixels cost fill rate and buy nothing
      // on a decorative, heavily blurred scene.
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // x, y, and normalised depth per point, reused by every ring in turn.
    const path = new Float32Array(SEGMENTS * 3);

    type Marker = {
      x: number;
      y: number;
      s: number;
      tone: RGB;
      alpha: number;
      size: number;
      core: number;
    };
    const markers: Marker[] = [];

    const draw = (t: number) => {
      if (width < 2 || height < 2) return; // pane is hidden (below lg) — nothing to paint

      const cx = width * fx;
      const cy = height * fy;
      const scale = Math.min(width * 0.46, height * 0.34) * fs;
      const spin = t * 0.055; // the whole system turns slowly, so tilts read as 3D
      // Ramp in rather than appear: at t=0 the panel is empty and it settles
      // over roughly two seconds, so there is no frame where the art pops on.
      const intro = still ? 1 : 1 - Math.exp(-t * 0.9);

      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      markers.length = 0;

      for (const ring of rings) {
        const u = rotateY(ring.u, spin);
        const v = rotateY(ring.v, spin);
        const phase = ring.phase + t * ring.speed;
        const r = ring.radius;

        // Project the orbit path once; the strokes below only read it back.
        for (let i = 0; i < SEGMENTS; i++) {
          const ca = COS[i] * r;
          const sa = SIN[i] * r;
          const z = u.z * ca + v.z * sa;
          const k = CAMERA / (CAMERA - z);
          path[i * 3] = cx + (u.x * ca + v.x * sa) * k * scale;
          path[i * 3 + 1] = cy + (u.y * ca + v.y * sa) * k * scale;
          // 0 at the far edge, 1 at the near edge.
          path[i * 3 + 2] = Math.min(1, Math.max(0, 0.5 + (0.5 * z) / r));
        }

        // Depth as a gradient instead of a near/far split. Each band collects
        // the segments at its depth into one path, so the ring fades smoothly
        // from back to front for the price of seven strokes.
        for (let b = 0; b < BANDS; b++) {
          const lo = b / BANDS;
          const hi = (b + 1) / BANDS;
          const mid = (b + 0.5) / BANDS;
          ctx.lineWidth = 0.85 + 0.95 * mid;
          ctx.strokeStyle = `rgba(${TRACK[0]},${TRACK[1]},${TRACK[2]},${
            (0.16 + 0.56 * mid * mid) * intro
          })`;
          ctx.beginPath();
          let open = false;
          for (let i = 0; i < SEGMENTS; i++) {
            const j = (i + 1) % SEGMENTS;
            const d = Math.max(path[i * 3 + 2], path[j * 3 + 2]);
            if (d < lo || d >= hi) {
              open = false;
              continue;
            }
            if (!open) {
              ctx.moveTo(path[i * 3], path[i * 3 + 1]);
              open = true;
            }
            ctx.lineTo(path[j * 3], path[j * 3 + 1]);
          }
          ctx.stroke();
        }

        // A run travels the routine faster than the routine itself turns.
        const pulseAngle = ring.pulse + t * ring.speed * 3.1;

        for (const light of ring.steplights) {
          const a = phase + light.offset;
          const ca = Math.cos(a) * r;
          const sa = Math.sin(a) * r;
          const z = u.z * ca + v.z * sa;
          const k = CAMERA / (CAMERA - z);
          // Flash a step as the run passes over it — that is the whole story:
          // work arriving at a node, firing, moving on.
          const d = Math.abs((((pulseAngle - a) % TAU) + TAU + Math.PI) % TAU - Math.PI);
          const hit = Math.exp(-(d * d) * 14);
          // Continuous shimmer underneath, so a light is always easing rather
          // than sitting flat and waiting its turn to blink.
          const tw = 0.66 + 0.34 * Math.sin(t * light.rate + light.seed);
          const depth = 0.34 + 0.66 * Math.min(1, Math.max(0, 0.5 + (0.5 * z) / r));
          markers.push({
            x: cx + (u.x * ca + v.x * sa) * k * scale,
            y: cy + (u.y * ca + v.y * sa) * k * scale,
            s: z,
            tone: ring.tone,
            alpha: Math.min(0.42, (0.11 + 0.1 * tw + 0.15 * hit) * depth) * intro,
            size: (7 + 7 * hit) * k,
            core: (1.05 + 0.55 * hit) * k,
          });
        }

        const pc = Math.cos(pulseAngle) * r;
        const ps = Math.sin(pulseAngle) * r;
        const pz = u.z * pc + v.z * ps;
        const pk = CAMERA / (CAMERA - pz);
        // The run itself, with a short tail along the path it just covered.
        // The tail fades on a curve rather than a straight ramp so its end
        // dissolves instead of stopping.
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        const TAIL = 14;
        for (let i = 0; i < TAIL; i++) {
          const f = 1 - i / TAIL;
          const p0 = project(u, v, pulseAngle - i * 0.048, r, cx, cy, scale);
          const p1 = project(u, v, pulseAngle - (i + 1) * 0.048, r, cx, cy, scale);
          ctx.strokeStyle = `rgba(${PULSE[0]},${PULSE[1]},${PULSE[2]},${0.17 * f * f * intro})`;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }

        markers.push({
          x: cx + (u.x * pc + v.x * ps) * pk * scale,
          y: cy + (u.y * pc + v.y * ps) * pk * scale,
          s: pz,
          tone: PULSE,
          alpha: 0.46 * intro,
          size: 13 * pk,
          core: 1.7 * pk,
        });
      }

      // Painter's algorithm: far markers first so near ones sit on top.
      markers.sort((a, b) => a.s - b.s);

      for (const m of markers) {
        const sprite = glows.get(m.tone);
        if (!sprite) continue;
        ctx.globalAlpha = m.alpha * 0.6;
        ctx.drawImage(sprite, m.x - m.size / 2, m.y - m.size / 2, m.size, m.size);
        ctx.globalAlpha = m.alpha;
        ctx.fillStyle = `rgb(${m.tone[0]},${m.tone[1]},${m.tone[2]})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.core, 0, TAU);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    // Assigning canvas.width wipes the bitmap, so a resize has to be followed
    // by a repaint. The animation loop covers itself; the reduced-motion path
    // draws exactly once and would otherwise be cleared to nothing.
    const ro = new ResizeObserver(() => {
      resize();
      if (still) draw(2.4);
    });
    ro.observe(host);
    resize();

    if (still) {
      draw(2.4); // a settled frame, since the intro ramp never runs
      return () => ro.disconnect();
    }

    let raf = 0;
    let clock = 0;
    let last = 0;

    const frame = (now: number) => {
      // Own clock rather than the timestamp: a backgrounded tab resumes where
      // it left off instead of jumping forward by the time it was away, and a
      // dropped frame stretches by at most one step instead of lurching.
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      clock += dt;
      draw(clock);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
    };
  }, [fx, fy, fs]);

  return (
    <div
      ref={hostRef}
      className={`pointer-events-none absolute inset-0 ${className}`}
      aria-hidden="true"
      /* The orbits run wider than the copy below them, so by default the
         lower third is masked out rather than shrunk — the art keeps its size
         and the blockquote keeps its contrast. Callers can swap the mask. */
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
