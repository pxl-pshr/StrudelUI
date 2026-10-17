// Trim panel: a sample's waveform with start / end handles. The handles are
// .begin() / .end() in the track's chain, fractions of the file's length;
// 0 and 1 are the defaults, so those remove the line instead.

import { h, popover } from './popover.js';
import { sampleBuffer, audition } from './sounds.js';

const MIN_GAP = 0.005; // smallest begin → end distance
const STEP = 0.01; // arrow keys; shift: STEP * 10

// min / max of each pixel column across all channels: [lo0, hi0, lo1, hi1, …]
export function peaks(buffer, cols) {
  const data = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const per = buffer.length / cols;
  const out = new Float32Array(cols * 2);
  for (let x = 0; x < cols; x++) {
    const a = Math.floor(x * per);
    const b = Math.min(buffer.length, Math.max(a + 1, Math.floor((x + 1) * per)));
    let lo = 0;
    let hi = 0;
    for (const d of data) {
      for (let i = a; i < b; i++) {
        if (d[i] < lo) lo = d[i];
        else if (d[i] > hi) hi = d[i];
      }
    }
    out[2 * x] = lo;
    out[2 * x + 1] = hi;
  }
  return out;
}

// keep both points in 0-1 with begin before end; `moved` is the one being set
export function clampRange(begin, end, moved) {
  begin = Math.min(Math.max(begin, 0), 1 - MIN_GAP);
  end = Math.min(Math.max(end, MIN_GAP), 1);
  if (end - begin < MIN_GAP) {
    if (moved === 'begin') begin = end - MIN_GAP;
    else end = begin + MIN_GAP;
  }
  return { begin: round(begin), end: round(end) };
}
const round = (v) => Math.round(v * 1000) / 1000;

