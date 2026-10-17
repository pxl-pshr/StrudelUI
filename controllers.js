// Controllers: drive the app from a MIDI controller (Web MIDI: Chrome, Edge)
// or the computer keyboard, by "MIDI learn": in map mode, click a control,
// then turn a knob / press a pad or key to link them.
//
// Mappable controls carry data-map="target" (app.js sets it): play, bpm, pump,
// mute:kick, solo:kick, gain:kick (or any slider column), step:kick:4 (cell 5
// on the bar shown), page:2 (bar 3), scene:intro. A mapping fires the control
// itself, so it does exactly what a click or a slider drag does (same code
// edits, same undo steps). Mappings name tracks, so they carry over to any
// tune with the same names.

import { popover, h } from './popover.js';

const STORE = 'beats-ui-controllers-v1';

// ── pure parts (tested in node) ──────────────────

// a source: { device, cc|note, channel (1-16) } or { key: KeyboardEvent.code }
export const sourceId = (s) => (s.key ? `key|${s.key}` : `midi|${s.device}|${s.cc != null ? `cc|${s.cc}` : `note|${s.note}`}|${s.channel}`);

// one MIDI message -> { source, press, value } or null for anything else.
// A note-on is a press. A CC is a value (0-1) for sliders, and a press when it
// rises past the middle, for controllers whose buttons send CC 127/0.
export function readMidi(device, data, last = {}) {
  const [st, a, b = 0] = data;
  const kind = st & 0xf0;
  const channel = (st & 0x0f) + 1;
  if (kind === 0x90 && b > 0) return { source: { device, note: a, channel }, press: true, value: null };
  if (kind !== 0xb0) return null; // note-offs, clock, pitch bend…
  const source = { device, cc: a, channel };
  const id = sourceId(source);
  const press = b >= 64 && (last[id] ?? 0) < 64;
  last[id] = b;
  return { source, press, value: b / 127 };
}

// keys a mapping may use: letters, digits, punctuation, the number pad. Not
// space, [ ], arrows, Enter, Esc, Tab or F-keys, which the app or browser use.
export const MAPPABLE_KEY = /^(Key[A-Z]|Digit\d|Numpad(\d|Add|Subtract|Multiply|Divide|Decimal)|Minus|Equal|Semicolon|Quote|Comma|Period|Slash|Backslash|Backquote|IntlBackslash)$/;

// the row's slider columns (app.js CONTROLS)
const SLIDERS = 'gain|lpf|hpf|room|delay|pan|distort|crush|coarse|swingBy';
const TARGET = new RegExp(`^(play|bpm|pump|page:\\d+|scene:\\w+|(mute|solo|${SLIDERS}):\\w+|step:\\w+:\\d+)$`);
export const continuous = (target) => new RegExp(`^(bpm|pump|(${SLIDERS}):)`).test(target);
const SLIDER_NAMES = { lpf: 'high cut', hpf: 'low cut', room: 'space', swingBy: 'swing' };

export function targetLabel(target) {
  const [what, id, n] = target.split(':');
  if (what === 'play') return 'play / stop';
  if (what === 'page') return `bar ${Number(id) + 1}`;
  if (what === 'scene') return `scene ${id}`;
  if (what === 'step') return `${id} step ${Number(n) + 1}`;
  return id ? `${id} ${SLIDER_NAMES[what] ?? what}` : what;
}

export function sourceLabel(s) {
  if (s.key) return `key ${s.key.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'num ').toLowerCase()}`;
  return `${s.cc != null ? `cc ${s.cc}` : `note ${s.note}`} · ch ${s.channel} · ${s.device}`;
}

// a rename in the tune renames the mappings that use the name
export function renameTarget(target, from, to) {
  const parts = target.split(':');
  if (parts[1] === from && parts[0] !== 'page') parts[1] = to;
  return parts.join(':');
}

// a mappings file (or what's stored) -> the mappings it holds that make sense
export function readMappings(json) {
  const list = Array.isArray(json) ? json : json?.mappings;
  if (!Array.isArray(list)) throw new Error('not a StrudelUI controller mappings file');
  const ch = (c) => Number.isInteger(c) && c >= 1 && c <= 16;
  const byte = (n) => Number.isInteger(n) && n >= 0 && n <= 127;
  return list.filter((m) => typeof m?.target === 'string' && TARGET.test(m.target) && (
    (typeof m.key === 'string' && MAPPABLE_KEY.test(m.key)) ||
    (typeof m.device === 'string' && ch(m.channel) && (m.cc != null ? byte(m.cc) && m.note == null : byte(m.note)))
  )).map(({ key, device, cc, note, channel, target }) => (key ? { key, target } : { device, ...(cc != null ? { cc } : { note }), channel, target }));
}

// ── state ─────────────────────────────────────────

let mappings = load();
const lastCC = {}; // source id -> last CC value, for presses
let status = () => {};
let mapBtn = null;
let learning = false;
let armed = null; // the target waiting for a knob / pad / key
let firing = false; // a mapping is clicking a control: learn mode lets it through
let midi = null; // MIDIAccess once granted
let midiError = '';

