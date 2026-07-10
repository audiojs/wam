# @audio/wam

Run [audio.js atoms](https://github.com/audiojs/compile/blob/main/CONTRACT.md) as Web Audio Modules / AudioWorklet nodes.

A single JS factory function with attached metadata becomes a WAM 2.0-shaped plugin — numeric params ride AudioParams, enum/bool params flow over MessagePort, works in browsers and Node ([web-audio-api](https://github.com/audiojs/web-audio-api)).

## Use

```js
import { toWam } from '@audio/wam'
import { gain } from './gain.js'

const wam = toWam(gain, { url: new URL('./gain.js', import.meta.url).href })
await wam.register(audioContext)    // installs the factory as an AudioWorklet processor
                                    // `url` lets the worklet import the atom itself;
                                    // omit it only for self-contained factories
const node = wam.create(audioContext, { parameterData: { value: -6 } })
source.connect(node).connect(audioContext.destination)

node.setParam('value', -12)         // numeric → AudioParam, enum/bool → MessagePort
node.onemit = (name, args) => {}    // events.out emissions (meters, detected pitch)
node.dispose()                      // releases the MessagePort (needed after offline render in Node)
```

Any package exposing an `audio.js` manifest (the `"audio"` field in its package.json) works — see the [contract](https://github.com/audiojs/compile/blob/main/CONTRACT.md).

`flags: ['restart']` params (attack/release-style coefficients baked at factory time) actually restart: a live `setParam` on a restart-flagged param re-runs the atom factory against a fresh `ctx.params` snapshot and swaps in the new process fn — state resets, matching the contract's "reconfigure = new instance" lifecycle rule. `streaming: false` (whole-render) atoms are refused at `toWam()` — they hold the entire timeline, so wrapping one in a 128-frame worklet would silently produce wrong output; render those offline via [`audio/batch`](https://github.com/audiojs/audio) instead.

For batch/stream hosting without an AudioContext see [`audio/batch`](https://github.com/audiojs/audio); for compiling atoms to native plugin formats (CLAP, VST3, AU, LV2) see [`@audio/compile`](https://github.com/audiojs/compile).
