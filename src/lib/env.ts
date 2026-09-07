/**
 * Central env access for Automata. Nothing throws at import time — the app must
 * boot without keys so unconfigured providers degrade to safe stubs. Use the
 * `*Configured` booleans to branch between live and simulated behavior.
 */

function pub(name: string): string {
  return process.env[name] ?? "";
}

export const env = {
  // ---- Supabase (auth + db + storage) ----
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey:
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    "",
  supabaseServiceKey: pub("SUPABASE_SECRET_KEY") || pub("SUPABASE_SERVICE_ROLE_KEY"),

  // ---- OpenAI (text generation) ----
  openaiKey: pub("OPENAI_API_KEY"),
  openaiModel: pub("OPENAI_MODEL") || pub("OPENAI_TEXT_MODEL") || "gpt-5.6-terra",
  openaiTrendsModel: pub("OPENAI_TRENDS_MODEL") || pub("OPENAI_MODEL") || "gpt-5.5",

  // ---- Stripe (billing) ----
  stripeSecret: pub("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: pub("STRIPE_WEBHOOK_SECRET"),
  stripePublishable: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",

  // ---- Higgsfield (video generation) ----
  higgsfieldKey: pub("HIGGSFIELD_API_KEY"),
  higgsfieldSecret: pub("HIGGSFIELD_SECRET"),
  higgsfieldBaseUrl: pub("HIGGSFIELD_BASE_URL") || "https://platform.higgsfield.ai",

  // ---- Composio (social connect + posting) ----
  composioKey: pub("COMPOSIO_API_KEY"),

  // ---- Twilio (WhatsApp workflow reminders + phone verification) ----
  twilioAccountSid: pub("TWILIO_ACCOUNT_SID"),
  twilioApiKey: pub("TWILIO_API_KEY"),
  twilioApiSecret: pub("TWILIO_API_SECRET"),
  twilioAuthToken: pub("TWILIO_AUTH_TOKEN"),
  twilioWhatsAppFrom: pub("TWILIO_WHATSAPP_FROM"),
  twilioVerifyServiceSid: pub("TWILIO_VERIFY_SERVICE_SID"),
  twilioContentGenericAlert: pub("TWILIO_CONTENT_SID_GENERIC_ALERT"),
  twilioContentScheduledDigest: pub("TWILIO_CONTENT_SID_SCHEDULED_DIGEST"),
  twilioContentReminder: pub("TWILIO_CONTENT_SID_REMINDER"),
  twilioWhatsAppSandbox: pub("TWILIO_WHATSAPP_SANDBOX") === "true",

  linkedinApiVersion: pub("LINKEDIN_API_VERSION") || "202608",

  // ---- Firecrawl (website analysis + all web research) ----
  firecrawlKey: pub("FIRECRAWL_API_KEY"),

  // ---- Linkup (web search — logo lookup fallback) ----
  linkupKey: pub("LINKUP_API_KEY"),

  // ---- Resend (transactional email) ----
  resendKey: pub("RESEND_API_KEY"),
  resendFrom: pub("RESEND_FROM") || pub("EMAIL_FROM") || "Automata <noreply@example.com>",

  // ---- Google Ads (reporting) ----
  googleAdsDeveloperToken: pub("GOOGLE_ADS_DEVELOPER_TOKEN"),

  // ---- Google Business Profile (our own OAuth client) ----
  googleClientId: pub("GOOGLE_CLIENT_ID"),
  googleClientSecret: pub("GOOGLE_CLIENT_SECRET"),

  // ---- Shopify (our own App Store install flow) ----
  shopifyClientId: pub("COMPOSIO_OAUTH_SHOPIFY_CLIENT_ID"),
  shopifyClientSecret: pub("COMPOSIO_OAUTH_SHOPIFY_CLIENT_SECRET"),
  shopifyScopes:
    pub("COMPOSIO_OAUTH_SHOPIFY_SCOPES") ||
    "read_products,read_orders,read_customers,read_inventory,read_fulfillments,read_locations",

  // ---- Credential encryption ----
  credentialKey: pub("CREDENTIAL_ENCRYPTION_KEY"),

  // ---- App ----
  appUrl: process.env.NEXT_PUBLIC_APP_URL || pub("APP_HOST") || "http://localhost:3000",

  // ---- Unattended worker ----
  cronSecret: pub("CRON_SECRET"),

  // ---- Composio real-time triggers ----
  composioWebhookSecret: pub("COMPOSIO_WEBHOOK_SECRET"),

  // ---- Automata internal keys & brand ----
  automataSecretKey: pub("AUTOMATA_SECRET_KEY"),
  automataWebhookKey: pub("AUTOMATA_WEBHOOK_KEY"),
  appName: pub("NEXT_PUBLIC_APP_NAME") || pub("NEXT_PUBLIC_BRAND_NAME") || "Automata",
  supportEmail: pub("NEXT_PUBLIC_SUPPORT_EMAIL") || "support@automata.internal",
};

export const supabaseConfigured = !!(
  env.supabaseUrl &&
  (env.supabaseAnonKey || env.supabaseServiceKey)
);
export const openaiConfigured = !!env.openaiKey;
export const stripeConfigured = !!env.stripeSecret;
export const higgsfieldConfigured = !!env.higgsfieldKey;
export const composioConfigured = !!env.composioKey;
export const twilioConfigured = !!(
  env.twilioAccountSid &&
  env.twilioWhatsAppFrom &&
  ((env.twilioApiKey && env.twilioApiSecret) || env.twilioAuthToken)
);
export const twilioVerifyConfigured = !!(
  env.twilioAccountSid &&
  env.twilioVerifyServiceSid &&
  ((env.twilioApiKey && env.twilioApiSecret) || env.twilioAuthToken)
);
export const composioRealtimeConfigured = !!(env.composioKey && env.composioWebhookSecret);
export const firecrawlConfigured = !!env.firecrawlKey;
export const linkupConfigured = !!env.linkupKey;
export const resendConfigured = !!env.resendKey;
export const googleAdsConfigured = !!env.googleAdsDeveloperToken;
export const googleBusinessConfigured = !!(env.googleClientId && env.googleClientSecret);
export const shopifyConfigured = !!(env.shopifyClientId && env.shopifyClientSecret);
export const automataConfigured = !!(env.automataSecretKey || env.automataWebhookKey);
