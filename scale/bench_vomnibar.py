# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.49", "psutil>=5.9"]
# ///
"""Benchmark Vimium's Vomnibar-in-new-tab latency across builds, in a throwaway headless Chromium.

Builds are given as NAME=PATH. Triggers:
  key      Ctrl+Shift+T into the page (the current Hammerspoon path; needs `map <c-T> ...`,
           which this script sets). In the textarea scenario it first sends Escape + 50ms, as
           Hammerspoon does.
  command  calls the background's vomnibarInNewTab() (what the chrome.commands shortcut runs).

Latency = wall clock from just before the trigger until the Vomnibar iframe is visible AND its
input has focus (measured inside the page with a MutationObserver + focus check).

  uv run bench_vomnibar.py --build base=... --build cmd=... --build preload=...
"""

import argparse
import asyncio
import json
import os
import statistics
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psutil
from playwright.async_api import async_playwright

PAGE = """<!doctype html><title>bench</title>
<h1>bench page</h1><textarea id=ta rows=4 cols=40></textarea>
<div style="height:3000px">filler</div>
<script>
window.__waitVomnibar = () => new Promise(resolve => {
  const check = () => {
    const w = [...document.documentElement.children].find(e => e.shadowRoot?.querySelector("iframe.vomnibar-frame"));
    const f = w?.shadowRoot.querySelector("iframe.vomnibar-frame");
    if (f && f.classList.contains("vimium-ui-component-visible") && w.shadowRoot.activeElement === f) {
      resolve(performance.timeOrigin + performance.now()); return true;
    }
    return false;
  };
  if (check()) return;
  const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
  mo.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
  // Shadow roots aren't covered by the observer above; poll them lightly too.
  const iv = setInterval(() => { if (check()) { clearInterval(iv); mo.disconnect(); } }, 2);
});
</script>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def chromium_procs():
    me = psutil.Process()
    return [p for p in me.children(recursive=True) if "chrom" in p.name().lower()]


def mem_mb():
    total = 0
    for p in chromium_procs():
        try:
            total += p.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return total / 2**20


async def bench_build(name, ext, args, port):
    out = {}
    with tempfile.TemporaryDirectory() as profile:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(
                profile, channel="chromium", headless=True,
                args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                      "--host-resolver-rules=MAP *.test 127.0.0.1"],
            )
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker", timeout=15000)
            await sw.evaluate("(async () => { await Settings.onLoaded(); await Settings.set('keyMappings', 'map <c-T> Vomnibar.activateInNewTab'); })()")
            has_cmd = await sw.evaluate("typeof globalThis.vomnibarInNewTab === 'function'")
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            url = f"http://bench.test:{port}/"

            async def trigger(kind, textarea):
                t0 = time.time() * 1000
                wait = asyncio.ensure_future(page.evaluate("window.__waitVomnibar()"))
                if kind == "key":
                    if textarea:
                        await page.keyboard.press("Escape")
                        await asyncio.sleep(0.05)
                    await page.keyboard.press("Control+Shift+T")
                else:
                    await sw.evaluate("(async () => { const [t] = await chrome.tabs.query({url: '%s*'}); await vomnibarInNewTab(t); })()" % url)
                t1 = await asyncio.wait_for(wait, 5)
                return t1 - t0

            async def scenario(kind, textarea, settle_ms, repeat):
                samples = []
                for _ in range(args.reps):
                    await page.goto(url)
                    await page.wait_for_timeout(settle_ms)
                    if textarea:
                        await page.click("#ta")
                    if repeat:  # open + close once so the iframe already exists
                        await trigger(kind, textarea)
                        await page.keyboard.press("Escape")
                        await page.wait_for_timeout(150)
                        if textarea:
                            await page.click("#ta")
                    try:
                        samples.append(await trigger(kind, textarea))
                    except asyncio.TimeoutError:
                        samples.append(float("nan"))
                return samples

            kinds = ["key"] + (["command"] if has_cmd else [])
            for kind in kinds:
                for label, textarea, settle, repeat in [
                    ("first open, page idle (1.5s after load)", False, 1500, False),
                    ("first open, right after load (100ms)", False, 100, False),
                    ("second open on same page", False, 1500, True),
                    ("first open, textarea focused", True, 1500, False),
                ]:
                    out[f"{kind} | {label}"] = await scenario(kind, textarea, settle, repeat)

            # Fallback: a page with no content script must still get a new tab.
            if has_cmd:
                await page.goto("chrome://version")
                n = len(ctx.pages)
                await sw.evaluate("(async () => { const [t] = await chrome.tabs.query({url: 'chrome://version/*'}); await vomnibarInNewTab(t); })()")
                await page.wait_for_timeout(500)
                out["fallback new tab on chrome://version"] = len(ctx.pages) == n + 1
                for t in ctx.pages[1:]:
                    await t.close()

            # Memory: N tabs of the test page, settled, total USS of all Chromium processes.
            base_mem = mem_mb()
            tabs = []
            for i in range(args.tabs):
                t = await ctx.new_page()
                await t.goto(f"http://t{i}.test:{port}/")
                tabs.append(t)
            await page.wait_for_timeout(3000)
            out[f"memory: +{args.tabs} tabs (MB, RSS)"] = round(mem_mb() - base_mem, 1)
            await ctx.close()
    return out


async def main_async(args):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = {}
    for spec in args.build:
        name, _, path = spec.partition("=")
        results[name] = await bench_build(name, os.path.abspath(os.path.expanduser(path)), args, port)
    server.shutdown()
    return results


def summarize(samples):
    ok = [s for s in samples if s == s]
    if not ok:
        return "all timed out"
    ok.sort()
    p95 = ok[min(len(ok) - 1, int(round(0.95 * (len(ok) - 1))))]
    fails = len(samples) - len(ok)
    return f"median {statistics.median(ok):6.1f}ms  p95 {p95:6.1f}ms  max {ok[-1]:6.1f}ms" + (f"  ({fails} timeouts)" if fails else "")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, metavar="NAME=PATH")
    ap.add_argument("--reps", type=int, default=20)
    ap.add_argument("--tabs", type=int, default=30)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    results = asyncio.run(main_async(args))
    if args.json:
        print(json.dumps(results, indent=2))
        return
    for name, r in results.items():
        print(f"\n== {name}")
        for k, v in r.items():
            print(f"  {k:<52} {summarize(v) if isinstance(v, list) else v}")


if __name__ == "__main__":
    main()
