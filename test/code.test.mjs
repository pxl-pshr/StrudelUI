// The code <-> track model (code.js). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse, generate, getParam, setParam, setLine, getPump, setPump, getSound, setSound,
  blockToTrack, addTrack, duplicateTrack, removeTrack, renameTrack, setBars, setMode,
  addScene, removeScene, addSongEntry, songLength, allIds, references, declared, freeOrbit, getTrackPump, setTrackPump, pumpTrack, orbitOf, setTrim, num, numAt, soundsIn, renameSounds, forStrudel,
} from '../code.js';
import { clampRange } from '../trim.js';
import { DEFAULT_TUNE } from '../default.js';

// a fixed tune for the model tests, so changing the default tune (default.js) doesn't move them
const TUNE = readFileSync(new URL('./fixtures/tune.strudel', import.meta.url), 'utf8');
// TUNE with two tracks muted, whatever it mutes itself
const MUTED = TUNE.replace(/^  (\/\/ )?hats,$/m, '  // hats,').replace(/^  (\/\/ )?clap,$/m, '  // clap,');
const HAND = readFileSync(new URL('./fixtures/hand-written.strudel', import.meta.url), 'utf8');
const gen = (tune) => generate(tune);
const T = (tune, id) => tune.tracks.find((t) => t.id === id);
const block = (code, id) => {
  const at = code.indexOf(`const ${id} =`);
  return code.slice(at, code.indexOf('\n\n', at));
};

for (const [name, code] of [['the default tune', DEFAULT_TUNE], ['the test tune', TUNE]]) {
  test(`${name} reads into grid tracks and writes back unchanged`, () => {
    const tune = parse(code);
    assert.ok(tune.bpm > 0);
    assert.ok(tune.tracks.every((t) => t.kind !== 'code'));
    const commented = [...code.matchAll(/^  \/\/ (\w+),$/gm)].map((m) => m[1]);
    assert.deepEqual(tune.tracks.filter((t) => t.mute).map((t) => t.id), commented);
    assert.equal(gen(tune), code);
  });
}

test('hand-written code: compact patterns are editable, the rest stays code', () => {
  const tune = parse(HAND);
  const kinds = Object.fromEntries(tune.tracks.map((t) => [t.id, t.kind]));
  assert.deepEqual(kinds, { kick: 'code', hats: 'hit', clap: 'hit', bass: 'note', chords: 'code' });
  assert.equal(T(tune, 'hats').steps.filter(Boolean).length, 16); // [x x]*8
  assert.deepEqual(T(tune, 'clap').steps.map((s) => (s ? 'x' : '.')).join(''), '....x.......x...'); // [~ x]*2
  assert.equal(T(tune, 'bass').steps[1], 'c2');
  assert.ok(T(tune, 'clap').mute);
});

test('hand-written code keeps its notation, comments and spacing', () => {
  const tune = parse(HAND);
  const out = gen(tune);
  assert.equal(gen(parse(out)), out); // stable
  assert.ok(out.includes('.struct("[x x]*8")'));
  assert.ok(out.includes('// ════ DRUMS ════\n\n// steady kick, pattern in s()\nconst kick'));
  assert.ok(out.includes('// ════ MIX ════\nstack('));
  assert.ok(tune.tracks.filter((t) => t.kind === 'code').every((t) => out.includes(t.raw)));
});

test('an edited row is rewritten as 16 steps; untouched rows are not', () => {
  const tune = parse(HAND);
  const hats = T(tune, 'hats');
  hats.steps[1] = null;
  hats.pat = null;
  const out = gen(tune);
  assert.ok(out.includes('.struct("x ~ x x  x x x x  x x x x  x x x x")'));
  assert.ok(out.includes('.struct("[~ x]*2")'));
});

