/**
 * The blog: every post in content/blog is valid (so a mistake in a new post stops the build instead of the live site),
 * the starter posts are the length that was asked for, their internal links point at real pages, and the Markdown
 * reader never lets a post inject markup or a dangerous link.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types; run from the reels-extractor folder)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { parseInline, parseMarkdown, safeHref } from "../lib/blog-markdown.ts";
import { LANDING_PLATFORMS, landingPath } from "../lib/landing.ts";

// lib/blog.ts imports its neighbour without a file extension (as the site build wants), which plain Node cannot
// resolve: run it from a copy that spells the extension out. It still reads content/blog from the project folder.
const dir = mkdtempSync(join(tmpdir(), "srf-blog-"));
for (const file of ["i18n-config", "landing", "blog"]) {
  writeFileSync(
    join(dir, `${file}.ts`),
    readFileSync(new URL(`../lib/${file}.ts`, import.meta.url), "utf8").replace(/from "\.\/([\w-]+)"/g, 'from "./$1.ts"')
  );
}
const { allPosts, getPost, getPosts, localesWithPosts, parseFrontmatter, readPost, relatedPosts, translationsOf } = (await import(
  pathToFileURL(join(dir, "blog.ts")).href
)) as typeof import("../lib/blog.ts");

const STARTERS = [
  "top-10-instagram-reels-ideas-2026",
  "youtube-shorts-vs-instagram-reels-for-creators",
  "download-social-media-videos-safely-and-legally",
  "best-video-formats-mp4-vs-webm-vs-mov",
  "grow-social-media-following-2026",
  // one or two per platform (see "each platform's own posts" below)
  "save-instagram-reels-offline",
  "save-youtube-shorts-offline",
  "save-facebook-videos-offline",
  "facebook-video-privacy-what-you-can-save",
  "threads-vs-x-content-strategy",
  "save-threads-videos",
  "repost-x-twitter-videos-legally",
  "pinterest-video-pins-guide",
  "save-pinterest-videos",
  "best-subreddits-for-video-content",
  "reddit-videos-no-sound-explained",
  "snapchat-spotlight-vs-stories",
  "save-snapchat-spotlight-videos",
  "tiktok-trends-and-saving-favorite-videos",
];

describe("posts on disk", () => {
  const posts = allPosts();

  it("loads the starter posts in English", () => {
    for (const slug of STARTERS) assert.ok(getPost("en", slug), `missing ${slug}`);
    assert.ok(localesWithPosts().includes("en"));
  });

  it("every post has a real title, a search description under 160 characters and a title under 60", () => {
    for (const post of posts) {
      assert.ok(post.title.length > 10, post.slug);
      assert.ok(post.description.length >= 80 && post.description.length < 160, `${post.slug} description is ${post.description.length}`);
      assert.ok(post.metaTitle.length < 60, `${post.slug} meta title is ${post.metaTitle.length}`);
    }
  });

  it("slugs, titles and descriptions are unique within a language", () => {
    for (const locale of localesWithPosts()) {
      const own = getPosts(locale);
      for (const key of ["slug", "title", "description"] as const) {
        assert.equal(new Set(own.map((p) => p[key])).size, own.length, `${locale}: duplicate ${key}`);
      }
    }
  });

  it("every post written so far is 600-800 words with plenty of headings and no second h1", () => {
    for (const slug of STARTERS) {
      const post = getPost("en", slug)!;
      assert.ok(post.wordCount >= 600 && post.wordCount <= 800, `${slug} is ${post.wordCount} words`);
      const blocks = parseMarkdown(post.body);
      const h2 = blocks.filter((b) => b.type === "heading" && b.level === 2).length;
      assert.ok(h2 >= 5, `${slug} has only ${h2} h2 headings`);
      assert.ok(!/^# /m.test(post.body), `${slug} has a # heading; the page title is the only h1`);
    }
  });

  it("newest first", () => {
    const dates = getPosts("en").map((p) => p.date);
    assert.deepEqual([...dates].sort().reverse(), dates);
  });

  it("every internal link in a post goes to a page that exists", () => {
    const valid = new Set(["/", "/privacy-policy", "/terms-of-service", "/dmca", "/disclaimer", "/contact", "/blog", ...LANDING_PLATFORMS.map(landingPath)]);
    for (const post of posts) {
      for (const slugged of allPosts().filter((p) => p.locale === post.locale)) valid.add(`/blog/${slugged.slug}`);
      for (const [, target] of post.body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        assert.ok(valid.has(target), `${post.slug} links to ${target}, which is not a page`);
      }
    }
  });

  it("each starter post links to the tool at least once, and not more than a handful of times", () => {
    for (const slug of STARTERS) {
      const links = [...getPost("en", slug)!.body.matchAll(/\]\((\/(?:[a-z-]+-downloader)?)\)/g)].length;
      assert.ok(links >= 1 && links <= 6, `${slug} links to the tool ${links} times`);
    }
  });

  it("a translation is the same slug in another language folder", () => {
    for (const post of posts) assert.ok(translationsOf(post.slug).includes(post.locale));
  });
});

describe("latest articles on the home page", () => {
  const component = readFileSync(new URL("../app/[locale]/components/LatestPosts.tsx", import.meta.url), "utf8");
  const cards = readFileSync(new URL("../app/[locale]/components/PostCards.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../app/[locale]/page.tsx", import.meta.url), "utf8");

  it("is on the home page and reads the posts from the blog folder, so a new post appears without a code change", () => {
    assert.match(home, /<LatestPosts locale=\{locale\} dict=\{dict\.blog\} \/>/);
    assert.match(component, /getPosts\(locale\)\.slice\(0, HOW_MANY\)/);
  });

  it("shows nothing in a language without a blog, so it can never link to a 404", () => {
    assert.match(component, /if \(posts\.length === 0\) return null;/);
    for (const locale of ["es", "hi", "fr", "ar"] as const) assert.equal(getPosts(locale).length, 0, `${locale} has no posts`);
  });

  it("shows at most three posts, newest first, and links each one and the blog index", () => {
    assert.match(component, /HOW_MANY = 3/);
    assert.match(cards, /localePath\(locale, blogPath\(post\.slug\)\)/);
    assert.match(component, /localePath\(locale, blogPath\(\)\)/);
  });
});

describe("posts and tool pages link to each other", () => {
  const ALL_TOOLS = LANDING_PLATFORMS;
  const starters = STARTERS.map((slug) => getPost("en", slug)!);

  it("every starter post declares the downloaders it is about, and its text links to each of them", () => {
    for (const post of starters) {
      assert.ok(post.tools.length >= 1, `${post.slug} declares no tools`);
      for (const tool of post.tools) {
        assert.ok(post.body.includes(`](${landingPath(tool)})`), `${post.slug} is about ${tool} but never links to ${landingPath(tool)}`);
      }
    }
  });

  it("the Instagram Reels post is about, and links to, the Instagram downloader", () => {
    const post = getPost("en", "top-10-instagram-reels-ideas-2026")!;
    assert.deepEqual(post.tools, ["instagram"]);
    assert.ok(post.body.includes("](/instagram-video-downloader)"));
  });

  it("every downloader page in English has at least one related article, and never more than three", () => {
    for (const tool of ALL_TOOLS) {
      const related = relatedPosts("en", tool);
      assert.ok(related.length >= 1 && related.length <= 3, `${tool} has ${related.length} related posts`);
      assert.equal(new Set(related.map((p) => p.slug)).size, related.length, `${tool} lists a post twice`);
    }
  });

  it("every downloader page has at least two articles written for it, not only general fallbacks", () => {
    for (const tool of ALL_TOOLS) {
      const dedicated = getPosts("en").filter((p) => p.tools.includes(tool) && !p.general);
      assert.ok(dedicated.length >= 2, `${tool} has only ${dedicated.length} dedicated posts: ${dedicated.map((p) => p.slug)}`);
      const shown = relatedPosts("en", tool);
      assert.ok(shown.slice(0, 2).every((p) => p.tools.includes(tool) && !p.general), `${tool}: the first two shown must be dedicated: ${shown.map((p) => p.slug)}`);
    }
  });

  it("posts mainly about the platform lead, then ones that mention it, then general ones", () => {
    const rank = (slug: string, tool: string) => {
      const post = getPost("en", slug)!;
      return post.tools[0] === tool ? 0 : post.tools.includes(tool) ? 1 : 2;
    };
    for (const tool of ALL_TOOLS) {
      const ranks = relatedPosts("en", tool).map((p) => rank(p.slug, tool));
      assert.deepEqual(ranks, [...ranks].sort(), `${tool}: ${ranks}`);
    }
    assert.equal(relatedPosts("en", "instagram")[0].tools[0], "instagram");
    assert.ok(relatedPosts("en", "instagram").map((p) => p.slug).includes("top-10-instagram-reels-ideas-2026"));
  });

  it("each platform's own posts are the ones the brief asked for", () => {
    const expected: Record<string, string[]> = {
      instagram: ["save-instagram-reels-offline", "top-10-instagram-reels-ideas-2026"],
      youtube: ["save-youtube-shorts-offline", "youtube-shorts-vs-instagram-reels-for-creators"],
      facebook: ["save-facebook-videos-offline", "facebook-video-privacy-what-you-can-save"],
      threads: ["threads-vs-x-content-strategy", "save-threads-videos"],
      x: ["repost-x-twitter-videos-legally", "threads-vs-x-content-strategy"],
      pinterest: ["pinterest-video-pins-guide", "save-pinterest-videos"],
      tiktok: ["tiktok-trends-and-saving-favorite-videos", "grow-social-media-following-2026"],
      reddit: ["best-subreddits-for-video-content", "reddit-videos-no-sound-explained"],
      snapchat: ["snapchat-spotlight-vs-stories", "save-snapchat-spotlight-videos"],
    };
    for (const [tool, slugs] of Object.entries(expected)) {
      const shown = relatedPosts("en", tool as (typeof ALL_TOOLS)[number]).map((p) => p.slug);
      for (const slug of slugs) assert.ok(shown.includes(slug), `${tool} should show ${slug}, shows ${shown}`);
    }
  });

  it("a language without a blog gets no related articles, so a tool page never links to English text", () => {
    for (const locale of ["es", "hi", "fr", "ar", "bn", "id"] as const) {
      for (const tool of ALL_TOOLS) assert.deepEqual(relatedPosts(locale, tool), [], `${locale}/${tool}`);
    }
  });

  it("the tool page and the post page render the links", () => {
    const toolPage = readFileSync(new URL("../app/[locale]/[platform]/page.tsx", import.meta.url), "utf8");
    assert.match(toolPage, /<RelatedPosts locale=\{locale\} platform=\{id\} dict=\{dict\.blog\} \/>/);
    const postPage = readFileSync(new URL("../app/[locale]/blog/[slug]/page.tsx", import.meta.url), "utf8");
    assert.match(postPage, /post\.tools\.map\(\(tool\) =>/);
    assert.match(postPage, /localePath\(locale, landingPath\(tool\)\)/);
  });

  it("an unknown or repeated downloader in a post's header stops the build", () => {
    const post = (extra: string) =>
      `---
title: A title
description: A description long enough to be a real one for the search results page.
date: 2026-09-21
language: en
${extra}
---

The body of the post is here and it is long enough to count as a body.`;
    assert.deepEqual(readPost(post("tools: instagram, x"), "en", "x")?.tools, ["instagram", "x"]);
    assert.equal(readPost(post("general: true"), "en", "x")?.general, true);
    assert.throws(() => readPost(post("tools: instagram, myspace"), "en", "x"), /"myspace", which is not a downloader/);
    assert.throws(() => readPost(post("tools: instagram, instagram"), "en", "x"), /same downloader twice/);
    assert.throws(() => readPost(post("general: maybe"), "en", "x"), /general must be true or false/);
  });
});

describe("post headers are checked", () => {
  const ok = "---\ntitle: A title\ndescription: A description long enough to be a real one for the search results page.\ndate: 2026-09-21\nlanguage: en\n---\n\nThe body of the post is here and it is long enough to count as a body.";

  it("reads a valid post", () => {
    const post = readPost(ok, "en", "a-title");
    assert.equal(post?.title, "A title");
    assert.equal(post?.date, "2026-09-21");
  });

  it("stops the build for each kind of mistake, naming the file", () => {
    assert.throws(() => readPost(ok.replace("title: A title\n", ""), "en", "x"), /missing "title"/);
    assert.throws(() => readPost(ok.replace("language: en", "language: es"), "en", "x"), /language is "es" but the file is in the "en" folder/);
    assert.throws(() => readPost(ok.replace("2026-09-21", "2026-13-40"), "en", "x"), /real date/);
    assert.throws(() => readPost(ok.replace("2026-09-21", "21/09/2026"), "en", "x"), /real date/);
    assert.throws(() => readPost(ok, "en", "Bad Slug"), /lowercase words/);
    assert.throws(() => readPost("no header at all\n\nbody body body body body body body body body body body", "en", "x"), /must start with a --- header/);
    assert.throws(() => readPost(ok.replace(/\n\nThe body.*/s, "\n\n"), "en", "x"), /no body/);
  });

  it("a draft is hidden, and quotes around header values are removed", () => {
    assert.equal(readPost(ok.replace("language: en", "language: en\ndraft: true"), "en", "x"), null);
    assert.equal(parseFrontmatter('---\ntitle: "Quoted: yes"\n---\nbody', "f").data.title, "Quoted: yes");
  });
});

