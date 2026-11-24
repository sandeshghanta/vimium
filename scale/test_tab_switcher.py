# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.49,<1.65"]
# ///
"""Check the Arc-style Ctrl+Tab switcher (background_scripts/tab_switcher.js) end to end.

Hammerspoon turns Ctrl+Tab / Ctrl+Shift+Tab / Ctrl-release into three Chrome shortcuts; this test
calls the same background functions those shortcuts call, in a throwaway headless Chromium with
fake *.test pages (nothing reaches the network).

  uv run scale/test_tab_switcher.py            # this checkout
  uv run scale/test_tab_switcher.py --ext DIR  # another build
"""

import argparse
import asyncio
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.async_api import async_playwright


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.strip("/") or "root"
        body = f"<!doctype html><title>Page {name}</title><h1>Page {name}</h1>".encode()
        self.send_response(200)
        if name == "D":
            # Like YouTube: Trusted Types enforced, so innerHTML-style DOM building is blocked.
            self.send_header("Content-Security-Policy", "require-trusted-types-for 'script'")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


async def run(ext: str) -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    failures = 0

    def check(name, ok, detail=""):
        nonlocal failures
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")

    with tempfile.TemporaryDirectory() as profile:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(
                profile,
                channel="chromium",
                headless=True,
                args=[
                    f"--disable-extensions-except={ext}",
                    f"--load-extension={ext}",
                    "--host-resolver-rules=MAP *.test 127.0.0.1, MAP app.slack.com 127.0.0.1, "
                    "MAP * ~NOTFOUND",
                ],
            )
            if not ctx.service_workers:
                await ctx.wait_for_event("serviceworker", timeout=15000)
            sw = ctx.service_workers[0]

            pages = {}
            first = ctx.pages[0] if ctx.pages else await ctx.new_page()
            # S is on app.slack.com, a HIDDEN_HOSTS site, visited just before D: it must never be
            # a candidate, so every expectation below is as if it weren't open.
            for i, name in enumerate("ABCSD"):
                pg = first if i == 0 else await ctx.new_page()
                host = "app.slack.com" if name == "S" else "site.test"
                await pg.goto(f"http://{host}:{port}/{name}")
                await pg.bring_to_front()  # activates the tab, so Vimium records the visit
                await pg.wait_for_timeout(300)
                pages[name] = pg
            await pages["D"].wait_for_timeout(1500)  # content scripts ready

            async def active():
                title = await sw.evaluate(
                    "chrome.tabs.query({active: true, lastFocusedWindow: true}).then(t => t[0].title)")
                return title.replace("Page ", "")

            async def call(fn):
                await sw.evaluate(f"tabSwitcher.{fn}()")

            async def panel(pg):
                return await pg.evaluate("""() => {
                    const h = document.getElementById('vimium-tab-switcher');
                    if (!h) return null;
                    const rows = [...h.shadowRoot.querySelectorAll('.row')];
                    return { titles: rows.map(r => r.querySelector('.title').textContent),
                             selected: rows.findIndex(r => r.classList.contains('selected')) };
                }""")

            # 1. Tap: flips to the previous tab (C, not the hidden S), no panel.
            await call("tabSwitcherNext")
            await call("tabSwitcherCommit")
            await pages["D"].wait_for_timeout(300)
            check("tap Ctrl+Tab -> previous tab", await active() == "C", await active())
            check("tap: no panel left behind", await panel(pages["D"]) is None)

            # 2. Tap again: flips back (C <-> D).
            await call("tabSwitcherNext")
            await call("tabSwitcherCommit")
            await pages["D"].wait_for_timeout(300)
            check("tap again -> flips back", await active() == "D", await active())

            # 3. Hold: the panel lists recent tabs; nothing switches until release; order frozen.
            await call("tabSwitcherNext")
            await pages["D"].wait_for_timeout(400)
            pnl = await panel(pages["D"])
            check("hold: panel shows recent tabs, previous one highlighted",
                  pnl is not None and pnl["titles"] == ["Page D", "Page C", "Page B", "Page A"]
                  and pnl["selected"] == 1, str(pnl))
            await call("tabSwitcherNext")
            await call("tabSwitcherNext")
            pnl = await panel(pages["D"])
            check("hold + 2 more Tabs: highlight walks down, order unchanged",
                  pnl is not None and pnl["selected"] == 3 and pnl["titles"][0] == "Page D", str(pnl))
            check("hold: no tab switched yet", await active() == "D", await active())
            await call("tabSwitcherCommit")
            await pages["D"].wait_for_timeout(300)
            check("release -> highlighted tab", await active() == "A", await active())
            check("release: panel removed", await panel(pages["D"]) is None)

            # 4. Shift+Tab from the start goes to the oldest of the shown tabs (recent: A D C B).
            await call("tabSwitcherPrevious")
            await call("tabSwitcherCommit")
            await pages["A"].wait_for_timeout(300)
            check("Ctrl+Shift+Tab -> oldest shown tab", await active() == "B", await active())

            # 5. Esc in the panel cancels: no switch.
            await call("tabSwitcherNext")
            await pages["B"].wait_for_timeout(400)
            await pages["B"].keyboard.press("Escape")
            await pages["B"].wait_for_timeout(300)
            await call("tabSwitcherCommit")  # Ctrl released after Esc
            await pages["B"].wait_for_timeout(300)
            check("Esc cancels", await active() == "B" and await panel(pages["B"]) is None,
                  await active())

            # 5b. The panel still shows on a page where Vimium is excluded (e.g. youtube.com).
            await sw.evaluate("""Settings.set("exclusionRules",
                [{ pattern: "http://site.test:*/B*", passKeys: "" }])""")
            await pages["B"].reload()
            await pages["B"].wait_for_timeout(1500)
            await call("tabSwitcherNext")
            await pages["B"].wait_for_timeout(400)
            pnl = await panel(pages["B"])
            check("panel shows where Vimium is excluded", pnl is not None, str(pnl))
            await call("tabSwitcherCancel")
            await sw.evaluate('Settings.set("exclusionRules", [])')

            # 6. Walking all the way round lands back on the current tab: release does nothing.
            for _ in range(4):
                await call("tabSwitcherNext")
            await call("tabSwitcherCommit")
            await pages["B"].wait_for_timeout(300)
            check("full circle -> stays put", await active() == "B", await active())

            await ctx.close()
    server.shutdown()
    return failures


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ext", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    args = ap.parse_args()
    failures = asyncio.run(run(os.path.abspath(os.path.expanduser(args.ext))))
    print("OK" if not failures else f"{failures} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
