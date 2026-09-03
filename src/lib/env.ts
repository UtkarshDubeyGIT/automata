/**
 * Central env access for Automata.
 */

function pub(name: string): string {
  return process.env[name] ?? "";
}

export const env = {
  // ---- Supabase (auth + db + storage) ----
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  supabaseServiceKey: pub("SUPABASE_SECRET_KEY") || pub("SUPABASE_SERVICE_ROLE_KEY"),

  // ---- OpenAI (text generation) ----
  openaiKey: pub("OPENAI_API_KEY"),
  openaiModel: pub("OPENAI_MODEL") || "gpt-4o-mini",
  openaiTrendsModel: pub("OPENAI_TRENDS_MODEL") || pub("OPENAI_MODEL") || "gpt-4o-mini",

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
  linkedinApiVersion: pub("LINKEDIN_API_VERSION") || "202608",

  // ---- Resend (transactional email) ----
  resendKey: pub("RESEND_API_KEY"),
  resendFrom: pub("RESEND_FROM") || "Automata <noreply@automata.local>",

  // ---- App ----
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",

  // ---- Unattended worker ----
  cronSecret: pub("CRON_SECRET"),

  // ---- Composio real-time triggers ----
  composioWebhookSecret: pub("COMPOSIO_WEBHOOK_SECRET"),
};

export const supabaseConfigured = !!(env.supabaseUrl && (env.supabaseAnonKey || env.supabaseServiceKey));
export const openaiConfigured = !!env.openaiKey;
export const stripeConfigured = !!env.stripeSecret;
export const higgsfieldConfigured = !!env.higgsfieldKey;
export const composioConfigured = !!env.composioKey;
export const composioRealtimeConfigured = !!(env.composioKey && env.composioWebhookSecret);
export const resendConfigured = !!env.resendKey;