describe("markdown reader", () => {
  it("reads headings, lists, quotes, rules and tables", () => {
    const blocks = parseMarkdown("## One\n\nText **bold** and *soft* and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n> quote\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "list", "list", "quote", "rule", "table"]);
    const lists = blocks.filter((b) => b.type === "list");
    assert.deepEqual(lists.map((l) => (l as { ordered: boolean }).ordered), [false, true]);
    const table = blocks.find((b) => b.type === "table") as { head: unknown[][]; rows: unknown[][][] };
    assert.equal(table.head.length, 2);
    assert.equal(table.rows.length, 1);
  });

  it("gives headings unique anchors and turns a single # into an h2", () => {
    const blocks = parseMarkdown("# Same\n\n## Same\n");
    const ids = blocks.map((b) => (b.type === "heading" ? b.id : ""));
    assert.deepEqual(ids, ["same", "same-2"]);
    assert.ok(blocks.every((b) => b.type === "heading" && b.level === 2));
  });

  it("keeps only safe links", () => {
    assert.equal(safeHref("/youtube-video-downloader"), "/youtube-video-downloader");
    assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://insecure.example", "//evil.example", "vbscript:x", " JaVaScRiPt:1"]) {
      assert.equal(safeHref(bad), null, bad);
    }
    const nodes = parseInline("[click](javascript:alert(1))");
    assert.ok(nodes.every((n) => n.type !== "link"), "a javascript: link must be reduced to plain text");
  });

  it("never turns text into markup: HTML in a post stays plain text", () => {
    const nodes = parseInline("<script>alert(1)</script> and <img src=x onerror=alert(1)>");
    assert.ok(nodes.every((n) => n.type === "text"));
    const [block] = parseMarkdown("<div onclick=alert(1)>hi</div>");
    assert.equal(block.type, "paragraph");
  });

  it("a page containing every kind of block reads without throwing, even when it is malformed", () => {
    for (const source of ["", "|", "| a |\n|---", "**unclosed", "[x](", "```\nunclosed code", "> ", "- ", "1. ", "###### too deep"]) {
      assert.doesNotThrow(() => parseMarkdown(source), JSON.stringify(source));
    }
  });
});
