"use client";

import { useEffect, useRef, useState } from "react";
import { parseSupportedUrl, type PlatformId } from "@/lib/platforms";

type Dict = {
  pasteButton: string;
  downloadCta: string;
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
      <div className="flex w-full flex-col gap-2 sm:flex-row">
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
          className="glass min-w-0 flex-1 rounded-xl px-4 py-3.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 disabled:opacity-60 sm:text-base"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handlePaste}
            disabled={disabled}
            className="glass flex-1 rounded-xl px-4 py-3.5 text-sm font-medium text-zinc-200 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 sm:flex-none"
          >
            {dict.pasteButton}
          </button>
          <button
            type="submit"
            disabled={disabled}
            className="flex-1 rounded-xl bg-brand-500 px-6 py-3.5 text-sm font-semibold text-white shadow-glow outline-none transition hover:bg-brand-400 hover:shadow-glow-lg focus-visible:ring-2 focus-visible:ring-brand-300 disabled:opacity-60 disabled:shadow-none sm:flex-none"
          >
            {dict.downloadCta}
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
