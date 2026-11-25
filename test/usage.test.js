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

test('pickSession / pickWeekly / shortLabel', () => {
  const { windows } = U.parseUsage(SAMPLE);
  const session = U.pickSession(windows);
  assert.equal(session.key, 'five_hour');
  assert.equal(U.pickWeekly(windows, session).key, 'seven_day');
  assert.equal(U.shortLabel(session), 'session');
  assert.equal(U.shortLabel(U.pickWeekly(windows, session)), 'weekly');

  // If only the weekly window exists it becomes the main cell and there is no second cell.
  const onlyWeekly = windows.filter((w) => w.key === 'seven_day');
  const s2 = U.pickSession(onlyWeekly);
  assert.equal(s2.key, 'seven_day');
  assert.equal(U.pickWeekly(onlyWeekly, s2), null);
  assert.equal(U.pickSession([]), null);
});

const T0 = Date.parse('2026-11-17T12:00:00Z');
const snap = (pct, resetsInMin) => ({ pct, resetsAt: resetsInMin == null ? null : new Date(T0 + resetsInMin * 60000) });

test('sessionDelta: 10% -> 15% is +5', () => {
  assert.equal(U.sessionDelta(snap(10, 120), snap(15, 120), 20000), 5);
});

test('sessionDelta: compares displayed (rounded) values', () => {
  assert.equal(U.sessionDelta(snap(10.4, 120), snap(14.6, 120), 20000), 5); // 10 -> 15
  assert.equal(U.sessionDelta(snap(10.2, 120), snap(10.4, 120), 20000), 0); // 10 -> 10
});

test('sessionDelta: no change, decrease, or missing data -> 0', () => {
  assert.equal(U.sessionDelta(snap(15, 120), snap(15, 120), 20000), 0);
  assert.equal(U.sessionDelta(snap(15, 120), snap(12, 120), 20000), 0);
  assert.equal(U.sessionDelta(null, snap(15, 120), 20000), 0);
  assert.equal(U.sessionDelta(snap(15, 120), null, 20000), 0);
});

test('sessionDelta: window rolled over -> counts from zero', () => {
  // 90% used, window resets, user sends a prompt: new window shows 3%.
  assert.equal(U.sessionDelta(snap(90, 5), snap(3, 300), 20000), 3);
  // Window rolled over with nothing used yet.
  assert.equal(U.sessionDelta(snap(90, 5), snap(0, null), 20000), 0);
});

test('sessionDelta: first prompt of an idle window counts from zero', () => {
  assert.equal(U.sessionDelta(snap(0, null), snap(4, 300), 20000), 4);
});

test('sessionDelta: tiny resets_at jitter is still the same window', () => {
  const a = { pct: 10, resetsAt: new Date(T0 + 120 * 60000) };
  const b = { pct: 16, resetsAt: new Date(T0 + 120 * 60000 + 2000) };
  assert.equal(U.sessionDelta(a, b, 20000), 6);
});

test('sessionDelta: ignores long gaps (sleeping laptop / background tab)', () => {
  assert.equal(U.sessionDelta(snap(10, 120), snap(40, 120), 10 * 60 * 1000), 0);
  assert.equal(U.sessionDelta(snap(10, 120), snap(40, 120), -5), 0);
  assert.equal(U.sessionDelta(snap(10, 120), snap(40, 120), NaN), 0);
});

test('pickSeparator: finds the header border, ignores everything else', () => {
  const header = { top: 0, bottom: 45, width: 1200, bw: 1 };
  assert.deepEqual(U.pickSeparator([header]), { bottom: 45, bw: 1 });

  const noise = [
    { top: 0, bottom: 900, width: 260, bw: 1 }, // sidebar: far too tall
    { top: 0, bottom: 45, width: 1200, bw: 0 }, // header-ish but no border
    { top: 120, bottom: 160, width: 800, bw: 1 }, // not at the top
    { top: 0, bottom: 30, width: 600, bw: 1 }, // too short
    { top: 0, bottom: 45, width: 120, bw: 1 }, // too narrow
  ];
  assert.equal(U.pickSeparator(noise), null);
  assert.deepEqual(U.pickSeparator([...noise, header]), { bottom: 45, bw: 1 });
  assert.equal(U.pickSeparator([]), null);
});

