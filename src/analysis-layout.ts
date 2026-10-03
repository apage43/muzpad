/** Frequency bins are k*sampleRate/N; browser and native arrays differ at Nyquist. */
export function spectrumPixelBins(width: number, sampleRate: number, sampleCount: number, bins: number) {
  const first = new Int32Array(width), last = new Int32Array(width);
  const low = Math.min(20, sampleRate / 2), high = sampleRate / 2;
  for (let x = 0; x < width; x++) {
    const a = low * (high / low) ** (x / width);
    const b = low * (high / low) ** ((x + 1) / width);
    first[x] = Math.min(bins - 1, Math.max(0, Math.floor(a * sampleCount / sampleRate)));
    last[x] = x === width - 1 ? bins - 1 :
      Math.min(bins - 1, Math.max(first[x], Math.ceil(b * sampleCount / sampleRate) - 1));
  }
  return { first, last };
}

/** 80ms display-only time constant, independent of frame cadence. */
export const displaySmoothingAlpha = (elapsedMs: number) => 1 - Math.exp(-Math.max(0, elapsedMs) / 80);
