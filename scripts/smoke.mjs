// Browser smoke test: the parts of StrudelUI that lean on Strudel's internals
// (editor events, scheduler, audio globals, the render frame), checked in a
// real headless Chrome. Run after updating Strudel: npm run smoke
//
// Needs Chrome (set CHROME=/path/to/chrome if it isn't found) and a network
// connection (sounds load from Strudel's sample collections).

import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!chromePath) {
  console.error('Chrome not found: set CHROME=/path/to/chrome');
  process.exit(2);
}

// ── a static server for the repo ──────────────────

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── Chrome over the DevTools protocol ─────────────

const profile = await mkdtemp(join(tmpdir(), 'strudelui-smoke-'));
// port 0: Chrome picks a free port and prints it on stderr; 30 s startup
// limit for slow CI runners
const chrome = spawn(chromePath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,900', // the desktop layout (phones get sheets and views)
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const devtools = new Promise((resolve, reject) => {
  let log = '';
  const limit = setTimeout(() => reject(new Error(`Chrome didn't start in 30 s${log ? `: ${log.trim().split('\n').pop()}` : ''}`)), 30000);
  chrome.stderr.on('data', (d) => {
    log += d;
    const m = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) {
      clearTimeout(limit);
      resolve(Number(m[1]));
    }
  });
  chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}) before starting: ${log.trim().split('\n').pop() ?? ''}`)));
});

let ws;
const pending = new Map();
const errors = [];
let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
// evaluate in the page; the expression can await
async function page(expression, timeout = 60000) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function open(url, ready) {
  errors.length = 0;
  await send('Page.navigate', { url });
  for (let i = 0; i < 120; i++) {
    await wait(500);
    if (await page(`return !!(${ready})`).catch(() => false)) return;
  }
  throw new Error(`${url} didn't get ready`);
}

const results = [];
async function check(name, run) {
  try {
    const detail = await run();
    results.push(['ok', name, detail ?? '']);
  } catch (err) {
    results.push(['FAIL', name, err.message.split('\n')[0]]);
  }
}

