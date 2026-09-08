import Link from "next/link";

import { NOTICE_COPY } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirects";
import { isSupabaseConfigured } from "@/lib/supabase/config";

import { LoginForm } from "./login-form";

type LoginPageProps = { searchParams: Promise<{ next?: string; notice?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  // Guarded here so a hostile ?next= never reaches the DOM.
  const next = safeNext(params.next);
  const notice = params.notice ? NOTICE_COPY[params.notice] : undefined;

  return (
    <>
      <header className="auth-heading"><span>Welcome back</span><h1>Sign in to Automata</h1><p>Pick up where your workflows left off.</p></header>
      {notice ? <p className="auth-alert" role="status">{notice}</p> : null}
      {!isSupabaseConfigured() ? <p className="auth-alert preview">Supabase keys are not set. Forms open the local product preview.</p> : null}
      <LoginForm next={next} />
      <p className="auth-legal">By continuing, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
    </>
  );
}
