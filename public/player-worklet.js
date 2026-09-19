// The worklet only drains bounded PCM buffers. No synthesis, compile, or JSON here.
class MuzPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.epoch = 0;
    this.acceptedRevision = 0;
    this.fadeRevision = null;
    this.playing = false;
    this.framesSinceReport = 0;
    this.underruns = 0;
    this.starved = false;
    this.status = { beat: 0, seconds: 0, peak: 0, rms: 0 };
    this.gain = 0;
    this.source = null;
    this.primed = false;
    this.analysis = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === "connect") {
        if (this.source) this.source.close();
        this.queue = [];
        this.offset = 0;
        this.gain = 0;
        this.primed = false;
        this.source = data.port;
        this.source.onmessage = ({ data }) => this.receive(data);
      }
      if (data.type === "playing") this.playing = data.value;
      if (data.type === "analysis") this.analysis = data.id;
    };
  }
  receive(data) {
    if (data.type === "revision" && data.epoch === this.epoch) {
      this.acceptedRevision = data.revision;
      // When paused/full, do not synthesize uncredited transition blocks. Fade
      // the queued boundary and first new block without discarding held state.
      if (data.queuedFade) {
        const last = this.queue.at(-1);
        if (last) last.fadeOut = true;
        this.fadeRevision = data.revision;
      }
    } else if (data.type === "reset") {
      for (const item of this.queue) this.recycle(item, false);
      this.queue = [];
      this.offset = 0;
      this.epoch = data.epoch;
      this.status = data.status;
      this.acceptedRevision = data.status.revision ?? 0;
      this.fadeRevision = null;
      this.gain = 0;
      this.primed = false;
      this.underruns = 0;
      this.starved = false;
      this.port.postMessage({
        type: "position",
        ...this.status,
        epoch: this.epoch,
        underruns: 0,
        meters: [],
      });
    } else if (data.type === "audio") {
      if (data.epoch !== this.epoch || this.queue.length >= 32)
        this.recycle(data, false);
      else {
        if (
          this.fadeRevision !== null &&
          data.meta.status.revision >= this.fadeRevision
        ) {
          data.fadeIn = true;
          this.fadeRevision = null;
        }
        this.queue.push(data);
      }
    }
  }
  recycle(item, credit = true) {
    this.source?.postMessage(
      {
        type: credit ? "credit" : "recycle",
        epoch: item.epoch,
        buffer: item.audio.buffer,
      },
      [item.audio.buffer],
    );
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!left || !right) return true;
    if (!this.playing) {
      this.gain = 0;
      return true;
    }
    if (!this.primed) {
      if (
        this.queue.length >= 8 ||
        this.queue.some((item) => item.meta.status.done)
      )
        this.primed = true;
      else return true;
    }
    for (let i = 0; i < left.length; i++) {
      const item = this.queue[0];
      if (!item) {
        if (!this.starved) this.underruns++;
        this.starved = true;
        this.gain = 0;
        break;
      }
      this.starved = false;
      this.gain = Math.min(1, this.gain + 1 / (sampleRate * 0.005));
      const phase = this.offset / Math.max(1, item.meta.frames - 1);
      const gain =
        this.gain * (item.fadeOut ? 1 - phase : 1) * (item.fadeIn ? phase : 1);
      left[i] = item.audio[this.offset * 2] * gain;
      right[i] = item.audio[this.offset * 2 + 1] * gain;
      const monitor = outputs[1];
      if (monitor && item.analysis === this.analysis) {
        const start = item.meta.frames * 2;
        monitor[0][i] = item.audio[start + this.offset * 2] * gain;
        monitor[1][i] = item.audio[start + this.offset * 2 + 1] * gain;
      }
      this.offset++;
      const end = item.meta.status;
      if (i === left.length - 1) {
        const f = this.offset / item.meta.frames;
        const endBeat =
          end.beat >= item.meta.startBeat
            ? end.beat
            : item.meta.startBeat +
              ((item.meta.frames / sampleRate) * end.bpm) / 60;
        this.status = {
          ...end,
          beat: item.meta.startBeat + (endBeat - item.meta.startBeat) * f,
          seconds: item.meta.startSeconds + this.offset / sampleRate,
          meters: item.meta.meters,
        };
      }
      if (this.offset === item.meta.frames) {
        this.queue.shift();
        this.offset = 0;
        this.status = { ...end, meters: item.meta.meters };
        this.recycle(item);
        if (end.done && (end.revision ?? 0) >= this.acceptedRevision) {
          this.playing = false;
          this.port.postMessage({
            type: "ended",
            ...this.status,
            epoch: this.epoch,
          });
          break;
        }
      }
    }
    this.framesSinceReport += left.length;
    if (this.framesSinceReport >= 2048) {
      this.framesSinceReport = 0;
      this.port.postMessage({
        type: "position",
        ...this.status,
        epoch: this.epoch,
        underruns: this.underruns,
        buffered: this.queue.length,
      });
    }
    return true;
  }
}
registerProcessor("muz-player", MuzPlayer);
