"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { isErrorCode } from "@/lib/errors";
import type { ErrorsDict, UiErrorCode } from "./ErrorCard";

export type DownloadDict = {
  preparing: string;
  downloading: string; // "{progress}" is replaced with "42% · 12.3 MB" or "12.3 MB"
  saving: string;
  saved: string;
  cancel: string;
};

type Variant = "primary" | "secondary" | "compact" | "compact-secondary";

// Buffering a download in memory is what makes a progress bar and an error message
// possible, but it has a cost. Above this size the browser's own download manager
// (which streams to disk) takes over instead.
const MAX_IN_MEMORY_BYTES = 80 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 120;
const SAVED_FLASH_MS = 2500;
const RETRY_PAUSE_MS = 1000;
// Only a busy signal is retried quietly; a block or timeout is shown at once instead of after a second wait.
const RETRYABLE = ["SERVER_BUSY"];

const STYLES: Record<Variant, string> = {
  primary:
    "rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-glow hover:bg-brand-400 hover:shadow-glow-lg focus-visible:ring-brand-300",
  secondary:
    "rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-zinc-100 hover:bg-white/10 focus-visible:ring-brand-500",
  compact:
    "rounded-lg bg-brand-500 px-2 py-1.5 text-xs font-semibold text-white hover:bg-brand-400 focus-visible:ring-brand-300",
  "compact-secondary":
    "rounded-lg border border-white/10 px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-white/10 focus-visible:ring-brand-500",
};

type State =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "downloading"; received: number; total: number | null }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; code: UiErrorCode };

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Hands the file to the browser's own download manager (streams to disk, no size limit). */
function nativeDownload(href: string, filename: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function DownloadButton({
  href,
  filename,
  label,
  variant = "primary",
  dict,
  errorsDict,
  platformName,
}: {
  href: string;
  filename: string;
  label: string;
  variant?: Variant;
  dict: DownloadDict;
  errorsDict: ErrorsDict;
  platformName: string;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    []
  );

  async function start(retried = false) {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "preparing" });

    try {
      const response = await fetch(href, { signal: controller.signal });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { code?: string } | null;
        const code = isErrorCode(body?.code) ? body.code : "STREAM_EXPIRED_OR_BLOCKED";
        if (!retried && RETRYABLE.includes(code)) {
          // The scraper is momentarily full: one more try after a short pause usually gets a slot.
          await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
          if (controller.signal.aborted) return;
          return await start(true);
        }
        setState({ phase: "error", code });
        return;
      }

      // Content-Length can be replaced by chunked encoding on streamed responses; X-File-Size backs it up.
      const total =
        Number(response.headers.get("content-length")) ||
        Number(response.headers.get("x-file-size")) ||
        null;
      const reader = response.body?.getReader();
      if (!reader || (total && total > MAX_IN_MEMORY_BYTES)) {
        controller.abort();
        nativeDownload(href, filename);
        setState({ phase: "idle" });
        return;
      }

      const parts: Uint8Array[] = [];
      let received = 0;
      let lastPaint = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.length;

        if (!total && received > MAX_IN_MEMORY_BYTES) {
          // Unknown size turned out to be huge: restart it in the browser's download manager.
          controller.abort();
          nativeDownload(href, filename);
          setState({ phase: "idle" });
          return;
        }

        const now = performance.now();
        if (now - lastPaint >= PROGRESS_INTERVAL_MS) {
          lastPaint = now;
          setState({ phase: "downloading", received, total });
        }
      }

      setState({ phase: "saving" });
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      saveBlob(new Blob(parts as BlobPart[], { type }), filename);

      setState({ phase: "saved" });
      savedTimerRef.current = setTimeout(() => setState({ phase: "idle" }), SAVED_FLASH_MS);
    } catch (err) {
      if (controller.signal.aborted) return; // cancelled, or handed over to the browser
      console.warn("[download] failed", err);
      setState({ phase: "error", code: "NETWORK" });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // Let "open in new tab" and friends behave normally.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void start();
  }

  function cancel() {
    controllerRef.current?.abort();
    setState({ phase: "idle" });
  }

  const busy =
    state.phase === "preparing" || state.phase === "downloading" || state.phase === "saving";
  const compact = variant === "compact" || variant === "compact-secondary";
  const percent =
    state.phase === "downloading" && state.total
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : null;

  let status = "";
  if (state.phase === "preparing") status = dict.preparing;
  else if (state.phase === "downloading") {
    const size = formatBytes(state.received);
    status = dict.downloading.replace("{progress}", percent != null ? `${percent}% · ${size}` : size);
  } else if (state.phase === "saving") status = dict.saving;
  else if (state.phase === "saved") status = dict.saved;

  if (busy) {
    return (
      <div
        className={`${STYLES[variant]} flex flex-col gap-1.5 text-left opacity-95`}
        aria-live="polite"
        aria-busy="true"
      >
        <div className="flex items-center justify-between gap-2">
          <span className={compact ? "truncate text-[11px]" : "truncate text-sm"}>{status}</span>
          <button
            type="button"
            onClick={cancel}
            className="shrink-0 rounded px-1 text-[11px] font-medium underline underline-offset-2 opacity-80 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {dict.cancel}
          </button>
        </div>
        {/* Determinate once the size is known; otherwise a sliding indeterminate bar. */}
        <div
          role="progressbar"
          aria-label={status}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-1.5 w-full overflow-hidden rounded-full bg-black/25"
        >
          {percent != null ? (
            <div
              className="h-full rounded-full bg-white/90 transition-[width] duration-150 ease-out"
              style={{ width: `${percent}%` }}
            />
          ) : (
            <div className="animate-indeterminate h-full w-1/4 rounded-full bg-white/90" />
          )}
        </div>
      </div>
    );
  }

  const error = state.phase === "error" ? (errorsDict[state.code] ?? errorsDict.EXTRACTION_FAILED) : null;

  return (
    <div className="flex flex-col gap-1">
      <a
        href={href}
        download={filename}
        onClick={onClick}
        className={`${STYLES[variant]} block text-center outline-none transition focus-visible:ring-2`}
      >
        {state.phase === "saved" ? `✓ ${dict.saved}` : label}
      </a>
      {error && (
        <p role="alert" className="text-xs leading-snug text-red-300">
          {error.message.replaceAll("{platform}", platformName)}
        </p>
      )}
    </div>
  );
}
