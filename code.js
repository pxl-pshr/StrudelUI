// The code is the source of truth: supported track blocks are parsed into grid
// tracks, and grid edits are written back to the code.
//
// Layout the grid understands:
//
//   <preamble, including setcpm(BPM/4)>
//
//   // comments right above a block belong to it (and move with it)
//   const kick = s("bd:3").bank("RolandTR909")      ← hit track
//     .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")
//     .gain(.8)                                     ← one call per line
//
//   const saw = note("~ g1 g0 g1  …").s("sawtooth") ← note track
//     .lpf(150)
//
//   const anything = <other code>                   ← "code" track: shown, not editable
//
//   const intro = stack(kick, saw)                  ← a scene
//   const song = arrange([4, intro], …)             ← the song
//
//   stack(                                          ← the live mix ends a loop
//     kick,                                         ←   plays
//     // saw,                                       ←   muted
//     hats, // solo                                 ←   soloed (others: "// x, // solo")
//   )
//
// In song mode the mix is kept as `const mix = stack(…)` and the tune ends
// with `song`, so switching modes never loses the mix.

export const STEPS = 16;
export const MAX_BARS = 16;
const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const NOTE = /^([a-g])([#b]?)(-?\d)$/;

const isNote = (tok) => NOTE.test(tok);
export function toMidi(n) {
  const [, pc, acc, oct] = n.match(NOTE);
  return (Number(oct) + 1) * 12 + NAMES.indexOf(pc) + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
}
export const fromMidi = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export const IDENT = /^[A-Za-z_$][\w$]*$/;
const NOTE_HEAD = /^note\("([^"]+)"\)(.*)$/;
const STRUCT = /^\.struct\("([^"]+)"\)$/;
const CALL = /^\.\w+\(.*\)\s*(\/\/.*)?$/;
const CONST = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
const SETCPM = /^setcpm\(\s*([\d.]+)\s*\/\s*4\s*\)/;
const MIX_NAME = /^mix\d*$/;

// ── reading code: what's code, what's a string or a comment ─────

// [[text, isCode], …]: strings and comments are not code
function pieces(text) {
  const out = [];
  let start = 0;
  let i = 0;
  const cut = (end, code) => {
    if (end > start) out.push([text.slice(start, end), code]);
    start = end;
  };
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      cut(i, true);
      const e = d === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      i = e === -1 ? text.length : d === '/' ? e : e + 2;
      cut(i, false);
    } else if (c === '"' || c === "'" || c === '`') {
      cut(i, true);
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      i = Math.min(j + 1, text.length);
      cut(i, false);
    } else i++;
  }
  cut(text.length, true);
  return out;
}

const word = (id) => new RegExp(`(?<![\\w$.])${id.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');

// Swap an identifier in code only: not in strings, comments or property
// access (`kick.fast(2)` → `drums.fast(2)`, but not "kick", // kick, or .kick)
function renameIdent(text, from, to) {
  return pieces(text)
    .map(([s, code]) => (code ? s.replace(word(from), to) : s))
    .join('');
}

const mentions = (text, id) => pieces(text).some(([s, code]) => code && word(id).test(s));

// paren depth at each character, strings skipped
function depths(line) {
  const out = [];
  let depth = 0;
  for (const [s, code] of pieces(line)) {
    for (const ch of s) {
      if (code && ch === ')') depth--;
      out.push(depth);
      if (code && ch === '(') depth++;
    }
  }
  return out;
}

// first match of `re` that sits at the top level of the line (not inside
// another call's parentheses, like a superimpose(…) layer)
function topMatch(line, re) {
  const d = depths(line);
  for (const m of line.matchAll(new RegExp(re.source, 'g'))) if (!d[m.index]) return m;
  return null;
}

// trailing // comment of a line (outside strings), kept when a line is rewritten
function trailingComment(line) {
  const comment = pieces(line).find(([s, code]) => !code && s.startsWith('//'));
  return comment ? comment[0] : '';
}

// one above every .orbit(n) in the code, and above 1, which every sound without
// .orbit() plays on. superdough keeps one reverb and one delay per orbit and
// rebuilds them whenever a hit brings different settings, so a track sharing
// an orbit loses its room to the others' roomsize
export function freeOrbit(code) {
  let max = 1;
  for (const [s, isCode] of pieces(code)) {
    if (!isCode) continue;
    for (const m of s.matchAll(/\.orbit\(\s*(\d+)\s*\)/g)) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ── sounds named in the code (download with samples, opening tune zips) ──

const escId = (name) => name.replace(/[$]/g, '\\$');
// a sound or identifier as a whole word (mini-notation separators around it)
const wordIn = (name, flags = '') => new RegExp(`(^|[^\\w$])${escId(name)}(?![\\w$])`, flags);
const plain = (t) => /^["'`]/.test(t) && !(t[0] === '`' && t.includes('${'));

