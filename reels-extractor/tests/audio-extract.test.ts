/**
 * Audio from videos with no separate audio track (every YouTube video, and posts whose sound only lives inside
 * the MP4): the audio button points at the video with `extract=1`, and the scraper takes the AAC track out.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildAudioHref, buildDownloadHref } from "../lib/download.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const query = (href: string) => new URLSearchParams(href.split("?")[1]);
const VIDEO = "https://rr1---sn-x.googlevideo.com/videoplayback?id=1";
const AUDIO = "https://x.cdninstagram.com/a.m4a";

describe("which audio link a video gets", () => {
  it("its own audio track when it has one, untouched and without extract", () => {
    const href = buildAudioHref({ id: "r", videoUrl: VIDEO, audioUrl: AUDIO, audioExt: "webm" }, "https://youtu.be/r")!;
    const q = query(href);
    assert.equal(q.get("url"), AUDIO);
    assert.equal(q.get("ext"), "webm");
    assert.equal(q.get("kind"), "audio");
    assert.equal(q.get("extract"), null);
  });

  it("otherwise the video itself, with extract=1, saved as M4A", () => {
    const q = query(buildAudioHref({ id: "yt", videoUrl: VIDEO }, "https://youtu.be/yt")!);
    assert.equal(q.get("url"), VIDEO);
    assert.equal(q.get("kind"), "audio");
    assert.equal(q.get("ext"), "m4a");
    assert.equal(q.get("extract"), "1");
    assert.equal(q.get("src"), "https://youtu.be/yt", "the post link lets the scraper re-resolve an expired video");
  });

  it("a photo has no sound to offer", () => {
    assert.equal(buildAudioHref({ id: "p", videoUrl: "https://x.fbcdn.net/p.jpg", kind: "image" }), null);
  });

  it("extract only ever applies to audio", () => {
    assert.equal(query(buildDownloadHref({ url: VIDEO, id: "v", extract: true })).get("extract"), null);
  });
});

describe("the download route", () => {
  const route = source("app/api/download/route.ts");

  it("only the scraper can extract: the direct CDN attempt is skipped", () => {
    assert.match(route, /const extract = requestedKind === "audio" && searchParams\.get\("extract"\) === "1"/);
    assert.match(route, /if \(!media\.extract && !media\.clip && media\.kind !== "gif" && !isIpBound\(target\)\)/);
  });

  it("passes extract on to both scraper endpoints, without a byte range, and always names the file .m4a", () => {
    assert.equal(route.match(/if \(media\.extract\) params\.set\("extract", "1"\)/g)?.length, 2);
    assert.match(route, /media\.extract \|\| media\.clip \|\| media\.kind === "gif" \? null : range/);
    assert.match(route, /const audioExt = !extract && isAudioExtension\(requestedExt\) \? requestedExt : "m4a"/);
  });
});

describe("the result cards use it", () => {
  it("single result and carousel slides both build the audio link the same way", () => {
    assert.match(source("app/[locale]/components/PreviewCard.tsx"), /isPhoto \? null : buildAudioHref\(result, result\.sourceUrl\)/);
    assert.match(source("app/[locale]/components/ItemsSlider.tsx"), /const audioHref = \(item: ReelItem\) => buildAudioHref\(item\)/);
  });
});
