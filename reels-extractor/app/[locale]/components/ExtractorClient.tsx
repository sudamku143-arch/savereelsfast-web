"use client";

import { useEffect, useRef, useState } from "react";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { isErrorCode } from "@/lib/errors";
import {
  getCachedResult,
  getLastViewed,
  putCachedResult,
  setLastViewed,
} from "@/lib/result-cache";
import InputBox from "./InputBox";
import PlatformTabs from "./PlatformTabs";
import SkeletonLoader from "./SkeletonLoader";
import PreviewCard, { type PreviewDict, type ReelResult } from "./PreviewCard";
import ErrorCard, { type ErrorsDict, type UiErrorCode } from "./ErrorCard";
import type { DownloadDict } from "./DownloadButton";
import AdBanner, { type AdDict } from "./AdBanner";

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

export default function ExtractorClient({
  heroDict,
  platformsDict,
  previewDict,
  errorsDict,
  downloadDict,
  adDict,
  initialPlatform = "instagram",
  fixedHeading,
}: {
  heroDict: HeroDict;
  platformsDict: PlatformsDict;
  previewDict: PreviewDict;
  errorsDict: ErrorsDict;
  downloadDict: DownloadDict;
  adDict: AdDict;
  /** Platform tab selected on first render (platform landing pages preselect theirs). */
  initialPlatform?: PlatformId;
  /**
   * Landing pages keep one fixed h1 and intro, whichever tab is active, because the
   * heading is what the page is meant to rank for. The home page changes it per tab.
   */
  fixedHeading?: { title: string; subtitle: string };
}) {
  const [platform, setPlatform] = useState<PlatformId>(initialPlatform);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [result, setResult] = useState<ReelResult | null>(null);
  const [errorCode, setErrorCode] = useState<UiErrorCode | null>(null);
  // Remounting the input clears it; "Try again" reuses the last link.
  const [inputKey, setInputKey] = useState(0);
  const [restoredUrl, setRestoredUrl] = useState("");
  const lastUrlRef = useRef<string | null>(null);

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, platformsDict[id].name])
  ) as Record<PlatformId, string>;

  // Coming back to the page (browser back, reload) shows the last result again
  // straight from sessionStorage: no spinner, no request.
  useEffect(() => {
    const last = getLastViewed<ReelResult>();
    if (!last) return;
    lastUrlRef.current = last.url;
    setResult(last.result);
    setStatus("done");
    if (last.result.platform) setPlatform(last.result.platform);
    setRestoredUrl(last.url);
    setInputKey((k) => k + 1);
  }, []);

  async function handleSubmit(url: string) {
    lastUrlRef.current = url;
    setErrorCode(null);

    // One of the last five successful lookups: render it instantly.
    const cached = getCachedResult<ReelResult>(url);
    if (cached) {
      setResult(cached);
      setStatus("done");
      if (cached.platform) setPlatform(cached.platform);
      setLastViewed(url);
      return;
    }

    setStatus("loading");
    setResult(null);

    try {
      // GET, so identical lookups can be cached by the CDN (see /api/extract).
      const res = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorCode(isErrorCode(data.code) ? data.code : "EXTRACTION_FAILED");
        setStatus("error");
        return;
      }

      const fresh = data as ReelResult;
      putCachedResult(url, fresh);
      setLastViewed(url);
      setResult(fresh);
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
    setLastViewed(null); // the cached results stay: pasting the same link again is still instant
    setRestoredUrl("");
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
        {fixedHeading?.title ?? active.title}
      </h1>
      <p className="mt-4 max-w-xl text-center text-sm text-zinc-400 sm:text-base">
        {fixedHeading?.subtitle ?? heroDict.subtitle}
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
          defaultUrl={restoredUrl}
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
          <>
            <PreviewCard
              result={result}
              dict={previewDict}
              downloadDict={downloadDict}
              errorsDict={errorsDict}
              platform={result.platform ?? platform}
              platformName={platformsDict[result.platform ?? platform].name}
              onReset={handleReset}
            />
            {/* Slot 2: right where attention is, directly below the result. */}
            <AdBanner variant="native" dict={adDict} className="mt-4" />
          </>
        )}
      </div>
    </div>
  );
}
