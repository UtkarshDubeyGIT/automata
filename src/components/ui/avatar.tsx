import { Icon, type IconName } from "@/components/ui/icon";
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

const HOVER_ICON_SIZES = {
  sm: 12,
  md: 15,
  lg: 17,
} as const;

export function Avatar({
  name,
  src,
  size = "md",
  status,
  hoverIcon,
  className,
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  status?: "online" | "offline";
  /** Icon to cross-fade into on hover; requires a `group` ancestor. */
  hoverIcon?: IconName;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <span
        className={cn(
          "relative inline-flex items-center justify-center overflow-hidden rounded-full font-semibold",
          "bg-gradient-to-br from-indigo-500 to-indigo-700 text-white",
          SIZES[size],
        )}
      >
        <span
          className={cn(
            "flex h-full w-full items-center justify-center transition-all duration-200 ease-out",
            hoverIcon && "group-hover:scale-75 group-hover:opacity-0",
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
        {hoverIcon && (
          <span
            aria-hidden
            className="absolute inset-0 flex scale-75 items-center justify-center opacity-0 transition-all duration-200 ease-out group-hover:scale-100 group-hover:opacity-100"
          >
            <Icon name={hoverIcon} size={HOVER_ICON_SIZES[size]} />
          </span>
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
