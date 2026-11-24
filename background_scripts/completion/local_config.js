// The only machine/company-specific settings of the Arc-style Vomnibar (see arc_ranking.js).
// Everything else in the fork is generic. Edit these when moving to another company.

// Typing "go/<name>" opens this URL with %s replaced by <name>. Set to null to turn go-links off.
export const GO_LINK_URL = "https://scale.gocleary.com/go/%s";

// Sites never suggested in the Vomnibar (history, open tabs or site rows), e.g. ones that have
// their own shortcut. A host matches itself and its subdomains.
export const HIDDEN_HOSTS = [
  "app.slack.com", // Hammerspoon Ctrl+E opens the Slack app
];
