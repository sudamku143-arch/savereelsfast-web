"use client";

import { useEffect, useRef, useState } from "react";

type Dict = {
  placeholder: string;
  pasteButton: string;
  downloadCta: string;
  errorInvalid: string;
};

const REEL_URL_REGEX =
  /https?:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv)\/[a-zA-Z0-9_-]+/i;

// The manual "Get Video" button stays lenient and also accepts links without a scheme.
const MANUAL_URL_REGEX = /instagram\.com\/(reel|reels|p|tv)\/[a-zA-Z0-9_-]+/i;

// Wait for typing to pause before auto-fetching, so a half-typed link
// (which already matches the regex after one character of the ID) never fires.
const TYPING_DEBOUNCE_MS = 600;

export default function InputBox({
  dict,
  onSubmit,
  disabled,
}: {
  dict: Dict;
  onSubmit: (url: string) => void;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubmittedRef = useRef<string | null>(null);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => clearTimer, []);

  function submit(value: string) {
    clearTimer();
    lastSubmittedRef.current = value;
    setLocalError(null);
    onSubmit(value);
  }

  async function handlePaste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      setUrl(text);
      if (REEL_URL_REGEX.test(text)) {
        submit(text);
      } else if (text) {
        setLocalError(dict.errorInvalid);
      }
    } catch {
      // Clipboard access denied — user can paste manually
    }
  }

  function handleInputPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").trim();
    if (!REEL_URL_REGEX.test(text)) return; // let the browser paste normally
    e.preventDefault();
    setUrl(text);
    submit(text);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setUrl(value);
    setLocalError(null);
    clearTimer();

    const trimmed = value.trim();
    if (REEL_URL_REGEX.test(trimmed) && trimmed !== lastSubmittedRef.current) {
      timerRef.current = setTimeout(() => submit(trimmed), TYPING_DEBOUNCE_MS);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!MANUAL_URL_REGEX.test(trimmed)) {
      setLocalError(dict.errorInvalid);
      return;
    }
    submit(trimmed);
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
          placeholder={dict.placeholder}
          aria-label={dict.placeholder}
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
