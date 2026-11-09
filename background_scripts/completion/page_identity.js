// scale: decides when two Vomnibar suggestions are "the same page", so only the best-ranked one
// is shown. Two layers:
//
// 1. Ignored query parameters: tracking junk everywhere, plus per-site parameters that never
//    change which page you're on. These are dropped before comparing.
// 2. Title rule, only for the sites in TITLE_RULE_HOSTS: same origin + path + title means the same
//    page whatever the query string. Off by default because tools with a fixed title (e.g. a
//    "Dashboard" with ?filter=) would wrongly merge.
//
// The #fragment is always ignored (RFC 3986 §3.5: it's resolved by the browser, not the server).
// The title is always part of the key, so hash-routed views with distinct titles (Gmail threads)
// and searches (?q=, whose results title carries the query) stay separate.

// Parameter names ignored on every site. Entries ending in "*" are prefixes.
export const IGNORED_PARAMS = [
  "utm_*", // Google Analytics campaign tags
  "fbclid", // Facebook
  "gclid", // Google Ads
  "gclsrc",
  "dclid", // DoubleClick
  "gbraid", // Google Ads (iOS)
  "wbraid",
  "msclkid", // Microsoft Ads
  "yclid", // Yandex
  "twclid", // X/Twitter
  "li_fat_id", // LinkedIn
  "igshid", // Instagram
  "mc_cid", // Mailchimp
  "mc_eid",
  "_hsenc", // HubSpot
  "_hsmi",
  "mkt_tok", // Marketo
  "_ga", // Google Analytics cross-domain
  "_gl",
  "ref_src", // X/Twitter
  "ref_url",
];

// Extra parameter names ignored per site. A key matches the host and its subdomains.
export const SITE_IGNORED_PARAMS = {
  "claude.ai": [
    "via", // where the link was clicked from, e.g. via=auto_preview
    "sk", // artifact share key: needed to share a link, same page for you
  ],
};

// Sites where same origin + path + title is the same page, whatever the query string.
export const TITLE_RULE_HOSTS = [
  "claude.ai",
];

function hostMatches(hostname, siteHost) {
  return hostname === siteHost || hostname.endsWith("." + siteHost);
}

function isIgnoredParam(name, siteParams) {
  const lower = name.toLowerCase();
  const matches = (p) => p.endsWith("*") ? lower.startsWith(p.slice(0, -1)) : lower === p;
  return IGNORED_PARAMS.some(matches) || siteParams.some(matches);
}

// The key under which suggestions are de-duplicated. Returns null for URLs that don't parse, or
// that aren't http(s), so the caller falls back to exact-URL de-duplication.
export function pageKey(url, title) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const hostname = u.hostname.toLowerCase();
  // Same as Chrome's own omnibox de-duplication: http vs https and a leading www. don't matter.
  const host = hostname.replace(/^www\./, "") + (u.port ? ":" + u.port : "");
  let query = "";
  if (!TITLE_RULE_HOSTS.some((h) => hostMatches(hostname, h))) {
    const siteParams = Object.entries(SITE_IGNORED_PARAMS)
      .filter(([h]) => hostMatches(hostname, h))
      .flatMap(([, params]) => params);
    const kept = [...u.searchParams]
      .filter(([name]) => !isIgnoredParam(name, siteParams))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    query = new URLSearchParams(kept).toString();
  }
  return `${host}${u.pathname}${query ? "?" + query : ""}\n${title ?? ""}`;
}