test('params: read, set before .orbit(), remove; patterns read as NaN', () => {
  const tune = parse(TUNE);
  const kick = T(tune, 'kick');
  setParam(kick, 'lpf', 900);
  assert.equal(kick.chain.at(-2), '.lpf(900)');
  setParam(kick, 'lpf', null);
  assert.equal(getParam(kick, 'lpf'), null);
  assert.ok(Number.isNaN(getParam(T(tune, 'hats'), 'decay')));
  setLine(kick, '.jux(', '.jux(rev)');
  assert.equal(kick.chain.at(-2), '.jux(rev)');
});

test('params: `before` places a new line ahead of another (trim: begin before end)', () => {
  const kick = T(parse(TUNE), 'kick');
  setParam(kick, 'end', 0.6);
  setParam(kick, 'begin', 0.07, '.end(');
  assert.deepEqual(kick.chain.slice(-3), ['.begin(.07)', '.end(.6)', '.orbit(1)']);
  setParam(kick, 'begin', 0.2, '.end('); // an existing line stays where it is
  assert.equal(kick.chain.at(-3), '.begin(.2)');
});

test('pump scales every ducked orbit together', () => {
  const tune = parse(TUNE);
  assert.deepEqual(getPump(tune).depths, [0.52, 0.17, 0.43]);
  setPump(tune, 0.26);
  assert.deepEqual(getPump(tune).depths, [0.26, 0.09, 0.22]);
});

test('sounds: read and write s(), :n, .n() and .bank() where they are', () => {
  const tune = parse(TUNE);
  assert.deepEqual(getSound(T(tune, 'toms')), { name: 'lt', n: 0, bank: 'RolandTR909' });
  setSound(T(tune, 'kick'), { name: 'bd', n: 2, bank: 'RolandTR808' });
  setSound(T(tune, 'toms'), { name: 'lt', n: 3, bank: 'LinnDrum' });
  setSound(T(tune, 'clap'), { name: 'shaker', n: 13, bank: null });
  const out = gen(tune);
  assert.ok(out.includes('const kick = s("bd:2").bank("RolandTR808")'));
  assert.ok(out.includes('.s("lt").n(3).bank("LinnDrum")'));
  assert.ok(out.includes('const clap = s("shaker:13")\n'));
  // a bank on its own line is removed with its line
  const hand = parse(HAND);
  setSound(T(hand, 'bass'), { name: 'supersaw', n: 0, bank: null });
  assert.ok(!T(hand, 'bass').chain.some((l) => l.includes('bank')));
  assert.equal(getSound(T(hand, 'bass')).name, 'supersaw');
});

test('add, duplicate, rename (with references), delete (keeping section headers)', () => {
  const tune = parse(HAND);
  addTrack(tune, blockToTrack('const lead = note("c4 ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~").s("square")\n  .orbit(5)'));
  duplicateTrack(tune, 'clap', 'clap2');
  let out = gen(tune);
  assert.ok(out.indexOf('const lead') < out.indexOf('\nstack(\n') && out.includes('  lead,\n'));
  assert.ok(out.indexOf('const clap2') > out.indexOf('const clap ') && out.indexOf('const clap2') < out.indexOf('const bass'));

  tune.extra.push('const both = stack(kick, kick.fast(2))');
  renameTrack(tune, 'kick', 'drums');
  out = gen(tune);
  assert.ok(out.includes('const drums = s("bd*4")') && out.includes('stack(drums, drums.fast(2))') && out.includes('  drums,\n'));

  removeTrack(tune, 'drums');
  out = gen(tune);
  assert.ok(!out.includes('steady kick') && out.includes('// ════ DRUMS ════'));
});

test('bars: <[bar] [bar]> reads, grows, shrinks and writes back', () => {
  const tune = parse(TUNE);
  setBars(T(tune, 'kick'), 2);
  T(tune, 'kick').steps[18] = true;
  const out = gen(tune);
  assert.ok(out.includes('.struct("<[x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~] [x ~ x ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~]>")'));
  const back = parse(out);
  assert.equal(T(back, 'kick').bars, 2);
  assert.equal(gen(back), out);
  setBars(T(back, 'kick'), 1);
  assert.equal(T(back, 'kick').steps.length, 16);
  assert.equal(parse('const h = s("hh")\n  .struct("<[x x]*8 [x ~]*8>")\nstack(\n  h,\n)\n').tracks[0].bars, 2);
});

