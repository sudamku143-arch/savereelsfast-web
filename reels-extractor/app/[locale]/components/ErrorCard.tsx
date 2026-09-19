"use client";

import type { ErrorCode } from "@/lib/errors";
import { CONTACT_EMAIL } from "@/lib/site";

export type UiErrorCode = ErrorCode | "NETWORK";

type Entry = { title: string; message: string };

export type ErrorsDict = Record<UiErrorCode, Entry> & {
  actions: {
    retry: string;
    clear: string;
    report: string;
    reportSubject: string;
    reportBody: string;
  };
};

function Icon({ code }: { code: UiErrorCode }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-5 w-5",
    "aria-hidden": true,
    focusable: false,
  };

  switch (code) {
    case "LOGIN_REQUIRED":
      return (
        <svg {...common}>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      );
    case "UNSUPPORTED_POST":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m3 3 18 18" />
        </svg>
      );
    case "STREAM_EXPIRED_OR_BLOCKED":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m5.6 5.6 12.8 12.8" />
        </svg>
      );
    case "PLATFORM_TIMEOUT":
    case "NETWORK":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M12 3 2 20h20L12 3Z" />
          <path d="M12 10v4M12 17.5v.01" />
        </svg>
      );
  }
}

export default function ErrorCard({
  code,
  platformName,
  dict,
  link,
  onRetry,
  onClear,
}: {
  code: UiErrorCode;
  platformName: string;
  dict: ErrorsDict;
  link: string | null;
  onRetry: () => void;
  onClear: () => void;
}) {
  const entry = dict[code] ?? dict.EXTRACTION_FAILED;
  const fill = (text: string) => text.replaceAll("{platform}", platformName);

  const reportHref = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
    dict.actions.reportSubject
  )}&body=${encodeURIComponent(
    `${dict.actions.reportBody}\n\nLink: ${link ?? "-"}\nError: ${code}\nPlatform: ${platformName}`
  )}`;

  return (
    <div
      role="alert"
      className="glass mt-6 w-full max-w-md animate-fade-in-up rounded-2xl border-red-400/20 p-4"
    >
      <div className="flex gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-300">
          <Icon code={code} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-50">{fill(entry.title)}</p>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">{fill(entry.message)}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {link && (
          <button
            type="button"
            onClick={onRetry}
            className="flex-1 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-glow outline-none transition hover:bg-brand-400 focus-visible:ring-2 focus-visible:ring-brand-300 sm:flex-none"
          >
            {dict.actions.retry}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="flex-1 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-300 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500 sm:flex-none"
        >
          {dict.actions.clear}
        </button>
        <a
          href={reportHref}
          className="w-full rounded text-center text-xs text-zinc-500 underline-offset-2 outline-none hover:text-zinc-300 hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 sm:ml-auto sm:w-auto"
        >
          {dict.actions.report}
        </a>
      </div>
    </div>
  );
}
