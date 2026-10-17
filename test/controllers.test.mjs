// Controller mapping (controllers.js): reading MIDI, labels, renames, files. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidi, sourceId, MAPPABLE_KEY, continuous, targetLabel, sourceLabel, renameTarget, readMappings } from '../controllers.js';

test('a note-on is a press; note-offs and other messages are nothing', () => {
  assert.deepEqual(readMidi('pads', [0x99, 36, 100]), { source: { device: 'pads', note: 36, channel: 10 }, press: true, value: null });
  assert.equal(readMidi('pads', [0x89, 36, 0]), null);
  assert.equal(readMidi('pads', [0x99, 36, 0]), null); // note-on at velocity 0 is a note-off
  assert.equal(readMidi('pads', [0xf8]), null); // clock
  assert.equal(readMidi('pads', [0xe0, 0, 64]), null); // pitch bend
});

test('a CC is a value, and a press when it rises past the middle', () => {
  const last = {};
  const cc = (v) => readMidi('knobs', [0xb0, 21, v], last);
  assert.deepEqual(cc(0), { source: { device: 'knobs', cc: 21, channel: 1 }, press: false, value: 0 });
  assert.equal(cc(127).value, 1);
  assert.equal(last[sourceId({ device: 'knobs', cc: 21, channel: 1 })], 127);
  // a button sending 127 / 0: one press per push
  const btn = (v) => readMidi('knobs', [0xb3, 64, v], last).press;
  assert.deepEqual([btn(127), btn(127), btn(0), btn(127)], [true, false, false, true]);
});

test('sources are told apart by device, kind, number and channel', () => {
  const ids = new Set([
    sourceId({ device: 'a', note: 36, channel: 10 }),
    sourceId({ device: 'a', cc: 36, channel: 10 }),
    sourceId({ device: 'a', note: 36, channel: 1 }),
    sourceId({ device: 'b', note: 36, channel: 10 }),
    sourceId({ key: 'KeyQ' }),
  ]);
  assert.equal(ids.size, 5);
});

test('keys the app or browser use cannot be mapped', () => {
  for (const code of ['KeyQ', 'Digit1', 'Numpad5', 'NumpadAdd', 'Comma', 'Backquote']) assert.ok(MAPPABLE_KEY.test(code), code);
  for (const code of ['Space', 'BracketLeft', 'BracketRight', 'Enter', 'NumpadEnter', 'Escape', 'Tab', 'ArrowUp', 'F5', 'ShiftLeft']) assert.ok(!MAPPABLE_KEY.test(code), code);
});

test('sliders take knobs, everything else takes presses', () => {
  for (const t of ['bpm', 'pump', 'gain:kick', 'lpf:kick', 'room:kick', 'delay:kick', 'swingBy:kick']) assert.ok(continuous(t), t);
  for (const t of ['play', 'mute:kick', 'solo:kick', 'step:kick:3', 'page:1', 'scene:intro']) assert.ok(!continuous(t), t);
});

test('labels', () => {
  assert.equal(targetLabel('step:kick:3'), 'kick step 4');
  assert.equal(targetLabel('page:0'), 'bar 1');
  assert.equal(targetLabel('lpf:sub'), 'sub high cut');
  assert.equal(targetLabel('hpf:sub'), 'sub low cut');
  assert.equal(targetLabel('delay:sub'), 'sub delay');
  assert.equal(targetLabel('mute:hats'), 'hats mute');
  assert.equal(targetLabel('play'), 'play / stop');
  assert.equal(sourceLabel({ key: 'KeyQ' }), 'key q');
  assert.equal(sourceLabel({ key: 'Numpad7' }), 'key num 7');
  assert.equal(sourceLabel({ device: 'Launchkey', cc: 21, channel: 1 }), 'cc 21 · ch 1 · Launchkey');
});

test('renaming a track or scene renames its mappings, and nothing else', () => {
  assert.equal(renameTarget('step:kick:3', 'kick', 'boom'), 'step:boom:3');
  assert.equal(renameTarget('gain:kick', 'kick', 'boom'), 'gain:boom');
  assert.equal(renameTarget('scene:intro', 'intro', 'start'), 'scene:start');
  assert.equal(renameTarget('mute:kick2', 'kick', 'boom'), 'mute:kick2');
  assert.equal(renameTarget('play', 'play', 'x'), 'play');
});

test('a mappings file keeps what makes sense and drops the rest', () => {
  const file = {
    strudelui: 'controllers',
    version: 1,
    mappings: [
      { device: 'pads', note: 36, channel: 10, target: 'mute:kick' },
      { device: 'knobs', cc: 21, channel: 1, target: 'gain:kick', extra: 'dropped' },
      { key: 'KeyP', target: 'play' },
      { key: 'Space', target: 'play' }, // reserved key
      { device: 'pads', note: 200, channel: 1, target: 'play' }, // not a note
      { device: 'pads', note: 1, channel: 17, target: 'play' }, // no such channel
      { device: 'pads', note: 1, channel: 1, target: 'eval:alert(1)' }, // not a control
      { device: 'pads', cc: 1, note: 2, channel: 1, target: 'play' }, // both
      null,
    ],
  };
  assert.deepEqual(readMappings(file), [
    { device: 'pads', note: 36, channel: 10, target: 'mute:kick' },
    { device: 'knobs', cc: 21, channel: 1, target: 'gain:kick' },
    { key: 'KeyP', target: 'play' },
  ]);
  assert.throws(() => readMappings({ tune: 'nope' }), /not a StrudelUI controller mappings file/);
});
