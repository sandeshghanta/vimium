// Checks background_scripts/completion/page_identity.js. Vimium's own unit tests need Deno; this
// runs with plain Node:  node scale/test_page_identity.mjs
// Node won't load a .js file as an ES module outside a "type": "module" package, so the module is
// copied to a temp .mjs first.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../background_scripts/completion/page_identity.js");
const tmp = join(mkdtempSync(join(tmpdir(), "page-identity-")), "page_identity.mjs");
copyFileSync(src, tmp);
const { pageKey } = await import(pathToFileURL(tmp).href);
const same = (a, b, t1 = "T", t2 = t1) => assert.equal(pageKey(a, t1), pageKey(b, t2), `${a} vs ${b}`);
const diff = (a, b, t1 = "T", t2 = t1) => assert.notEqual(pageKey(a, t1), pageKey(b, t2), `${a} vs ${b}`);
const A = "https://claude.ai/artifact/ch6cymzv5ztjy8idtahjqd";
// The screenshot: claude.ai, same title, different query -> one page.
same(A, A + "?sk=7stgbbee-x0eh-ficbu4vg", "ARP Resource Lifecycle");
same(A, A + "?via=auto_preview", "ARP Resource Lifecycle");
same(A + "?anything=1#x", A, "ARP Resource Lifecycle");
// ...but different artifacts, or different titles, stay apart.
diff(A, "https://claude.ai/artifact/other", "ARP Resource Lifecycle");
diff(A + "?x=1", A + "?x=2", "One", "Two");
// Fragments ignored everywhere (the earlier fix), title still required.
same("https://docs.test/a#callers", "https://docs.test/a#rate-limits");
diff("https://mail.google.com/mail/u/0/#inbox/t1", "https://mail.google.com/mail/u/0/#inbox/t2", "thread one", "thread two");
// Tracking params ignored on any site; real params kept outside title-rule sites.
same("https://ex.test/p?utm_source=x&utm_medium=y&id=3", "https://ex.test/p?id=3");
same("https://ex.test/p?fbclid=abc", "https://ex.test/p");
same("https://ex.test/p?b=2&a=1", "https://ex.test/p?a=1&b=2");
diff("https://ex.test/dash?filter=a", "https://ex.test/dash?filter=b", "Dashboard");
diff("https://www.google.com/search?q=cats", "https://www.google.com/search?q=dogs", "Google");
// www. and http/https don't matter; other hosts and paths do.
same("http://www.ex.test/p", "https://ex.test/p");
diff("https://ex.test/p", "https://ex.test/q");
diff("https://a.ex.test/p", "https://b.ex.test/p");
// claude.ai's per-site params only apply to claude.ai.
diff("https://ex.test/p?via=x", "https://ex.test/p?via=y");
// Non-http(s) and garbage fall back to exact-URL de-duplication.
assert.equal(pageKey("javascript:alert(1)", "T"), null);
assert.equal(pageKey("not a url", "T"), null);
console.log("page_identity: all assertions passed");
