# sandeshghanta/vimium `main`

Branch `main` of `sandeshghanta/vimium`: the latest upstream release tag of `philc/vimium` plus
local commits. Not tied to a company: the only company-specific setting is the go-link URL in
`background_scripts/completion/local_config.js`. (`scale_customized` and `purestorage_customized`
are older branches, kept as they were.) Loaded unpacked in Chrome from the DotFiles submodule
`companies/active/vimium` (repo root is the extension, no build). This `scale/` folder holds the
fork's tests and notes.

## Commits on top of upstream

- **Vomnibar: rank open tabs above all other suggestions** — matching open
  tabs always sort first, and the "domain" row is dropped when a tab matches. (The omni Vomnibar
  now ranks with `arc_ranking.js` instead, see below; this still applies to the tabs Vomnibar.)
- **Chrome shortcut "Open the Vomnibar in a new tab"** (`Cmd+Shift+,`, manifest `commands` +
  `vomnibarInNewTab` in `background_scripts/main.js`). Chrome handles it before the page sees the
  key, so it never clashes with text fields, editors or video. Opens a plain new tab where Vimium
  has no content script. Hammerspoon maps Cmd+T in Chrome to it.
- **Vomnibar: one row per page** (`background_scripts/completion/page_identity.js`) — suggestions
  for the same page collapse to the best-ranked one (the open tab, if any). Always ignored: the
  `#fragment`, tracking params (`utm_*`, `fbclid`, `gclid`, …), `www.` and http/https. Per site:
  `SITE_IGNORED_PARAMS` (claude.ai: `via`, `sk`), and for `TITLE_RULE_HOSTS` (claude.ai) any
  query string. The title is always part of the key, so views with distinct titles (Gmail
  threads, searches) stay separate. Edit those lists to add sites;
  `node scale/test_page_identity.mjs` checks the rules.
- **Vomnibar: highlight the top suggestion** (`PATCH(autoselect-first)` in `pages/vomnibar_page.js`)
  — in the omni Vomnibar (`o`, `O`, Cmd+T) row 1 is selected as you type, so Enter opens it.
  Up from row 1 clears the selection, and then Enter opens or searches exactly what you typed.
  Not applied when the query is an explicit URL (has a scheme, a `/` path or a `:port`). Enter
  pressed before the latest suggestions arrive waits for them, so a fast type+Enter opens the
  top match for what is in the box. `uv run scale/test_autoselect.py` checks it end to end
  (stock Vimium fails most of its checks).
- **Arc-style Vomnibar** (`PATCH(arc)`; `background_scripts/completion/arc_ranking.js`) — the
  omni Vomnibar ranks every row with one score, like Arc's Command Bar:
  - a **web search** row is always offered (Enter on it = Chrome's default search for the text),
    at a fixed score: prefix matches (title starts with the query, or a site's front page does)
    go above it, word-start matches only with enough recency/frequency, mid-word matches never;
  - at equal strength: tabs, bookmarks, history; caps of 3 tabs, 2 bookmarks, 4 history, 2 past
    searches, 8 rows in all; the page you are on sinks to the bottom;
  - Arc's same-title-same-site de-dup for web apps (`TITLE_HOST_GROUPS` in `page_identity.js`:
    claude.ai and its artifact frames, Notion, Figma, Linear, GitHub, Slack, Google Calendar and
    Maps), ignoring unread counters, Slack's "N new items" and a " - Claude" suffix;
  - search results pages in history show once as **past search** rows, under the web search;
  - sign-in, SSO and redirect pages never show from history;
  - text that is a URL (`example.com`, `localhost:3000/x`, `https://…`) gets a **url** row
    first, as Arc keeps a typed URL first, so Enter opens it even if you never visited it;
  - `go/<name>` gets a **go link** row first (URL template in `local_config.js`);
  - open tabs are never hidden by de-dup (two Claude chats can both be titled "Claude"); the
    sign-in filter matches paths like `/login` and `/sso/`, so a real page at such a path is
    hidden from history too.
  Arc doesn't publish its algorithm; the signals come from a reverse-engineering of Arc 1.17x
  (github.com/MartinPTielemans/ilo/issues/1396), the weights are ours (header of
  `arc_ranking.js`). `node scale/test_arc_ranking.mjs` checks the ranking.
- This `scale/` folder (tests + notes). Chrome ignores it; keep it free of
  `__pycache__` (Chrome refuses to load an extension containing `_`-prefixed names).

## Updating to a new upstream release

Review the release's diff for new network calls, permissions or remote code, then:

```sh
cd ~/workplace/DotFiles/companies/active/vimium
git fetch upstream --tags
git rebase --onto <new-tag> <old-tag> main
uv run scale/test_vomnibar.py              # the open tab must be #1
uv run scale/test_autoselect.py            # Enter / web search / go-link, end to end
node scale/test_arc_ranking.mjs && node scale/test_page_identity.mjs
git push --force-with-lease origin main
```

Then commit the new submodule pin in DotFiles and click reload on Vimium in
`chrome://extensions`.

## test_vomnibar.py

Loads a Vimium folder into a throwaway headless Chromium (fake `*.test` sites,
empty profile), types a query into the Vomnibar and prints the ranked
suggestions. `--ext <folder>` to test another build, `--headed` to watch,
`--help` for custom history/tabs/query. First run:
`uv run --with playwright playwright install chromium`.

## Settings this setup relies on (Vimium Options)

No custom key mapping is needed for Cmd+T any more. After loading/reloading, confirm the
shortcut in `chrome://extensions/shortcuts` (Vimium -> "Open the Vomnibar in a new tab" =
Cmd+Shift+,); Chrome drops a suggested key that clashes with another extension.

Custom search engines:

```
gcal: https://calendar.google.com Google Calendar
```

## bench_vomnibar.py

Times trigger -> Vomnibar visible and focused, per build, in a throwaway headless Chromium:
`uv run scale/bench_vomnibar.py --build base=<dir> --build new=<dir>` (`--reps`, `--tabs`).
Covers the old page-keystroke path, the Chrome-shortcut path, a focused textarea, the
chrome:// fallback and a 30-tab memory delta.
