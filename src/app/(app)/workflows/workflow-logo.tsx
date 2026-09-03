"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { toolkitLogo } from "@/lib/social/platforms";

/**
 * Lead-integration logo for an automation (Composio toolkit logo), with a
 * sparkles fallback and an optional "running" status dot.
 */
export function WorkflowLogo({
  logo,
  active,
}: {
  logo: string | null | undefined;
  active?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative inline-flex h-10 w-10 flex-none">
      {logo && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={toolkitLogo(logo)}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-10 w-10 rounded-[12px] border border-line bg-card object-contain p-1"
        />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-brand-subtle text-brand">
          <Icon name="sparkles" size={18} />
        </span>
      )}
      {active && (
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card bg-success" />
      )}
    </span>
  );
}
