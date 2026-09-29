import type { Metadata } from "next";

import { ResetPasswordForm } from "./reset-form";

export const metadata: Metadata = { title: "Choose a New Password" };

export default function ResetPasswordPage() {
  return (
    <>
      <header className="auth-heading"><span>Account recovery</span><h1>Choose a new password</h1><p>Pick something you don&apos;t use anywhere else.</p></header>
      <ResetPasswordForm />
    </>
  );
}