test('scenes and the song: write, read back, switch modes, follow renames', () => {
  const tune = parse(TUNE);
  addScene(tune, 'intro', ['kick', 'sub']);
  addScene(tune, 'drop', ['kick', 'sub', 'saw', 'hats']);
  addSongEntry(tune, 'intro', 4);
  addSongEntry(tune, 'drop', 8);
  const loop = gen(tune);
  assert.ok(loop.includes('const intro = stack(kick, sub)\nconst drop = stack(kick, sub, saw, hats)\n'));
  assert.ok(loop.includes('const song = arrange(\n  [4, intro],\n  [8, drop],\n)'));
  const back = parse(loop);
  assert.equal(back.mode, 'loop');
  assert.equal(gen(back), loop);
  assert.equal(songLength(back), 12);

  setMode(back, 'song');
  const song = gen(back);
  assert.ok(song.trimEnd().endsWith('\nsong') && !song.includes('\nstack(\n'));
  assert.equal(parse(song).mode, 'song');

  renameTrack(back, 'kick', 'drums');
  renameTrack(back, 'intro', 'start');
  assert.ok(gen(back).includes('const start = stack(drums, sub)') && gen(back).includes('[4, start]'));
  removeScene(back, 'start');
  assert.ok(!gen(back).includes('start') && allIds(back).includes('drop'));
});

// ── regressions ───────────────────────────────────

test('loop → song → loop keeps code written in the mix', () => {
  const src = MUTED.replace('  stab2,\n)\n', '  stab2,\n  s("cp").struct("~ x"), // extra\n).room(.2)\n');
  const tune = parse(src);
  addScene(tune, 'intro', ['kick']);
  addSongEntry(tune, 'intro', 4);
  setMode(tune, 'song');
  const song = gen(tune);
  assert.ok(song.includes('const mix = stack(') && song.includes('s("cp").struct("~ x"), // extra') && song.trimEnd().endsWith('song'));
  const back = parse(song);
  assert.equal(back.mode, 'song');
  assert.deepEqual(back.tracks.filter((t) => t.mute).map((t) => t.id), parse(MUTED).tracks.filter((t) => t.mute).map((t) => t.id));
  setMode(back, 'loop');
  const loop = gen(back);
  assert.ok(loop.includes('  s("cp").struct("~ x"), // extra\n).room(.2)'));
  assert.ok(!loop.includes('const mix'));
});

test('solo lives in the code: reload and unsolo keep the real mutes', () => {
  const tune = parse(MUTED);
  T(tune, 'kick').solo = true;
  const soloed = gen(tune);
  assert.ok(soloed.includes('  kick, // solo\n') && soloed.includes('  // sub, // solo\n') && soloed.includes('  // hats,\n'));
  const back = parse(soloed); // reload / undo / open
  assert.deepEqual(back.tracks.filter((t) => t.solo).map((t) => t.id), ['kick']);
  T(back, 'kick').solo = false; // unsolo
  assert.equal(gen(back), MUTED);
});

test('mix lines keep their comments, and mute works on them', () => {
  const tune = parse(TUNE.replace('  kick,\n', '  kick, // main\n'));
  assert.equal(T(tune, 'kick').mute, false);
  T(tune, 'kick').mute = true;
  const out = gen(tune);
  assert.ok(out.includes('  // kick, // main\n') && !out.includes('  kick,'));
});

test('a track used by the mix code is not listed twice', () => {
  const tune = parse(TUNE.replace('  kick,\n', '  kick.fast(2),\n'));
  assert.ok(T(tune, 'kick').inMixCode && !T(tune, 'kick').mute);
  assert.ok(!gen(tune).includes('// kick,'));
});

test('rename skips strings and comments, even with an apostrophe in one', () => {
  const tune = parse(`const kick = s("bd")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n\nconst fx = stack(\n  // don't let this get loud\n  kick.fast(2),\n  kick.s('cp'),\n)\n\nstack(\n  fx,\n)\n`);
  renameTrack(tune, 'kick', 'boom');
  const out = gen(tune);
  assert.ok(out.includes('boom.fast(2)') && out.includes("boom.s('cp')") && out.includes("// don't let this get loud"));
  assert.ok(!/\bkick\b/.test(out));
});

