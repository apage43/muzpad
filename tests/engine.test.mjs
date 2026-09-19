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

function tinyWav() {
  const frames = 480,
    bytes = new Uint8Array(44 + frames * 2),
    v = new DataView(bytes.buffer);
  const text = (at, s) =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, bytes.length - 8, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 96000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    v.setInt16(44 + i * 2, i % 16 < 8 ? 6000 : -6000, true);
  return bytes;
}
const tinyMidi = Uint8Array.from([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b,
  0, 0, 0, 12, 0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 0xff, 0x2f, 0,
]);
const tinyFlac = Uint8Array.from(
  "664c614300000022100010000000000000000bb800f0000000200000000000000000000000000000000084000028200000007265666572656e6365206c6962464c414320312e352e3020323032353032313100000000fff86a08001f7a000000f914"
    .match(/../g)
    .map((x) => parseInt(x, 16)),
);

test("independent WASM instances transfer MIDI, WAV and FLAC memory assets", async () => {
  const compiler = await createEngine(bytes),
    renderer = await createEngine(bytes);
  const entries = [
    {
      path: "part.mid",
      version: `sha256:${"0".repeat(12)}1${"0".repeat(51)}`,
      bytes: tinyMidi,
    },
    {
      path: "tone.wav",
      version: `sha256:${"0".repeat(12)}2${"0".repeat(51)}`,
      bytes: tinyWav(),
    },
    {
      path: "tone.flac",
      version: `sha256:${"0".repeat(12)}3${"0".repeat(51)}`,
      bytes: tinyFlac,
    },
  ];
  compiler.call({ command: "assets", entries });
  renderer.call({ command: "assets", entries });
  const assetFiles = {
    "song.muz":
      'song({tracks:[track("m",midi("part.mid"),synth("bell")),track("w",note(60,1b),sample("tone.wav",{attack_ms:0,release_ms:0})),clip("f","tone.flac",{fade_in:0,fade_out:0})],tail:0})',
  };
  const compiled = compiler.call({
    command: "compile",
    files: assetFiles,
    entry: "song.muz",
  });
  assert.equal(compiled.snapshot.performed[0].midi.notes.length, 1);
  assert.ok(compiled.snapshot.assets.length >= 2);
  renderer.call({ command: "load", snapshot: compiled.snapshot, rate: 48000 });
  renderer.call({ command: "render", frames: 480 });
  assert.ok(renderer.audio(480).some((v) => Math.abs(v) > 0.0001));
});

test("asset cache recovers after a failed upload prunes an older version", async () => {
  const engine = await createEngine(bytes);
  const old = {
    path: "part.mid",
    version: `sha256:${"1".repeat(64)}`,
    bytes: tinyMidi,
  };
  engine.call({ command: "assets", entries: [old] });
  assert.throws(
    () =>
      engine.call({
        command: "assets",
        entries: [
          {
            ...old,
            version: `sha256:${"2".repeat(64)}`,
            bytes: new Uint8Array(16_000_001),
          },
        ],
      }),
    /16 MB/,
  );
  engine.call({ command: "assets", entries: [old] });
  const compiled = engine.call({
    command: "compile",
    entry: "song.muz",
    files: {
      "song.muz":
        'song({tracks:[track("x",midi("part.mid"),synth("bell"))],tail:0})',
    },
  });
  assert.equal(compiled.snapshot.performed[0].midi.notes.length, 1);
});

