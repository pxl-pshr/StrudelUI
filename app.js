import './vendor/strudel-repl/index.mjs'; // defines <strudel-editor>
import {
  STEPS, IDENT, MAX_BARS, parse, generate, audible, references, declared, getParam, setParam, hasLine, setLine, getPump, setPump, getSound, setSound,
  getTrackPump, pumpTrack,
  blockToTrack, addTrack, duplicateTrack, removeTrack, renameTrack, setBars, allIds, setMode,
  addScene, removeScene, addSongEntry, songLength, toMidi, fromMidi, num, freeOrbit, soundsIn, renameSounds, forStrudel, setTrim,
} from './code.js';
import { DEFAULT_TUNE, DEFAULT_NAME } from './default.js';
import { loadBankNames, loadUserSamples, userSoundNames, userSoundFiles, deleteAllUserSamples, catalog, banks, bankName, hasSound, isSample, countOf, audition, addFiles, tuneSamples, reassertUserSounds, filesFromDrop } from './sounds.js';
import { openPicker } from './picker.js';
import { openTrim } from './trim.js';
import { openSettings, applyEditorSettings, applyOutput } from './settings.js';
import { popover, menu, h } from './popover.js';
import { collect, renderMix, renderStems, fitsInMemory, wav, peakDb, startRecording, download } from './export.js';
import { zip } from './zip.js';
import { listTunes, getTune, saveTune, deleteTune, fileName, pickFile, readTuneFile, isZip } from './files.js';
import { initControllers, mark as markControls, renameMappings } from './controllers.js';

const STORE = 'beats-ui-v2';
// the modifier key named in hints: cmd on Apple devices, ctrl elsewhere
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'cmd' : 'ctrl';
const $ = (sel, el = document) => el.querySelector(sel);

// the sticky header's height as --head, so the sticky code panel sits below it
// (the header wraps to more lines on narrow windows)
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--head', `${Math.ceil(e.target.getBoundingClientRect().height)}px`))
  .observe(document.querySelector('header'));

// ── saved tune ────────────────────────────────────
// The code in the editor is the tune. The grid is a view of it: `tune` is the
// code parsed (code.js), and grid edits write new code back into the editor.

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (typeof s?.code === 'string') return s;
  } catch {}
  return { code: DEFAULT_TUNE, name: DEFAULT_NAME };
}

const saved = loadSaved();
let code = saved.code; // what's in the editor
let parsedCode = code; // what `tune` was parsed from
let tune = parse(code);
let tuneName = saved.name ?? 'untitled';
let savedAs = saved.savedAs ?? null; // the named save this tune came from: cmd+s only overwrites that one
// A tune from outside (a link, a file, a zip) is held: shown, but its code
// doesn't run until play, ctrl+enter, export or record (like strudel.cc's
// links), so opening one can't run its JavaScript. Kept in the autosave.
let held = !!saved.held;

let saveTimer;
let storageWarned = false;
let wiping = false; // settings → reset everything: no autosave may follow it
function save() {
  if (wiping) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ code, name: tuneName, savedAs, ...(held && { held }) }));
    } catch {
      if (!storageWarned) status('autosave failed: browser storage is full · download the code to keep it', true);
      storageWarned = true;
    }
  }, 200);
}

const track = (id) => tune.tracks.find((t) => t.id === id);
const isAudible = (t) => audible(tune, t);

// mutes and solo are part of the code (code.js), so parsing restores them
function adopt(src) {
  tune = parse(src);
  parsedCode = src;
}

// ── editor (also the player) ──────────────────────

const host = document.createElement('strudel-editor');
host.setAttribute('code', code);
$('#editor').append(host);
const editor = host.editor;
applyEditorSettings(editor);
editor.setFontFamily('ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace');
// Every evaluate of this editor goes through repl.evaluate (play, ctrl+enter,
// export, record, and preview, which skips held tunes): one that runs releases
// a held tune.
{
  const evaluate = editor.repl.evaluate;
  editor.repl.evaluate = (...args) => {
    if (held) {
      held = false;
      save();
    }
    return evaluate(...args);
  };
}
// When the code scrolls with the page (layout below, narrow windows), keep the
// caret out from under the sticky header: CodeMirror's scrollMargins. The
// bundle doesn't export EditorView or StateEffect, so both come from the view.
{
  const cm = editor.editor;
  const View = cm.constructor;
  const StateEffect = View.scrollIntoView(0).constructor;
  const header = document.querySelector('header');
  const box = $('#editor');
  // CodeMirror applies the margin against the window when the page scrolls the
  // code: then it's the header's full height. When the panel scrolls itself
  // (side layout), only what the header covers of the panel.
  const margins = View.scrollMargins.of(() => {
    const bottom = header.getBoundingClientRect().bottom;
    const own = box.scrollHeight > box.clientHeight;
    return { top: own ? Math.max(0, bottom - box.getBoundingClientRect().top) : bottom };
  });
  cm.dispatch({ effects: StateEffect.appendConfig.of(margins) });
}

let playing = false;
let previewing = false; // the sound picker is playing a changed copy of the code
let pattern = null; // last evaluated pattern
let activeTune = tune; // `tune` as of the last evaluation, for mapping events to tracks

host.addEventListener('update', (e) => {
  const st = e.detail;
  if (st.started !== playing) {
    playing = st.started;
    playBtn.textContent = playing ? '■ stop' : '▶ play';
    playBtn.classList.toggle('live', playing);
    if (!playing) stopped();
  }
  // the editor's text, not st.code: evaluating other code (a sound preview)
  // sets st.code to that code
  if (editor.code !== code) {
    code = editor.code;
    save();
    clearTimeout(parseTimer);
    parseTimer = setTimeout(syncFromCode, 200);
  }
  if (st.pattern && st.pattern !== pattern) {
    pattern = st.pattern;
    activeTune = parse(st.activeCode);
    readCodeRows(playing && follow ? Math.floor(editor.repl.scheduler.now()) : page);
  }
  dirty.hidden = !(playing && st.isDirty && !previewing);
  if (st.evalError && !quiet) status(`error: ${st.evalError.message ?? st.evalError}`, true);
});

let parseTimer;
function syncFromCode() {
  clearTimeout(parseTimer);
  if (code === parsedCode) return;
  remember(parsedCode, true);
  adopt(code);
  render();
  preview();
}

// ── undo ──────────────────────────────────────────
// Snapshots of the code before each burst of changes (a slider drag or a
// run of typing is one step). The editor keeps its own cmd+z for typing.

const past = [];
const future = [];
let lastChange = 0;
let lastMerge = false;
// merge: true = part of a continuous gesture, folded into the step before;
// 'start' = the first change of a gesture (a step of its own that the rest fold into)
const snapshot = (c = code) => ({ code: c, name: tuneName, savedAs });
function remember(before, merge = false) {
  const now = Date.now();
  const folds = merge === true && lastMerge && now - lastChange < 700;
  if (!folds && before !== past.at(-1)?.code) past.push(snapshot(before));
  if (past.length > 200) past.shift();
  lastChange = now;
  lastMerge = merge;
  future.length = 0;
}
// a snapshot is the code, the tune's name and the save it came from, so
// undoing an open also undoes the name (and cmd+s can't save over another)
function restore(snap) {
  clearTimeout(parseTimer);
  code = snap.code;
  tuneName = snap.name;
  savedAs = snap.savedAs;
  writeCode(snap.code);
  adopt(snap.code);
  showName();
  save();
  render();
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => (playing ? editor.repl.evaluate(editor.code) : preview()), 60);
}
function undo() {
  syncFromCode();
  if (!past.length) return status('nothing to undo');
  future.push(snapshot());
  restore(past.pop());
  lastChange = 0;
  status('undone');
}
function redo() {
  if (!future.length) return status('nothing to redo');
  past.push(snapshot());
  restore(future.pop());
  lastChange = 0;
  status('redone');
}

// While stopped, evaluate without playing so code tracks can show their steps.
// Errors stay quiet here: the code may be half-typed.
let quiet = false;
async function preview() {
  if (held || playing || !tune.tracks.some((t) => t.kind === 'code')) return;
  await editor.prebaked;
  quiet = true;
  try {
    await editor.repl.evaluate(editor.code, false);
  } catch {}
  quiet = false;
}

// Writes code into the editor, changing only the span that differs: a full
// replace (StrudelMirror.setCode) drops every inline widget (_scope(),
// _pianoroll(), …) and playing highlight until the next evaluate, which
// during a slider drag only comes once the drag pauses.
function writeCode(next) {
  const view = editor.editor;
  const prev = view.state.doc.toString();
  if (prev === next) return;
  let from = 0;
  while (from < prev.length && from < next.length && prev[from] === next[from]) from++;
  let tail = 0;
  while (tail < prev.length - from && tail < next.length - from && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  view.dispatch({ changes: { from, to: prev.length - tail, insert: next.slice(from, next.length - tail) } });
}

// Every grid edit goes through here: catch up with any typing first,
// change the tune, write it back as code, and re-evaluate if playing.
let evalTimer;
function edit(change, merge = false) {
  syncFromCode();
  change();
  const next = generate(tune);
  adopt(next);
  if (next !== code) {
    remember(code, merge);
    code = next;
    writeCode(next);
  }
  save();
  render();
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => (playing ? editor.repl.evaluate(editor.code) : preview()), 60);
}

// While playing, the sound picker swaps the browsed sound into the running
// tune: a copy of the code with that one sound changed is evaluated, so the
// editor, the autosave and undo keep the real code until a pick. null puts the
// editor's code back.
function previewSound(id, snd) {
  if (!snd) {
    if (previewing && playing) editor.repl.evaluate(editor.code);
    previewing = false;
    return false;
  }
  if (!playing) return false;
  syncFromCode();
  const copy = parse(code);
  const t = copy.tracks.find((x) => x.id === id);
  if (!t || !getSound(t)) return false;
  setSound(t, snd);
  audition(snd, undefined, true); // load it now, so its first hit in the loop isn't dropped
  previewing = true;
  editor.repl.evaluate(generate(copy));
  return true;
}

// Strudel loads a sample the first time it plays, so the first bar drops
// hits. Triggering each track's sound silently loads it ahead of time.
function preloadSounds() {
  for (const t of tune.tracks) {
    const s = getSound(t);
    if (s) audition(s, t.kind === 'note' ? t.steps.find(Boolean) : undefined, true);
  }
}

// user samples must be registered before the tune first evaluates
// sounds count as missing only once Strudel's maps and the user samples are in;
// sample maps that register later trigger a recheck
let soundsReady = false;
let soundsTimer;
editor.prebaked.then(async () => {
  await Promise.all([loadBankNames(), loadUserSamples()]);
  applyOutput();
  soundsReady = true;
  globalThis.soundMap?.listen?.(() => {
    clearTimeout(soundsTimer);
    soundsTimer = setTimeout(render, 300);
  });
  fillKits();
  render();
  playBtn.disabled = false;
  playBtn.textContent = '▶ play';
  preloadSounds();
  preview();
});

// ── header ────────────────────────────────────────

const playBtn = $('#play');
const dirty = $('#dirty');
playBtn.addEventListener('click', toggle);
function toggle() {
  if (playing) editor.stop();
  else {
    syncFromCode();
    editor.evaluate();
  }
}

const bpm = $('#bpm');
bpm.addEventListener('input', () => {
  const v = Math.round(Number(bpm.value));
  if (v >= 40 && v <= 240) edit(() => (tune.bpm = v), true);
});

