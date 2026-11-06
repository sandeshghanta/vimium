# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.49"]
# ///
"""Drive Vimium's Vomnibar in a throwaway headless Chromium and print the ranked suggestions.

Fake sites (*.test) are served from a local HTTP server, so nothing touches the real
profile or network. The default scenario mirrors "typing `cale` shows the
calendar.google.com domain row above the open Calendar tab".

  uv run test_vomnibar.py                                  # this checkout, query "cale"
  uv run test_vomnibar.py --ext /path/to/stock-vimium      # compare against another build
  uv run test_vomnibar.py --query web \
      --history web.whatsapp.test/old=WhatsApp \
      --tab web.whatsapp.test/=WhatsApp
  uv run test_vomnibar.py --headed                         # watch it

First run only: uv run --with playwright playwright install chromium
"""

import argparse
import asyncio
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

DEFAULT_HISTORY = [
    "calendar.test/day/1=Scale - Calendar - Monday",
    "calendar.test/day/2=Scale - Calendar - Tuesday",
    "calendar.test/event/abc=Scale - Calendar - Event details",
    "mail.test/old=Scale Mail",
]
DEFAULT_TABS = ["calendar.test/r=Scale - Calendar - Friday, today"]
DEFAULT_ACTIVE = "mail.test/inbox=Scale Mail"

TITLES: dict[str, str] = {}  # "host/path" -> title


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        key = self.headers.get("Host", "").split(":")[0] + self.path
        title = TITLES.get(key, key)
        body = f"<!doctype html><title>{title}</title><h1>{title}</h1>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def parse_page(spec: str, port: int) -> str:
    """'host/path=Title' -> 'http://host:port/path', registering the title."""
    target, _, title = spec.partition("=")
    parts = urlsplit("http://" + target)
    path = parts.path or "/"
    TITLES[parts.hostname + path] = title or target
    return f"http://{parts.hostname}:{port}{path}"


async def run(args) -> list[dict]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    history = [parse_page(s, port) for s in args.history]
    tabs = [parse_page(s, port) for s in args.tab]
    active_url = parse_page(args.active, port)
    ext = os.path.abspath(os.path.expanduser(args.ext))

    with tempfile.TemporaryDirectory() as profile:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(
                profile,
                channel="chromium",  # new headless mode, which supports extensions
                headless=not args.headed,
                args=[
                    f"--disable-extensions-except={ext}",
                    f"--load-extension={ext}",
                    "--host-resolver-rules=MAP *.test 127.0.0.1",
                ],
            )
            if not ctx.service_workers:
                await ctx.wait_for_event("serviceworker", timeout=15000)

            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            for url in history:  # visited, then navigated away from -> history only
                await page.goto(url)
            for url in tabs:  # left open
                t = await ctx.new_page()
                await t.goto(url)
            await page.goto(active_url)
            await page.bring_to_front()
            await page.wait_for_timeout(1500)  # let Vimium's content script initialise

            await page.keyboard.press("o")  # Vomnibar.activate (default mapping)
            frame = None
            for _ in range(50):
                frame = next((f for f in page.frames if "vomnibar_page.html" in f.url), None)
                if frame:
                    break
                await page.wait_for_timeout(100)
            if not frame:
                raise SystemExit("Vomnibar did not open (is Vimium loaded and enabled?)")

            box = frame.locator("#vomnibar-search-area input")
            await box.wait_for()
            await box.press_sequentially(args.query, delay=60)
            await page.wait_for_timeout(1500)

            items = await frame.eval_on_selector_all(
                "#vomnibar ul li",
                """els => els.map(e => ({
                    source: [...e.querySelectorAll('.source')].map(s => s.textContent.trim())
                              .filter(Boolean).join(' '),
                    title: e.querySelector('.title')?.textContent.trim() || '',
                    url: e.querySelector('.url')?.textContent.trim() || '',
                }))""",
            )
            await ctx.close()
    server.shutdown()
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ext", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."), help="unpacked Vimium folder (default: this checkout)")
    ap.add_argument("--query", default="cale")
    ap.add_argument("--history", nargs="*", default=DEFAULT_HISTORY, metavar="HOST/PATH=TITLE")
    ap.add_argument("--tab", nargs="*", default=DEFAULT_TABS, metavar="HOST/PATH=TITLE")
    ap.add_argument("--active", default=DEFAULT_ACTIVE, metavar="HOST/PATH=TITLE")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    items = asyncio.run(run(args))
    if args.json:
        print(json.dumps(items, indent=2))
        return
    print(f"query={args.query!r}  ext={args.ext}")
    for i, it in enumerate(items, 1):
        print(f"{i:2}. [{it['source']:<8}] {it['title'][:50]:<50} {it['url']}")


if __name__ == "__main__":
    main()
