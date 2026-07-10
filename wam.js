// Wrap an audio.js atom factory as a Web Audio Module 2.0-shaped plugin.
// JS-runtime path: factory body runs as JS inside an AudioWorkletProcessor,
// numeric params ride AudioParam, enum/bool params live in worklet-side closure
// state and are mutated through MessagePort messages.
// Future WASM path will replace the inner closure with a compiled atom.

const PARAM_FLOAT_MIN = -3.4028235e38
const PARAM_FLOAT_MAX = 3.4028235e38

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

// Normalized internal spec for every declared param. Order is preserved so the
// worklet and host build matching key sets without coordination.
const buildParamSpecs = (params) =>
  Object.entries(params).map(([name, p]) => {
    const type = p.type ?? 'number'
    const restart = !!(p.flags && p.flags.includes('restart'))
    if (type === 'number') return {
      name, type, restart,
      default: p.default ?? 0,
      min: p.min ?? PARAM_FLOAT_MIN,
      max: p.max ?? PARAM_FLOAT_MAX,
      rate: p.rate === 'sample' ? 'a-rate' : 'k-rate',
      smoothing: p.smoothing ?? 0
    }
    if (type === 'enum') return {
      name, type, restart,
      values: p.values ?? [],
      default: p.default ?? (p.values?.[0] ?? null)
    }
    if (type === 'bool') return {
      name, type, restart,
      default: p.default ?? false
    }
    throw new Error(`toWam: unknown param type "${type}" for "${name}"`)
  })

// Bus count for one side of a `channels` declaration. `number[]` is one bus
// per entry, `string[]` is one bus with a layout choice, `[]` is no bus.
const busCount = (side) =>
  side === undefined ? 1
  : Array.isArray(side)
    ? (side.length === 0 ? 0 : typeof side[0] === 'string' ? 1 : side.length)
  : 1 // number | 'any' | layout string | descriptor

const resolveBuses = (channels) =>
  channels != null && typeof channels === 'object' && !Array.isArray(channels)
    ? { inputs: busCount(channels.inputs), outputs: busCount(channels.outputs) }
    : { inputs: 1, outputs: 1 }

// Fixed output channel counts when the declaration pins them; undefined lets
// the host negotiate ('any', layout tags, descriptors).
const outputChannels = (channels) => {
  const side = channels != null && typeof channels === 'object' && !Array.isArray(channels)
    ? channels.outputs : channels
  if (typeof side === 'number') return [side]
  if (Array.isArray(side) && side.length && typeof side[0] === 'number') return side
  return undefined
}

const buildDescriptor = (factory, id, specs, buses) => {
  const evIn = factory.events?.in ?? []
  const evOut = Object.values(factory.events?.out ?? {})
  return {
    identifier: factory.native?.wam ?? `${factory.vendor ?? 'audio'}.${id}`,
    name: factory.title ?? id,
    vendor: factory.vendor ?? 'audio',
    version: factory.version ?? '0.0.0',
    description: factory.description ?? '',
    keywords: factory.keywords ?? [],
    isInstrument: buses.inputs === 0 && evIn.includes('note'),
    hasAudioInput: buses.inputs > 0,
    hasAudioOutput: buses.outputs > 0,
    hasMidiInput: evIn.includes('midi') || evIn.includes('note'),
    hasMidiOutput: evOut.includes('midi') || evOut.includes('note'),
    hasAutomationInput: specs.some(s => s.type === 'number'),
    hasAutomationOutput: false
  }
}

