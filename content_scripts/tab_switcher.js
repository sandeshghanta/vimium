// PATCH(tab-switcher): the panel for the Arc-style Ctrl+Tab switcher (logic in
// background_scripts/tab_switcher.js). Shown in the top frame of the tab you start from: your most
// recent tabs, the highlighted one is where letting go of Ctrl takes you. Esc cancels.

const TabSwitcherUI = {
  host: null,
  root: null,

  ensureDom() {
    if (this.host?.isConnected) return;
    this.host = document.createElement("div");
    this.host.className = "vimium-reset";
    this.host.id = "vimium-tab-switcher";
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `
<style>
  :host { all: initial; }
  .panel {
    --bg: rgba(250, 250, 250, 0.96); --fg: #1d1d1f; --muted: #6e6e73;
    --sel: rgba(0, 113, 227, 0.14); --sel-ring: rgba(0, 113, 227, 0.55); --border: rgba(0,0,0,0.12);
    position: fixed; top: 22vh; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; width: min(520px, calc(100vw - 32px)); box-sizing: border-box;
    padding: 8px; border-radius: 14px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg);
    box-shadow: 0 18px 50px rgba(0,0,0,0.28);
    font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    backdrop-filter: blur(18px);
  }
  @media (prefers-color-scheme: dark) {
    .panel { --bg: rgba(38, 38, 40, 0.96); --fg: #f5f5f7; --muted: #a1a1a6;
      --sel: rgba(10, 132, 255, 0.24); --sel-ring: rgba(10, 132, 255, 0.7);
      --border: rgba(255,255,255,0.12); }
  }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px;
    border: 1px solid transparent; }
  .row.selected { background: var(--sel); border-color: var(--sel-ring); }
  img { width: 16px; height: 16px; flex: none; }
  .text { min-width: 0; }
  .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .host { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted);
    font-size: 11px; }
</style>
<div class="panel" role="listbox" aria-label="Recent tabs"></div>`;
    (document.documentElement || document.body).appendChild(this.host);
  },

  show({ items, index }) {
    this.ensureDom();
    const panel = this.root.querySelector(".panel");
    panel.replaceChildren(...items.map((item, i) => {
      const row = document.createElement("div");
      row.className = i === index ? "row selected" : "row";
      row.setAttribute("role", "option");
      const img = document.createElement("img");
      img.src = item.favicon;
      img.alt = "";
      const text = document.createElement("div");
      text.className = "text";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = item.title;
      const host = document.createElement("div");
      host.className = "host";
      host.textContent = i === 0 ? `${item.host} · current tab` : item.host;
      text.append(title, host);
      row.append(img, text);
      return row;
    }));
    if (!this.keyListener) {
      this.keyListener = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        chrome.runtime.sendMessage({ handler: "tabSwitcherCancel" });
      };
      globalThis.addEventListener("keydown", this.keyListener, true);
    }
  },

  hide() {
    this.host?.remove();
    this.host = null;
    this.root = null;
    if (this.keyListener) {
      globalThis.removeEventListener("keydown", this.keyListener, true);
      this.keyListener = null;
    }
  },
};

globalThis.TabSwitcherUI = TabSwitcherUI;
