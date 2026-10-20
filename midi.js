// Standard MIDI files (.mid) as a new tune. Drums (channel 10) become one drum
// track per sound; every other part becomes note tracks, a chord part split
// into one track per voice (top note first). The grid's 16th-note steps are
// the resolution: notes move to the nearest step, and velocity, pitch bends
// and tempo changes aren't kept. A part's usual note length becomes .clip().
import { STEPS, MAX_BARS, fromMidi, IDENT } from './code.js';

export const isMidi = (file) => /\.midi?$/i.test(file.name) || /^audio\/(x-)?midi$/.test(file.type);

// ── reading ───────────────────────────────────────

// { ppq, bpm, timeSig: [n, d], tracks: [{ name, notes: [{ tick, end, key, vel, ch, program }] }] }
export function readMidi(buffer) {
  const data = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let at = 0;
  const text = (n) => String.fromCharCode(...bytes.subarray(at, (at += n)));
  const u32 = () => ((at += 4), data.getUint32(at - 4));
  const u16 = () => ((at += 2), data.getUint16(at - 2));
  const vlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = bytes[at++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('not a MIDI file (bad length)');
  };

  if (bytes.length < 14 || text(4) !== 'MThd') throw new Error('not a MIDI file');
  const headerEnd = u32() + at;
  u16(); // format: 0 (one track) and 1 (tracks played together) read the same way
  const count = u16();
  const ppq = u16();
  if (ppq & 0x8000) throw new Error('this MIDI file times its notes in SMPTE frames, which isn\'t supported');
  at = headerEnd;

  let tempo = null; // µs per quarter note, the first one set
  let timeSig = null;
  const tracks = [];
  for (let n = 0; n < count && at + 8 <= bytes.length; n++) {
    const id = text(4);
    const end = Math.min(u32() + at, bytes.length);
    if (id !== 'MTrk') {
      at = end; // an unknown chunk: skip it
      continue;
    }
    const track = { name: '', notes: [] };
    const open = new Map(); // ch * 128 + key → [{ tick, vel, program }], first in first out
    const program = Array(16).fill(0);
    let tick = 0;
    let status = 0;
    while (at < end) {
      tick += vlq();
      let b = bytes[at];
      if (b & 0x80) {
        at++;
        if (b < 0xf0) status = b; // running status: channel messages only
      } else if (status) b = status;
      else throw new Error('not a MIDI file (bad event)');

      if (b === 0xff) {
        const type = bytes[at++];
        const len = vlq();
        if (type === 0x51 && len === 3 && tempo == null) tempo = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
        if (type === 0x58 && len >= 2 && !timeSig) timeSig = [bytes[at], 2 ** bytes[at + 1]];
        if (type === 0x03 && !track.name) track.name = new TextDecoder().decode(bytes.subarray(at, at + len)).trim();
        at += len;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        at += vlq(); // system exclusive
        continue;
      }
      const ch = b & 0x0f;
      const kind = b & 0xf0;
      const d1 = bytes[at++];
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[at++];
      if (kind === 0xc0) program[ch] = d1;
      const k = ch * 128 + d1;
      if (kind === 0x90 && d2 > 0) {
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ tick, vel: d2, program: program[ch] });
      } else if (kind === 0x80 || kind === 0x90) {
        const on = open.get(k)?.shift();
        if (on) track.notes.push({ tick: on.tick, end: tick, key: d1, vel: on.vel, ch, program: on.program });
      }
    }
    // notes never released end with the track
    for (const [k, ons] of open) for (const on of ons) track.notes.push({ tick: on.tick, end: tick, key: k % 128, vel: on.vel, ch: Math.floor(k / 128), program: on.program });
    track.notes.sort((a, b) => a.tick - b.tick || b.key - a.key);
    tracks.push(track);
    at = end;
  }
  return { ppq, bpm: tempo ? 60e6 / tempo : 120, timeSig: timeSig ?? [4, 4], tracks };
}

// ── into a tune ───────────────────────────────────

