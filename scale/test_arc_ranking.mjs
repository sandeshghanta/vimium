// Checks background_scripts/completion/arc_ranking.js with plain Node (no Deno, no browser):
//   node scale/test_arc_ranking.mjs
// The modules are copied into a temp folder marked "type": "module" so Node loads them as ESM.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../background_scripts/completion");
const tmp = mkdtempSync(join(tmpdir(), "arc-ranking-"));
writeFileSync(join(tmp, "package.json"), '{"type": "module"}');
for (const f of ["arc_ranking.js", "page_identity.js"]) copyFileSync(join(srcDir, f), join(tmp, f));
const { arcRank, goLinkUrl, SEARCH_SCORE } = await import(pathToFileURL(join(tmp, "arc_ranking.js")).href);

const NOW = Date.parse("2026-11-23T12:00:00Z");
const DAY = 864e5;
const search = () => ({ kind: "search", score: SEARCH_SCORE, url: "", title: "" });
const h = (url, title, { daysAgo = 1, visits = 3, typed = 0 } = {}) => ({
  kind: "history", url, title, lastVisitTime: NOW - daysAgo * DAY, visitCount: visits, typedCount: typed,
  wordRelevancy: 0.3,
});
const tab = (url, title, extra = {}) => ({ kind: "tab", url, title, tabRecency: 0.5, wordRelevancy: 0.3, ...extra });
const rank = (q, rows) => arcRank(q, [...rows, search()], NOW);
const kinds = (out) => out.map((r) => r.kind);
let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log("ok  " + name);
};

check("five 'Project Docs' rows on claude.ai collapse to the open tab", () => {
  const t = "Project Docs";
  const out = rank("Project Docs", [
    tab("https://claude.ai/artifact/aaa111?sk=key1#intro", t),
    h("https://claude.ai/artifact/bbb222", t),
    h("https://claude.ai/artifact/bbb222?sk=key2", t),
    h("https://claude.ai/artifact/aaa111", t),
    h("https://claude.ai/code/frame/ccc333#intro", t),
    h("https://ccc333.frame.claudeusercontent.com/", t),
    h("https://claude.ai/artifact/fork1", "Project Docs Fork"),
  ]);
  assert.deepEqual(kinds(out), ["tab", "history", "search"]);
  assert.equal(out[1].title, "Project Docs Fork");
});

check("'you' -> YouTube first, web search still offered", () => {
  const out = rank("you", [
    h("https://www.youtube.com/", "(1) YouTube", { visits: 100, typed: 10 }),
    h("https://www.youtube.com/watch?v=x", "Some video - YouTube", { visits: 1, daysAgo: 20 }),
    h("https://news.test/a", "Why you should sleep", { visits: 1, daysAgo: 10 }),
  ]);
  assert.equal(out[0].url, "https://www.youtube.com/");
  assert.ok(kinds(out).includes("search"));
});

check("'we' -> a web app's front page first (typed often)", () => {
  const out = rank("we", [
    h("https://web.chatapp.test/", "(3) ChatApp", { visits: 50, typed: 20 }),
    h("https://weather.test/", "Weather", { visits: 2, daysAgo: 25 }),
  ]);
  assert.equal(out[0].url, "https://web.chatapp.test/");
});

check("a phrase you never visited -> web search first", () => {
  const out = rank("best hiking boots", [
    h("https://news.test/x", "Reviews: the best hiking boots of the year", { visits: 1, daysAgo: 12 }),
  ]);
  assert.equal(out[0].kind, "search");
});

check("mid-word matches never beat the search row", () => {
  const out = rank("king", [tab("https://news.test/hiking", "Hiking news", { tabRecency: 1 })]);
  assert.equal(out[0].kind, "search");
});