// One body, two delivery vehicles: closure (Node, web-audio-api accepts a setup
// function) and Blob URL (browser). The body references `factory`, `ID`,
// `SPECS` from the surrounding scope.
const PROCESSOR_BODY = `
class Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const out = []
    for (const s of SPECS) if (s.type === 'number') {
      out.push({ name: s.name, defaultValue: s.default, minValue: s.min, maxValue: s.max, automationRate: s.rate })
    }
    return out
  }
  constructor(opts) {
    super()
    const po = (opts && opts.processorOptions) || {}
    // Numeric params seed via AudioWorklet's parameterData; non-numeric (enum/bool)
    // ride processorOptions.parameterData so they're available at first block —
    // postMessage races synchronous OfflineAudioContext rendering.
    const numericInit = (opts && opts.parameterData) || {}
    const nonNumInit = po.parameterData || {}
    const ctxParams = {}
    // Stable params object handed to process every block. Browsers freeze the
    // host-provided parameters object — it must never be written to.
    this._params = {}
    this._numNames = []
    this._nonNum = {}
    this._smooth = null
    // restart-flagged params (flags: ['restart']): a change swaps in a
    // freshly-factoried process fn (state resets — the documented semantic).
    // _restart covers every type (checked on message arrival for enum/bool);
    // _restartNum/_restartLive are the cheap per-block change detector for
    // numeric restart params, since those arrive via the AudioParam array.
    this._restart = {}
    this._restartNum = []
    this._restartLive = {}
    this._pendingRestart = false
    for (const s of SPECS) {
      if (s.type === 'number') {
        const seed = numericInit[s.name] !== undefined ? numericInit[s.name] : s.default
        ctxParams[s.name] = new Float32Array([seed])
        this._numNames.push(s.name)
        if (s.smoothing > 0 && s.rate === 'k-rate')
          (this._smooth || (this._smooth = {}))[s.name] =
            { time: s.smoothing, from: seed, target: seed, t: 1, init: false, buf: new Float32Array([seed]) }
        if (s.restart) { this._restart[s.name] = true; this._restartNum.push(s.name); this._restartLive[s.name] = seed }
      } else {
        const seed = nonNumInit[s.name] !== undefined ? nonNumInit[s.name] : s.default
        ctxParams[s.name] = seed
        this._params[s.name] = seed
        this._nonNum[s.name] = true
        if (s.restart) this._restart[s.name] = true
      }
    }
    this._frames = 0
    const self = this
    const emits = (factory.events && factory.events.out) || null
    const ctx = {
      sampleRate,
      maxBlockSize: 128,
      render: po.render || 'realtime',
      duration: po.duration,
      params: ctxParams,
      transport: undefined,
      layouts: undefined,
      events: factory.events && factory.events.in && factory.events.in.length ? [] : undefined,
      get currentTime() { return self._frames / sampleRate },
      emit: (name, ...args) => {
        if (!emits || !(name in emits)) throw new Error('emit: "' + name + '" not declared in events.out')
        self.port.postMessage({ type: 'emit', name, args })
      }
    }
    this._proc = factory(ctx)
    const lat = typeof factory.latency === 'function' ? factory.latency(ctx) | 0 : factory.latency | 0
    if (lat) this.port.postMessage({ type: 'latency', value: lat })
    // Re-run the factory against a fresh ctx.params snapshot built from the
    // live values (this._params doubles as that snapshot: numeric names hold
    // the current block's Float32Array, non-numeric hold the raw value) —
    // same shape as first construction, so the swapped-in process fn starts
    // from a clean closure exactly like a reinstantiated instance would.
    this._rebuild = () => {
      const rp = {}
      for (const s of SPECS) {
        rp[s.name] = s.type === 'number'
          ? new Float32Array([this._params[s.name] ? this._params[s.name][0] : s.default])
          : (this._params[s.name] !== undefined ? this._params[s.name] : s.default)
      }
      const rctx = {
        sampleRate,
        maxBlockSize: 128,
        render: po.render || 'realtime',
        duration: po.duration,
        params: rp,
        transport: undefined,
        layouts: undefined,
        events: factory.events && factory.events.in && factory.events.in.length ? [] : undefined,
        get currentTime() { return self._frames / sampleRate },
        emit: (name, ...args) => {
          if (!emits || !(name in emits)) throw new Error('emit: "' + name + '" not declared in events.out')
          self.port.postMessage({ type: 'emit', name, args })
        }
      }
      this._proc = factory(rctx)
      const rlat = typeof factory.latency === 'function' ? factory.latency(rctx) | 0 : factory.latency | 0
      this.port.postMessage({ type: 'latency', value: rlat })
    }
    this.port.onmessage = (e) => {
      const d = e.data
      if (d && d.type === 'param' && this._nonNum[d.name] === true) {
        this._params[d.name] = d.value
        if (this._restart[d.name]) this._pendingRestart = true
      }
    }
  }
  process(inputs, outputs, params) {
    const p = this._params
    for (let i = 0; i < this._numNames.length; i++) {
      const k = this._numNames[i]
      p[k] = params[k]
    }
    // Cheap restart-change detection: only iterates declared restart params
    // (empty for atoms with none), comparing against the last seen scalar.
    let restartDirty = this._pendingRestart
    for (let i = 0; i < this._restartNum.length; i++) {
      const k = this._restartNum[i]
      const v = p[k][0]
      if (this._restartLive[k] !== v) { this._restartLive[k] = v; restartDirty = true }
    }
    if (restartDirty) { this._rebuild(); this._pendingRestart = false }
    const frames = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128
    if (this._smooth) for (const k in this._smooth) {
      const s = this._smooth[k], target = params[k][0]
      if (!s.init) { s.init = true; s.from = s.target = target }
      else if (target !== s.target) {
        s.from = s.from + (s.target - s.from) * s.t
        s.target = target
        s.t = 0
      }
      if (s.t < 1) s.t = Math.min(1, s.t + frames / (s.time * sampleRate))
      s.buf[0] = s.from + (s.target - s.from) * s.t
      p[k] = s.buf
    }
    const r = this._proc(inputs, outputs, p)
    this._frames += frames
    return r === undefined ? true : r
  }
}
registerProcessor(ID, Processor)
`

// Browser path — an atom source string. With `url` the worklet imports the
// real atom (atom-scope helpers and imports survive); without it the
// factory source is serialized and must be self-contained.
const buildProcessorSource = (factory, id, specs, url, exportName) => `
${url
  ? `import { ${exportName} as factory } from ${JSON.stringify(url)};`
  : `const factory = (${factory.toString()});