const pump = $('#pump');
pump.addEventListener('input', () => {
  edit(() => setPump(tune, Number(pump.value)), true);
  status(`pump · sidechain depth ${Math.round(Number(pump.value) * 100)}%`);
});

// kit: the drum machine most tracks use; switching moves every track whose
// sound the new kit also has, and says which ones it left
const kit = $('#kit');
const currentKit = () => {
  const count = {};
  for (const t of tune.tracks) {
    const b = getSound(t)?.bank && bankName(getSound(t).bank).toLowerCase();
    if (b) count[b] = (count[b] ?? 0) + 1;
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};
function fillKits() {
  kit.replaceChildren(new Option('—', ''), ...banks().map((b) => new Option(b, b)));
}
kit.addEventListener('change', () => {
  const to = kit.value;
  if (!to) return;
  const kept = [];
  edit(() => {
    for (const t of tune.tracks) {
      const s = getSound(t);
      if (!s?.bank) continue;
      if (hasSound(s.name, to)) setSound(t, { ...s, bank: to, n: Math.min(s.n, countOf(s.name, to) - 1) });
      else kept.push(`${t.id} (${s.name})`);
    }
  });
  preloadSounds();
  status(kept.length ? `kit ${to} · kept ${kept.join(', ')}: ${to} has no such sound` : `kit ${to}`);
});

// user samples: files or folders dropped anywhere, or picked
let onImported = null; // set by importFiles: gets the names of the sounds added
// quiet: leave a pending "import files…" (onImported) for its own import
async function takeFiles(list, { quiet = false } = {}) {
  let added;
  try {
    added = await addFiles(list);
  } catch (err) {
    return status(`couldn't add samples: ${err.message ?? err}`, true);
  }
  if (!added.length) return status('no audio files in that drop', true);
  const notes = [
    ...added.filter((a) => a.replaces).map((a) => `${a.name} now replaces the built-in ${a.name}`),
    ...(added.some((a) => !a.stored) ? ["couldn't store them, so they're here for this visit only"] : []),
  ];
  const what = added.map((a) => `${a.name} ×${a.count}${a.added < a.count ? ` (+${a.added})` : ''}`).join(', ');
  status(`added ${what} · ${notes.length ? notes.join(' · ') : "pick them from any track's sound"}`, notes.length > 0);
  if (quiet) return;
  const done = onImported;
  onImported = null;
  done?.(added.map((a) => a.name));
}
// the picker's "import files…": the file dialog, then done(names)
function importFiles(done) {
  onImported = done;
  $('#files').click();
}
$('#files').addEventListener('cancel', () => (onImported = null));
// a folder works like strudel.cc's "import sounds folder": each subfolder
// becomes a sound, its files the variations
for (const input of [$('#files'), $('#folder')]) {
  input.addEventListener('change', () => {
    takeFiles([...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    input.value = '';
  });
}
$('#add-samples').addEventListener('click', (e) =>
  menu(e.currentTarget, [
    { label: 'a sounds folder…', run: () => $('#folder').click() },
    { label: 'audio files…', run: () => $('#files').click() },
  ], { label: 'add samples' }),
);
let dragDepth = 0;
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!carriesFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', (e) => {
  if (carriesFiles(e) && --dragDepth <= 0) document.body.classList.remove('dropping');
});
window.addEventListener('dragover', (e) => {
  if (carriesFiles(e)) e.preventDefault();
});
window.addEventListener('drop', async (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const list = await filesFromDrop(e.dataTransfer);
  // a tune file (.js, or a .zip from "download with samples") opens; audio goes to the user samples
  const tune = list.find(({ file }) => isZip(file) || /\.(js|strudel)$/i.test(file.name));
  if (tune) openTuneFile(tune.file);
  else takeFiles(list);
});

// A second Strudel engine, never started, for checking a tune zip's sound
// renames (renameCheck): created on the first rename, kept hidden. Its prebake
// registers the built-in sample maps again, over any user sound that replaced
// one, so those are put back once it's done. Strudel's globals (setcpm, hush,
// the time source the highlighting reads) follow whichever engine evaluated
// last; the main one takes them back when it next evaluates (loadTune).
let probe = null;
function probeEngine() {
  if (!probe) {
    const box = h('div');
    box.hidden = true;
    const el = document.createElement('strudel-editor');
    box.append(el);
    document.body.append(box);
    probe = el.editor.prebaked.then(() => (reassertUserSounds(), el.editor)).catch((err) => {
      probe = null; // its prebake failed (offline?): try afresh next time
      box.remove();
      throw err;
    });
  }
  return probe;
}

// Every track's events over 32 cycles (muted ones too): [{ at, end, key, rest }],
// key = the sound as Strudel looks it up (bank_name, lowercase). null if the
// code doesn't evaluate.
async function trackEvents(src) {
  const ed = await probeEngine();
  const ids = parse(src).tracks.map((t) => t.id);
  await ed.repl.evaluate(ids.length ? `${src}\n\nstack(${ids.join(', ')})\n` : src, false);
  const { pattern, evalError } = ed.repl.state;
  if (evalError || !pattern) return null;
  return pattern.queryArc(0, 32).filter((ev) => ev.whole && ev.value && typeof ev.value === 'object').map((ev) => {
    const { s, bank, ...rest } = ev.value;
    const name = typeof s === 'string' ? s.split(':')[0] : null;
    return { at: ev.whole.begin.valueOf(), end: ev.whole.end.valueOf(), key: name && (bank ? `${bank}_${name}` : name).toLowerCase(), rest };
  });
}

// `holds`: `after` plays exactly what `before` does, with the renamed sounds
// ({ from: to }) in place of the old ones: nothing else changed, nothing missed.
// `plays`: the sound keys `before` plays (null if it doesn't evaluate), to tell
// a sound the tune only reaches through .bank() from one it really plays.
async function renameCheck(before, after, renames) {
  const a = await trackEvents(before);
  const plays = a && new Set(a.map((ev) => ev.key));
  if (!a || after === before) return { holds: false, plays };
  const b = await trackEvents(after);
  const norm = (evs, map) => evs.map((ev) => JSON.stringify({ ...ev, key: map?.[ev.key] ?? ev.key })).sort().join('\n');
  return { holds: !!b && a.length === b.length && norm(a, renames) === norm(b), plays };
}

// a .js tune, or a .zip with the tune and its samples (imported first)
async function openTuneFile(file) {
  try {
    const f = await readTuneFile(file);
    if (f.code == null) { // samples only: an ordinary import, takeFiles says what it added
      if (f.samples.length) await takeFiles(f.samples, { quiet: true });
      return;
    }
    let code = f.code;
    let notes = '';
    let warn = false;
    let sounds = [];
    if (f.samples.length) {
      await editor.prebaked; // built-in names are known
      const t = await tuneSamples(f.samples);
      let added = true;
      try {
        if (t.list.length) await addFiles(t.list);
      } catch (err) {
        added = false;
        notes += ` · couldn't add its samples: ${err.message ?? err}`;
        warn = true;
      }
      if (added) {
        sounds = t.sounds;
        if (t.renames.length) {
          const renames = Object.fromEntries(t.renames);
          const renamed = renameSounds(code, renames);
          // the check needs the second engine; without it, the rename is only unsure
          const { holds, plays } = await renameCheck(code, renamed, renames).catch(() => ({ holds: false, plays: null }));
          if (holds) code = renamed;
          for (const [from, to] of t.renames) {
            if (holds) notes += ` · your ${from} is a different sound, so this tune's is ${to}`;
            else if (plays && !plays.has(from)) notes += ` · your ${from} is a different sound, so this tune's ${from} samples are under ${to}`; // the code never plays plain `from`
            else {
              notes += ` · your ${from} is a different sound, so this tune's samples are ${to}, but StrudelUI couldn't safely rename ${from} in its code: change it there to hear them`;
              warn = true;
            }
          }
        }
      }
    }
    loadTune(code, { name: f.name, held: true });
    openedStatus(`opened ${f.name}${sounds.length ? ` with its samples (${sounds.join(', ')})` : ''}${notes}`, warn);
  } catch (err) {
    status(`couldn't open ${file.name}: ${err.message ?? err}`, true);
  }
}

// "download with samples": the tune and the samples of yours it uses, laid out
// like strudel.cc's "import sounds folder" (samples/<sound>/<file>), so opening
// the zip here, or importing its samples folder there, gives the same s("name:n")
async function downloadWithSamples() {
  syncFromCode();
  const name = fileName(tuneName);
  const used = soundsIn(code, userSoundNames());
  const files = [{ name: `${name}.js`, blob: new Blob([code], { type: 'text/javascript' }) }];
  for (const sound of used) {
    for (const f of await userSoundFiles(sound)) files.push({ name: `samples/${sound}/${f.name}`, blob: f.blob });
  }
  try {
    download(await zip(files), `${name}.zip`);
  } catch (err) {
    return status(`couldn't zip it: ${err.message ?? err}`, true);
  }
  status(used.length ? `downloaded ${name}.zip · the code + ${used.join(', ')}` : `downloaded ${name}.zip · it uses none of your samples, so it's just the code`);
}

// ── file: save, open, download ────────────────────
// The current tune autosaves to STORE on every change; these are the named
// saves (files.js).

const fileBtn = $('#file');
const showName = () => {
  fileBtn.textContent = `${tuneName} ▾`;
  document.title = `${tuneName} · strudelUI`;
};

// replace the whole tune (undoable like any edit)
function loadTune(src, meta = {}) {
  syncFromCode();
  remember(code);
  lastChange = 0;
  code = src.replace(/\r\n?/g, '\n');
  writeCode(code);
  adopt(code);
  tuneName = meta.name ?? tuneName;
  savedAs = meta.savedAs ?? null;
  held = !!meta.held;
  if (held && playing) editor.stop();
  page = 0;
  showName();
  save();
  render();
  preloadSounds();
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => (playing ? editor.repl.evaluate(editor.code) : preview()), 60);
}

// a small "name it" panel; resolves with the name or null
function askName(anchor, title, initial, okLabel = 'save') {
  return new Promise((resolve) => {
    const label = h('div', 'fx-title', title);
    const input = h('input', 'rename');
    Object.assign(input, { value: initial, spellcheck: false });
    input.setAttribute('aria-label', title);
    const ok = h('button', 'link', okLabel);
    ok.type = 'button';
    const line = h('div', 'ask');
    line.append(input, ok);
    let answered = false;
    const answer = (v) => {
      if (answered) return;
      answered = true;
      pop.close();
      resolve(v);
    };
    const pop = popover(anchor, [label, line], { className: 'ask-panel', label: title, onClose: () => answer(null) });
    input.select();
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) answer(input.value.trim());
      if (e.key === 'Escape') answer(null);
    });
    ok.addEventListener('click', () => input.value.trim() && answer(input.value.trim()));
  });
}

// the code's first line is its title, `// name`: saving under a name rewrites
// a comment there (or adds one), so the code says what it's called
function retitle(name) {
  syncFromCode();
  const lines = code.split('\n');
  const head = `// ${name}`;
  if (lines[0] === head) return;
  if (lines[0].startsWith('//')) lines[0] = head;
  else lines.unshift(head);
  remember(code);
  code = lines.join('\n');
  writeCode(code);
  adopt(code);
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => (playing ? editor.repl.evaluate(editor.code) : preview()), 60);
}

