# scale_customized

`sandeshghanta/vimium` branch `scale_customized`: the latest upstream release
tag of `philc/vimium` plus local commits. Loaded unpacked in Chrome from the
DotFiles submodule `companies/active/vimium` (repo root is the extension, no build).

## Commits on top of upstream

- **Vomnibar: rank open tabs above all other suggestions** — matching open
  tabs always sort first, and the "domain" row is dropped when a tab matches.
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
  (stock Vimium fails 4 of its 7 checks). About 1 run in 6, the first Vomnibar open times out
  in headless Chromium, on any build; just rerun.
- This `scale/` folder (tests + notes). Chrome ignores it; keep it free of
  `__pycache__` (Chrome refuses to load an extension containing `_`-prefixed names).

## Updating to a new upstream release

Review the release's diff for new network calls, permissions or remote code, then:

```sh
cd ~/workplace/DotFiles/companies/active/vimium
git fetch upstream --tags
git rebase --onto <new-tag> <old-tag> scale_customized
uv run scale/test_vomnibar.py              # the open tab must be #1
git push --force-with-lease origin scale_customized
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
