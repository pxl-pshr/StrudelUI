// The learn page: every <pre class="ex"> becomes an editable example that
// plays (one shared Strudel engine, one example at a time), shows its grid
// and opens in StrudelUI.

import './vendor/strudel-repl/index.mjs'; // defines <strudel-editor>
import { parse, STEPS } from './code.js';
import { h } from './popover.js';

// one hidden editor is the player for every example
const engineHost = h('div');
engineHost.hidden = true;
document.body.append(engineHost);
const engine = document.createElement('strudel-editor');
engine.setAttribute('code', '// learn');
engineHost.append(engine);
const player = engine.editor;

let active = null; // the example playing: { box, code, cells, … }

// the app reads a tune from #code=<base64 of the code>, like strudel.cc does
function appLink(code) {
  let bin = '';
  for (const byte of new TextEncoder().encode(code)) bin += String.fromCharCode(byte);
  return `index.html#code=${encodeURIComponent(btoa(bin))}`;
}

function example(pre, index) {
  const original = pre.textContent.replace(/\s+$/, '');
  const box = h('div', 'ex-box');
  const bar = h('div', 'ex-bar');
  const play = h('button', 'ex-play', '▶ play');
  play.type = 'button';
  const reset = h('button', 'ex-link', 'reset');
  reset.type = 'button';
  reset.hidden = true;
  const open = h('a', 'ex-link', 'open in StrudelUI ↗');
  open.style.marginLeft = 'auto';
  open.target = '_blank'; // new tab: the learn page keeps its scroll position
  bar.append(play, reset, open);

  const code = h('textarea', 'ex-code');
  Object.assign(code, { value: original, spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
  code.setAttribute('aria-label', `example ${index + 1}: Strudel code, editable`);
  const err = h('div', 'ex-err');
  err.setAttribute('role', 'status');
  const grid = h('div', 'ex-grid');
  grid.setAttribute('aria-hidden', 'true');
  box.append(bar, code, err, grid);
  pre.replaceWith(box);

  const ex = { box, code, play, err, grid, rows: [] };
  const fit = () => {
    code.style.height = 'auto';
    code.style.height = `${code.scrollHeight}px`;
  };

  // the grid StrudelUI would show for this code (first bar of each track)
  function drawGrid() {
    let tune;
    try {
      tune = parse(code.value);
    } catch {
      return;
    }
    ex.rows = [];
    grid.replaceChildren(
      ...tune.tracks.map((t) => {
        const row = h('div', `g-row${t.mute ? ' muted' : ''}`);
        row.append(h('span', 'g-name', t.id));
        if (t.kind === 'code') {
          row.append(h('span', 'g-code', 'code · plays as written'));
          return row;
        }
        const steps = h('div', 'g-steps');
        const cells = t.steps.slice(0, STEPS).map((v) => {
          const c = h('span', v ? 'on' : '', typeof v === 'string' ? v : '');
          steps.append(c);
          return c;
        });
        ex.rows.push({ bars: t.bars, steps: t.steps, cells });
        row.append(steps);
        return row;
      }),
    );
  }

  const update = () => {
    fit();
    drawGrid();
    open.href = appLink(code.value);
    reset.hidden = code.value === original;
  };
  let typing;
  code.addEventListener('input', () => {
    update();
    // live: while it plays, re-evaluate shortly after typing stops
    clearTimeout(typing);
    if (active === ex) typing = setTimeout(() => run(ex), 400);
  });
  code.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run(ex);
    } else if ((e.ctrlKey || e.metaKey) && e.key === '.') {
      e.preventDefault();
      stop();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.altKey) {
      // two spaces, like the rest of the code (Esc then Tab moves on)
      if (code.dataset.tabs === 'off') return;
      e.preventDefault();
      code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
      code.dispatchEvent(new Event('input'));
    } else if (e.key === 'Escape') code.dataset.tabs = 'off';
  });
  code.addEventListener('focus', () => delete code.dataset.tabs);
  play.addEventListener('click', () => (active === ex ? stop() : run(ex)));
  reset.addEventListener('click', () => {
    code.value = original;
    update();
    if (active === ex) run(ex);
  });
  update();
  return ex;
}

async function run(ex) {
  if (active && active !== ex) markStopped(active);
  active = ex;
  ex.box.classList.add('playing');
  ex.play.textContent = '■ stop';
  ex.err.textContent = '';
  await player.prebaked;
  await player.repl.evaluate(ex.code.value);
  const error = player.repl.state.evalError;
  if (error) ex.err.textContent = `error: ${error.message ?? error}`;
}

function markStopped(ex) {
  ex.box.classList.remove('playing');
  ex.play.textContent = '▶ play';
  for (const r of ex.rows) for (const c of r.cells) c.classList.remove('now');
}

function stop() {
  player.stop();
  if (active) markStopped(active);
  active = null;
}

// playhead on the playing example's grid
let lit = -1;
(function frame() {
  if (active && player.repl.scheduler.started) {
    const pos = player.repl.scheduler.now();
    const step = Math.floor((((pos % 1) + 1) % 1) * STEPS);
    if (step !== lit) {
      const bar = Math.floor(pos);
      for (const r of active.rows) {
        const b = ((bar % r.bars) + r.bars) % r.bars;
        r.cells.forEach((c, i) => {
          const v = r.steps[b * STEPS + i];
          c.classList.toggle('on', !!v);
          c.textContent = typeof v === 'string' ? v : '';
          c.classList.toggle('now', i === step);
        });
      }
      lit = step;
    }
  }
  requestAnimationFrame(frame);
})();

document.querySelectorAll('pre.ex').forEach(example);

// highlight the nav link of the section in view
const links = [...document.querySelectorAll('nav a')];
const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links) a.classList.toggle('on', a.hash === `#${e.target.id}`);
    }
  },
  { rootMargin: '-20% 0px -70% 0px' },
);
document.querySelectorAll('article section').forEach((s) => seen.observe(s));

// back to top, once the first lesson has scrolled away
const toTop = document.querySelector('.to-top');
const first = document.querySelector('article section');
new IntersectionObserver(([e]) => toTop.classList.toggle('shown', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(first);
toTop.addEventListener('click', () => {
  scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  history.replaceState(null, '', location.pathname);
  document.querySelector('nav a')?.focus({ preventScroll: true });
});

// Esc (outside the code) stops
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && active && !e.target.closest('textarea')) stop();
});
