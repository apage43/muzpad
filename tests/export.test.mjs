import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEngine } from "../src/engine.js";
import { bounceWav, createWav } from "../src/export-audio.js";
const bytes = await readFile(new URL("../public/muz.wasm", import.meta.url));
async function fixture() {
  const engine = await createEngine(bytes);
  const { snapshot } = engine.call({
    command: "compile",
    files: {
      "s.muz":
        'song({tempo:100,tracks:[track("one",phrase("C4:q D4:q"),synth("init")),track("two",phrase("G4:q A4:q"),synth("init"))],tail:0.1})',
    },
    entry: "s.muz",
  });
  return { engine, snapshot };
}
function chunks(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.toString("ascii", 0, 4), "MThd");
  assert.equal(b.readUInt16BE(8), 1);
  assert.equal(b.readUInt16BE(12), 960);
  const out = [];
  for (let i = 14; i < b.length;) {
    assert.equal(b.toString("ascii", i, i + 4), "MTrk");
    const len = b.readUInt32BE(i + 4);
    out.push(b.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  assert.equal(out.length, b.readUInt16BE(10));
  return out;
}
test("MIDI export keeps conductor, names, performed notes and selection", async () => {
  const { engine, snapshot } = await fixture();
  const all = chunks(
    engine.call({ command: "export_midi", snapshot, tracks: ["one", "two"] })
      .bytes,
  );
  const single = chunks(
    engine.call({ command: "export_midi", snapshot, tracks: ["two"] }).bytes,
  );
  assert.equal(all.length, 3);
  assert.equal(single.length, 2);
  assert.deepEqual(single[0], all[0]);
  assert.deepEqual(single[1], all[2]);
  assert.ok(single[1].includes(Buffer.from("two")));
  assert.ok(single[1].includes(Buffer.from([0x90, 67])));
  assert.ok(single[1].includes(Buffer.from([0x80, 67])));
  assert.ok(
    single[0].includes(Buffer.from([0xff, 0x51, 3, 9, 0x27, 0xc0])),
    "100 BPM tempo",
  );
  assert.ok(single[0].includes(Buffer.from([0xff, 0x58, 4, 4, 2, 24, 8])));
  assert.throws(
    () => engine.call({ command: "export_midi", snapshot, tracks: [] }),
    /select at least/,
  );
  assert.throws(
    () =>
      engine.call({ command: "export_midi", snapshot, tracks: ["missing"] }),
    /unknown MIDI/,
  );
});
test("PCM headers, signed limits, clipping and allocation guard", () => {
  for (const bits of [16, 24]) {
    const wav = createWav(2, 48000, bits);
    wav.write(new Float32Array([-1, 1, 2, -2]), 0);
    const b = Buffer.from(wav.bytes);
    assert.equal(b.readUInt32LE(40), (4 * bits) / 8);
    assert.equal(b.readUInt16LE(34), bits);
    assert.equal(b.readUInt16LE(22), 2);
    assert.equal(b.readIntLE(44, bits / 8), -(2 ** (bits - 1)));
    assert.equal(b.readIntLE(44 + bits / 8, bits / 8), 2 ** (bits - 1) - 1);
    assert.equal(wav.clipped, 2);
  }
  assert.throws(() => createWav(100_000_000, 48000, 24), /256 MB/);
  assert.throws(() => createWav(1, 48000, 24).write([NaN], 0), /non-finite/);
});
test("offline WAV trims exact frames, includes tail and isolates selected tracks", async () => {
  const { snapshot } = await fixture();
  async function render(tracks, start, end) {
    const engine = await createEngine(bytes);
    engine.call({ command: "load", snapshot, rate: 48000 });
    return bounceWav(engine, { rate: 48000, bits: 24, start, end, tracks })
      .bytes;
  }
  const full = await render(["one", "two"], 0, 1.3);
  assert.equal(full.length, 44 + 62400 * 6);
  const crop = await render(["one", "two"], 0.2, 0.8);
  assert.deepEqual(
    crop.subarray(44),
    full.subarray(44 + 9600 * 6, 44 + 38400 * 6),
  );
  const solo = await render(["one"], 0, 1.3);
  assert.notDeepEqual(solo.subarray(44), full.subarray(44));
  assert.ok(solo.subarray(44).some((x) => x !== 0));
});
