// Strudel's sound registry as a searchable catalog, auditioning, and user
// samples (dropped files, persisted in IndexedDB).
// soundMap, samples, superdough and getAudioContext are globals Strudel sets up
// for tune code once the editor has prebaked.

const SAMPLE_MAP = 'https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json';
const DRUM_TYPES = new Set(['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'sh', 'tb', 'perc', 'misc', 'fx', 'cb']);
const HIDDEN = new Set(['user', 'one', 'bus']);

// soundMap keys are lowercase; the sample map has the names as written (RolandTR909)
const bankCase = {};
export async function loadBankNames() {
  try {
    const map = await fetch(SAMPLE_MAP).then((r) => r.json());
    for (const key of Object.keys(map)) {
      const cut = key.lastIndexOf('_');
      if (cut > 0) bankCase[key.slice(0, cut).toLowerCase()] = key.slice(0, cut);
    }
  } catch {}
}
export const bankName = (b) => bankCase[b.toLowerCase()] ?? aliasOf()[b.toLowerCase()] ?? b;

// Strudel also registers short aliases (tr808 → RolandTR808) pointing at the
// same files; map them to the full name so each kit is listed once. The alias
// map loads in the background, so the table is rebuilt when sounds change.
let aliases = {};
let aliasesFor = -1; // number of sounds the table was built from
function aliasOf() {
  const map = globalThis.soundMap?.get() ?? {};
  const size = Object.keys(map).length;
  if (size === aliasesFor || !Object.keys(bankCase).length) return aliases;
  aliasesFor = size;
  aliases = {};
  const owner = {}; // first sample url -> full bank name
  for (const [key, e] of Object.entries(map)) {
    const cut = key.lastIndexOf('_');
    if (cut > 0 && bankCase[key.slice(0, cut)] && Array.isArray(e.data?.samples)) owner[e.data.samples[0]] = bankCase[key.slice(0, cut)];
  }
  for (const [key, e] of Object.entries(map)) {
    const cut = key.lastIndexOf('_');
    const bank = key.slice(0, cut);
    if (cut > 0 && !bankCase[bank] && owner[e.data?.samples?.[0]]) aliases[bank] = owner[e.data.samples[0]];
  }
  return aliases;
}
const isAlias = (b) => !bankCase[b] && !!aliasOf()[b];

const userSounds = new Map(); // name -> blob urls of its files

// [{ key, name, bank, group, count }]: drum machine sounds are split into
// bank + name, the way tune code writes them: s("bd").bank("RolandTR909")
export function catalog() {
  const items = [];
  for (const [key, entry] of Object.entries(globalThis.soundMap?.get() ?? {})) {
    const type = entry?.data?.type;
    if (key.startsWith('_') || HIDDEN.has(key) || type === 'input') continue;
    const count = type === 'sample' && Array.isArray(entry.data.samples) ? entry.data.samples.length : 1;
    const cut = key.lastIndexOf('_');
    if (userSounds.has(key)) items.push({ key, name: key, bank: null, group: 'yours', count });
    else if (type === 'sample' && cut > 0 && !key.startsWith('gm_') && DRUM_TYPES.has(key.slice(cut + 1))) {
      if (isAlias(key.slice(0, cut))) continue;
      items.push({ key, name: key.slice(cut + 1), bank: bankName(key.slice(0, cut)), group: 'drum machines', count });
    } else {
      const group = type === 'synth' ? 'synths' : type === 'soundfont' ? 'instruments' : 'samples';
      items.push({ key, name: key, bank: null, group, count });
    }
  }
  return items;
}

export const banks = () => [...new Set(catalog().filter((i) => i.bank).map((i) => i.bank))].sort((a, b) => a.localeCompare(b));
const entryOf = (name, bank) => globalThis.soundMap?.get()[(bank ? `${bank}_${name}` : name).toLowerCase()];
export const hasSound = (name, bank) => !!entryOf(name, bank);
export const isSample = (name, bank) => entryOf(name, bank)?.data?.type === 'sample';
export const countOf = (name, bank) => {
  const e = entryOf(name, bank);
  return e?.data?.type === 'sample' && Array.isArray(e.data.samples) ? e.data.samples.length : 1;
};

// play one hit now; silent: load only, so its first real play isn't dropped.
// params: extra controls for the hit, e.g. { begin, end }
export function audition({ name, n = 0, bank }, note, silent = false, params = {}) {
  const { superdough, getAudioContext } = globalThis;
  if (!superdough) return;
  const ctx = getAudioContext();
  if (!silent && ctx.state !== 'running') ctx.resume();
  const value = { s: name, n, gain: silent ? 0 : 0.8, ...params };
  if (bank) value.bank = bank;
  if (note) value.note = note;
  superdough(value, ctx.currentTime + 0.05, 0.4).catch(() => {});
}

// The decoded file a sample sound plays, through superdough's own lookup
// (getSampleBuffer): same n wrap-around and, for pitched sample maps, the zone
// nearest `note`. Null for synths and soundfonts.
export async function sampleBuffer({ name, n = 0, bank }, note) {
  const entry = entryOf(name, bank);
  if (entry?.data?.type !== 'sample' || !globalThis.getSampleBuffer) return null;
  const value = { s: bank ? `${bank}_${name}` : name, n };
  if (note != null) value.note = note;
  const { buffer } = await globalThis.getSampleBuffer(value, entry.data.samples);
  return buffer;
}

// ── user samples ──────────────────────────────────

const AUDIO = /\.(wav|mp3|ogg|flac|aiff?|m4a|opus|webm)$/i;
const slug = (s) => {
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return !v ? 'sample' : /^\d/.test(v) ? `s_${v}` : v;
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('beats-samples', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sounds', { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('sample storage is busy in another tab'));
  });
}
// one transaction; settles on success, error or abort (a full disk aborts)
async function store(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sounds', mode);
      const req = run(tx.objectStore('sounds'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('storage was full or unavailable'));
    });
  } finally {
    db.close();
  }
}

