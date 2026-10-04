// Text and code samples of the public API documentation page (/free-video-api). English only: it is written
// for developers. Kept free of runtime imports so tests can read it with plain Node.

export const API_DOCS_PATH = "/free-video-api";
export const API_ENDPOINT = "https://www.savereelsfast.com/api/public/extract";

export const API_DOCS = {
  metaTitle: "Free Video Extractor API - Social Media Download API",
  metaDescription:
    "Free social media download API: get the video URL, thumbnail, title and duration of public TikTok, Facebook, X, Reddit and more. No key, 50 requests/day.",
  h1: "Free Video Extractor API",
  lead:
    "One GET request turns a public TikTok, Facebook, X, Pinterest, Reddit, Threads, Snapchat or LinkedIn post into clean JSON: video URL, thumbnail, title, author and duration. Free, no sign-up, no API key.",
  breadcrumb: "Free Video API",

  sections: [
    {
      heading: "What the API Does",
      paragraphs: [
        "SaveReelsFast's free video extractor API is the same engine that runs the downloader on this site, opened up for developers. Send it the link of a public social media post and it answers with the post's direct video file URL, its cover image, caption, author, duration and, where the platform has one, a separate audio track. It is a simple way to add a social media download feature, a link preview or a media archive tool to your own app without maintaining scrapers for eight different platforms.",
        "There is nothing to install and no account to create. It is a plain HTTPS endpoint that returns JSON, so it works from any language that can make a web request: Node.js, Python, PHP, Go, Ruby or a shell script with curl.",
      ],
    },
    {
      heading: "Quickstart",
      paragraphs: [
        "Make a GET request to the endpoint below with the post's link in the url query parameter, URL-encoded. That's the whole integration. A successful answer has success set to true and the media details in data; a failed one has success set to false and an error object with a stable code and a readable message.",
        "Call the API from your server, not from a browser: it sends no CORS headers, so web pages on other sites can't call it directly. Cache the answers you get, because the same post gives the same result for a while, and every cached answer saves one of your daily requests.",
      ],
    },
    {
      heading: "Supported Platforms",
      paragraphs: [
        "The public API covers TikTok, Facebook (videos, Reels and fb.watch links), X (Twitter), Pinterest (video pins and pin.it links), Reddit (posts, share links and v.redd.it), Threads, Snapchat Spotlight and LinkedIn. Only public posts can be read: anything that needs a login, such as private accounts, friends-only posts or private groups, returns PRIVATE_CONTENT.",
        "Instagram and YouTube are not part of the free API at the moment. Looking them up costs this site paid proxy traffic, which is reserved for visitors of the website. Links from them return UNSUPPORTED_PLATFORM, so you can handle them cleanly instead of guessing.",
      ],
    },
    {
      heading: "Rate Limits",
      paragraphs: [
        "Each IP address can make 50 requests per day, and no more than 20 in any one minute, with no key needed. Every answer carries X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset headers (the reset is a Unix timestamp in seconds), and a 429 answer adds a Retry-After header telling you how many seconds to wait.",
        "Optional free API keys with a higher daily allowance are planned; until then, the per-IP limit applies to everyone. If you need more for a real project, contact us through the site and tell us what you are building.",
      ],
    },
    {
      heading: "Using the Video URL",
      paragraphs: [
        "video_url is the platform's own CDN link to the file, not a copy on our servers. These links are signed and usually expire after a few hours, so fetch the file soon after the lookup or look the post up again later instead of storing the link. Some CDNs, TikTok's for example, also check the Referer header and expect the platform's own site.",
        "audio_url is set only when the platform serves the sound as a separate file (Reddit often does, because its MP4s carry no sound). items lists every video or image when a post has several, such as a multi-video post on X; for a single video it is empty and the top-level fields describe it.",
      ],
    },
  ],

  responseHeading: "Response Format",
  successExample: `{
  "success": true,
  "data": {
    "platform": "tiktok",
    "id": "7212345678901234567",
    "title": "Morning routine in 30 seconds",
    "caption": "Morning routine in 30 seconds #routine #morning",
    "author": "someone",
    "duration": 31.2,
    "thumbnail": "https://p16-sign.tiktokcdn.com/...jpeg",
    "video_url": "https://v16-webapp.tiktok.com/...mp4",
    "audio_url": null,
    "quality": "1080p",
    "items": []
  }
}`,
  errorExample: `{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit reached: 50 requests per day per IP (and 20 per minute)."
  }
}`,

  errorsHeading: "Error Codes",
  errors: [
    { status: 400, code: "INVALID_URL", meaning: "The url parameter is missing or isn't a link to a single post." },
    { status: 403, code: "PRIVATE_CONTENT", meaning: "The post is private, age-restricted or needs a login." },
    { status: 404, code: "UNSUPPORTED_PLATFORM", meaning: "The link is from a platform the public API doesn't cover (including Instagram and YouTube for now)." },
    { status: 422, code: "NO_VIDEO", meaning: "The post exists but has no video, for example a text-only post." },
    { status: 429, code: "RATE_LIMITED", meaning: "Daily or per-minute limit reached. See Retry-After." },
    { status: 503, code: "EXTRACTION_FAILED", meaning: "The platform didn't answer in time or refused the lookup. Retry later." },
  ],

  examplesHeading: "Code Examples",
  examples: [
    {
      language: "JavaScript (Node.js 18+)",
      code: `const endpoint = "https://www.savereelsfast.com/api/public/extract";
const link = "https://www.tiktok.com/@user/video/7212345678901234567";

const res = await fetch(\`\${endpoint}?url=\${encodeURIComponent(link)}\`);
const body = await res.json();

if (body.success) {
  console.log(body.data.title, body.data.video_url);
} else {
  console.error(res.status, body.error.code, body.error.message);
}`,
    },
    {
      language: "Python (requests)",
      code: `import requests

ENDPOINT = "https://www.savereelsfast.com/api/public/extract"
link = "https://www.tiktok.com/@user/video/7212345678901234567"

res = requests.get(ENDPOINT, params={"url": link}, timeout=30)
body = res.json()

if body["success"]:
    print(body["data"]["title"], body["data"]["video_url"])
else:
    print(res.status_code, body["error"]["code"], body["error"]["message"])`,
    },
    {
      language: "PHP",
      code: `<?php
$endpoint = "https://www.savereelsfast.com/api/public/extract";
$link = "https://www.tiktok.com/@user/video/7212345678901234567";

$ch = curl_init($endpoint . "?url=" . urlencode($link));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
$body = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($body["success"]) {
    echo $body["data"]["title"] . " " . $body["data"]["video_url"] . PHP_EOL;
} else {
    echo $status . " " . $body["error"]["code"] . ": " . $body["error"]["message"] . PHP_EOL;
}`,
    },
  ],

  faqHeading: "Frequently Asked Questions",
  faq: [
    {
      q: "What are the rate limits of the free video API?",
      a: "50 requests per day per IP address, and at most 20 per minute, with no API key. Each answer reports what's left in the X-RateLimit headers, and a 429 answer says how long to wait in Retry-After.",
    },
    {
      q: "Which platforms does the API support?",
      a: "TikTok, Facebook, X (Twitter), Pinterest, Reddit, Threads, Snapchat Spotlight and LinkedIn, for public posts. Instagram and YouTube are not available on the free API for now and return UNSUPPORTED_PLATFORM.",
    },
    {
      q: "Is it legal to use a social media download API?",
      a: "The API only reads what a platform already shows publicly, without logging in. Whether you may download, store or republish a particular video depends on its copyright and on the platform's terms, and that responsibility is yours. Use it for content you own, have permission for, or may use under the law where you are.",
    },
    {
      q: "Does using the API break platform Terms of Service?",
      a: "Some platforms restrict automated access or downloading in their terms. Read the terms of each platform you work with and design your app to respect them, for example by only fetching media your users are entitled to. The API's own terms are the site's Terms of Service.",
    },
    {
      q: "Can I use the free API in a commercial product?",
      a: "Yes, within the free limits, as long as you don't resell the API itself or present it as your own service, and you respect creators' rights. A link back to SaveReelsFast in your docs or about page is appreciated. For higher volume, contact us.",
    },
    {
      q: "Do I need an API key?",
      a: "No. The free tier works without one, limited per IP. Optional free keys with a higher daily allowance are planned; they will be announced on this page.",
    },
  ],
} as const;
