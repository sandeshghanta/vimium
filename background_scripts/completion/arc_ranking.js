// Arc-style ranking for the omni Vomnibar: one score for every row, a "web search" row that ranks
// among them, per-category caps, and Arc's same-title-same-site de-duplication.
//
// Arc does not publish its Command Bar algorithm. A reverse-engineering of Arc 1.17x
// (github.com/MartinPTielemans/ilo/issues/1396) found the signals (fuzzy match quality and where
// it matches, the last switch times of each tab with a boost for very recent ones, title+host
// de-dup for web apps, de-ranking the current page) but not the weights, which live in a CoreML
// model. The weights below are ours, in the spirit of the Arc clones (Aero, yarc, arbalete):
//
//   score = base(match tier) + kind bonus + recency + frequency + word relevancy
//
//   match tier   prefix:     the title starts with the query, or a site's front page does
//                            (a deep URL like youtube.com/watch?... only counts as wordStart) 5
//                wordStart:  every query term starts a word in the title or URL             3.5
//                contains:   anything else that matched                                     2
//   kind bonus   tab 0.6, bookmark 0.4, domain 0.3, history 0
//   recency      up to 0.5 (tabs: how recently you switched to it; history: last visit,
//                halving every 3 days)
//   frequency    up to 0.4, history only (visits, typed visits count 3x)
//   word score   up to 0.3, Vimium's own wordRelevancy
//
// The web-search row has a fixed SEARCH_SCORE (4.2): every prefix match goes above it, a
// word-start match only with enough recency/frequency, a mid-word match never. So "you" puts
// YouTube first, and "best hiking boots" puts the search first unless you visited such a page
// lately.
//
// Results pages of earlier searches show as "past search" rows (the query text, once each), capped
// at 2 and always just under the web-search row. Sign-in/SSO hops never show from history.
//
// This module is pure (no chrome.* calls) so scale/test_arc_ranking.mjs can run it under Node.

import {
  cleanTitle,
  isJunkPage,
  pageKey,
  searchResultsQuery,
  titleHostKey,
} from "./page_identity.js";

export const SEARCH_SCORE = 4.2;
const BASE = { prefix: 5, wordStart: 3.5, contains: 2 };
const KIND_BONUS = { tab: 0.6, bookmark: 0.4, domain: 0.3, history: 0, pastSearch: 0 };
// Most rows per kind. "domain" rows count as history.
export const CAPS = { tab: 3, bookmark: 2, history: 4, pastSearch: 2 };
export const MAX_ROWS = 8;
const DAY = 24 * 60 * 60 * 1000;

