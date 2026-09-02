import type { CSSProperties } from "react";
import { Github, Notion, OpenAI } from "@lobehub/icons";
import {
  siAirtable,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siGooglesheets,
  siHubspot,
  siLinkedin,
  siShopify,
  siSlack,
  siTelegram,
  siWhatsapp,
  type SimpleIcon,
} from "simple-icons";

const SERVICE_ICONS: Record<string, SimpleIcon> = {
  airtable: siAirtable,
  gmail: siGmail,
  googlecalendar: siGooglecalendar,
  googledrive: siGoogledrive,
  googlesheets: siGooglesheets,
  hubspot: siHubspot,
  linkedin: siLinkedin,
  shopify: siShopify,
  slack: siSlack,
  telegram: siTelegram,
  whatsapp: siWhatsapp,
};

const LOBE_SERVICE_ICONS = {
  github: Github,
  notion: Notion,
  openai: OpenAI,
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
  const LobeIcon = LOBE_SERVICE_ICONS[slug as keyof typeof LOBE_SERVICE_ICONS];
  if (LobeIcon) {
    return (
      <span
        className={`service-icon service-icon-${variant} service-icon-lobe ${className}`}
        style={{ "--service-color": LobeIcon.colorPrimary } as CSSProperties}
        title={label ?? LobeIcon.title}
        aria-label={label ?? LobeIcon.title}
      >
        <LobeIcon size="57%" aria-hidden="true" />
      </span>
    );
  }

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
