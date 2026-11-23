# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.49,<1.65"]
# ///
"""Check the autoselect-first patch end to end in a throwaway headless Chromium.

Opens the Vomnibar the way Cmd+T does (the vomnibarInNewTab Chrome command), types, presses
keys, and asserts which URL the new tab gets. Fake *.test sites, empty profile. The "Up, Enter"
case opens the default search engine, so that one tab does reach the network.

  uv run scale/test_autoselect.py            # this checkout
  uv run scale/test_autoselect.py --ext DIR  # another build (stock Vimium fails cases 1 and 3)
"""

import argparse
import asyncio
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.async_api import async_playwright

TITLES = {"/design": "Design Doc for Widgets", "/other": "Other page", "/inbox": "Inbox"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        title = TITLES.get(self.path, self.path)
        body = f"<!doctype html><title>{title}</title><h1>{title}</h1>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


async def open_vomnibar(page, sw):
    # Call the background function the Cmd+T Chrome command runs (vomnibarInNewTab, see
    # background_scripts/main.js). Retried because a fresh profile's first activation is
    # sometimes lost before Vimium's content script is ready.
    for _attempt in range(5):
        await page.bring_to_front()  # a fresh install can open a tab that steals focus
        await sw.evaluate("vomnibarInNewTab()")
        for _ in range(30):
            frame = next((f for f in page.frames if "vomnibar_page.html" in f.url), None)
            if frame and await frame.locator("#vomnibar").is_visible():
                box = frame.locator("#vomnibar-search-area input")
                await box.wait_for()
                return frame, box
            await page.wait_for_timeout(100)
    raise SystemExit("Vomnibar did not open (is Vimium loaded and enabled?)")


async def run(ext: str) -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://docs.test:{port}"
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
                    "--host-resolver-rules=MAP *.test 127.0.0.1",
                ],
            )
            if not ctx.service_workers:
                await ctx.wait_for_event("serviceworker", timeout=15000)
            sw = ctx.service_workers[0]
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            for path in ("/design", "/other"):  # history only
                await page.goto(base + path)
            await page.goto(base + "/inbox")
            await page.wait_for_timeout(3000)

            async def enter_and_get_url(box, keys=("Enter",)):
                async with ctx.expect_page(timeout=5000) as info:
                    for k in keys:
                        await box.press(k)
                new = await info.value
                await new.wait_for_load_state("commit")
                url = new.url
                await new.close()
                return url

            # 1. Typing highlights the top suggestion; Enter opens it.
            frame, box = await open_vomnibar(page, sw)
            await box.press_sequentially("design", delay=60)
            await page.wait_for_timeout(800)
            first_cls = await frame.locator("#vomnibar ul li").first.get_attribute("class")
            check("top row highlighted after typing", first_cls == "selected", f"class={first_cls!r}")
            url = await enter_and_get_url(box)
            check("Enter opens top suggestion", url == base + "/design", url)

            # 2. Up from the highlighted row -> no selection -> Enter searches the typed text.
            frame, box = await open_vomnibar(page, sw)
            await box.press_sequentially("design", delay=60)
            await page.wait_for_timeout(800)
            url = await enter_and_get_url(box, ("ArrowUp", "Enter"))
            check("Up, Enter searches typed text", "design" in url and "docs.test" not in url, url)

            # 3. Type fast and hit Enter before suggestions arrive -> still the top match.
            frame, box = await open_vomnibar(page, sw)
            await box.press_sequentially("widg", delay=0)
            url = await enter_and_get_url(box)
            check("fast type+Enter opens top match", url == base + "/design", url)

            # 4. An explicit URL is not auto-selected; Enter opens exactly what was typed.
            frame, box = await open_vomnibar(page, sw)
            typed = f"localhost:{port}/other?x=1"
            await box.press_sequentially(typed, delay=20)
            await page.wait_for_timeout(800)
            n_sel = await frame.locator("#vomnibar ul li.selected").count()
            check("explicit URL: nothing highlighted", n_sel == 0, f"selected={n_sel}")
            url = await enter_and_get_url(box)
            check("explicit URL: Enter opens it", url.endswith("/other?x=1"), url)

            # 5. Down still moves the selection to row 2.
            frame, box = await open_vomnibar(page, sw)
            await box.press_sequentially("docs", delay=60)
            await page.wait_for_timeout(800)
            await box.press("ArrowDown")
            idx = await frame.eval_on_selector_all(
                "#vomnibar ul li", "els => els.findIndex(e => e.className === 'selected')")
            check("Down moves to row 2", idx == 1, f"index={idx}")
            await box.press("Escape")

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