// The string pieces given to calls matching `call` (a regex source ending at
// the name, e.g. "\\.bank"): directly, s("pack"), or through a constant,
// const k = "pack"; s(k). `soleUse`: follow a constant only when every use of
// it is such a call (renaming it can't change anything else). `dynamic`: some
// argument is anything else (an expression, a parameter, a template with ${…}).
function argStrings(parts, call, soleUse) {
  const comment = (i) => !parts[i][1] && /^\/[/*]/.test(parts[i][0]);
  const next = (i) => { // the piece after parts[i], skipping comments
    let j = i + 1;
    while (j < parts.length && comment(j)) j++;
    return j;
  };
  const isPlain = (i) => i < parts.length && !parts[i][1] && plain(parts[i][0]);
  // every identifier use counts, inside ${…} of templates too
  const all = parts.map(([t, isCode]) => (isCode || t[0] === '`' ? t : '')).join('\n');
  const count = (re) => [...all.matchAll(re)].length;
  const consts = new Map(); // name -> index of its string piece
  parts.forEach(([t, isCode], i) => {
    const m = isCode && t.match(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
    const at = next(i);
    if (!m || !isPlain(at) || !/^\s*(;|\n|$)/.test(parts[next(at)]?.[0] ?? '')) return;
    const id = escId(m[1]);
    const uses = count(new RegExp(`(?<![\\w$.])${id}(?![\\w$])`, 'g')) - 1;
    if (!soleUse || uses === count(new RegExp(`${call}\\s*\\(\\s*${id}\\s*\\)`, 'g'))) consts.set(m[1], at);
  });
  const found = new Set();
  let dynamic = false;
  parts.forEach(([t, isCode], i) => {
    if (!isCode) return;
    for (const m of t.matchAll(new RegExp(`${call}\\s*\\(\\s*`, 'g'))) {
      const rest = t.slice(m.index + m[0].length);
      const name = rest.match(/^([A-Za-z_$][\w$]*)\s*\)/)?.[1];
      const at = next(i);
      if (!rest && isPlain(at) && /^\s*\)/.test(parts[next(at)]?.[0] ?? '')) found.add(at);
      else if (name && consts.has(name)) found.add(consts.get(name));
      else dynamic = true;
    }
  });
  return { found, dynamic };
}
const SOUND_CALL = '(?<![\\w$])(?:s|sound)';
const BANK_ARG = '\\.bank';

// which of `names` the code uses as sounds: as a word inside a string
// (s("shaker:2"), "bd [shaker hh]"), or as bank_sound when a .bank() argument
// names the bank (s("hh").bank("mykit") → mykit_hh). Like Strudel, ignores
// case. A mention in a comment counts too.
export function soundsIn(code, names) {
  const parts = pieces(code);
  const text = parts.filter(([, isCode]) => !isCode).map(([t]) => t).join('\n');
  const banks = [...argStrings(parts, BANK_ARG, false).found].flatMap((i) => parts[i][0].slice(1, -1).toLowerCase().match(/[\w$]+/g) ?? []);
  return names.filter((n) => wordIn(n, 'i').test(text) || banks.some((b) => n.startsWith(`${b}_`) && wordIn(n.slice(b.length + 1), 'i').test(text)));
}

// Renames sounds ({ from: to }, lowercase) in the strings argStrings finds for
// s(…) / sound(…), mini-notation included ("<pack:2 hh>" → "<pack_2:2 hh>"),
// ignoring case. Skipped: strings in a chain with .bank(…) (the sound there is
// bank_name), other strings (.scale("C3:minor"), notes, URLs) and comments.
// One pass, so a rename never applies to another rename's result. The caller
// checks the result by evaluating both (app.js renameHolds).
export function renameSounds(code, renames) {
  const names = Object.keys(renames).sort((a, b) => b.length - a.length);
  if (!names.length) return code;
  const any = new RegExp(`(^|[^\\w$])(${names.map(escId).join('|')})(?![\\w$])`, 'gi');
  const parts = pieces(code);
  const { found } = argStrings(parts, SOUND_CALL, true);
  const starts = parts.reduce((acc, [t]) => [...acc, acc.at(-1) + t.length], [0]);
  // the statement around a position: its lines, plus the .method lines chained
  // onto it (comment lines between them included)
  const chained = /^\s*(\.|\/\/)/;
  const lineAt = (i) => code.slice(i, code.indexOf('\n', i) + 1 || undefined);
  const statement = (at) => {
    let from = code.lastIndexOf('\n', at - 1) + 1;
    while (from > 0 && chained.test(lineAt(from))) from = from < 2 ? 0 : code.lastIndexOf('\n', from - 2) + 1;
    let to = code.indexOf('\n', at);
    while (to !== -1 && chained.test(lineAt(to + 1))) to = code.indexOf('\n', to + 1);
    return code.slice(from, to === -1 ? undefined : to);
  };
  return parts.map(([t], i) => {
    if (!found.has(i) || /\.bank\s*\(/.test(statement(starts[i]))) return t;
    return t.replace(any, (m, pre, name) => pre + (renames[name.toLowerCase()] ?? name));
  }).join('');
}

// names declared anywhere in the code (for picking names that won't clash)
export function declared(code) {
  const names = new Set();
  for (const [s, isCode] of pieces(code)) {
    if (!isCode) continue;
    for (const m of s.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  }
  return names;
}

// ── parse ─────────────────────────────────────────

// One bar the grid can show: plain tokens, optionally wrapped as "[…]" or
// "[…]*k", whose count divides 16 ("[x x]*8" = 16ths, "[x x]*4" = 8ths).
function readBar(pat, kind) {
  const m = pat.trim().match(/^\[([^[\]<>]*)\](?:\*(\d+))?$/) ?? [null, pat, '1'];
  const once = m[1].trim().split(/\s+/);
  const toks = Array.from({ length: Number(m[2] ?? 1) }, () => once).flat();
  if (STEPS % toks.length !== 0) return null;
  const every = STEPS / toks.length;
  const steps = Array(STEPS).fill(null);
  for (const [k, t] of toks.entries()) {
    if (t === '~' || t === '-') continue;
    if (kind === 'hit' && t === 'x') steps[k * every] = true;
    else if (kind === 'note' && isNote(t)) steps[k * every] = t;
    else return null;
  }
  return steps;
}

// split "a [b c] [d]*2" at the top level only
function topLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s.trim()) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// Several bars are written "<[bar 1] [bar 2] …>": Strudel plays one per cycle,
// and a cycle is a bar here (setcpm(bpm/4)). Returns { steps, bars } or null.
function readSteps(pat, kind) {
  const many = pat.trim().match(/^<(.*)>$/);
  const bars = many ? topLevel(many[1]).map((b) => readBar(b, kind)) : [readBar(pat, kind)];
  if (!bars.length || bars.length > MAX_BARS || bars.some((b) => !b)) return null;
  return { steps: bars.flat(), bars: bars.length };
}

// Turn one `const id = …` block into a track. Editable when its steps live in
// one place: a `.struct("…")` line (hit) or a leading `note("…")` (note).
// Everything else in the block is kept as written.
function readTrack(id, first, rest) {
  const chain = rest.map((l) => l.trim());
  const code = { id, kind: 'code', raw: [first, ...rest].join('\n') };
  if (!chain.every((l) => CALL.test(l))) return code;

  const note = first.match(NOTE_HEAD);
  if (note) {
    const read = readSteps(note[1], 'note');
    return read ? { id, kind: 'note', pat: note[1], rest: note[2], ...read, chain } : code;
  }
  const structs = chain.flatMap((l, i) => (STRUCT.test(l) ? [i] : []));
  if (structs.length !== 1) return code;
  const pat = chain[structs[0]].match(STRUCT)[1];
  const read = readSteps(pat, 'hit');
  return read ? { id, kind: 'hit', head: first, structAt: structs[0], pat, ...read, chain } : code;
}

// Change a track's length: longer repeats its bars, shorter drops the last ones.
export function setBars(t, n) {
  const bars = Array.from({ length: t.bars }, (_, b) => t.steps.slice(b * STEPS, (b + 1) * STEPS));
  t.steps = Array.from({ length: n }, (_, b) => bars[b % t.bars]).flat();
  t.bars = n;
  t.pat = null;
}

// lines that continue a block: blank, indented, or a chained/closing line
const isBlockLine = (l) => l === '' || /^\s/.test(l) || /^[.)\]}]/.test(l);

// A track that makes sound (and belongs in the mix), as opposed to a helper
// value like `const scale = "C:minor"` or a function.
const playable = (t) =>
  t.kind !== 'code' || !/^\s*(["'`\d[{(]|function\b|async\b|class\b|[\w$]+\s*=>)/.test(t.raw);

// Scenes and the song are blocks too, recognised by shape:
//   const intro = stack(kick, hats)          ← a scene: one line, only track names
//   const song = arrange(                    ← the song: [bars, scene] lines
//     [4, intro],
//   )
const SCENE = /^stack\(\s*((?:[A-Za-z_$][\w$]*\s*,\s*)*[A-Za-z_$][\w$]*)?\s*,?\s*\)\s*$/;
const ENTRY = /^\[\s*(\d+)\s*,\s*([A-Za-z_$][\w$]*)\s*\],?$/;

function readArrangement(tune) {
  const looksLikeScene = (t) => t.kind === 'code' && !t.raw.includes('\n') && SCENE.test(t.raw);
  const playing = new Set(tune.tracks.filter((t) => !looksLikeScene(t)).map((t) => t.id));
  tune.scenes = [];
  for (const t of tune.tracks.filter(looksLikeScene)) {
    const ids = (t.raw.match(SCENE)[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.every((id) => playing.has(id))) tune.scenes.push({ id: t.id, ids, lead: t.lead });
  }
  const sceneIds = new Set(tune.scenes.map((s) => s.id));
  tune.song = null;
  for (const t of tune.tracks) {
    if (t.kind !== 'code' || tune.song) continue;
    const lines = t.raw.split('\n').map((l) => l.trim());
    if (lines[0] !== 'arrange(' || lines.at(-1) !== ')') continue;
    const entries = lines.slice(1, -1).map((l) => l.match(ENTRY));
    if (entries.every((m) => m && sceneIds.has(m[2]))) {
      tune.song = { id: t.id, entries: entries.map((m) => ({ bars: Number(m[1]), scene: m[2] })), lead: t.lead };
    }
  }
  // code written below the scenes/song stays below them (it may use them)
  let below = false;
  for (const t of tune.tracks) {
    if (sceneIds.has(t.id) || t.id === tune.song?.id) below = true;
    else if (below) t.late = true;
  }
  tune.tracks = tune.tracks.filter((t) => !sceneIds.has(t.id) && t.id !== tune.song?.id);
}

// The mix: one line per track, plus anything else (kept as written).
//   kick,            plays          // kick,          muted
//   kick, // solo    soloed         // kick, // solo  silenced only by the solo
const ENTRY_LINE = /^(\/\/\s*)?([A-Za-z_$][\w$]*)\s*,?\s*(?:\/\/\s*(.*))?$/;

function readMix(tune, id, body, tail) {
  const byId = new Map(tune.tracks.map((t) => [t.id, t]));
  tune.mix = { id, other: [], tail };
  for (const l of body) {
    const e = l.trim().match(ENTRY_LINE);
    const t = e && byId.get(e[2]);
    if (t) {
      const marks = (e[3] ?? '').trim();
      const solo = /^solo\b/.test(marks);
      t.listed = true;
      t.mixNote = marks.replace(/^solo\b\s*(\/\/\s*)?/, '');
      t.solo = !e[1] && solo;
      t.mute = !!e[1] && !solo;
    } else if (l.trim()) {
      tune.mix.other.push(l);
      for (const tr of tune.tracks) if (mentions(l, tr.id)) tr.inMixCode = true;
    }
  }
  // a playable track the mix doesn't list plays nowhere: show it muted
  for (const t of tune.tracks) if (!t.listed && !t.inMixCode && playable(t)) t.mute = true;
}

export function parse(src) {
  const code = src.replace(/\r\n?/g, '\n');
  const lines = code.split('\n');
  const tune = { bpm: null, preamble: [], tracks: [], scenes: [], song: null, extra: [], mix: null, mode: 'none' };
  // char offset of each line, to map Strudel's source locations back to tracks
  const offsets = [];
  lines.reduce((o, l, i) => ((offsets[i] = o), o + l.length + 1), 0);

  let i = 0;
  let lead = [];
  const firstConst = lines.findIndex((l) => CONST.test(l));
  const stackAt = lines.findIndex((l, k) => k >= Math.max(firstConst, 0) && /^stack\(\s*$/.test(l));

  const end = stackAt === -1 ? lines.length : stackAt;
  if (firstConst === -1) {
    tune.preamble = lines.slice(0, end);
    i = end;
  } else {
    // the preamble ends at its last line of code; comments after that
    // belong to the first block, like comments above any other block
    let last = firstConst - 1;
    while (last >= 0 && (lines[last].trim() === '' || lines[last].trim().startsWith('//'))) last--;
    const codeAt = lines.slice(0, firstConst).findIndex((l) => l.trim() && !l.trim().startsWith('//'));
    const cut = codeAt === -1 ? 0 : last + 1;
    tune.preamble = lines.slice(0, cut);
    i = cut;
  }
  while (tune.preamble.length && tune.preamble.at(-1).trim() === '') tune.preamble.pop();
  const bpmLine = tune.preamble.find((l) => SETCPM.test(l));
  if (bpmLine) tune.bpm = Number(bpmLine.match(SETCPM)[1]);

  while (i < end) {
    const m = lines[i].match(CONST);
    if (!m) {
      // keep blank lines inside the lead: they separate a section header from
      // the comment that belongs to the block
      if (lead.length || lines[i].trim() !== '') lead.push(lines[i]);
      i++;
      continue;
    }
    const start = i;
    const rest = [];
    i++;
    while (i < end && isBlockLine(lines[i])) rest.push(lines[i++]);
    while (rest.length && rest.at(-1).trim() === '') rest.pop();
    const track = readTrack(m[1], m[2], rest);
    Object.assign(track, { lead, mute: false, solo: false, listed: false, mixNote: '' });
    track.range = [offsets[start], offsets[start + rest.length] + lines[start + rest.length].length];
    tune.tracks.push(track);
    lead = [];
  }
  while (lead.length && lead.at(-1).trim() === '') lead.pop();
  tune.extra = lead;

  // song mode keeps the mix as `const mix = stack(…)`
  const kept = stackAt === -1 && tune.tracks.find((t) => MIX_NAME.test(t.id) && t.kind === 'code' && /^stack\(\s*\n/.test(t.raw));
  if (kept) tune.tracks = tune.tracks.filter((t) => t !== kept);
  readArrangement(tune);

  // the tune ends with the live mix, stack(…), or with the song's name
  const lastCode = tune.extra.findLastIndex((l) => l.trim() && !l.trim().startsWith('//'));
  if (tune.song && stackAt === -1 && tune.extra[lastCode]?.trim() === tune.song.id) {
    tune.mode = 'song';
    tune.extra.splice(lastCode, 1);
    while (tune.extra.length && tune.extra.at(-1).trim() === '') tune.extra.pop();
  }

  if (stackAt !== -1) {
    const close = lines.findIndex((l, k) => k > stackAt && l.startsWith(')'));
    if (close !== -1) {
      const tail = [lines[close].slice(1), ...lines.slice(close + 1)];
      while (tail.length > 1 && tail.at(-1).trim() === '') tail.pop();
      readMix(tune, null, lines.slice(stackAt + 1, close), tail);
      tune.mode = 'loop';
    } else {
      tune.extra.push(...lines.slice(stackAt));
    }
  } else if (kept) {
    const raw = kept.raw.split('\n');
    const close = raw.findIndex((l, k) => k > 0 && l.startsWith(')'));
    readMix(tune, kept.id, raw.slice(1, close), [raw[close].slice(1), ...raw.slice(close + 1)]);
    if (tune.mode !== 'song') tune.mode = 'none';
  }
  return tune;
}

// every const name the tune manages: tracks, scenes, the song, the kept mix
export const allIds = (tune) => [
  ...tune.tracks.map((t) => t.id),
  ...tune.scenes.map((s) => s.id),
  ...(tune.song ? [tune.song.id] : []),
  ...(tune.mix?.id ? [tune.mix.id] : []),
];

const freeIn = (taken, base) => {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
};

// switch between the live mix and the song (the mix is kept either way)
export function setMode(tune, mode, taken = new Set()) {
  if (!tune.mix) tune.mix = { id: null, other: [], tail: [''] };
  if (mode === 'song' && !tune.mix.id) tune.mix.id = freeIn(new Set([...allIds(tune), ...taken]), 'mix');
  if (mode === 'loop') tune.mix.id = null;
  tune.mode = mode;
}

// ── params: numeric `.name(value)` lines in a track's chain ─────

// rest: fixed trailing arguments, digits only (swingBy(x, 8): rest '8')
const paramLine = (name, rest = '') =>
  new RegExp(`^\\.${name}\\(\\s*(-?[\\d.]+)\\s*${rest ? `,\\s*${rest}\\s*` : ''}\\)\\s*(\\/\\/.*)?$`);

// number, null when absent, NaN when set to something the slider can't show
export function getParam(t, name, rest = '') {
  const line = t.chain.find((l) => l.startsWith(`.${name}(`));
  if (!line) return null;
  const m = line.match(paramLine(name, rest));
  return m ? Number(m[1]) : NaN;
}

export const hasLine = (t, prefix) => t.chain.some((l) => l.startsWith(prefix));

// replace the chain line starting with `prefix` (keeping its // comment), add
// it before the first line starting with `before` (else before .orbit(), else
// at the end), or remove it (line = null)
export function setLine(t, prefix, line, before) {
  const at = t.chain.findIndex((l) => l.startsWith(prefix));
  if (line == null) {
    if (at !== -1) t.chain.splice(at, 1);
  } else if (at !== -1) {
    const note = trailingComment(t.chain[at]);
    t.chain[at] = note ? `${line} ${note}` : line;
  } else {
    const find = (p) => (p ? t.chain.findIndex((l) => l.startsWith(p)) : -1);
    const to = [find(before), find('.orbit(')].find((i) => i !== -1) ?? t.chain.length;
    t.chain.splice(to, 0, line);
  }
  if (t.kind === 'hit') t.structAt = t.chain.findIndex((l) => STRUCT.test(l));
}

export const setParam = (t, name, value, before, rest = '') =>
  setLine(t, `.${name}(`, value == null ? null : `.${name}(${num(value)}${rest ? `, ${rest}` : ''})`, before);

// trim: .begin / .end at 3 decimals, the trim panel's resolution (its smallest
// gap is .005, which 2 decimals would round away); NaN leaves a point alone,
// 0 / 1 remove the line, .begin goes above .end
export function setTrim(t, begin, end) {
  if (!Number.isNaN(begin)) setLine(t, '.begin(', begin > 0 ? `.begin(${numAt(begin, 3)})` : null, '.end(');
  if (!Number.isNaN(end)) setLine(t, '.end(', end < 1 ? `.end(${numAt(end, 3)})` : null);
}

// ── sound: s("name:n") / .sound(…), .bank("…"), .n(i) ─────
// Only calls at the top level of a line count, so a layer inside
// .superimpose(x => x.s("ht").n(4)) keeps its own sound.

const S_CALL = /(^|\.)(s|sound)\("([^"]*)"\)/;
const BANK_CALL = /\.bank\("([^"]*)"\)/;
const N_CALL = /\.n\((\d+)\)/;
const PLAIN_SOUND = /^([A-Za-z0-9_.-]+?)(?::(\d+))?$/;

// head line (hit: whole head, note: what follows note("…")) + chain lines
const soundLines = (t) => [t.kind === 'hit' ? t.head : t.rest, ...t.chain];

// [line index, match] of the first top-level match
function findTop(lines, re) {
  for (const [i, l] of lines.entries()) {
    const m = topMatch(l, re);
    if (m) return [i, m];
  }
  return [-1, null];
}
const replaceAt = (line, m, text) => line.slice(0, m.index) + text + line.slice(m.index + m[0].length);

// { name, n, bank } or null when the track has no plain s("…") to pick for
export function getSound(t) {
  if (t.kind === 'code') return null;
  const lines = soundLines(t);
  const [, s] = findTop(lines, S_CALL);
  const plain = s?.[3].match(PLAIN_SOUND);
  if (!plain) return null;
  const [, n] = findTop(lines, N_CALL);
  const [, bank] = findTop(lines, BANK_CALL);
  return { name: plain[1], n: Number(plain[2] ?? n?.[1] ?? 0), bank: bank?.[1] ?? null };
}

// Change the sound where it's written: the s("…") call keeps its spot, a
// separate .n(i) stays separate, .bank is added next to s("…") or removed.
export function setSound(t, { name, n = 0, bank = null }) {
  const lines = soundLines(t);
  const [ni, nm] = findTop(lines, N_CALL);
  if (nm) lines[ni] = replaceAt(lines[ni], nm, `.n(${n})`);
  const [si, sm] = findTop(lines, S_CALL);
  if (!sm) return;
  const value = nm || !n ? name : `${name}:${n}`;
  lines[si] = replaceAt(lines[si], sm, `${sm[1]}${sm[2]}("${value}")`);

  const [bi, bm] = findTop(lines, BANK_CALL);
  if (bank && bm) lines[bi] = replaceAt(lines[bi], bm, `.bank("${bank}")`);
  else if (bank) {
    const [, s2] = findTop([lines[si]], S_CALL);
    lines[si] = replaceAt(lines[si], s2, `${s2[0]}.bank("${bank}")`);
  } else if (bm) lines[bi] = replaceAt(lines[bi], bm, '');

  if (t.kind === 'hit') t.head = lines[0];
  else t.rest = lines[0];
  t.chain = lines.slice(1).filter((l) => l.trim() !== '');
  if (t.kind === 'hit') t.structAt = t.chain.findIndex((l) => STRUCT.test(l));
}

// sidechain "pump": the track with .duckdepth("a:b:c"); a is the main depth
export function getPump(tune) {
  for (const t of tune.tracks) {
    if (t.kind === 'code') continue;
    const line = t.chain.find((l) => l.startsWith('.duckdepth('));
    const m = line?.match(/^\.duckdepth\("([\d.:]+)"\)/);
    if (m) return { track: t, depths: m[1].split(':').map(Number) };
  }
  return null;
}

export function setPump(tune, value) {
  const p = getPump(tune);
  if (!p) return;
  const [main, ...others] = p.depths;
  // keep the balance between ducked orbits
  const scaled = main > 0 ? p.depths.map((d) => (d * value) / main) : [value, ...others.map(() => value)];
  setLine(p.track, '.duckdepth(', `.duckdepth("${scaled.map(num).join(':')}")`);
}

// Per-track pump. Ducking is per orbit: the source track (the kick) lists
// the orbits it ducks and how far, .duckorbit("2:4:5") .duckdepth(".52:.17:.43")
// .duckattack("…"), so a track's pump is its orbit's entry there, shared
// with every track on that orbit.

// a track's orbit: 1 without .orbit() (superdough's default), null when it's
// written as a pattern
export const orbitOf = (t) => {
  const line = t.chain.find((l) => l.startsWith('.orbit('));
  if (!line) return 1;
  const m = line.match(/^\.orbit\(\s*(\d+)\s*\)/);
  return m ? Number(m[1]) : null;
};
const DUCK = ['orbit', 'depth', 'attack'];
const duckList = (t, k) => {
  const line = t.chain.find((l) => l.startsWith(`.duck${k}(`));
  if (!line) return null;
  const m = line.match(new RegExp(`^\\.duck${k}\\(\\s*"?([\\d.:]+)"?\\s*\\)\\s*(\\/\\/.*)?$`));
  return m ? m[1].split(':').map(Number) : NaN;
};
const isKick = (t) => t.kind === 'hit' && /^(bd|kick)/i.test(getSound(t)?.name ?? '');
const duckSource = (tune) =>
  tune.tracks.find((t) => t.kind !== 'code' && hasLine(t, '.duckorbit(')) ?? tune.tracks.find(isKick) ?? null;

// { depth, orbit, source, shared } (depth 0: not ducked; shared: the other
// tracks on that orbit, the source included), or { why } when it can't be
// set: 'source' (this track drives it), 'none' (no kick to drive it), 'orbit'
// (.orbit() written as a pattern), 'code' (duck lists written as patterns)
export function getTrackPump(tune, t) {
  const source = duckSource(tune);
  if (!source) return { why: 'none' };
  if (source === t) return { why: 'source' };
  const orbit = orbitOf(t);
  if (orbit == null) return { why: 'orbit' };
  const [orbits, depths] = [duckList(source, 'orbit') ?? [], duckList(source, 'depth') ?? []];
  if (Number.isNaN(orbits) || Number.isNaN(depths)) return { why: 'code' };
  const i = orbits.indexOf(orbit);
  const shared = tune.tracks.filter((x) => x !== t && x.kind !== 'code' && orbitOf(x) === orbit).map((x) => x.id);
  return { depth: i === -1 ? 0 : (depths[i] ?? depths.at(-1) ?? 1), orbit, source, shared };
}

// depth 0 (or null) takes the orbit out of the lists
export function setTrackPump(tune, t, depth) {
  const p = getTrackPump(tune, t);
  if (p.why) return;
  const lists = Object.fromEntries(DUCK.map((k) => [k, duckList(p.source, k)]));
  if (DUCK.some((k) => Number.isNaN(lists[k]))) return;
  const orbits = lists.orbit ?? [];
  const n = orbits.length;
  // a shorter list repeats its last value: spell it out before editing
  const full = (list, fill) => Array.from({ length: n }, (_, j) => list?.[j] ?? list?.at(-1) ?? fill);
  const depths = full(lists.depth, 1);
  const attacks = lists.attack ? full(lists.attack, 0.1) : null;
  const i = orbits.indexOf(p.orbit);
  if (!depth) {
    if (i === -1) return;
    for (const list of [orbits, depths, attacks]) list?.splice(i, 1);
  } else if (i === -1) {
    orbits.push(p.orbit);
    depths.push(depth);
    attacks?.push(attacks.at(-1) ?? 0.1);
  } else depths[i] = depth;
  const write = (k, list) => setLine(p.source, `.duck${k}(`, list?.length ? `.duck${k}("${list.map(num).join(':')}")` : null);
  write('orbit', orbits);
  write('depth', orbits.length ? depths : null);
  if (lists.attack || !orbits.length) write('attack', orbits.length ? attacks : null);
}

// Pump on / off for one track, at the pump's main depth (the header's
// amount). A track sharing its orbit first moves to an orbit of its own, so
// the switch changes this track only (and its room stops being shared).
// Returns the new orbit when it moved.
export function pumpTrack(tune, t, on) {
  const p = getTrackPump(tune, t);
  if (p.why) return null;
  const moved = p.shared.length ? freeOrbit(generate(tune)) : null;
  if (moved) setParam(t, 'orbit', moved);
  const main = duckList(p.source, 'depth')?.[0];
  setTrackPump(tune, t, on ? (main > 0 ? main : 0.4) : 0);
  return moved;
}

// ── tracks: add, duplicate, rename, delete ────────
// (rename works for any const: a track, a scene or the song)

// a track from one `const id = …` block of code
export function blockToTrack(src) {
  const t = parse(src).tracks[0];
  t.lead = [];
  return t;
}

export function addTrack(tune, t, after = null) {
  const at = after ? tune.tracks.findIndex((x) => x.id === after) + 1 : tune.tracks.length;
  tune.tracks.splice(at, 0, t);
}

export function duplicateTrack(tune, id, newId) {
  const t = tune.tracks.find((x) => x.id === id);
  const copy = structuredClone({ ...t, range: undefined });
  Object.assign(copy, { id: newId, lead: [], solo: false, listed: false, inMixCode: false, mixNote: '' });
  addTrack(tune, copy, id);
  return copy;
}

// A deleted block takes the comment right above it along; anything above a
// blank line (a section header) moves to the next block.
const header = (lead) => lead.slice(0, lead.findLastIndex((l) => l.trim() === '') + 1);

export function removeTrack(tune, id) {
  const i = tune.tracks.findIndex((x) => x.id === id);
  const [t] = tune.tracks.splice(i, 1);
  const h = header(t.lead);
  if (h.length) (tune.tracks[i]?.lead ?? tune.extra).unshift(...h);
  for (const sc of tune.scenes) sc.ids = sc.ids.filter((x) => x !== id);
}

// where the code still uses a name (to warn before it breaks): track ids,
// 'mix' or 'code'
export function references(tune, id) {
  const where = [];
  for (const t of tune.tracks) {
    if (t.id === id) continue;
    const text = t.kind === 'code' ? t.raw : [t.kind === 'hit' ? t.head : t.rest, ...t.chain].join('\n');
    if (mentions(text, id)) where.push(t.id);
  }
  if (tune.mix && [...tune.mix.other, ...tune.mix.tail].some((l) => mentions(l, id))) where.push('mix');
  if ([...tune.preamble, ...tune.extra].some((l) => mentions(l, id))) where.push('code');
  return where;
}

export function renameTrack(tune, from, to) {
  const swap = (s) => renameIdent(s, from, to);
  for (const t of tune.tracks) {
    if (t.id === from) t.id = to;
    if (t.kind === 'code') t.raw = swap(t.raw);
    else {
      t.chain = t.chain.map(swap);
      if (t.kind === 'hit') t.head = swap(t.head);
      else t.rest = swap(t.rest);
    }
  }
  for (const sc of tune.scenes) {
    if (sc.id === from) sc.id = to;
    sc.ids = sc.ids.map((x) => (x === from ? to : x));
  }
  if (tune.song) {
    if (tune.song.id === from) tune.song.id = to;
    for (const e of tune.song.entries) if (e.scene === from) e.scene = to;
  }
  tune.extra = tune.extra.map(swap);
  if (tune.mix) {
    tune.mix.other = tune.mix.other.map(swap);
    tune.mix.tail = tune.mix.tail.map(swap);
  }
}

// a number as tune code writes it: 2 decimals, no leading 0 (numAt: other
// precision; num takes one argument, so .map(num) is safe)
export const num = (v) => numAt(v, 2);
export function numAt(v, places) {
  const k = 10 ** places;
  const s = String(Math.round(v * k) / k);
  return s.startsWith('0.') ? s.slice(1) : s.startsWith('-0.') ? '-' + s.slice(2) : s;
}

// ── generate ──────────────────────────────────────

function miniBar(steps, kind) {
  const tok = steps.map((v) => (v ? (kind === 'note' ? v : 'x') : '~'));
  const beats = [];
  for (let i = 0; i < tok.length; i += 4) beats.push(tok.slice(i, i + 4).join(' '));
  return beats.join('  ');
}

function mini(steps, kind) {
  const bars = [];
  for (let i = 0; i < steps.length; i += STEPS) bars.push(miniBar(steps.slice(i, i + STEPS), kind));
  return bars.length === 1 ? bars[0] : `<${bars.map((b) => `[${b}]`).join(' ')}>`;
}

// t.pat holds the pattern as written; the app clears it when steps change,
// so untouched tracks keep their own notation
function trackCode(t) {
  if (t.kind === 'code') return `const ${t.id} = ${t.raw}`;
  const pat = t.pat ?? mini(t.steps, t.kind);
  const head = t.kind === 'hit' ? t.head : `note("${pat}")${t.rest}`;
  const chain = t.kind === 'hit' ? t.chain.map((l, i) => (i === t.structAt ? `.struct("${pat}")` : l)) : t.chain;
  return [`const ${t.id} = ${head}`, ...chain.map((l) => '  ' + l)].join('\n');
}

export const soloing = (tune) => tune.tracks.some((t) => t.solo);
export const audible = (tune, t) => (soloing(tune) ? t.solo : !t.mute);

function mixLines(tune) {
  const solo = soloing(tune);
  const lines = [];
  for (const t of tune.tracks) {
    if (!t.listed && (t.inMixCode || !playable(t))) continue; // plays from the mix's own code, or isn't sound
    const marks = [solo && (t.solo || !t.mute) ? 'solo' : '', t.mixNote].filter(Boolean).join(' // ');
    lines.push(`  ${audible(tune, t) ? '' : '// '}${t.id},${marks ? ` // ${marks}` : ''}`);
  }
  return [...lines, ...tune.mix.other];
}

export function generate(tune) {
  const pre = [...tune.preamble];
  const bpm = `setcpm(${num(tune.bpm)}/4)`;
  const at = pre.findIndex((l) => SETCPM.test(l));
  if (at !== -1) pre[at] = pre[at].replace(SETCPM, bpm);
  else if (tune.bpm != null) pre.push(bpm);

  const out = pre.length ? [...pre, ''] : [];
  for (const t of tune.tracks.filter((x) => !x.late)) out.push(...t.lead, trackCode(t), '');
  if (tune.scenes.length) {
    for (const sc of tune.scenes) out.push(...sc.lead, `const ${sc.id} = stack(${sc.ids.join(', ')})`);
    out.push('');
  }
  if (tune.song) {
    const entries = tune.song.entries.map((e) => `  [${e.bars}, ${e.scene}],`);
    out.push(...tune.song.lead, `const ${tune.song.id} = arrange(`, ...entries, ')', '');
  }
  const ending = tune.mode === 'song' && tune.song ? 'song' : tune.mode === 'loop' && tune.mix ? 'loop' : 'none';
  if (tune.mix?.id && ending !== 'loop') {
    out.push(`const ${tune.mix.id} = stack(`, ...mixLines(tune), ')' + tune.mix.tail.join('\n'), '');
  }
  for (const t of tune.tracks.filter((x) => x.late)) out.push(...t.lead, trackCode(t), '');
  if (tune.extra.length) out.push(...tune.extra); // comments right above the ending
  if (ending === 'song') out.push(tune.song.id);
  else if (ending === 'loop') out.push('stack(', ...mixLines(tune), ')' + tune.mix.tail.join('\n'));
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

// ── scenes and the song ───────────────────────────

export function addScene(tune, id, ids) {
  const lead = tune.scenes.length ? [] : ['// scenes: which tracks play'];
  tune.scenes.push({ id, ids, lead });
}

export function removeScene(tune, id) {
  const i = tune.scenes.findIndex((s) => s.id === id);
  const [sc] = tune.scenes.splice(i, 1);
  // its own comment goes with it; a header (or the first scene's whole
  // lead, the scenes header) moves to the next scene
  const h = i === 0 ? sc.lead : header(sc.lead);
  if (h.length && tune.scenes[i]) tune.scenes[i].lead.unshift(...h);
  if (!tune.song) return;
  tune.song.entries = tune.song.entries.filter((e) => e.scene !== id);
  if (!tune.song.entries.length) {
    tune.song = null;
    if (tune.mode === 'song') setMode(tune, 'loop');
  }
}

export function addSongEntry(tune, scene, bars = 4, id = 'song') {
  tune.song ??= { id, entries: [], lead: ['// song: [bars, scene]'] };
  tune.song.entries.push({ bars, scene });
}

export const songLength = (tune) => tune.song?.entries.reduce((n, e) => n + e.bars, 0) ?? 0;
