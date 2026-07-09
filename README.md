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

For batch/stream hosting without an AudioContext see [`audio/batch`](https://github.com/audiojs/audio); for compiling atoms to native plugin formats (CLAP, VST3, AU, LV2) see [`@audio/compile`](https://github.com/audiojs/compile).
