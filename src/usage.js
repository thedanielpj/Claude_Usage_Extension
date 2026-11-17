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

  const api = {
    parseUsage,
    primaryWindow,
    severity,
    formatCountdown,
    formatAgo,
  };

  root.ClaudeUsage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
