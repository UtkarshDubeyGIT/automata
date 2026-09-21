/**
 * A slice of the Composio toolkit catalog for the public tool wall.
 *
 * Generated from the CLI's cached catalog (~/.composio/toolkits.json) on
 * 2026-09-09; the full catalog held 1431 toolkits that day. The counts are
 * kept for future use — the wall itself shows logos only. Logos resolve
 * through `toolkitLogo(slug)`, the same helper the product uses.
 */

export const COMPOSIO_CATALOG_SIZE = 1431;

export interface WallToolkit {
  slug: string;
  name: string;
  /** Actions the toolkit exposes. */
  tools: number;
  /** Event triggers the toolkit exposes. */
  triggers: number;
}

export const WALL_TOOLKITS: WallToolkit[] = [
  { slug: "gmail", name: "Gmail", tools: 61, triggers: 2 },
  { slug: "slack", name: "Slack", tools: 158, triggers: 9 },
  { slug: "hubspot", name: "HubSpot", tools: 244, triggers: 2 },
  { slug: "stripe", name: "Stripe", tools: 425, triggers: 7 },
  { slug: "notion", name: "Notion", tools: 53, triggers: 8 },
  { slug: "shopify", name: "Shopify", tools: 315, triggers: 0 },
  { slug: "salesforce", name: "Salesforce", tools: 184, triggers: 7 },
  { slug: "airtable", name: "Airtable", tools: 24, triggers: 6 },
  { slug: "github", name: "GitHub", tools: 871, triggers: 46 },
  { slug: "googlesheets", name: "Google Sheets", tools: 45, triggers: 16 },
  { slug: "googlecalendar", name: "Google Calendar", tools: 45, triggers: 7 },
  { slug: "googledrive", name: "Google Drive", tools: 77, triggers: 7 },
  { slug: "discord", name: "Discord", tools: 23, triggers: 1 },
  { slug: "zendesk", name: "Zendesk", tools: 451, triggers: 2 },
  { slug: "linear", name: "Linear", tools: 46, triggers: 12 },
  { slug: "jira", name: "Jira", tools: 97, triggers: 3 },
  { slug: "trello", name: "Trello", tools: 322, triggers: 5 },
  { slug: "asana", name: "Asana", tools: 153, triggers: 6 },
  { slug: "intercom", name: "Intercom", tools: 133, triggers: 0 },
  { slug: "mailchimp", name: "Mailchimp", tools: 272, triggers: 4 },
  { slug: "whatsapp", name: "WhatsApp", tools: 57, triggers: 1 },
  { slug: "telegram", name: "Telegram", tools: 18, triggers: 0 },
  { slug: "linkedin", name: "LinkedIn", tools: 24, triggers: 0 },
  { slug: "twitter", name: "Twitter", tools: 79, triggers: 0 },
  { slug: "youtube", name: "YouTube", tools: 48, triggers: 4 },
  { slug: "calendly", name: "Calendly", tools: 52, triggers: 0 },
  { slug: "zoom", name: "Zoom", tools: 90, triggers: 11 },
  { slug: "dropbox", name: "Dropbox", tools: 174, triggers: 0 },
  { slug: "one_drive", name: "OneDrive", tools: 81, triggers: 9 },
  { slug: "outlook", name: "Outlook", tools: 286, triggers: 5 },
  { slug: "microsoft_teams", name: "Microsoft Teams", tools: 157, triggers: 0 },
  { slug: "clickup", name: "ClickUp", tools: 162, triggers: 21 },
  { slug: "monday", name: "Monday", tools: 121, triggers: 0 },
  { slug: "typeform", name: "Typeform", tools: 35, triggers: 1 },
  { slug: "webflow", name: "Webflow", tools: 59, triggers: 0 },
  { slug: "wordpress_com", name: "WordPress.com", tools: 10, triggers: 0 },
  { slug: "figma", name: "Figma", tools: 52, triggers: 0 },
  { slug: "canva", name: "Canva", tools: 46, triggers: 0 },
  { slug: "pipedrive", name: "Pipedrive", tools: 399, triggers: 3 },
  { slug: "zoho", name: "Zoho", tools: 57, triggers: 0 },
  { slug: "freshdesk", name: "Freshdesk", tools: 178, triggers: 0 },
  { slug: "quickbooks", name: "QuickBooks", tools: 114, triggers: 0 },
  { slug: "xero", name: "Xero", tools: 53, triggers: 0 },
  { slug: "paypal", name: "Paypal", tools: 78, triggers: 0 },
  { slug: "razorpay", name: "Razorpay", tools: 42, triggers: 0 },
  { slug: "klaviyo", name: "Klaviyo", tools: 225, triggers: 0 },
  { slug: "sendgrid", name: "SendGrid", tools: 359, triggers: 0 },
  { slug: "brevo", name: "Brevo", tools: 21, triggers: 0 },
  { slug: "posthog", name: "PostHog", tools: 503, triggers: 0 },
  { slug: "mixpanel", name: "Mixpanel", tools: 43, triggers: 0 },
  { slug: "segment", name: "Segment", tools: 17, triggers: 0 },
  { slug: "supabase", name: "Supabase", tools: 124, triggers: 0 },
  { slug: "firebase", name: "Firebase", tools: 8, triggers: 0 },
  { slug: "vercel", name: "Vercel", tools: 131, triggers: 0 },
  { slug: "openai", name: "OpenAI", tools: 126, triggers: 0 },
  { slug: "perplexityai", name: "Perplexity AI", tools: 9, triggers: 0 },
  { slug: "exa", name: "Exa", tools: 17, triggers: 0 },
  { slug: "firecrawl", name: "Firecrawl", tools: 29, triggers: 0 },
  { slug: "apollo", name: "Apollo", tools: 48, triggers: 0 },
  { slug: "instagram", name: "Instagram", tools: 28, triggers: 0 },
  { slug: "facebook", name: "Facebook", tools: 39, triggers: 0 },
  { slug: "tiktok", name: "Tiktok", tools: 9, triggers: 0 },
  { slug: "reddit", name: "Reddit", tools: 21, triggers: 0 },
  { slug: "googleads", name: "Google Ads", tools: 22, triggers: 0 },
  { slug: "metaads", name: "Meta Ads", tools: 51, triggers: 0 },
  { slug: "google_analytics", name: "Google Analytics", tools: 67, triggers: 0 },
  { slug: "google_maps", name: "Google Maps", tools: 20, triggers: 0 },
  { slug: "docusign", name: "DocuSign", tools: 335, triggers: 0 },
  { slug: "pagerduty", name: "PagerDuty", tools: 356, triggers: 0 },
  { slug: "datadog", name: "Datadog", tools: 64, triggers: 0 },
  { slug: "sentry", name: "Sentry", tools: 209, triggers: 0 },
  { slug: "gitlab", name: "GitLab", tools: 116, triggers: 0 },
  { slug: "bitbucket", name: "Bitbucket", tools: 108, triggers: 0 },
  { slug: "confluence", name: "Confluence", tools: 69, triggers: 23 },
  { slug: "coda", name: "Coda", tools: 109, triggers: 4 },
  { slug: "miro", name: "Miro", tools: 77, triggers: 0 },
  { slug: "elevenlabs", name: "ElevenLabs", tools: 155, triggers: 0 },
  { slug: "heygen", name: "HeyGen", tools: 71, triggers: 0 },
  { slug: "coinbase", name: "Coinbase", tools: 28, triggers: 0 },
  { slug: "square", name: "Square", tools: 122, triggers: 0 },
  { slug: "gumroad", name: "Gumroad", tools: 7, triggers: 0 },
  { slug: "lemon_squeezy", name: "Lemon Squeezy", tools: 32, triggers: 0 },
];

/**
 * The landing wall is texture, not an integration directory. Keep the first
 * paint curated and bounded; the full catalog remains available elsewhere in
 * the app instead of turning a decorative strip into a hundred-image request
 * burst.
 */
export const WALL_VISIBLE_TOOLKITS = WALL_TOOLKITS.slice(0, 32);
