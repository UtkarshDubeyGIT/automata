"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

type Variant = { key: string; name: string };

export function PrototypeSwitcher({ variants, current }: { variants: Variant[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const index = Math.max(0, variants.findIndex((variant) => variant.key === current));

  function move(direction: -1 | 1) {
    const next = variants[(index + direction + variants.length) % variants.length];
    router.replace(`${pathname}?variant=${next.key}` as Route);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="prototype-switcher" role="group" aria-label="Theme prototype variants">
      <button onClick={() => move(-1)} aria-label="Previous variant"><ArrowLeft size={16} /></button>
      <span><small>Theme preview</small><b>{variants[index].key} — {variants[index].name}</b></span>
      <button onClick={() => move(1)} aria-label="Next variant"><ArrowRight size={16} /></button>
    </div>
  );
}
