"use client";

import { useState } from "react";

type Dict = {
  placeholder: string;
  pasteButton: string;
  downloadCta: string;
  errorInvalid: string;
};

const REEL_URL_REGEX = /instagram\.com\/(reel|reels|p)\/[A-Za-z0-9_-]+/i;

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

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
      setLocalError(null);
    } catch {
      // Clipboard access denied — user can paste manually
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!REEL_URL_REGEX.test(trimmed)) {
      setLocalError(dict.errorInvalid);
      return;
    }
    setLocalError(null);
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
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