check("an open tab whose title starts with the query beats history", () => {
  const out = rank("cale", [
    h("https://calendar.google.com/calendar/u/0/r/day", "Example - Calendar - Monday", { visits: 44, typed: 31 }),
    tab("https://calendar.google.com/calendar/u/0/r", "Example - Calendar - Friday"),
    { kind: "domain", url: "https://calendar.google.com", title: "", visitCount: 44 },
  ]);
  assert.equal(out[0].kind, "tab");
  assert.ok(!kinds(out).includes("domain"), "domain row dropped when a tab matches");
});

check("855 'Google Maps' rows -> one; distinct place titles stay", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(h(`https://www.google.com/maps/@37.${i},-122,${i}z`, "Google Maps"));
  rows.push(h("https://www.google.com/maps/place/Dublin", "Dublin - Google Maps"));
  const out = rank("maps", rows);
  assert.equal(out.filter((r) => r.title === "Google Maps").length, 1);
  assert.equal(out.filter((r) => r.title === "Dublin - Google Maps").length, 1);
});

check("sign-in / SSO pages are hidden from history (not from tabs)", () => {
  const out = rank("example", [
    h("https://example.okta.com/login/login.htm", "Example - Sign In", { visits: 66 }),
    h("https://example.okta.com/app/x/sso/saml", "Example - Signing in...", { visits: 55 }),
    h("https://accounts.google.com/v3/signin", "Sign in - Google Accounts", { visits: 60 }),
    h("https://golinks.example.test/go/wiki&sourceid=chrome&ie=UTF-8", "Example go/wiki"),
    h("https://example.okta.com/app/UserHome", "My Apps Dashboard | Example"),
    tab("https://example.okta.com/login/login.htm", "Example - Sign In"),
  ]);
  assert.deepEqual(out.map((r) => r.title).sort(),
    ["", "My Apps Dashboard | Example", "Example - Sign In"].sort());
});

check("caps: at most 3 tabs and 4 history rows", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(tab(`https://docs.test/t${i}`, `Docs tab ${i}`));
  for (let i = 0; i < 9; i++) rows.push(h(`https://docs.test/h${i}`, `Docs page ${i}`));
  const out = rank("docs", rows);
  assert.equal(out.filter((r) => r.kind === "tab").length, 3);
  assert.equal(out.filter((r) => r.kind === "history").length, 4);
  assert.ok(out.length <= 8);
  assert.ok(out.some((r) => r.kind === "search"), "search row keeps its slot");
});

check("the search row keeps a slot even when tabs, bookmarks and history fill the caps", () => {
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(tab(`https://docs.test/t${i}`, `Docs tab ${i}`));
  for (let i = 0; i < 2; i++) rows.push({ kind: "bookmark", url: `https://docs.test/b${i}`, title: `Docs bm ${i}` });
  for (let i = 0; i < 4; i++) rows.push(h(`https://docs.test/h${i}`, `Docs page ${i}`, { visits: 50, typed: 20, daysAgo: 0 }));
  const out = rank("docs", rows);
  assert.equal(out.length, 8);
  assert.ok(out.some((r) => r.kind === "search"));
});

check("two open tabs with the same title on a grouped site both show", () => {
  const out = rank("claude", [tab("https://claude.ai/chat/1", "Claude"), tab("https://claude.ai/chat/2", "Claude")]);
  assert.equal(out.filter((r) => r.kind === "tab").length, 2);
});

check("a typed URL row stays first and hides history for the same URL", () => {
  const out = rank("example.com", [
    { kind: "url", score: 50, url: "http://example.com", title: "example.com" },
    h("https://example.com/", "Example Domain", { visits: 50, typed: 20, daysAgo: 0 }),
  ]);
  assert.deepEqual(out.map((r) => r.kind), ["url", "search"]);
});

check("the page you are on sinks below other matches", () => {
  const out = rank("inbox", [
    tab("https://mail.google.com/mail/u/0/#inbox", "Inbox - Work Mail", { isCurrentTab: true }),
    h("https://mail.google.com/mail/u/1/#inbox", "Inbox - Personal Mail"),
  ]);
  assert.equal(out[0].title, "Inbox - Personal Mail");
});

