/**
 * AudioWorklet capture processor. Lives in `public/` so Vite serves it verbatim
 * (AudioWorkletGlobalScope has no module system, so it must not be bundled or
 * import anything). Accumulates the mic's native-rate Float32 samples into
 * fixed-size frames and ships them to the main thread, which converts to Int16
 * PCM and forwards over the WS. The browser stays dumb: no VAD, no resample,
 * no STT here -- the server does all of that (see AGENTS.md "Keep the browser
 * dumb").
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = 2048;
    this.acc = new Float32Array(this.frameSize);
    this.len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const space = this.frameSize - this.len;
      const take = Math.min(space, channel.length - offset);
      this.acc.set(channel.subarray(offset, offset + take), this.len);
      this.len += take;
      offset += take;
      if (this.len === this.frameSize) {
        // Copy out so the next frame doesn't race the structured clone.
        this.port.postMessage(this.acc.slice(0, this.frameSize));
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