factory.events = ${JSON.stringify(factory.events ?? null)} || undefined;
factory.latency = ${typeof factory.latency === 'function' ? `(${factory.latency.toString()})` : JSON.stringify(factory.latency ?? 0)};`}
const ID = ${JSON.stringify(id)};
const SPECS = ${JSON.stringify(specs)};
${PROCESSOR_BODY}
`

// Node path — same body, but `factory` and constants come from the closure
// rather than serialization. Built via Function so the code path is identical.
const installProcessor = (scope, factory, id, specs) => {
  const AWP = scope.AudioWorkletProcessor ?? globalThis.AudioWorkletProcessor
  if (!AWP) throw new Error('AudioWorkletProcessor unavailable in worklet scope')
  const fn = new Function(
    'factory', 'ID', 'SPECS', 'AudioWorkletProcessor', 'registerProcessor', 'sampleRate',
    PROCESSOR_BODY
  )
  fn(factory, id, specs, AWP, scope.registerProcessor.bind(scope), scope.sampleRate)
}

export function toWam(factory, opts = {}) {
  const id = opts.id ?? factory.id ?? (factory.name && kebab(factory.name))
  if (!id) throw new Error('toWam: factory needs an id (set factory.id or use a named export)')
  if (factory.streaming === false)
    throw new Error(`toWam(atom): ${id} declares streaming: false (whole-render) — it cannot run as a realtime worklet; render it offline via audio/batch`)

  const specs = buildParamSpecs(factory.params ?? {})
  const buses = resolveBuses(factory.channels)
  const descriptor = buildDescriptor(factory, id, specs, buses)
  const numericNames = new Set(specs.filter(s => s.type === 'number').map(s => s.name))

  return {
    descriptor,
    paramSpecs: specs,

    async register(audioContext) {
      const aw = audioContext.audioWorklet

      // Closure path: web-audio-api in Node accepts a setup function; the
      // standard browser worklet only accepts URLs and falls through.
      let viaClosure = false
      try {
        await aw.addModule((scope) => {
          installProcessor(scope, factory, id, specs)
          viaClosure = true
        })
      } catch { /* fall through to URL path */ }
      if (viaClosure) return

      if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL)
        throw new Error('toWam.register: no Blob/URL support and closure-style addModule was not accepted')
      const source = buildProcessorSource(factory, id, specs, opts.url, opts.export ?? factory.name)
      const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
      try { await aw.addModule(url) }
      finally { URL.revokeObjectURL(url) }
    },

    create(audioContext, opts = {}) {
      const Ctor = globalThis.AudioWorkletNode
      if (!Ctor) throw new Error('toWam.create: globalThis.AudioWorkletNode is undefined — import "web-audio-api/polyfill" in Node, or assign AudioWorkletNode to globalThis')

      // Split parameterData: numeric goes to AudioWorkletNode constructor;
      // non-numeric rides processorOptions (present at first block).
      const incoming = opts.parameterData ?? {}
      const numericData = {}
      const nonNumericData = {}
      for (const k in incoming) {
        if (numericNames.has(k)) numericData[k] = incoming[k]
        else nonNumericData[k] = incoming[k]
      }

      const offline = typeof OfflineAudioContext !== 'undefined' && audioContext instanceof OfflineAudioContext
      const nodeOpts = {
        numberOfInputs: buses.inputs,
        numberOfOutputs: buses.outputs,
        parameterData: numericData,
        processorOptions: {
          parameterData: nonNumericData,
          render: offline ? 'offline' : 'realtime',
          duration: offline ? audioContext.length / audioContext.sampleRate : undefined
        }
      }
      const outCh = opts.outputChannelCount ?? outputChannels(factory.channels)
      if (outCh !== undefined) nodeOpts.outputChannelCount = outCh

      const node = new Ctor(audioContext, id, nodeOpts)
      // A dead processor is otherwise silent — surface it. Hosts may override.
      node.onprocessorerror = (e) => console.error(`@audio/wam [${id}] processor error`, e)
      // Worklet → host traffic: `events.out` emissions and one-shot latency report.
      node.latency = 0
      node.onemit = null
      node.port.onmessage = (e) => {
        const d = e.data
        if (!d) return
        if (d.type === 'emit') node.onemit && node.onemit(d.name, d.args)
        else if (d.type === 'latency') node.latency = d.value
      }
      // Convenience: a host-side setter that routes either side correctly.
      node.setParam = (name, value) => {
        if (numericNames.has(name)) {
          const p = node.parameters.get(name)
          if (p) p.setValueAtTime(value, audioContext.currentTime)
        } else {
          node.port.postMessage({ type: 'param', name, value })
        }
      }
      // Releases the MessagePort handle. Required after offline rendering in
      // Node — web-audio-api keeps the port live until explicitly closed.
      node.dispose = () => { try { node.port.close() } catch { /* idempotent */ } }
      return node
    }
  }
}