// built-in sounds a user sound of the same name replaced: deleting the user
// sound puts them back
const shadowed = new Map();

function register(rec) {
  if (!userSounds.has(rec.name)) {
    const builtIn = globalThis.soundMap?.get()[rec.name];
    if (builtIn) shadowed.set(rec.name, builtIn);
  }
  for (const url of userSounds.get(rec.name) ?? []) URL.revokeObjectURL(url);
  const urls = rec.files.map((f) => URL.createObjectURL(f.blob));
  globalThis.samples({ [rec.name]: urls });
  userSounds.set(rec.name, urls);
}

// Puts the user sounds back in front of the built-ins after something registered
// those again (a second Strudel engine's prebake): the same blob URLs, so
// nothing is re-read and `shadowed` still holds the originals.
export function reassertUserSounds() {
  if (userSounds.size) globalThis.samples(Object.fromEntries(userSounds));
}

export async function loadUserSamples() {
  try {
    const all = await store('readonly', (s) => s.getAll());
    all.forEach(register);
  } catch {}
}

// Group files into sounds: files in a folder become that folder's sound (one
// variation each), loose files group by name without the trailing number
// ("Shaker 13.wav" → shaker), numbered alphabetically from 0.
function groupFiles(list /* [{ file, path }] */) {
  const groups = new Map(); // sound name -> [File]
  for (const { file, path } of list) {
    if (!(file.type.startsWith('audio/') || AUDIO.test(file.name))) continue;
    const parts = path.split('/');
    const stem = file.name.replace(/\.[^.]+$/, '');
    const name = slug(parts.length > 1 ? parts.at(-2) : stem.replace(/[\s_-]*\d+$/, '') || stem);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(file);
  }
  return groups;
}

