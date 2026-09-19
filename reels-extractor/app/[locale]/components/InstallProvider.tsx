"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Chromium's install event isn't in the DOM typings.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type InstallContextValue = {
  /** True once the browser has been inspected (avoids server/client markup mismatch). */
  ready: boolean;
  /** An install action is available: the native prompt was captured, or this is iOS. */
  canInstall: boolean;
  /** Runs the native install dialog, or opens the iOS instructions. */
  install: () => Promise<void>;
  iosGuideOpen: boolean;
  closeIosGuide: () => void;
};

const InstallContext = createContext<InstallContextValue>({
  ready: false,
  canInstall: false,
  install: async () => {},
  iosGuideOpen: false,
  closeIosGuide: () => {},
});

export function useInstall(): InstallContextValue {
  return useContext(InstallContext);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function detectIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so touch support is the tell.
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Owns everything about installing the app, so the header button, the banner and
 * the iOS guide share one state. It mounts once, at the root, because the browser
 * fires `beforeinstallprompt` a single time, early: whoever misses it never gets it.
 */
export default function InstallProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);

  useEffect(() => {
    // The (cache-free for content) service worker is what lets browsers offer installation.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    setStandalone(isStandalone());
    setIos(detectIos());
    setReady(true);

    const displayMode = window.matchMedia("(display-mode: standalone)");
    const onDisplayModeChange = () => setStandalone(isStandalone());
    const onBeforeInstall = (event: Event) => {
      event.preventDefault(); // keep the browser's own mini-infobar out of the way
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
      setIosGuideOpen(false);
    };

    displayMode.addEventListener("change", onDisplayModeChange);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      displayMode.removeEventListener("change", onDisplayModeChange);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (deferred) {
      try {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        if (choice.outcome === "accepted") setInstalled(true);
      } catch {
        // prompt() refused (no user gesture) or the event was already used: nothing to recover.
      } finally {
        setDeferred(null); // a prompt event can only be used once, so never offer a dead button
      }
      return;
    }
    if (ios) setIosGuideOpen(true);
  }, [deferred, ios]);

  const value = useMemo<InstallContextValue>(
    () => ({
      ready,
      // Hidden inside the installed app, after installing, and wherever installing isn't possible.
      canInstall: ready && !standalone && !installed && (deferred !== null || ios),
      install,
      iosGuideOpen,
      closeIosGuide: () => setIosGuideOpen(false),
    }),
    [ready, standalone, installed, deferred, ios, install, iosGuideOpen]
  );

  return <InstallContext.Provider value={value}>{children}</InstallContext.Provider>;
}