function saveAs(name) {
  try {
    retitle(name);
    saveTune(name, { code });
    tuneName = savedAs = name;
    showName();
    save();
    status(`saved ${name}`);
  } catch {
    status("couldn't save: browser storage is full · download the code instead", true);
  }
}

// asks for a name; a name that's already saved (and isn't this tune's) is
// confirmed before it's replaced
async function saveAsAsk(anchor) {
  let name = await askName(anchor, 'save as', tuneName);
  while (name && name !== savedAs && getTune(name)) {
    const again = await askName(anchor, `"${name}" is already saved · replace it, or pick another name`, name, 'replace');
    if (again === name) break;
    name = again;
  }
  if (name) saveAs(name);
}

// cmd+s: overwrites the save this tune came from, otherwise asks
const saveNow = () => (savedAs === tuneName && getTune(tuneName) ? saveAs(tuneName) : saveAsAsk($('#save')));
$('#save').addEventListener('click', saveNow);

function openSaved(anchor) {
  const tunes = listTunes();
  if (!tunes.length) return status('nothing saved yet: use save');
  const items = tunes.map((t) => {
    const row = h('div', 'saved');
    const open = h('button', 'menu-item', t.name);
    open.type = 'button';
    open.setAttribute('role', 'menuitem');
    open.title = `saved ${new Date(t.saved).toLocaleString()}`;
    open.addEventListener('click', () => {
      pop.close();
      loadTune(t.code, { name: t.name, savedAs: t.name });
      openedStatus(`opened ${t.name}`);
    });
    const del = h('button', 'snd-del', '×');
    del.type = 'button';
    del.title = `delete ${t.name}`;
    del.setAttribute('aria-label', `delete saved tune ${t.name}`);
    del.addEventListener('click', () => {
      deleteTune(t.name);
      row.remove();
      status(`deleted saved tune ${t.name}`, false, { label: 'undo', run: () => {
        saveTune(t.name, { code: t.code });
        status(`restored ${t.name}`);
      } });
    });
    row.append(open, del);
    return row;
  });
  const pop = popover(anchor, [h('div', 'fx-title', 'saved in this browser'), ...items], { className: 'menu saved-list', label: 'saved tunes', role: 'menu' });
  items[0].querySelector('button').focus();
}

// file → demos…: the default tune (default.js), then the tunes in demos/
const DEMOS = [
  { name: DEFAULT_NAME, code: DEFAULT_TUNE },
  { file: 'visuals.js', name: 'visuals demo' },
];

