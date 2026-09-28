"use client";

import { useEffect, useRef, useState } from "react";
import { parseSupportedUrl, type PlatformId } from "@/lib/platforms";

type Dict = {
  pasteButton: string;
  downloadCta: string;
  /** Short "Processing…" shown on the button, with a spinner, while a link is being looked up. */
  working: string;
  errorInvalid: string;
};

// Wait for typing to pause before auto-fetching, so a half-typed link
// (which can already look valid after a few characters) never fires.
const TYPING_DEBOUNCE_MS = 600;

export default function InputBox({
  dict,
  placeholder,
  defaultUrl = "",
  onSubmit,
  onDetectPlatform,
  onDraftChange,
  disabled,
}: {
  dict: Dict;
  placeholder: string;
  defaultUrl?: string;
  onSubmit: (url: string) => void;
  onDetectPlatform: (platform: PlatformId) => void;
  /** Called with the current text (so it can be kept across a platform switch). */
  onDraftChange?: (text: string) => void;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState(defaultUrl);
  const [localError, setLocalError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubmittedRef = useRef<string | null>(defaultUrl || null);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => clearTimer, []);

  /** Detects the platform, cleans the link and starts the fetch immediately. */
  function submit(value: string): boolean {
    clearTimer();
    const parsed = parseSupportedUrl(value);
    if (!parsed) return false;

    lastSubmittedRef.current = parsed.url;
    setUrl(parsed.url);
    onDraftChange?.(parsed.url);
    setLocalError(null);
    onDetectPlatform(parsed.platform);
    onSubmit(parsed.url);
    return true;
  }

  async function handlePaste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      setUrl(text);
      if (!submit(text) && text) setLocalError(dict.errorInvalid);
    } catch {
      // Clipboard access denied — user can paste manually
    }
  }

  function handleInputPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").trim();
    if (!parseSupportedUrl(text)) return; // let the browser paste normally
    e.preventDefault();
    submit(text);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setUrl(value);
    onDraftChange?.(value);
    setLocalError(null);
    clearTimer();

    const parsed = parseSupportedUrl(value);
    if (parsed) {
      // Highlight the platform right away; the fetch waits for typing to pause.
      onDetectPlatform(parsed.platform);
      if (parsed.url !== lastSubmittedRef.current) {
        timerRef.current = setTimeout(() => submit(value), TYPING_DEBOUNCE_MS);
      }
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submit(url)) setLocalError(dict.errorInvalid);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      {/* One glass bar holding the field and both buttons (stacked under it on phones). The pink glow
          brightens while the field has focus. */}
      <div className="flex w-full flex-col gap-2 rounded-3xl border border-brand-400/30 bg-white/[0.03] p-2 shadow-glow-input backdrop-blur-xl transition duration-300 focus-within:border-brand-400/60 focus-within:shadow-glow-input-focus sm:flex-row sm:items-center sm:rounded-full">
        <label className="flex min-w-0 flex-1 items-center gap-3 px-3">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-brand-300"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={handleChange}
            onPaste={handleInputPaste}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-invalid={localError ? true : undefined}
            disabled={disabled}
            className="min-w-0 flex-1 bg-transparent py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 disabled:opacity-60 sm:text-base"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handlePaste}
            disabled={disabled}
            className="flex-1 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-200 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-60 sm:flex-none"
          >
            {dict.pasteButton}
          </button>
          <button
            type="submit"
            disabled={disabled}
            aria-busy={disabled ? true : undefined}
            className="btn-primary flex flex-1 items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:opacity-80 sm:flex-none"
          >
            {disabled && (
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4 shrink-0 motion-safe:animate-spin">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            )}
            {disabled ? dict.working : dict.downloadCta}
          </button>
        </div>
      </div>
      {localError && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {localError}
        </p>
      )}
    </form>
  );
}