// A tune zip's samples, kept numbered the way the tune uses them (s("name:n")):
// appending them to a user sound of the same name would shift the numbers. A
// user sound with the same files isn't imported again; one with other files,
// or a built-in of that name, stays as it is and the zip's sound goes under
// name_2, name_3, … (the first that's free, or that already holds these files
// from an earlier open): `renames` [[from, to]] for the tune's code. `list` is
// what's left to import.
export async function tuneSamples(list) {
  const groups = groupFiles(list);
  const out = [];
  const renames = [];
  // a user sound's files: stored (also by another tab, or before loadUserSamples
  // ran) or registered for this session only
  const existing = async (name) => {
    const rec = await store('readonly', (s) => s.get(name)).catch(() => null);
    return rec?.files ?? (userSounds.has(name) ? userSoundFiles(name) : null);
  };
  const CHUNK = 1 << 20;
  const equal = async (a, b) => { // two blobs, a chunk at a time, stopping at the first difference
    if (a.size !== b.size) return false;
    for (let at = 0; at < a.size; at += CHUNK) {
      const [x, y] = await Promise.all([a, b].map(async (f) => new Uint8Array(await f.slice(at, at + CHUNK).arrayBuffer())));
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    }
    return true;
  };
  const byName = (a, b) => a.name.localeCompare(b.name);
  const same = async (have, files) => { // same file names with the same bytes
    if (have.length !== files.length) return false;
    const a = [...have].sort(byName);
    const b = [...files].sort(byName);
    if (a.some((f, i) => f.name !== b[i].name || f.blob.size !== b[i].size)) return false;
    for (let i = 0; i < a.length; i++) if (!(await equal(a[i].blob, b[i]))) return false;
    return true;
  };
  for (const [name, files] of groups) {
    let to = name;
    let have = false;
    const mine = await existing(name);
    if (mine || hasSound(name)) {
      have = !!mine && (await same(mine, files));
      for (let i = 2; !have; i++) {
        to = `${name}_${i}`;
        const there = await existing(to);
        if (there) have = await same(there, files);
        else if (!groups.has(to) && !hasSound(to)) break;
      }
      if (to !== name) renames.push([name, to]);
    }
    if (!have) for (const file of files) out.push({ file, path: `${to}/${file.name}` });
  }
  return { list: out, renames, sounds: [...groups.keys()].map((n) => renames.find(([from]) => from === n)?.[1] ?? n) };
}

// Files added to an existing sound are appended (same file name = replaced).
// If IndexedDB fails, the sounds are still registered for this session.
export async function addFiles(list /* [{ file, path }] */) {
  const groups = groupFiles(list);
  const added = [];
  for (const [name, files] of groups) {
    const before = await store('readonly', (s) => s.get(name)).catch(() => null);
    const byName = new Map((before?.files ?? []).map((f) => [f.name, f]));
    for (const f of files) byName.set(f.name, { name: f.name, blob: f });
    // numbered like strudel.cc's "import sounds folder" (plain alphabetical:
    // 10 before 2), so s("name:n") picks the same file there and here
    const rec = { name, files: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    const replaces = !before && !userSounds.has(name) && hasSound(name); // a built-in sound of that name
    const stored = await store('readwrite', (s) => s.put(rec)).then(() => true, () => false);
    register(rec);
    added.push({ name, count: rec.files.length, added: files.length, replaces, stored });
  }
  return added;
}

// deletes the whole sample database (settings → reset everything)
export function deleteAllUserSamples() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('beats-samples');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('sample storage is busy in another tab: close it and try again'));
  });
}

export const userSoundNames = () => [...userSounds.keys()];

// a user sound's files [{ name, blob }], in variation order: from storage, or
// for a sound that couldn't be stored, its registered blobs (named by number)
export async function userSoundFiles(name) {
  const rec = await store('readonly', (s) => s.get(name)).catch(() => null);
  if (rec) return rec.files;
  const blobs = await Promise.all((userSounds.get(name) ?? []).map((u) => fetch(u).then((r) => r.blob())));
  return blobs.map((blob, i) => ({ name: `${String(i).padStart(3, '0')}.${blob.type.split('/')[1] || 'wav'}`, blob }));
}

// Deletes the stored files and the registration, so the sound stops playing
// (or the built-in it replaced plays again). Returns the removed record, so it
// can be put back (undo).
export async function removeUserSound(name) {
  const rec = await store('readonly', (s) => s.get(name)).catch(() => null);
  await store('readwrite', (s) => s.delete(name));
  for (const url of userSounds.get(name) ?? []) URL.revokeObjectURL(url);
  userSounds.delete(name);
  globalThis.soundMap?.setKey(name, shadowed.get(name)); // undefined removes the key
  shadowed.delete(name);
  return rec;
}

export async function restoreUserSound(rec) {
  await store('readwrite', (s) => s.put(rec)).catch(() => {});
  register(rec);
}

// dropped items, walking into folders
export async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) {
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path: dir + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) {
        for (const e of batch) await walk(e, `${dir}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
