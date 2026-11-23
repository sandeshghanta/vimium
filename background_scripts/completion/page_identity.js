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

// Arc's "dedupByTitleAndHostList": on web apps that give many URLs one title (every view of a
// Notion page, every Claude artifact version, every Google Maps pan), rows with the same title on
// the same site are one row, whatever the path. Each entry is [group name, host, path prefix];
// a host matches itself and its subdomains. Only for these sites, because elsewhere one fixed
// title (e.g. "Dashboard") can cover genuinely different pages.
export const TITLE_HOST_GROUPS = [
  ["claude", "claude.ai", "/"],
  ["claude", "claudeusercontent.com", "/"], // artifact frames, one subdomain per artifact
  ["notion", "notion.so", "/"],
  ["notion", "notion.com", "/"],
  ["figma", "figma.com", "/"],
  ["linear", "linear.app", "/"],
  ["github", "github.com", "/"],
  ["slack", "slack.com", "/"],
  ["gcal", "calendar.google.com", "/"],
  ["gmaps", "google.com", "/maps"],
  ["gmaps", "maps.google.com", "/"],
];

// Strips the parts of a title that change without the page changing: unread counters
// ("(3) WhatsApp", "(9+) Notion"), Slack's "- 24 new items", and a trailing " - Claude".
export function cleanTitle(title) {
  return (title ?? "")
    .replace(/^\(\d+\+?\)\s*/, "")
    .replace(/\s+-\s+\d+\+? new items?\b/i, "")
    .replace(/\s+[-|]\s+Claude$/, "")
    .trim();
}

// For a search engine results page in history, the query it searched for; otherwise null.
export function searchResultsQuery(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const isGoogle = /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === "/search";
  const isBing = /(^|\.)bing\.com$/i.test(u.hostname) && u.pathname === "/search";
  const isDdg = /(^|\.)duckduckgo\.com$/i.test(u.hostname);
  if (!(isGoogle || isBing || isDdg)) return null;
  const q = u.searchParams.get("q");
  return q && q.trim() ? q.trim() : null;
}

// The title+site key for TITLE_HOST_GROUPS sites, or null for other sites or untitled pages.
export function titleHostKey(url, title) {
  const t = cleanTitle(title).toLowerCase();
  if (!t) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const hostname = u.hostname.toLowerCase();
  const group = TITLE_HOST_GROUPS.find(([, h, path]) =>
    hostMatches(hostname, h) && u.pathname.startsWith(path)
  );
  return group ? `${group[0]}\n${t}` : null;
}

// History entries never worth suggesting: sign-in, SSO and redirect hops, and malformed URLs a
// search engine produced from a go-link typed as a query ("…/go/x&sourceid=chrome").
const JUNK_HOSTS = ["accounts.google.com", "login.microsoftonline.com"];
const JUNK_PATH = /\/(oauth2?|sso|saml2?|signin|sign-in|login|logout|callback)(\/|$)/i;
const JUNK_TITLE = /^(sign ?in|signing in|log ?in|logging in|redirecting)\b|[-|] sign ?in$/i;

export function isJunkPage(url, title) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const hostname = u.hostname.toLowerCase();
  if (JUNK_HOSTS.some((h) => hostMatches(hostname, h))) return true;
  if (JUNK_PATH.test(u.pathname)) return true;
  if (u.pathname.includes("&sourceid=")) return true;
  return JUNK_TITLE.test(cleanTitle(title)) ||
    /signing in\.\.\.$/i.test(title ?? "");
}
