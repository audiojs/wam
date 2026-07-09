// Stateful peak compressor — single-band, RMS-free, gain-reduction in dB.
// Demonstrates the full contract surface: closure state, ctx.params snapshot
// for sample-rate-dependent coefficients, mixed param types (number/enum/bool),
// `tail`, and `channels: 'any'` (mono envelope shared across channels).

const KNEE_WIDTH = 6 // dB; soft knee transition width around threshold

export const compressor = (ctx) => {
  const sr = ctx.sampleRate

  // Envelope follower state — one shared envelope across channels (peak across
  // channels per sample, so stereo material gangs naturally).
  let env = 0

  // Coefficients track live `attack`/`release`. Seeded from the snapshot so the
  // very first block has correct values; updated when params change.
  let aSec = ctx.params.attack[0]
  let rSec = ctx.params.release[0]
  let aCoef = Math.exp(-1 / (aSec * sr))
  let rCoef = Math.exp(-1 / (rSec * sr))

  return (inputs, outputs, params) => {
    const inp = inputs[0], out = outputs[0]
    if (!inp || inp.length === 0) return
    const ch = inp.length, n = inp[0].length

    const threshold = params.threshold[0]
    const ratio = params.ratio[0]
    const attack = params.attack[0]
    const release = params.release[0]
    const knee = params.knee
    const auto = params.auto

    if (attack !== aSec) { aSec = attack; aCoef = Math.exp(-1 / (attack * sr)) }
    if (release !== rSec) { rSec = release; rCoef = Math.exp(-1 / (release * sr)) }

    const thrLin = 10 ** (threshold / 20)
    const slope = 1 - 1 / ratio
    // Auto makeup: roughly half the gain reduction at threshold (industry rule of thumb)
    const makeup = auto ? 10 ** (-threshold * slope * 0.5 / 20) : 1
    const halfKnee = KNEE_WIDTH / 2

    for (let i = 0; i < n; i++) {
      let peak = 0
      for (let c = 0; c < ch; c++) {
        const s = inp[c][i]
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
      }

      const coef = peak > env ? aCoef : rCoef
      env = peak + coef * (env - peak)

      let gain = 1
      if (env > 0) {
        const overDb = 20 * Math.log10(env / thrLin)
        let reductDb = 0
        if (knee === 'soft') {
          if (overDb >= halfKnee) reductDb = -slope * overDb
          else if (overDb > -halfKnee) {
            const x = overDb + halfKnee
            reductDb = -slope * x * x / (2 * KNEE_WIDTH)
          }
        } else if (overDb > 0) {
          reductDb = -slope * overDb
        }
        if (reductDb !== 0) gain = 10 ** (reductDb / 20)
      }

      const g = gain * makeup
      for (let c = 0; c < ch; c++) out[c][i] = inp[c][i] * g
    }
  }
}

compressor.id = 'compressor'
compressor.vendor = 'org.audiojs'
compressor.version = '0.0.0'
compressor.channels = 'any'
compressor.tail = 0.5
compressor.params = {
  threshold: { type: 'number', min: -60, max: 0,  default: -20, smoothing: 0.01 },
  ratio:     { type: 'number', min: 1,   max: 20, default: 4 },
  attack:    { type: 'number', min: 0.001, max: 1, default: 0.01 },
  release:   { type: 'number', min: 0.01,  max: 2, default: 0.1 },
  knee:      { type: 'enum', values: ['hard', 'soft'], default: 'soft' },
  auto:      { type: 'bool', default: false }
}
