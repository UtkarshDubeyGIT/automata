import { ResetPasswordForm } from "./reset-form";

export default function ResetPasswordPage() {
  return (
    <>
      <header className="auth-heading"><span>Account recovery</span><h1>Choose a new password</h1><p>Pick something you don&apos;t use anywhere else.</p></header>
      <ResetPasswordForm />
    </>
  );
}
