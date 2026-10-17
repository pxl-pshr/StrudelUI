// Audio export: offline renders of the mix or per-track stems (WAV, stems
// zipped with zip.js), and a live recorder.
// Renders run in a throwaway hidden frame (render.html): superdough pools
// audio nodes across contexts, so a render in this page would break the next
// render and live playback.

// ── offline render ────────────────────────────────

// audio as plain channels, enough for wav() and peakDb()
const audio = (data, sampleRate) => ({
  numberOfChannels: data.length,
  length: data[0]?.length ?? 0,
  sampleRate,
  getChannelData: (c) => data[c],
});

const SAMPLE_RATE = 48000;
const TAIL = 2; // seconds after the last bar, for reverb and delay tails
const MAX_RENDER = 1.5 * 2 ** 30; // bytes of audio one render may hold

export const renderBytes = (cycles, cps, channels) => (cycles / cps + TAIL) * SAMPLE_RATE * channels * 4;
export const fitsInMemory = (cycles, cps, channels) => renderBytes(cycles, cps, channels) <= MAX_RENDER;

// The sample sounds the notes use, as this page has them registered: tune code
// can register its own with samples(…), which the frame never runs. Sample
// maps only (URLs), keyed like soundMap: lowercase, bank_name for banks.
function sampleDefs(haps) {
  const map = globalThis.soundMap?.get() ?? {};
  const defs = {};
  for (const { value } of haps) {
    const s = typeof value.s === 'string' ? value.s.split(':')[0] : null;
    if (!s) continue;
    const key = (value.bank ? `${value.bank}_${s}` : s).toLowerCase();
    const e = map[key];
    if (e?.data?.type === 'sample' && !(key in defs)) defs[key] = e.data.samples;
  }
  return defs;
}

// haps: [{ value, begin, duration }] in cycles. Resolves with the audio and
// `failed`: [[reason, count]] for notes that couldn't play (missing sounds…).
function renderInFrame(haps, cycles, cps, channels) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = 'render.html';
    // loading sounds takes seconds; rendering runs much faster than real time
    const limit = setTimeout(() => finish(new Error('the render timed out')), 60000 + (cycles / cps) * 1000);
    const finish = (err, result) => {
      clearTimeout(limit);
      removeEventListener('message', onMessage);
      frame.remove();
      err ? reject(err) : resolve(result);
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow) return;
      try {
        if (e.data.ready) {
          const jobs = haps.map(({ value, begin, duration }) => ({ value, begin, duration }));
          const sounds = sampleDefs(jobs);
          frame.contentWindow.postMessage({ haps: jobs, sounds, cycles, cps, channels, tail: TAIL, sampleRate: SAMPLE_RATE }, location.origin);
        } else if (e.data.error) finish(new Error(e.data.error));
        else if (e.data.data) finish(null, Object.assign(audio(e.data.data, e.data.sampleRate), { failed: e.data.failed ?? [] }));
      } catch (err) {
        finish(err); // e.g. a note value that can't be sent to the frame
      }
    };
    addEventListener('message', onMessage);
    frame.addEventListener('error', () => finish(new Error("the render frame didn't load")));
    document.body.append(frame);
  });
}

const startOf = (h) => h.whole.begin.valueOf();
// every note of the pattern over `cycles` bars, with where in the code it came from
export function collect(pattern, cycles, cps) {
  return pattern
    .queryArc(0, cycles, { _cps: cps })
    .filter((h) => h.hasOnset())
    .sort((a, b) => startOf(a) - startOf(b))
    .map((h) => ({
      value: { ...h.value },
      begin: startOf(h),
      duration: h.duration.valueOf(),
      at: h.context?.locations?.[0]?.start,
    }));
}

export const renderMix = (haps, cycles, cps) => renderInFrame(haps, cycles, cps, 2);

// Stems in one pass: each track gets its own orbit, and orbit n plays on
// channels 2n-1/2n, so every track lands on its own pair (16 per pass, the
// most an offline render can hold). Sidechain targets are remapped from the
// old shared orbits to the new ones, so stems still pump like the mix.
const PER_PASS = 16;
const list = (v) => (v == null ? [] : [v].flat());

