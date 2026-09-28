/**
 * Instagram photos (a single photo, or photo slides of a carousel): links, file names, the two API routes,
 * the result card and the words for them in every language.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildDownloadHref, downloadFilename, isImageExtension } from "../lib/download.ts";
import { locales } from "../lib/i18n-config.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`));

describe("photo download links and file names", () => {
  it("a photo link says kind=image and keeps its extension", () => {
    const href = buildDownloadHref({ url: "https://x.fbcdn.net/p.jpg", id: "abc", kind: "image", ext: "jpg" });
    const params = new URL(href, "https://site").searchParams;
    assert.equal(params.get("kind"), "image");
    assert.equal(params.get("ext"), "jpg");
  });

  it("a video link still carries no kind at all", () => {
    const params = new URL(buildDownloadHref({ url: "https://x.fbcdn.net/v.mp4", id: "abc" }), "https://site").searchParams;
    assert.equal(params.get("kind"), null);
  });

  it("photos are saved as .jpg (or their own .webp/.png), videos as .mp4, audio as its container", () => {
    assert.equal(downloadFilename("abc", "image", "jpg"), "savereelsfast-abc.jpg");
    assert.equal(downloadFilename("abc", "image", "webp"), "savereelsfast-abc.webp");
    assert.equal(downloadFilename("abc", "image", "heic"), "savereelsfast-abc.jpg");
    assert.equal(downloadFilename("abc", "image"), "savereelsfast-abc.jpg");
    assert.equal(downloadFilename("abc"), "savereelsfast-abc.mp4");
    assert.equal(downloadFilename("abc", "audio"), "savereelsfast-abc.m4a");
    assert.equal(downloadFilename("abc", "audio", "webm"), "savereelsfast-abc.webm");
  });

  it("knows which picture types it serves", () => {
    for (const ext of ["jpg", "webp", "png"]) assert.ok(isImageExtension(ext), ext);
    for (const ext of ["jpeg", "gif", "mp4", "../x", 5]) assert.ok(!isImageExtension(ext), String(ext));
  });
});

describe("the API routes", () => {
  const extract = source("app/api/extract/route.ts");
  const download = source("app/api/download/route.ts");

  it("/api/extract asks the scraper for photos and maps kind=image items", () => {
    assert.match(extract, /\/extract\?url=\$\{encodeURIComponent\(reelUrl\)\}&images=1/);
    assert.match(extract, /if \(raw\.kind !== "image"\) return null;/);
    // A photo's URL must pass the same CDN allow-list as every video.
    assert.match(extract, /const url = toSafeMediaUrl\(raw\.imageUrl\);/);
  });

  it("/api/download accepts kind=image, and only picture types for it", () => {
    assert.match(download, /requestedKind === "image"/);
    assert.match(download, /image: \["image\/jpeg", "image\/webp", "image\/png", "application\/octet-stream"\]/);
    assert.match(download, /video: \["video\/", "application\/octet-stream"\]/, "a video request still refuses a picture");
  });
});

describe("the result card", () => {
  const card = source("app/[locale]/components/PreviewCard.tsx");
  const slider = source("app/[locale]/components/ItemsSlider.tsx");

  it("a single photo gets its own heading, a photo button and a photo-shaped preview", () => {
    assert.match(card, /allPhotos \? dict\.photoTitle : dict\.title/);
    assert.match(card, /items\.every\(\(item\) => item\.kind === "image"\)/, "a carousel of photos only is a photo post too");
    assert.match(card, /PLACEHOLDER_TITLE = \/\^\(Video\|Post\) by \[\\w\.\]\+\$\//, "yt-dlp's 'Video by x' is not shown as a caption");
    assert.match(card, /dict\.downloadPhoto\.replaceAll\("\{format\}"/);
    assert.match(card, /kind: "image" as const, ext: result\.imageExt/);
  });

  it("a carousel downloads each photo slide as a photo and counts photos and videos honestly", () => {
    assert.match(slider, /kind: "image", ext: item\.imageExt/);
    assert.match(slider, /photos === 0 \? dict\.postItems : photos === items\.length \? dict\.postPhotos : dict\.postMixed/);
  });
});

describe("words for photos, in every language", () => {
  for (const locale of locales) {
    it(locale, () => {
      const p = messages(locale).preview;
      for (const key of ["photoTitle", "downloadPhoto", "postPhotos", "postMixed", "itemPhotoTitle"]) {
        assert.ok(typeof p[key] === "string" && p[key].trim().length > 2, `${locale}.preview.${key}`);
      }
      assert.match(p.downloadPhoto, /\{format\}/);
      for (const key of ["postPhotos", "postMixed", "itemPhotoTitle"]) assert.match(p[key], /\{n\}/, `${locale}.${key}`);
      assert.notEqual(p.postPhotos, p.postItems, `${locale}: photos and videos are counted differently`);
    });
  }
});