async function openDemo({ file, name, code: src }) {
  try {
    if (src == null) {
      const res = await fetch(`demos/${file}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      src = await res.text();
    }
  } catch (err) {
    return status(`couldn't load ${name}: ${err.message ?? err}`, true);
  }
  loadTune(src, { name });
  openedStatus(`opened ${name}`);
}

fileBtn.addEventListener('click', () =>
  menu(fileBtn, [
    { label: 'open saved…', run: () => openSaved(fileBtn) },
    { label: 'open file…  (.js or .zip)', run: async () => {
      const f = await pickFile();
      if (f) openTuneFile(f);
    } },
    { label: 'demos…', run: () => menu(fileBtn, DEMOS.map((d) => ({ label: d.name, run: () => openDemo(d) })), { label: 'demos' }) },
    { label: 'new (empty)', run: () => {
      loadTune(`// untitled\nsetcpm(${tune.bpm ?? 120}/4)\n\nstack(\n)\n`, { name: 'untitled' });
      status('new empty tune · + track to start', false, { label: 'undo', run: undo });
    } },
    '-',
    { label: `save  (${MOD}+s)`, run: saveNow },
    { label: 'save as…', run: () => saveAsAsk(fileBtn) },
    '-',
    { label: 'download .js', run: () => download(new Blob([editor.code], { type: 'text/javascript' }), `${fileName(tuneName)}.js`) },
    { label: 'download with samples (.zip)', run: downloadWithSamples },
  ], { label: 'file' }),
);
showName();
$('#save').title = `save this tune in the browser (${MOD}+s) · open, download and more in the menu on the left`;
$('#undo').title = `undo (${MOD}+z)`;
$('#redo').title = `redo (shift+${MOD}+z)`;

// ── export and record ─────────────────────────────

const exportBtn = $('#export');
exportBtn.addEventListener('click', () => {
  const songBars = tune.mode === 'song' ? songLength(tune) : 0;
  const what = h('div', 'ask');
  const mix = h('button', 'fx-toggle on', 'mix');
  const stems = h('button', 'fx-toggle', 'stems');
  const codeBtn = h('button', 'fx-toggle', 'code');
  codeBtn.title = 'the tune as a .js file: open it here or paste it into strudel.cc';
  const kinds = [mix, stems, codeBtn];
  for (const b of kinds) {
    b.type = 'button';
    b.addEventListener('click', () => {
      kinds.forEach((k) => k.classList.toggle('on', k === b));
      lenLine.hidden = b === codeBtn; // code has no length
    });
  }
  what.append(...kinds);
  const len = h('input', 'rename bars-input');
  Object.assign(len, { type: 'number', min: 1, max: 256, value: songBars || Math.max(pages(), 4) });
  const lenLine = h('label', 'ask');
  lenLine.append(len, h('span', 'fx-value', songBars ? 'bars (the song)' : 'bars'));
  const go = h('button', 'link', 'render');
  go.type = 'button';
  const note = h('div', 'fx-value export-note', 'mix/stems render offline, faster than real time · 32-bit float WAV · stems: one file per track, same length, zipped · code: the tune as .js');
  const pop = popover(exportBtn, [h('div', 'fx-title', 'export'), what, lenLine, go, note], { className: 'ask-panel export-panel' });
  go.focus();
  go.addEventListener('click', async () => {
    pop.close();
    if (codeBtn.classList.contains('on')) {
      download(new Blob([editor.code], { type: 'text/javascript' }), `${fileName(tuneName)}.js`);
      return status(`exported ${fileName(tuneName)}.js`);
    }
    const bars = Math.max(1, Math.min(256, Math.round(Number(len.value) || 4)));
    await exportAudio(stems.classList.contains('on'), bars);
  });
});

async function exportAudio(asStems, bars) {
  if (playing) editor.stop();
  syncFromCode();
  exportBtn.disabled = true;
  try {
    status('rendering…');
    await editor.prebaked;
    quiet = true;
    await editor.repl.evaluate(editor.code, false);
    quiet = false;
    const st = editor.repl.state;
    if (st.evalError) throw st.evalError;
    const cps = editor.repl.scheduler.cps;
    const haps = collect(st.pattern, bars, cps);
    const name = `${fileName(tuneName)}-${num(tune.bpm ?? cps * 240)}bpm`;
    const level = (buf) => {
      const db = peakDb(buf);
      return db > 0 ? `peak +${db.toFixed(1)} dB, over full scale: turn it down in your DAW` : `peak ${db.toFixed(1)} dB`;
    };
    // notes that couldn't play are reported, not silently dropped
    const missed = (failed) => {
      const n = failed.reduce((sum, [, count]) => sum + count, 0);
      return n ? ` · ${n} note${n > 1 ? 's' : ''} didn't play (${failed[0][0]})` : '';
    };
    const tooBig = (channels) => `${bars} bars is too long to render in one go: try fewer bars${channels > 2 ? ' or the mix' : ''}`;
    if (!asStems) {
      if (!fitsInMemory(bars, cps, 2)) throw new Error(tooBig(2));
      const buf = await renderMix(haps, bars, cps);
      download(wav(buf), `${name}.wav`);
      status(`exported ${name}.wav · ${bars} bars · ${level(buf)}${missed(buf.failed)}`, buf.failed.length > 0);
      return;
    }
    const tracks = parse(st.activeCode).tracks;
    if (!fitsInMemory(bars, cps, tracks.length * 2)) throw new Error(tooBig(tracks.length * 2));
    status(`rendering ${tracks.length} stems…`);
    const out = await renderStems(haps, tracks, bars, cps);
    status('zipping…');
    download(await zip(out.map((s) => ({ name: `${name}/${s.name}.wav`, blob: wav(s.buffer) }))), `${name}-stems.zip`);
    status(`exported ${out.length} stems · ${bars} bars · ${name}-stems.zip${missed(out.failed ?? [])}`, (out.failed ?? []).length > 0);
  } catch (err) {
    status(`export failed: ${err.message ?? err}`, true);
  } finally {
    quiet = false;
    exportBtn.disabled = false;
  }
}

const recBtn = $('#rec');
let recording = null;
recBtn.addEventListener('click', async () => {
  if (recording) {
    const r = recording;
    recording = null;
    recBtn.classList.remove('live');
    recBtn.textContent = '● rec';
    status('finishing the recording…');
    try {
      const name = `${fileName(tuneName)}-live-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.wav`;
      const seconds = r.seconds();
      download(await r.stop(), name);
      status(`recorded ${name} · ${Math.round(seconds)} s`);
    } catch (err) {
      status(`recording failed: ${err.message ?? err}`, true);
    }
    return;
  }
  if (!playing) {
    syncFromCode();
    await editor.evaluate();
  }
  try {
    recording = await startRecording();
    recBtn.classList.add('live');
    recBtn.textContent = '■ stop rec';
    status('recording · press stop rec to save a WAV');
  } catch (err) {
    status(`can't record: ${err.message ?? err}`, true);
  }
});

// ── rack ──────────────────────────────────────────

const rack = $('#rack');
const rows = new Map(); // id -> { row, kind, cells, mute, solo, inputs, chip, fx, barsTag }
const lastNote = {}; // id -> note used when switching a step on

// bar pages: the grid shows one bar; a track shorter than the page loops,
// so page 3 of a 2-bar track is its bar 1 again
let page = 0;
let follow = true; // jump to the playing bar
const pages = () => Math.max(1, ...tune.tracks.filter((t) => t.kind !== 'code').map((t) => t.bars));
const barOf = (t) => page % t.bars;
const at = (id, i) => barOf(track(id)) * STEPS + i; // cell i on this page -> step index
const codeSteps = {}; // id -> steps read from the playing pattern, for code tracks

// The row's three sliders. Each column shows one of CONTROLS, chosen by
// clicking its heading and kept in this browser (COLUMNS_STORE).
// def: the slider's position when the code has no line for it; store: the
// value to write, null to remove the line; rest: fixed trailing arguments.
const lin = { to: (v) => v, from: (v) => v };
const logHz = (min, max) => ({
  min: 0, max: 1, step: 0.001,
  to: (f) => Math.log(f / min) / Math.log(max / min),
  from: (v) => min * (max / min) ** v,
});
const CONTROLS = {
  gain: { label: 'gain', min: 0, max: 1.2, step: 0.01, def: 1, ...lin, show: num },
  lpf: {
    label: 'high cut', ...logHz(40, 20000), def: 20000,
    show: (v) => (v >= 19500 ? 'open' : `${Math.round(v)} Hz`),
    store: (v) => (v >= 19500 ? null : Math.round(v)),
  },
  hpf: {
    label: 'low cut', ...logHz(20, 4000), def: 20,
    show: (v) => (v <= 21 ? 'off' : `${Math.round(v)} Hz`),
    store: (v) => (v <= 21 ? null : Math.round(v)),
  },
  room: { label: 'space', min: 0, max: 3, step: 0.05, def: 0, ...lin, show: num, store: (v) => (v > 0 ? v : null) },
  delay: { label: 'delay', min: 0, max: 1, step: 0.01, def: 0, ...lin, show: num, store: (v) => (v > 0 ? v : null) },
  pan: {
    label: 'pan', min: 0, max: 1, step: 0.01, def: 0.5, ...lin,
    show: (v) => (Math.abs(v - 0.5) < 0.01 ? 'center' : num(v)),
    store: (v) => (Math.abs(v - 0.5) < 0.01 ? null : v),
  },
  distort: { label: 'distort', min: 0, max: 5, step: 0.05, def: 0, ...lin, show: num, store: (v) => (v > 0 ? v : null) },
  crush: {
    label: 'crush', min: 1, max: 16, step: 1, def: 16, ...lin,
    show: (v) => (v >= 16 ? 'off' : `${v} bits`), store: (v) => (v >= 16 ? null : v),
  },
  coarse: { label: 'coarse', min: 1, max: 32, step: 1, def: 1, ...lin, show: (v) => (v <= 1 ? 'off' : num(v)), store: (v) => (v <= 1 ? null : v) },
  swingBy: { label: 'swing', rest: '8', min: 0, max: 0.33, step: 0.01, def: 0, ...lin, show: num, store: (v) => (v > 0 ? v : null) },
};
for (const [key, k] of Object.entries(CONTROLS)) k.key = key;

const COLUMNS_STORE = 'beats-ui-columns';
const DEFAULT_COLUMNS = ['gain', 'lpf', 'room'];
function loadColumns() {
  try {
    const c = JSON.parse(localStorage.getItem(COLUMNS_STORE));
    if (Array.isArray(c) && c.length === 3 && new Set(c).size === 3 && c.every((k) => CONTROLS[k])) return c;
  } catch {}
  return DEFAULT_COLUMNS;
}
let columns = loadColumns();
const knobsShown = () => columns.map((k) => CONTROLS[k]);

let paint = null; // { id, on, cell } while dragging across steps
let longPress;
const endPaint = () => {
  paint = null;
  clearTimeout(longPress);
};
window.addEventListener('pointerup', endPaint);
window.addEventListener('pointercancel', endPaint);

function buildRow(t) {
  const id = t.id;
  const row = h('div', 'row');
  row.dataset.id = id;

  const name = h('button', 'name');
  name.type = 'button';
  name.title = t.kind === 'code' ? 'drag to reorder' : 'drag to reorder · right-click for effects';
  name.setAttribute('aria-label', `${id}, drag or use arrow keys to reorder`);
  name.append(h('span', 'grip', '⠿'), h('span', 'label', id));
  if (t.kind === 'code') name.append(h('span', 'tag', 'code'));
  name.addEventListener('dblclick', () => startRename(id));
  name.addEventListener('pointerdown', (e) => startDrag(e, row));
  name.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const sib = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling?.nextElementSibling;
    if (e.key === 'ArrowUp' && !sib) return;
    rack.insertBefore(row, sib ?? null);
    commitOrder();
    rows.get(id).row.querySelector('.name').focus();
  });
  const who = h('div', 'who');
  who.append(name);
  const barsTag = t.kind === 'code' ? null : h('span', 'bars-tag');
  if (barsTag) name.append(barsTag);

  let chip = null;
  if (t.kind !== 'code') {
    chip = h('button', 'chip');
    chip.type = 'button';
    let held = false; // a long-press opened the trim panel: skip its click
    chip.addEventListener('click', () => {
      if (held) return void (held = false);
      const s = getSound(track(id));
      if (!s) return status(`${id}'s sound is a pattern: change it in the code`);
      openPicker({
        anchor: chip,
        current: s,
        note: track(id).kind === 'note' ? lastNote[id] : undefined,
        onPick: (snd) => {
          previewing = false;
          edit(() => setSound(track(id), snd));
          status(`${id} → ${soundLabel(snd)}`);
        },
        onStatus: status,
        onImport: importFiles,
        onPreview: (snd) => previewSound(id, snd),
      });
    });
    // right-click (long-press on touch): trim the sample
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTrimFor(id, chip);
    });
    chip.addEventListener('pointerdown', (e) => {
      held = false;
      if (e.pointerType === 'mouse') return;
      clearTimeout(longPress);
      longPress = setTimeout(() => {
        held = true;
        openTrimFor(id, chip);
      }, 450);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) chip.addEventListener(ev, () => clearTimeout(longPress));
    // ←→ on the chip: next / previous variation of the same sound
    chip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const s = getSound(track(id));
      const count = s && countOf(s.name, s.bank);
      if (!count || count < 2) return;
      e.preventDefault();
      const next = { ...s, n: (s.n + (e.key === 'ArrowRight' ? 1 : -1) + count) % count };
      edit(() => setSound(track(id), next));
      audition(next, track(id).kind === 'note' ? lastNote[id] : undefined);
      status(`${id} → ${soundLabel(next)} (${next.n + 1} of ${count})`);
    });
    who.append(chip);
  }
  row.append(who);

  const steps = h('div', 'steps');
  const cells = [];
  for (let i = 0; i < STEPS; i++) {
    const cell = h('button', 'step');
    cell.type = 'button';
    cell.setAttribute('aria-label', `${id} step ${i + 1}`);
    if (t.kind === 'code') {
      cell.classList.add('ro');
      cell.addEventListener('click', () => showInCode(id));
    } else {
      cell.dataset.map = `step:${id}:${i}`;
      cell.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // touch captures the pointer to this cell; release it so a drag
        // paints across the row like a mouse does
        if (cell.hasPointerCapture?.(e.pointerId)) cell.releasePointerCapture(e.pointerId);
        const on = !track(id).steps[at(id, i)];
        paint = { id, on, cell: i };
        setStep(id, i, on, 'start');
        // long-press a note step (phones have no right-click): put the step
        // back the way it was and open the piano
        if (t.kind === 'note' && e.pointerType !== 'mouse') {
          clearTimeout(longPress);
          longPress = setTimeout(() => {
            if (paint?.id !== id || paint.cell !== i) return;
            setStep(id, i, !on, true);
            paint = null;
            openNotePicker(id, i, cell);
          }, 450);
        }
      });
      cell.addEventListener('pointerenter', () => {
        if (paint?.id !== id || paint.cell === i) return;
        clearTimeout(longPress);
        paint.cell = i;
        setStep(id, i, paint.on, true);
      });
      cell.addEventListener('click', (e) => {
        if (e.detail === 0) setStep(id, i, !track(id).steps[at(id, i)]); // keyboard
      });
    }
    if (t.kind === 'note') {
      // right-click (long-press on touch): a small piano for this step
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openNotePicker(id, i, cell);
      });
      let acc = 0;
      cell.addEventListener(
        'wheel',
        (e) => {
          if (!track(id).steps[at(id, i)]) return;
          e.preventDefault();
          acc += e.deltaY;
          if (Math.abs(acc) < 30) return;
          shiftNote(id, i, acc < 0 ? 1 : -1, true);
          acc = 0;
        },
        { passive: false },
      );
      cell.addEventListener('keydown', (e) => {
        if (!track(id).steps[at(id, i)] || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        shiftNote(id, i, e.key === 'ArrowUp' ? 1 : -1);
      });
    }
    cells.push(cell);
    steps.append(cell);
  }
  row.append(steps);

  const mute = h('button', 'tog', 'M');
  const soloBtn = h('button', 'tog solo', 'S');
  mute.type = soloBtn.type = 'button';
  mute.setAttribute('aria-label', `${id} mute`);
  soloBtn.setAttribute('aria-label', `${id} solo`);
  soloBtn.title = 'solo';
  mute.dataset.map = `mute:${id}`;
  soloBtn.dataset.map = `solo:${id}`;
  mute.addEventListener('click', () => edit(() => (track(id).mute = !track(id).mute)));
  soloBtn.addEventListener('click', () => edit(() => (track(id).solo = !track(id).solo)));
  const fx = h('button', 'tog fx', 'fx');
  fx.type = 'button';
  fx.setAttribute('aria-label', `${id} effects`);
  fx.setAttribute('aria-haspopup', 'dialog');
  if (t.kind === 'code') {
    fx.disabled = true;
    fx.title = 'this track is code: add effects in the editor';
  } else {
    fx.addEventListener('click', () => openFx(id, fx));
    // right-click the track name: its effects
    name.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openFx(id, fx);
    });
  }
  const more = h('button', 'tog', '⋯');
  more.type = 'button';
  more.title = 'length, copy / paste this bar, rename, duplicate, delete';
  more.setAttribute('aria-label', `${id} options`);
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', () =>
    menu(more, [
      ...(t.kind === 'code'
        ? []
        : [1, 2, 4, 8].map((n) => ({
            label: `${track(id)?.bars === n ? '● ' : ''}length ${n} bar${n > 1 ? 's' : ''}`,
            run: () => setLength(id, n),
          }))),
      ...(t.kind === 'code'
        ? []
        : [
            { label: `copy bar ${barOf(track(id)) + 1}`, run: () => copyTrackBar(id) },
            ...(trackClip ? [{ label: `paste ${trackClip.from} into bar ${barOf(track(id)) + 1}`, run: () => pasteTrackBar(id) }] : []),
          ]),
      { label: 'rename', run: () => startRename(id) },
      { label: 'duplicate', run: () => duplicate(id) },
      { label: 'delete', run: () => remove(id), danger: true },
    ]),
  );
  const togs = h('div', 'togs');
  togs.append(mute, soloBtn, fx, more);
  row.append(togs);

  const { knobs, inputs } = buildKnobs(t, id);
  row.append(knobs);

  return { row, kind: t.kind, cells, mute, solo: soloBtn, inputs, chip, fx, barsTag };
}

// column headings: click one to pick what that column shows
function renderColumns() {
  const heads = columns.map((key, slot) => {
    const b = h('button', 'link col-head', CONTROLS[key].label);
    b.type = 'button';
    b.title = 'choose what this column shows';
    b.addEventListener('click', () =>
      menu(
        b,
        Object.values(CONTROLS).map((k) => ({
          label: `${k.key === key ? '● ' : columns.includes(k.key) ? '○ ' : '\u00a0\u00a0'}${k.label}`,
          run: () => setColumn(slot, k.key),
        })),
        { label: `column ${slot + 1}` },
      ),
    );
    return b;
  });
  $('#columns').replaceChildren(...heads);
}

// a control already in another column swaps places with this one
function setColumn(slot, key) {
  const next = [...columns];
  const other = next.indexOf(key);
  if (other !== -1) next[other] = next[slot];
  next[slot] = key;
  columns = next;
  try {
    localStorage.setItem(COLUMNS_STORE, JSON.stringify(columns));
  } catch {}
  for (const [id, r] of rows) {
    const { knobs, inputs } = buildKnobs(track(id), id);
    r.row.querySelector('.knobs').replaceWith(knobs);
    r.inputs = inputs;
    syncRow(track(id), r);
  }
  renderColumns();
  markControls();
  status(`columns: ${knobsShown().map((k) => k.label).join(' · ')}`);
}

