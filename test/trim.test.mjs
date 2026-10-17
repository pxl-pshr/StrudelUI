// Trim panel math (trim.js): the handle range and the waveform peaks. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRange, peaks } from '../trim.js';

test('clampRange keeps 0 <= begin < end <= 1, moving only the dragged handle', () => {
  assert.deepEqual(clampRange(0.1, 0.5, 'begin'), { begin: 0.1, end: 0.5 });
  assert.deepEqual(clampRange(-0.2, 1.3, 'end'), { begin: 0, end: 1 });
  assert.deepEqual(clampRange(0.9, 0.5, 'begin'), { begin: 0.495, end: 0.5 });
  assert.deepEqual(clampRange(0.5, 0.2, 'end'), { begin: 0.5, end: 0.505 });
  assert.deepEqual(clampRange(1, 1, 'begin'), { begin: 0.995, end: 1 });
  assert.deepEqual(clampRange(0.12345, 0.6789, 'end'), { begin: 0.123, end: 0.679 });
});

const fakeBuffer = (...channels) => ({
  numberOfChannels: channels.length,
  length: channels[0].length,
  getChannelData: (c) => Float32Array.from(channels[c]),
});

test('peaks: min / max per column across channels', () => {
  const p = peaks(fakeBuffer([0.5, -0.25, 0, 0], [0, 0, 0.75, -1]), 2);
  assert.deepEqual([...p], [-0.25, 0.5, -1, 0.75]);
  // more columns than samples: each column still reads one sample
  assert.deepEqual([...peaks(fakeBuffer([0.5, -0.5]), 4)], [0, 0.5, 0, 0.5, -0.5, 0, -0.5, 0]);
});