test('delete reports where the code still uses a track', () => {
  const tune = parse(`const kick = s("bd")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n\nconst fx = kick.fast(2) // "kick" in a string doesn't count\n\nstack(\n  fx,\n)\n`);
  assert.deepEqual(references(tune, 'kick'), ['fx']);
  assert.deepEqual(references(tune, 'fx'), []);
});

test('blocks continue through lines starting with } or ]', () => {
  const src = 'const chords = {\n  a: "c3",\n}\n\nconst kick = s("bd")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n\nstack(\n  kick,\n)\n';
  const tune = parse(src);
  assert.ok(T(tune, 'chords').raw.endsWith('}'));
  assert.deepEqual(T(tune, 'kick').lead, []);
  assert.equal(gen(tune), src);
});

test('code below the scenes stays below them, a fresh mix skips helpers', () => {
  const src = 'const scale = "C:minor"\n\nconst kick = s("bd")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n\nconst intro = stack(kick)\n\nconst loud = intro.gain(2)\n\nloud\n';
  const tune = parse(src);
  assert.equal(gen(tune), src);
  setMode(tune, 'loop');
  const out = gen(tune);
  assert.ok(out.indexOf('const loud') > out.indexOf('const intro'));
  assert.ok(out.includes('stack(\n  kick,\n  loud,\n)') && !out.includes('  scale,'));
});

test('sound edits stay out of superimpose layers; edited lines keep comments', () => {
  const tune = parse('const kick = s("bd:3").bank("RolandTR909")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n  .superimpose(x => x.s("sd").n(4).bank("RolandTR808"))\n  .gain(.5) // keep quiet\n\nstack(\n  kick,\n)\n');
  const kick = T(tune, 'kick');
  assert.deepEqual(getSound(kick), { name: 'bd', n: 3, bank: 'RolandTR909' });
  setSound(kick, { name: 'bd', n: 5, bank: 'LinnDrum' });
  setParam(kick, 'gain', 0.6);
  const out = gen(tune);
  assert.ok(out.includes('const kick = s("bd:5").bank("LinnDrum")'));
  assert.ok(out.includes('.superimpose(x => x.s("sd").n(4).bank("RolandTR808"))'));
  assert.ok(out.includes('.gain(.6) // keep quiet'));
});

test('windows line endings, empty preamble, names declared anywhere', () => {
  const tune = parse('const kick = s("bd")\r\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\r\n\r\nstack(\r\n  kick,\r\n)\r\n');
  assert.equal(T(tune, 'kick').kind, 'hit');
  assert.ok(gen(tune).startsWith('const kick'));
  assert.deepEqual([...declared('let a = 1\nconst b = "const c"\nfunction d() {}')], ['a', 'b', 'd']);
});

test('renameSounds: only strings passed to s(…) / sound(…), whole words, one pass', () => {
  const code = [
    'const bass = n("0 2 4").scale("C3:minor").s("sawtooth") // minor',
    'const hit = s("minor:0")',
    'const b = note("c e").sound("<minor minors [hh minor:2]>")',
    "const c = s('a a_2')",
    'samples("https://example.com/minor/")',
    'const minor = 1',
    '',
  ].join('\n');
  const out = renameSounds(code, { minor: 'minor_2', a: 'a_2', a_2: 'a_2_2' });
  assert.equal(out, [
    'const bass = n("0 2 4").scale("C3:minor").s("sawtooth") // minor',
    'const hit = s("minor_2:0")',
    'const b = note("c e").sound("<minor_2 minors [hh minor_2:2]>")',
    "const c = s('a_2 a_2_2')",
    'samples("https://example.com/minor/")',
    'const minor = 1',
    '',
  ].join('\n'));
  assert.deepEqual(soundsIn(out, ['minor_2', 'minors']), ['minor_2', 'minors']);
  assert.equal(renameSounds(code, {}), code);
});

