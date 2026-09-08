import { COMPOSIO_CATALOG_SIZE, WALL_TOOLKITS } from "@/lib/integrations/composio-wall";

import { ToolLogo } from "@/components/tool-logo";

import styles from "./space-landing.module.css";

/**
 * A narrow band of app logos drifting right-to-left. Two rows move at
 * different speeds in opposite directions so the band reads as a field rather
 * than a ticker, and the drift never stops — not on hover, not on focus.
 * Deliberately quiet: no names, no badges, no hover state. The logos keep
 * their real colours — the band reads as "your tools are already here", and
 * small, widely spaced marks behind a soft edge mask keep it from shouting.
 */
export function ToolWall() {
  const half = Math.ceil(WALL_TOOLKITS.length / 2);
  const rows = [WALL_TOOLKITS.slice(0, half), WALL_TOOLKITS.slice(half)];

  return (
    <section className="relative" aria-label="Connected app catalog">
      <p className="mx-auto w-full max-w-6xl px-6 text-[13px] text-[var(--ink-subtle)]">
        Works with the tools you already use.{" "}
        <span className="text-[var(--ink-muted)]">
          Connect to over {(Math.floor(COMPOSIO_CATALOG_SIZE / 100) * 100).toLocaleString("en-US")} apps, plus your own custom ones.
        </span>
      </p>

      <div className={styles.wall}>
        {rows.map((row, index) => (
          <div key={index} className={`${styles.wallRow} ${index === 1 ? styles.wallRowSlow : ""}`}>
            {/* Rendered twice so the loop point is invisible. */}
            {[0, 1].map((copy) => (
              <ul key={copy} className={styles.wallTrack} aria-hidden={copy === 1 ? true : undefined}>
                {row.map((toolkit) => (
                  <li key={toolkit.slug} className={styles.wallTile} title={toolkit.name}>
                    <ToolLogo slug={toolkit.slug} label={toolkit.name} size={26} />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