test('pickSeparator: handles sub-pixel borders and picks the lowest valid edge', () => {
  const a = { top: 0, bottom: 44.5, width: 900, bw: 0.5 };
  const b = { top: 0, bottom: 45, width: 900, bw: 1 };
  assert.deepEqual(U.pickSeparator([a]), { bottom: 44.5, bw: 0.5 });
  assert.deepEqual(U.pickSeparator([a, b]), { bottom: 45, bw: 1 });
});

test('pickSeparator: hairline element that IS the separator (claude.ai chat pages)', () => {
  // Measured on claude.ai at 1.5x zoom: a div 44.33..45.00 tall, 1419 wide.
  const hairline = { kind: 'line', top: 44.33, bottom: 45, width: 1419 };
  const sep = U.pickSeparator([hairline]);
  assert.equal(sep.bottom, 45);
  assert.ok(Math.abs(sep.bw - 0.67) < 0.01, `bw ${sep.bw}`);

  // Header bar with no border of its own must not be mistaken for the line.
  const bar = { kind: 'border', top: 0, bottom: 45, width: 1409, bw: 0 };
  assert.equal(U.pickSeparator([bar]), null);
  assert.equal(U.pickSeparator([bar, hairline]).bottom, 45);
});

test('pickSeparator: rejects hairline-shaped things that are not the header line', () => {
  const bad = [
    { kind: 'line', top: 44, bottom: 52, width: 1400 }, // 8px tall: a bar, not a hairline
    { kind: 'line', top: 300, bottom: 301, width: 1400 }, // far below the header
    { kind: 'line', top: 44.3, bottom: 45, width: 80 }, // too narrow (e.g. an icon underline)
    { kind: 'line', top: 10, bottom: 11, width: 1400 }, // too high: part of the bar itself
    { kind: 'line', top: 44, bottom: 44, width: 1400 }, // zero height
  ];
  assert.equal(U.pickSeparator(bad), null);
});

test('centeredLeft: centres on the axis, keeps the box inside the viewport', () => {
  assert.equal(U.centeredLeft(500, 300, 1000), 350);
  assert.equal(U.centeredLeft(500.4, 301, 1000), 350); // whole pixels
  assert.equal(U.centeredLeft(10, 300, 1000), 8); // clamp left
  assert.equal(U.centeredLeft(990, 300, 1000), 692); // clamp right
  assert.equal(U.centeredLeft(500, 2000, 1000), 8); // wider than viewport
});

test('formatAgo', () => {
  assert.equal(U.formatAgo(1000), 'just now');
  assert.equal(U.formatAgo(42 * 1000), '42s ago');
  assert.equal(U.formatAgo(3 * 60 * 1000), '3m ago');
});

test('burn word pool is locked per tier', () => {
  const tiers = U.BURN_WORDS.map((t) => t.words.join(' '));
  assert.deepEqual(tiers, [
    'sparked sizzled noice tidy neat clean burnt crisp cute',
    'toasted scorched torched blazed solid sheesh bussin cooked smooth',
    'blasted kaboom ouch daammn yowza banger',
    'nuked wildfire lessgoo massive absurd',
    'shattered legend godmode cinema',
  ]);
});

test('burn word tier boundaries', () => {
  const first = () => 0;
  const pool = (i) => U.BURN_WORDS[i].words;
  assert.equal(U.pickBurnWord(1, first), pool(0)[0]);
  assert.equal(U.pickBurnWord(2, first), pool(1)[0]);
  assert.equal(U.pickBurnWord(7, first), pool(1)[0]);
  assert.equal(U.pickBurnWord(8, first), pool(2)[0]);
  assert.equal(U.pickBurnWord(15, first), pool(2)[0]);
  assert.equal(U.pickBurnWord(16, first), pool(3)[0]);
  assert.equal(U.pickBurnWord(40, first), pool(3)[0]);
  assert.equal(U.pickBurnWord(41, first), pool(4)[0]);
  assert.equal(U.pickBurnWord(100, first), pool(4)[0]);
});

test('burn word picks across the whole tier and tolerates rng edges', () => {
  const last = (i) => U.BURN_WORDS[i].words[U.BURN_WORDS[i].words.length - 1];
  assert.equal(U.pickBurnWord(3, () => 0.999999), last(1));
  assert.equal(U.pickBurnWord(3, () => 1), last(1)); // rng must not index out of range
  const seen = new Set();
  for (let n = 0; n < 9; n++) seen.add(U.pickBurnWord(1, () => n / 9));
  assert.equal(seen.size, 9);
});

