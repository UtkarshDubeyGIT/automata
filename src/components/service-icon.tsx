import { ToolLogo } from "@/components/tool-logo";

/**
 * An app mark on the public site and template cards.
 *
 * Was a hand-curated set of monochrome glyphs tinted with each brand's colour,
 * which covered fourteen apps and looked nothing like the same app inside the
 * product. It now renders the same full-colour logo the product does, so a
 * catalog of hundreds resolves instead of falling back to two grey letters.
 *
 * The wrapper keeps its original class contract (`service-icon`,
 * `service-icon-<variant>`) because marketing.css sizes and positions marks
 * through those selectors in a dozen places.
 */
export function ServiceIcon({
  slug,
  label,
  className = "",
  variant = "badge",
}: {
  slug: string;
  label?: string;
  className?: string;
  variant?: "badge" | "mark";
}) {
  return (
    <span
      className={`service-icon service-icon-${variant} ${className}`}
      title={label}
      aria-label={label ?? slug}
    >
      <ToolLogo slug={slug} label={label} className="service-icon-art" />
    </span>
  );
}
