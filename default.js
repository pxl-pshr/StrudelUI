// The tune a first visit opens (no autosave yet); also first in file → demos….
export const DEFAULT_NAME = 'stab - pxlpshr';
export const DEFAULT_TUNE = `// stab - pxlpshr
setcpm(137/4)

const kick = s("bd").bank("BossDR110")
  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")
  .decay(.8)
  .duckorbit("2:5")
  .duckdepth(".46:.39")
  .duckattack(".01:.03")
  .gain(1.2)
  .swingBy(.26, 8)
  .orbit(1)

const sub = s("bd").bank("RolandTR909")
  .struct("~ ~ x ~  ~ ~ x ~  ~ ~ x ~  ~ ~ x ~")
  .roomsize(4)
  .lpf(60)
  .room(.4)
  .gain(.3)
  .orbit(7)

const toms = note("~ ~ ~ g1  ~ ~ f1 ~  ~ ~ ~ g1  ~ ~ f1 ~").s("lt").n(0).bank("RolandTR909")
  .superimpose(x => x.sub(note(12)).s("ht").n(4).hpf(300).velocity(.6))
  .decay(.8)
  .lpf(300)
  .room(.85)
  .gain(.7)
  .orbit(2)

const saw = note("~ g1 g0 g1  ~ f2 f0 g1  ~ g1 g0 g1  ~ f2 f0 g1").s("sawtooth")
  .decay(.2)
  .sustain(.2)
  .release(.2)
  .lpf(228)
  .gain(.8)
  .room(1.55)
  .orbit(2)

const perc = note("~ c#2 ~ ~  ~ ~ ~ ~  ~ c#2 ~ ~  ~ ~ ~ ~").s("mt").bank("RolandTR909")
  .decay(.15)
  .lpf(1000)
  .gain(.4)
  .orbit(5)

const hats = s("hh").bank("RolandTR909")
  .struct("x x x x  x x x x  x x x x  x x x x")
  .decay("[.05 .08 .12 .05]*4")
  .velocity("[.5 .6 1 .6]*4")
  .roomsize(.4)
  .postgain(.3)
  .lpf(8000)
  .room(.8)
  .gain(.5)
  .orbit(4)

const hhoff = s("hh").bank("RolandTR909")
  .struct("~ ~ x ~  ~ ~ x ~  ~ ~ x ~  ~ ~ x ~")
  .decay(.05)
  .delay(.01)
  .roomsize(.2)
  .hpf(2000)
  .lpf(7000)
  .room(.1)
  .gain(.2)
  .orbit(4)

const clap = s("cp").bank("RolandTR909")
  .struct("~ x ~ x  ~ ~ x ~  ~ x ~ x  ~ ~ x ~")
  .decay(.16)
  .size(1)
  .roomlp(4000)
  .delay(.1)
  .hpf(800)
  .lpf(15000)
  .room(.3)
  .gain(.14)
  .orbit(3)

const ride = s("rd").bank("RolandTR909")
  .struct("x ~ x ~  x ~ x ~  x ~ x ~  x ~ x ~")
  .velocity("[.17 .17 1 1]*4")
  .decay(.8)
  .delay(.2)
  .hpf(1000)
  .postgain(.15)
  .gain(.3)
  .orbit(4)

const stab = note("~ ~ ~ g3  ~ ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~").s("square")
  .superimpose(x => x.add(note(6)))
  .decay(.65)
  .sustain(0)
  .release(.3)
  .delay(.2)
  .lpf(210)
  .room(1.2)
  .gain(.35)
  .orbit(5)

const stab2 = note("g3 ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~  ~ ~ ~ ~").s("square")
  .add(note("0,3,7"))
  .decay(.5)
  .sustain(0)
  .lpf(305)
  .room(1.95)
  .gain(.22)
  .delay(.54)
  .orbit(5)

// scenes: which tracks play
const intro = stack(kick)
const build = stack(kick, sub, toms)
const build2 = stack(kick, sub, toms, hats)
const build3 = stack(kick, sub, toms, perc, hats, hhoff)
const solo_clap = stack(clap)
const build4 = stack(kick, sub, toms, perc, hats, hhoff, clap, ride, stab, stab2)
const full = stack(kick, sub, toms, saw, perc, hats, hhoff, clap, ride, stab, stab2)
const outro = stack(sub, toms, saw, perc, hats, hhoff, clap, ride, stab, stab2)
const outro2 = stack(sub, toms, saw, perc, hhoff, clap, ride, stab, stab2)
const outro3 = stack(sub, toms, saw, perc, stab, stab2)

// song: [bars, scene]
const song = arrange(
  [4, intro],
  [4, build],
  [4, build2],
  [7, build3],
  [1, solo_clap],
  [8, build4],
  [8, full],
  [8, outro],
  [8, outro2],
  [8, outro3],
)

stack(
  kick,
  sub,
  toms,
  // saw,
  // perc,
  // hats,
  // hhoff,
  // clap,
  // ride,
  // stab,
  // stab2,
)
`;
