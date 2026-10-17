// Zip writing and reading (zip.js), and finding the samples a tune uses (code.js soundsIn). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { zip, unzip } from '../zip.js';
import { soundsIn } from '../code.js';

const text = (blob) => blob.text();

test('zip → unzip round trip keeps paths (UTF-8) and bytes', async () => {
  const wav = new Uint8Array(1000).map((_, i) => i % 251);
  const z = await zip([
    { name: 'night drive.js', blob: new Blob(['setcpm(130/4)\n']) },
    { name: 'samples/shaker/Shaker 1.wav', blob: new Blob([wav]) },
    { name: 'samples/fx/röhre.wav', blob: new Blob([wav.slice(0, 10)]) },
  ]);
  const out = await unzip(z);
  assert.deepEqual(out.map((e) => e.path), ['night drive.js', 'samples/shaker/Shaker 1.wav', 'samples/fx/röhre.wav']);
  assert.equal(await text(out[0].blob), 'setcpm(130/4)\n');
  assert.deepEqual(new Uint8Array(await out[1].blob.arrayBuffer()), wav);
});

// a minimal zip with deflated entries, as an OS or another tool writes them
function deflatedZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [path, body] of entries) {
    const name = Buffer.from(path);
    const data = deflateRawSync(Buffer.from(body));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Blob([...parts, ...central, end]);
}

test('unzip reads deflated entries and skips folders and macOS metadata', async () => {
  const body = 'stack(s("shaker"))\n'.repeat(20);
  const out = await unzip(deflatedZip([
    ['tune/', ''],
    ['tune/tune.js', body],
    ['__MACOSX/tune/._tune.js', 'x'],
    ['tune/.DS_Store', 'x'],
  ]));
  assert.deepEqual(out.map((e) => e.path), ['tune/tune.js']);
  assert.equal(await text(out[0].blob), body);
  await assert.rejects(unzip(new Blob(['not a zip at all, just some text'])), /not a zip/);
});

test('soundsIn: names used in strings, whole words only', () => {
  const code = 'const a = s("shaker:2").bank("x")\nconst b = s("<tp_fx [hh shaker2]>")\n// kick_old\nconst shaker_x = 1\n';
  assert.deepEqual(soundsIn(code, ['shaker', 'shaker2', 'tp_fx', 'tp', 'kick_old', 'shaker_x', 'hat']), ['shaker', 'shaker2', 'tp_fx', 'kick_old']);
});
