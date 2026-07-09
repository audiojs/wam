// Verify a factory wrapped via toWam processes audio correctly through
// an AudioWorklet hosted by web-audio-api in Node.

import 'web-audio-api/polyfill'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { toWam } from '../wam.js'
import { gain } from '../examples/gain.js'

const SR = 44100
const DUR = 0.05      // 2205 frames
const FREQ = 440

// Render a sine through the wrapped plugin and return the output Float32Array.
async function renderGainAt(dB) {
  const ctx = new OfflineAudioContext(1, Math.round(SR * DUR), SR)

  const wam = toWam(gain)
  await wam.register(ctx)

  const source = ctx.createOscillator()
  source.frequency.value = FREQ
  source.type = 'sine'

  const node = wam.create(ctx, { parameterData: { value: dB } })

  source.connect(node).connect(ctx.destination)
  source.start()
  source.stop(DUR)

  const buffer = await ctx.startRendering()
  node.dispose()
  return buffer.getChannelData(0)
}

test('toWam descriptor reflects factory metadata', () => {
  const wam = toWam(gain)
  assert.equal(wam.descriptor.identifier, 'org.audiojs.gain')
  assert.equal(wam.descriptor.vendor, 'org.audiojs')
  assert.equal(wam.descriptor.version, '0.0.0')
  assert.equal(wam.descriptor.hasAudioInput, true)
  assert.equal(wam.descriptor.hasAudioOutput, true)
  assert.equal(wam.descriptor.hasAutomationInput, true)
})

test('gain at 0 dB passes signal through unchanged', async () => {
  const out = await renderGainAt(0)
  // Find peak in steady-state (skip first AudioWorklet block — oscillator hasn't ramped)
  let peak = 0
  for (let i = 256; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  assert.ok(peak > 0.95 && peak < 1.05, `expected ~1.0 peak at 0dB, got ${peak}`)
})

test('gain at -20 dB attenuates by factor of 10', async () => {
  const out = await renderGainAt(-20)
  let peak = 0
  for (let i = 256; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  assert.ok(peak > 0.08 && peak < 0.12, `expected ~0.1 peak at -20dB, got ${peak}`)
})

test('gain at +6 dB roughly doubles signal', async () => {
  const out = await renderGainAt(6)
  let peak = 0
  for (let i = 256; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  // 10^(6/20) ≈ 1.995
  assert.ok(peak > 1.9 && peak < 2.1, `expected ~2.0 peak at +6dB, got ${peak}`)
})