test('renameSounds: ignores case like Strudel; skips .bank() chains', () => {
  assert.equal(renameSounds('const a = s("Pack:1")\n', { pack: 'pack_2' }), 'const a = s("pack_2:1")\n');
  // s("hh").bank("kit") plays kit_hh: renaming hh there would make kit_hh_2
  const banked = 'const h = s("hh").bank("kit")\nconst h2 = s("hh")\n  .bank("kit")\n  .gain(.5)\nconst h3 = s("hh")\n  .gain(.5)\n';
  assert.equal(renameSounds(banked, { hh: 'hh_2' }), banked.replace('const h3 = s("hh")', 'const h3 = s("hh_2")'));
  // a comment line inside the chain, and a chain starting on the second line
  const commented = 'const h = s("hh")\n  // hats\n  .bank("kit")\n';
  assert.equal(renameSounds(commented, { hh: 'hh_2' }), commented);
  assert.equal(renameSounds('\n.s("hh")\n', { hh: 'hh_2' }), '\n.s("hh_2")\n');
  // rename keys are lowercase (slugs); anything else is left as it was
  assert.equal(renameSounds('const a = s("Pack")\n', { Pack: 'Pack_2' }), 'const a = s("Pack")\n');
});

test('renameSounds follows a constant only when s(…) / sound(…) is its only use', () => {
  const code = 'const chosen = "pack"\nconst other = "pack"\nconst kit = "<pack hh>"\nconst a = s(chosen)\nconst b = note("c").s(kit)\n';
  assert.equal(renameSounds(code, { pack: 'pack_2' }),
    'const chosen = "pack_2"\nconst other = "pack"\nconst kit = "<pack_2 hh>"\nconst a = s(chosen)\nconst b = note("c").s(kit)\n');
  // also used by a scale (concatenated or inside a template): left alone
  const shared = "const chosen = 'minor'\nconst bass = n(\"0 2 4\").scale('C3:' + chosen).s(\"sawtooth\")\nconst hit = s(chosen)\n";
  assert.equal(renameSounds(shared, { minor: 'minor_2' }), shared);
  const templated = 'const k = "pack"\nconst a = s(k)\nconst b = n("0").scale(`C3:${k}`)\n';
  assert.equal(renameSounds(templated, { pack: 'pack_2' }), templated);
  // a template with ${…} or a concatenation is not a plain sound string
  for (const dyn of ['const pack = "x"\nconst hit = s(`pack:${pack}`)\n', 'const hit = s("pack" + x)\n']) {
    assert.equal(renameSounds(dyn, { pack: 'pack_2' }), dyn);
  }
});

test('soundsIn finds bank-qualified sounds, through constants, other chains and comments, ignoring case', () => {
  const code = 'const hats = s("hh").bank("mykit")\n  .struct("x ~ ~ ~")\n';
  assert.deepEqual(soundsIn(code, ['mykit_hh', 'mykit_cp', 'otherkit_cp', 'mykit_bd', 'hh', 'yourkit_hh']), ['mykit_hh', 'hh']);
  assert.deepEqual(soundsIn('const c = s("cp").bank("<otherkit mykit>")\n', ['mykit_cp', 'otherkit_cp', 'mykit_hh']), ['mykit_cp', 'otherkit_cp']);
  assert.deepEqual(soundsIn('const hats = s("hh")\nconst h2 = hats.bank("kit")\n', ['kit_hh']), ['kit_hh']);
  assert.deepEqual(soundsIn('const h = s("hh").bank(/* c */"kit")\n', ['kit_hh']), ['kit_hh']);
  assert.deepEqual(soundsIn('const kit = "mykit"\nconst h = s("hh").bank(kit)\n', ['mykit_hh']), ['mykit_hh']);
  assert.deepEqual(soundsIn('const a = s("Pack")\n', ['pack']), ['pack']);
});

