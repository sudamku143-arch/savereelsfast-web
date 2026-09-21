/** @type {import('next').NextConfig} */

// Sent on every response. What each one defends against:
//  - X-Frame-Options / frame-ancestors: clickjacking (nobody may embed this site in a frame).
//  - X-Content-Type-Options: stops browsers guessing a file's type, so a download can never be run as a script.
//  - Referrer-Policy: other sites (ad networks, video CDNs) only ever see our origin, never full URLs.
//  - Strict-Transport-Security: browsers refuse to talk to the site over plain HTTP.
//  - Permissions-Policy: switches off browser features the site has no use for.
//  - COOP: isolates our window from pages that open us. "allow-popups" keeps ad click-throughs working.
//  - CSP: no <base> hijacking, no plugins, forms can only post back to us. script-src is deliberately
//    left open, because ad networks load scripts from many hosts; see the notes in the security review.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework (and version) to scanners.
  poweredByHeader: false,
  images: {
    // Every <Image> in the app is already `unoptimized`, so the /_next/image optimizer is never used.
    // Turning it off removes its attack surface (several Next.js DoS advisories are about it).
    unoptimized: true,
  },
  async redirects() {
    // Platform pages used to live at /downloader/<name>. They now live at /<name>-video-downloader; every
    // old address (in every language) is redirected permanently, so old links and search results still work.
    // tests/sitemap.test.ts checks these tables against lib/landing.ts.
    const LANGUAGES = "es|pt|hi|bn|te|ta|mr|id|fr|ar";
    const LEGACY = {
      instagram: "instagram-video-downloader",
      youtube: "youtube-video-downloader",
      facebook: "facebook-video-downloader",
      threads: "threads-video-downloader",
      twitter: "twitter-x-video-downloader",
      x: "twitter-x-video-downloader",
      pinterest: "pinterest-video-downloader",
      tiktok: "tiktok-video-downloader",
      reddit: "reddit-video-downloader",
      snapchat: "snapchat-video-downloader",
      linkedin: "linkedin-video-downloader",
    };
    return Object.entries(LEGACY).flatMap(([old, current]) => [
      { source: `/downloader/${old}`, destination: `/${current}`, permanent: true },
      { source: `/:locale(${LANGUAGES})/downloader/${old}`, destination: `/:locale/${current}`, permanent: true },
    ]);
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // The API is not for search engines.
        source: "/api/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        // Always revalidate the service worker so updates reach users promptly.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
module.exports.SECURITY_HEADERS = SECURITY_HEADERS;