// General MIDI drum keys → Strudel's drum machine names, and a track name for each
const DRUMS = {
  35: 'bd', 36: 'bd', 37: 'rim', 38: 'sd', 39: 'cp', 40: 'sd', 41: 'lt', 42: 'hh', 43: 'lt', 44: 'hh', 45: 'mt', 46: 'oh',
  47: 'mt', 48: 'ht', 49: 'cr', 50: 'ht', 51: 'rd', 52: 'cr', 53: 'rd', 54: 'tb', 55: 'cr', 56: 'cb', 57: 'cr', 59: 'rd',
  69: 'sh', 70: 'sh', 82: 'sh',
};
const DRUM_ORDER = ['bd', 'sd', 'rim', 'cp', 'hh', 'oh', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'tb', 'sh', 'perc'];
const DRUM_NAMES = {
  bd: 'kick', sd: 'snare', rim: 'rim', cp: 'clap', hh: 'hats', oh: 'openhat', lt: 'lowtom', mt: 'midtom', ht: 'hitom',
  cr: 'crash', rd: 'ride', cb: 'cowbell', tb: 'tamb', sh: 'shaker', perc: 'perc',
};

// General MIDI programs 0–127, as Strudel's soundfont names (without gm_);
// its four acoustic and grand pianos are one sound, gm_piano
const GM = (
  'piano piano piano piano epiano1 epiano2 harpsichord clavinet ' +
  'celesta glockenspiel music_box vibraphone marimba xylophone tubular_bells dulcimer ' +
  'drawbar_organ percussive_organ rock_organ church_organ reed_organ accordion harmonica bandoneon ' +
  'acoustic_guitar_nylon acoustic_guitar_steel electric_guitar_jazz electric_guitar_clean electric_guitar_muted overdriven_guitar distortion_guitar guitar_harmonics ' +
  'acoustic_bass electric_bass_finger electric_bass_pick fretless_bass slap_bass_1 slap_bass_2 synth_bass_1 synth_bass_2 ' +
  'violin viola cello contrabass tremolo_strings pizzicato_strings orchestral_harp timpani ' +
  'string_ensemble_1 string_ensemble_2 synth_strings_1 synth_strings_2 choir_aahs voice_oohs synth_choir orchestra_hit ' +
  'trumpet trombone tuba muted_trumpet french_horn brass_section synth_brass_1 synth_brass_2 ' +
  'soprano_sax alto_sax tenor_sax baritone_sax oboe english_horn bassoon clarinet ' +
  'piccolo flute recorder pan_flute blown_bottle shakuhachi whistle ocarina ' +
  'lead_1_square lead_2_sawtooth lead_3_calliope lead_4_chiff lead_5_charang lead_6_voice lead_7_fifths lead_8_bass_lead ' +
  'pad_new_age pad_warm pad_poly pad_choir pad_bowed pad_metallic pad_halo pad_sweep ' +
  'fx_rain fx_soundtrack fx_crystal fx_atmosphere fx_brightness fx_goblins fx_echoes fx_sci_fi ' +
  'sitar banjo shamisen koto kalimba bagpipe fiddle shanai ' +
  'tinkle_bell agogo steel_drums woodblock taiko_drum melodic_tom synth_drum reverse_cymbal ' +
  'guitar_fret_noise breath_noise seashore bird_tweet telephone helicopter applause gunshot'
).split(' ');
// a name for a part without one, from its program's family of eight
const FAMILY = ['piano', 'bells', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass', 'reed', 'pipe', 'lead', 'pad', 'fx', 'folk', 'tuned', 'sfx'];
const VOICES = 4; // most tracks one chord part splits into

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// The bars as written, or fewer when they repeat (a loop of p bars, p dividing
// the length, plays the same)
function shortest(steps) {
  const bars = steps.length / STEPS;
  for (let p = 1; p < bars; p++) {
    if (bars % p) continue;
    if (steps.every((v, i) => v === steps[i % (p * STEPS)])) return steps.slice(0, p * STEPS);
  }
  return steps;
}

function mini(steps) {
  const bar = (s) => {
    const tok = s.map((v) => (v === true ? 'x' : v || '~'));
    const beats = [];
    for (let i = 0; i < STEPS; i += 4) beats.push(tok.slice(i, i + 4).join(' '));
    return beats.join('  ');
  };
  const bars = [];
  for (let i = 0; i < steps.length; i += STEPS) bars.push(bar(steps.slice(i, i + STEPS)));
  return bars.length === 1 ? bars[0] : `<${bars.map((b) => `[${b}]`).join(' ')}>`;
}

// A tune's code from readMidi()'s result.
//   kit: the drum machine for drum tracks that it has (hasKit(sound) says so)
//   isFree(name): a name a track may take (not a Strudel or JavaScript name)
// → { code, report: { tracks, bars, fileBars, bpm, moved, dropped, split, timeSig } }
export function midiToTune(midi, { name = 'midi', kit = '', hasKit = () => false, isFree = () => true } = {}) {
  const step = midi.ppq / 4;
  const all = midi.tracks.flatMap((t) => t.notes);
  if (!all.length) throw new Error('this MIDI file has no notes');
  const barTicks = step * STEPS;
  const start = Math.floor(Math.min(...all.map((n) => n.tick)) / barTicks) * barTicks;
  const at = (tick) => Math.round((tick - start) / step);
  const fileBars = Math.ceil((Math.max(...all.map((n) => at(n.tick))) + 1) / STEPS);
  const bars = Math.min(fileBars, MAX_BARS);
  const length = bars * STEPS;
  const report = { bars, fileBars, bpm: Math.round(midi.bpm), moved: 0, dropped: 0, split: [], timeSig: midi.timeSig };
  for (const n of all) if ((n.tick - start) % step && at(n.tick) < length) report.moved++;

  const taken = new Set();
  const claim = (base) => {
    let id = base;
    for (let i = 2; taken.has(id) || !isFree(id); i++) id = `${base}${i}`;
    taken.add(id);
    return id;
  };
  const tracks = []; // { id, head, pattern line, chain }

  // drums: channel 10 (9 counting from 0), one track per sound
  const drums = new Map();
  for (const t of midi.tracks) {
    for (const n of t.notes) {
      if (n.ch !== 9 || at(n.tick) >= length) continue;
      const snd = DRUMS[n.key] ?? 'perc';
      if (!drums.has(snd)) drums.set(snd, Array(length).fill(null));
      drums.get(snd)[at(n.tick)] = true;
    }
  }
  for (const snd of DRUM_ORDER.filter((s) => drums.has(s))) {
    const bank = kit && hasKit(snd) ? `.bank("${kit}")` : '';
    tracks.push({ id: claim(DRUM_NAMES[snd]), head: `s("${snd}")${bank}`, pat: `.struct("${mini(shortest(drums.get(snd)))}")`, chain: [] });
  }

  // every other part: per MIDI track, channel and program
  for (const t of midi.tracks) {
    const parts = new Map();
    for (const n of t.notes) {
      if (n.ch === 9 || at(n.tick) >= length) continue;
      const k = `${n.ch}:${n.program}`;
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push(n);
    }
    for (const notes of parts.values()) {
      const program = notes[0].program;
      // the keys at each step, highest first; voice v takes the v-th
      const byStep = new Map();
      for (const n of notes) {
        const s = at(n.tick);
        if (!byStep.has(s)) byStep.set(s, new Set());
        byStep.get(s).add(n.key);
      }
      const voices = [];
      for (const [s, keys] of byStep) {
        const sorted = [...keys].sort((a, b) => b - a);
        report.dropped += Math.max(0, sorted.length - VOICES);
        sorted.slice(0, VOICES).forEach((key, v) => {
          voices[v] ??= Array(length).fill(null);
          voices[v][s] = fromMidi(key);
        });
      }
      const label = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 16);
      const base = IDENT.test(label) ? label : FAMILY[program >> 3];
      const clip = median(notes.map((n) => Math.max(1, Math.round((n.end - n.tick) / step))));
      const ids = voices.map((steps, v) => {
        const id = claim(v ? `${base}${v + 1}` : base);
        tracks.push({
          id,
          head: `note("${mini(shortest(steps))}").s("gm_${GM[program]}")`,
          pat: null,
          chain: clip > 1 ? [`.clip(${clip})`] : [],
        });
        return id;
      });
      if (ids.length > 1) report.split.push(ids);
    }
  }

  const blocks = tracks.map((t, i) => {
    const chain = [...(t.pat ? [t.pat] : []), ...t.chain, `.orbit(${i + 1})`];
    return [`const ${t.id} = ${t.head}`, ...chain.map((l) => `  ${l}`)].join('\n');
  });
  const code = [
    `// ${name}`,
    `setcpm(${report.bpm}/4)`,
    '',
    ...blocks.flatMap((b) => [b, '']),
    'stack(',
    ...tracks.map((t) => `  ${t.id},`),
    ')',
    '',
  ].join('\n');
  report.tracks = tracks.map((t) => t.id);
  return { code, report };
}
