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
      <div className="flex flex-col sm:flex-row gap-2 w-full">
        <div className="relative flex-1">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={dict.placeholder}
            disabled={disabled}
            className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3.5 text-sm sm:text-base shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60"
          />
        </div>
        <button
          type="button"
          onClick={handlePaste}
          disabled={disabled}
          className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:bg-zinc-50 disabled:opacity-60"
        >
          {dict.pasteButton}
        </button>
        <button
          type="submit"
          disabled={disabled}
          className="rounded-xl bg-brand-500 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:opacity-60"
        >
          {dict.downloadCta}
        </button>
      </div>
      {localError && (
        <p className="mt-2 text-sm text-red-600">{localError}</p>
      )}
    </form>
  );
}