test('burn word falls back to the smallest tier for odd input', () => {
  for (const bad of [0, -3, NaN, undefined]) {
    assert.ok(U.BURN_WORDS[0].words.includes(U.pickBurnWord(bad)));
  }
});

test('burn power steps up with the tier', () => {
  assert.equal(U.burnPower(1), 0);
  assert.equal(U.burnPower(2), 0.25);
  assert.equal(U.burnPower(7), 0.25);
  assert.equal(U.burnPower(8), 0.5);
  assert.equal(U.burnPower(16), 0.75);
  assert.equal(U.burnPower(41), 1);
  assert.equal(U.burnPower(500), 1);
  assert.equal(U.burnPower(NaN), 0);
});









test('heatLevel thresholds', () => {
  const cases = [[0, 0], [79.9, 0], [80, 1], [89.9, 1], [90, 2], [94.9, 2], [95, 3], [99.4, 3], [99.5, 4], [100, 4], [130, 4], [NaN, 0]];
  for (const [pct, lvl] of cases) assert.equal(U.heatLevel(pct), lvl, `pct ${pct}`);
  assert.deepEqual(U.WARN_WORDS.slice(1), ['running hot', 'redline', 'last drop']);
});

test('auroraStrength ramps from 90 to 100', () => {
  assert.equal(U.auroraStrength(89.9), 0);
  assert.equal(U.auroraStrength(90), 0);
  assert.equal(U.auroraStrength(95), 0.5);
  assert.equal(U.auroraStrength(100), 1);
  assert.equal(U.auroraStrength(120), 1);
  assert.equal(U.auroraStrength(NaN), 0);
});

test('heatRgb goes from amber to red', () => {
  assert.equal(U.heatRgb(0), '255, 160, 40');
  assert.equal(U.heatRgb(1), '240, 50, 35');
  assert.equal(U.heatRgb(5), '240, 50, 35');
});

test('formatResetAt: time only when soon, weekday when further out', () => {
  const now = new Date(2026, 10, 25, 9, 0).getTime();
  const soon = U.formatResetAt(new Date(2026, 10, 25, 21, 40), now, 'en-US');
  assert.equal(soon, '9:40 PM');
  const later = U.formatResetAt(new Date(2026, 10, 27, 9, 0), now, 'en-US');
  assert.equal(later, 'Fri 9 AM');
});


test('placeBetween: centred when the title is short', () => {
  assert.equal(U.placeBetween(579, 338, 450, 1121), 579);
});

test('placeBetween: slides right past a long title (incl. its chevron)', () => {
  assert.equal(U.placeBetween(579, 338, 700, 1121), 712);
});

test('placeBetween: never runs into the buttons or a side panel', () => {
  assert.equal(U.placeBetween(800, 338, 450, 1121), 1121 - 12 - 338);
  // gap too narrow: stay off the buttons, title end goes under
  assert.equal(U.placeBetween(579, 338, 833, 1121), 771);
});

test('splitHeader: title chevron past the middle still counts as the title', () => {
  // breadcrumb, title, chevron (631..660), then Step / Share far right
  const c = [{ l: 196, r: 330 }, { l: 340, r: 630 }, { l: 631, r: 660 }, { l: 866, r: 960 }, { l: 975, r: 1040 }];
  assert.deepEqual(U.splitHeader(c), { lastLeft: 660, firstRight: 866 });
});

test('splitHeader: no right-side buttons (side panel open) -> all left', () => {
  const c = [{ l: 120, r: 160 }, { l: 196, r: 330 }, { l: 340, r: 630 }, { l: 631, r: 660 }];
  assert.deepEqual(U.splitHeader(c), { lastLeft: 660, firstRight: null });
});

test('splitHeader: empty', () => {
  assert.deepEqual(U.splitHeader([]), { lastLeft: null, firstRight: null });
});

test('splitHeader: long title pressed against the buttons -> trailing text buttons are the right group', () => {
  const c = [{ l: 196, r: 330 }, { l: 340, r: 720 }, { l: 720, r: 735 }, { l: 735, r: 820, btn: true }, { l: 836, r: 884, btn: true }];
  assert.deepEqual(U.splitHeader(c, 900), { lastLeft: 735, firstRight: 735 });
});

test('splitHeader: side panel, title + icon chevron near the panel edge -> all left', () => {
  const c = [{ l: 196, r: 330 }, { l: 340, r: 583 }, { l: 583, r: 596 }];
  assert.deepEqual(U.splitHeader(c, 612), { lastLeft: 596, firstRight: null });
});