// read(): { begin, end } from the code (null = default, NaN = not a plain number)
// write(begin, end, merge): writes both (0 / 1 remove the lines)
export function openTrim({ anchor, id, sound, note, read, write, onStatus }) {
  const label = `${sound.name}${sound.n ? `:${sound.n}` : ''}`;
  const title = h('div', 'fx-title', `${id} · trim ${label}`);
  const wave = h('div', 'trim-wave');
  const canvas = h('canvas');
  const msg = h('div', 'trim-msg', 'loading…');
  const handles = { begin: h('div', 'trim-handle'), end: h('div', 'trim-handle') };
  for (const [key, el] of Object.entries(handles)) {
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', `${id} trim ${key === 'begin' ? 'start' : 'end'}`);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '1');
  }
  wave.append(canvas, msg, handles.begin, handles.end);

  const info = h('span', 'trim-info');
  const play = h('button', 'link', '▶ play');
  const reset = h('button', 'link', 'reset');
  play.type = reset.type = 'button';
  const foot = h('div', 'trim-foot');
  foot.append(info, play, reset);

  let closed = false;
  const resize = new ResizeObserver(() => {
    cols = null;
    draw();
  });
  const pop = popover(anchor, [title, wave, foot], {
    className: 'fx-panel trim-panel',
    label: `${id} trim`,
    onClose: () => {
      closed = true;
      resize.disconnect();
    },
  });

  let buffer = null;
  let cols = null; // peaks for the current canvas width
  const range = () => {
    const { begin, end } = read();
    return { begin: begin ?? 0, end: end ?? 1 };
  };
  const fixed = (v) => Number.isNaN(v); // written as a pattern: the code owns it

  function draw() {
    const { begin, end } = range();
    for (const [key, el] of Object.entries(handles)) {
      const v = key === 'begin' ? begin : end;
      el.hidden = fixed(v);
      if (fixed(v)) continue;
      el.style.left = `${v * 100}%`;
      el.setAttribute('aria-valuenow', String(v));
      el.setAttribute('aria-valuetext', v.toFixed(3));
    }
    const len = buffer ? ` · ${(((fixed(end) ? 1 : end) - (fixed(begin) ? 0 : begin)) * buffer.duration).toFixed(2)} s` : '';
    const show = (v) => (fixed(v) ? 'in code' : v.toFixed(2));
    info.textContent = `start ${show(begin)} · end ${show(end)}${len}`;
    if (!buffer) return;

    const dpr = devicePixelRatio || 1;
    const w = Math.round(wave.clientWidth * dpr);
    const ht = Math.round(wave.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== ht || !cols) {
      canvas.width = w;
      canvas.height = ht;
      cols = peaks(buffer, w);
    }
    const css = getComputedStyle(wave);
    const on = css.getPropertyValue('--accent').trim();
    const off = css.getPropertyValue('--dim').trim();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, ht);
    const mid = ht / 2;
    const a = fixed(begin) ? 0 : begin * w;
    const b = fixed(end) ? w : end * w;
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = x >= a && x <= b ? on : off;
      ctx.globalAlpha = x >= a && x <= b ? 1 : 0.35;
      const top = mid - cols[2 * x + 1] * mid;
      const bottom = mid - cols[2 * x] * mid;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.globalAlpha = 1;
  }

  const set = (key, v, merge) => {
    const cur = range();
    if (fixed(cur[key])) return;
    const next = clampRange(key === 'begin' ? v : cur.begin, key === 'end' ? v : cur.end, key);
    write(fixed(cur.begin) ? NaN : next.begin, fixed(cur.end) ? NaN : next.end, merge);
    draw();
  };
  const listen = () => {
    const { begin, end } = range();
    const params = {};
    if (!fixed(begin)) params.begin = begin;
    if (!fixed(end)) params.end = end;
    audition(sound, note, false, params);
  };

  // drag anywhere on the waveform: moves the nearer handle
  wave.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !buffer) return;
    e.preventDefault();
    const box = wave.getBoundingClientRect();
    const at = (ev) => (ev.clientX - box.left) / box.width;
    const { begin, end } = range();
    const free = ['begin', 'end'].filter((k) => !fixed(k === 'begin' ? begin : end));
    if (!free.length) return;
    const x = at(e);
    const key = free.length === 1 ? free[0] : Math.abs(x - begin) <= Math.abs(x - end) ? 'begin' : 'end';
    wave.setPointerCapture(e.pointerId);
    handles[key].focus();
    set(key, x, 'start');
    const move = (ev) => set(key, at(ev), true);
    const up = () => {
      wave.removeEventListener('pointermove', move);
      wave.removeEventListener('pointerup', up);
      wave.removeEventListener('pointercancel', up);
      listen();
    };
    wave.addEventListener('pointermove', move);
    wave.addEventListener('pointerup', up);
    wave.addEventListener('pointercancel', up);
  });

  for (const [key, el] of Object.entries(handles)) {
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? STEP * 10 : STEP;
      const v = range()[key];
      const to = { ArrowLeft: v - step, ArrowDown: v - step, ArrowRight: v + step, ArrowUp: v + step, Home: 0, End: 1 }[e.key];
      if (to === undefined) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation(); // space would also toggle play
          listen();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation(); // arrows also drive the rack
      set(key, to, true);
    });
  }

  play.addEventListener('click', listen);
  reset.addEventListener('click', () => {
    const { begin, end } = read();
    if (fixed(begin) || fixed(end)) return onStatus(`${id}: start or end is written as a pattern · change it in the code`);
    write(0, 1, false);
    draw();
    onStatus(`${id} · trim reset`);
  });

  resize.observe(wave);
  draw();
  (handles.begin.hidden ? play : handles.begin).focus();
  sampleBuffer(sound, note)
    .then((b) => {
      if (closed) return;
      if (!b) throw new Error('not a sample');
      buffer = b;
      msg.remove();
      draw();
    })
    .catch(() => {
      msg.textContent = "couldn't load this sample";
    });
  return pop;
}
