import Link from "next/link";

import { isSupabaseConfigured } from "@/lib/supabase/config";

import { signInWithGoogle, signUp } from "../actions";

type SignupPageProps = { searchParams: Promise<{ error?: string }> };

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const notice = await searchParams;
  return (
    <>
      <header className="auth-heading"><span>Private beta</span><h1>Build your first automation</h1><p>Start free. Publish when you are ready.</p></header>
      {notice.error ? <p className="auth-alert error">{notice.error}</p> : null}
      {!isSupabaseConfigured() ? <p className="auth-alert preview">Supabase keys are not set. Forms open the local product preview.</p> : null}
      <form action={signInWithGoogle}><button className="oauth-button" type="submit"><b>G</b> Continue with Google</button></form>
      <div className="auth-divider"><span>or use email</span></div>
      <form action={signUp} className="auth-form">
        <label>Full name<input name="fullName" autoComplete="name" placeholder="Alex Morgan" required /></label>
        <label>Work email<input type="email" name="email" autoComplete="email" placeholder="you@company.com" required /></label>
        <label>Password<input type="password" name="password" autoComplete="new-password" minLength={8} placeholder="At least 8 characters" required /></label>
        <button className="button button-primary auth-submit" type="submit">Create free workspace</button>
      </form>
      <p className="auth-switch">Already have an account? <Link href="/login">Sign in</Link></p>
      <p className="auth-legal">By continuing, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
    </>
  );
}
