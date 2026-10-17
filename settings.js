// Settings: theme, layout, audio output device, code font size, code helpers,
// editor keys, and a reset of everything StrudelUI keeps. Kept in this browser
// (theme under theme.js's key, the rest under STORE).
// applyTheme and THEME_STORE come from theme.js, a classic script in <head>.

import { h, popover } from './popover.js';

const STORE = 'strudelui-settings';
const FONT = { min: 9, max: 20, def: 12 };
const THEMES = [['', 'default'], ['strudel', 'strudel']];

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
}
function save(change) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...load(), ...change }));
  } catch {}
}

const canPickOutput = () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

// Sends the page's audio to a device ('' = the system default). Live playback
// only: exports render offline and don't play.
async function setOutput(id) {
  const ctx = globalThis.getAudioContext?.();
  if (!ctx || !canPickOutput() || ctx.sinkId === id) return;
  await ctx.setSinkId(id);
}

// Outputs with names. Browsers only name devices once the page has had
// microphone access, so `ask` requests it (one prompt per site) and releases
// the microphone straight away; nothing is recorded.
async function outputs(ask) {
  const named = (list) => list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.label);
  let list = named(await navigator.mediaDevices.enumerateDevices());
  if (!list.length && ask) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.getTracks().forEach((t) => t.stop());
    list = named(await navigator.mediaDevices.enumerateDevices());
  }
  return list;
}

// code helpers: StrudelMirror settings, switched with editor.changeSetting
const HELPERS = [
  ['isAutoCompletionEnabled', 'autocomplete', 'suggest functions as you type, with their docs'],
  ['isTooltipEnabled', 'docs on ctrl+hover', 'hold ctrl and hover a function to see its docs'],
  ['isBracketMatchingEnabled', 'bracket matching', 'highlight the bracket that pairs with the one at the cursor'],
  ['isLineWrappingEnabled', 'wrap lines', 'wrap long lines instead of scrolling sideways'],
];
const KEYMAPS = ['codemirror', 'vim', 'emacs', 'vscode'];

// at startup, once the editor exists: font size, helpers and keys. The output
// is applied once Strudel's audio context exists (after prebake).
export function applyEditorSettings(editor) {
  const s = load();
  editor.setFontSize(s.fontSize ?? FONT.def);
  for (const [key] of HELPERS) if (s.helpers?.[key] != null) editor.changeSetting(key, s.helpers[key]);
  if (KEYMAPS.includes(s.keys)) editor.changeSetting('keybindings', s.keys);
}
export function applyOutput() {
  const { output } = load();
  if (output) setOutput(output).catch(() => {}); // the device may be unplugged: stays on the default
}