test('forStrudel: the duck lists keep only orbits a playing track uses', () => {
  const lines = (c) => c.split('\n').filter((l) => /\.duck/.test(l)).map((l) => l.trim());
  // the default tune plays its song: the scenes play orbit 5 too, so the lists stay
  assert.equal(parse(DEFAULT_TUNE).mode, 'song');
  assert.equal(forStrudel(DEFAULT_TUNE), DEFAULT_TUNE);
  // loop: perc, stab and stab2 (orbit 5) are muted, so orbit 5 goes; nothing else changes
  const t = parse(DEFAULT_TUNE);
  setMode(t, 'loop');
  const loop = generate(t);
  const out = forStrudel(loop);
  assert.deepEqual(lines(out), ['.duckorbit("2")', '.duckdepth(".46")', '.duckattack(".01")']);
  assert.equal(out.split('\n').filter((l, i) => l !== loop.split('\n')[i]).length, 3);
  // every orbit playing: unchanged
  assert.equal(forStrudel(TUNE), TUNE);
});

test('freeOrbit: one above every .orbit(n) in code, not in comments or strings', () => {
  const max = Math.max(...[...TUNE.matchAll(/\.orbit\((\d+)\)/g)].map((m) => Number(m[1])));
  assert.equal(freeOrbit(TUNE), max + 1);
  assert.equal(freeOrbit('s("bd").orbit(2) // .orbit(9)\nconst t = ".orbit(12)"'), 3);
  assert.equal(freeOrbit('s("bd")'), 2); // no .orbit(): orbit 1 is in use
});

test('params with fixed trailing arguments: .swingBy(x, 8)', () => {
  const hats = T(parse(TUNE), 'hats');
  assert.equal(getParam(hats, 'swingBy', '8'), null);
  setParam(hats, 'swingBy', 0.17, undefined, '8');
  assert.ok(hats.chain.includes('.swingBy(.17, 8)'));
  assert.equal(getParam(hats, 'swingBy', '8'), 0.17);
  setLine(hats, '.swingBy(', '.swingBy(1/6, 8)'); // hand-written: shown as "in code"
  assert.ok(Number.isNaN(getParam(hats, 'swingBy', '8')));
  setLine(hats, '.swingBy(', '.swingBy(.2, 4)'); // other slice count: not the slider's
  assert.ok(Number.isNaN(getParam(hats, 'swingBy', '8')));
  setParam(hats, 'swingBy', null, undefined, '8');
  assert.ok(!hats.chain.some((l) => l.startsWith('.swingBy(')));
});

