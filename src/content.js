/*
 * Claude Usage Overlay: content script for claude.ai.
 *
 * Reads the same-origin usage endpoint the Settings > Usage page uses, using
 * your existing session. Nothing is sent anywhere else, and no chat content
 * is read. The overlay lives in a shadow root so claude.ai's styles can't
 * touch it (and it can't touch theirs).
 */
(function () {
  'use strict';

  if (window.top !== window || document.getElementById('cuo-host')) return;

  const U = globalThis.ClaudeUsage;
  const REFRESH_MS = 60 * 1000; // how often to poll while the tab is visible
  const MIN_GAP_MS = 20 * 1000; // never fetch more often than this
  const TICK_MS = 15 * 1000; // re-render countdowns
  const KEY_POS = 'cuo_pos';
  const KEY_HIDDEN = 'cuo_hidden';
  const EDGE = 8;
  const PANEL_W = 300;

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
    fetchedAt: 0,
    fetching: false,
    open: false,
    hidden: false,
    pos: { right: 16, bottom: 16 },
  };

  async function refresh(force) {
    if (state.fetching) return;
    if (!force && Date.now() - state.fetchedAt < MIN_GAP_MS) return;
    state.fetching = true;
    render();
    try {
      const json = await loadUsage();
      state.parsed = U.parseUsage(json);
      state.status = 'ok';
      state.fetchedAt = Date.now();
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
        state.status = 'unavailable';
      } else if (state.status !== 'ok') {
        state.status = 'error';
      }
      // Keep showing the last good numbers on transient errors.
      state.fetchedAt = Date.now();
    } finally {
      state.fetching = false;
      render();
    }
  }

  // ------------------------------------------------------------- DOM helpers

  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  const RING_R = 9.5;
  const RING_C = 2 * Math.PI * RING_R;

  function createRing() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(SVG_NS, 'circle');
    const arc = document.createElementNS(SVG_NS, 'circle');
    for (const c of [track, arc]) {
      c.setAttribute('cx', '12');
      c.setAttribute('cy', '12');
      c.setAttribute('r', String(RING_R));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke-width', '3');
    }
    track.setAttribute('class', 'ring-track');
    arc.setAttribute('class', 'ring-arc');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('transform', 'rotate(-90 12 12)');
    svg.append(track, arc);
    return {
      el: svg,
      set(pct, sev) {
        const filled = pct == null ? 0 : (RING_C * pct) / 100;
        arc.setAttribute('stroke-dasharray', `${filled} ${RING_C}`);
        svg.setAttribute('class', `ring sev-${sev}`);
      },
    };
  }

  function resetClock(date) {
    return date.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // -------------------------------------------------------------------- CSS

  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.root {
  --bg: #faf9f5; --card: #ffffff; --fg: #1f1e1d; --muted: #6b6a66;
  --line: rgba(31, 30, 29, 0.14); --track: rgba(31, 30, 29, 0.1);
  --ok: #2f7d6b; --warn: #a96a0c; --high: #c23b2e;
  --shadow: 0 4px 18px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  position: fixed; z-index: 2147483000;
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
.root[data-theme="dark"] {
  --bg: #262624; --card: #30302e; --fg: #f0eee6; --muted: #a8a69e;
  --line: rgba(240, 238, 230, 0.16); --track: rgba(240, 238, 230, 0.14);
  --ok: #5fc2a2; --warn: #e3ac45; --high: #f27a6d;
  --shadow: 0 4px 18px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4);
}
.root[hidden] { display: none; }

.sev-ok { --c: var(--ok); }
.sev-warn { --c: var(--warn); }
.sev-high { --c: var(--high); }
.sev-none { --c: var(--muted); }

/* ---- pill ---- */
.pill {
  display: flex; align-items: center; gap: 8px;
  height: 36px; padding: 0 12px 0 8px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--bg); color: var(--fg);
  box-shadow: var(--shadow);
  font: inherit; cursor: grab; touch-action: none; user-select: none;
  transition: transform 120ms ease;
}
.pill:hover { transform: translateY(-1px); }
.pill:active { cursor: grabbing; }
.pill:focus-visible { outline: 2px solid var(--c, var(--fg)); outline-offset: 2px; }
.pill .ring { width: 22px; height: 22px; flex: none; }
.pill .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
.pill .eta { color: var(--muted); font-variant-numeric: tabular-nums; }
.pill.busy .ring { opacity: 0.55; }

.ring-track { stroke: var(--track); }
.ring-arc { stroke: var(--c, var(--muted)); transition: stroke-dasharray 400ms ease; }