// onReset: wipes everything and reloads (app.js resetEverything)
export function openSettings(anchor, { editor, onStatus, onReset }) {
  const s = load();
  const row = (label, ...control) => {
    const line = h('div', 'set-row');
    line.append(h('span', 'set-label', label), ...control);
    return line;
  };

  // theme
  const themeBtns = THEMES.map(([id, label]) => {
    const b = h('button', 'seg', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      applyTheme(id);
      try {
        if (id) localStorage.setItem(THEME_STORE, id);
        else localStorage.removeItem(THEME_STORE);
      } catch {}
      showTheme();
    });
    return b;
  });
  const showTheme = () => {
    const current = document.documentElement.dataset.theme ?? '';
    themeBtns.forEach((b, i) => b.setAttribute('aria-pressed', b.classList.toggle('on', THEMES[i][0] === current)));
  };
  showTheme();
  const themes = h('span', 'mode');
  themes.append(...themeBtns);

  // layout: the code beside the sequencer, or below it (theme.js applies the
  // saved one before first paint)
  const LAYOUTS = [['side', 'side'], ['below', 'below']];
  const layoutBtns = LAYOUTS.map(([id, label]) => {
    const b = h('button', 'seg', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (id === 'below') document.documentElement.dataset.layout = 'below';
      else delete document.documentElement.dataset.layout;
      save({ layout: id });
      showLayout();
    });
    return b;
  });
  const showLayout = () => {
    const current = document.documentElement.dataset.layout ?? 'side';
    layoutBtns.forEach((b, i) => b.setAttribute('aria-pressed', b.classList.toggle('on', LAYOUTS[i][0] === current)));
  };
  showLayout();
  const layouts = h('span', 'mode');
  layouts.append(...layoutBtns);

  // output device
  const output = h('select');
  output.setAttribute('aria-label', 'audio output');
  const fill = (list) => {
    const current = globalThis.getAudioContext?.()?.sinkId ?? load().output ?? '';
    output.replaceChildren(new Option('system default', ''), ...list.map((d) => new Option(d.label, d.deviceId)));
    // a saved device that isn't listed (unplugged, or names not shown yet)
    if (current && !list.some((d) => d.deviceId === current)) output.append(new Option(load().outputLabel ?? 'saved device', current));
    output.value = current;
  };
  const listBtn = h('button', 'link', 'list outputs…');
  listBtn.type = 'button';
  listBtn.title = 'the browser asks for microphone access once, only to show device names; nothing is recorded';
  listBtn.addEventListener('click', async () => {
    try {
      const list = await outputs(true);
      fill(list);
      listBtn.hidden = list.length > 0;
      output.focus();
    } catch {
      onStatus("couldn't list outputs: the browser didn't allow it", true);
    }
  });
  output.addEventListener('change', async () => {
    const id = output.value;
    try {
      await setOutput(id);
      save({ output: id, outputLabel: id ? output.selectedOptions[0].text : undefined });
      onStatus(`output: ${output.selectedOptions[0].text}`);
    } catch {
      onStatus(`couldn't switch to ${output.selectedOptions[0].text}`, true);
      fill([]);
    }
  });
  fill([]);
  const outputCtl = h('span', 'set-output');
  if (canPickOutput()) {
    outputCtl.append(output, listBtn);
    outputs(false).then((list) => {
      if (list.length) {
        fill(list);
        listBtn.hidden = true;
      }
    }).catch(() => {});
  } else outputCtl.append(h('span', 'set-note', 'needs Chrome or Edge'));

  // code font size
  const size = h('input');
  Object.assign(size, { type: 'range', min: FONT.min, max: FONT.max, step: 1, value: s.fontSize ?? FONT.def });
  size.setAttribute('aria-label', 'code font size');
  const sizeValue = h('span', 'fx-value', `${size.value}px`);
  size.addEventListener('input', () => {
    const n = Number(size.value);
    editor.setFontSize(n);
    sizeValue.textContent = `${n}px`;
    save({ fontSize: n });
  });
  const sizeCtl = h('span', 'set-size');
  sizeCtl.append(size, sizeValue);

  // code helpers: on/off toggles; unset ones keep Strudel's default (off)
  const helpers = h('span', 'set-helpers');
  for (const [key, label, title] of HELPERS) {
    const b = h('button', 'fx-toggle', label);
    b.type = 'button';
    b.title = title;
    const show = (on) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    };
    show(!!s.helpers?.[key]);
    b.addEventListener('click', () => {
      const on = !b.classList.contains('on');
      editor.changeSetting(key, on);
      save({ helpers: { ...load().helpers, [key]: on } });
      show(on);
    });
    helpers.append(b);
  }

  // keys: the editor's keymap
  const keyBtns = KEYMAPS.map((id) => {
    const b = h('button', 'seg', id);
    b.type = 'button';
    b.addEventListener('click', () => {
      editor.changeSetting('keybindings', id);
      save({ keys: id });
      showKeys(id);
    });
    return b;
  });
  const showKeys = (id) => keyBtns.forEach((b, i) => b.setAttribute('aria-pressed', b.classList.toggle('on', KEYMAPS[i] === id)));
  showKeys(KEYMAPS.includes(s.keys) ? s.keys : 'codemirror');
  const keys = h('span', 'mode');
  keys.append(...keyBtns);

  // reset everything, behind a confirm that says what goes
  const reset = h('div', 'set-reset');
  const resetBtn = h('button', 'link danger', 'reset everything…');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    const warn = h('p', 'set-warn',
      "Deletes everything StrudelUI keeps in this browser: the tune you have open, all saved tunes, your samples, " +
      "MIDI / key mappings and these settings. It can't be undone, so download what you want to keep first.");
    const yes = h('button', 'link danger', 'yes, delete it all');
    const no = h('button', 'link', 'cancel');
    yes.type = no.type = 'button';
    yes.addEventListener('click', () => {
      yes.disabled = no.disabled = true;
      yes.textContent = 'deleting…';
      onReset();
    });
    no.addEventListener('click', () => {
      reset.replaceChildren(resetBtn);
      resetBtn.focus();
    });
    const choice = h('div', 'set-choice');
    choice.append(yes, no);
    reset.replaceChildren(warn, choice);
    no.focus();
  });
  reset.append(resetBtn);

  const pop = popover(anchor, [
    h('div', 'fx-title', 'settings · kept in this browser'),
    row('theme', themes),
    row('layout', layouts),
    row('output', outputCtl),
    row('code size', sizeCtl),
    row('helpers', helpers),
    row('keys', keys),
    reset,
  ], { className: 'fx-panel settings-panel', label: 'settings' });
  themeBtns[0].focus();
  return pop;
}
