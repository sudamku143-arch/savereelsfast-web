"use client";

import { useState } from "react";
import InputBox from "./InputBox";
import SkeletonLoader from "./SkeletonLoader";
import PreviewCard, { type ReelResult } from "./PreviewCard";

type Dict = {
  placeholder: string;
  pasteButton: string;
  downloadCta: string;
  loading: string;
  errorGeneric: string;
  errorInvalid: string;
};

type PreviewDict = {
  title: string;
  author: string;
  duration: string;
  downloadButton: string;
  newSearch: string;
  quality: string;
  original: string;
  thumbnailAlt: string;
};

export default function ExtractorClient({
  heroDict,
  previewDict,
}: {
  heroDict: Dict;
  previewDict: PreviewDict;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [result, setResult] = useState<ReelResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(url: string) {
    setStatus("loading");
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error ?? heroDict.errorGeneric);
        setStatus("error");
        return;
      }

      setResult(data.data as ReelResult);
      setStatus("done");
    } catch {
      setError(heroDict.errorGeneric);
      setStatus("error");
    }
  }

  function handleReset() {
    setStatus("idle");
    setResult(null);
    setError(null);
  }

  return (
    <div className="flex w-full flex-col items-center">
      <div className="w-full max-w-xl">
        <InputBox
          dict={heroDict}
          onSubmit={handleSubmit}
          disabled={status === "loading"}
        />
      </div>

      {status === "loading" && <SkeletonLoader label={heroDict.loading} />}

      {status === "error" && error && (
        <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>
      )}

      {status === "done" && result && (
        <PreviewCard result={result} dict={previewDict} onReset={handleReset} />
      )}
    </div>
  );
}
