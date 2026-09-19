/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.cdninstagram.com" },
      { protocol: "https", hostname: "**.fbcdn.net" },
    ],
  },
  async redirects() {
    // "twitter" is the slug people search for; keep the old id-based URL working.
    return [
      { source: "/downloader/x", destination: "/downloader/twitter", permanent: true },
      { source: "/:locale(es|pt)/downloader/x", destination: "/:locale/downloader/twitter", permanent: true },
    ];
  },
  async headers() {
    return [
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
