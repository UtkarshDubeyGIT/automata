"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

type ToastTone = "default" | "success" | "warning" | "danger";
interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

const ToastCtx = React.createContext<{
  toast: (t: { title: string; description?: string; tone?: ToastTone }) => void;
}>({ toast: () => {} });

export function useToast() {
  return React.useContext(ToastCtx);
}

const ICON: Record<ToastTone, string> = {
  default: "sparkles",
  success: "check-circle",
  warning: "shield",
  danger: "x",
};
const ACCENT: Record<ToastTone, string> = {
  default: "text-brand",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const toast = React.useCallback(
    (t: { title: string; description?: string; tone?: ToastTone }) => {
      const id = Date.now() + Math.floor(performance.now());
      setToasts((cur) => [
        ...cur,
        { id, title: t.title, description: t.description, tone: t.tone ?? "default" },
      ]);
      setTimeout(
        () => setToasts((cur) => cur.filter((x) => x.id !== id)),
        4200,
      );
    },
    [],
  );

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[200] flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-card border border-line bg-card p-4 shadow-lg"
            style={{ animation: "toast-rise 0.24s var(--ease-out)" }}
          >
            <span className={cn("mt-0.5", ACCENT[t.tone])}>
              <Icon name={ICON[t.tone]} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-ink">{t.title}</div>
              {t.description && (
                <div className="mt-0.5 text-[13px] text-ink-subtle">
                  {t.description}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <style>{`@keyframes toast-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}`}</style>
    </ToastCtx.Provider>
  );
}
