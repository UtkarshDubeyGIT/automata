import type { SVGProps } from "react";

export type ProductIconName =
  | "activity"
  | "arrow-right"
  | "bell"
  | "blocks"
  | "branch"
  | "cable"
  | "check"
  | "check-circle"
  | "clock"
  | "close"
  | "dashboard"
  | "filter"
  | "help"
  | "history"
  | "inbox"
  | "loader"
  | "play"
  | "plus"
  | "search"
  | "send"
  | "settings"
  | "sparkles"
  | "template"
  | "warning";

type ProductIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: ProductIconName;
  size?: number;
};

export function ProductIcon({ name, size = 18, ...props }: ProductIconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.2}
        vectorEffect="non-scaling-stroke"
      >
        {pathFor(name)}
      </g>
    </svg>
  );
}

function pathFor(name: ProductIconName) {
  switch (name) {
    case "activity":
      return <path d="M3 12h4l2.1-6 4.1 12 2.2-6H21" />;
    case "arrow-right":
      return <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>;
    case "bell":
      return <><path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 5 2 5 2 6.5h-15c0-1.5 2-1.5 2-6.5Z" /><path d="M10 19h4" /></>;
    case "blocks":
      return <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><path d="M14 17.5h7M17.5 14v7" /></>;
    case "branch":
      return <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 7v6a5 5 0 0 0 5 5h5M8 7h8" /></>;
    case "cable":
      return <><path d="M8 3v5M5 5h6M16 16v5M13 19h6" /><path d="M8 8v2a6 6 0 0 0 6 6h2" /></>;
    case "check":
      return <path d="m5 12.5 4.3 4.3L19 7" />;
    case "check-circle":
      return <><circle cx="12" cy="12" r="9" /><path d="m7.5 12 3 3 6-6" /></>;
    case "clock":
      return <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>;
    case "close":
      return <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>;
    case "dashboard":
      return <><path d="M4 13a8 8 0 1 1 16 0" /><path d="m12 13 4-4" /><path d="M5 18h14" /></>;
    case "filter":
      return <><path d="M4 6h16M7 12h10M10 18h4" /></>;
    case "help":
      return <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 3.3 2.4c-.9.4-.9 1.1-.9 1.6M12 17h.01" /></>;
    case "history":
      return <><path d="M4 6v5h5" /><path d="M5.5 8.5A8 8 0 1 1 5 16" /><path d="M12 8v4l3 2" /></>;
    case "inbox":
      return <><path d="M4 5h16l1 9v5H3v-5l1-9Z" /><path d="M3 14h5l1.5 2h5L16 14h5" /></>;
    case "loader":
      return <><path d="M12 3a9 9 0 0 1 9 9" /><path d="M12 21a9 9 0 0 1-9-9" /></>;
    case "play":
      return <path d="m8 5 11 7-11 7V5Z" />;
    case "plus":
      return <><path d="M12 5v14M5 12h14" /></>;
    case "search":
      return <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></>;
    case "send":
      return <><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></>;
    case "settings":
      return <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>;
    case "sparkles":
      return <><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z" /><path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></>;
    case "template":
      return <><rect height="16" rx="2" width="18" x="3" y="4" /><path d="M8 4v16M8 10h13" /></>;
    case "warning":
      return <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17h.01" /></>;
  }
}