/* ---- panel ---- */
.panel {
  position: absolute; width: ${PANEL_W}px; padding: 14px 14px 10px;
  border: 1px solid var(--line); border-radius: 14px;
  background: var(--card); box-shadow: var(--shadow);
}
.panel[hidden] { display: none; }
.panel.up { bottom: calc(100% + 8px); }
.panel.down { top: calc(100% + 8px); }
.panel.align-right { right: 0; }
.panel.align-left { left: 0; }

.panel h2 {
  margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  text-transform: uppercase; color: var(--muted);
}
.row + .row { margin-top: 12px; }
.row-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.row-title { font-weight: 600; }
.row-detail { color: var(--muted); margin-left: 6px; font-weight: 400; }
.row-pct { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--c); }
.bar {
  height: 6px; margin-top: 6px; border-radius: 999px; background: var(--track); overflow: hidden;
}
.bar > span {
  display: block; height: 100%; border-radius: inherit; background: var(--c);
  transition: width 400ms ease;
}
.row-reset { margin-top: 5px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.note { color: var(--muted); padding: 2px 0 4px; }

.foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 12px;
}
.foot-actions { display: flex; gap: 2px; }
.btn {
  border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 12px;
  padding: 3px 6px; border-radius: 6px; cursor: pointer;
}
.btn:hover { background: var(--track); color: var(--fg); }
.btn:focus-visible { outline: 2px solid var(--fg); outline-offset: 1px; }
.btn.spin svg { animation: cuo-spin 900ms linear infinite; }
@keyframes cuo-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .pill, .ring-arc, .bar > span { transition: none; }
  .btn.spin svg { animation: none; }
}
`;

  // ------------------------------------------------------------------ build

  const host = document.createElement('div');
  host.id = 'cuo-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const ring = createRing();
  const pctEl = h('span', { class: 'pct' });
  const etaEl = h('span', { class: 'eta' });
  const pill = h('button', {
    class: 'pill',
    type: 'button',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
  }, ring.el, pctEl, etaEl);

  const bodyEl = h('div', { class: 'body' });
  const updatedEl = h('span');
  const refreshBtn = h('button', {
    class: 'btn',
    type: 'button',
    'aria-label': 'Refresh usage',
    title: 'Refresh now',
    onclick: () => refresh(true),
  });
  refreshBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  const hideBtn = h('button', {
    class: 'btn',
    type: 'button',
    title: 'Hide the overlay. Click the extension icon in the toolbar to bring it back.',
    onclick: () => setHidden(true),
  }, 'Hide');

  const panel = h('div', {
    class: 'panel up align-right',
    role: 'region',
    'aria-label': 'Claude usage details',
    hidden: true,
  },
    h('h2', {}, 'Claude usage'),
    bodyEl,
    h('div', { class: 'foot' }, updatedEl, h('div', { class: 'foot-actions' }, refreshBtn, hideBtn)),
  );

  const rootEl = h('div', { class: 'root' }, panel, pill);
  shadow.append(h('style', {}, CSS), rootEl);

  // ----------------------------------------------------------------- render

  function barRow(win, now) {
    const sev = U.severity(win.pct);
    const pct = Math.round(win.pct);
    let reset = null;
    if (win.resetsAt) {
      const ms = win.resetsAt.getTime() - now;
      reset = h('div', { class: 'row-reset', title: `Resets ${resetClock(win.resetsAt)}` },
        ms <= 0 ? 'Resetting…' : `Resets in ${U.formatCountdown(ms)} · ${resetClock(win.resetsAt)}`);
    }
    return h('div', { class: `row sev-${sev}` },
      h('div', { class: 'row-head' },
        h('span', { class: 'row-title' }, win.label,
          win.detail ? h('span', { class: 'row-detail' }, win.detail) : null),
        h('span', { class: 'row-pct' }, `${pct}%`)),
      h('div', {
        class: 'bar',
        role: 'progressbar',
        'aria-label': `${win.label} ${win.detail}`.trim(),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(pct),
      }, h('span', { style: `width:${win.pct}%` })),
      reset);
  }

  function renderPill(now) {
    const primary = U.primaryWindow(state.parsed.windows);
    pill.classList.toggle('busy', state.fetching);

    if (state.status === 'ok' && primary) {
      const sev = U.severity(primary.pct);
      const pct = Math.round(primary.pct);
      ring.set(primary.pct, sev);
      pill.className = `pill sev-${sev}${state.fetching ? ' busy' : ''}`;
      pctEl.textContent = `${pct}%`;
      let eta = '';
      if (primary.resetsAt) {
        const ms = primary.resetsAt.getTime() - now;
        eta = ms > 0 ? U.formatCountdown(ms) : 'resetting';
      }
      etaEl.textContent = eta;
      etaEl.hidden = !eta;
      const label = `${primary.label} usage ${pct}%` + (eta ? `, resets in ${eta}` : '');
      pill.setAttribute('aria-label', `${label}. Open details.`);
      pill.title = label;
      return;
    }

    ring.set(null, 'none');
    pill.className = `pill sev-none${state.fetching ? ' busy' : ''}`;
    etaEl.hidden = true;
    if (state.status === 'loading') {
      pctEl.textContent = '…';
      pill.title = 'Loading usage…';
    } else {
      pctEl.textContent = '–';
      pill.title = state.status === 'ok' ? 'No usage limits reported' : 'Usage unavailable';
    }
    pill.setAttribute('aria-label', `${pill.title}. Open details.`);
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
      if (!nodes.length) {
        nodes.push(h('div', { class: 'note' }, 'No usage limits reported for this account.'));
      }
    }
    bodyEl.replaceChildren(...nodes);

    updatedEl.textContent = state.fetchedAt
      ? `Updated ${U.formatAgo(now - state.fetchedAt)}`
      : '';
    refreshBtn.classList.toggle('spin', state.fetching);
  }

  function render() {
    const now = Date.now();
    rootEl.hidden = state.hidden;
    renderPill(now);
    if (state.open) renderPanel(now);
  }

  // ---------------------------------------------------------- open / position

  function applyPos() {
    const w = pill.offsetWidth || 90;
    const hgt = pill.offsetHeight || 36;
    state.pos.right = Math.min(Math.max(EDGE, state.pos.right), Math.max(EDGE, window.innerWidth - w - EDGE));
    state.pos.bottom = Math.min(Math.max(EDGE, state.pos.bottom), Math.max(EDGE, window.innerHeight - hgt - EDGE));
    rootEl.style.right = `${state.pos.right}px`;
    rootEl.style.bottom = `${state.pos.bottom}px`;
  }

  function placePanel() {
    const r = pill.getBoundingClientRect();
    const up = r.top + r.height / 2 > window.innerHeight / 2;
    const alignRight = r.right - PANEL_W >= EDGE;
    panel.className = `panel ${up ? 'up' : 'down'} ${alignRight ? 'align-right' : 'align-left'}`;
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
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

  let drag = null;
  let justDragged = false;

  pill.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      right: state.pos.right,
      bottom: state.pos.bottom,
      moved: false,
    };
    try {
      pill.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  });

  pill.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    state.pos.right = drag.right - dx;
    state.pos.bottom = drag.bottom - dy;
    applyPos();
    if (state.open) placePanel();
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      justDragged = true;
      store.set({ [KEY_POS]: state.pos });
    }
    drag = null;
  }
  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', endDrag);

  pill.addEventListener('click', () => {
    if (justDragged) {
      justDragged = false;
      return;
    }
    setOpen(!state.open);
  });

  document.addEventListener('pointerdown', (e) => {
    if (state.open && !e.composedPath().includes(host)) setOpen(false);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) {
      setOpen(false);
      pill.focus();
    }
  }, true);

  window.addEventListener('resize', () => {
    applyPos();
    if (state.open) placePanel();
  });

  // ------------------------------------------------------------------ theme

  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function detectTheme() {
    const de = document.documentElement;
    const marks = [de.getAttribute('data-mode'), de.getAttribute('data-theme')];
    if (marks.includes('dark') || de.classList.contains('dark')) return 'dark';
    if (marks.includes('light') || de.classList.contains('light')) return 'light';
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    rootEl.setAttribute('data-theme', detectTheme());
  }

  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-mode', 'data-theme'],
  });
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);

  // ------------------------------------------------------------------- boot

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[KEY_HIDDEN]) {
        state.hidden = !!changes[KEY_HIDDEN].newValue;
        if (state.hidden) setOpen(false);
        render();
        if (!state.hidden) refresh(false);
      }
    });
  } catch (e) {
    /* ignore */
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.hidden) refresh(false);
  });

  setInterval(() => {
    if (state.hidden || document.visibilityState !== 'visible') return;
    const now = Date.now();
    const stale = now - state.fetchedAt >= REFRESH_MS;
    const expired = state.parsed.windows.some((w) => w.resetsAt && w.resetsAt.getTime() <= now);
    if (stale || (expired && now - state.fetchedAt >= MIN_GAP_MS)) refresh(false);
    else render();
  }, TICK_MS);

  (async function init() {
    const saved = await store.get([KEY_POS, KEY_HIDDEN]);
    if (saved[KEY_POS] && typeof saved[KEY_POS] === 'object') {
      const { right, bottom } = saved[KEY_POS];
      if (Number.isFinite(right) && Number.isFinite(bottom)) state.pos = { right, bottom };
    }
    state.hidden = saved[KEY_HIDDEN] === true;
    document.documentElement.appendChild(host);
    applyTheme();
    applyPos();
    render();
    if (!state.hidden) refresh(true);
  })();
})();