function buildKnobs(t, id) {
  const knobs = h('div', 'knobs');
  const inputs = {};
  for (const k of knobsShown()) {
    const input = h('input');
    Object.assign(input, { type: 'range', min: k.min, max: k.max, step: k.step });
    input.setAttribute('aria-label', `${id} ${k.label}`);
    if (t.kind !== 'code') input.dataset.map = `${k.key}:${id}`;
    input.addEventListener('input', () => {
      const v = k.from(Number(input.value));
      edit(() => setParam(track(id), k.key, k.store ? k.store(v) : v, undefined, k.rest), true);
      status(`${id} · ${k.label} ${k.show(v)}`);
    });
    input.addEventListener('dblclick', () => {
      edit(() => setParam(track(id), k.key, null, undefined, k.rest));
      status(`${id} · ${k.label} removed from the code`);
    });
    inputs[k.key] = input;
    // the caption shows on phones, where the column headings are hidden
    const knob = h('label', 'knob');
    knob.append(h('span', 'knob-cap', k.label), input);
    knobs.append(knob);
  }
  return { knobs, inputs };
}

const isMissing = (s) => soundsReady && !!s && !hasSound(s.name, s.bank);
// settings: theme, layout, audio output, code font size, helpers, keys (settings.js)
$('#settings').addEventListener('click', (e) => openSettings(e.currentTarget, { editor, onStatus: status, onReset: resetEverything }));