function load() {
  try {
    return readMappings(JSON.parse(localStorage.getItem(STORE)));
  } catch {
    return [];
  }
}
function store() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ mappings }));
  } catch {
    status("couldn't keep the mappings: browser storage is full", true);
  }
}

const find = (target) => document.querySelector(`[data-map="${CSS.escape(target)}"]`);

// ── firing ────────────────────────────────────────

// knobs send hundreds of values a second: apply the latest at most every
// 16 ms. setTimeout, not requestAnimationFrame, which pauses while the window
// is hidden or occluded.
const pending = new Map();
let timer = 0;
let flushed = 0;
function setValue(target, v) {
  pending.set(target, v);
  timer ||= setTimeout(() => {
    timer = 0;
    flushed = performance.now();
    for (const [t, value] of pending) fire(t, value);
    pending.clear();
  }, Math.max(0, 16 - (performance.now() - flushed)));
}

// value: 0-1 for sliders, null for a press
function fire(target, value = null) {
  const el = find(target);
  if (!el || el.disabled || el.closest('[hidden]')) return;
  firing = true;
  try {
    if (value == null) el.click();
    else {
      const min = Number(el.min);
      el.value = String(min + value * (Number(el.max) - min));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } finally {
    firing = false;
  }
}

function handle(source, press, value) {
  if (learning && armed) return learn(source, press, value);
  const id = sourceId(source);
  for (const m of mappings) {
    if (sourceId(m) !== id) continue;
    if (continuous(m.target)) {
      if (value != null) setValue(m.target, value);
    } else if (press) fire(m.target);
  }
}

// ── learn ─────────────────────────────────────────

function learn(source, press, value) {
  const target = armed;
  if (continuous(target)) {
    if (value == null) return status(`${targetLabel(target)} is a slider: turn a knob or move a fader for it`);
  } else if (!press) return; // a knob passing through: wait for a press
  const id = sourceId(source);
  mappings = mappings.filter((m) => sourceId(m) !== id);
  mappings.push({ ...source, target });
  store();
  const [what, track, cell] = target.split(':');
  // a run of pads onto a row: the next step waits for the next pad
  armed = what === 'step' && Number(cell) < 15 && find(`step:${track}:${Number(cell) + 1}`) ? `step:${track}:${Number(cell) + 1}` : null;
  mark();
  status(`${sourceLabel(source)} → ${targetLabel(target)}${armed ? ` · next pad: ${targetLabel(armed)}` : ''}`);
}

function startLearning() {
  learning = true;
  armed = null;
  document.body.classList.add('mapping');
  mapBtn.textContent = 'done mapping';
  mapBtn.classList.add('live');
  mark();
  status(`map: click a control, then turn a knob, press a pad or a key${midi ? '' : ' (no MIDI connected: keys only)'} · esc when done`, false, { label: 'done', run: stopLearning });
}

function stopLearning() {
  if (!learning) return;
  learning = false;
  armed = null;
  document.body.classList.remove('mapping');
  mapBtn.textContent = 'map';
  mapBtn.classList.remove('live');
  mark();
  status(`${mappings.length} mapping${mappings.length === 1 ? '' : 's'}`);
}

// outline what can be mapped, what is, and what's waiting; app.js calls this
// after it redraws
export function mark() {
  for (const el of document.querySelectorAll('[data-map].mapped, [data-map].armed')) el.classList.remove('mapped', 'armed');
  if (!learning) return;
  for (const m of mappings) find(m.target)?.classList.add('mapped');
  if (armed) find(armed)?.classList.add('armed');
}

// in map mode a click on a control picks it instead of using it
function pick(e) {
  if (!learning || firing) return;
  const el = e.target.closest?.('[data-map]');
  if (!el || el.closest('.pop')) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === 'click') arm(armed === el.dataset.map ? null : el.dataset.map);
}

function arm(target) {
  armed = target;
  mark();
  if (armed) {
    const has = mappings.filter((m) => m.target === armed).map(sourceLabel);
    status(`${targetLabel(armed)}: ${continuous(armed) ? 'turn a knob or fader' : 'press a pad, button or key'}${has.length ? ` · now on ${has.join(', ')}` : ''}`);
  }
}

// ── keys ──────────────────────────────────────────

