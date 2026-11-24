// PATCH(tab-switcher): Arc-style Ctrl+Tab. Arc's Tab Switcher: tap Ctrl+Tab and let go to flip to
// your previous tab; keep holding Ctrl and a panel of your 5 most recent tabs appears, each Tab
// moves down (Shift+Tab up), and letting go of Ctrl switches to the highlighted tab. Esc cancels.
//
// Chrome won't let an extension bind Ctrl+Tab or see a modifier being released, so Hammerspoon
// does the keys (see hammerspoon/init.lua in DotFiles) and calls three extension shortcuts:
//   tabSwitcherNext (MacCtrl+Shift+.), tabSwitcherPrevious (MacCtrl+Shift+,), and
//   tabSwitcherCommit (MacCtrl+Shift+End, sent when Ctrl is released).
// No tab is activated until the commit, so the recency order stays frozen during a walk and only
// the tab you land on becomes the most recent one.

import * as bgUtils from "./bg_utils.js";
import { isHiddenUrl } from "./completion/hidden_hosts.js";

export const MAX_TABS = 5;
// The panel appears only if Ctrl is still held this long after the first Tab (a quick tap just
// flips tabs, as in Arc).
const SHOW_DELAY_MS = 150;
// If Hammerspoon never sends the commit (e.g. it missed the Ctrl release), drop the session.
const IDLE_MS = 10000;

let session = null;
// Key events arrive faster than chrome.* calls resolve, so handle them one at a time, in order.
let queue = Promise.resolve();

function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error("tab switcher:", e));
  return queue;
}

function sendUI(message) {
  if (!session) return;
  chrome.tabs.sendMessage(
    session.originTabId,
    Object.assign({ handler: "tabSwitcherUI" }, message),
    { frameId: 0 },
  ).catch(() => {}); // Pages Vimium can't run on (chrome://, Web Store): no panel, still works.
}

function render() {
  const items = session.order.map((tab) => ({
    title: tab.title || tab.url,
    host: (() => {
      try {
        return new URL(tab.url).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })(),
    favicon: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`),
  }));
  sendUI({ action: "show", items, index: session.index });
}

function clearTimers() {
  clearTimeout(session?.showTimer);
  clearTimeout(session?.idleTimer);
}

function end() {
  if (!session) return;
  clearTimers();
  if (session.shown) sendUI({ action: "hide" });
  session = null;
}

async function start() {
  await bgUtils.tabRecency.init();
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) return;
  // PATCH(hidden-hosts): hidden sites (Slack) are never candidates, so they don't take a slot.
  const tabs = new Map(
    (await chrome.tabs.query({})).filter((t) => !isHiddenUrl(t.url)).map((t) => [t.id, t]),
  );
  const tracked = bgUtils.tabRecency.getTabsByRecency()
    .filter((id) => id !== active.id && tabs.has(id));
  // Vimium only knows tabs you switched to since it started; the rest go after, by Chrome's own
  // tab.lastAccessed (newest first).
  const trackedSet = new Set(tracked);
  const untracked = [...tabs.values()]
    .filter((t) => t.id !== active.id && !trackedSet.has(t.id))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const recent = [...tracked.map((id) => tabs.get(id)), ...untracked];
  const order = [active, ...recent].slice(0, MAX_TABS);
  if (order.length < 2) return;
  session = { order, index: 0, originTabId: active.id, shown: false };
  session.showTimer = setTimeout(() => {
    if (!session) return;
    session.shown = true;
    render();
  }, SHOW_DELAY_MS);
}

async function step(direction) {
  if (!session) await start();
  if (!session) return;
  const n = session.order.length;
  session.index = (session.index + direction + n) % n;
  if (session.shown) render();
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => enqueue(end), IDLE_MS);
}

async function commit() {
  if (!session) return;
  const target = session.order[session.index];
  const switching = session.index !== 0;
  end();
  if (!switching) return;
  await chrome.windows.update(target.windowId, { focused: true });
  await chrome.tabs.update(target.id, { active: true });
}

export const tabSwitcherNext = () => enqueue(() => step(1));
export const tabSwitcherPrevious = () => enqueue(() => step(-1));
export const tabSwitcherCommit = () => enqueue(commit);
export const tabSwitcherCancel = () => enqueue(end);
// For tests.
export const tabSwitcherState = () =>
  session && { index: session.index, shown: session.shown, ids: session.order.map((t) => t.id) };
