"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabasePublicConfig } from "./config";

export function createBrowserSupabaseClient() {
  const config = getSupabasePublicConfig();
  if (!config) throw new Error("Supabase is not configured.");
  return createBrowserClient(config.url, config.publishableKey);
}
