"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { tileColors } from "@/lib/data/workflows";
import { toolkitLogo } from "@/lib/social/platforms";
import {
  CATEGORY_LABELS,
  palette,
  toolBlock,
  type BlockCategory,
  type PaletteBlock,
} from "@/lib/workflows/blocks";
import type { ToolSpec } from "@/lib/workflows/registry";

/**
 * The "add a step" picker — the visual builder's library of blocks, generated
 * from the same catalog the AI compiler is constrained to. Anything listed
 * here can be inserted by hand; anything the AI emits appears here too, so the
 * two builders can never drift apart.
 */

const ALL_BLOCKS = palette();

const ORDER: BlockCategory[] = ["trigger", "ai", "logic", "human", "app", "social", "notification", "output"];

/** Mounted only while picking — closing unmounts it, which resets the search. */
export function StepPicker({
  mode,
  onPick,
  onClose,
}: {
  /** "trigger" swaps the workflow's start node; "step" inserts into the flow. */
  mode: "trigger" | "step";
  onPick: (block: PaletteBlock) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<BlockCategory | "all">("all");
  const [dynamicBlocks, setDynamicBlocks] = useState<PaletteBlock[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q && category !== "app") return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (q) params.set("search", q);

    fetch(`/api/integrations/catalog/tools?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tools?: Array<{ slug: string; spec: ToolSpec }> } | null) => {
        if (cancelled) return;
        const blocks = data?.tools ? data.tools.map((t) => toolBlock(t.slug, t.spec)) : [];
        setDynamicBlocks(blocks);
      })
      .catch(() => {
        if (!cancelled) setDynamicBlocks([]);
      });

    return () => {
      cancelled = true;
    };
  }, [query, category]);

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pool = useMemo(() => {
    const base = ALL_BLOCKS.filter((b) => (mode === "trigger" ? b.category === "trigger" : b.category !== "trigger"));
    const active = query.trim() || category === "app" ? dynamicBlocks : [];
    if (!active.length || mode === "trigger") return base;
    const existingIds = new Set(base.map((b) => b.id));
    const extra = active.filter((b) => !existingIds.has(b.id));
    return [...base, ...extra];
  }, [mode, query, category, dynamicBlocks]);

  const categories = useMemo(() => {
    const present = new Set(pool.map((b) => b.category));
    return ORDER.filter((c) => present.has(c));
  }, [pool]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pool.filter((b) => {
      if (category !== "all" && b.category !== category) return false;
      if (!q) return true;
      return `${b.label} ${b.desc} ${b.keywords ?? ""}`.toLowerCase().includes(q);
    });
  }, [pool, category, query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[color:rgba(15,17,26,0.45)] p-4 pt-[8vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "trigger" ? "Choose a trigger" : "Add a step"}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[76vh] w-full max-w-[720px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-lg"
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">
              {mode === "trigger" ? "What starts this automation?" : "Add a step"}
            </div>
            <div className="text-[12.5px] text-ink-subtle">
              {mode === "trigger"
                ? "Every workflow has exactly one trigger."
                : "Pick a block — you can configure it after adding."}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-ink-muted transition-colors hover:bg-inset hover:text-ink"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="border-b border-line px-5 py-3">
          <Input
            ref={searchRef}
            leftIcon="search"
            placeholder="Search blocks — Slack, approve, classify, schedule…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-1.5">
            <CategoryChip active={category === "all"} onClick={() => setCategory("all")}>
              All
            </CategoryChip>
            {categories.map((c) => (
              <CategoryChip key={c} active={category === c} onClick={() => setCategory(c)}>
                {CATEGORY_LABELS[c]}
              </CategoryChip>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {results.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13.5px] text-ink-subtle">
              Nothing matches “{query}”.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {results.map((b) => (
                <BlockCard key={b.id} block={b} onPick={() => onPick(b)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors",
        active ? "bg-brand text-white" : "bg-inset text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function BlockCard({ block, onPick }: { block: PaletteBlock; onPick: () => void }) {
  const tc = tileColors(block.tile);
  const [brokenLogo, setBrokenLogo] = useState(false);
  return (
    <button
      onClick={onPick}
      className="flex items-start gap-3 rounded-card border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-inset"
    >
      {block.app && !brokenLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={toolkitLogo(block.app)}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          onError={() => setBrokenLogo(true)}
          className="h-8 w-8 flex-none rounded-[8px] border border-line bg-card object-contain p-1"
        />
      ) : (
        <span
          className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px]"
          style={{ background: tc.bg, color: tc.fg }}
        >
          <Icon name={block.icon} size={16} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold leading-tight text-ink">{block.label}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-subtle">{block.desc}</span>
      </span>
    </button>
  );
}
