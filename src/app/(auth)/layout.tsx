import { AuthOrbits } from "@/components/auth-orbits";
import { Logo } from "@/components/logo";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="theme-light grid min-h-dvh lg:grid-cols-2">
      {/* Form side */}
      <div className="flex flex-col px-6 py-8">
        <div className="mx-auto w-full max-w-sm flex-none">
          <Logo />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm py-10">{children}</div>
        </div>
      </div>

      {/* Brand panel — the sanctioned dark editorial surface */}
      <div className="relative hidden overflow-hidden bg-gray-950 lg:block">
        <AuthOrbits />
        <div className="relative flex h-full flex-col justify-end p-14">
          <blockquote className="max-w-md">
            <p className="font-display text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white text-balance">
              Tell it once. Watch work move.
            </p>
            <p className="mt-5 text-[15px] text-gray-400">
              Connect your tools, describe your workflow, and review what runs.
              Automata handles the repetition while you stay in control.
            </p>
          </blockquote>
          <div className="mt-10 flex gap-8 border-t border-white/10 pt-8">
            {[
              ["Build", "in plain language"],
              ["Connect", "your tools"],
              ["Review", "every run"],
            ].map(([v, l]) => (
              <div key={l}>
                <div className="font-mono text-[22px] font-semibold text-white">
                  {v}
                </div>
                <div className="mt-0.5 text-[13px] text-gray-500">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