// everything StrudelUI keeps in this browser (this site's localStorage and the
// sample database), then a reload into a first visit
async function resetEverything() {
  wiping = true;
  clearTimeout(saveTimer);
  if (playing) editor.stop();
  try {
    await deleteAllUserSamples();
  } catch (err) {
    wiping = false;
    return status(`couldn't reset: ${err.message ?? err}`, true);
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {}
  location.replace(location.pathname);
}

// hovering a missing sound's ! : which sample, and how to bring it in
const tip = h('div', 'tip');
tip.hidden = true;
document.body.append(tip);
rack.addEventListener('pointerover', (e) => {
  const mark = e.target.closest?.('.chip .miss');
  if (!mark) return;
  tip.replaceChildren(
    h('b', '', mark.dataset.sample), ' is missing: it isn\'t in this browser.',
    h('div', '', `+ samples → a folder named ${mark.dataset.sound}, or open the tune's .zip (download with samples).`),
  );
  tip.hidden = false;
  const r = mark.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  tip.style.left = `${Math.max(8, Math.min(r.left - 6, vw - tip.offsetWidth - 8))}px`;
  tip.style.top = `${r.bottom + 6}px`;
});
rack.addEventListener('pointerout', (e) => {
  if (e.target.closest?.('.chip .miss')) tip.hidden = true;
});
addEventListener('scroll', () => (tip.hidden = true), true);

// sounds the tune uses that this browser doesn't have (e.g. someone else's samples)
const missingSounds = () => [...new Set(tune.tracks.map((t) => t.kind !== 'code' && getSound(t)).filter(isMissing).map(soundLabel))];
// after opening a tune: the message, plus what's missing here, with undo
function openedStatus(msg, warn = false) {
  const miss = missingSounds();
  const note = miss.length ? ` · not in this browser: ${miss.join(', ')} (+ samples to import)` : '';
  const waits = held && tune.tracks.some((t) => t.kind === 'code') ? ' · its code runs when you press play' : '';
  status(msg + waits + note, warn || miss.length > 0, { label: 'undo', run: undo });
}
const soundLabel = (s) => `${s.name}${s.n ? `:${s.n}` : ''}${s.bank ? ` · ${s.bank}` : ''}`;

// Bring the rack in line with `tune`: rows rebuilt only when a track appears
// or changes kind, so a slider being dragged is never replaced.
function render() {
  // clamp first: syncRow shows each row's bar for `page`
  if (page >= pages()) page = pages() - 1;
  const ids = new Set(tune.tracks.map((t) => t.id));
  for (const [id, r] of rows) {
    if (!ids.has(id)) {
      r.row.remove();
      rows.delete(id);
    }
  }
  let prev = null;
  for (const t of tune.tracks) {
    let r = rows.get(t.id);
    if (!r || r.kind !== t.kind) {
      const fresh = buildRow(t);
      r?.row.replaceWith(fresh.row);
      rows.set(t.id, (r = fresh));
    }
    // DOM order = code order; only move rows that are out of place, since
    // moving a row would blur a slider being dragged in it
    const want = prev ? prev.nextElementSibling : rack.firstElementChild;
    if (r.row !== want) rack.insertBefore(r.row, want);
    prev = r.row;
    syncRow(t, r);
  }
  $('#empty').hidden = tune.tracks.length > 0;
  renderPager();
  renderArrange();

  if (document.activeElement !== bpm) bpm.value = tune.bpm ?? '';
  bpm.disabled = tune.bpm == null;
  const p = getPump(tune);
  $('#pump-ctl').hidden = !p;
  if (p && document.activeElement !== pump) pump.value = p.depths[0];
  // a tune with no drum machine tracks (a new empty one) keeps the kit
  // picked before, so new drum tracks still get it
  const k = currentKit();
  if (k && document.activeElement !== kit) kit.value = [...kit.options].find((o) => o.value.toLowerCase() === k)?.value ?? '';
  markControls();
}

function syncRow(t, r) {
  const b = t.kind === 'code' ? 0 : barOf(t);
  const steps = t.kind === 'code' ? codeSteps[t.id] ?? [] : t.steps.slice(b * STEPS, (b + 1) * STEPS);
  r.row.classList.toggle('looping', t.kind !== 'code' && page >= t.bars);
  if (r.barsTag) {
    r.barsTag.textContent = t.bars > 1 ? `${b + 1}/${t.bars}` : '';
    r.barsTag.title = t.bars > 1 ? `bar ${b + 1} of this track's ${t.bars}` : '';
  }
  r.cells.forEach((c, i) => {
    const v = steps[i];
    c.classList.toggle('on', !!v);
    c.textContent = typeof v === 'string' ? v : '';
    c.setAttribute('aria-pressed', !!v);
    c.setAttribute('aria-label', `${t.id} step ${i + 1}${typeof v === 'string' ? ` ${v}` : ''}`);
  });
  if (r.chip) {
    const s = getSound(t);
    const missing = isMissing(s);
    const mark = missing && h('span', 'miss', '!');
    if (mark) Object.assign(mark.dataset, { sample: `${s.name}:${s.n ?? 0}`, sound: s.name });
    r.chip.replaceChildren(...(mark ? [mark, ' '] : []), s ? soundLabel(s) : 'pattern');
    // a missing sound explains itself in the ! tip (the .tip pointerover handler); no slow native tooltip on top
    r.chip.title = missing ? '' : s ? `${soundLabel(s)} · click to change, ←→ for variations, right-click to trim` : 'sound is a pattern: change it in the code';
    if (missing) r.chip.setAttribute('aria-label', `${soundLabel(s)}, missing: not in this browser`);
    else r.chip.removeAttribute('aria-label');
  }
  if (t.kind !== 'code') {
    // NaN: written in code (on), except for an fx with a why() (pump), where it
    // means it can't be switched here
    const on = FX.filter((f) => {
      const v = fxValue(t, f);
      return v !== null && !(f.why && Number.isNaN(v));
    });
    r.fx.textContent = on.length ? `fx ${on.length}` : 'fx';
    r.fx.classList.toggle('on', on.length > 0);
    r.fx.title = on.length ? `effects: ${on.map((f) => f.label).join(', ')}` : 'add effects';
  }
  r.mute.classList.toggle('active', !!t.mute);
  r.solo.classList.toggle('active', !!t.solo);
  r.mute.setAttribute('aria-pressed', !!t.mute);
  r.solo.setAttribute('aria-pressed', !!t.solo);
  const fromMixCode = t.inMixCode && !t.listed;
  r.mute.disabled = r.solo.disabled = !tune.mix || tune.mode === 'song' || fromMixCode;
  r.mute.title = tune.mode === 'song' ? 'song mode: scenes decide what plays'
    : !tune.mix ? 'no live mix in the code'
    : fromMixCode ? "plays from the mix's own code: mute it there" : 'mute';
  r.row.classList.toggle('silent', tune.mode === 'song' ? !!stage && !stage.has(t.id) : !isAudible(t) || !tune.mix);
  for (const k of knobsShown()) {
    const input = r.inputs[k.key];
    const v = t.kind === 'code' ? NaN : getParam(t, k.key, k.rest);
    input.disabled = Number.isNaN(v);
    input.title = input.disabled ? `${k.label}: set in code` : `${k.label} ${k.show(v ?? k.def)}`;
    if (document.activeElement !== input) input.value = k.to(Number.isNaN(v) ? k.def : v ?? k.def);
  }
  if (t.kind === 'note' && !lastNote[t.id]) lastNote[t.id] = t.steps.find(Boolean) ?? 'c2';
}

function setStep(id, cell, on, merge = false) {
  const t = track(id);
  const i = at(id, cell);
  const next = on ? (t.kind === 'note' ? t.steps[i] || lastNote[id] : true) : null;
  if (t.steps[i] === next) return;
  edit(() => {
    const t = track(id);
    t.steps[i] = next;
    t.pat = null;
  }, merge);
}

// Trim: .begin / .end on the track's chain, set on the sample's waveform.
// Android fires contextmenu on a long-press too, so a second open within
// 600 ms of the first is ignored.
let trimOpened = { id: null, at: 0 };
function openTrimFor(id, anchor) {
  const now = Date.now();
  if (trimOpened.id === id && now - trimOpened.at < 600) return;
  trimOpened = { id, at: now };
  const s = getSound(track(id));
  if (!s) return status(`${id}'s sound is a pattern: trim it in the code`);
  if (!isSample(s.name, s.bank)) return status(`${soundLabel(s)} is a synth · trim works on samples`);
  openTrim({
    anchor,
    id,
    sound: s,
    note: track(id).kind === 'note' ? lastNote[id] : undefined,
    read: () => ({ begin: getParam(track(id), 'begin'), end: getParam(track(id), 'end') }),
    write: (begin, end, merge) => edit(() => setTrim(track(id), begin, end), merge),
    onStatus: status,
  });
}

// a one-octave piano: click a key to hear it and set the step, ‹ › for octaves
const KEYS = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
function openNotePicker(id, cellIdx, anchor) {
  // the step is fixed when the piano opens (the page may follow the playhead on)
  const idx = at(id, cellIdx);
  const current = track(id).steps[idx];
  let octave = Number((current ?? lastNote[id] ?? 'c2').match(/-?\d$/)[0]);
  const title = h('div', 'fx-title');
  const keys = h('div', 'piano');
  const set = (note) => {
    edit(() => {
      const t = track(id);
      t.steps[idx] = note;
      t.pat = null;
    });
    if (note) {
      lastNote[id] = note;
      const s = getSound(track(id));
      if (s) audition(s, note);
    }
    draw();
  };
  function draw() {
    const now = track(id)?.steps[idx];
    title.textContent = `${id} · bar ${Math.floor(idx / STEPS) + 1} step ${cellIdx + 1} · ${now ?? 'empty'}`;
    keys.replaceChildren(
      ...KEYS.map((k) => {
        const note = `${k}${octave}`;
        const b = h('button', `key${k.includes('#') ? ' black' : ''}${now && toMidi(now) === toMidi(note) ? ' on' : ''}`, k.includes('#') ? '' : note);
        b.type = 'button';
        b.title = note;
        b.setAttribute('aria-label', note);
        b.addEventListener('click', () => set(note));
        return b;
      }),
    );
  }
  const nav = h('div', 'ask');
  const btn = (label, title, run) => {
    const b = h('button', 'link', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', run);
    return b;
  };
  const octLabel = h('span', 'fx-value');
  const moveOctave = (by) => {
    octave = Math.max(0, Math.min(7, octave + by));
    octLabel.textContent = `octave ${octave}`;
    draw();
  };
  nav.append(
    btn('‹ octave', 'an octave down', () => moveOctave(-1)),
    octLabel,
    btn('octave ›', 'an octave up', () => moveOctave(1)),
    h('span', 'pager-gap'),
    btn('× clear', 'empty this step', () => set(null)),
  );
  octLabel.textContent = `octave ${octave}`;
  draw();
  popover(anchor, [title, keys, nav], { className: 'ask-panel note-panel', label: `${id} note` });
  keys.querySelector('.key.on, .key')?.focus();
}

function shiftNote(id, cell, by, merge = false) {
  let note;
  const i = at(id, cell);
  edit(() => {
    const t = track(id);
    note = fromMidi(Math.min(96, Math.max(12, toMidi(t.steps[i]) + by)));
    t.steps[i] = lastNote[id] = note;
    t.pat = null;
  }, merge);
  status(`${id} · bar ${Math.floor(i / STEPS) + 1} step ${cell + 1} → ${note}`);
}

function showInCode(id) {
  const t = track(id);
  if (!t) return;
  editor.editor.dispatch({ selection: { anchor: t.range[0] }, scrollIntoView: true });
  editor.editor.focus();
  status(`${id} is written as code: edit it in the editor, ctrl+enter to apply`);
}

// Code tracks: read their steps from the playing pattern. Every event carries
// the source location of the code that made it, which falls inside one block.
function readCodeRows(cycle) {
  if (!pattern) return;
  const blocks = activeTune.tracks.filter((t) => t.kind === 'code');
  if (!blocks.length) return;
  const found = {};
  let haps = [];
  try {
    haps = pattern.queryArc(cycle, cycle + 1);
  } catch {}
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const at = hap.context?.locations?.[0]?.start;
    const b = at != null && blocks.find((t) => at >= t.range[0] && at < t.range[1]);
    if (!b) continue;
    const step = Math.floor((hap.whole.begin.valueOf() - cycle) * STEPS);
    if (step < 0 || step >= STEPS) continue;
    const v = hap.value?.note;
    (found[b.id] ??= Array(STEPS).fill(null))[step] =
      typeof v === 'string' ? v : typeof v === 'number' ? fromMidi(Math.round(v)) : true;
  }
  // muted tracks aren't in the pattern: keep what they last played
  for (const t of blocks) if (found[t.id] || isAudible(t)) codeSteps[t.id] = found[t.id] ?? [];
  for (const t of tune.tracks) if (t.kind === 'code' && rows.has(t.id)) syncRow(t, rows.get(t.id));
}

// ── bars ──────────────────────────────────────────

const gridTracks = () => tune.tracks.filter((t) => t.kind !== 'code');

function setPage(p) {
  page = Math.max(0, Math.min(pages() - 1, p));
  for (const t of tune.tracks) if (rows.has(t.id)) syncRow(t, rows.get(t.id));
  if (!playing || !follow) readCodeRows(page);
  renderPager();
}

function setLength(id, n) {
  edit(() => setBars(track(id), n));
  status(`${id} is ${n} bar${n > 1 ? 's' : ''} long${n > 1 ? ' · its new bars start as copies' : ''}`);
}

// + bar: the longest tracks grow by a copy of their last bar; shorter ones keep looping
function addBar() {
  const L = pages();
  if (L >= MAX_BARS) return status(`${MAX_BARS} bars is the most`);
  edit(() => {
    for (const t of gridTracks()) {
      if (t.bars !== L) continue;
      t.steps.push(...t.steps.slice((L - 1) * STEPS));
      t.bars = L + 1;
      t.pat = null;
    }
  });
  setPage(L);
  status(`added bar ${L + 1} · a copy of bar ${L}`);
}

function removeBar() {
  const L = pages();
  if (L === 1) return;
  edit(() => gridTracks().filter((t) => t.bars === L).forEach((t) => setBars(t, L - 1)));
  setPage(Math.min(page, L - 2));
  status(`removed bar ${L}`, false, { label: 'undo', run: undo });
}

let clip = null; // id -> one bar of steps

// one track's bar, from the track's ⋯ menu; pastes into any grid track (the bar
// it shows): hits become the track's last note on a note track, notes become hits
let trackClip = null; // { from: label, steps }
function copyTrackBar(id) {
  const t = track(id);
  const b = barOf(t);
  trackClip = { from: `${id} bar ${b + 1}`, steps: t.steps.slice(b * STEPS, (b + 1) * STEPS) };
  status(`copied ${trackClip.from} · paste it from any track's ⋯ menu`);
}
function pasteTrackBar(id) {
  if (!trackClip) return;
  const b = barOf(track(id));
  const before = code;
  edit(() => {
    const t = track(id);
    const steps = trackClip.steps.map((v) => (!v ? null : t.kind === 'note' ? (v === true ? lastNote[id] : v) : true));
    t.steps.splice(b * STEPS, STEPS, ...steps);
    t.pat = null;
  });
  // edit() records history only for a change, so undo is offered only then
  if (code === before) status(`${id} bar ${b + 1} already matches ${trackClip.from}`);
  else status(`pasted ${trackClip.from} into ${id} bar ${b + 1}`, false, { label: 'undo', run: undo });
}
function copyBar() {
  clip = Object.fromEntries(gridTracks().map((t) => [t.id, t.steps.slice(barOf(t) * STEPS, (barOf(t) + 1) * STEPS)]));
  status(`copied bar ${page + 1} · go to another bar and paste`);
  renderPager();
}
function pasteBar() {
  if (!clip) return status('copy a bar first');
  let n = 0;
  edit(() => {
    for (const t of gridTracks()) {
      if (!clip[t.id] || page >= t.bars) continue;
      t.steps.splice(page * STEPS, STEPS, ...clip[t.id]);
      t.pat = null;
      n++;
    }
  });
  const skipped = gridTracks().filter((t) => page >= t.bars).length;
  status(`pasted into bar ${page + 1} on ${n} tracks${skipped ? ` · ${skipped} shorter ones loop and were left alone` : ''}`);
}

const pager = $('#pager');
let pageBtns = [];
function renderPager() {
  const L = pages();
  const bits = [h('span', 'pager-label', 'bar')];
  pageBtns = Array.from({ length: L }, (_, i) => {
    const b = h('button', `page${i === page ? ' on' : ''}${playing && i === currentBar % L ? ' playing' : ''}`, String(i + 1));
    b.type = 'button';
    b.setAttribute('aria-label', `bar ${i + 1}`);
    b.dataset.map = `page:${i}`;
    if (i === page && !follow) b.title = 'click again to follow the playing bar';
    b.addEventListener('click', () => {
      // the bar on screen, clicked again: back to following the playhead
      if (i === page && !follow) {
        follow = true;
        if (playing) setPage(currentBar % pages());
        else renderPager();
        return status('following the playing bar');
      }
      if (playing && follow) follow = false;
      setPage(i);
    });
    return b;
  });
  const act = (label, title, run, disabled = false) => {
    const b = h('button', 'link', label);
    b.type = 'button';
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  };
  const followBtn = act(follow ? '● follow' : '○ follow', 'jump to the bar that is playing', () => {
    follow = !follow;
    renderPager();
  });
  bits.push(
    ...pageBtns,
    act('+', 'add a bar (a copy of the last one)', addBar, L >= MAX_BARS),
    act('−', 'remove the last bar', removeBar, L === 1),
    h('span', 'pager-gap'),
    act('copy', `copy this bar (${MOD}+c)`, copyBar),
    act('paste', `paste into this bar (${MOD}+v)`, pasteBar, !clip),
    followBtn,
  );
  pager.replaceChildren(...bits);
  markControls();
}

// ── scenes and the song ───────────────────────────
// A scene is a set of tracks (const intro = stack(kick, hats)). Clicking one
// sets the live mix to it. The song plays scenes in order for so many bars.

const arrangeEl = $('#arrange');
let stage = null; // ids playing in the current song section, while the song plays
let section = -1;

const audibleIds = () => tune.tracks.filter(isAudible).map((t) => t.id);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function launchScene(id) {
  const sc = tune.scenes.find((s) => s.id === id);
  edit(() => {
    if (tune.mode === 'song') setMode(tune, 'loop');
    for (const t of tune.tracks) {
      t.solo = false;
      t.mute = !sc.ids.includes(t.id);
    }
  });
  status(`scene ${id} · ${sc.ids.length} tracks`);
}

let sceneClick = null; // the last scene click: { id, changed }, for a double-click to take back
const SCENE_NAMES = ['intro', 'build', 'drop', 'break', 'outro'];
function newScene() {
  const id = SCENE_NAMES.find((n) => !nameProblem(n)) ?? freeName('part');
  const ids = audibleIds();
  edit(() => addScene(tune, id, ids));
  status(`scene ${id}: the ${ids.length} tracks playing now · add it to the song below`);
}

async function renameScene(anchor, id) {
  const name = await askName(anchor, `rename ${id}`, id);
  if (!name || name === id) return;
  const problem = nameProblem(name, id);
  if (problem) return status(`can't rename ${id}: ${problem}`, true);
  edit(() => renameTrack(tune, id, name));
  renameMappings(id, name);
}

function sceneMenu(anchor, id) {
  menu(anchor, [
    { label: 'set to the tracks playing now', run: () => edit(() => (tune.scenes.find((s) => s.id === id).ids = audibleIds())) },
    { label: 'rename', run: () => renameScene(anchor, id) },
    { label: 'delete', danger: true, run: () => {
      edit(() => removeScene(tune, id));
      status(`deleted scene ${id}`, false, { label: 'undo', run: undo });
    } },
  ]);
}

function entryMenu(anchor, i) {
  const e = tune.song.entries[i];
  const move = (by) => edit(() => {
    const list = tune.song.entries;
    list.splice(i + by, 0, ...list.splice(i, 1));
  });
  const PRESETS = [1, 2, 4, 8, 16];
  const typeBars = async () => {
    const v = await askName(anchor, `${e.scene}: how many bars (1-256)`, String(e.bars), 'set');
    if (v == null) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 256) return status(`bars: a whole number from 1 to 256, not "${v}"`, true);
    edit(() => (tune.song.entries[i].bars = n));
    status(`${e.scene} plays for ${n} bar${n > 1 ? 's' : ''}`);
  };
  menu(anchor, [
    ...PRESETS.map((n) => ({ label: `${e.bars === n ? '● ' : ''}${n} bar${n > 1 ? 's' : ''}`, run: () => edit(() => (tune.song.entries[i].bars = n)) })),
    { label: PRESETS.includes(e.bars) ? 'other…' : `● ${e.bars} bars · change…`, run: typeBars },
    ...(i > 0 ? [{ label: 'move earlier', run: () => move(-1) }] : []),
    ...(i < tune.song.entries.length - 1 ? [{ label: 'move later', run: () => move(1) }] : []),
    { label: 'remove', danger: true, run: () => edit(() => {
      tune.song.entries.splice(i, 1);
      if (!tune.song.entries.length) {
        tune.song = null;
        setMode(tune, 'loop');
      }
    }) },
  ]);
}

