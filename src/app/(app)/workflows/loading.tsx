import { Card } from "@/components/ui/card";

/**
 * Route-level loading state. Without one, navigating to Automations showed the
 * previous page until the bundle and the first fetch both landed.
 */
export default function Loading() {
  return (
    <div className="flex flex-col items-start gap-6 lg:flex-row">
      <div className="h-[420px] w-full animate-pulse rounded-card bg-inset lg:w-[360px]" />
      <div className="flex w-full min-w-0 flex-1 flex-col gap-4">
        <div className="h-[180px] animate-pulse rounded-card bg-inset" />
        <div className="h-[42px] animate-pulse rounded-card bg-inset" />
        <Card className="p-0">
          <div className="flex flex-col gap-3 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[72px] animate-pulse rounded-[10px] bg-inset" />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
