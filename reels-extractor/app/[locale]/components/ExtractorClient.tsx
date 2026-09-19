"use client";

import { useRef, useState } from "react";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { isErrorCode } from "@/lib/errors";
import InputBox from "./InputBox";
import PlatformTabs from "./PlatformTabs";
import SkeletonLoader from "./SkeletonLoader";
import PreviewCard, { type ReelResult } from "./PreviewCard";
import ErrorCard, { type ErrorsDict, type UiErrorCode } from "./ErrorCard";

type HeroDict = {
  badge: string;
  subtitle: string;
  pasteButton: string;
  downloadCta: string;
  loading: string;
  errorGeneric: string;
  errorInvalid: string;
};

type PlatformsDict = { label: string } & Record<
  PlatformId,
  { name: string; title: string; placeholder: string }
>;

type PreviewDict = {
  title: string;
  author: string;
  duration: string;
  downloadButton: string;
  newSearch: string;
  thumbnailAlt: string;
  noAudio: string;
};

export default function ExtractorClient({
  heroDict,
  platformsDict,
  previewDict,
  errorsDict,
}: {
  heroDict: HeroDict;
  platformsDict: PlatformsDict;
  previewDict: PreviewDict;
  errorsDict: ErrorsDict;
}) {
  const [platform, setPlatform] = useState<PlatformId>("instagram");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [result, setResult] = useState<ReelResult | null>(null);
  const [errorCode, setErrorCode] = useState<UiErrorCode | null>(null);
  // Remounting the input clears it; "Try again" reuses the last link.
  const [inputKey, setInputKey] = useState(0);
  const lastUrlRef = useRef<string | null>(null);

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, platformsDict[id].name])
  ) as Record<PlatformId, string>;

  async function handleSubmit(url: string) {
    lastUrlRef.current = url;
    setStatus("loading");
    setErrorCode(null);
    setResult(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorCode(isErrorCode(data.code) ? data.code : "EXTRACTION_FAILED");
        setStatus("error");
        return;
      }

      setResult(data as ReelResult);
      setStatus("done");
    } catch {
      setErrorCode("NETWORK");
      setStatus("error");
    }
  }

  /** Back to a clean slate: no result, no error, empty input. */
  function handleReset() {
    setStatus("idle");
    setResult(null);
    setErrorCode(null);
    lastUrlRef.current = null;
    setInputKey((k) => k + 1);
  }

  function handleRetry() {
    if (lastUrlRef.current) void handleSubmit(lastUrlRef.current);
  }

  function handleSelectPlatform(id: PlatformId) {
    setPlatform(id);
    if (status === "error") {
      setStatus("idle");
      setErrorCode(null);
    }
  }

  const active = platformsDict[platform];

  return (
    <div className="flex w-full flex-col items-center">
      <span className="mb-4 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-300 ring-1 ring-brand-500/30">
        {heroDict.badge}
      </span>
      <h1 className="max-w-2xl text-center text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-5xl">
        {active.title}
      </h1>
      <p className="mt-4 max-w-xl text-center text-sm text-zinc-400 sm:text-base">
        {heroDict.subtitle}
      </p>

      <div className="mt-8 w-full max-w-xl space-y-3">
        <PlatformTabs
          label={platformsDict.label}
          names={names}
          active={platform}
          onSelect={handleSelectPlatform}
        />
        <InputBox
          key={inputKey}
          dict={heroDict}
          placeholder={active.placeholder}
          onSubmit={handleSubmit}
          onDetectPlatform={setPlatform}
          disabled={status === "loading"}
        />
      </div>

      <div className="flex w-full flex-col items-center" aria-live="polite">
        {status === "loading" && <SkeletonLoader label={heroDict.loading} />}

        {status === "error" && errorCode && (
          <ErrorCard
            code={errorCode}
            platformName={active.name}
            dict={errorsDict}
            link={lastUrlRef.current}
            onRetry={handleRetry}
            onClear={handleReset}
          />
        )}

        {status === "done" && result && (
          <PreviewCard result={result} dict={previewDict} onReset={handleReset} />
        )}
      </div>
    </div>
  );
}
