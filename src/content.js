/*
 * Claude Usage Overlay: content script for claude.ai.
 *
 * A flat strip docked to the top of the page:
 *
 *   [ session · 2h 13m  43% ][ weekly 15% ]
 *     └ gradient progress line along the bottom edge
 *
 *  - the weekly label flips to time-left (the percentage stays put) every ~30s
 *  - when a prompt finishes and session usage jumps (10% -> 15%), the session
 *    cell lights up with a fire animation and shows "+5%" for a few seconds
 *
 * Data comes from the same-origin usage endpoint that Settings > Usage uses,
 * with your existing session. Nothing is sent anywhere else and no chat
 * content is read. The UI lives in a shadow root, so claude.ai's CSS can't
 * touch it.
 */
(function () {
  'use strict';

  if (window.top !== window || document.getElementById('cuo-host')) return;

  const U = globalThis.ClaudeUsage;

  // Timings. Overridable via globalThis.__CUO_CONFIG__ (used by the tests).
  const CFG = Object.assign(
    {
      refreshMs: 30 * 1000, // poll interval while the tab is visible
      minGapMs: 10 * 1000, // never poll (unforced) more often than this
      tickMs: 15 * 1000, // re-render countdowns
      flipEveryMs: 30 * 1000, // weekly: how often the label flips to time-left
      flipHoldMs: 6 * 1000, // weekly: how long time-left stays up
      warnEveryMs: 45 * 1000, // near the limit: how often the warning word shows
      warnHoldMs: 3500, // ...and for how long
      warnFirstMs: 1200, // first warning shortly after crossing a threshold
      relitMs: 3000, // "reloaded" moment after a hit limit resets
      burnHoldMs: 5 * 1000, // flame + word hold
      burnFadeMs: 1600, // slow die-out after the hold
      flameFrameMs: 70, // flame frame step (~14 fps)
      finishCheckMs: 1000, // how often to look for "generation finished"
      finishRefreshAfterMs: [1500, 6000, 15000], // refresh attempts after a prompt finishes
    },
    globalThis.__CUO_CONFIG__ || {}
  );

  const KEY_HIDDEN = 'cuo_hidden';
  const EDGE = 8;
  const PANEL_W = 300;
  const reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  // ---------------------------------------------------------------- storage

  const store = {
    get(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(keys, (v) => resolve(v || {}));
        } catch (e) {
          resolve({});
        }
      });
    },
    set(obj) {
      try {
        chrome.storage.local.set(obj);
      } catch (e) {
        /* extension was reloaded; ignore */
      }
    },
  };

  // ---------------------------------------------------------------- network

  function httpError(status) {
    const e = new Error(`HTTP ${status}`);
    e.status = status;
    return e;
  }

  async function getJson(path) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw httpError(res.status);
    return res.json();
  }

  function cookieOrgId() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function listOrgIds() {
    const orgs = await getJson('/api/organizations');
    if (!Array.isArray(orgs)) return [];
    const chatFirst = [...orgs].sort((a, b) => {
      const ac = (a.capabilities || []).includes('chat') ? 0 : 1;
      const bc = (b.capabilities || []).includes('chat') ? 0 : 1;
      return ac - bc;
    });
    return chatFirst.map((o) => o.uuid).filter(Boolean);
  }

  const maybeWrongOrg = (e) => e && (e.status === 403 || e.status === 404);
  let orgId = null;

  async function loadUsage() {
    const usage = (id) => getJson(`/api/organizations/${id}/usage`);

    if (orgId) {
      try {
        return await usage(orgId);
      } catch (e) {
        if (!maybeWrongOrg(e)) throw e;
        orgId = null;
      }
    }

    const fromCookie = cookieOrgId();
    if (fromCookie) {
      try {
        const data = await usage(fromCookie);
        orgId = fromCookie;
        return data;
      } catch (e) {
        if (!maybeWrongOrg(e)) throw e;
      }
    }

    let lastErr = httpError(404);
    for (const id of await listOrgIds()) {
      try {
        const data = await usage(id);
        orgId = id;
        return data;
      } catch (e) {
        lastErr = e;
        if (!maybeWrongOrg(e)) throw e;
      }
    }
    throw lastErr;
  }

  // ------------------------------------------------------------------ state

  const state = {
    status: 'loading', // loading | ok | unavailable | error
    parsed: { windows: [], extra: null },
    okAt: 0, // last successful fetch
    triedAt: 0, // last attempt (for throttling)
    fetching: false,
    open: false,
    hidden: false,
    weeklyFace: 'pct', // pct (label shows "weekly") | time (label shows time left)
    weeklyView: 0, // 0 normal | 1-3 warning word | 'out' | 'relit'
    flipping: false,
    burn: null, // { delta, word, fading, timer, fadeTimer }
    warn: { session: { level: 0, until: 0, next: 0 }, weekly: { level: 0, until: 0, next: 0 } },
    lastOut: { session: null, weekly: null }, // for the "reloaded" moment
    relitUntil: { session: 0, weekly: 0 },
    test: null, // TEMP-TEST: { session, weekly } usage overrides from the popup
  };

  const snapshotOf = (parsed) => {
    const w = U.pickSession(parsed.windows);
    return w ? { pct: w.pct, resetsAt: w.resetsAt } : null;
  };

  let sawIncreaseSinceFinish = false;

  async function refresh(force) {
    if (state.fetching) return;
    if (!force && Date.now() - state.triedAt < CFG.minGapMs) return;
    state.fetching = true;
    state.triedAt = Date.now();
    renderBusy();
    try {
      const json = await loadUsage();
      const parsed = U.parseUsage(json);
      const now = Date.now();
      const prev = state.status === 'ok' ? snapshotOf(state.parsed) : null;
      const gap = now - state.okAt;
      state.parsed = parsed;
      state.status = 'ok';
      state.okAt = now;
      const delta = U.sessionDelta(prev, snapshotOf(parsed), gap);
      if (delta > 0 && !state.hidden) {
        sawIncreaseSinceFinish = true;
        burn(delta);
      }
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
        state.status = 'unavailable';
      } else if (state.status !== 'ok') {
        state.status = 'error';
      }
      // On transient errors keep showing the last good numbers.
    } finally {
      state.fetching = false;
      render();
    }
  }

  // ------------------------------------------------------------- DOM helpers

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) el.append(kid);
    }
    return el;
  }

  function resetClock(date) {
    return date.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // Inter is bundled so the strip matches the design; falls back to system-ui
  // if the page's CSP blocks the font.
  function injectFont() {
    try {
      const url = chrome.runtime.getURL('fonts/inter-latin-wght-normal.woff2');
      const burnUrl = chrome.runtime.getURL('fonts/bangers-latin-400-normal.woff2');
      const style = document.createElement('style');
      style.textContent =
        '@font-face{font-family:"Cuo Inter";font-style:normal;font-weight:100 900;' +
        `font-display:swap;src:url("${url}") format("woff2");}` +
        // Bangers (SIL OFL) is only used for the burn word.
        '@font-face{font-family:"Cuo Bangers";font-style:normal;font-weight:400;' +
        `font-display:swap;src:url("${burnUrl}") format("woff2");}`;
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------- CSS

  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.root {
  --bg: #191919; --line: #353535; --muted: #9e9e9e; --fg: #efefef;
  --fire-a: #ff5500; --fire-b: #f28d00;
  --h: 45px; /* header height incl. its separator; measured from the page at runtime */
  --bw: 1px; /* separator thickness; the progress line is exactly this thick */
  position: fixed; top: 0; left: 0; z-index: 2147483000;
  height: var(--h);
  display: flex; align-items: flex-start;
  font: 400 14px/17px "Cuo Inter", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.root[hidden] { display: none; }

/* ---------- cells ---------- */
.cell {
  position: relative; isolation: isolate;
  height: calc(var(--h) - var(--bw)); margin: 0; padding: 0 16px;
  background: var(--bg); color: inherit; font: inherit;
  border: 0 solid var(--line); border-width: 0 1px 0 1px; border-radius: 0;
  cursor: pointer;
}
.cell + .cell { border-left-width: 0; }
.cell:focus-visible { outline: 1px solid var(--muted); outline-offset: -4px; }
.cell[hidden] { display: none; }

/* The session cell's bottom edge is the progress line itself (2px), not a border. */
.session { display: grid; min-width: 195px; padding: 0; }
/* If the page's separator can't be found, draw our own 1px bottom edge instead. */
.root.fallback .cell { height: var(--h); border-bottom-width: var(--bw); }
.weekly { display: flex; align-items: center; gap: 16px; }
.weekly > .flip, .weekly > .val { position: relative; z-index: 1; }

.face {
  grid-area: 1 / 1; z-index: 1;
  display: flex; align-items: center; justify-content: center; gap: 16px;
  transition: opacity 260ms ease, transform 260ms ease;
}
.head { display: flex; align-items: center; gap: 8px; }
.eta { font-size: 12px; } /* countdown a touch smaller than the label and percentage (14px) */
.dot { width: 2px; height: 2px; flex: none; border-radius: 50%; background: var(--muted); }
.pct, .val { font-weight: 500; color: var(--fg); }
.val { display: inline-block; min-width: 42px; }
/* weekly label: flips to the time left. Fixed slot so the cell doesn't jump between the two. */
.wl { display: inline-block; min-width: 52px; text-align: right; backface-visibility: hidden; }
.wl.time { font-size: 12px; }
.flip { display: inline-block; perspective: 240px; }

/* ---------- progress line (session utilisation) ---------- */
.line { position: absolute; left: -1px; right: -1px; top: 100%; height: var(--bw); z-index: 2; pointer-events: none; }
.fill {
  display: block; height: 100%; width: 0;
  background: linear-gradient(90deg, var(--fire-a), var(--fire-b));
  transition: width 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* ---------- burn state ---------- */
/* Orange tint + a jet-thrust flame fill the session cell. The fun word and +N% take the
   label/percentage slots and glow light yellow on top of it. */
.fx { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
/* --p (0..1) is the burn's power, set from the size of the jump: bigger jump = bigger,
   faster, hotter flame (see burnPower in usage.js). */
.session { --p: 0; }
.tint {
  position: absolute; inset: 0; opacity: 0;
  background: linear-gradient(270deg,
    rgba(255, 90, 10, calc(0.26 + 0.2 * var(--p))),
    rgba(255, 130, 20, calc(0.09 + 0.12 * var(--p))) 70%,
    rgba(255, 130, 20, calc(0.04 + 0.08 * var(--p))));
  transition: opacity 400ms ease;
}
.session.burning .tint { opacity: 1; animation: cuo-tint calc(300ms - 160ms * var(--p)) steps(1, end) infinite; }
.session.burning.fading .tint { opacity: 0; animation: none; transition: opacity 1500ms ease-in; }
.thrust {
  position: absolute; right: -3%; top: calc(-6% - 20% * var(--p)); width: calc(100% + 40% * var(--p)); height: calc(112% + 40% * var(--p));
  transform-origin: 100% 50%; transform: translateX(100%); opacity: 0;
}
.session.burning .thrust {
  opacity: 1; transform: none;
  transition: transform calc(230ms - 120ms * var(--p)) cubic-bezier(0.05, 0.9, 0.2, 1), opacity 60ms linear;
}
.session.burning.fading .thrust {
  opacity: 0; transform: translateX(30%) scaleX(0.7);
  transition: transform 1500ms ease-in, opacity 1500ms ease-in;
}
.thrust g.f { display: none; }
.thrust g.f.on { display: inline; }
.session.burning .head > span, .session.burning .head > .dot, .session.burning .pct {
  color: #fff1a8;
  text-shadow: 0 0 calc(6px + 8px * var(--p)) rgba(255, 214, 102, calc(0.4 + 0.4 * var(--p))), 0 0 2px rgba(70, 15, 0, 0.85), 0 1px 1px rgba(70, 15, 0, 0.8);
  transition: color 300ms ease, text-shadow 300ms ease;
}
.session.burning .head > .dot { background: #fff1a8; box-shadow: none; }
.session.burning .pct { font-weight: 600; }
/* The fun word: Bangers (comic caps), falls back to Inter if the font can't load. */
.session.burning .head > span:first-child {
  font-family: "Cuo Bangers", "Cuo Inter", Inter, system-ui, sans-serif;
  font-weight: 400; font-size: 18px; letter-spacing: 0.04em;
}
.session.burning.fading .head > span, .session.burning.fading .pct {
  color: var(--fg); text-shadow: none; transition: color 1500ms ease-in, text-shadow 1500ms ease-in;
}
.session.burning.fading .head > span { color: var(--muted); }
@keyframes cuo-tint { 0% { opacity: 1; } 35% { opacity: 0.72; } 60% { opacity: 0.9; } 80% { opacity: 0.6; } }


/* ---------- heat: nearing the limit ---------- */
/* Progress line heats up: 80% hot, 90% red-orange, 95% red with a slow pulse.
   Weekly only shows its line once it is heating up. */
.weekly .line { opacity: 0; transition: opacity 600ms ease; }
.weekly.heat-1 .line, .weekly.heat-2 .line, .weekly.heat-3 .line, .weekly.out .line { opacity: 1; }
.heat-1 .fill { background: linear-gradient(90deg, #ff7a00, #ffae1a); box-shadow: 0 0 4px rgba(255, 150, 20, 0.55); }
.heat-2 .fill { background: linear-gradient(90deg, #ff4a10, #ff7a1a); box-shadow: 0 0 5px rgba(255, 80, 20, 0.6); }
.heat-3 .fill { background: linear-gradient(90deg, #f02a1a, #ff5a2a); box-shadow: 0 0 6px rgba(240, 50, 30, 0.7);
  animation: cuo-pulse 2400ms ease-in-out infinite; }
@keyframes cuo-pulse { 50% { opacity: 0.5; } }

/* Warning word ("running hot" / "redline" / "last drop"), shown for a few seconds now and then. */
.warn-1 { color: #e9a85a !important; }
.warn-2 { color: #f08a5e !important; }
.warn-3 { color: #f07060 !important; }
.weekly.heat-1 .wl, .weekly.heat-2 .wl, .weekly.heat-3 .wl { min-width: 72px; } /* room for the word, no jump */

/* Northern-lights glow from 90% to the limit: soft blurred light drifting along the bottom
   half of the strip, amber at 90% warming to a gentle red at 100%. --q = 0..1, --heat = r,g,b */
.root { --q: 0; --heat: 255, 160, 40; }
.aurora {
  position: absolute; left: -30%; right: -30%; bottom: -35%; height: 90%;
  opacity: 0; filter: blur(9px); transition: opacity 1400ms ease;
}
.root.aurora-on .cell:not(.out):not(.burning) .aurora { opacity: calc(0.6 + 0.4 * var(--q)); }
.aurora i {
  position: absolute; bottom: 0; width: 55%; height: 100%; border-radius: 50%;
  background: radial-gradient(ellipse at 50% 100%, rgba(var(--heat), calc(0.30 + 0.16 * var(--q))), rgba(var(--heat), 0) 70%);
}
.aurora i:nth-child(1) { left: 0; animation: cuo-aur-a 13s ease-in-out infinite alternate; }
.aurora i:nth-child(2) { left: 25%; animation: cuo-aur-b 17s ease-in-out infinite alternate; opacity: 0.8; }
.aurora i:nth-child(3) { left: 48%; animation: cuo-aur-c 11s ease-in-out infinite alternate; opacity: 0.9; }
@keyframes cuo-aur-a { 0% { transform: translateX(-10%) scaleY(0.75); } 50% { transform: translateX(25%) scaleY(1.05); } 100% { transform: translateX(45%) scaleY(0.85); } }
@keyframes cuo-aur-b { 0% { transform: translateX(20%) scaleY(1); } 50% { transform: translateX(-20%) scaleY(0.7); } 100% { transform: translateX(10%) scaleY(1.1); } }
@keyframes cuo-aur-c { 0% { transform: translateX(10%) scaleY(0.9); } 50% { transform: translateX(-30%) scaleY(1.15); } 100% { transform: translateX(-5%) scaleY(0.8); } }

/* Burn tie-in: at 90%+ the flame burns red. */
.session.hot .thrust g.f { fill: url(#cuo-thrust-red); }
.session.hot .tint {
  background: linear-gradient(270deg, rgba(225, 40, 20, calc(0.28 + 0.2 * var(--p))),
    rgba(230, 60, 30, calc(0.1 + 0.12 * var(--p))) 70%, rgba(230, 60, 30, calc(0.05 + 0.08 * var(--p))));
}

/* ---------- burnt out: the limit is hit ---------- */
/* Charred cell, ash-grey text, a faint ember smoulder along the bottom, line burnt full. */
.cell.out { background: #110d0c; }
.char { position: absolute; inset: 0; opacity: 0; transition: opacity 1200ms ease; }
.cell.out .char { opacity: 1; }
.char::before {
  content: ''; position: absolute; inset: 0;
  background:
    radial-gradient(120% 70% at 50% 135%, rgba(150, 40, 12, 0.32), rgba(150, 40, 12, 0) 70%),
    linear-gradient(180deg, rgba(0, 0, 0, 0) 40%, rgba(60, 18, 8, 0.25));
  animation: cuo-smoulder 5200ms ease-in-out infinite;
}
.char i {
  position: absolute; bottom: 3px; width: 2px; height: 2px; border-radius: 50%;
  background: #ff7a3a; box-shadow: 0 0 4px 1px rgba(255, 100, 40, 0.7); opacity: 0;
  animation: cuo-ember-glow 4200ms ease-in-out infinite;
}
.char i:nth-child(1) { left: 18%; animation-delay: 0s; }
.char i:nth-child(2) { left: 52%; bottom: 5px; animation-delay: 1.6s; animation-duration: 5000ms; }
.char i:nth-child(3) { left: 81%; animation-delay: 2.9s; animation-duration: 3800ms; }
@keyframes cuo-smoulder { 50% { opacity: 0.55; } }
@keyframes cuo-ember-glow { 0%, 100% { opacity: 0; } 45% { opacity: 0.85; } 70% { opacity: 0.3; } }
.cell.out .head > span, .cell.out .wl { color: #857a74; }
.cell.out .pct, .cell.out .val { color: #c88a6c; }
.cell.out .dot { background: #5e5450; }
.cell.out .fill { width: 100% !important; background: linear-gradient(90deg, #4a150a, #8a2a12); box-shadow: 0 0 4px rgba(140, 40, 15, 0.6); }

/* ---------- reloaded: a hit limit just reset ---------- */
.glint { position: absolute; inset: 0; opacity: 0; }
.cell.relit .glint {
  background: linear-gradient(100deg, rgba(255, 230, 170, 0) 30%, rgba(255, 230, 170, 0.16) 50%, rgba(255, 230, 170, 0) 70%);
  background-size: 250% 100%; animation: cuo-glint 1300ms ease-out 1 forwards;
}
.cell.relit .head > span:first-child, .cell.relit .wl { color: #f3dca0; }
.cell.relit .fill { animation: cuo-refill 900ms cubic-bezier(0.2, 0.7, 0.2, 1) 1; transform-origin: 0 50%; }
@keyframes cuo-glint { 0% { opacity: 1; background-position: 100% 0; } 100% { opacity: 1; background-position: 0 0; } }
@keyframes cuo-refill { from { transform: scaleX(0); } }

/* ---------- details dropdown ---------- */
.panel {
  position: absolute; top: 100%; width: ${PANEL_W}px; z-index: 5;
  padding: 14px 16px 8px; background: var(--bg);
  border: 1px solid var(--line); border-top: 0; border-radius: 0;
  user-select: text; cursor: default;
}
.panel.align-left { left: 0; }
.panel.align-right { right: 0; }
.panel[hidden] { display: none; }
.row + .row { margin-top: 14px; }
.row-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.row-title { color: var(--fg); font-weight: 500; }
.row-detail { margin-left: 8px; font-variant-numeric: normal; }
.row-pct { color: var(--fg); font-weight: 500; }
.bar { height: 2px; margin-top: 8px; background: var(--line); }
.bar > span {
  display: block; height: 100%;
  background: linear-gradient(90deg, var(--fire-a), var(--fire-b));
  transition: width 500ms ease;
}
.row-reset { margin-top: 6px; font-size: 12px; line-height: 15px; }
.note { padding: 2px 0 6px; }
.foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px;
}
.foot-actions { display: flex; gap: 2px; }
.btn {
  border: 0; border-radius: 0; background: transparent; color: var(--muted);
  font: inherit; font-size: 12px; padding: 3px 6px; cursor: pointer;
}
.btn:hover { background: #262626; color: var(--fg); }
.btn:focus-visible { outline: 1px solid var(--muted); outline-offset: 1px; }
.btn.spin svg { animation: cuo-spin 900ms linear infinite; }
@keyframes cuo-spin { to { transform: rotate(360deg); } }

.sr {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .face, .fill, .bar > span, .tint, .thrust, .session *, .weekly *, .aurora, .char { transition: none !important; }
  .session.burning .tint { animation: none; opacity: 0.85; }
  .aurora i, .char::before, .heat-3 .fill, .cell.relit .glint, .cell.relit .fill { animation: none !important; }
  .char i { animation: none; opacity: 0.5; }
}
`;

  // ------------------------------------------------------------------ build

  // Flame frames live in src/flame.js (generated). Built once; only one frame is visible at a time.
  const FLAME = window.ClaudeFlame;
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  const flameFrames = [];
  function buildThrust() {
    const svg = svgEl('svg', {
      class: 'thrust', viewBox: `0 0 ${FLAME.w} ${FLAME.h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
    });
    const defs = svgEl('defs', {});
    const grad = svgEl('linearGradient', { id: 'cuo-thrust', gradientUnits: 'userSpaceOnUse', x1: FLAME.w, y1: 0, x2: 0, y2: 0 });
    // Deep red-orange at the nozzle (under the number), thinning out toward the word so both stay legible.
    [['0', '#b82a07', '1'], ['0.4', '#cc380a', '0.95'], ['1', '#ec6218', '0.5']].forEach(([o, c, a]) =>
      grad.appendChild(svgEl('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));
    defs.appendChild(grad);
    // Red version for burns at 90%+ (the nozzle stays dark so the number stays readable).
    const red = svgEl('linearGradient', { id: 'cuo-thrust-red', gradientUnits: 'userSpaceOnUse', x1: FLAME.w, y1: 0, x2: 0, y2: 0 });
    [['0', '#9e1408', '1'], ['0.4', '#c01f0c', '0.95'], ['1', '#e04424', '0.5']].forEach(([o, c, a]) =>
      red.appendChild(svgEl('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));
    defs.appendChild(red);
    svg.appendChild(defs);
    FLAME.frames.forEach((paths) => {
      const g = svgEl('g', { class: 'f', fill: 'url(#cuo-thrust)' });
      paths.forEach((d) => g.appendChild(svgEl('path', { d })));
      svg.appendChild(g);
      flameFrames.push(g);
    });
    return svg;
  }

  const host = document.createElement('div');
  host.id = 'cuo-host';
  const shadow = host.attachShadow({ mode: 'open' });

  // session cell
  const labelEl = h('span', {}, 'session');
  const dotEl = h('i', { class: 'dot' });
  const etaEl = h('span', { class: 'eta' });
  const pctEl = h('span', { class: 'pct' });
  const auroraEl = () => h('span', { class: 'aurora' }, h('i'), h('i'), h('i'));
  const charEl = () => h('span', { class: 'char' }, h('i'), h('i'), h('i'));
  const fillEl = h('span', { class: 'fill' });

  const sessionBtn = h('button', { class: 'cell session', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    h('span', { class: 'fx', 'aria-hidden': 'true' }, auroraEl(), charEl(), h('span', { class: 'glint' }),
      h('span', { class: 'tint' }), buildThrust()),
    h('span', { class: 'face normal' },
      h('span', { class: 'head' }, labelEl, dotEl, etaEl),
      pctEl),
    h('span', { class: 'line' }, fillEl));

  // weekly cell
  const wLabelEl = h('span', { class: 'wl' }, 'weekly');
  const valEl = h('span', { class: 'val' });
  const wFillEl = h('span', { class: 'fill' });
  const weeklyBtn = h('button', { class: 'cell weekly', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true },
    h('span', { class: 'fx', 'aria-hidden': 'true' }, auroraEl(), charEl(), h('span', { class: 'glint' })),
    h('span', { class: 'flip' }, wLabelEl), valEl,
    h('span', { class: 'line' }, wFillEl));

  // dropdown
  const bodyEl = h('div');
  const updatedEl = h('span');
  const refreshBtn = h('button', {
    class: 'btn', type: 'button', 'aria-label': 'Refresh usage', title: 'Refresh now',
    onclick: () => refresh(true),
  });
  refreshBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  const hideBtn = h('button', {
    class: 'btn', type: 'button',
    title: 'Hide the overlay. Turn it back on from the extension icon in the toolbar.',
    onclick: () => setHidden(true),
  }, 'Hide');
  const panel = h('div', { class: 'panel align-left', role: 'region', 'aria-label': 'Claude usage details', hidden: true },
    bodyEl,
    h('div', { class: 'foot' }, updatedEl, h('div', { class: 'foot-actions' }, refreshBtn, hideBtn)));

  const live = h('div', { class: 'sr', 'aria-live': 'polite' });
  const rootEl = h('div', { class: 'root', role: 'group', 'aria-label': 'Claude usage' }, sessionBtn, weeklyBtn, panel, live);
  shadow.append(h('style', {}, CSS), rootEl);

  // ----------------------------------------------------------------- render

  /** Weekly label: "weekly", or the time left while it is flipped. */
  function weeklyText() {
    const w = weeklyWindow();
    if (!w) return '';
    if (state.weeklyView === 'out') return w.resetsAt ? `back ${U.formatResetAt(w.resetsAt)}` : 'maxed';
    if (state.weeklyView === 'relit') return 'reloaded';
    if (state.weeklyView > 0) return U.WARN_WORDS[state.weeklyView];
    if (state.weeklyFace === 'time' && w.resetsAt) {
      const ms = w.resetsAt.getTime() - Date.now();
      return ms > 0 ? U.formatCountdown(ms) : '…';
    }
    return 'weekly';
  }

  function setWeeklyLabel(text) {
    wLabelEl.textContent = text;
    const v = state.weeklyView;
    wLabelEl.classList.toggle('time', text !== 'weekly' && !(v > 0) && v !== 'relit');
    setWarnClass(wLabelEl, typeof v === 'number' && text === U.WARN_WORDS[v] ? v : 0);
  }

  // TEMP-TEST: the popup can override the percentages to preview each state.
  const withTest = (w, key) => (w && state.test && state.test[key] != null ? Object.assign({}, w, { pct: state.test[key] }) : w);
  const rawSession = () => U.pickSession(state.parsed.windows);
  const sessionWindow = () => withTest(rawSession(), 'session');
  const weeklyWindow = () => withTest(U.pickWeekly(state.parsed.windows, rawSession()), 'weekly');

  /** Warning word schedule for one cell: shows for a few seconds now and then while heating up. */
  function warnFor(key, level, now) {
    const w = state.warn[key];
    if (level < 1 || level > 3) {
      w.level = 0; w.until = 0;
      return 0;
    }
    if (level > w.level) w.next = now + CFG.warnFirstMs; // crossed a threshold: say so soon
    w.level = level;
    if (now >= w.next) {
      w.until = now + CFG.warnHoldMs;
      w.next = now + CFG.warnEveryMs;
      schedule(CFG.warnHoldMs + 50);
    }
    if (now < w.until) return level;
    schedule(w.next - now + 20);
    return 0;
  }

  /** "Reloaded" moment: a limit that was hit has reset. */
  function relitFor(key, out, now) {
    if (state.lastOut[key] === true && !out) {
      state.relitUntil[key] = now + CFG.relitMs;
      schedule(CFG.relitMs + 50);
    }
    state.lastOut[key] = out;
    return now < state.relitUntil[key];
  }

  // One pending re-render for timed effects (warning words, reloaded); the regular tick is slow.
  let fxTimer = 0;
  let fxAt = Infinity;
  function schedule(ms) {
    const at = Date.now() + Math.max(0, ms);
    if (fxTimer && at >= fxAt) return;
    clearTimeout(fxTimer);
    fxAt = at;
    fxTimer = setTimeout(() => { fxTimer = 0; fxAt = Infinity; render(); }, Math.max(0, ms));
  }

  function setHeatClass(el, level) {
    for (let i = 1; i <= 3; i++) el.classList.toggle(`heat-${i}`, level === i);
  }
  function setWarnClass(el, level) {
    for (let i = 1; i <= 3; i++) el.classList.toggle(`warn-${i}`, level === i);
  }

  function renderBusy() {
    refreshBtn.classList.toggle('spin', state.fetching);
  }

  function renderStrip(now) {
    const s = state.status === 'ok' ? sessionWindow() : null;

    const wRaw = s ? weeklyWindow() : null;
    const weeklyOut = !!wRaw && U.heatLevel(wRaw.pct) === 4;
    const burningNow = !!(state.burn && s);
    let sessionOut = false;
    let sLevel = 0;
    let sWarn = 0;
    let sRelit = false;

    if (s) {
      const pct = Math.round(s.pct);
      const ms = s.resetsAt ? s.resetsAt.getTime() - now : null;
      const eta = ms == null ? '' : ms > 0 ? U.formatCountdown(ms) : 'resetting';
      sLevel = U.heatLevel(s.pct);
      sessionOut = sLevel === 4;
      // If the weekly limit is hit, that is what blocks you: session goes on hold, weekly shows when it's back.
      const blocked = sessionOut || weeklyOut;
      sRelit = relitFor('session', blocked, now);
      sWarn = blocked || burningNow ? 0 : warnFor('session', sLevel, now);
      let label = U.shortLabel(s);
      let sub = eta;
      if (weeklyOut) {
        label = 'on hold'; sub = ''; // the weekly cell says when it's back
      } else if (sessionOut) {
        label = ms != null && ms > 0 ? 'back in' : 'resetting'; sub = ms != null && ms > 0 ? eta : '';
      } else if (sRelit) {
        label = 'reloaded'; sub = '';
      } else if (sWarn) {
        label = U.WARN_WORDS[sWarn]; sub = '';
      }
      labelEl.textContent = label;
      setWarnClass(labelEl, sWarn);
      etaEl.textContent = sub;
      etaEl.hidden = dotEl.hidden = !sub;
      pctEl.textContent = `${pct}%`;
      fillEl.style.width = `${Math.min(100, s.pct)}%`;
      const aria = `${U.shortLabel(s)} usage ${pct}%` + (sessionOut ? ', limit reached' : '')
        + (weeklyOut && wRaw.resetsAt ? `, weekly limit reached, back ${U.formatResetAt(wRaw.resetsAt, now)}` : eta ? `, resets in ${eta}` : '')
        + '. Show details.';
      sessionBtn.setAttribute('aria-label', aria);
      sessionBtn.title = '';
    } else {
      const loading = state.status === 'loading';
      labelEl.textContent = loading ? 'session' : 'usage';
      etaEl.hidden = dotEl.hidden = true;
      pctEl.textContent = loading ? '…' : '–';
      setWarnClass(labelEl, 0);
      fillEl.style.width = '0';
      const msg = loading ? 'Loading usage' : 'Usage unavailable';
      sessionBtn.setAttribute('aria-label', `${msg}. Show details.`);
      sessionBtn.title = msg;
    }

    const w = wRaw;
    weeklyBtn.hidden = !w;
    let wLevel = 0;
    if (w) {
      if (!w.resetsAt && state.weeklyFace === 'time') state.weeklyFace = 'pct';
      wLevel = U.heatLevel(w.pct);
      const wRelit = relitFor('weekly', wLevel === 4, now);
      const wWarn = wLevel === 4 ? 0 : warnFor('weekly', wLevel, now);
      const view = wLevel === 4 ? 'out' : wRelit ? 'relit' : wWarn || 0;
      const changed = view !== state.weeklyView;
      state.weeklyView = view;
      valEl.textContent = `${Math.round(w.pct)}%`;
      wFillEl.style.width = `${Math.min(100, w.pct)}%`;
      setHeatClass(weeklyBtn, wLevel);
      weeklyBtn.classList.toggle('out', wLevel === 4);
      weeklyBtn.classList.toggle('relit', wRelit);
      if (changed && !state.flipping && view !== 'out') flipLabel(weeklyText());
      else if (!state.flipping) setWeeklyLabel(weeklyText());
      const reset = w.resetsAt ? `, resets in ${U.formatCountdown(w.resetsAt.getTime() - now)}` : '';
      weeklyBtn.setAttribute('aria-label', `weekly usage ${Math.round(w.pct)}%${reset}. Show details.`);
    }

    const burning = burningNow;
    setHeatClass(sessionBtn, burning ? 0 : sLevel);
    sessionBtn.classList.toggle('out', !burning && (sessionOut || weeklyOut));
    sessionBtn.classList.toggle('relit', !burning && sRelit);
    sessionBtn.classList.toggle('hot', burning && s.pct >= 90);

    // Northern-lights glow while either limit is 90-99%.
    const near = [s, w].filter((x) => x && U.heatLevel(x.pct) < 4).map((x) => x.pct);
    const q = near.length ? Math.max(...near.map(U.auroraStrength)) : 0;
    const glowOn = near.some((p) => p >= 90);
    rootEl.classList.toggle('aurora-on', glowOn);
    if (glowOn) {
      rootEl.style.setProperty('--q', q.toFixed(3));
      rootEl.style.setProperty('--heat', U.heatRgb(q));
    }
    sessionBtn.classList.toggle('burning', burning);
    sessionBtn.classList.toggle('fading', burning && state.burn.fading);
    if (burning) {
      sessionBtn.style.setProperty('--p', String(U.burnPower(state.burn.delta)));
      labelEl.textContent = state.burn.word;
      setWarnClass(labelEl, 0);
      pctEl.textContent = `+${state.burn.delta}%`;
    }
    // During a burn only the word and +N% show; the countdown comes back afterwards.
    if (burning) etaEl.hidden = dotEl.hidden = true;
    setThrust(burning, burning ? U.burnPower(state.burn.delta) : 0);
  }

  function barRow(win, now) {
    const pct = Math.round(win.pct);
    let reset = null;
    if (win.resetsAt) {
      const ms = win.resetsAt.getTime() - now;
      reset = h('div', { class: 'row-reset' },
        ms <= 0 ? 'Resetting…' : `Resets in ${U.formatCountdown(ms)} · ${resetClock(win.resetsAt)}`);
    }
    return h('div', { class: 'row' },
      h('div', { class: 'row-head' },
        h('span', { class: 'row-title' }, win.label,
          win.detail ? h('span', { class: 'row-detail' }, win.detail) : null),
        h('span', { class: 'row-pct' }, `${pct}%`)),
      h('div', {
        class: 'bar', role: 'progressbar',
        'aria-label': `${win.label} ${win.detail}`.trim(),
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
      }, h('span', { style: `width:${win.pct}%` })),
      reset);
  }

  function renderPanel(now) {
    const nodes = [];
    if (state.status === 'loading') {
      nodes.push(h('div', { class: 'note' }, 'Loading…'));
    } else if (state.status === 'unavailable' && !state.parsed.windows.length) {
      nodes.push(h('div', { class: 'note' },
        'Usage isn’t available right now. You may be signed out, or this plan doesn’t report usage.'));
    } else if (state.status === 'error' && !state.parsed.windows.length) {
      nodes.push(h('div', { class: 'note' }, 'Couldn’t reach claude.ai. Will retry shortly.'));
    } else {
      for (const w of state.parsed.windows) nodes.push(barRow(w, now));
      const extra = state.parsed.extra;
      if (extra && extra.enabled && extra.pct != null) {
        nodes.push(barRow({ label: 'Extra usage', detail: 'Usage credits', pct: extra.pct, resetsAt: null }, now));
      }
      if (!nodes.length) nodes.push(h('div', { class: 'note' }, 'No usage limits reported for this account.'));
    }
    bodyEl.replaceChildren(...nodes);
    updatedEl.textContent = state.okAt ? `Updated ${U.formatAgo(now - state.okAt)}` : '';
    renderBusy();
  }

  function render() {
    const now = Date.now();
    rootEl.hidden = state.hidden;
    renderStrip(now);
    if (state.open) renderPanel(now);
  }

  // ------------------------------------------------------------ fire (burn)

  function announce(text) {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 50);
  }

  let thrustTimer = 0;
  let thrustMs = 0;
  let frameIdx = 0;
  function showFrame(i) {
    flameFrames.forEach((g, n) => g.classList.toggle('on', n === i));
  }
  /** Runs the frame loop only while the burn is on screen; static frame under reduced motion. */
  function setThrust(on, power = 0) {
    // Bigger burns flicker faster; restart the loop if the power changed (stacked burns).
    const ms = Math.round(CFG.flameFrameMs - 30 * power);
    if (on && thrustTimer > 0 && ms !== thrustMs) setThrust(false);
    if (on && !thrustTimer) {
      thrustMs = ms;
      if (reducedMotion) {
        showFrame(4);
        thrustTimer = -1;
      } else {
        showFrame(frameIdx);
        thrustTimer = setInterval(() => {
          frameIdx = (frameIdx + 1) % flameFrames.length;
          showFrame(frameIdx);
        }, ms);
      }
    } else if (!on && thrustTimer) {
      if (thrustTimer > 0) clearInterval(thrustTimer);
      thrustTimer = 0;
    }
  }

  function burn(delta, opts = {}) {
    // A burn that arrives while the previous one is dying out starts a fresh burst.
    const fresh = opts.fresh || !state.burn || state.burn.fading;
    const total = (fresh ? 0 : state.burn.delta) + delta;
    if (state.burn) { clearTimeout(state.burn.timer); clearTimeout(state.burn.fadeTimer); }
    state.burn = {
      delta: total,
      word: opts.word || U.pickBurnWord(total),
      fading: false,
      timer: setTimeout(fadeBurn, CFG.burnHoldMs),
      fadeTimer: 0,
    };
    announce(`Session usage up ${total}%`);
    render();
  }

  function fadeBurn() {
    if (!state.burn) return;
    state.burn.fading = true;
    state.burn.fadeTimer = setTimeout(endBurn, reducedMotion ? 0 : CFG.burnFadeMs);
    render();
  }

  function endBurn() {
    state.burn = null;
    render();
  }

  // ------------------------------------------------------------- weekly flip

  function flipLabel(text) {
    if (reducedMotion || typeof wLabelEl.animate !== 'function') {
      setWeeklyLabel(text);
      return;
    }
    state.flipping = true;
    const anims = [];
    let done = false;
    // Always end in a clean, visible state, even if the animation is throttled
    // (background tab) and its finish events are delayed or never fire.
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      anims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
      state.flipping = false;
      setWeeklyLabel(weeklyText());
    };
    const safety = setTimeout(finish, 800);

    const out = wLabelEl.animate(
      [{ transform: 'rotateX(0deg)', opacity: 1 }, { transform: 'rotateX(-90deg)', opacity: 0 }],
      { duration: 140, easing: 'ease-in', fill: 'forwards' });
    anims.push(out);
    out.onfinish = () => {
      if (done) return;
      setWeeklyLabel(text);
      out.cancel();
      const back = wLabelEl.animate(
        [{ transform: 'rotateX(90deg)', opacity: 0 }, { transform: 'rotateX(0deg)', opacity: 1 }],
        { duration: 180, easing: 'ease-out' });
      anims.push(back);
      back.onfinish = finish;
    };
  }

  function setWeeklyFace(face) {
    state.weeklyFace = face;
    flipLabel(weeklyText());
  }

  let flipTimer = null;
  function scheduleFlip() {
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => {
      const w = weeklyWindow();
      if (!state.hidden && document.visibilityState === 'visible' && w && w.resetsAt && !state.weeklyView) {
        setWeeklyFace('time');
        flipTimer = setTimeout(() => {
          setWeeklyFace('pct');
          scheduleFlip();
        }, CFG.flipHoldMs);
      } else {
        scheduleFlip();
      }
    }, CFG.flipEveryMs);
  }

  // ---------------------------------------------------- "prompt finished" watch

  // While Claude is replying, the composer shows a stop button. When it goes
  // away, a prompt has finished: re-check usage right away (usage accounting
  // can lag a moment, so retry a couple of times if nothing changed yet).
  // If this heuristic ever stops matching, the regular poll still catches the
  // jump; it just shows up a little later.
  const STOP_SELECTOR =
    'button[aria-label="Stop response"], button[aria-label="Stop generating"], button[data-testid="stop-button"]';
  let wasGenerating = false;
  let finishTimers = [];

  function onPromptFinished() {
    finishTimers.forEach(clearTimeout);
    sawIncreaseSinceFinish = false;
    finishTimers = CFG.finishRefreshAfterMs.map((ms, i) =>
      setTimeout(() => {
        if (i === 0 || !sawIncreaseSinceFinish) refresh(true);
      }, ms));
  }

  // ---------------------------------------------------------- open / position

  // ----------------------------------------------- alignment with the page

  const FALLBACK_H = 45; // claude.ai: 44px bar + 1px separator (measured from a screenshot)
  const dpr = () => window.devicePixelRatio || 1;
  const round2 = (n) => Math.round(n * 100) / 100;
  const layoutCache = { left: NaN, h: NaN, bw: NaN, fallback: null };
  let composerRef = null;

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };

  // The vertical axis the strip is centred on: the message composer. It is
  // centred in the chat column, which is the middle of the space between the
  // chat title (left) and the header buttons (right), and it follows the
  // sidebar / side panel opening and closing. Falls back to <main>, then to
  // the viewport centre.
  function findAxis() {
    if (composerRef && composerRef.isConnected) {
      const r = rectOf(composerRef);
      if (r && r.width >= 200) return r.left + r.width / 2;
    }
    composerRef = null;
    for (const el of document.querySelectorAll('[contenteditable="true"], textarea')) {
      const r = rectOf(el);
      if (r && r.width >= 200 && r.bottom > 0 && r.top < window.innerHeight) {
        composerRef = el.closest('fieldset') || el;
        const cr = rectOf(composerRef) || r;
        return cr.left + cr.width / 2;
      }
    }
    const main = document.querySelector('main');
    const mr = main && rectOf(main);
    if (mr && mr.width >= 300) return mr.left + mr.width / 2;
    return window.innerWidth / 2;
  }

  // Find the page header's separator (its bottom border) so the strip can end
  // exactly on it. Returns {bottom, bw} or null.
  function measureSeparator(axisX) {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const vw = window.innerWidth;
    const cands = new Set(document.querySelectorAll('header, [role="banner"]'));
    for (const x of [axisX, vw * 0.25, vw * 0.75]) {
      const px = Math.min(Math.max(x, 1), vw - 1);
      for (const hit of document.elementsFromPoint(px, 12)) {
        // The title-bar wrapper can be pointer-events:none (so hit-testing skips
        // it), but it is always an ancestor of something that is hit.
        let el = hit;
        for (let i = 0; i < 8 && el && el !== document.body; i++, el = el.parentElement) cands.add(el);
      }
    }

    const infos = [];
    const band = [];
    bandEls = band;
    for (const el of cands) {
      if (el === host || el === document.documentElement || el === document.body) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const hasBorder = cs.borderBottomStyle !== 'none' && cs.borderBottomStyle !== 'hidden';
      infos.push({
        kind: 'border',
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        bw: hasBorder ? parseFloat(cs.borderBottomWidth) || 0 : 0,
      });
      if (r.top <= 4 && r.bottom <= 90) band.push(el);
    }

    // claude.ai draws the separator as a hairline element (a pointer-events:none
    // div about one device pixel tall), not as a border. Hit-testing can't see
    // it, but it is a child of something in the header band, so look there.
    const lookAt = (el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height <= 3) {
        infos.push({ kind: 'line', top: r.top, bottom: r.bottom, width: r.width });
      }
    };
    for (const el of band) {
      for (const child of Array.from(el.children).slice(0, 40)) {
        lookAt(child);
        for (const grand of Array.from(child.children).slice(0, 20)) lookAt(grand);
      }
    }
    return U.pickSeparator(infos);
  }

  // Returns true if anything moved/resized (used to keep the frame loop alive
  // while the page animates, e.g. the sidebar sliding open).
  let sepCache = null;
  let scanDue = true;
  let itemsDue = true;
  let bandEls = [];
  let headerItems = [];
  let headerBox = { l: 0, r: window.innerWidth };

  // What the page header already shows (chat title text, buttons, icons), as horizontal
  // extents, so the strip can slide right instead of covering a long title.
  const CTL_SELECTOR = 'button, a[href], input, select, textarea, [role="button"], [contenteditable="true"], img, svg';
  // A real button is small with a short label ("Share", "Step 3 of 5"). A long label (the
  // renamable chat title, a breadcrumb link) is text the strip may cover if it must.
  // An icon inside a button or link (like the chevron next to the chat title) belongs to it.
  const BTN_SELECTOR = 'button, a[href], input, select, textarea, [role="button"], [contenteditable="true"]';
  const controlOf = (el) => el.closest(BTN_SELECTOR) || el.closest('img, svg');
  const isButton = (el, r) => r.width < 160 && (el.textContent || '').trim().length <= 16;
  function measureHeaderItems(h) {
    const out = [];
    const vw = window.innerWidth;
    const inBand = (r) => r.width > 0 && r.height > 0 && r.bottom > 2 && r.top < h - 2;
    const visible = (el) => !el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true });
    let budget = 3000; // cap the work on very large headers
    const range = document.createRange();
    const roots = bandEls.filter((e) => e.isConnected && !bandEls.some((o) => o !== e && o.contains(e)));
    for (const bandEl of roots) {
      const walker = document.createTreeWalker(bandEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && budget > 0; n = walker.nextNode(), budget--) {
        if (n.nodeType === 3) {
          if (!n.nodeValue.trim()) continue;
          const parent = n.parentElement;
          if (!parent || host.contains(parent) || !visible(parent)) continue;
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (inBand(r)) {
            // only the visible part: titles are often cut off with an ellipsis
            let l = r.left;
            let rr = r.right;
            for (let el = parent, i = 0; el && i < 6 && el !== document.body; el = el.parentElement, i++) {
              if (getComputedStyle(el).overflowX !== 'visible') {
                const b = el.getBoundingClientRect();
                l = Math.max(l, b.left);
                rr = Math.min(rr, b.right);
              }
            }
            if (rr > l) out.push({ l, r: rr, ctl: false });
          }
        } else if (n.matches(CTL_SELECTOR) && controlOf(n) === n && !host.contains(n) && visible(n)) {
          const r = n.getBoundingClientRect();
          // a control stretched across most of the header is a layout wrapper, not a button
          // a wide control (e.g. the renamable chat title) is text to avoid, not a button to stay off
          if (inBand(r) && r.width < vw * 0.6) out.push({ l: r.left, r: r.right, ctl: isButton(n, r) });
        }
      }
    }
    return out;
  }

  // Second, structure-free look at the header: hit-test a line across its middle (with the
  // strip itself made see-through for the moment) and record where there is visible text or
  // a button. Catches titles the DOM walk misses, and respects text clipped with an ellipsis.
  const STEP = 4;
  function sampleHeader(h, from, to) {
    const y = Math.max(4, Math.round((h - 1) / 2));
    // claude.ai's header is see-through: the conversation scrolls underneath it. Only count
    // what belongs to the header bar itself (elements that end within the header band).
    const roots = bandEls.filter((e) => e.isConnected && e.getBoundingClientRect().bottom <= h + 6);
    if (!roots.length) return [];
    const inHeader = (el) => roots.some((r) => r.contains(el));
    const runs = [];
    let cur = null;
    const prev = host.style.pointerEvents;
    host.style.pointerEvents = 'none';
    try {
      for (let x = Math.max(1, from); x < to; x += STEP) {
        let kind = null;
        const el = document.elementFromPoint(x, y);
        if (el && el !== document.body && el !== document.documentElement && inHeader(el)) {
          const c = controlOf(el);
          const cr = c && c.getBoundingClientRect();
          // small controls are buttons to stay off; a wide one (like a renamable title) counts as text
          if (cr && isButton(c, cr)) kind = 'ctl';
          else if (document.caretRangeFromPoint) {
            const r = document.caretRangeFromPoint(x, y);
            const n = r && r.startContainer;
            if (n && n.nodeType === 3 && n.nodeValue.trim()) {
              const rg = document.createRange();
              const o = r.startOffset;
              for (const [a, b] of [[o, o + 1], [o - 1, o]]) {
                if (a < 0 || b > n.nodeValue.length) continue;
                rg.setStart(n, a);
                rg.setEnd(n, b);
                const box = rg.getBoundingClientRect();
                if (box.width && x >= box.left - STEP && x <= box.right + STEP && box.bottom > 2 && box.top < h) {
                  kind = 'text';
                  break;
                }
              }
            }
          }
        }
        if (kind && cur && cur.kind === kind && x - cur.r <= STEP * 3) cur.r = x;
        else if (kind) runs.push((cur = { kind, l: x, r: x }));
      }
    } finally {
      host.style.pointerEvents = prev;
    }
    return runs.map((u) => ({ l: u.l - STEP / 2, r: u.r + STEP / 2, ctl: u.kind === 'ctl' }));
  }

  // The header strip the chat column sits under: with a side panel open, claude.ai's header
  // only spans the chat column, so the strip should stay inside it.
  function headerBounds(axis, h) {
    const vw = window.innerWidth;
    const prev = host.style.pointerEvents;
    host.style.pointerEvents = 'none';
    let best = null;
    try {
      let el = document.elementFromPoint(Math.min(Math.max(axis, 1), vw - 1), Math.max(4, Math.round(h / 2)));
      for (let i = 0; i < 12 && el && el !== document.body && el !== document.documentElement; i++, el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.top <= 4 && r.bottom <= h + 6 && r.height >= h * 0.6 && (!best || r.width > best.width)) best = r;
      }
    } finally {
      host.style.pointerEvents = prev;
    }
    return best && best.width >= 300 ? { l: Math.max(0, best.left), r: Math.min(vw, best.right) } : { l: 0, r: vw };
  }

  function layout() {
    const axis = findAxis();
    observe(composerRef);
    if (scanDue) {
      sepCache = measureSeparator(axis);
      scanDue = false;
    }
    const sep = sepCache;
    const h = sep ? round2(sep.bottom) : FALLBACK_H;
    const bw = round2(Math.max(sep ? sep.bw : 1, 1 / dpr()));
    const width = rootEl.offsetWidth || 330;
    if (itemsDue) {
      headerBox = headerBounds(axis, h);
      headerItems = measureHeaderItems(h).concat(sampleHeader(h, headerBox.l, headerBox.r));
      itemsDue = false;
    }
    // Centred on the composer; if that would sit on the chat title or buttons, slide right.
    const centered = U.centeredLeft(axis, width, window.innerWidth, EDGE);
    // Work in the chat header's own coordinates so the strip stays inside it (side panel open).
    const bx = headerBox.l;
    const local = headerItems
      .filter((i) => i.r > headerBox.l && i.l < headerBox.r) // ignore a side panel's own header
      .map((i) => ({ l: Math.max(0, i.l - bx), r: Math.min(headerBox.r, i.r) - bx, ctl: i.ctl }));
    const start = Math.min(Math.max(centered, bx + EDGE), headerBox.r - width - EDGE) - bx;
    const left = bx + U.placeOverlay(local, start, width, headerBox.r - bx, EDGE);
    let changed = false;

    if (left !== layoutCache.left) {
      rootEl.style.left = `${left}px`;
      layoutCache.left = left;
      changed = true;
    }
    if (h !== layoutCache.h || bw !== layoutCache.bw) {
      rootEl.style.setProperty('--h', `${h}px`);
      rootEl.style.setProperty('--bw', `${bw}px`);
      layoutCache.h = h;
      layoutCache.bw = bw;
      changed = true;
    }
    const fallback = !sep;
    if (fallback !== layoutCache.fallback) {
      rootEl.classList.toggle('fallback', fallback);
      layoutCache.fallback = fallback;
      changed = true;
    }
    if (changed && state.open) placePanel();
    return changed;
  }

  let frame = 0;
  let calm = 0;
  function pump() {
    frame = 0;
    calm = layout() ? 0 : calm + 1;
    if (calm < 30) frame = requestAnimationFrame(pump); // ~0.5s of calm, then sleep
  }
  function kick(scan = true) {
    itemsDue = true;
    if (scan) scanDue = true;
    calm = 0;
    if (!frame) frame = requestAnimationFrame(pump);
  }

  const observed = new Set();
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => kick(false)) : null;
  function observe(el) {
    if (resizeObserver && el && !observed.has(el)) {
      observed.add(el);
      resizeObserver.observe(el);
    }
  }

  function placePanel() {
    const r = rootEl.getBoundingClientRect();
    panel.className = `panel ${r.left + PANEL_W > window.innerWidth - EDGE ? 'align-right' : 'align-left'}`;
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    sessionBtn.setAttribute('aria-expanded', String(open));
    weeklyBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      placePanel();
      renderPanel(Date.now());
      refresh(false);
    }
  }

  function setHidden(hidden) {
    state.hidden = hidden;
    if (hidden) setOpen(false);
    store.set({ [KEY_HIDDEN]: hidden });
    render();
  }

  // ------------------------------------------------------------ interactions

  rootEl.addEventListener('click', () => setOpen(!state.open));
  panel.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('pointerdown', (e) => {
    if (state.open && !e.composedPath().includes(host)) setOpen(false);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) {
      setOpen(false);
      sessionBtn.focus();
    }
  }, true);

  window.addEventListener('resize', kick);
  // Sidebar toggles, navigation and composer swaps don't always fire resize.
  setInterval(() => { if (!state.hidden) kick(); }, 500);

  // ------------------------------------------------------------------- boot

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      // TEMP-TEST: the popup's test panel asks for a burn. Remove with popup-testpanel.js.
      if (area === 'local' && changes.cuo_test_usage) {
        state.test = changes.cuo_test_usage.newValue || null;
        render();
      }
      if (area === 'local' && changes.cuo_test_burn && changes.cuo_test_burn.newValue) {
        const t = changes.cuo_test_burn.newValue;
        if (!state.hidden && state.status === 'ok' && t.delta > 0) burn(t.delta, { fresh: true, word: t.word });
      }
      if (area !== 'local' || !changes[KEY_HIDDEN]) return;
      state.hidden = !!changes[KEY_HIDDEN].newValue;
      if (state.hidden) setOpen(false);
      render();
      if (!state.hidden) refresh(false);
    });
  } catch (e) {
    /* ignore */
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.hidden) refresh(false);
  });

  // Poll + keep countdowns fresh.
  setInterval(() => {
    if (state.hidden || document.visibilityState !== 'visible') return;
    const now = Date.now();
    const stale = now - state.triedAt >= CFG.refreshMs;
    const expired = state.parsed.windows.some((w) => w.resetsAt && w.resetsAt.getTime() <= now);
    if (stale || expired) refresh(false);
    else render();
  }, CFG.tickMs);

  // Cheap check for "a reply just finished".
  setInterval(() => {
    if (state.hidden || document.visibilityState !== 'visible') return;
    const generating = !!document.querySelector(STOP_SELECTOR);
    if (wasGenerating && !generating) onPromptFinished();
    wasGenerating = generating;
  }, CFG.finishCheckMs);

  (async function init() {
    const saved = await store.get([KEY_HIDDEN, 'cuo_test_usage']);
    state.hidden = saved[KEY_HIDDEN] === true;
    state.test = saved.cuo_test_usage || null; // TEMP-TEST
    injectFont();
    document.documentElement.appendChild(host);
    observe(document.documentElement);
    observe(rootEl);
    layout();
    kick();
    render();
    scheduleFlip();
    if (!state.hidden) refresh(true);
  })();
})();