function renderArrange() {
  const chip = (cls, text, onClick, title = '') => {
    const b = h('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  const live = audibleIds();
  const scenes = tune.scenes.map((sc) => {
    const wrap = h('span', 'scene-wrap');
    const on = tune.mode === 'song' ? stage && sameSet([...stage], sc.ids) : sameSet(sc.ids, live);
    const b = chip(`scene${on ? ' on' : ''}`, sc.id, (e) => {
      if (e.detail > 1) return; // the second click of a double-click
      const before = code;
      launchScene(sc.id);
      sceneClick = { id: sc.id, changed: code !== before };
    }, `${sc.ids.join(', ') || 'no tracks'} · click to play this mix, double-click to rename`);
    // double-click: rename. Its first click already switched to the scene, so
    // that switch is undone first (the mix stays as it was)
    b.addEventListener('dblclick', () => {
      if (sceneClick?.id === sc.id && sceneClick.changed) undo(); // dblclick pairs the clicks at the OS speed
      sceneClick = null;
      status(`rename ${sc.id}`);
      const anchor = [...$('#arrange').querySelectorAll('.scene')].find((x) => x.textContent === sc.id) ?? b;
      renameScene(anchor, sc.id);
    });
    b.dataset.map = `scene:${sc.id}`;
    const more = chip('scene-more', '⋯', (e) => sceneMenu(e.currentTarget, sc.id), `${sc.id} options`);
    wrap.append(b, more);
    return wrap;
  });
  const sceneRow = h('div', 'arr-row');
  sceneRow.append(h('span', 'arr-label', 'scenes'), ...scenes, chip('link', '+ scene', newScene, 'save the tracks playing now as a scene'));

  const songRow = h('div', 'arr-row');
  const entries = (tune.song?.entries ?? []).map((e, i) =>
    chip(`entry${tune.mode === 'song' && section === i ? ' on' : ''}`, `${e.scene} ×${e.bars}`, (ev) => entryMenu(ev.currentTarget, i), 'bars, order, remove'),
  );
  const addEntry = chip('link', '+', (ev) => {
    if (!tune.scenes.length) return status('make a scene first: + scene saves the tracks playing now');
    menu(ev.currentTarget, tune.scenes.map((sc) => ({ label: sc.id, run: () => edit(() => addSongEntry(tune, sc.id, 4, tune.song?.id ?? freeName('song'))) })));
  }, 'add a scene to the song');
  const mode = h('span', 'mode');
  const loopBtn = chip(`seg${tune.mode !== 'song' ? ' on' : ''}`, 'loop', () => edit(() => setMode(tune, 'loop')), 'play the live mix (stack)');
  const songBtn = chip(`seg${tune.mode === 'song' ? ' on' : ''}`, 'song', () => {
    if (!tune.song?.entries.length) return status('add scenes to the song first');
    edit(() => setMode(tune, 'song', declared(code)));
    status(`song mode · ${songLength(tune)} bars, then it starts over`);
  }, 'play the song (arrange)');
  mode.append(loopBtn, songBtn);
  songRow.append(h('span', 'arr-label', 'song'), ...entries, addEntry, mode);
  if (tune.song) songRow.append(h('span', 'fx-value', `${songLength(tune)} bars`));
  arrangeEl.replaceChildren(sceneRow, songRow);
}

// Which song section plays at this cycle, and which bar of its scene. On the
// song's k-th pass, arrange() plays a section's bars k·n … k·n+n-1 (it speeds
// the scene up into its slot), so a 2-bar track in a 1-bar section alternates.
function sectionAt(cycle) {
  const total = songLength(tune);
  if (tune.mode !== 'song' || !total) return null;
  const pass = Math.floor(cycle / total);
  let c = cycle - pass * total;
  for (const [i, e] of tune.song.entries.entries()) {
    if (c < e.bars) return { i, bar: pass * e.bars + c, ids: tune.scenes.find((s) => s.id === e.scene)?.ids ?? [] };
    c -= e.bars;
  }
  return null;
}

// ── tracks: add, rename, duplicate, delete ────────

const RESERVED = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof let new null return super switch this throw true try typeof var void while ' +
    'with yield await implements interface package private protected public static').split(' '),
);
// a track's name is a const in the tune, so it can't clash with another
// name in the code or with Strudel's own names
function nameProblem(name, self = null) {
  if (!IDENT.test(name)) return 'use letters, numbers and _ (not starting with a number)';
  if (RESERVED.has(name)) return `${name} is a JavaScript word`;
  if (name !== self && (allIds(tune).includes(name) || declared(code).has(name))) return `${name} is already used in this tune`;
  if (name !== self && name in globalThis) return `${name} is taken by Strudel`;
  return null;
}
function freeName(base) {
  let name = base;
  for (let i = 2; nameProblem(name); i++) name = `${base}${i}`;
  return name;
}

// new tracks start playable, in the key of the tune's first note track, each
// on an orbit of its own (freeOrbit)
const TEMPLATES = {
  drum: (id, root, kitName, orbit) => {
    const bank = kitName && hasSound('cp', kitName) ? `.bank("${kitName}")` : '';
    return `const ${id} = s("cp")${bank}\n  .struct("~ ~ ~ ~  x ~ ~ ~  ~ ~ ~ ~  x ~ ~ ~")\n  .gain(.5)\n  .orbit(${orbit})`;
  },
  bass: (id, root, kitName, orbit) =>
    `const ${id} = note("~ ~ ${root}1 ~  ~ ~ ${root}1 ~  ~ ~ ${root}1 ~  ~ ~ ${root}1 ~").s("sawtooth")\n` +
    `  .decay(.15)\n  .sustain(0)\n  .lpf(500)\n  .gain(.5)\n  .orbit(${orbit})`,
  chord: (id, root, kitName, orbit) =>
    `const ${id} = note("${root}3 ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~").s("square")\n` +
    `  .add(note("0,3,7"))\n  .decay(.5)\n  .sustain(0)\n  .lpf(1800)\n  .room(.4)\n  .gain(.3)\n  .orbit(${orbit})`,
  code: (id, root, kitName, orbit) =>
    `const ${id} = n("<0 2 4>(3,8)").scale("${root.toUpperCase()}3:minor").s("triangle")\n` +
    `  .decay(.2)\n  .sustain(0)\n  .gain(.3)\n  .orbit(${orbit})`,
};
const BASE_NAME = { drum: 'perc', bass: 'bass', chord: 'stab', code: 'riff' };

function addNew(kind) {
  const first = tune.tracks.find((t) => t.kind === 'note' && t.steps.some(Boolean))?.steps.find(Boolean);
  const root = first ? first.replace(/-?\d$/, '') : 'c';
  const id = freeName(BASE_NAME[kind]);
  edit(() => addTrack(tune, blockToTrack(TEMPLATES[kind](id, root, kit.value, freeOrbit(editor.code)))));
  const r = showNew(id);
  if (kind === 'code') showInCode(id);
  else {
    status(`added ${id} · pick its sound`);
    r.chip.click();
  }
}

function showNew(id) {
  const r = rows.get(id);
  r.row.scrollIntoView({ block: 'nearest' });
  r.row.classList.add('fresh');
  setTimeout(() => r.row.classList.remove('fresh'), 1200);
  return r;
}

// "sample": one hit on step 1, the picker open on it (user samples first,
// starting from the newest), and the track named after the sound picked
function addSample() {
  const newest = catalog().filter((i) => i.group === 'yours').at(-1);
  const bank = kit.value && hasSound('cp', kit.value) ? `.bank("${kit.value}")` : '';
  const head = newest ? `s("${newest.name}")` : `s("cp")${bank}`;
  const id = freeName('sample');
  edit(() => addTrack(tune, blockToTrack(`const ${id} = ${head}\n  .struct("x ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~")\n  .gain(.6)\n  .orbit(${freeOrbit(editor.code)})`)));
  const r = showNew(id);
  status(`added ${id} · pick a sound or import one`);
  openPicker({
    anchor: r.chip,
    current: getSound(track(id)),
    onPick: (snd) => {
      if (!track(id)) return;
      const base = snd.name.replace(/[^\w$]/g, '_');
      const name = freeName(/^[A-Za-z_$]/.test(base) ? base : `s_${base}`);
      edit(() => {
        setSound(track(id), snd);
        renameTrack(tune, id, name);
      });
      status(`added ${name}${name === snd.name && !snd.bank ? '' : ` · ${soundLabel(snd)}`} · click steps to place hits`);
    },
    onStatus: status,
    onImport: importFiles,
  });
}

$('#add-track').addEventListener('click', (e) =>
  menu(e.currentTarget, [
    { label: 'drum · hits on a grid', run: () => addNew('drum') },
    { label: 'bass · notes on a grid', run: () => addNew('bass') },
    { label: 'chord · minor stabs', run: () => addNew('chord') },
    { label: 'code · write it in the editor', run: () => addNew('code') },
    { label: 'sample · pick or import a sound', run: addSample },
  ]),
);

