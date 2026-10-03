import { test } from "node:test";
import assert from "node:assert/strict";
import { spectrumPixelBins, displaySmoothingAlpha } from "../src/analysis-layout.ts";

for (const sampleRate of [44_100, 48_000, 96_000]) {
  test(`log spectrum mapping uses sampleRate/N at ${sampleRate}`, () => {
    const native = spectrumPixelBins(400, sampleRate, 2048, 1025);
    const web = spectrumPixelBins(400, sampleRate, 2048, 1024);
    const frequency = 1000;
    const pixel = Math.floor(Math.log(frequency / 20) / Math.log((sampleRate / 2) / 20) * 400);
    const bin = Math.floor(frequency * 2048 / sampleRate);
    assert.ok(native.first[pixel] <= bin && native.last[pixel] >= bin);
    assert.deepEqual(native.first.subarray(0, 399), web.first.subarray(0, 399));
    assert.equal(native.last[399], 1024, "native Nyquist is included at the right endpoint");
    assert.ok(web.last[399] <= 1023, "unavailable browser Nyquist is never invented");
    for (let x = 0; x < 400; x++) {
      assert.ok(native.first[x] >= 0 && native.first[x] <= native.last[x]);
      assert.ok(native.last[x] <= 1024);
      if (x) assert.ok(native.first[x] >= native.first[x - 1]);
    }
  });
}

test("display smoothing composes by elapsed time rather than frame count", () => {
  const a = displaySmoothingAlpha(16), b = displaySmoothingAlpha(33);
  assert.ok(Math.abs((1 - (1 - a) * (1 - b)) - displaySmoothingAlpha(49)) < 1e-12);
  assert.equal(displaySmoothingAlpha(0), 0);
  assert.equal(displaySmoothingAlpha(-1), 0);
});
