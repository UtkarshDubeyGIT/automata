import Link from "next/link";

import { isSupabaseConfigured } from "@/lib/supabase/config";

import { signIn } from "../actions";

type LoginPageProps = { searchParams: Promise<{ error?: string; message?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const notice = await searchParams;
  const configured = isSupabaseConfigured();
  return (
    <>
      <header className="auth-heading"><span>Welcome back</span><h1>Sign in to Automata</h1><p>Pick up where your workflows left off.</p></header>
      {notice.error ? <p className="auth-alert error">{notice.error}</p> : null}
      {notice.message ? <p className="auth-alert">{notice.message}</p> : null}
      {!configured ? <p className="auth-alert preview">Supabase keys are not set. Forms open the local product preview.</p> : null}
      <form action={signIn} className="auth-form">
        <label>Email address<input type="email" name="email" autoComplete="email" placeholder="you@company.com" required /></label>
        <label>Password<input type="password" name="password" autoComplete="current-password" placeholder="Your password" required /></label>
        <button className="button button-primary auth-submit" type="submit">Sign in</button>
      </form>
      <p className="auth-switch">New to Automata? <Link href="/signup">Create an account</Link></p>
      <p className="auth-legal">By continuing, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
    </>
  );
}
