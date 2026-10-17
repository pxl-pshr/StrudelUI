// Runs inside render.html: renders the page's notes (haps) and sample maps
// offline and posts the audio back. Superdough reuses finished audio nodes
// across contexts, so each frame does one render and is thrown away.

import { prebake } from './vendor/strudel-repl/index.mjs';
import { loadUserSamples } from './sounds.js';

// the short kit names (tr909 → RolandTR909); prebake starts loading them without waiting
const ALIASES = 'https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json';

const ready = (async () => {
  await prebake(); // sample maps, synths, and the globals used below
  await Promise.all([globalThis.aliasBank?.(ALIASES), loadUserSamples()]);
})();

// Superdough lowpasses each generated reverb impulse response in a nested
// OfflineAudioContext and sets the convolver's buffer in its oncomplete. Those
// renders are collected here and awaited before the main render, or every
// .room() convolver renders with no IR (no reverb). Patching this frame's
// prototype leaves the page untouched.
const startRendering = OfflineAudioContext.prototype.startRendering;
const nested = [];
OfflineAudioContext.prototype.startRendering = function () {
  const done = startRendering.call(this);
  nested.push(done);
  return done;
};

const reply = (msg, transfer) => parent.postMessage(msg, location.origin, transfer);

addEventListener('message', async (e) => {
  if (e.origin !== location.origin) return;
  const { haps, sounds = {}, cycles, cps, channels, tail = 2, sampleRate = 48000 } = e.data;
  try {
    await ready;
    const { setAudioContext, setSuperdoughAudioController, initAudio, superdough, soundMap, samples } = globalThis;
    // the page's sample definitions win wherever this frame's differ: tune code
    // can add a name with samples(…) or redefine a built-in one (the page's blob
    // URLs for imported samples load here too, same origin)
    const own = soundMap.get();
    const differ = Object.entries(sounds).filter(([key, defs]) => JSON.stringify(own[key]?.data?.samples) !== JSON.stringify(defs));
    if (differ.length) await samples(Object.fromEntries(differ));
    const offline = new OfflineAudioContext(channels, Math.ceil((cycles / cps + tail) * sampleRate), sampleRate);
    setAudioContext(offline);
    setSuperdoughAudioController(null);
    // more than 2 channels: orbit n plays on channels 2n-1, 2n (one stem per orbit)
    await initAudio({ multiChannelOrbits: channels > 2 });
    const failed = new Map(); // reason -> count
    for (const h of haps) {
      try {
        await superdough(h.value, h.begin / cps, h.duration / cps, cps, h.begin / cps);
      } catch (err) {
        const reason = String(err?.message ?? err).slice(0, 80);
        failed.set(reason, (failed.get(reason) ?? 0) + 1);
      }
    }
    // oncomplete (which sets the IR) runs before this await resumes
    await Promise.all(nested.splice(0));
    const buffer = await startRendering.call(offline);
    const data = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    reply({ data, sampleRate: buffer.sampleRate, failed: [...failed] }, data.map((d) => d.buffer));
  } catch (err) {
    reply({ error: String(err?.message ?? err) });
  }
});

ready.then(
  () => reply({ ready: true }),
  (err) => reply({ error: `couldn't load sounds: ${err?.message ?? err}` }),
);
