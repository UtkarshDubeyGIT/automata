import { Skeleton } from "@/components/ui/feedback";

/**
 * Route-level loading state for Automations.
 *
 * It mirrors the "Create a new one" tab, because that is the tab the page opens
 * on: the centred tab rail, the composer hero, the two-up suggestion grid, and
 * the template grid under its divider. The previous version drew a 360px column
 * beside a stack of list rows — a layout this page has not had since the tabs
 * landed — so every load ended in a full re-shuffle of the screen.
 *
 * Widths and gaps are copied from page.tsx rather than approximated, so the
 * skeleton and the real thing occupy the same boxes.
 */
export default function Loading() {
  return (
    <div aria-hidden="true">
      {/* TabBar: centred pill rail, four tabs. */}
      <div className="flex justify-center">
        <div className="inline-flex gap-0.5 rounded-full border border-line bg-inset p-1">
          {/* Widths track the real labels: Create a new one / My workflows /
              Runs history / Needs your attention. The first is drawn as the
              selected pill, because the page opens on that tab — a rail of four
              identical bars reads as one blob and then rearranges on load. */}
          {["w-[104px]", "w-[96px]", "w-[92px]", "w-[132px]"].map((w, i) => (
            <span
              key={i}
              className={`flex h-8 items-center justify-center rounded-full ${w} ${
                i === 0 ? "bg-card shadow-xs" : ""
              }`}
            >
              <Skeleton className={`h-[13px] ${i === 0 ? "w-3/5" : "w-2/3"}`} />
            </span>
          ))}
        </div>
      </div>

      {/* BuilderChat, hero variant. */}
      <div className="pt-6">
        <div className="mx-auto w-full max-w-[820px]">
          <div className="flex flex-col items-center text-center">
            <Skeleton className="h-[38px] w-[min(420px,90%)]" />
            <Skeleton className="mt-3.5 h-[19px] w-[min(540px,100%)]" />
          </div>

          {/* The composer. */}
          <Skeleton rounded="card" className="mt-5 h-[132px] w-full" />

          {/* Four suggestions, two up. */}
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-card border border-line bg-card px-4 py-3.5"
              >
                <Skeleton className="h-8 w-8 flex-none rounded-[9px]" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-[14px] w-1/2" />
                  <Skeleton className="mt-2 h-[12px] w-full" />
                </div>
              </div>
            ))}
          </div>

          {/* "Prefer to build step by step?" + Create manually. */}
          <div className="mx-auto mt-5 flex w-fit items-center gap-2.5">
            <Skeleton className="h-[15px] w-[168px]" />
            <Skeleton rounded="control" className="h-[34px] w-[132px]" />
          </div>
        </div>
      </div>

      {/* "Or start from a template" divider, then the template grid. */}
      <div className="mx-auto mt-9 w-full max-w-[1080px]">
        <div className="flex items-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <Skeleton className="h-[15px] w-[164px]" />
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex flex-col gap-2.5 rounded-card border border-line bg-card p-4 shadow-xs"
            >
              {/* WorkflowLogo: 40px, rounded-[12px]. */}
              <Skeleton className="h-10 w-10 rounded-[12px]" />
              <Skeleton className="h-[15px] w-2/3" />
              <Skeleton className="h-[13px] w-full" />
              <Skeleton className="h-[13px] w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
