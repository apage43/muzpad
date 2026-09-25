/** Stereo integer PCM WAV, bounded before allocating the destination. */
export function createWav(frames, rate, bits) {
  if (
    !Number.isSafeInteger(frames) ||
    frames < 1 ||
    ![44100, 48000, 96000].includes(rate) ||
    ![16, 24].includes(bits)
  )
    throw new Error("Invalid WAV settings");
  const dataSize = frames * 2 * (bits / 8);
  if (dataSize > 256 * 1024 * 1024)
    throw new Error(
      "WAV exceeds the 256 MB export limit. Choose a shorter range or lower sample rate.",
    );
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * 2 * bits) / 8, true);
  view.setUint16(32, (2 * bits) / 8, true);
  view.setUint16(34, bits, true);
  text(36, "data");
  view.setUint32(40, dataSize, true);
  let clipped = 0;
  return {
    bytes,
    get clipped() {
      return clipped;
    },
    write(samples, frameOffset) {
      let offset = 44 + (frameOffset * 2 * bits) / 8;
      for (const sample of samples) {
        if (!Number.isFinite(sample))
          throw new Error("Audio contains a non-finite sample");
        if (Math.abs(sample) > 1) clipped++;
        const value = Math.max(-1, Math.min(1, sample));
        const scale = 2 ** (bits - 1);
        const n = Math.round(value * (value < 0 ? scale : scale - 1));
        if (bits === 16) view.setInt16(offset, n, true);
        else {
          view.setUint8(offset, n & 255);
          view.setUint8(offset + 1, (n >> 8) & 255);
          view.setUint8(offset + 2, (n >> 16) & 255);
        }
        offset += bits / 8;
      }
    },
  };
}

export function bounceWav(engine, options, progress = (_fraction) => {}) {
  const { rate, bits, start, end, tracks } = options;
  const status = engine.call({ command: "status" });
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    !tracks.length
  )
    throw new Error("Select tracks and a valid time range");
  if (status.seconds !== 0)
    throw new Error("Export renderer must start at zero");
  engine.call({ command: "audition", muted: [], solo: tracks, ramp: false });
  const latency = status.latencyFrames ?? 0;
  const first = Math.round(start * rate) + latency,
    last = Math.round(end * rate) + latency;
  const wav = createWav(last - first, rate, bits);
  // Render the lead-in as well, preserving sustained notes and effect history.
  for (let frame = 0; frame < last;) {
    const frames = Math.min(1024, last - frame);
    engine.call({ command: "render", frames });
    if (frame + frames > first) {
      const skip = Math.max(0, first - frame);
      wav.write(
        engine.audio(frames).subarray(skip * 2),
        Math.max(0, frame - first),
      );
    }
    frame += frames;
    if (frame % (1024 * 32) === 0 || frame === last) progress(frame / last);
  }
  return { bytes: wav.bytes, clipped: wav.clipped };
}
