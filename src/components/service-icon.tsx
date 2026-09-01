import type { CSSProperties } from "react";
import {
  siAirtable,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siGooglesheets,
  siHubspot,
  siLinkedin,
  siNotion,
  siOpenai,
  siShopify,
  siSlack,
  siTelegram,
  siWhatsapp,
  type SimpleIcon,
} from "simple-icons";

const SERVICE_ICONS: Record<string, SimpleIcon> = {
  airtable: siAirtable,
  github: siGithub,
  gmail: siGmail,
  googlecalendar: siGooglecalendar,
  googledrive: siGoogledrive,
  googlesheets: siGooglesheets,
  hubspot: siHubspot,
  linkedin: siLinkedin,
  notion: siNotion,
  openai: siOpenai,
  shopify: siShopify,
  slack: siSlack,
  telegram: siTelegram,
  whatsapp: siWhatsapp,
};

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
  const icon = SERVICE_ICONS[slug];
  if (!icon) return <span className={`service-icon service-icon-fallback ${className}`} aria-label={label ?? slug}>{slug.slice(0, 2).toUpperCase()}</span>;

  return (
    <span
      className={`service-icon service-icon-${variant} ${className}`}
      style={{ "--service-color": `#${icon.hex}` } as CSSProperties}
      title={label ?? icon.title}
      aria-label={label ?? icon.title}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={icon.path} />
      </svg>
    </span>
  );
}
