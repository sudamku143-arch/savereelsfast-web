/**
 * Tell Bing (and every other IndexNow engine: Yandex, Seznam, Naver...) about our pages, so they don't wait
 * to discover the site on their own. Bing had indexed none of it.
 *
 *   npm run indexnow                 every URL in the live sitemap
 *   npm run indexnow -- <url> ...    just these (after changing a page)
 *
 * The key is public by design: IndexNow checks that https://www.savereelsfast.com/<key>.txt contains it,
 * which proves the submission comes from whoever controls the site.
 */
const HOST = "www.savereelsfast.com";
const KEY = "6f9836d5ef1840d5b295820cdb9a7b43";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS = 10_000; // IndexNow's per-request limit

async function sitemapUrls() {
  const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
}

const given = process.argv.slice(2);
const urls = (given.length ? given : await sitemapUrls()).filter((u) => new URL(u).host === HOST);
if (!urls.length) {
  console.error("No URLs on", HOST, "to submit.");
  process.exit(1);
}

const keyFile = await fetch(`https://${HOST}/${KEY}.txt`);
if (!keyFile.ok || (await keyFile.text()).trim() !== KEY) {
  console.error(`The key file https://${HOST}/${KEY}.txt isn't live yet (deploy first).`);
  process.exit(1);
}

for (let i = 0; i < urls.length; i += MAX_URLS) {
  const batch = urls.slice(i, i + MAX_URLS);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: batch }),
  });
  // 200 = accepted, 202 = accepted, key check pending. Anything else is an error worth reading.
  console.log(`IndexNow: ${batch.length} URLs -> HTTP ${res.status} ${res.statusText}`, res.ok ? "" : await res.text());
  if (!res.ok) process.exitCode = 1;
}
