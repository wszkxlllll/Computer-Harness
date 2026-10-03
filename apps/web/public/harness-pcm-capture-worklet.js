class HarnessPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === "harness-flush") this.port.postMessage({ type: "harness-flushed" });
    };
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0] && inputs[0][0];
    if (input && input.length) {
      const frame = input.slice();
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("harness-pcm-capture", HarnessPcmCapture);