test("WASM compiler snapshot carries performed events into an independent audio instance", async () => {
  const compiler = await createEngine(bytes),
    renderer = await createEngine(bytes);
  const compiled = compiler.call({
    command: "compile",
    files,
    entry: "song.muz",
  });
  assert.equal(compiled.snapshot.version, 1);
  assert.equal(compiled.snapshot.performed[0].midi.notes.length, 4);
  const locations = compiler.call({
    command: "inspect",
    revision: compiled.revision,
    view: "locations",
  });
  assert.equal(locations.rows[0].location.path, "part.muz");
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
  broken.performed.length = 0;
  assert.throws(
    () => renderer.call({ command: "load", snapshot: broken, rate: 48000 }),
    /missing performed association/,
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
  const compiled = compiler.call({
    command: "compile",
    files,
    entry: "song.muz",
  });
  const graph = compiler.call({
    command: "inspect",
    revision: compiled.revision,
    view: "graph",
  });
  assert.ok(graph.rows.length >= 1);
});

test("retained prepare can be discarded, rejects stale base and transport races", async () => {
  const compiler = await createEngine(bytes),
    renderer = await createEngine(bytes);
  const first = compiler.call({ command: "compile", files, entry: "song.muz" });
  renderer.call({ command: "load", snapshot: first.snapshot, rate: 48000 });
  const base = renderer.call({ command: "status" }).revision;
  const changed = {
    ...files,
    "song.muz":
      'use "part.muz" as p; song({title:"rename",tempo:120,tracks:[p.line],tail:0.1})',
  };
  const second = compiler.call({
    command: "compile",
    files: changed,
    entry: "song.muz",
  });
  const prepared = renderer.call({
    command: "prepare",
    snapshot: second.snapshot,
    base_revision: base,
    request: 9,
    rate: 48000,
  });
  assert.equal(prepared.base_revision, base);
  renderer.call({ command: "discard" });
  assert.equal(renderer.call({ command: "status" }).revision, base);
  assert.throws(
    () =>
      renderer.call({
        command: "prepare",
        snapshot: second.snapshot,
        base_revision: base + 1,
        request: 10,
        rate: 48000,
      }),
    /stale base revision/,
  );
  renderer.call({
    command: "prepare",
    snapshot: second.snapshot,
    base_revision: base,
    request: 11,
    rate: 48000,
  });
  renderer.call({ command: "seek", beat: 1 });
  assert.throws(
    () => renderer.call({ command: "apply", request: 11 }),
    /transport|generation|stale/i,
  );
  assert.equal(renderer.call({ command: "status" }).revision, base);
});

test("compatible schedule edit retains a sounding voice without changing immediate PCM", async () => {
  const compiler = await createEngine(bytes),
    baseline = await createEngine(bytes),
    edited = await createEngine(bytes);
  const oldFiles = {
    "song.muz":
      'song({tracks:[track("held",stack([note(60,4b).gate(1),note(64,1b).at(3b)]),synth("pad"))],tail:0})',
  };
  const newFiles = {
    "song.muz":
      'song({tracks:[track("held",stack([note(60,4b).gate(1),note(67,1b).at(3b)]),synth("pad"))],tail:0})',
  };
  const old = compiler.call({
    command: "compile",
    files: oldFiles,
    entry: "song.muz",
  });
  baseline.call({ command: "load", snapshot: old.snapshot, rate: 48000 });
  edited.call({ command: "load", snapshot: old.snapshot, rate: 48000 });
  baseline.call({ command: "render", frames: 1024 });
  edited.call({ command: "render", frames: 1024 });
  assert.deepEqual(edited.audio(1024), baseline.audio(1024));
  const candidate = compiler.call({
    command: "compile",
    files: newFiles,
    entry: "song.muz",
  });
  const base = edited.call({ command: "status" }).revision;
  const prepared = edited.call({
    command: "prepare",
    snapshot: candidate.snapshot,
    base_revision: base,
    request: 21,
    rate: 48000,
  });
  assert.equal(prepared.needs_fade, false);
  edited.call({ command: "apply", request: 21 });
  baseline.call({ command: "render", frames: 1024 });
  edited.call({ command: "render", frames: 1024 });
  assert.deepEqual(edited.audio(1024), baseline.audio(1024));
});

test("malformed snapshot rejection retains accepted renderer state", async () => {
  const compiler = await createEngine(bytes),
    renderer = await createEngine(bytes);
  const compiled = compiler.call({
    command: "compile",
    files,
    entry: "song.muz",
  });
  renderer.call({ command: "load", snapshot: compiled.snapshot, rate: 48000 });
  renderer.call({ command: "render", frames: 256 });
  const revision = renderer.call({ command: "status" }).revision;
  const broken = structuredClone(compiled.snapshot);
  broken.performed[0].midi.notes[0].duration_ticks = 0;
  assert.throws(
    () =>
      renderer.call({
        command: "prepare",
        snapshot: broken,
        base_revision: revision,
        request: 30,
        rate: 48000,
      }),
    /endpoint|duration|summary/,
  );
  renderer.call({ command: "render", frames: 256 });
  assert.equal(renderer.call({ command: "status" }).revision, revision);
  assert.ok(renderer.audio(256).some((v) => Math.abs(v) > 0.000001));
});

test("explain and diff are revision-bound and reject stale inspection", async () => {
  const compiler = await createEngine(bytes);
  const first = compiler.call({ command: "compile", files, entry: "song.muz" });
  compiler.call({ command: "accept_compilation", revision: first.revision });
  const changed = {
    ...files,
    "part.muz":
      'use "std/synthesis" as s; let line = track("lead", phrase("C4:q E4:q A4:q B4:q"), s.pluck());',
  };
  const second = compiler.call({
    command: "compile",
    files: changed,
    entry: "song.muz",
  });
  const explanation = compiler.call({
    command: "explain",
    revision: second.revision,
    track: "lead",
    page: { offset: 0, limit: 1, revision: second.revision },
  });
  assert.equal(explanation.revision, second.revision);
  assert.ok(explanation.page.total > 0);
  const diff = compiler.call({
    command: "diff",
    revision: second.revision,
    category: "notes",
    page: { offset: 0, limit: 1, revision: second.revision },
  });
  assert.equal(diff.base_revision, first.revision);
  assert.ok(diff.page.total > 0);
  assert.throws(
    () =>
      compiler.call({
        command: "inspect",
        revision: second.revision,
        view: "summary",
        page: { revision: first.revision },
      }),
    /stale page revision/,
  );
  assert.throws(
    () => compiler.call({ command: "diff", revision: 999, category: "notes" }),
    /stale inspection revision/,
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
