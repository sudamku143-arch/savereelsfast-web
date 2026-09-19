import type { PlatformId } from "@/lib/platforms";

/** Simple monochrome glyphs (inherit `currentColor`), not official brand artwork. */
export default function PlatformIcon({
  id,
  className = "h-5 w-5",
}: {
  id: PlatformId;
  className?: string;
}) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
    focusable: false,
  };

  switch (id) {
    case "instagram":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.3" cy="6.7" r="0.6" fill="currentColor" />
        </svg>
      );
    case "youtube":
      return (
        <svg {...common}>
          <rect x="2" y="5" width="20" height="14" rx="4.5" />
          <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
        </svg>
      );
    case "facebook":
      return (
        <svg {...common}>
          <path d="M14.5 8H17V4.5h-2.7C11.9 4.5 10.5 6 10.5 8.4V11H8v3.5h2.5V21h3.5v-6.5h2.6l.5-3.5H14V8.6c0-.4.2-.6.5-.6Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "threads":
      return (
        <svg {...common}>
          <path d="M16.5 10.8c-.4-2.4-1.9-3.8-4.4-3.8-2.7 0-4.6 2-4.6 5s1.9 5 4.6 5c2.2 0 3.7-1.2 3.7-2.9 0-1.8-1.5-2.6-3.7-2.6-1.2 0-2.1.4-2.1 1.2 0 .7.6 1.1 1.5 1.1 1.7 0 2.9-1.3 3.1-3.8" />
        </svg>
      );
    case "x":
      return (
        <svg {...common} strokeWidth={2.2}>
          <path d="M5 4.5 19 19.5M19 4.5 5 19.5" />
        </svg>
      );
    case "pinterest":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M11 17.5 12.6 10M10.3 12.6c-.6-2.3 1-4 2.8-3.6 2.4.5 2.3 3.6.4 4.6-1.1.6-2.1.2-2.3-.6" />
        </svg>
      );
    case "tiktok":
      return (
        <svg {...common}>
          <path d="M14 3.5v11a3.6 3.6 0 1 1-3.6-3.6" />
          <path d="M14 3.5c.3 2.5 1.8 4 4.5 4.3" />
        </svg>
      );
  }
}
