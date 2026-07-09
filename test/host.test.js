// Host-semantics regressions against a minimal fake AudioWorklet scope —
// covers browser behaviors the Node polyfill is too lenient to catch
// (frozen parameters object), plus adapter features: smoothing, latency
// report, ctx.emit, descriptor derivations, offline render detection.

import 'web-audio-api/polyfill'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { toWam } from '../wam.js'
import { compressor } from '../examples/compressor.js'

const SR = 48000
const FRAMES = 128

// Register `factory` into a fake worklet scope and return the processor class
// plus the port message log.
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

test('process never writes the host parameters object (browsers freeze it)', async () => {
  const { proc } = await instantiate(compressor, {
    parameterData: { threshold: -20 },
    processorOptions: { parameterData: { knee: 'hard' } }
  })
  // Browsers hand process() a non-extensible params object — mutation throws.
  const params = Object.freeze({
    threshold: new Float32Array([-20]),
    ratio: new Float32Array([4]),
    attack: new Float32Array([0.005]),
    release: new Float32Array([0.05])
  })
  const inputs = block(0.5), outputs = block()
  proc.process(inputs, outputs, params) // must not throw
  assert.ok(!('knee' in params), 'host params object gained a key')
  assert.notEqual(outputs[0][0][FRAMES - 1], 0, 'compressor produced no output')
})

test('block-rate smoothing ramps linearly over the declared seconds', async () => {
  const seen = []
  const probe = () => (inputs, outputs, params) => { seen.push(params.x[0]) }
  probe.params = { x: { type: 'number', min: 0, max: 1, default: 0, smoothing: 0.1 } }

  const { proc } = await instantiate(probe)
  const at = (v) => Object.freeze({ x: new Float32Array([v]) })
  proc.process(block(), block(), at(0))     // first block snaps, no ramp
  assert.equal(seen[0], 0)

  const blocksToTarget = Math.ceil((0.1 * SR) / FRAMES) // 4800 / 128 = 37.5 → 38
  for (let i = 0; i < blocksToTarget + 2; i++) proc.process(block(), block(), at(1))

  const step = FRAMES / (0.1 * SR)
  assert.ok(Math.abs(seen[1] - step) < 1e-6, `first ramp block ≈ ${step}, got ${seen[1]}`)
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i] >= seen[i - 1], `ramp not monotonic at block ${i}`)
  assert.equal(seen[seen.length - 1], 1, 'ramp never reached target')
})

test('function-form latency evaluates against ctx and reports once', async () => {
  const mod = () => () => {}
  mod.params = {}
  mod.latency = (ctx) => ctx.sampleRate / 100
  const { messages } = await instantiate(mod)
  assert.deepEqual(messages.filter(m => m.type === 'latency'), [{ type: 'latency', value: 480 }])
})

test('ctx.emit posts declared events and traps undeclared names', async () => {
  let ctxRef
  const mod = (ctx) => { ctxRef = ctx; return () => { ctx.emit('meter', 0.5) } }
  mod.params = {}
  mod.events = { out: { meter: 'number' } }
  const { proc, messages } = await instantiate(mod)
  proc.process(block(), block(), Object.freeze({}))
  assert.deepEqual(messages.filter(m => m.type === 'emit'), [{ type: 'emit', name: 'meter', args: [0.5] }])
  assert.throws(() => ctxRef.emit('undeclared', 1), /not declared/)
})

test('ctx.currentTime advances per block from stream start', async () => {
  const times = []
  const mod = (ctx) => () => { times.push(ctx.currentTime) }
  mod.params = {}
  const { proc } = await instantiate(mod)
  for (let i = 0; i < 3; i++) proc.process(block(), block(), Object.freeze({}))
  assert.deepEqual(times, [0, FRAMES / SR, (2 * FRAMES) / SR])
})

test('descriptor derives kebab id, title, and generator flags', () => {
  const pingPong = () => () => {}
  pingPong.params = {}
  pingPong.title = 'Ping Pong'
  assert.equal(toWam(pingPong).descriptor.identifier, 'audio.ping-pong')
  assert.equal(toWam(pingPong).descriptor.name, 'Ping Pong')

  const silence = () => () => {}
  silence.params = {}
  silence.channels = { inputs: [], outputs: 2 }
  const d = toWam(silence).descriptor
  assert.equal(d.hasAudioInput, false)
  assert.equal(d.hasAudioOutput, true)
  assert.equal(d.hasAutomationInput, false)
})

test('offline render is detected and ctx.render reaches the factory', async () => {
  const meterMod = (ctx) => {
    let sent = false
    return () => { if (!sent) { sent = true; ctx.emit('meter', ctx.render === 'offline' ? 1 : 0) } }
  }
  meterMod.params = {}
  meterMod.events = { out: { meter: 'number' } }

  const ctx = new OfflineAudioContext(1, SR * 0.05, SR)
  const wam = toWam(meterMod, { id: 'meter-mod' })
  await wam.register(ctx)
  const src = ctx.createOscillator()
  const node = wam.create(ctx)
  const emitted = []
  node.onemit = (name, args) => emitted.push([name, ...args])
  src.connect(node).connect(ctx.destination)
  src.start()
  await ctx.startRendering()
  await new Promise(r => setImmediate(r))
  node.dispose()
  assert.deepEqual(emitted, [['meter', 1]])
})