function bareUrl(url) {
  return (url ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\/(www\.)?/i, "").toLowerCase();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFrontPage(bare) {
  return !/[/?#]./.test(bare.replace(/\/+$/, ""));
}

export function matchTier(query, title, url) {
  const q = query.trim().toLowerCase();
  const t = cleanTitle(title).toLowerCase();
  const u = bareUrl(url);
  // A URL prefix only counts for a front page, or once the query itself reaches into the path.
  const urlPrefix = u.startsWith(q) && (isFrontPage(u) || /[/?#]/.test(q));
  if (q && (t.startsWith(q) || urlPrefix)) return "prefix";
  const terms = q.split(/\s+/).filter(Boolean);
  const startsWord = (term) => {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}`, "i");
    return re.test(t) || re.test(u);
  };
  if (terms.length && terms.every(startsWord)) return "wordStart";
  return "contains";
}

// 1 now, 0.5 after 3 days, 0.25 after 6, ...
export function visitRecency(lastVisitTime, now) {
  if (!lastVisitTime) return 0;
  return Math.pow(0.5, Math.max(0, now - lastVisitTime) / (3 * DAY));
}

// 0..1; about 50 weighted visits saturate it.
export function visitFrequency(visitCount = 0, typedCount = 0) {
  return Math.min(1, Math.log1p(visitCount + 3 * typedCount) / Math.log1p(50));
}

// A row is { kind: "tab"|"bookmark"|"history"|"domain", url, title, wordRelevancy (0..1),
// tabRecency (0..1, tabs), lastVisitTime, visitCount, typedCount (history), isCurrentTab }.
export function scoreRow(query, row, now) {
  let score = BASE[matchTier(query, row.title, row.url)] + (KIND_BONUS[row.kind] ?? 0);
  if (row.kind === "tab") {
    score += 0.5 * (row.tabRecency ?? 0);
  } else if (row.kind === "history" || row.kind === "domain" || row.kind === "pastSearch") {
    score += 0.5 * visitRecency(row.lastVisitTime, now);
    score += 0.4 * visitFrequency(row.visitCount, row.typedCount);
  }
  score += 0.3 * Math.min(1, row.wordRelevancy ?? 0);
  // Arc's derankCurrentItemURL: the page you are on is the least useful suggestion.
  if (row.isCurrentTab) score -= 3;
  // Past searches complete the query, so they sit under the live search row, never above it.
  if (row.kind === "pastSearch") score = Math.min(score, SEARCH_SCORE - 0.01);
  return score;
}

// Picks and orders the rows to show. `rows` may contain anything with { kind, url, title, ... };
// rows with kind "search", "golink" or "url" (the typed text as a URL) must carry their own
// `score`. Returns the chosen rows, best first, each with `score` set. The search row always gets a
// slot, and open tabs are never hidden by de-dup (two tabs can share a title).
export function arcRank(query, rows, now = Date.now()) {
  // A matching open tab makes the "domain" row (site root from history) redundant, and so does
  // a history row for that same front page (which has a title).
  const hasTab = rows.some((r) => r.kind === "tab");
  const historyUrls = new Set(
    rows.filter((r) => r.kind === "history").map((r) => bareUrl(r.url).replace(/\/+$/, "")),
  );
  const normQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  const candidates = rows.filter((r) => {
    if (r.kind === "domain" && (hasTab || historyUrls.has(bareUrl(r.url).replace(/\/+$/, "")))) {
      return false;
    }
    if ((r.kind === "history" || r.kind === "domain") && isJunkPage(r.url, r.title)) return false;
    if (r.kind === "history") {
      // A results page from an earlier search shows as that search's text, once ("past search").
      // The one for exactly what is typed is dropped: the web-search row already does that.
      const q = searchResultsQuery(r.url);
      if (q != null) {
        const nq = q.toLowerCase().replace(/\s+/g, " ");
        if (nq === normQuery) return false;
        // It matched through the results URL's parameters, not the search text: noise.
        if (!normQuery.split(" ").every((t) => nq.includes(t))) return false;
        r.kind = "pastSearch";
        r.title = q;
      }
    }
    return true;
  });
  for (const r of candidates) {
    if (r.score == null) r.score = scoreRow(query, r, now);
  }
  // Stable for equal scores: tabs, bookmarks, history (the order rows arrive in is not stable).
  const kindOrder = {
    url: -1,
    golink: 0,
    tab: 1,
    bookmark: 2,
    search: 3,
    domain: 4,
    history: 5,
    pastSearch: 6,
  };
  candidates.sort((a, b) =>
    (b.score - a.score) || (kindOrder[a.kind] - kindOrder[b.kind]) ||
    (bareUrl(a.url).length - bareUrl(b.url).length)
  );

  const seen = new Set();
  const perKind = {};
  const out = [];
  const hasSearch = candidates.some((r) => r.kind === "search");
  let searchPlaced = false;
  for (const r of candidates) {
    // Keep one slot free for the search row until it is placed.
    const free = MAX_ROWS - out.length - (hasSearch && !searchPlaced ? 1 : 0);
    if (r.kind !== "search" && free <= 0) continue;
    const capKind = r.kind === "domain" ? "history" : r.kind;
    if (CAPS[capKind] != null && (perKind[capKind] ?? 0) >= CAPS[capKind]) continue;
    if (r.kind !== "search" && r.kind !== "golink") {
      const keys = r.kind === "pastSearch"
        ? ["search\n" + r.title.toLowerCase().replace(/\s+/g, " ")]
        : [bareUrl(r.url).replace(/[/#?]+$/, ""), pageKey(r.url, r.title),
          titleHostKey(r.url, r.title)].filter(Boolean);
      if (r.kind !== "tab" && keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
    }
    if (r.kind === "search") searchPlaced = true;
    perKind[capKind] = (perKind[capKind] ?? 0) + 1;
    out.push(r);
  }
  return out;
}

// "go/<name>" (one word after go/) -> the go-link URL, or null.
export function goLinkUrl(query, template) {
  const m = /^go\/(\S+)$/i.exec(query.trim());
  if (!m || !template) return null;
  return template.replace("%s", m[1]);
}
