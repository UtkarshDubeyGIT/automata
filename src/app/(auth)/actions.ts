"use server";

import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/lib/supabase/server";

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function authError(path: "/login" | "/signup", message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}` as Route);
}

export async function signIn(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) redirect("/app");

  const email = value(formData, "email");
  const password = value(formData, "password");
  if (!email || !password) authError("/login", "Enter your email and password.");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) authError("/login", error.message);
  redirect("/app");
}

export async function signUp(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) redirect("/app");

  const fullName = value(formData, "fullName");
  const email = value(formData, "email");
  const password = value(formData, "password");
  if (!fullName || !email || password.length < 8) {
    authError("/signup", "Use your name, a valid email, and at least 8 password characters.");
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName }, emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) authError("/signup", error.message);
  if (!data.session) redirect("/login?message=Check%20your%20email%20to%20confirm%20your%20account." as Route);
  redirect("/app");
}

export async function signInWithGoogle() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) redirect("/app");

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.url) authError("/login", error?.message ?? "Google sign-in could not start.");
  redirect(data.url as Route);
}

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  if (supabase) await supabase.auth.signOut();
  redirect("/");
}
