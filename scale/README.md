# scale_customized

`sandeshghanta/vimium` branch `scale_customized`: the latest upstream release
tag of `philc/vimium` plus local commits. Loaded unpacked in Chrome from the
DotFiles submodule `companies/active/vimium` (repo root is the extension, no build).

## Commits on top of upstream

- **Vomnibar: rank open tabs above all other suggestions** — matching open
  tabs always sort first, and the "domain" row is dropped when a tab matches.
- This `scale/` folder (test + notes). Chrome ignores it; keep it free of
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

Custom key mappings (Hammerspoon sends Ctrl+Shift+T on Cmd+T in Chrome, see
DotFiles `hammerspoon/init.lua`):

```
map <c-T> Vomnibar.activateInNewTab
```

Custom search engines:

```
gcal: https://calendar.google.com Google Calendar
```