check("same page as tab and history -> only the tab", () => {
  const out = rank("design", [
    tab("https://docs.test/design#top", "Design Doc"),
    h("https://docs.test/design", "Design Doc"),
  ]);
  assert.deepEqual(kinds(out), ["tab", "search"]);
});

check("go-links", () => {
  const T = "https://golinks.example.test/go/%s";
  assert.equal(goLinkUrl("go/wiki", T), "https://golinks.example.test/go/wiki");
  assert.equal(goLinkUrl(" go/team-handbook ", T), "https://golinks.example.test/go/team-handbook");
  assert.equal(goLinkUrl("go/two words", T), null);
  assert.equal(goLinkUrl("google", T), null);
  assert.equal(goLinkUrl("go/x", null), null);
  const out = rank("go/wiki", [{ kind: "golink", score: 100, url: "u", title: "go/wiki" },
    h("https://golinks.example.test/go/wiki&sourceid=chrome", "Example go/wiki")]);
  assert.deepEqual(kinds(out), ["golink", "search"]);
});

check("past searches: shown as their text, once, under the search row; exact match dropped", () => {
  const g = (q, extra = "") => h(`https://www.google.com/search?q=${encodeURIComponent(q)}${extra}`, `${q} - Google Search`);
  const out = rank("hiking", [
    g("hiking boots"), g("hiking boots", "&oq=hiking"), g("hiking"),
    g("go/wiki", "&gs_lcrp=hiking"),
    h("https://hikingstore.test/", "Hiking Store"),
  ]);
  const past = out.filter((r) => r.kind === "pastSearch");
  assert.deepEqual(past.map((r) => r.title), ["hiking boots"]);
  assert.ok(out.indexOf(past[0]) > out.findIndex((r) => r.kind === "search"));
});

check("deep URLs do not count as a prefix match ('you' vs youtube.com/watch)", () => {
  const out = rank("you", [
    h("https://www.youtube.com/watch?v=1", "Elfirium - Noise - YouTube", { visits: 5 }),
    h("https://www.youtube.com/", "(1) YouTube", { visits: 100, typed: 10 }),
  ]);
  assert.deepEqual(out.map((r) => r.kind), ["history", "search", "history"]);
});

check("the domain row yields to the titled history row for the same front page", () => {
  const out = rank("we", [
    { kind: "domain", url: "https://web.chatapp.test", title: "" },
    h("https://web.chatapp.test/", "(3) ChatApp", { visits: 50, typed: 20 }),
  ]);
  assert.equal(out[0].title, "(3) ChatApp");
  assert.ok(!out.some((r) => r.kind === "domain"));
});

check("Slack '- N new items' and ' - Claude' suffixes do not split a page", () => {
  const out = rank("general", [
    h("https://app.slack.com/client/E1/C1", "general (Channel) - Example - 23 new items - Slack"),
    h("https://app.slack.com/client/E1/C1?x=2", "general (Channel) - Example - 4 new items - Slack"),
  ]);
  assert.equal(out.filter((r) => r.kind === "history").length, 1);
});

check("hidden hosts never show (history, tabs, site rows); other sites unaffected", () => {
  const rows = [
    tab("https://app.slack.com/client/E1/C1", "general (Channel) - Slack"),
    h("https://app.slack.com/client/E1/C2", "random (Channel) - Slack", { visits: 50, typed: 20 }),
    { kind: "domain", url: "https://app.slack.com", title: "" },
    h("https://api.slack.com/apps", "Slack API: Applications"),
    search(),
  ];
  const out = arcRank("slack", rows, NOW, { hiddenHosts: ["app.slack.com"] });
  assert.ok(!out.some((r) => r.url.includes("app.slack.com")), JSON.stringify(out.map((r) => r.url)));
  assert.ok(out.some((r) => r.url === "https://api.slack.com/apps"));
  assert.ok(out.some((r) => r.kind === "search"));
});

console.log(`${n} checks passed`);
