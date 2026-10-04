/**
 * The result card's inline player: native controls, nothing downloaded before play, never autoplays, a cover
 * image up front, and a quiet fallback that never gets in the way of the download buttons.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { IP_BOUND_HOSTS, isIpBoundHost } from "../lib/download.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const player = source("app/[locale]/components/VideoPreview.tsx");
const card = source("app/[locale]/components/PreviewCard.tsx");
const route = source("app/api/download/route.ts");
const videoTag = player.slice(player.indexOf("<video"), player.indexOf("/>", player.indexOf("<video")));

describe("the <video> element", () => {
  it("has native controls (play, volume, and the browser's own Download in its menu)", () => {
    assert.match(videoTag, /\bcontrols\b/);
    assert.doesNotMatch(player, /controlsList|nodownload/, "the native download option stays available");
  });

  it("downloads nothing until the visitor presses play", () => {
    assert.match(videoTag, /preload="none"/);
    assert.doesNotMatch(videoTag, /autoPlay/i);
    assert.doesNotMatch(player, /\.play\(\)/, "no scripted autoplay either");
  });

  it("shows the reel's cover first and plays inline on phones", () => {
    assert.match(videoTag, /poster=\{poster \|\| undefined\}/);
    assert.match(videoTag, /\bplaysInline\b/);
  });

  it("is a rounded, width-bounded, responsive frame", () => {
    assert.match(player, /rounded-xl/);
    assert.match(player, /w-full/);
    assert.match(player, /max-h-\[60vh\]/);
    assert.match(player, /aspect-\[9\/16\] max-w-\[340px\]/);
    assert.match(player, /aspect-video/);
  });
});

describe("when the CDN link won't play", () => {
  it("tries once through the site's own download route, then falls back to the cover image", () => {
    assert.match(videoTag, /onError=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\}/);
    assert.match(videoTag, /src=\{attempt === 0 \? src : fallbackSrc\}/);
    assert.match(player, /if \(attempt >= 2\)/);
    assert.match(card, /fallbackSrc=\{videoHref\}/, "the fallback is the same /api/download link the button uses");
  });

  it("never replaces or hides the download buttons", () => {
    const playerAt = card.indexOf("<VideoPreview");
    const buttonsAt = card.indexOf("<DownloadButton", card.indexOf("{isCarousel ? ("));
    assert.ok(playerAt > 0 && buttonsAt > playerAt, "player above, buttons below");
    // The buttons don't depend on the player at all.
    const buttons = card.slice(card.indexOf("{isCarousel ? ("));
    assert.doesNotMatch(buttons, /showPlayer/);
  });
});

describe("where the player appears", () => {
  it("only for a single video, never on the audio page, never for IP-bound links", () => {
    assert.match(
      card,
      /const showPlayer =\s+focus !== "cover" && !isCarousel && !isPhoto && !audioOnly && Boolean\(result\.videoUrl\) && !isIpBoundHost\(result\.videoUrl\);/
    );
    assert.match(card, /\{!isCarousel && !showPlayer && focus !== "cover" && \(/, "the small thumbnail stays wherever there is no player");
  });

  it("YouTube's links are bound to the scraper's IP, so they get no inline player", () => {
    assert.equal(isIpBoundHost("https://rr3---sn-abc.googlevideo.com/videoplayback?id=1"), true);
    assert.equal(isIpBoundHost("https://instagram.fdel1-1.fna.fbcdn.net/o1/v/t2/x.mp4"), false);
    assert.equal(isIpBoundHost("not a url"), false);
  });

  it("the download route uses the same list", () => {
    assert.deepEqual(IP_BOUND_HOSTS, ["googlevideo.com"]);
    assert.match(route, /isIpBoundHost\(target\)/);
    assert.doesNotMatch(route, /const IP_BOUND_HOSTS/, "one list, not two");
  });
});