function onKey(e) {
  if (e.defaultPrevented || e.repeat) return;
  if (learning && e.key === 'Escape' && !document.querySelector('.pop')) {
    stopLearning();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  // map mode, keyboard: Enter on a slider picks it (buttons pick on click)
  if (learning && e.key === 'Enter' && e.target.matches?.('input[data-map]')) {
    e.preventDefault();
    arm(e.target.dataset.map);
    return;
  }
  if (e.target.closest?.('.cm-editor, input, textarea, select, [contenteditable], .pop')) return;
  if (!MAPPABLE_KEY.test(e.code)) {
    if (learning && armed && /^(Space|BracketLeft|BracketRight)$/.test(e.code)) {
      e.preventDefault();
      status(`${e.key === ' ' ? 'space' : e.key} is taken (play, bars): pick another key`);
    }
    return;
  }
  const mine = (learning && armed) || mappings.some((m) => m.key === e.code);
  if (!mine) return;
  e.preventDefault();
  handle({ key: e.code }, true, null);
}

// ── MIDI ──────────────────────────────────────────

const listening = new WeakSet();
const portState = new Map(); // port id -> connected / disconnected
function attach() {
  for (const input of midi.inputs.values()) {
    portState.set(input.id, input.state);
    if (listening.has(input)) continue;
    listening.add(input);
    input.addEventListener('midimessage', (e) => {
      const msg = readMidi(input.name || 'midi', e.data, lastCC);
      if (msg) handle(msg.source, msg.press, msg.value);
    });
    input.open?.().catch(() => {});
  }
}

const inputNames = () => (midi ? [...midi.inputs.values()].filter((i) => i.state !== 'disconnected').map((i) => i.name) : []);

// requestMIDIAccess (may show the browser's permission prompt)
async function connect() {
  if (midi) return midi;
  if (!navigator.requestMIDIAccess) {
    midiError = 'this browser has no Web MIDI (use Chrome or Edge) · keys still work';
    return null;
  }
  try {
    midi = await navigator.requestMIDIAccess();
    midiError = '';
    attach();
    // plugged in or out: listen to new inputs, and say so
    midi.addEventListener('statechange', (e) => {
      const was = portState.get(e.port.id);
      attach();
      if (e.port.type === 'input' && was !== e.port.state) status(`${e.port.name} ${e.port.state}`);
    });
  } catch (err) {
    midiError = `no MIDI access: ${err.message ?? err} · keys still work`;
  }
  return midi;
}

// ── panel ─────────────────────────────────────────

async function openPanel() {
  await connect();
  const devices = inputNames();
  const title = h('div', 'fx-title', 'controllers');
  const dev = h('div', 'fx-value map-note', midiError || (devices.length ? `MIDI in: ${devices.join(', ')}` : 'no MIDI devices found: plug one in · keys work too'));
  const learnBtn = h('button', 'link', '● map controls…');
  learnBtn.type = 'button';
  learnBtn.title = 'click a control, then turn a knob / press a pad or key';
  learnBtn.addEventListener('click', () => {
    pop.close();
    startLearning();
  });
  const rowsEl = h('div', 'map-list');
  const draw = () => {
    rowsEl.replaceChildren(
      ...(mappings.length ? [] : [h('div', 'fx-value map-note', 'nothing mapped yet')]),
      ...mappings.map((m) => {
        const row = h('div', `map-row${find(m.target) ? '' : ' gone'}`);
        const what = h('span', 'map-what', `${sourceLabel(m)} → ${targetLabel(m.target)}`);
        if (!find(m.target)) what.title = 'not in this tune';
        const del = h('button', 'snd-del', '×');
        del.type = 'button';
        del.setAttribute('aria-label', `remove ${sourceLabel(m)} → ${targetLabel(m.target)}`);
        del.addEventListener('click', () => {
          mappings = mappings.filter((x) => x !== m);
          store();
          draw();
          (rowsEl.querySelector('.snd-del') ?? learnBtn).focus();
        });
        row.append(what, del);
        return row;
      }),
    );
  };
  draw();
  const foot = h('div', 'ask');
  const exp = h('button', 'link', 'export');
  const imp = h('button', 'link', 'import');
  exp.type = imp.type = 'button';
  exp.title = 'download the mappings as JSON';
  imp.title = 'add mappings from a JSON file (same controls are replaced)';
  exp.disabled = !mappings.length;
  exp.addEventListener('click', () => {
    const json = JSON.stringify({ strudelui: 'controllers', version: 1, mappings }, null, 2);
    const a = h('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'strudelui-controllers.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  });
  imp.addEventListener('click', () => {
    const input = h('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const got = readMappings(JSON.parse(await f.text()));
        const ids = new Set(got.map(sourceId));
        mappings = [...mappings.filter((m) => !ids.has(sourceId(m))), ...got];
        store();
        draw();
        exp.disabled = !mappings.length;
        status(`imported ${got.length} mapping${got.length === 1 ? '' : 's'}`);
      } catch (err) {
        status(`couldn't import: ${err.message ?? err}`, true);
      }
    });
    input.click();
  });
  foot.append(learnBtn, h('span', 'pager-gap'), exp, imp);
  const pop = popover(mapBtn, [title, dev, rowsEl, foot], { className: 'ask-panel map-panel', label: 'controllers' });
  learnBtn.focus();
}

// ── setup ─────────────────────────────────────────

export function initControllers({ button, onStatus }) {
  mapBtn = button;
  status = onStatus;
  mapBtn.addEventListener('click', () => (learning ? stopLearning() : openPanel()));
  for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, pick, true);
  window.addEventListener('keydown', onKey);
  // MIDI access granted on an earlier visit: connect without asking
  navigator.permissions?.query({ name: 'midi' }).then((p) => p.state === 'granted' && connect(), () => {});
}

export function renameMappings(from, to) {
  const next = mappings.map((m) => ({ ...m, target: renameTarget(m.target, from, to) }));
  if (next.some((m, i) => m.target !== mappings[i].target)) {
    mappings = next;
    store();
  }
}