function toOwnOrbits(haps, tracks) {
  const owner = (h) => tracks.findIndex((t) => h.at != null && h.at >= t.range[0] && h.at < t.range[1]);
  const moved = new Map(); // old orbit -> new orbits of the tracks that used it
  for (const h of haps) {
    const i = owner(h);
    if (i === -1) continue;
    const old = h.value.orbit ?? 1;
    if (!moved.has(old)) moved.set(old, new Set());
    moved.get(old).add(i + 1);
  }
  return haps.flatMap((h) => {
    const i = owner(h);
    if (i === -1) return [];
    const v = { ...h.value, orbit: i + 1 };
    delete v.channels;
    if (v.duckorbit != null) {
      const [depth, attack, onset] = [list(v.duckdepth), list(v.duckattack), list(v.duckonset)];
      const to = { duckorbit: [], duckdepth: [], duckattack: [], duckonset: [] };
      list(v.duckorbit).forEach((o, k) => {
        for (const n of moved.get(o) ?? []) {
          if (n === i + 1) continue;
          to.duckorbit.push(n);
          to.duckdepth.push(depth[k] ?? depth[0]);
          to.duckattack.push(attack[k] ?? attack[0]);
          to.duckonset.push(onset[k] ?? onset[0]);
        }
      });
      for (const [key, vals] of Object.entries(to)) {
        if (to.duckorbit.length && vals.some((x) => x != null)) v[key] = vals;
        else delete v[key];
      }
    }
    return [{ ...h, value: v }];
  });
}

export async function renderStems(haps, tracks, cycles, cps) {
  const playing = tracks.filter((t) => haps.some((h) => h.at != null && h.at >= t.range[0] && h.at < t.range[1]));
  if (!playing.length) return [];
  if (playing.length > PER_PASS) {
    throw new Error(`stems: ${playing.length} tracks play at once, ${PER_PASS} is the most · mute some and export twice`);
  }
  const out = await renderInFrame(toOwnOrbits(haps, playing), cycles, cps, playing.length * 2);
  const stems = playing.map((t, i) => ({ name: t.id, buffer: audio([out.getChannelData(i * 2), out.getChannelData(i * 2 + 1)], out.sampleRate) }));
  return Object.assign(stems, { failed: out.failed });
}

// ── WAV ───────────────────────────────────────────

// 32-bit float, interleaved: samples above 0 dBFS are stored as is, not clipped
export function wav(buffer) {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  const v = new DataView(new ArrayBuffer(44 + n * ch * 4));
  const text = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * ch * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, ch, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * ch * 4, true);
  v.setUint16(32, ch * 4, true);
  v.setUint16(34, 32, true);
  text(36, 'data');
  v.setUint32(40, n * ch * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++, o += 4) v.setFloat32(o, data[c][i], true);
  }
  return new Blob([v.buffer], { type: 'audio/wav' });
}

// loudest sample, in dB relative to full scale
export function peakDb(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    for (const s of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(s));
  }
  return peak ? 20 * Math.log10(peak) : -Infinity;
}

// ── live recording ────────────────────────────────
// Taps Strudel's final output with a tiny audio worklet that hands back the
// raw samples (lossless; MediaRecorder would go through Opus/AAC). Takes the
// first two output channels as they are, so a multichannel interface doesn't
// get downmixed.

const TAP = `registerProcessor('pcm-tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input.length) this.port.postMessage(input.map((ch) => ch.slice()));
    return true;
  }
});`;
const tapReady = new WeakMap(); // audio context -> worklet module loaded

export async function startRecording() {
  const { getAudioContext, getSuperdoughAudioController } = globalThis;
  const ctx = getAudioContext();
  if (!tapReady.has(ctx)) {
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    tapReady.set(ctx, ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)));
  }
  await tapReady.get(ctx);
  const out = getSuperdoughAudioController().output.destinationGain;
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  const quiet = ctx.createGain(); // keeps the worklet running without playing it twice
  quiet.gain.value = 0;
  const chunks = [[], []];
  tap.port.onmessage = (e) => {
    chunks[0].push(e.data[0]);
    chunks[1].push(e.data[1] ?? e.data[0]);
  };
  out.connect(tap);
  tap.connect(quiet).connect(ctx.destination);
  return {
    seconds: () => (chunks[0].length * 128) / ctx.sampleRate,
    async stop() {
      out.disconnect(tap);
      tap.disconnect();
      quiet.disconnect();
      tap.port.onmessage = null;
      const join = (list) => {
        const all = new Float32Array(list.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of list) all.set(c, (o += c.length) - c.length);
        return all;
      };
      return wav(audio(chunks.map(join), ctx.sampleRate));
    },
  };
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
