import { cn } from "@/lib/utils";

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const SIZES = {
  sm: "h-7 w-7 text-[11px]",
  md: "h-9 w-9 text-[13px]",
  lg: "h-11 w-11 text-[15px]",
} as const;

export function Avatar({
  name,
  src,
  size = "md",
  status,
  className,
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  status?: "online" | "offline";
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full font-semibold",
          "bg-gradient-to-br from-indigo-500 to-indigo-700 text-white",
          SIZES[size],
        )}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded avatar URL, not a static asset
          <img
            src={src}
            alt={name}
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          initials(name)
        )}
      </span>
      {status && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card",
            status === "online" ? "bg-success" : "bg-gray-300",
          )}
        />
      )}
    </span>
  );
}
