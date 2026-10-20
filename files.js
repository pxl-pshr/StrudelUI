// Saved tunes. A tune is its code (mutes and solo included), so a save is a
// name and the code.
// Kept in this browser's localStorage; download/open move them as .js files
// (or .zip with their samples).

import { unzip } from './zip.js';

const KEY = 'beats-ui-tunes';

// a prototype-free object, so any name is just a key (even "__proto__")
function all() {
  try {
    return Object.assign(Object.create(null), JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return Object.create(null);
  }
}
function write(tunes) {
  localStorage.setItem(KEY, JSON.stringify(tunes)); // throws when storage is full: callers report it
}

// newest first
export const listTunes = () =>
  Object.entries(all())
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => (b.saved ?? '').localeCompare(a.saved ?? ''));

export const getTune = (name) => all()[name] ?? null;

export function saveTune(name, tune /* { code } */) {
  const tunes = all();
  tunes[name] = { ...tune, saved: new Date().toISOString() };
  write(tunes);
}

export function deleteTune(name) {
  const tunes = all();
  delete tunes[name];
  write(tunes);
}

export const fileName = (name) => `${name.trim().replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'tune'}`;

// pick a tune: .js / .txt / .strudel, a .zip from "download with samples", or
// a MIDI file (midi.js)
export function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.txt,.strudel,.zip,.mid,.midi,text/plain,text/javascript,application/zip,audio/midi,audio/x-midi';
    input.addEventListener('change', () => resolve(input.files[0] ?? null));
    input.click();
  });
}

export const isZip = (file) => /\.zip$/i.test(file.name) || file.type === 'application/zip';
const TUNE = /\.(js|txt|strudel)$/i;
const base = (path) => path.split('/').pop().replace(TUNE, '').replace(/\.(strudel|zip)$/i, '');

// a tune's name: its title line (// name, which saving writes), else the file's
const titled = (code, fallback) => code?.match(/^\/\/ *(\S.*?) *(\r?\n|$)/)?.[1] ?? fallback;

// { name, code, samples: [{ file, path }] }. A zip holds a tune file (the one
// nearest the top) and samples in folders, one per sound (samples/<sound>/…);
// code is null when it has no tune file.
export async function readTuneFile(file) {
  if (!isZip(file)) {
    const code = await file.text();
    return { name: titled(code, base(file.name)), code, samples: [] };
  }
  const entries = await unzip(file);
  const depth = (e) => e.path.split('/').length;
  const tune = entries.filter((e) => TUNE.test(e.path)).sort((a, b) => depth(a) - depth(b))[0];
  const samples = entries.filter((e) => e !== tune).map((e) => ({ file: new File([e.blob], e.path.split('/').pop()), path: e.path }));
  const code = tune ? await tune.blob.text() : null;
  return { name: titled(code, tune ? base(tune.path) : base(file.name)), code, samples };
}
