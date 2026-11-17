# Claude Usage Overlay

A small Chrome extension that keeps your Claude usage limits visible while you're on [claude.ai](https://claude.ai). A compact pill shows your 5-hour session usage and time to reset. Click it for the full breakdown: weekly limits, per-model limits and extra usage.

- Pill with a ring gauge, percentage and reset countdown
- Click to expand: every limit with a progress bar and reset time
- Draggable. It remembers where you put it
- Follows Claude's light/dark theme
- Click the toolbar icon to hide or show it
- No account, no API key, no analytics, no remote servers

Works in Chrome and Edge (and other Chromium browsers).

## Install (unpacked)

1. Download or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Open [claude.ai](https://claude.ai) while signed in. The pill appears in the bottom-right corner.

After pulling changes, click the reload icon on the extension's card and refresh the claude.ai tab.

## How it works

The content script (`src/content.js`) runs only on `https://claude.ai/*`. It calls the same endpoint Settings > Usage uses:

```
GET /api/organizations/{orgId}/usage
```

It uses your existing session cookies, and the request goes to claude.ai itself. The org id comes from the `lastActiveOrg` cookie, with a fallback to `GET /api/organizations`. It polls about once a minute while the tab is visible, and again when you switch back to the tab or a limit is due to reset. Countdowns tick locally between polls.

The only permission is `storage`, used to remember the pill's position and the hidden/shown state. It reads no chats, and nothing leaves your browser.

Windows are discovered generically (any object with a numeric `utilization`), so new limits that Anthropic adds, such as per-model weekly caps, appear without a code change.

### Caveats

- **The endpoint is undocumented.** It's the one claude.ai's own settings page uses, but Anthropic can change it at any time. If the pill shows `–`, that's the likeliest reason.
- Some plans, such as Free, may not report usage at all. The panel says so rather than showing wrong numbers.
- Extra-usage credits are shown as a percentage only, not a currency amount, because the unit isn't documented.

## Development

```
npm test        # unit tests for the parser/formatters (Node 20+, no dependencies)
```

```
manifest.json      MV3 manifest
src/usage.js       pure parsing/formatting helpers (unit-tested)
src/content.js     overlay UI (shadow DOM), fetching, drag, theming
src/background.js  toolbar icon toggles the overlay
test/              node:test unit tests
icons/             16/48/128 px icons
```

### Tweaking the design

All styling is in the `CSS` string near the top of `src/content.js`. Colors are CSS variables on `.root` (light) and `.root[data-theme="dark"]`. Severity thresholds (70% warn, 90% high) live in `severity()` in `src/usage.js`. Severity is always shown as a number as well as a color.

## Not affiliated with Anthropic

This is an independent project.