test('per-track pump reads and writes its orbit in the kick\'s duck lists', () => {
  const tune = parse(TUNE);
  const kick = T(tune, 'kick');
  const duck = () => kick.chain.filter((l) => l.startsWith('.duck'));
  const before = duck();
  const hats = getTrackPump(tune, T(tune, 'hats'));
  assert.equal(hats.orbit, 4);
  assert.equal(hats.depth, Number(before.find((l) => l.startsWith('.duckdepth(')).match(/"([^"]+)"/)[1].split(':')[1]));
  assert.ok(hats.shared.includes('ride'));
  assert.equal(getTrackPump(tune, kick).why, 'source');
  assert.equal(getTrackPump(tune, T(tune, 'clap')).depth, 0); // orbit 3 isn't ducked

  setTrackPump(tune, T(tune, 'clap'), 0.3);
  assert.equal(getTrackPump(tune, T(tune, 'clap')).depth, 0.3);
  assert.ok(duck()[0].endsWith(':3")') && duck()[1].endsWith(':.3")'));
  assert.equal(duck()[2].split(':').length, 4); // attack list grows with it
  setTrackPump(tune, T(tune, 'clap'), 0);
  assert.equal(getTrackPump(tune, T(tune, 'clap')).depth, 0);
  assert.equal(duck()[0], before[0]);

  setTrackPump(tune, T(tune, 'hats'), 0.5);
  assert.equal(getTrackPump(tune, T(tune, 'ride')).depth, 0.5); // same orbit
  assert.equal(gen(parse(gen(tune))), gen(tune));
});

test('per-track pump with no ducking yet: the kick starts driving it', () => {
  const tune = parse('const kick = s("bd")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n  .orbit(1)\n\nconst hats = s("hh")\n  .struct("~ ~ x ~  ~ ~ x ~  ~ ~ x ~  ~ ~ x ~")\n  .orbit(2)\n\nstack(\n  kick,\n  hats,\n)\n');
  assert.equal(getTrackPump(tune, T(tune, 'hats')).depth, 0);
  setTrackPump(tune, T(tune, 'hats'), 0.4);
  assert.deepEqual(T(tune, 'kick').chain.slice(-3), ['.duckorbit("2")', '.duckdepth(".4")', '.orbit(1)']);
  setTrackPump(tune, T(tune, 'hats'), 0);
  assert.ok(!T(tune, 'kick').chain.some((l) => l.startsWith('.duck')));
  assert.equal(getTrackPump(parse('stack(\n)\n'), { kind: 'hit', chain: [] }).why, 'none');
});

test('pump switch: a shared orbit is split first, so only that track changes', () => {
  const tune = parse(TUNE);
  const free = freeOrbit(TUNE);
  const ride = getTrackPump(tune, T(tune, 'ride')).depth;
  assert.equal(pumpTrack(tune, T(tune, 'hats'), false), free); // hats shared orbit 4: moved
  assert.equal(orbitOf(T(tune, 'hats')), free);
  assert.equal(getTrackPump(tune, T(tune, 'hats')).depth, 0);
  assert.equal(getTrackPump(tune, T(tune, 'ride')).depth, ride); // ride and hhoff untouched

  const main = getTrackPump(tune, T(tune, 'sub')).depth;
  assert.equal(pumpTrack(tune, T(tune, 'hats'), true), null); // alone now: stays put
  assert.equal(getTrackPump(tune, T(tune, 'hats')).depth, main); // at the main depth
  assert.equal(pumpTrack(tune, T(tune, 'clap'), true), null); // clap is alone on orbit 3
  assert.equal(getTrackPump(tune, T(tune, 'clap')).depth, main);
  assert.equal(gen(parse(gen(tune))), gen(tune));
});

test('pump switch: no .orbit() means orbit 1, shared with the kick, so it moves', () => {
  const tune = parse('const kick = s("bd")\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\n\nconst pad = note("c3 ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~").s("sawtooth")\n  .gain(.3)\n\nstack(\n  kick,\n  pad,\n)\n');
  assert.deepEqual(getTrackPump(tune, T(tune, 'pad')).shared, ['kick']);
  assert.equal(pumpTrack(tune, T(tune, 'pad'), true), 2);
  assert.ok(T(tune, 'kick').chain.includes('.duckorbit("2")') && T(tune, 'kick').chain.includes('.duckdepth(".4")'));
  assert.equal(T(tune, 'pad').chain.at(-1), '.orbit(2)');
});

test('trim round trip keeps 3 decimals: no zero-length or collapsed slices', () => {
  const trimmed = (begin, end) => {
    const tune = parse(TUNE);
    setTrim(T(tune, 'kick'), begin, end);
    const kick = T(parse(gen(tune)), 'kick');
    return { begin: getParam(kick, 'begin') ?? 0, end: getParam(kick, 'end') ?? 1, chain: kick.chain };
  };
  const last = clampRange(1, 1, 'begin');
  assert.deepEqual(last, { begin: 0.995, end: 1 });
  const a = trimmed(last.begin, last.end);
  assert.deepEqual([a.begin, a.end], [0.995, 1]);
  assert.ok(a.chain.includes('.begin(.995)') && !a.chain.some((l) => l.startsWith('.end(')));
  const narrow = clampRange(0.336, 0.341, 'end');
  const b = trimmed(narrow.begin, narrow.end);
  assert.deepEqual([b.begin, b.end], [0.336, 0.341]);
  assert.ok(b.begin < b.end);
  assert.equal(num(0.3456), '.35'); // other params keep 2 decimals
  assert.equal(numAt(0.3456, 3), '.346');
});
