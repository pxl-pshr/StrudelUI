// visuals demo
setcpm(126/4)

// ════ every track draws its own visual in the code: six widgets under their
// ════ lines, and markcss restyling the rim's steps as they play

// _scope: the kick's waveform
const kick = s("bd").bank("RolandTR909")
  .struct("x ~ ~ ~  x ~ ~ ~  x ~ ~ ~  x ~ ~ ~")
  .duckorbit("2:4:5:6")
  .duckdepth(".5:.3:.4:.3")
  .gain(.95)
  .color("white")
  ._scope()
  .orbit(1)

// _punchcard: the hats' pattern as blocks rolling past
const hats = s("hh").bank("RolandTR909")
  .struct("~ ~ x ~  ~ ~ x ~  ~ ~ x ~  ~ ~ x x")
  .decay(.06)
  .hpf(3000)
  .gain(.45)
  .color("cyan")
  ._punchcard()
  .orbit(3)

// _spiral: each clap around a turning spiral
const clap = s("cp").bank("RolandTR909")
  .struct("~ ~ ~ ~  x ~ ~ ~  ~ ~ ~ ~  x ~ ~ x")
  .room(.4)
  .gain(.5)
  .color("magenta")
  ._spiral({ steady: .96 })
  .orbit(7)

// markcss: the CSS for the rim's playing steps, replacing the default outline
// (single quotes: a double-quoted string would be read as mini-notation)
const rim = s("rim").bank("RolandTR909")
  .struct("~ ~ ~ x  ~ ~ x ~  ~ x ~ ~  ~ ~ ~ x")
  .delay(.25)
  .gain(.4)
  .markcss('background: deepskyblue; color: black; border-radius: 2px')
  .orbit(8)

// _pianoroll: the bass line, note by note
const bass = note("<[a1 ~ a1 ~  ~ ~ a2 ~  a1 ~ ~ a1  ~ c2 ~ ~] [f1 ~ f1 ~  ~ ~ f2 ~  f1 ~ ~ f1  ~ g1 ~ ~]>").s("sawtooth")
  .decay(.18)
  .sustain(0)
  .lpf(600)
  .gain(.55)
  .color("orange")
  ._pianoroll()
  .orbit(2)

// _pitchwheel: the stab's chord notes on a wheel of pitches
const stab = note("<[a3 ~ ~ ~  ~ ~ ~ ~  ~ ~ a3 ~  ~ ~ ~ ~] [f3 ~ ~ ~  ~ ~ ~ ~  ~ ~ f3 ~  ~ ~ ~ ~]>").s("square")
  .add(note("0,3,7"))
  .decay(.35)
  .sustain(0)
  .lpf(1600)
  .room(.5)
  .gain(.25)
  .color("yellow")
  ._pitchwheel()
  .orbit(5)

// _spectrum: the lead's frequencies, live
const lead = note("<[e5 ~ ~ c5  ~ ~ a4 ~  ~ ~ ~ ~  ~ ~ ~ ~] [~ ~ ~ ~  c5 ~ ~ a4  ~ ~ g4 ~  ~ ~ ~ ~]>").s("triangle")
  .decay(.3)
  .sustain(.1)
  .delay(.4)
  .room(.6)
  .gain(.3)
  .color("lime")
  ._spectrum()
  .orbit(6)

stack(
  kick,
  hats,
  clap,
  rim,
  bass,
  stab,
  lead,
)
