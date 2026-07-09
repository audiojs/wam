// Verify the compressor (stateful, multi-typed params) survives the WAM wrap:
// numeric AudioParams ride through, enum/bool flow over MessagePort, factory
// snapshot seeds attack/release coefficients.

import 'web-audio-api/polyfill'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { toWam } from '../wam.js'
import { compressor } from '../examples/compressor.js'

const SR = 44100
const DUR = 0.2 // 8820 frames — long enough for envelope to settle
const FREQ = 440

// Render `dur` seconds of a sine at 0 dBFS through the compressor, with the
// given parameter overrides.
async function renderCompressed(parameterData = {}, dur = DUR) {
  const ctx = new OfflineAudioContext(1, Math.round(SR * dur), SR)
  const wam = toWam(compressor)
  await wam.register(ctx)

  const source = ctx.createOscillator()
  source.frequency.value = FREQ
  source.type = 'sine'

  const node = wam.create(ctx, { parameterData })

  source.connect(node).connect(ctx.destination)
  source.start()
  source.stop(dur)

  const buffer = await ctx.startRendering()
  node.dispose()
  return buffer.getChannelData(0)
}

const peakOf = (out, fromFrame) => {
  let peak = 0
  for (let i = fromFrame; i < out.length; i++) {
    const a = Math.abs(out[i])
    if (a > peak) peak = a
  }
  return peak
}

test('toWam descriptor and paramSpecs reflect mixed-type params', () => {
  const wam = toWam(compressor)
  assert.equal(wam.descriptor.identifier, 'org.audiojs.compressor')
  assert.equal(wam.descriptor.vendor, 'org.audiojs')
  assert.equal(wam.descriptor.hasAutomationInput, true)

  const types = Object.fromEntries(wam.paramSpecs.map(s => [s.name, s.type]))
  assert.deepEqual(types, {
    threshold: 'number', ratio: 'number', attack: 'number', release: 'number',
    knee: 'enum', auto: 'bool'
  })
})

test('compressor reduces peak when input exceeds threshold', async () => {
  // 0 dBFS sine, threshold -20 dB, ratio 4:1 → expected reduction ≈ 15 dB → peak ≈ 0.178
  const out = await renderCompressed({ threshold: -20, ratio: 4, attack: 0.005, release: 0.05 })
  // Skip the attack ramp — measure steady state in the second half.
  const peak = peakOf(out, Math.floor(out.length / 2))
  assert.ok(peak > 0.13 && peak < 0.23, `expected ~0.178 steady-state peak, got ${peak}`)
})

test('compressor at high threshold passes signal through unchanged', async () => {
  // Threshold above 0 dB → never engaged → unity gain
  const out = await renderCompressed({ threshold: 0, ratio: 4, attack: 0.005, release: 0.05 })
  const peak = peakOf(out, 256)
  assert.ok(peak > 0.95 && peak < 1.05, `expected ~1.0 peak (untouched), got ${peak}`)
})

test('auto makeup raises the compressed level', async () => {
  const off = await renderCompressed({ threshold: -20, ratio: 4, attack: 0.005, release: 0.05 })
  const on  = await renderCompressed({ threshold: -20, ratio: 4, attack: 0.005, release: 0.05, auto: true })
  const pOff = peakOf(off, Math.floor(off.length / 2))
  const pOn  = peakOf(on,  Math.floor(on.length / 2))
  // Auto should add roughly half the gain reduction (~7.5 dB → ×2.37) of makeup.
  assert.ok(pOn > pOff * 1.5, `expected auto-makeup to raise peak materially: ${pOff} → ${pOn}`)
})

test('hard vs soft knee diverge at threshold-grazing input', async () => {
  // Set a threshold right at the sine's peak so only the soft knee starts
  // pulling the level below it before the signal crosses threshold.
  const hard = await renderCompressed({ threshold: 0, ratio: 4, knee: 'hard', attack: 0.005, release: 0.05 })
  const soft = await renderCompressed({ threshold: 0, ratio: 4, knee: 'soft', attack: 0.005, release: 0.05 })
  const pHard = peakOf(hard, Math.floor(hard.length / 2))
  const pSoft = peakOf(soft, Math.floor(soft.length / 2))
  // Soft knee starts compressing below threshold → its peak should be lower.
  assert.ok(pSoft < pHard - 0.01, `expected soft knee to reduce peak more than hard: hard=${pHard}, soft=${pSoft}`)
})
