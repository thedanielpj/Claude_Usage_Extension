// TEMP-TEST: test panel for the burn animation. Delete this file, the "Testing" block in
// popup.html, its CSS in popup.css, and the TEMP-TEST hook in src/content.js before release.
(function () {
  'use strict';
  const TIERS = [
    { label: '+1%', delta: 1 },
    { label: '+5%', delta: 5 },
    { label: '+12%', delta: 12 },
    { label: '+25%', delta: 25 },
    { label: '+60%', delta: 60 },
  ];
  const play = (delta, word) =>
    chrome.storage.local.set({ cuo_test_burn: { delta, word: word || null, n: Date.now() } });

  const btns = document.getElementById('t-tiers');
  TIERS.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.title = 'Random word for ' + t.label;
    b.addEventListener('click', () => play(t.delta));
    btns.appendChild(b);
  });

  const sel = document.getElementById('t-word');
  const rnd = document.createElement('option');
  rnd.value = '';
  rnd.textContent = 'Random word';
  sel.appendChild(rnd);
  window.ClaudeUsage.BURN_WORDS.forEach((tier, i) => {
    const g = document.createElement('optgroup');
    g.label = TIERS[i].label + ' tier';
    tier.words.forEach((w) => {
      const o = document.createElement('option');
      o.value = TIERS[i].delta + ':' + w;
      o.textContent = w;
      g.appendChild(o);
    });
    sel.appendChild(g);
  });
  document.getElementById('t-play').addEventListener('click', () => {
    if (!sel.value) return play(TIERS[Math.floor(Math.random() * TIERS.length)].delta);
    const [d, w] = sel.value.split(':');
    play(Number(d), w);
  });
})();
