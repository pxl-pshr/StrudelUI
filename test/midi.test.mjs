import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidi, midiToTune, isMidi } from '../midi.js';
import { parse, generate } from '../code.js';

// a Standard MIDI file from tracks of [delta ticks, ...event bytes]
const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
function smf(ppq, tracks) {
  const u32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const bytes = [...'MThd'].map((c) => c.charCodeAt(0)).concat(u32(6), [0, 1, 0, tracks.length, ppq >> 8, ppq & 255]);
  for (const events of tracks) {
    const body = events.flatMap(([dt, ...ev]) => [...vlq(dt), ...ev]).concat(0, 0xff, 0x2f, 0);
    bytes.push(...[...'MTrk'].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  }
  return new Uint8Array(bytes).buffer;
}
const PPQ = 96; // a 16th is 24 ticks, a bar 384
const name = (s) => [0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];

// tempo 100 bpm (600000 µs), a drum track, and a two-note chord part
const FILE = smf(PPQ, [
  [[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0]],
  [
    // kick on every beat for two bars (running status after the first), a hat on beat 4 of bar 1
    [0, 0x99, 36, 100], [24, 36, 0], [72, 36, 100], [24, 36, 0], [72, 36, 100], [24, 36, 0], [72, 36, 100], [0, 42, 90], [24, 36, 0], [0, 42, 0],
    [72, 36, 100], [24, 36, 0], [72, 36, 100], [24, 36, 0], [72, 36, 100], [24, 36, 0], [72, 36, 100], [24, 0x89, 36, 0],
  ],
  [
    [0, ...name('Keys'), ],
    [0, 0xc0, 4], // program 4: electric piano 1
    // a chord on step 1 held two steps, then a note 5 ticks late of step 9 (moves to step 9)
    [0, 0x90, 60, 90], [0, 64, 90], [48, 0x80, 60, 0], [0, 64, 0],
    [149, 0x90, 67, 90], [48, 67, 0],
  ],
]);

test('isMidi: by extension or type', () => {
  assert.ok(isMidi({ name: 'a.mid', type: '' }));
  assert.ok(isMidi({ name: 'a.MIDI', type: '' }));
  assert.ok(isMidi({ name: 'x', type: 'audio/midi' }));
  assert.ok(!isMidi({ name: 'a.js', type: 'text/javascript' }));
});

test('readMidi: tempo, names, programs and notes with running status and note-on 0 as off', () => {
  const m = readMidi(FILE);
  assert.equal(m.ppq, PPQ);
  assert.equal(Math.round(m.bpm), 100);
  assert.deepEqual(m.timeSig, [4, 4]);
  const [, drums, keys] = m.tracks;
  assert.equal(drums.notes.filter((n) => n.key === 36).length, 8);
  assert.ok(drums.notes.every((n) => n.ch === 9 && n.end - n.tick === 24));
  assert.equal(keys.name, 'Keys');
  assert.deepEqual(keys.notes.map((n) => [n.tick, n.end, n.key, n.program]), [[0, 48, 64, 4], [0, 48, 60, 4], [197, 245, 67, 4]]);
});

test('readMidi: not a MIDI file, or SMPTE timing', () => {
  assert.throws(() => readMidi(new TextEncoder().encode('const a = 1').buffer), /not a MIDI file/);
  const smpte = new Uint8Array(smf(PPQ, [[]]));
  smpte[12] = 0xe7; // division with the top bit set
  assert.throws(() => readMidi(smpte.buffer), /SMPTE/);
});

test('midiToTune: drums per sound, chords split by voice, steps on the grid, a tune the grid reads', () => {
  const { code, report } = midiToTune(readMidi(FILE), { name: 'groove', kit: 'RolandTR909', hasKit: (s) => s === 'bd' });
  const t = parse(code);
  assert.equal(generate(t), code); // exactly the code the app would write
  assert.equal(t.bpm, 100);
  assert.deepEqual(t.tracks.map((x) => [x.id, x.kind]), [['kick', 'hit'], ['hats', 'hit'], ['keys', 'note'], ['keys2', 'note']]);
  const [kick, hats, keys, keys2] = t.tracks;
  // the kick repeats bar to bar: one bar; the hat only plays in bar 1: two
  assert.equal(kick.bars, 1);
  assert.deepEqual(kick.steps.map((v, i) => (v ? i : null)).filter((i) => i != null), [0, 4, 8, 12]);
  assert.match(code, /s\("bd"\)\.bank\("RolandTR909"\)/);
  assert.match(code, /const hats = s\("hh"\)\n/); // the kit has no hh
  assert.equal(hats.bars, 2);
  assert.equal(hats.steps[12], true);
  // the chord: top note first, the late note on the nearest step (197 ticks: step 8)
  assert.equal(keys.steps[0], 'e4');
  assert.equal(keys2.steps[0], 'c4');
  assert.equal(keys.steps[8], 'g4');
  assert.match(code, /note\("[^"]+"\)\.s\("gm_epiano1"\)\n {2}\.clip\(2\)/);
  assert.deepEqual(report.split, [['keys', 'keys2']]);
  assert.equal(report.moved, 1);
  assert.equal(report.bars, 2);
  assert.match(code, /^\/\/ groove\n/);
});

test('midiToTune: names a track may not take, and the 16-bar limit', () => {
  const long = smf(PPQ, [[[0, 0x99, 36, 100], [24, 0x89, 36, 0], [384 * 20 - 24, 0x99, 38, 100], [24, 0x89, 38, 0]]]);
  const { code, report } = midiToTune(readMidi(long), { isFree: (n) => n !== 'kick' });
  const t = parse(code);
  assert.deepEqual(t.tracks.map((x) => x.id), ['kick2']); // the snare is past bar 16
  assert.equal(report.fileBars, 21);
  assert.equal(report.bars, 16);
  // a kick in bar 1 only, then silence: all 16 bars, it doesn't loop
  assert.equal(t.tracks[0].bars, 16);
  assert.equal(t.tracks[0].steps.filter(Boolean).length, 1);
});

test('midiToTune: General MIDI programs on Strudel\'s sounds (the pianos are one, gm_piano)', () => {
  const one = (program) => smf(PPQ, [[[0, 0xc0, program], [0, 0x90, 60, 90], [24, 0x80, 60, 0]]]);
  const sound = (program) => midiToTune(readMidi(one(program))).code.match(/\.s\("(gm_\w+)"\)/)[1];
  assert.deepEqual([0, 3, 4, 33, 127].map(sound), ['gm_piano', 'gm_piano', 'gm_epiano1', 'gm_electric_bass_finger', 'gm_gunshot']);
  assert.match(midiToTune(readMidi(one(33))).code, /const bass = /); // no track name: its family's
});

test('midiToTune: a file with no notes', () => {
  assert.throws(() => midiToTune(readMidi(smf(PPQ, [[[0, 0xff, 0x51, 3, 7, 0xa1, 0x20]]]))), /no notes/);
});
