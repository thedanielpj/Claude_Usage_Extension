const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/usage.js');

const SAMPLE = {
  five_hour: { utilization: 42.7, resets_at: '2026-11-17T12:00:00Z' },
  seven_day: { utilization: 77, resets_at: '2026-11-20T09:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 4.2, resets_at: '2026-11-20T09:00:00Z' },
  seven_day_fable: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 250, utilization: 5 },
};

test('parses windows in a stable order and drops null/unused ones', () => {
  const { windows, extra } = U.parseUsage(SAMPLE);
  assert.deepEqual(windows.map((w) => w.key), ['five_hour', 'seven_day', 'seven_day_sonnet']);
  assert.equal(windows[0].label, 'Session');
  assert.equal(windows[1].detail, 'All models');
  assert.equal(windows[2].detail, 'Sonnet');
  assert.ok(windows[0].resetsAt instanceof Date);
  assert.deepEqual(extra, { enabled: true, pct: 5 });
});

test('discovers unknown windows generically', () => {
  const { windows } = U.parseUsage({
    seven_day_fable: { utilization: 31, resets_at: '2026-11-20T09:00:00Z' },
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].detail, 'Fable');
});

test('clamps utilization to 0-100', () => {
  const { windows } = U.parseUsage({
    five_hour: { utilization: 130, resets_at: '2026-11-17T12:00:00Z' },
    seven_day: { utilization: -5, resets_at: '2026-11-17T12:00:00Z' },
  });
  assert.equal(windows[0].pct, 100);
  assert.equal(windows[1].pct, 0);
});

test('keeps primary windows even when idle', () => {
  const { windows } = U.parseUsage({ five_hour: { utilization: 0, resets_at: null } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resetsAt, null);
});

test('tolerates garbage input', () => {
  for (const bad of [null, undefined, 'x', 5, [], {}, { five_hour: 'nope' }, { five_hour: { utilization: 'a' } }]) {
    assert.deepEqual(U.parseUsage(bad).windows, []);
  }
  const { windows } = U.parseUsage({ five_hour: { utilization: 10, resets_at: 'not a date' } });
  assert.equal(windows[0].resetsAt, null);
});

test('primaryWindow prefers the session, else the busiest', () => {
  const { windows } = U.parseUsage(SAMPLE);
  assert.equal(U.primaryWindow(windows).key, 'five_hour');
  const noSession = windows.filter((w) => w.key !== 'five_hour');
  assert.equal(U.primaryWindow(noSession).key, 'seven_day');
  assert.equal(U.primaryWindow([]), null);
});

test('severity thresholds', () => {
  assert.equal(U.severity(0), 'ok');
  assert.equal(U.severity(69.9), 'ok');
  assert.equal(U.severity(70), 'warn');
  assert.equal(U.severity(89.9), 'warn');
  assert.equal(U.severity(90), 'high');
  assert.equal(U.severity(100), 'high');
});

test('formatCountdown', () => {
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  assert.equal(U.formatCountdown(-1), 'now');
  assert.equal(U.formatCountdown(30 * 1000), '<1m');
  assert.equal(U.formatCountdown(14 * min), '14m');
  assert.equal(U.formatCountdown(2 * hr + 14 * min), '2h 14m');
  assert.equal(U.formatCountdown(4 * day + 3 * hr + 59 * min), '4d 3h');
});

test('formatAgo', () => {
  assert.equal(U.formatAgo(1000), 'just now');
  assert.equal(U.formatAgo(42 * 1000), '42s ago');
  assert.equal(U.formatAgo(3 * 60 * 1000), '3m ago');
});