try {
  const port = await devtools;
  for (let i = 0; i < 40 && !ws; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const target = targets.find((t) => t.type === 'page');
      if (target) ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch {}
    if (!ws) await wait(250);
  }
  if (!ws) throw new Error(`Chrome started on port ${port} but has no page to drive`);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  // ── the app ──
  await check('app starts and loads its sounds', async () => {
    await open(`${base}/index.html`, `document.querySelector('#play')?.textContent.includes('play') && document.querySelector('#kit')?.options.length > 10`);
    const rows = await page(`return document.querySelectorAll('#rack .row').length`);
    if (!rows) throw new Error('no tracks on the grid');
    if (errors.length) throw new Error(errors[0]);
    return `${rows} tracks`;
  });

  await check('the Strudel globals the app relies on exist', async () => {
    const missing = await page(`return ['soundMap', 'samples', 'superdough', 'getAudioContext', 'setAudioContext', 'getSuperdoughAudioController', 'setSuperdoughAudioController', 'initAudio', 'aliasBank', 'getSampleBuffer'].filter((n) => !(n in globalThis))`);
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });

  await check('play: scheduler runs, playhead moves, no errors', async () => {
    const r = await page(`
      const ed = document.querySelector('strudel-editor').editor;
      document.querySelector('#play').click();
      await new Promise((r) => setTimeout(r, 2500));
      const out = { started: ed.repl.scheduler.started, now: document.querySelectorAll('.step.now').length, error: String(ed.repl.state.evalError ?? '') };
      document.querySelector('#play').click();
      await new Promise((r) => setTimeout(r, 300));
      out.stopped = !ed.repl.scheduler.started;
      return out;`);
    if (!r.started) throw new Error("the scheduler didn't start");
    if (!r.now) throw new Error("the playhead didn't move");
    if (r.error) throw new Error(r.error);
    if (!r.stopped) throw new Error("stop didn't stop");
    if (errors.length) throw new Error(errors[0]);
  });

  await check('a grid click writes code into the editor', async () => {
    const r = await page(`
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      const cell = document.querySelector('#rack .row .step:not(.on):not(.ro)');
      cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup'));
      await new Promise((r) => setTimeout(r, 300));
      const changed = cell.classList.contains('on') && ed.code !== before;
      document.querySelector('#undo').click();
      await new Promise((r) => setTimeout(r, 300));
      return { changed, undone: ed.code === before };`);
    if (!r.changed) throw new Error("a grid click didn't change the code");
    if (!r.undone) throw new Error("undo didn't restore the code");
  });

  await check('shortening a track while its later bar is shown keeps grid and edits on the same bar', async () => {
    const r = await page(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      const bar = (i) => '[' + Array.from({ length: 16 }, (_, j) => (j === i ? 'x' : '~')).join(' ') + ']';
      ed.setCode(before.replace('const kick =', 'const four = s("cp")\\n  .struct("<' + [0, 1, 2, 3].map(bar).join(' ') + '>")\\n  .orbit(9)\\n\\nconst kick =').replace('stack(\\n', 'stack(\\n  four,\\n'));
      await wait(700);
      document.querySelectorAll('#pager .page')[2].click();
      await wait(100);
      const row = () => document.querySelector('#rack .row[data-id="four"]');
      row().querySelector('.tog[aria-label="four options"]').click();
      await wait(100);
      [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.endsWith('length 2 bars')).click();
      await wait(300);
      const shown = [...document.querySelectorAll('#pager .page')].findIndex((b) => b.classList.contains('on')) + 1;
      const tag = row().querySelector('.bars-tag').textContent;
      const on = [...row().querySelectorAll('.step')].findIndex((c) => c.classList.contains('on'));
      const cells = row().querySelectorAll('.step');
      cells[5].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup'));
      await wait(300);
      // the steps lit in each bar of the four track's code
      const struct = ed.code.split('\\n').find((l) => l.includes('.struct("<'));
      const lit = (struct.match(/\\[[^\\]]*\\]/g) ?? []).map((b) => b.slice(1, -1).trim().split(/\\s+/).flatMap((t, i) => (t === 'x' ? [i] : [])));
      ed.setCode(before);
      await wait(500);
      return { shown, tag, on, lit };`);
    if (r.shown !== 2 || r.tag !== '2/2' || r.on !== 1) throw new Error(`shows bar ${r.shown}, tag ${r.tag}, step ${r.on + 1} lit (want bar 2, 2/2, step 2)`);
    if (JSON.stringify(r.lit) !== '[[0],[1,5]]') throw new Error(`steps per bar after the click: ${JSON.stringify(r.lit)} (want [[0],[1,5]])`);
  });

  await check('export uses the samples the tune registers with samples(…): new names and redefined built-ins', async () => {
    const r = await page(`
      const wav = (f) => {
        const sr = 44100, n = 8820, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
        v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * f) * 20000, true);
        return new Blob([buf], { type: 'audio/wav' });
      };
      const ex = await import('/export.js');
      const code = await import('/code.js');
      const ed = document.querySelector('strudel-editor').editor;
      const casio = soundMap.get().casio; // the built-in, put back afterwards
      const tone = URL.createObjectURL(wav(0.05));
      const silent = URL.createObjectURL(wav(0));
      // a new name (a tone), a built-in redefined as silence, and an untouched built-in;
      // single quotes: a double-quoted string in tune code is mini-notation
      const tune = "samples({ review_only: ['" + tone + "'], casio: ['" + silent + "'] })\\nsetcpm(120/4)\\n\\n" +
        "const hit = s(\\"review_only\\")\\n  .struct(\\"x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~\\")\\n  .orbit(1)\\n\\n" +
        "const over = s(\\"casio\\")\\n  .struct(\\"x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~\\")\\n  .orbit(2)\\n\\n" +
        "const kick = s(\\"bd\\").bank(\\"RolandTR909\\")\\n  .struct(\\"x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~\\")\\n  .orbit(3)\\n\\n" +
        "stack(\\n  hit,\\n  over,\\n  kick,\\n)\\n";
      let error = '', haps = [], mix = null, stems = [];
      try {
        await ed.repl.evaluate(tune, false);
        const st = ed.repl.state, cps = ed.repl.scheduler.cps;
        error = String(st.evalError ?? '');
        haps = error ? [] : ex.collect(st.pattern, 1, cps);
        mix = haps.length ? await ex.renderMix(haps, 1, cps) : null;
        stems = haps.length ? await ex.renderStems(haps, code.parse(tune).tracks, 1, cps) : [];
      } finally {
        soundMap.setKey('casio', casio);
        await ed.repl.evaluate(ed.code, false);
      }
      return {
        error, sounds: [...new Set(haps.map((h) => h.value.s))].sort(),
        mixDb: mix && ex.peakDb(mix), failed: [...(mix?.failed ?? []), ...(stems.failed ?? [])].map(([r]) => r),
        stemDb: Object.fromEntries(stems.map((s) => [s.name, ex.peakDb(s.buffer)])),
      };`, 120000);
    if (r.error) throw new Error(r.error);
    if (r.sounds.join() !== 'bd,casio,review_only') throw new Error(`the test tune played ${r.sounds.join(', ')}`);
    if (r.failed.length) throw new Error(`notes failed: ${r.failed.join('; ')}`);
    if (!(r.mixDb > -30)) throw new Error(`the mix is silent (peak ${r.mixDb} dB)`);
    const db = (id) => (r.stemDb[id] == null ? 'silent' : r.stemDb[id].toFixed(1));
    if (!(r.stemDb.hit > -30)) throw new Error(`the new sample's stem is silent (${db('hit')} dB)`);
    if (!('over' in r.stemDb)) throw new Error('no stem for the redefined casio');
    if (r.stemDb.over != null && r.stemDb.over > -60) throw new Error(`the redefined casio played the built-in (${db('over')} dB)`);
    if (!(r.stemDb.kick > -30)) throw new Error(`the built-in kick's stem is silent (${db('kick')} dB)`);
    return `new ${db('hit')} dB · redefined ${db('over')} · built-in ${db('kick')} dB`;
  });

  await check('deleting an imported sample unregisters it (or restores the built-in it replaced); undo brings it back', async () => {
    const r = await page(`
      const wav = (f) => {
        const sr = 44100, n = 8820, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
        v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * f) * 20000, true);
        return new Blob([buf], { type: 'audio/wav' });
      };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const sounds = await import('/sounds.js');
      await sounds.addFiles([{ file: new File([wav(0.08)], 'zz_review 1.wav'), path: 'zz_review 1.wav' }]);
      await sounds.sampleBuffer({ name: 'zz_review' }); // decoded and cached
      const added = sounds.hasSound('zz_review');
      const rec = await sounds.removeUserSound('zz_review');
      const gone = !sounds.hasSound('zz_review') && !sounds.catalog().some((i) => i.key === 'zz_review');
      const buffer = await sounds.sampleBuffer({ name: 'zz_review' });
      await sounds.restoreUserSound(rec);
      const back = sounds.hasSound('zz_review') && sounds.catalog().some((i) => i.key === 'zz_review' && i.group === 'yours');
      await sounds.removeUserSound('zz_review');
      // a sample named like a built-in replaces it; deleting it brings the built-in back
      const builtIn = soundMap.get().casio;
      await sounds.addFiles([{ file: new File([wav(0.03)], 'casio 1.wav'), path: 'casio 1.wav' }]);
      const replaced = soundMap.get().casio !== builtIn && sounds.catalog().some((i) => i.key === 'casio' && i.group === 'yours');
      await sounds.removeUserSound('casio');
      const restored = soundMap.get().casio === builtIn;
      return { added, gone, cached: !!buffer, back, replaced, restored };`);
    if (!r.added) throw new Error("the import didn't register");
    if (!r.gone) throw new Error('still registered after delete');
    if (r.cached) throw new Error('its decoded audio still plays after delete');
    if (!r.back) throw new Error("undo didn't bring it back");
    if (!r.replaced) throw new Error("a sample named casio didn't replace the built-in");
    if (!r.restored) throw new Error("deleting it didn't bring the built-in casio back");
  });

  await check('opening a tune zip keeps its sample numbers when a sound of that name has other files', async () => {
    const r = await page(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const wav = (f) => {
        const sr = 44100, n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
        v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * f) * 20000, true);
        return new Blob([buf], { type: 'audio/wav' });
      };
      const sounds = await import('/sounds.js');
      const { zip } = await import('/zip.js');
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      let result;
      try {
        // a user sound over a built-in must survive the rename check's second engine (its prebake)
        await sounds.addFiles([{ file: new File([wav(0.05)], 'c.wav', { type: 'audio/wav' }), path: 'samples/casio/c.wav' }]);
        await sounds.addFiles([{ file: new File([wav(0.05)], 'a.wav', { type: 'audio/wav' }), path: 'samples/review_pack/a.wav' }]);
        const tune = '// review zip\\nsetcpm(120/4)\\n\\nconst hit = s("review_pack:0")\\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\\n\\nstack(\\n  hit,\\n)\\n';
        const z = await zip([{ name: 'review.js', blob: new Blob([tune]) }, { name: 'samples/review_pack/z.wav', blob: wav(0.11) }]);
        const drop = async () => {
          const dt = new DataTransfer();
          dt.items.add(new File([z], 'review.zip', { type: 'application/zip' }));
          document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          // the first rename check builds the second engine (its prebake loads the sample maps)
          for (let i = 0; i < 150 && !ed.code.startsWith('// review zip'); i++) await wait(100);
          await wait(300);
        };
        const names = async (n) => (await sounds.userSoundFiles(n)).map((f) => f.name).join();
        await drop();
        const first = { uses: (ed.code.match(/s\\("([^"]+)"\\)/) ?? [])[1], pack: await names('review_pack'), pack2: await names('review_pack_2'), casio: String(soundMap.get().casio?.data?.samples?.[0] ?? '') };
        document.querySelector('#undo').click();
        await wait(300);
        await drop(); // the same zip again: reuses review_pack_2
        const again = { uses: (ed.code.match(/s\\("([^"]+)"\\)/) ?? [])[1], all: sounds.userSoundNames().filter((n) => n.startsWith('review_pack')).sort().join() };
        document.querySelector('#undo').click();
        await wait(300);
        result = { first, again };
      } finally {
        for (let i = 0; i < 4 && ed.code !== before; i++) {
          document.querySelector('#undo').click();
          await new Promise((r) => setTimeout(r, 300));
        }
        for (const n of ['review_pack', 'review_pack_2', 'review_pack_3', 'casio']) await sounds.removeUserSound(n).catch(() => {});
      }
      return { ...result, restored: ed.code === before };`);
    if (r.first.uses !== 'review_pack_2:0') throw new Error(`the tune plays ${r.first.uses}, not review_pack_2:0`);
    if (!r.first.casio.startsWith('blob:')) throw new Error(`the user casio was replaced by the built-in after the zip opened: ${r.first.casio || 'gone'}`);
    if (r.first.pack !== 'a.wav') throw new Error(`the existing review_pack changed: ${r.first.pack}`);
    if (r.first.pack2 !== 'z.wav') throw new Error(`review_pack_2 holds ${r.first.pack2}, not z.wav`);
    if (r.again.uses !== 'review_pack_2:0' || r.again.all !== 'review_pack,review_pack_2') throw new Error(`opening it again gave ${r.again.uses} with ${r.again.all}`);
    if (!r.restored) throw new Error("undo didn't bring the tune back");
    return 'review_pack:0 → review_pack_2:0, reused on a second open';
  });

  await check('opening a tune zip compares sample contents: same name and size but other audio gets its own sound', async () => {
    const r = await page(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const wav = (f) => {
        const sr = 44100, n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
        v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * f) * 20000, true);
        return new Blob([buf], { type: 'audio/wav' });
      };
      const sounds = await import('/sounds.js');
      const { zip } = await import('/zip.js');
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      let result;
      try {
        const mine = wav(0.05);
        await sounds.addFiles([{ file: new File([mine], 'hit.wav', { type: 'audio/wav' }), path: 'samples/review_equal/hit.wav' }]);
        const tune = '// review equal\\nsetcpm(120/4)\\n\\nconst hit = s("review_equal:0")\\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\\n\\nstack(\\n  hit,\\n)\\n';
        const open = async (blob) => {
          const z = await zip([{ name: 'review.js', blob: new Blob([tune]) }, { name: 'samples/review_equal/hit.wav', blob }]);
          const dt = new DataTransfer();
          dt.items.add(new File([z], 'review.zip', { type: 'application/zip' }));
          document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          for (let i = 0; i < 40 && !ed.code.startsWith('// review equal'); i++) await wait(100);
          await wait(300);
          const out = { uses: (ed.code.match(/s\\("([^"]+)"\\)/) ?? [])[1], all: sounds.userSoundNames().filter((n) => n.startsWith('review_equal')).sort().join() };
          document.querySelector('#undo').click();
          await wait(300);
          return out;
        };
        const other = wav(0.07);
        const sameSize = other.size === mine.size;
        const differs = await open(other); // other audio, same name and size
        const identical = await open(new Blob([await mine.arrayBuffer()], { type: 'audio/wav' }));
        result = { sameSize, differs, identical };
      } finally {
        for (let i = 0; i < 4 && ed.code !== before; i++) {
          document.querySelector('#undo').click();
          await new Promise((r) => setTimeout(r, 300));
        }
        for (const n of ['review_equal', 'review_equal_2']) await sounds.removeUserSound(n).catch(() => {});
      }
      return { ...result, restored: ed.code === before };`);
    if (!r.sameSize) throw new Error('the test files differ in size');
    if (r.differs.uses !== 'review_equal_2:0' || r.differs.all !== 'review_equal,review_equal_2') throw new Error(`other audio opened as ${r.differs.uses} with ${r.differs.all}`);
    if (r.identical.uses !== 'review_equal:0') throw new Error(`identical audio opened as ${r.identical.uses}, not the existing review_equal:0`);
    if (!r.restored) throw new Error("undo didn't bring the tune back");
    return 'other audio → review_equal_2, identical → review_equal';
  });

  await check('tune zips: a constant used only as a sound is renamed, a shared one is left with a warning; download includes bank-qualified samples', async () => {
    const r = await page(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const wav = (f) => {
        const sr = 44100, n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
        v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * f) * 20000, true);
        return new Blob([buf], { type: 'audio/wav' });
      };
      const sounds = await import('/sounds.js');
      const { zip, unzip } = await import('/zip.js');
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      const out = {};
      const click = HTMLAnchorElement.prototype.click;
      try {
        // a zip whose tune names its sound through a constant
        await sounds.addFiles([{ file: new File([wav(0.05)], 'a.wav', { type: 'audio/wav' }), path: 'samples/review_indirect/a.wav' }]);
        const tune = '// review indirect\\nsetcpm(120/4)\\n\\nconst chosen = "review_indirect"\\n\\nconst hit = s(chosen)\\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\\n\\nstack(\\n  hit,\\n)\\n';
        const z = await zip([{ name: 'review.js', blob: new Blob([tune]) }, { name: 'samples/review_indirect/z.wav', blob: wav(0.11) }]);
        const dt = new DataTransfer();
        dt.items.add(new File([z], 'review.zip', { type: 'application/zip' }));
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        for (let i = 0; i < 40 && !ed.code.startsWith('// review indirect'); i++) await wait(100);
        await ed.repl.evaluate(ed.code, false);
        out.plays = [...new Set(ed.repl.state.pattern.queryArc(0, 1).map((h) => h.value.s))].join();
        out.warned = document.querySelector('#status').classList.contains('err') || /couldn't safely rename/.test(document.querySelector('#status').textContent);
        document.querySelector('#undo').click();
        await wait(300);

        // a constant shared by s(…) and a scale: left alone (the bass keeps its notes), with a warning
        await sounds.addFiles([{ file: new File([wav(0.05)], 'a.wav', { type: 'audio/wav' }), path: 'samples/minor/a.wav' }]);
        const shared = "// review shared\\nsetcpm(120/4)\\n\\nconst chosen = 'minor'\\n\\nconst bass = n(\\"0 2 4\\").scale('C3:' + chosen).s(\\"sawtooth\\")\\n\\nconst hit = s(chosen)\\n  .struct(\\"x ~ ~ ~\\")\\n\\nstack(\\n  bass,\\n  hit,\\n)\\n";
        const notes = async () => {
          await ed.repl.evaluate(ed.code, false);
          return ed.repl.state.pattern.queryArc(0, 1).filter((h) => h.value.s === 'sawtooth').map((h) => h.value.note).join();
        };
        const z2 = await zip([{ name: 'review.js', blob: new Blob([shared]) }, { name: 'samples/minor/z.wav', blob: wav(0.11) }]);
        const dt3 = new DataTransfer();
        dt3.items.add(new File([z2], 'review.zip', { type: 'application/zip' }));
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt3, bubbles: true, cancelable: true }));
        for (let i = 0; i < 40 && !ed.code.startsWith('// review shared'); i++) await wait(100);
        await wait(300);
        out.shared = { same: ed.code === shared, notes: await notes(), warned: document.querySelector('#status').classList.contains('err'), imported: sounds.userSoundNames().includes('minor_2') };
        document.querySelector('#undo').click();
        await wait(300);

        // download with samples: s("hh").bank("reviewbank") plays the user sound reviewbank_hh
        await sounds.addFiles([{ file: new File([wav(0.05)], 'hit.wav', { type: 'audio/wav' }), path: 'samples/reviewbank_hh/hit.wav' }]);
        const banked = '// review bank\\nsetcpm(120/4)\\n\\nconst hats = s("hh").bank("reviewbank")\\n  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")\\n\\nstack(\\n  hats,\\n)\\n';
        const dt2 = new DataTransfer();
        dt2.items.add(new File([banked], 'review-bank.js', { type: 'text/javascript' }));
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true }));
        for (let i = 0; i < 40 && !ed.code.startsWith('// review bank'); i++) await wait(100);
        await wait(300);
        let blob = null;
        HTMLAnchorElement.prototype.click = function () { if (this.download?.endsWith('.zip')) blob = fetch(this.href).then((r) => r.blob()); else click.call(this); };
        document.querySelector('#file').click();
        await wait(150);
        [...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.startsWith('download with samples')).click();
        for (let i = 0; i < 40 && !blob; i++) await wait(100);
        out.zipped = blob ? (await unzip(await blob)).map((e) => e.path).sort().join() : 'no download';
        document.querySelector('#undo').click();
        await wait(300);

        // a zip whose sound the tune only plays through .bank(): hh is a built-in
        // here, so its samples go under hh_2, the code stays, and that's no warning
        const z3 = await zip([{ name: 'review.js', blob: new Blob([banked]) }, { name: 'samples/hh/z.wav', blob: wav(0.11) }]);
        const dt4 = new DataTransfer();
        dt4.items.add(new File([z3], 'review.zip', { type: 'application/zip' }));
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt4, bubbles: true, cancelable: true }));
        for (let i = 0; i < 100 && !ed.code.startsWith('// review bank'); i++) await wait(100);
        await wait(300);
        const st = document.querySelector('#status');
        out.bankOnly = { same: ed.code === banked, warned: st.classList.contains('err'), text: st.textContent, imported: sounds.userSoundNames().includes('hh_2') };
      } finally {
        HTMLAnchorElement.prototype.click = click;
        for (let i = 0; i < 4 && ed.code !== before; i++) {
          document.querySelector('#undo').click();
          await new Promise((r) => setTimeout(r, 300));
        }
        for (const n of ['review_indirect', 'review_indirect_2', 'minor', 'minor_2', 'reviewbank_hh', 'hh_2']) await sounds.removeUserSound(n).catch(() => {});
      }
      out.restored = ed.code === before;
      return out;`);
    if (r.plays !== 'review_indirect_2') throw new Error(`the tune plays ${r.plays}, not review_indirect_2`);
    if (r.warned) throw new Error('warned about a rename that was complete');
    const sh = r.shared;
    if (!sh.same) throw new Error('a constant shared with a scale was rewritten');
    if (sh.notes !== 'C3,Eb3,G3') throw new Error(`the bass plays ${sh.notes}, not C3,Eb3,G3`);
    if (!sh.warned || !sh.imported) throw new Error(`shared constant: warned ${sh.warned}, minor_2 imported ${sh.imported}`);
    if (!/samples\/reviewbank_hh\/hit\.wav/.test(r.zipped)) throw new Error(`the zip holds ${r.zipped}`);
    const bo = r.bankOnly;
    if (!bo.same || bo.warned || !/hh samples are under hh_2/.test(bo.text) || !bo.imported) throw new Error(`bank-only sound: code kept ${bo.same}, warned ${bo.warned}, hh_2 imported ${bo.imported} · status: ${bo.text}`);
    if (!r.restored) throw new Error("undo didn't bring the tune back");
    return `s(chosen) → review_indirect_2 · zip: ${r.zipped} · bank-only hh → hh_2, no warning`;
  });

  await check('+ track → sample adds a track and opens the picker with "import files…"', async () => {
    const r = await page(`
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      document.querySelector('#add-track').click();
      [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.startsWith('sample')).click();
      await new Promise((r) => setTimeout(r, 300));
      const out = {
        row: !!document.querySelector('#rack .row[data-id="sample"]'),
        picker: [...document.querySelectorAll('.picker-foot button')].some((b) => b.textContent.startsWith('import')),
      };
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.querySelector('#undo').click();
      await new Promise((r) => setTimeout(r, 300));
      out.undone = ed.code === before;
      return out;`);
    if (!r.row) throw new Error("the sample track wasn't added");
    if (!r.picker) throw new Error("the picker didn't open with an import link");
    if (!r.undone) throw new Error("undo didn't remove the track");
  });

  await check('trim: right-click a sound shows its waveform, a handle writes .begin()', async () => {
    const r = await page(`
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      const chip = document.querySelector('#rack .row .chip');
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const panel = document.querySelector('.trim-panel');
      if (!panel) return { panel: false };
      for (let i = 0; i < 100 && panel.querySelector('.trim-msg'); i++) await new Promise((r) => setTimeout(r, 100));
      const loaded = !panel.querySelector('.trim-msg');
      const start = panel.querySelector('.trim-handle');
      start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const wrote = /\\.begin\\(\\.1\\)/.test(ed.code);
      document.querySelector('#undo').click();
      await new Promise((r) => setTimeout(r, 200));
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return { panel: true, loaded, msg: panel.querySelector('.trim-msg')?.textContent, wrote, undone: ed.code === before };`);
    if (!r.panel) throw new Error("right-click on a sound didn't open the trim panel");
    if (!r.loaded) throw new Error(`the waveform didn't load (${r.msg})`);
    if (!r.wrote) throw new Error("moving the start handle didn't write .begin()");
    if (!r.undone) throw new Error("undo didn't restore the code");
  });

  await check('export renders a mix and stems with sound', async () => {
    const r = await page(`
      const ex = await import('/export.js');
      const code = await import('/code.js');
      const ed = document.querySelector('strudel-editor').editor;
      await ed.repl.evaluate(ed.code, false);
      const st = ed.repl.state, cps = ed.repl.scheduler.cps;
      const haps = ex.collect(st.pattern, 1, cps);
      const mix = await ex.renderMix(haps, 1, cps);
      const stems = await ex.renderStems(haps, code.parse(st.activeCode).tracks, 1, cps);
      return { mixDb: ex.peakDb(mix), failed: mix.failed.length, stems: stems.length, loud: stems.filter((s) => ex.peakDb(s.buffer) > -60).length, frames: document.querySelectorAll('iframe').length };`, 120000);
    if (!(r.mixDb > -40)) throw new Error(`the mix is silent (peak ${r.mixDb} dB)`);
    if (r.failed) throw new Error(`${r.failed} kinds of notes failed to play`);
    if (!r.stems || r.loud < r.stems) throw new Error(`${r.stems - r.loud} of ${r.stems} stems are silent`);
    if (r.frames) throw new Error('a render frame was left behind');
    return `mix peak ${r.mixDb.toFixed(1)} dB, ${r.stems} stems`;
  });

  await check('export keeps reverb and delay tails (mix and stems)', async () => {
    const r = await page(`
      const ex = await import('/export.js');
      const clap = (fx) => [{ value: { s: 'cp', bank: 'RolandTR909', gain: 0.6, orbit: 6, ...fx }, begin: 0, duration: 1 / 16, at: 0 }];
      // RMS in dB from 0.5 s on, after the dry clap has died away
      const tail = (b) => {
        let sum = 0, n = 0;
        for (let c = 0; c < b.numberOfChannels; c++) {
          const d = b.getChannelData(c);
          for (let i = Math.floor(b.sampleRate * 0.5); i < d.length; i++, n++) sum += d[i] * d[i];
        }
        return 10 * Math.log10(sum / n || 1e-20);
      };
      const cps = 0.5;
      const dry = tail(await ex.renderMix(clap({}), 1, cps));
      const room = tail(await ex.renderMix(clap({ room: 3 }), 1, cps));
      const delay = tail(await ex.renderMix(clap({ delay: 0.6, delaytime: 0.25, delayfeedback: 0.5 }), 1, cps));
      const [stem] = await ex.renderStems(clap({ room: 3 }), [{ id: 'cp', range: [0, 1] }], 1, cps);
      return { dry, room, delay, stem: tail(stem.buffer) };`, 120000);
    const db = (x) => x.toFixed(1);
    const summary = `tail dry ${db(r.dry)} · room ${db(r.room)} · delay ${db(r.delay)} · room stem ${db(r.stem)} dB`;
    const flat = ['room', 'delay', 'stem'].filter((k) => !(r[k] > r.dry + 20));
    if (flat.length) throw new Error(`no ${flat.join('/')} tail: ${summary}`);
    return summary;
  });

  await check('settings → helpers and keys switch the editor (autocomplete with docs, wrap lines, vim)', async () => {
    const r = await page(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = document.querySelector('strudel-editor').editor.editor;
      const before = cm.state.doc.toString();
      const press = async (label) => {
        document.querySelector('#settings').click();
        await wait(150);
        [...document.querySelectorAll('.settings-panel button')].find((b) => b.textContent === label).click();
        await wait(150);
      };
      await press('autocomplete');
      await press('wrap lines');
      const end = cm.state.doc.length;
      cm.focus();
      cm.dispatch({ changes: { from: end, insert: '\\nnote("c").lp' }, selection: { anchor: end + 13 }, userEvent: 'input.type' });
      let info = null;
      for (let i = 0; i < 20 && !info; i++) {
        await wait(100);
        info = document.querySelector('.cm-completionInfo .autocomplete-info-function-name')?.textContent ?? null;
      }
      const out = { info, wrapped: !!document.querySelector('#editor .cm-lineWrapping') };
      await press('vim');
      cm.focus();
      await wait(150);
      out.vim = !!document.querySelector('#editor .cm-fat-cursor');
      // back to the defaults and the tune as it was
      await press('autocomplete');
      await press('wrap lines');
      await press('codemirror');
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: before } });
      return out;`);
    if (!r.info) throw new Error('no autocomplete docs for .lp');
    if (!r.wrapped) throw new Error("wrap lines didn't wrap");
    if (!r.vim) throw new Error("keys → vim didn't switch the keymap");
    return `docs for ${r.info}`;
  });

  await check('every demo in file → demos… opens onto the grid and evaluates', async () => {
    const r = await page(`
      const ed = document.querySelector('strudel-editor').editor;
      const code = await import('/code.js');
      const pick = async (label) => {
        [...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent === label).click();
        await new Promise((r) => setTimeout(r, 200));
      };
      document.querySelector('#file').click();
      await new Promise((r) => setTimeout(r, 200));
      await pick('demos…');
      const names = [...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent);
      const bad = [];
      for (const name of names) {
        document.querySelector('#file').click();
        await new Promise((r) => setTimeout(r, 200));
        await pick('demos…');
        await pick(name);
        await new Promise((r) => setTimeout(r, 800));
        if (!document.querySelector('#file').textContent.startsWith(name)) { bad.push(name + ": didn't open"); continue; }
        const codeOnly = code.parse(ed.code).tracks.filter((t) => t.kind === 'code').map((t) => t.id);
        if (codeOnly.length) bad.push(name + ': code-only tracks ' + codeOnly.join(', '));
        await ed.repl.evaluate(ed.code, false);
        if (ed.repl.state.evalError) bad.push(name + ': ' + (ed.repl.state.evalError.message ?? ed.repl.state.evalError));
      }
      return { names, bad };`);
    if (!r.names.length) throw new Error('no demos in the menu');
    if (r.bad.length) throw new Error(r.bad.join('; '));
    return r.names.join(', ');
  });

  await check('dragging a slider keeps the code\'s inline widgets (visuals demo, playing)', async () => {
    const r = await page(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const ed = document.querySelector('strudel-editor').editor;
      const before = ed.code;
      const widgets = () => [...document.querySelector('#editor .cm-content').children].filter((c) => !c.classList.contains('cm-line')).length;
      const out = {};
      try {
        document.querySelector('#file').click();
        await wait(200);
        [...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent === 'demos…').click();
        await wait(200);
        [...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent === 'visuals demo').click();
        await wait(1500);
        document.querySelector('#play').click();
        for (let i = 0; i < 40 && widgets() < 6; i++) await wait(100);
        out.before = widgets();
        const slider = [...document.querySelectorAll('#rack .row')].find((r) => r.textContent.includes('lead')).querySelectorAll('input[type=range]')[1];
        const counts = [];
        for (let i = 0; i < 15; i++) {
          slider.value = String(Number(slider.value) - (Number(slider.max) - Number(slider.min)) / 60);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(20); // faster than the 60 ms re-evaluate: only the code write runs
          counts.push(widgets());
        }
        out.during = Math.min(...counts);
        out.changed = ed.code !== before;
      } finally {
        if (ed.repl.scheduler.started) document.querySelector('#play').click();
        await wait(300);
        for (let i = 0; i < 20 && ed.code !== before; i++) {
          document.querySelector('#undo').click();
          await wait(100);
        }
      }
      return out;`);
    if (!(r.before >= 6)) throw new Error(`only ${r.before} widgets drew`);
    if (!r.changed) throw new Error("the slider didn't change the code");
    if (r.during < r.before) throw new Error(`widgets dropped from ${r.before} to ${r.during} during the drag`);
    return `${r.before} widgets, ${r.during} during the drag`;
  });

  await check("a tune from a link waits for play: opening (or reloading) doesn't run its code", async () => {
    const appReady = `document.querySelector('#play')?.textContent.includes('play') && document.querySelector('#kit')?.options.length > 10`;
    // a code-only track (shown by running the code) and a line that leaves a mark when it runs
    const tune = '// review link\nglobalThis.reviewRan = (globalThis.reviewRan ?? 0) + 1\nsetcpm(120/4)\n\nconst chirp = s("bd*4").every(2, (x) => x.fast(2))\n\nstack(\n  chirp,\n)\n';
    const link = `${base}/index.html#code=${encodeURIComponent(Buffer.from(tune).toString('base64'))}`;
    let r;
    try {
      await open(link, appReady);
      await new Promise((res) => setTimeout(res, 1500));
      const opened = await page(`return { ran: globalThis.reviewRan ?? 0, loaded: document.querySelector('strudel-editor').editor.code.startsWith('// review link'), status: document.querySelector('#status').textContent }`);
      await open(`${base}/index.html`, appReady); // a reload: the held tune is the autosave now
      await new Promise((res) => setTimeout(res, 1500));
      const reloaded = await page(`return { ran: globalThis.reviewRan ?? 0, loaded: document.querySelector('strudel-editor').editor.code.startsWith('// review link') }`);
      const played = await page(`
        document.querySelector('#play').click();
        await new Promise((r) => setTimeout(r, 1500));
        const ran = globalThis.reviewRan ?? 0;
        document.querySelector('#play').click();
        await new Promise((r) => setTimeout(r, 300));
        return { ran, held: JSON.parse(localStorage.getItem('beats-ui-v2'))?.held ?? false };`);
      r = { opened, reloaded, played };
    } finally {
      await page(`localStorage.clear(); return true`).catch(() => {});
      await open(`${base}/index.html`, appReady);
    }
    if (!r.opened.loaded) throw new Error("the link's tune didn't load");
    if (r.opened.ran) throw new Error('opening the link ran its code');
    if (!/runs when you press play/.test(r.opened.status)) throw new Error(`no hint in the status: ${r.opened.status}`);
    if (!r.reloaded.loaded || r.reloaded.ran) throw new Error(`after a reload: loaded ${r.reloaded.loaded}, ran ${r.reloaded.ran}`);
    if (r.played.ran < 1) throw new Error("play didn't run the code");
    if (r.played.held) throw new Error('still held after play');
    return 'held through open and reload, runs on play';
  });

  await check('Hydra\'s canvas goes behind the code panel at its size, and goes when the code stops using it or another tune opens', async () => {
    // a stand-in for the canvas initHydra() adds to <body> (the real one loads hydra-synth from unpkg)
    const r = await page(`
      const c = document.createElement('canvas');
      c.id = 'hydra-canvas';
      c.width = innerWidth;
      c.height = innerHeight;
      c.style = 'pointer-events:none;width:100%;height:100%;position:fixed;top:0;left:0';
      document.body.prepend(c);
      await new Promise((r) => setTimeout(r, 100));
      const panel = document.querySelector('.code-wrap');
      const box = c.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const out = {
        inPanel: c.parentElement === panel,
        size: [c.width, c.height].join() === [panel.clientWidth, panel.clientHeight].join(),
        covers: Math.abs(box.left - p.left) < 2 && Math.abs(box.width - p.width) < 2,
        behind: getComputedStyle(c).zIndex === '-1',
      };
      // evaluating code without initHydra() clears it; so does opening another tune
      const ed = document.querySelector('strudel-editor').editor;
      await ed.repl.evaluate(ed.code, false);
      out.clearedByEval = !document.getElementById('hydra-canvas');
      document.body.prepend(c);
      await new Promise((r) => setTimeout(r, 50));
      const before = ed.code;
      document.querySelector('#file').click();
      await new Promise((r) => setTimeout(r, 100));
      [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.startsWith('new')).click();
      await new Promise((r) => setTimeout(r, 300));
      out.clearedByNew = !document.getElementById('hydra-canvas');
      document.querySelector('#undo').click();
      await new Promise((r) => setTimeout(r, 300));
      out.restored = ed.code === before;
      c.remove();
      return out;`);
    for (const [k, ok] of Object.entries(r)) if (!ok) throw new Error(`${k}: ${JSON.stringify(r)}`);
  });

  // ── phones ──
  await check('phone: views, the track sheet, and touch on steps (tap sets, a drag paints, scrolls don\'t)', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    try {
      await open(`${base}/index.html`, `document.querySelector('#play')?.textContent.includes('play') && document.querySelectorAll('#mix-rows .mix-row').length > 0`);
      const r = await page(`
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const ed = document.querySelector('strudel-editor').editor;
        const before = ed.code;
        const shown = (sel) => !!document.querySelector(sel)?.getClientRects().length;
        const tab = async (name) => {
          document.querySelector('#tabs [data-tab="' + name + '"]').click();
          await wait(50);
          return { rack: shown('#rack'), mixer: shown('#mixer'), code: shown('#editor') };
        };
        const views = { song: await tab('song'), code: await tab('code'), grid: await tab('grid') };

        // touch: a tap sets a step, a drag along the row paints; a scroll sets
        // nothing (Safari cancels the touch, the finger goes more up or down
        // than sideways, or the touch stops a scroll still gliding)
        const row = document.querySelector('#rack .row:not(:has(.ro))');
        const id = row.dataset.id;
        const cells = [...row.querySelectorAll('.step')];
        const off = cells.findIndex((c, i) => !c.classList.contains('on') && !cells[i + 1]?.classList.contains('on') && i < 15);
        const mid = (el, dx = 0, dy = 0) => {
          const r = el.getBoundingClientRect();
          return { clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 + dy };
        };
        const touch = (target, type, at) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerType: 'touch', ...at }));
        const nothing = () => !cells[off].classList.contains('on') && !cells[off + 1].classList.contains('on') && ed.code === before;
        const scrolls = [];
        touch(cells[off], 'pointerdown', mid(cells[off]));
        touch(window, 'pointercancel');
        await wait(200);
        scrolls.push(nothing());
        touch(cells[off], 'pointerdown', mid(cells[off]));
        touch(cells[off + 1], 'pointerenter', mid(cells[off], 21, -15)); // a scroll that starts with a sideways drift
        touch(window, 'pointermove', mid(cells[off], 21, -15));
        touch(window, 'pointerup', mid(cells[off], 25, -60));
        await wait(200);
        scrolls.push(nothing());
        window.dispatchEvent(new Event('scroll'));
        touch(cells[off], 'pointerdown', mid(cells[off]));
        touch(window, 'pointerup', mid(cells[off]));
        await wait(300);
        scrolls.push(nothing());
        const scrolled = scrolls.join() !== 'true,true,true' && scrolls.join();
        touch(cells[off], 'pointerdown', mid(cells[off]));
        touch(window, 'pointerup', mid(cells[off], 3, 2));
        await wait(200);
        const tapped = cells[off].classList.contains('on');
        document.querySelector('#undo').click();
        await wait(200);
        touch(cells[off], 'pointerdown', mid(cells[off]));
        touch(cells[off + 1], 'pointerenter', mid(cells[off + 1]));
        touch(window, 'pointerup', mid(cells[off + 1]));
        await wait(200);
        const painted = cells[off].classList.contains('on') && cells[off + 1].classList.contains('on');
        document.querySelector('#undo').click();
        await wait(200);

        // the track's ⋯: a sheet with its sliders and length; a slider there moves the grid's and the mixer's
        row.querySelector('.tog[aria-label="' + id + ' options"]').click();
        await wait(100);
        const sheet = document.querySelector('.pop.sheet');
        const sliders = sheet?.querySelectorAll('.sheet-head input[type=range]').length ?? 0;
        const lengths = sheet?.querySelectorAll('.sheet-len .seg').length ?? 0;
        const gain = sheet.querySelector('input[aria-label="' + id + ' gain"]');
        gain.value = gain.min;
        gain.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(200);
        const synced = [...document.querySelectorAll('#rack input[aria-label="' + id + ' gain"], #mix-rows input[aria-label="' + id + ' gain"]')].every((i) => i.value === gain.min);
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        document.querySelector('#undo').click();
        await wait(200);

        // header ⋯: tempo moves into the sheet and back
        document.querySelector('#more').click();
        await wait(100);
        const inSheet = !!document.querySelector('.pop.sheet #bpm');
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await wait(50);
        const back = document.querySelector('#bpm').closest('header') !== null;
        return { views, scrolled, tapped, painted, sliders, lengths, synced, inSheet, back, restored: ed.code === before };`);
      const v = r.views;
      if (!v.song.mixer || v.song.rack || v.song.code || !v.code.code || v.code.rack || !v.grid.rack || v.grid.mixer) throw new Error(`views: ${JSON.stringify(v)}`);
      if (r.scrolled) throw new Error(`a scroll set a step (cancelled, mostly vertical, stopping a glide: ${r.scrolled})`);
      if (!r.tapped) throw new Error("a tap didn't set the step");
      if (!r.painted) throw new Error("a drag along the row didn't paint");
      if (r.sliders !== 3 || r.lengths !== 4) throw new Error(`track sheet: ${r.sliders} sliders, ${r.lengths} lengths`);
      if (!r.synced) throw new Error("the sheet's slider didn't move the grid's and the mixer's");
      if (!r.inSheet || !r.back) throw new Error(`header ⋯: bpm in the sheet ${r.inSheet}, back in the header ${r.back}`);
      if (!r.restored) throw new Error("undo didn't restore the code");
      if (errors.length) throw new Error(errors[0]);
      return 'grid · song · code, tap / scroll / paint, sheet sliders in sync';
    } finally {
      await send('Emulation.clearDeviceMetricsOverride');
    }
  });

  // ── the learn page ──
  await check('every learn-page example evaluates', async () => {
    await open(`${base}/learn.html`, `document.querySelectorAll('.ex-box').length > 0`);
    const r = await page(`
      const ed = document.querySelector('strudel-editor').editor;
      await ed.prebaked;
      const bad = [];
      for (const [i, box] of [...document.querySelectorAll('.ex-box')].entries()) {
        await ed.repl.evaluate(box.querySelector('textarea').value, false);
        if (ed.repl.state.evalError) bad.push(i + 1 + ': ' + (ed.repl.state.evalError.message ?? ed.repl.state.evalError));
      }
      return { count: document.querySelectorAll('.ex-box').length, bad };`);
    if (r.bad.length) throw new Error(r.bad.join('; '));
    return `${r.count} examples`;
  });
} catch (err) {
  results.push(['FAIL', 'smoke test setup', err.message]);
} finally {
  ws?.close();
  chrome.kill();
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

for (const [state, name, detail] of results) console.log(`${state.padEnd(4)} ${name}${detail ? ` · ${detail}` : ''}`);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
