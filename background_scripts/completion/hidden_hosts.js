// PATCH(hidden-hosts): sites Vimium never looks at, as listed in HIDDEN_HOSTS (local_config.js).
// Their tabs, history and bookmarks are dropped where each source is read (the history cache,
// the tab/bookmark/domain completers, the Ctrl+Tab switcher and `^`), so they are never matched,
// ranked or counted, not filtered out of a finished list.
import { HIDDEN_HOSTS } from "./local_config.js";

export function isHiddenUrl(url, hosts = HIDDEN_HOSTS) {
  if (!url || !hosts?.length) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => hostname === h || hostname.endsWith("." + h));
}
