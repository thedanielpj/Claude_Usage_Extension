/*
 * Pure helpers: parse the claude.ai usage payload and format it for display.
 * No DOM or chrome.* access here, so it can be unit-tested in Node.
 *
 * The usage endpoint is undocumented. Windows are discovered generically
 * (any object with a numeric `utilization`), so new limits that Anthropic
 * adds later show up without a code change.
 */
(function (root) {
  'use strict';

  const PRIMARY_ORDER = ['five_hour', 'seven_day'];

  function titleCase(s) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function describeKey(key) {
    if (key === 'five_hour') return { label: 'Session', detail: '5-hour window' };
    if (key === 'seven_day') return { label: 'Weekly', detail: 'All models' };
    const m = /^seven_day_(.+)$/.exec(key);
    if (m) return { label: 'Weekly', detail: titleCase(m[1].replace(/_/g, ' ')) };
    return { label: titleCase(key.replace(/_/g, ' ')), detail: '' };
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, n));
  }

  function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * @returns {{windows: Array<{key,label,detail,pct,resetsAt}>, extra: null|{enabled:boolean,pct:number|null}}}
   */
  function parseUsage(json) {
    const out = { windows: [], extra: null };
    if (!json || typeof json !== 'object') return out;

    for (const [key, v] of Object.entries(json)) {
      if (!v || typeof v !== 'object') continue;

      if (key === 'extra_usage') {
        out.extra = {
          enabled: v.is_enabled === true,
          pct: isFiniteNumber(v.utilization) ? clampPct(v.utilization) : null,
        };
        continue;
      }

      if (!isFiniteNumber(v.utilization)) continue;

      const resetsAt = parseDate(v.resets_at);
      const pct = clampPct(v.utilization);
      // Hide model-specific windows that have never been touched.
      if (!resetsAt && pct === 0 && !PRIMARY_ORDER.includes(key)) continue;

      out.windows.push({ key, ...describeKey(key), pct, resetsAt });
    }

    out.windows.sort((a, b) => {
      const ai = PRIMARY_ORDER.indexOf(a.key);
      const bi = PRIMARY_ORDER.indexOf(b.key);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.key.localeCompare(b.key);
    });

    return out;
  }

  /** The window shown on the collapsed pill: the 5-hour session, else the busiest one. */
  function primaryWindow(windows) {
    if (!windows.length) return null;
    const session = windows.find((w) => w.key === 'five_hour');
    if (session) return session;
    return windows.reduce((a, b) => (b.pct > a.pct ? b : a));
  }

  function severity(pct) {
    if (pct >= 90) return 'high';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  /** "2h 14m", "4d 3h", "<1m". */
  function formatCountdown(ms) {
    if (ms <= 0) return 'now';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 1) return '<1m';
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /** "just now", "42s ago", "3m ago". */
  function formatAgo(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }

  /** The window shown in the main "session" cell. */
  function pickSession(windows) {
    return windows.find((w) => w.key === 'five_hour') || primaryWindow(windows);
  }

  /** The window shown in the "weekly" cell (null if absent or already used as the session). */
  function pickWeekly(windows, session) {
    return windows.find((w) => w.key === 'seven_day' && w !== session) || null;
  }

  /** Lower-case cell label: "session", "weekly", or the window's own label. */
  function shortLabel(win) {
    if (win.key === 'five_hour') return 'session';
    if (win.key === 'seven_day') return 'weekly';
    return win.label.toLowerCase();
  }

  const SAME_WINDOW_TOLERANCE_MS = 5 * 60 * 1000;
  const MAX_OBSERVATION_GAP_MS = 3 * 60 * 1000;

  /**
   * How many whole percentage points of usage were just consumed?
   *
   * prev/next are `{pct, resetsAt}` snapshots of the session window taken at
   * two consecutive successful fetches (or null). Returns 0 when there was no
   * increase, when the two snapshots are too far apart to attribute to "a
   * prompt just finished" (sleeping laptop, background tab), or when the
   * window rolled over without new usage.
   *
   * Compares *displayed* (rounded) values, so what the user sees going
   * 10% -> 15% is reported as +5.
   */
  function sessionDelta(prev, next, gapMs, maxGapMs = MAX_OBSERVATION_GAP_MS) {
    if (!prev || !next) return 0;
    if (!(gapMs >= 0) || gapMs > maxGapMs) return 0;

    let sameWindow;
    if (prev.resetsAt && next.resetsAt) {
      sameWindow = Math.abs(next.resetsAt - prev.resetsAt) < SAME_WINDOW_TOLERANCE_MS;
    } else {
      sameWindow = !prev.resetsAt && !next.resetsAt;
    }

    const base = sameWindow ? Math.round(prev.pct) : 0; // a fresh window starts from 0
    const delta = Math.round(next.pct) - base;
    return delta > 0 ? delta : 0;
  }

  const api = {
    parseUsage,
    primaryWindow,
    pickSession,
    pickWeekly,
    shortLabel,
    sessionDelta,
    severity,
    formatCountdown,
    formatAgo,
  };

  root.ClaudeUsage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
