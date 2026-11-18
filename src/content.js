/*
 * Claude Usage Overlay: content script for claude.ai.
 *
 * A flat strip docked to the top of the page:
 *
 *   [ session · 2h 13m  43% ][ weekly 15% ]
 *     └ gradient progress line along the bottom edge
 *
 *  - weekly flips between its percentage and time-left every ~30s
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
      flipEveryMs: 30 * 1000, // weekly: how often to flip to time-left
      flipHoldMs: 6 * 1000, // weekly: how long time-left stays up
      burnHoldMs: 5 * 1000, // fire animation hold
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
    weeklyFace: 'pct', // pct | time
    flipping: false,
    burn: null, // { delta, timer }
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
      const style = document.createElement('style');
      style.textContent =
        '@font-face{font-family:"Cuo Inter";font-style:normal;font-weight:100 900;' +
        `font-display:swap;src:url("${url}") format("woff2");}`;
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

.face {
  grid-area: 1 / 1; z-index: 1;
  display: flex; align-items: center; justify-content: center; gap: 16px;
  transition: opacity 260ms ease, transform 260ms ease;
}
.head { display: flex; align-items: center; gap: 8px; }
.dot { width: 2px; height: 2px; flex: none; border-radius: 50%; background: var(--muted); }
.pct, .val { font-weight: 500; color: var(--fg); }
.val { display: inline-block; min-width: 42px; backface-visibility: hidden; }
.flip { display: inline-block; perspective: 240px; }

/* ---------- progress line (session utilisation) ---------- */
.line { position: absolute; left: -1px; right: -1px; top: 100%; height: var(--bw); z-index: 2; pointer-events: none; }
.fill {
  display: block; height: 100%; width: 0;
  background: linear-gradient(90deg, var(--fire-a), var(--fire-b));
  transition: width 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* ---------- burn state ---------- */
.face.burn { opacity: 0; transform: translateY(6px); gap: 8px; pointer-events: none; }
.burn .delta { font-weight: 600; color: #ffb27a; }
.fire { width: 20px; height: 20px; flex: none; transform-origin: 50% 100%; }
.session.burning .face.normal { opacity: 0; transform: translateY(-6px); }
.session.burning .face.burn { opacity: 1; transform: none; }
.session.burning .fire { animation: cuo-flicker 520ms ease-in-out infinite alternate; }

.flame {
  position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
  background: linear-gradient(90deg, rgba(255, 85, 0, 0.21) 0%, rgba(242, 141, 0, 0.21) 100%);
  transform: scaleX(-1);
  opacity: 0; transition: opacity 450ms ease;
}
.session.burning .flame { opacity: 1; }
.flame::before, .flame::after {
  content: ""; position: absolute; left: -10%; right: -10%; bottom: -35%; height: 150%;
  transform-origin: 50% 100%;
}
.flame::before {
  background:
    radial-gradient(38% 80% at 14% 100%, rgba(255, 85, 0, 0.9), transparent 72%),
    radial-gradient(34% 100% at 50% 100%, rgba(242, 141, 0, 0.85), transparent 72%),
    radial-gradient(38% 82% at 86% 100%, rgba(255, 85, 0, 0.9), transparent 72%);
  animation: cuo-lick 880ms ease-in-out infinite alternate;
}
.flame::after {
  background:
    radial-gradient(30% 70% at 30% 100%, rgba(255, 190, 60, 0.7), transparent 72%),
    radial-gradient(30% 76% at 70% 100%, rgba(255, 160, 30, 0.7), transparent 72%);
  animation: cuo-lick 640ms ease-in-out infinite alternate-reverse;
}
.ember {
  position: absolute; bottom: 4px; width: 3px; height: 3px; border-radius: 50%;
  background: #ffc15a; box-shadow: 0 0 4px 1px rgba(255, 150, 40, 0.8); opacity: 0;
}
.session.burning .ember { animation: cuo-ember 1400ms ease-out infinite; }
.ember:nth-child(1) { left: 18%; animation-delay: 0ms; }
.ember:nth-child(2) { left: 46%; animation-delay: 420ms; }
.ember:nth-child(3) { left: 71%; animation-delay: 840ms; }
.ember:nth-child(4) { left: 88%; animation-delay: 210ms; }

@keyframes cuo-lick {
  0%   { transform: scaleY(0.78) skewX(-3deg); opacity: 0.7; }
  50%  { transform: scaleY(1.05) skewX(2deg);  opacity: 1; }
  100% { transform: scaleY(0.9)  skewX(-1deg); opacity: 0.82; }
}
@keyframes cuo-flicker {
  0%   { transform: scale(1, 0.94) rotate(-2deg); }
  100% { transform: scale(1.06, 1.08) rotate(2deg); }
}
@keyframes cuo-ember {
  0%   { transform: translateY(0); opacity: 0; }
  15%  { opacity: 0.95; }
  100% { transform: translateY(-30px) translateX(4px); opacity: 0; }
}

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
  .face, .flame, .fill, .bar > span { transition: none; }
  .flame::before, .flame::after, .session.burning .fire, .session.burning .ember { animation: none; }
  .ember { display: none; }
}
`;

  // ------------------------------------------------------------------ build

  const FIRE_SVG =
    '<svg class="fire" viewBox="0 0 24 24" aria-hidden="true">' +
    '<defs><linearGradient id="cuo-fg" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#f28d00"/><stop offset="1" stop-color="#ff4d00"/>' +
    '</linearGradient></defs>' +
    '<path d="M12 2c.6 3.2 3.6 5.2 5 8.2 1.3 2.7.9 6-.6 8.1C15.1 20 13.7 21 12 21c-2.6 0-5-2-5.7-4.7-.6-2.3.2-4.3 1.5-5.9.4 1.2 1 2 2 2.4C9.400 9 10.200 5 12 2z" fill="url(#cuo-fg)"/>' +
    '<path d="M12 12.500c.8 1.500 2.500 2.300 2.500 4.500 0 1.600-1.100 2.600-2.500 2.600S9.500 18.600 9.500 17.200c0-1.700 1.700-2.700 2.500-4.700z" fill="#ffe2a8"/>' +
    '</svg>';

  const host = document.createElement('div');
  host.id = 'cuo-host';
  const shadow = host.attachShadow({ mode: 'open' });

  // session cell
  const labelEl = h('span', {}, 'session');
  const dotEl = h('i', { class: 'dot' });
  const etaEl = h('span');
  const pctEl = h('span', { class: 'pct' });
  const fireWrap = h('span');
  fireWrap.innerHTML = FIRE_SVG;
  const deltaEl = h('span', { class: 'delta' });
  const fillEl = h('span', { class: 'fill' });

  const sessionBtn = h('button', { class: 'cell session', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    h('span', { class: 'flame', 'aria-hidden': 'true' },
      h('i', { class: 'ember' }), h('i', { class: 'ember' }), h('i', { class: 'ember' }), h('i', { class: 'ember' })),
    h('span', { class: 'face normal' },
      h('span', { class: 'head' }, labelEl, dotEl, etaEl),
      pctEl),
    h('span', { class: 'face burn', 'aria-hidden': 'true' }, fireWrap.firstChild, deltaEl),
    h('span', { class: 'line' }, fillEl));

  // weekly cell
  const wLabelEl = h('span', {}, 'weekly');
  const valEl = h('span', { class: 'val' });
  const weeklyBtn = h('button', { class: 'cell weekly', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true },
    wLabelEl, h('span', { class: 'flip' }, valEl));

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
    title: 'Hide the overlay. Click the extension icon in the toolbar to bring it back.',
    onclick: () => setHidden(true),
  }, 'Hide');
  const panel = h('div', { class: 'panel align-left', role: 'region', 'aria-label': 'Claude usage details', hidden: true },
    bodyEl,
    h('div', { class: 'foot' }, updatedEl, h('div', { class: 'foot-actions' }, refreshBtn, hideBtn)));

  const live = h('div', { class: 'sr', 'aria-live': 'polite' });
  const rootEl = h('div', { class: 'root', role: 'group', 'aria-label': 'Claude usage' }, sessionBtn, weeklyBtn, panel, live);
  shadow.append(h('style', {}, CSS), rootEl);

  // ----------------------------------------------------------------- render

  function weeklyText() {
    const w = weeklyWindow();
    if (!w) return '';
    if (state.weeklyFace === 'time' && w.resetsAt) {
      const ms = w.resetsAt.getTime() - Date.now();
      return ms > 0 ? U.formatCountdown(ms) : '…';
    }
    return `${Math.round(w.pct)}%`;
  }

  const sessionWindow = () => U.pickSession(state.parsed.windows);
  const weeklyWindow = () => U.pickWeekly(state.parsed.windows, sessionWindow());

  function renderBusy() {
    refreshBtn.classList.toggle('spin', state.fetching);
  }

  function renderStrip(now) {
    const s = state.status === 'ok' ? sessionWindow() : null;

    if (s) {
      const pct = Math.round(s.pct);
      const ms = s.resetsAt ? s.resetsAt.getTime() - now : null;
      const eta = ms == null ? '' : ms > 0 ? U.formatCountdown(ms) : 'resetting';
      labelEl.textContent = U.shortLabel(s);
      etaEl.textContent = eta;
      etaEl.hidden = dotEl.hidden = !eta;
      pctEl.textContent = `${pct}%`;
      fillEl.style.width = `${s.pct}%`;
      const aria = `${U.shortLabel(s)} usage ${pct}%` + (eta ? `, resets in ${eta}` : '') + '. Show details.';
      sessionBtn.setAttribute('aria-label', aria);
      sessionBtn.title = '';
    } else {
      const loading = state.status === 'loading';
      labelEl.textContent = loading ? 'session' : 'usage';
      etaEl.hidden = dotEl.hidden = true;
      pctEl.textContent = loading ? '…' : '–';
      fillEl.style.width = '0';
      const msg = loading ? 'Loading usage' : 'Usage unavailable';
      sessionBtn.setAttribute('aria-label', `${msg}. Show details.`);
      sessionBtn.title = msg;
    }

    const w = s ? weeklyWindow() : null;
    weeklyBtn.hidden = !w;
    if (w) {
      if (!w.resetsAt && state.weeklyFace === 'time') state.weeklyFace = 'pct';
      if (!state.flipping) valEl.textContent = weeklyText();
      const reset = w.resetsAt ? `, resets in ${U.formatCountdown(w.resetsAt.getTime() - now)}` : '';
      weeklyBtn.setAttribute('aria-label', `weekly usage ${Math.round(w.pct)}%${reset}. Show details.`);
    }

    sessionBtn.classList.toggle('burning', !!state.burn);
    if (state.burn) deltaEl.textContent = `+${state.burn.delta}%`;
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

  function burn(delta) {
    const total = (state.burn ? state.burn.delta : 0) + delta;
    if (state.burn) clearTimeout(state.burn.timer);
    state.burn = { delta: total, timer: setTimeout(endBurn, CFG.burnHoldMs) };
    announce(`Session usage up ${total}%`);
    render();
  }

  function endBurn() {
    state.burn = null;
    render();
  }

  // ------------------------------------------------------------- weekly flip

  function flipValue(text) {
    if (reducedMotion || typeof valEl.animate !== 'function') {
      valEl.textContent = text;
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
      valEl.textContent = weeklyText();
    };
    const safety = setTimeout(finish, 800);

    const out = valEl.animate(
      [{ transform: 'rotateX(0deg)', opacity: 1 }, { transform: 'rotateX(-90deg)', opacity: 0 }],
      { duration: 140, easing: 'ease-in', fill: 'forwards' });
    anims.push(out);
    out.onfinish = () => {
      if (done) return;
      valEl.textContent = text;
      out.cancel();
      const back = valEl.animate(
        [{ transform: 'rotateX(90deg)', opacity: 0 }, { transform: 'rotateX(0deg)', opacity: 1 }],
        { duration: 180, easing: 'ease-out' });
      anims.push(back);
      back.onfinish = finish;
    };
  }

  function setWeeklyFace(face) {
    state.weeklyFace = face;
    flipValue(weeklyText());
  }

  let flipTimer = null;
  function scheduleFlip() {
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => {
      const w = weeklyWindow();
      if (!state.hidden && document.visibilityState === 'visible' && w && w.resetsAt) {
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
    const left = U.centeredLeft(axis, rootEl.offsetWidth || 330, window.innerWidth, EDGE);
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
    const saved = await store.get([KEY_HIDDEN]);
    state.hidden = saved[KEY_HIDDEN] === true;
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
