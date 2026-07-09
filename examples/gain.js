// Stateless gain — multiplies every sample by 10^(value/20).
// Sample-accurate (`rate: 'sample'`) so AudioParam ramps don't introduce
// per-block zipper noise when the host automates the value.

export const gain = (ctx) => (inputs, outputs, params) => {
  const inp = inputs[0], out = outputs[0]
  if (!inp || inp.length === 0) return
  const v = params.value
  // Hosts pass length 1 when the param is constant across the block, length =
  // frames when automating. Branch once to keep the steady-state path fast.
  if (v.length === 1) {
    const g = 10 ** (v[0] / 20)
    for (let c = 0; c < inp.length; c++) {
      const ic = inp[c], oc = out[c]
      for (let i = 0; i < ic.length; i++) oc[i] = ic[i] * g
    }
  } else {
    for (let c = 0; c < inp.length; c++) {
      const ic = inp[c], oc = out[c]
      for (let i = 0; i < ic.length; i++) oc[i] = ic[i] * 10 ** (v[i] / 20)
    }
  }
}
gain.params = {
  value: { type: 'number', min: -60, max: 6, default: 0, rate: 'sample' }
}
gain.vendor = 'org.audiojs'
gain.version = '0.0.0'
