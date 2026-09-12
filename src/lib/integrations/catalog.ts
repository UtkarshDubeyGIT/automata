export type IntegrationCategory = "Google" | "Communication" | "Data" | "Sales" | "Commerce" | "Developer";

export interface IntegrationDefinition {
  slug: string;
  name: string;
  shortName: string;
  description: string;
  category: IntegrationCategory;
  color: string;
  verified: boolean;
  triggerCount: number;
  actionCount: number;
}

export const INTEGRATIONS: IntegrationDefinition[] = [
  { slug: "vikunja", name: "Vikunja", shortName: "VK", description: "Create and track tasks from your automations.", category: "Data", color: "#196AFF", verified: true, triggerCount: 0, actionCount: 4 },
  { slug: "gmail", name: "Gmail", shortName: "GM", description: "Route, summarize, draft, and send email.", category: "Google", color: "#EA4335", verified: true, triggerCount: 3, actionCount: 8 },
  { slug: "googlesheets", name: "Google Sheets", shortName: "GS", description: "Watch rows and keep operational data in sync.", category: "Google", color: "#0F9D58", verified: true, triggerCount: 4, actionCount: 18 },
  { slug: "googledrive", name: "Google Drive", shortName: "GD", description: "Move, organize, and share files automatically.", category: "Google", color: "#4285F4", verified: true, triggerCount: 3, actionCount: 15 },
  { slug: "googlecalendar", name: "Google Calendar", shortName: "GC", description: "React to events and coordinate schedules.", category: "Google", color: "#4C8BF5", verified: true, triggerCount: 4, actionCount: 14 },
  { slug: "slack", name: "Slack", shortName: "SL", description: "Send alerts, digests, and team decisions.", category: "Communication", color: "#4A154B", verified: true, triggerCount: 4, actionCount: 21 },
  { slug: "notion", name: "Notion", shortName: "NO", description: "Create pages and synchronize knowledge.", category: "Data", color: "#151515", verified: true, triggerCount: 2, actionCount: 14 },
  { slug: "airtable", name: "Airtable", shortName: "AT", description: "Automate records across lightweight databases.", category: "Data", color: "#F82B60", verified: true, triggerCount: 4, actionCount: 16 },
  { slug: "telegram", name: "Telegram", shortName: "TG", description: "Receive messages and run bot actions.", category: "Communication", color: "#229ED9", verified: true, triggerCount: 3, actionCount: 11 },
  { slug: "whatsapp", name: "WhatsApp Business", shortName: "WA", description: "Send approved customer and operations messages.", category: "Communication", color: "#25D366", verified: true, triggerCount: 2, actionCount: 9 },
  { slug: "hubspot", name: "HubSpot", shortName: "HS", description: "Coordinate contacts, deals, and follow-up.", category: "Sales", color: "#FF7A59", verified: true, triggerCount: 6, actionCount: 24 },
  { slug: "shopify", name: "Shopify", shortName: "SH", description: "Respond to orders, products, and customers.", category: "Commerce", color: "#7AB55C", verified: true, triggerCount: 3, actionCount: 22 },
  { slug: "github", name: "GitHub", shortName: "GH", description: "Triage issues and automate repository work.", category: "Developer", color: "#24292F", verified: true, triggerCount: 5, actionCount: 18 },
  { slug: "linkedin", name: "LinkedIn", shortName: "LI", description: "Publish approved professional content.", category: "Sales", color: "#0A66C2", verified: true, triggerCount: 1, actionCount: 7 },
];

export const INTEGRATION_BY_SLUG = new Map(INTEGRATIONS.map((integration) => [integration.slug, integration]));
