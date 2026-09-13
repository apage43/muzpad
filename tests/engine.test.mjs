import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEngine } from "../src/engine.js";
const bytes = await readFile(new URL("../public/muz.wasm", import.meta.url));
const files = {
  "song.muz":
    'use "part.muz" as p; song({tempo: 120, tracks: [p.line], tail: 0.1})',
  "part.muz":
    'use "std/synthesis" as s; let line = track("lead", phrase("C4:q E4:q G4:q B4:q"), s.pluck());',
};

test("WASM compiler snapshot carries performed events into an independent audio instance", async () => {
  const compiler = await createEngine(bytes),
    renderer = await createEngine(bytes);
  const compiled = compiler.call({
    command: "compile",
    files,
    entry: "song.muz",
  });
  assert.equal(compiled.snapshot.events.lead.notes.length, 4);
  assert.equal(compiled.views.locations["track.lead"].path, "part.muz");
  const status = renderer.call({
    command: "load",
    snapshot: compiled.snapshot,
    rate: 48000,
  });
  assert.equal(status.endBeat, 4);
  assert.equal(status.duration, 2);
  renderer.call({ command: "seek", beat: 2 });
  const rendered = renderer.call({ command: "render", frames: 1024 });
  assert.equal(rendered.startBeat, 2);
  assert.ok(rendered.status.beat > 2);
  const pcm = renderer.audio(1024);
  assert.ok(pcm.every(Number.isFinite));
  assert.ok(pcm.some((v) => Math.abs(v) > 0.0001));
  const broken = structuredClone(compiled.snapshot);
  delete broken.events.lead;
  assert.throws(
    () => renderer.call({ command: "load", snapshot: broken, rate: 48000 }),
    /missing performed track/,
  );
  assert.ok(
    renderer.call({ command: "render" }).startBeat > 2,
    "rejected preparation retains accepted engine",
  );
});

test("WASM diagnostics survive invalid edits and module cycles without poisoning later runs", async () => {
  const compiler = await createEngine(bytes);
  try {
    compiler.call({
      command: "compile",
      files: { ...files, "part.muz": "// café\nunknown_name(1)" },
      entry: "song.muz",
    });
    assert.fail();
  } catch (error) {
    assert.equal(error.diagnostic.location.path, "part.muz");
    assert.equal(error.diagnostic.location.line, 2);
  }
  assert.throws(
    () =>
      compiler.call({
        command: "compile",
        files: { "a.muz": 'use "a.muz" as a; a' },
        entry: "a.muz",
      }),
    /circular import/,
  );
  assert.throws(
    () =>
      compiler.call({
        command: "compile",
        files: { "a.muz": 'use "../escape.muz" as a; a' },
        entry: "a.muz",
      }),
    /escapes the project/,
  );
  assert.equal(
    compiler.call({ command: "compile", files, entry: "song.muz" }).views.graph
      .tracks.length,
    1,
  );
});

test("WASM loops remain inside their range and one-shot playback finishes after the tail", async () => {
  const e = await createEngine(bytes);
  const c = e.call({ command: "compile", files, entry: "song.muz" });
  e.call({ command: "load", snapshot: c.snapshot, rate: 48000 });
  e.call({ command: "seek", beat: 1 });
  e.call({ command: "loop", range: [1, 1.25] });
  let wraps = 0,
    previous = 1;
  for (let i = 0; i < 20; i++) {
    const s = e.call({ command: "render" }).status;
    assert.ok(s.beat >= 1 && s.beat < 1.25);
    if (s.beat < previous) wraps++;
    previous = s.beat;
  }
  assert.ok(wraps > 0);
  e.call({ command: "loop", range: null });
  e.call({ command: "seek", beat: 3.9 });
  let done = false;
  for (let i = 0; i < 12; i++)
    done ||= e.call({ command: "render" }).status.done;
  assert.equal(done, true);
});

test("analysis taps a selected track without replacing the master mix", async () => {
  const e = await createEngine(bytes);
  const compiled = e.call({ command: "compile", files, entry: "song.muz" });
  e.call({ command: "load", snapshot: compiled.snapshot, rate: 48000 });
  const meta = e.call({ command: "render", analysis: "lead" });
  const tap = e.audio(1024, undefined, true);
  assert.ok(tap.some((v) => Math.abs(v) > 0.0001));
  assert.ok(
    Math.abs(Math.max(...tap.map(Math.abs)) - meta.meters[0].peak) < 1e-6,
  );
  e.call({ command: "render", analysis: "missing" });
  assert.ok(e.audio(1024, undefined, true).every((v) => v === 0));
  assert.ok(e.audio(1024).some((v) => Math.abs(v) > 0.0001));
  e.call({ command: "render", analysis: null });
  assert.deepEqual(e.audio(1024, undefined, true), e.audio(1024));
});