function startRename(id) {
  const nameBtn = rows.get(id)?.row.querySelector('.name');
  if (!nameBtn) return;
  const input = h('input', 'rename');
  Object.assign(input, { value: id, spellcheck: false });
  input.setAttribute('aria-label', `rename ${id}`);
  nameBtn.replaceWith(input);
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(nameBtn);
    if (!save || name === id) return;
    const problem = nameProblem(name, id);
    if (problem) return status(`can't rename ${id}: ${problem}`, true);
    edit(() => renameTrack(tune, id, name));
    renameMappings(id, name);
    lastNote[name] = lastNote[id];
    codeSteps[name] = codeSteps[id];
    status(`renamed ${id} → ${name} (and everywhere the code uses it)`);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function duplicate(id) {
  const copy = freeName(id.replace(/\d+$/, ''));
  edit(() => duplicateTrack(tune, id, copy));
  lastNote[copy] = lastNote[id];
  status(`duplicated ${id} → ${copy}`);
}

function remove(id) {
  syncFromCode();
  const usedBy = references(tune, id);
  edit(() => removeTrack(tune, id));
  if (usedBy.length) status(`deleted ${id}, but ${usedBy.join(', ')} still use${usedBy.length > 1 ? '' : 's'} it: the tune errors until that's fixed`, true, { label: 'undo', run: undo });
  else status(`deleted ${id}`, false, { label: 'undo', run: undo });
}

// ── effects ───────────────────────────────────────
// each one is a line in the track's chain: on = the line is there

// pump: on / off for this track (pumpTrack), at the header's amount;
// [short, long] reasons it can't be switched from here
const PUMP_WHY = {
  source: ['drives it', 'this track drives the pump'],
  none: ['no kick', 'no kick track to drive the pump'],
  orbit: ['in code', 'its .orbit() is written as a pattern'],
  code: ['in code', "the kick's duck lists are written as patterns"],
};
function pumpNote(p) {
  if (p.why) return PUMP_WHY[p.why][1];
  const move = p.shared.length ? ` · switching moves it off orbit ${p.orbit} (shared with ${p.shared.join(', ')})` : '';
  return `${p.depth ? 'dips' : 'switch on to dip'} on each ${p.source.id} hit, by the header's pump amount${move}`;
}

// get / set / why / note: an effect that isn't one line in this track's chain;
// toggle: on / off only
const FX = [
  {
    key: 'pump', label: 'pump', toggle: true,
    get: (t) => {
      const p = getTrackPump(tune, t);
      return p.why ? NaN : p.depth ? true : null;
    },
    set: (t, v) => {
      const moved = pumpTrack(tune, t, v != null);
      return moved && `${t.id} · pump ${v != null ? 'on' : 'off'} · moved to orbit ${moved}, its own`;
    },
    why: (t) => PUMP_WHY[getTrackPump(tune, t).why],
    note: (t) => pumpNote(getTrackPump(tune, t)),
  },
  { key: 'delay', label: 'delay', min: 0, max: 1, step: 0.01, on: 0.3 },
  { key: 'distort', label: 'distort', min: 0, max: 5, step: 0.05, on: 1 },
  { key: 'crush', label: 'crush', min: 1, max: 16, step: 1, on: 6, hint: 'bits · lower is harsher' },
  { key: 'coarse', label: 'coarse', min: 1, max: 32, step: 1, on: 6, hint: 'sample-rate cut' },
  { key: 'phaser', label: 'phaser', min: 0.25, max: 8, step: 0.25, on: 2, hint: 'speed' },
  { key: 'hpf', label: 'low cut', min: 20, max: 4000, step: 0.001, on: 300, log: true, unit: ' Hz' },
  { key: 'pan', label: 'pan', min: 0, max: 1, step: 0.01, on: 0.5, hint: '0 left · 1 right' },
  { key: 'jux', label: 'stereo', line: '.jux(rev)', hint: 'jux(rev): reversed copy on the right' },
  // swingBy(x, 8): every second 16th late by x of a 16th
  { key: 'swingBy', rest: '8', label: 'swing', min: 0, max: 0.33, step: 0.01, on: 0.17, hint: 'swung 16ths · .17 light · .33 triplet' },
];
const fxTo = (f, v) => (f.log ? Math.log(v / f.min) / Math.log(f.max / f.min) : v);
const fxFrom = (f, v) => (f.log ? Math.round(f.min * (f.max / f.min) ** v) : v);

// number when on, true for switch-only fx, NaN when written in a way a
// slider can't show, null when off
const fxValue = (t, f) => (f.get ? f.get(t) : f.line ? (hasLine(t, `.${f.key}(`) ? true : null) : getParam(t, f.key, f.rest));
// v: null = off
const fxSet = (t, f, v) =>
  f.set ? f.set(t, v) : f.line ? setLine(t, `.${f.key}(`, v == null ? null : f.line) : setParam(t, f.key, v, undefined, f.rest);

function openFx(id, anchor) {
  const t = track(id);
  const rowsEl = FX.map((f) => {
    const line = h('div', 'fx-row');
    const toggle = h('button', 'fx-toggle', f.label);
    toggle.type = 'button';
    toggle.title = f.hint ?? f.label;
    line.append(toggle);
    let slider = null;
    const value = h('span', 'fx-value');
    if (!f.line && !f.toggle) {
      slider = h('input');
      Object.assign(slider, f.log ? { type: 'range', min: 0, max: 1, step: 0.001 } : { type: 'range', min: f.min, max: f.max, step: f.step });
      slider.setAttribute('aria-label', `${id} ${f.label}`);
      line.append(slider);
    }
    line.append(value);

    const show = () => {
      const v = fxValue(track(id), f);
      toggle.classList.toggle('on', v !== null);
      toggle.setAttribute('aria-pressed', v !== null);
      if (slider) {
        slider.disabled = Number.isNaN(v);
        if (document.activeElement !== slider) slider.value = fxTo(f, typeof v === 'number' && !Number.isNaN(v) ? v : f.on);
      }
      value.textContent = Number.isNaN(v) ? (f.why?.(track(id))?.[0] ?? 'in code') : typeof v === 'number' ? `${num(v)}${f.unit ?? ''}` : '';
      if (f.note) toggle.title = f.note(track(id));
    };
    toggle.addEventListener('click', () => {
      const on = fxValue(track(id), f) !== null;
      if (Number.isNaN(fxValue(track(id), f))) {
        return status(f.why ? `${id} · ${f.why(track(id))[1]}` : `${id} · ${f.label} is written as a pattern: change it in the code`);
      }
      let msg = null; // an fx's set() may say what else it changed
      edit(() => (msg = fxSet(track(id), f, on ? null : (f.on ?? true))));
      status(typeof msg === 'string' ? msg : `${id} · ${f.label} ${on ? 'off' : 'on'}`);
      show();
    });
    slider?.addEventListener('input', () => {
      const v = fxFrom(f, Number(slider.value));
      edit(() => fxSet(track(id), f, v), true);
      show();
    });
    show();
    return line;
  });
  const title = h('div', 'fx-title', `${id} · effects`);
  popover(anchor, [title, ...rowsEl], { className: 'fx-panel', label: `${t.id} effects` });
  rowsEl[0].querySelector('.fx-toggle').focus();
}

// ── reorder ───────────────────────────────────────

function startDrag(e, row) {
  if (e.button !== 0) return;
  e.preventDefault();
  // listen on window: moving the row in the DOM drops any pointer capture
  const id = e.pointerId;
  row.classList.add('dragging');
  rack.classList.add('sorting');
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    const before = [...rack.children].find((r) => {
      if (r === row) return false;
      const b = r.getBoundingClientRect();
      return ev.clientY < b.top + b.height / 2;
    });
    if (row.nextElementSibling !== (before ?? null)) rack.insertBefore(row, before ?? null);
  };
  const end = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    row.classList.remove('dragging');
    rack.classList.remove('sorting');
    commitOrder();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function commitOrder() {
  const order = [...rack.children].map((r) => r.dataset.id);
  if (order.join() === tune.tracks.map((t) => t.id).join()) return;
  edit(() => tune.tracks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
}

// ── playhead ──────────────────────────────────────

// `bar`: bars since the pattern started (in song mode, since the section
// started). A row lights its step only when the bar it shows is the one playing.
let current = -1;
let currentBar = -1;
let cycle = null;
let lit = [];
function setPlayhead(i, bar = currentBar) {
  if (i === current && bar === currentBar) return;
  for (const c of lit) c.classList.remove('now');
  lit = [];
  if (i >= 0) {
    for (const t of tune.tracks) {
      const r = rows.get(t.id);
      if (!r || (t.kind !== 'code' && bar % t.bars !== barOf(t))) continue;
      r.cells[i].classList.add('now');
      lit.push(r.cells[i]);
    }
  }
  current = i;
  currentBar = bar;
}
function stopped() {
  setPlayhead(-1, -1);
  cycle = null;
  stage = null;
  section = -1;
  render();
}
(function frame() {
  if (playing) {
    const pos = editor.repl.scheduler.now();
    const c = Math.floor(pos);
    let bar = c;
    if (c !== cycle) {
      cycle = c;
      const s = sectionAt(c);
      if (s) bar = s.bar;
      if ((s?.i ?? -1) !== section) {
        section = s?.i ?? -1;
        stage = s ? new Set(s.ids) : null;
        render();
      }
      if (follow && pages() > 1 && bar % pages() !== page) setPage(bar % pages());
      readCodeRows(follow ? c : page);
      pageBtns.forEach((b, i) => b.classList.toggle('playing', i === bar % pages()));
    } else bar = currentBar;
    setPlayhead(Math.floor((((pos % 1) + 1) % 1) * STEPS), bar);
  }
  rack.classList.toggle('following', playing && follow);
  requestAnimationFrame(frame);
})();

// ── code panel ────────────────────────────────────

// strudel.cc reads a tune from base64 in the URL hash
$('#open').addEventListener('click', () => {
  let bin = '';
  for (const byte of new TextEncoder().encode(forStrudel(editor.code))) bin += String.fromCharCode(byte);
  window.open(`https://strudel.cc/#${encodeURIComponent(btoa(bin))}`, '_blank', 'noopener');
});
$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(editor.code);
    status('code copied');
  } catch {
    status('copy failed: select the code and copy it by hand', true);
  }
});

// ── status line ───────────────────────────────────

const statusEl = $('#status');
let statusTimer;
// action: { label, run } shown as a link after the message, e.g. undo
function status(msg, error = false, action = null) {
  $('#announce').textContent = msg;
  statusEl.replaceChildren(msg);
  if (action) {
    const b = h('button', 'link status-action', action.label);
    b.type = 'button';
    b.addEventListener('click', action.run);
    statusEl.append(' · ', b);
  }
  statusEl.classList.toggle('err', error);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
    statusEl.classList.remove('err');
  }, error || action ? 6000 : 1800);
}

// ? : the tips, [what to do, what it does]
const TIPS = [
  ['click or drag on steps', 'set them'],
  ['right-click a note step, or scroll on it', 'pick the note'],
  ['click a sound', 'change it · right-click it to trim'],
  ['right-click a track name', 'its effects · drag the name to reorder'],
  ['click a slider heading', 'choose what that column shows'],
  ['click a bar, then again', 'stay on it while it plays, then follow · [ ] step bars'],
  ['drop audio files or folders', 'add them to your samples'],
  [`space · ${MOD}+s · ${MOD}+z`, 'play / stop · save · undo'],
];
$('#help').addEventListener('click', (e) => {
  const list = h('ul', 'tips');
  for (const [what, does] of TIPS) {
    const li = h('li');
    li.append(h('b', '', what), ` → ${does}`);
    list.append(li);
  }
  const pop = popover(e.currentTarget, [h('div', 'fx-title', 'tips'), list], { className: 'fx-panel help-panel', label: 'tips' });
  pop.el.tabIndex = -1; // focus inside, so Esc closes it
  pop.el.focus();
});

// ── keys ──────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault(); // anywhere, even in the editor
    saveNow();
    return;
  }
  if (e.target.closest('.cm-editor, input, textarea, select')) return;
  if (mod && e.key.toLowerCase() === 'c' && !getSelection().toString()) {
    e.preventDefault();
    copyBar();
    return;
  }
  if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteBar();
    return;
  }
  if (!mod && (e.key === '[' || e.key === ']')) {
    follow = false;
    setPage(page + (e.key === ']' ? 1 : -1));
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (e.code === 'Space' && !mod && !e.target.closest('.pop')) {
    // a button reached with the keyboard keeps Space for itself
    if (e.target.closest('button')?.matches(':focus-visible')) return;
    e.preventDefault();
    toggle();
  }
});
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);

// MIDI and keyboard mapping (controllers.js)
initControllers({ button: $('#map'), onStatus: status });

renderColumns();
render();

// a tune in the link (#code=<base64>, like strudel.cc's): the learn page's
// "open in StrudelUI". Loads like any open, so undo goes back.
function openFromLink() {
  const m = location.hash.match(/^#code=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const bin = atob(decodeURIComponent(m[1]));
    const src = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    // work that isn't saved anywhere is kept as a named save first
    syncFromCode();
    const unsaved = code !== DEFAULT_TUNE && code !== src && !(savedAs && getTune(savedAs)?.code === code);
    const kept = unsaved ? `${tuneName === 'untitled' ? 'my tune' : tuneName} · ${new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : null;
    if (kept) {
      try {
        saveTune(kept, { code });
      } catch {}
    }
    loadTune(src, { name: 'example', held: true });
    openedStatus(kept ? `opened an example · your tune was saved as "${kept}" (file menu → open saved)` : 'opened an example from the link');
  } catch {
    status("couldn't read the tune in that link", true);
  }
}
openFromLink();
addEventListener('hashchange', openFromLink);
