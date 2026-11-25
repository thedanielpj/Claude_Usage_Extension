# Claude Usage Overlay

A small Chrome extension that docks a flat usage strip to the top of [claude.ai](https://claude.ai):

```
 ┌───────────────────────────┬──────────────┐
 │ session · 2h 13m    43%   │ weekly  15%  │
 └▀▀▀▀▀▀▀▀▀▀▀▀░░░░░░░░░░░░░░░┴──────────────┘
   gradient progress line
```

- **Session cell:** label, time until the 5-hour window resets, and the percentage used. The gradient progress fill sits on the page's own header separator line, with exactly the same thickness, so it reads as part of that line.
- **Weekly cell:** the weekly percentage. Every 30 seconds it flips to the time left (`3d 4h`), holds for about 6 seconds, and flips back.
- **Burn animation:** when you finish a prompt and session usage jumps (say 10% to 15%), a jet-thrust flame shoots across the session cell from right to left. A fun word replaces `session` and `+5%` replaces the percentage for about 5 seconds, then the flame slowly dies out and the cell settles back to normal. With reduced motion on, you get a still flame instead.
- **Near the limit:** at 80% / 90% / 95% the progress line heats up (hot, red-orange, slow red pulse) and a warning word (`running hot`, `redline`, `last drop`) shows for a few seconds now and then. From 90% a soft northern-lights glow drifts along the bottom of the strip, warming from amber to red as you approach 100%, and burns turn the flame red. The weekly cell gets its own line once it passes 80%.
- **Limit hit:** the cell goes burnt out (charred, faint smouldering embers) and shows `back in 1h 12m` for the session, or `back Thu 9 AM` for the weekly limit (the session cell then reads `on hold`). When the limit resets, a short `reloaded` moment plays.
- **Details:** click the strip to drop down every limit (per-model weekly caps, extra usage) with reset times.
- Click the toolbar icon and use the switch to hide or show the strip.
- No account, no API key, no analytics, no remote servers.

Works in Chrome and Edge (and other Chromium browsers).

## Install (unpacked)

1. Download or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Open [claude.ai](https://claude.ai) while signed in. The strip appears at the top centre.

After pulling changes, click the reload icon on the extension's card and refresh the claude.ai tab.

## How it works

The content script (`src/content.js`) runs only on `https://claude.ai/*`. It calls the same endpoint Settings > Usage uses:

```
GET /api/organizations/{orgId}/usage
```

It uses your existing session cookies, and the request goes to claude.ai itself. The org id comes from the `lastActiveOrg` cookie, with a fallback to `GET /api/organizations`.

**Refreshing.** It polls about every 30 seconds while the tab is visible, and again when you switch back to the tab. Countdowns tick locally in between.

**Detecting a finished prompt.** While Claude replies, the composer shows a stop button. When that button disappears, the extension re-checks usage straight away. It retries after about 6 and 15 seconds in case usage accounting lags. The "+N%" figure is the change in the *displayed* percentage between two checks.

- If claude.ai changes that button and the detection stops matching, nothing breaks: the regular 30-second poll still catches the jump, just a little later.
- A jump is only shown when the two checks were less than 3 minutes apart, so reopening a laptop or a background tab doesn't set off the fire for old usage.
- A window rolling over (new 5-hour session) counts from 0.

The only permission is `storage`, used to remember the hidden/shown state. It reads no chats, and nothing leaves your browser.

Windows are discovered generically (any object with a numeric `utilization`), so new limits that Anthropic adds appear in the dropdown without a code change.

**Alignment with claude.ai.** The strip fits itself to the page it's on:

- *Bottom edge:* it finds the header's separator line at runtime (the header's bottom border), ends the strip just above it, and draws the progress fill in that same row with the same thickness. If it can't find a separator it falls back to a 45px strip with its own 1px bottom edge.
- *Horizontal position:* it centres on the message composer's vertical axis, which is the middle of the chat column (between the chat title on the left and the header buttons on the right). It follows the composer as the sidebar or a side panel opens and closes, and falls back to `<main>`, then the viewport centre, on pages with no composer.
- *Auto-layout:* the strip stays between the header's title (including its ⌄ chevron) on the left and the header buttons on the right, or a side panel when one is open. If the centred spot would cover the title, it slides right; if there isn't room for both, it stays off the buttons and the end of the title goes under. Only the header's own controls count, so scrolling the conversation never moves it.

### Caveats

- **The endpoint is undocumented.** It's the one claude.ai's own settings page uses, but Anthropic can change it at any time. If the strip shows `usage · –`, that's the likeliest reason.
- Some plans, such as Free, may not report usage at all. The strip and dropdown say so rather than showing wrong numbers.
- Extra-usage credits are shown as a percentage only, not a currency amount, because the unit isn't documented.
- The strip is always dark (`#191919`), as in the design, regardless of Claude's light/dark theme.

## Development

```
npm test        # unit tests for parsing, formatting and the +N% logic (Node 20+, no dependencies)
```

```
manifest.json      MV3 manifest
src/usage.js       pure parsing/formatting/delta helpers (unit-tested)
src/content.js     the strip: UI (shadow DOM), fetching, flip, burn animation, drag
src/flame.js       flame frames for the burn animation (from a LottieFiles animation, Lottie Simple License)
popup.html/css/js  toolbar popup (on/off switch + privacy link)
fonts/             Inter (variable, latin subset) and Bangers (burn word), both SIL Open Font License
test/              node:test unit tests
icons/             16/48/128 px icons
```

### Tweaking the design

All styling is in the `CSS` string near the top of `src/content.js`. The palette is a handful of CSS variables on `.root` (`--bg`, `--line`, `--muted`, `--fg`, `--fire-a`, `--fire-b`). The timings (poll interval, weekly flip interval and hold, burn hold and die-out) are in the `CFG` object at the top of the same file.

## Not affiliated with Anthropic

This is an independent project. Inter is © The Inter Project Authors and Bangers is © The Bangers Project Authors; both are used under the SIL Open Font License 1.1 (see `fonts/LICENSE.txt` and `fonts/Bangers-OFL.txt`). The burn flame (`src/flame.js`) is a modified version of a free flame animation ("VG_Flame_Def") from the LottieFiles community library, used and shared under the [Lottie Simple License](https://lottiefiles.com/page/license); thanks to its creator.
