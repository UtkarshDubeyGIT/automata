import type { Metadata } from "next";

import { ForgotPasswordForm } from "./forgot-form";

export const metadata: Metadata = { title: "Reset Your Password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <header className="auth-heading"><span>Account recovery</span><h1>Reset your password</h1><p>We&apos;ll email you a link to choose a new one.</p></header>
      <ForgotPasswordForm />
    </>
  );
}
