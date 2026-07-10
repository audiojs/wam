// Coverage for the two contract gaps: `streaming: false` must be refused at
// wrap time, and `flags: ['restart']` params must actually restart (factory
// re-run, state reset) rather than silently no-op.

import 'web-audio-api/polyfill'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { toWam } from '../wam.js'

const SR = 48000
const FRAMES = 128

// Same fake-worklet-scope harness as test/host.test.js — exercises the
// processor directly, no real AudioParam automation timing to fight.
async function instantiate(factory, opts = {}) {
  let Captured
  const messages = []
  const scope = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m), onmessage: null, close() {} }
      }
    },
    registerProcessor: (id, C) => { Captured = C },
    sampleRate: SR
  }
  const fakeCtx = { audioWorklet: { async addModule(fn) { fn(scope) } } }
  const wam = toWam(factory)
  await wam.register(fakeCtx)
  return { proc: new Captured(opts), messages, wam }
}

const block = (fill = 0) => [[new Float32Array(FRAMES).fill(fill)]]

test('toWam refuses a streaming: false (whole-render) atom', () => {
  const stretch = (ctx) => (inputs, outputs) => {}
  stretch.id = 'stretch'
  stretch.params = {}
  stretch.streaming = false
  assert.throws(
    () => toWam(stretch),
    /toWam\(atom\): stretch declares streaming: false \(whole-render\) — it cannot run as a realtime worklet; render it offline via audio\/batch/
  )
})

test('streaming: true (default) atoms wrap normally', () => {
  const gain = (ctx) => (inputs, outputs) => {}
  gain.id = 'gain'
  gain.params = {}
  assert.doesNotThrow(() => toWam(gain))
})

// CONTRACT's compressor bakes attack/release coefficients into the factory
// closure — this minimal analogue bakes a gain multiplier the same way, so a
// live setParam only takes effect if the factory actually re-runs.
const bakedGain = (ctx) => {
  const g = ctx.params.gain[0] // baked once, at factory time — never re-read
  return (inputs, outputs) => {
    const inp = inputs[0], out = outputs[0]
    for (let c = 0; c < inp.length; c++)
      for (let i = 0; i < inp[c].length; i++)
        out[c][i] = inp[c][i] * g
  }
}
bakedGain.id = 'baked-gain'
bakedGain.params = {
  gain: { type: 'number', min: 0, max: 10, default: 1, flags: ['restart'] }
}

test('restart-flagged numeric param re-runs the factory on change', async () => {
  const { proc } = await instantiate(bakedGain, { parameterData: { gain: 1 } })

  const at = (v) => Object.freeze({ gain: new Float32Array([v]) })

  const out1 = block()
  proc.process(block(0.5), out1, at(1))
  assert.equal(out1[0][0][0], 0.5, 'gain=1 baked at construction')

  const out2 = block()
  proc.process(block(0.5), out2, at(2)) // gain changes → restart
  assert.equal(out2[0][0][0], 1.0, 'gain=2 rebaked after restart: 0.5 * 2')

  const out3 = block()
  proc.process(block(0.5), out3, at(2)) // unchanged → no restart, stays at 2x
  assert.equal(out3[0][0][0], 1.0, 'no further change without a param change')
})

test('non-restart numeric param change does not re-run the factory', async () => {
  const plain = (ctx) => {
    const g = ctx.params.gain[0]
    return (inputs, outputs) => {
      const inp = inputs[0], out = outputs[0]
      for (let c = 0; c < inp.length; c++)
        for (let i = 0; i < inp[c].length; i++)
          out[c][i] = inp[c][i] * g
    }
  }
  plain.id = 'plain-gain'
  plain.params = { gain: { type: 'number', min: 0, max: 10, default: 1 } }

  const { proc } = await instantiate(plain, { parameterData: { gain: 1 } })
  const at = (v) => Object.freeze({ gain: new Float32Array([v]) })

  const out1 = block()
  proc.process(block(0.5), out1, at(1))
  assert.equal(out1[0][0][0], 0.5)

  const out2 = block()
  proc.process(block(0.5), out2, at(2)) // no restart flag → stays baked at 1
  assert.equal(out2[0][0][0], 0.5, 'unflagged param change must not restart')
})

test('restart-flagged enum/bool param (MessagePort) re-runs the factory', async () => {
  const mode = (ctx) => {
    const m = ctx.params.mode // baked once
    return (inputs, outputs) => {
      const inp = inputs[0], out = outputs[0]
      const g = m === 'double' ? 2 : 1
      for (let c = 0; c < inp.length; c++)
        for (let i = 0; i < inp[c].length; i++)
          out[c][i] = inp[c][i] * g
    }
  }
  mode.id = 'mode-gain'
  mode.params = { mode: { type: 'enum', values: ['unity', 'double'], default: 'unity', flags: ['restart'] } }

  const { proc } = await instantiate(mode, { processorOptions: { parameterData: { mode: 'unity' } } })

  const out1 = block()
  proc.process(block(0.5), out1, Object.freeze({}))
  assert.equal(out1[0][0][0], 0.5, 'unity baked at construction')

  proc.port.onmessage({ data: { type: 'param', name: 'mode', value: 'double' } })

  const out2 = block()
  proc.process(block(0.5), out2, Object.freeze({}))
  assert.equal(out2[0][0][0], 1.0, 'double rebaked after restart via port message')
})

test('restart rebuild re-reports latency', async () => {
  const lat = (ctx) => () => {}
  lat.id = 'lat'
  lat.params = { size: { type: 'number', min: 0, max: 10, default: 1, flags: ['restart'] } }
  lat.latency = (ctx) => ctx.params.size[0] * 10

  const { proc, messages } = await instantiate(lat, { parameterData: { size: 1 } })
  assert.deepEqual(messages.filter(m => m.type === 'latency'), [{ type: 'latency', value: 10 }])

  proc.process(block(), block(), Object.freeze({ size: new Float32Array([2]) }))
  assert.deepEqual(messages.filter(m => m.type === 'latency'), [
    { type: 'latency', value: 10 },
    { type: 'latency', value: 20 }
  ])
})
