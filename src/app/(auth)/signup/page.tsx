import Link from "next/link";

import { NOTICE_COPY } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirects";
import { isSupabaseConfigured } from "@/lib/supabase/config";

import { SignupForm } from "./signup-form";

type SignupPageProps = { searchParams: Promise<{ next?: string; notice?: string }> };

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const notice = params.notice ? NOTICE_COPY[params.notice] : undefined;

  return (
    <>
      <header className="auth-heading"><span>Private beta</span><h1>Build your first automation</h1><p>Start free. Publish when you are ready.</p></header>
      {notice ? <p className="auth-alert" role="status">{notice}</p> : null}
      {!isSupabaseConfigured() ? <p className="auth-alert preview">Supabase keys are not set. Forms open the local product preview.</p> : null}
      <SignupForm next={next} />
      <p className="auth-legal">By continuing, you agree to our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
    </>
  );
}
