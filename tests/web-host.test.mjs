import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { assetTransfers, createAsset } from "../src/assets.js";

const fixtureURL = "data:text/javascript;base64," + Buffer.from(`
export class Compiler {
  next = 0;
  async call(message) {
    if (message.command === "compile") return { revision: ++this.next,
      snapshot: { description: { tracks: [{ id: "lead", name: "Lead", source: { kind: "midi" } }], extras: { tail: 1 } } } };
    if (message.command === "inspect") return { revision: message.revision, rows: [], total: 0 };
    if (message.command === "format") return { source: message.source.trim() };
    return {};
  }
  reset() { this.next = 0; }
  dispose() {}
}
export class AudioPlayer {
  context = { sampleRate: 48000 };
  revision = 0; playing = false; loop = null;
  async accept(snapshot, isCurrent, assets, onCommit, authorize) {
    await authorize?.();
    if (!isCurrent()) return null;
    onCommit?.();
    return { revision: ++this.revision, beat: 0, seconds: 0, duration: 4, endBeat: 8, bpm: 120, meter: [4,4] };
  }
  async seek(beat) { return { revision: this.revision, beat, seconds: beat / 2 }; }
  async play() { this.playing = true; }
  pause() { this.playing = false; }
  async stop() { this.pause(); return this.seek(this.loop?.[0] ?? 0); }
  async setLoop(range) { this.loop = range; return this.seek(range?.[0] ?? 0); }
  async panic() { return this.seek(0); }
  async setAudition() {}
  setAnalysisEnabled() {}
  selectAnalysis() {}
  async shutdown() { this.revision = 0; }
}
export class WebProjectStore {}
export class WebPreferencesStore {}
`).toString("base64");
const sourceURL = new URL("../src/host/web.ts", import.meta.url);
const source = await readFile(sourceURL, "utf8");
const compiled = stripTypeScriptTypes(source)
  .replace(/from "(?:\.\.\/audio|\.\/web-projects|\.\/web-preferences)"/g, `from "${fixtureURL}"`)
  .replaceAll("import.meta.url", JSON.stringify(sourceURL.href));
const { WebRuntime, webPageRequest, sameRevision } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

function projectFixture(assets = {}) {
  const pins = new Map();
  const metadata = (id) => ({ id, project: "project", epoch: "epoch", sourceVersion: Number(id.slice(1)), entry: "song.muz" });
  return {
    pins,
    getSourceSnapshotMetadata: metadata,
    getSourceSnapshot(id) {
      return { snapshot: metadata(id), files: { "song.muz": "source" },
        assets: assetTransfers(assets), title: "Song" };
    },
    pinSourceSnapshot(id) { pins.set(id, (pins.get(id) ?? 0) + 1); },
    releaseSourceSnapshot(id) { pins.set(id, pins.get(id) - 1); },
    async validateSourceSnapshot() {},
  };
}
const operation = (signal) => ({ requestId: crypto.randomUUID(), signal });

test("tick filtering rejects imprecise identities and revision equality includes every field", () => {
  assert.deepEqual(webPageRequest({ start_tick: "960000", limit: 1000 }), { limit: 1000, start_tick: 960000 });
  for (const tick of ["01", "-1", "1.5", "9007199254740992"]) assert.throws(() => webPageRequest({ start_tick: tick }));
  assert.throws(() => webPageRequest({ limit: 1001 }));
  const ref = { project: "p", epoch: "e", engineEpoch: "engine", revision: "1", sourceVersion: 1, entry: "song.muz" };
  assert.ok(sameRevision(ref, { ...ref }));
  for (const field of Object.keys(ref)) assert.equal(sameRevision(ref, { ...ref, [field]: "changed" }), false);
});

test("asset rebuild phases reuse metadata and decode only at the actual compiler/audio transfer boundary", async () => {
  const bytes = { "beat.mid": new Uint8Array([0, 1, 127, 255]), "sample.wav": new Uint8Array([255, 2, 0, 128, 64]) };
  const assets = Object.fromEntries(await Promise.all(Object.entries(bytes).map(async ([path, data]) => [path, await createAsset(path, data)])));
  const projects = projectFixture(assets);
  const runtime = new WebRuntime(projects, "test-core");
  const originalAtob = globalThis.atob;
  let decodes = 0;
  globalThis.atob = (value) => { decodes++; return originalAtob(value); };
  const events = [], transfers = [];
  runtime.subscribe((event) => { if (event.kind === "build") events.push({ ...event, decodes }); });
  const compilerCall = runtime.compiler.call.bind(runtime.compiler);
  runtime.compiler.call = async (message) => {
    if (message.command === "assets") transfers.push({ target: "compiler", assets: message.entries });
    return compilerCall(message);
  };
  const accept = runtime.player.accept.bind(runtime.player);
  runtime.player.accept = async (...args) => {
    transfers.push({ target: "audio", assets: args[2] });
    return accept(...args);
  };
  const op = operation();
  try {
    const accepted = await runtime.rebuild({ snapshot: "s1", base: null }, op);
    assert.deepEqual(events.map(({ phase, decodes }) => ({ phase, decodes })), [
      { phase: "compiling", decodes: 2 }, { phase: "preparing", decodes: 2 },
      { phase: "applying", decodes: 2 }, { phase: "accepted", decodes: 2 },
    ]);
    for (const event of events) {
      assert.equal(event.requestId, op.requestId);
      assert.deepEqual(event.project, { project: "project", epoch: "epoch" });
      assert.equal(event.sourceVersion, 1);
      assert.deepEqual(event.ref, event.phase === "accepted" ? accepted.ref : null);
      assert.equal(event.failure, null);
    }
    assert.equal(decodes, 2, "each asset is decoded once, independent of the number of build phases");
    assert.deepEqual(transfers.map(({ target }) => target), ["compiler", "audio"]);
    const expected = Object.entries(assets).map(([path, asset]) => ({ path, format: asset.format, version: asset.version, bytes: bytes[path] }));
    for (const transfer of transfers) assert.deepEqual(transfer.assets, expected);
    assert.strictEqual(transfers[0].assets, transfers[1].assets, "compiler and audio receive the same captured transfer buffers");
  } finally {
    await runtime.dispose();
    globalThis.atob = originalAtob;
  }
  assert.ok([...projects.pins.values()].every((count) => count === 0));
});

test("queued, superseded and pre-transfer rejected asset builds emit metadata without decoding", async () => {
  const projects = projectFixture({ "beat.mid": await createAsset("beat.mid", new Uint8Array([0, 127, 255])) });
  const runtime = new WebRuntime(projects, "test-core");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  projects.validateSourceSnapshot = async () => { entered.resolve(); await release.promise; };
  const originalAtob = globalThis.atob;
  let decodes = 0, compilerTransfers = 0, audioTransfers = 0;
  globalThis.atob = (value) => { decodes++; return originalAtob(value); };
  const events = [];
  runtime.subscribe((event) => { if (event.kind === "build") events.push({ ...event, decodes }); });
  const compilerCall = runtime.compiler.call.bind(runtime.compiler);
  runtime.compiler.call = async (message) => {
    if (message.command === "assets") compilerTransfers++;
    return compilerCall(message);
  };
  const accept = runtime.player.accept.bind(runtime.player);
  runtime.player.accept = async (...args) => { audioTransfers++; return accept(...args); };
  const firstOp = operation(), middleOp = operation(), lastOp = operation(), staleOp = operation();
  const phases = (op) => events.filter((event) => event.requestId === op.requestId).map((event) => event.phase);
  try {
    const first = runtime.rebuild({ snapshot: "s1", base: null }, firstOp);
    const middle = runtime.rebuild({ snapshot: "s2", base: null }, middleOp);
    const middleRejected = assert.rejects(middle, { code: "cancelled" });
    const last = runtime.rebuild({ snapshot: "s3", base: null }, lastOp);
    await entered.promise;
    assert.equal(decodes, 1, "queueing and superseding do not decode assets");
    assert.deepEqual(phases(middleOp), ["queued", "cancelled"]);
    assert.deepEqual(phases(lastOp), ["queued"]);
    release.resolve();
    await first;
    await middleRejected;
    const accepted = await last;
    await runtime.buildPromise;
    await assert.rejects(runtime.rebuild({ snapshot: "s4", base: { ...accepted.ref, revision: "stale" } }, staleOp), { code: "stale_revision" });
    assert.deepEqual(phases(firstOp), ["compiling", "preparing", "applying", "accepted"]);
    assert.deepEqual(phases(lastOp), ["queued", "compiling", "preparing", "applying", "accepted"]);
    assert.deepEqual(phases(staleOp), ["rejected"]);
    assert.equal(decodes, 2, "only the two builds that reach transfer decode an asset");
    assert.equal(compilerTransfers, 2);
    assert.equal(audioTransfers, 2);
    for (const [op, sourceVersion] of [[firstOp, 1], [middleOp, 2], [lastOp, 3], [staleOp, 4]]) {
      const matching = events.filter((event) => event.requestId === op.requestId);
      for (const event of matching) {
        assert.deepEqual(event.project, { project: "project", epoch: "epoch" });
        assert.equal(event.sourceVersion, sourceVersion);
        assert.equal(event.decodes, sourceVersion === 1 || sourceVersion === 2 || event.phase === "queued" ? 1 : 2);
      }
    }
    const rejected = events.find((event) => event.requestId === staleOp.requestId);
    assert.equal(rejected.failure.code, "stale_revision");
    assert.equal(rejected.ref, null);
    const superseded = events.find((event) => event.requestId === middleOp.requestId && event.phase === "cancelled");
    assert.equal(superseded.failure.code, "cancelled");
    assert.equal(superseded.ref, null);
  } finally {
    release.resolve();
    await runtime.dispose();
    globalThis.atob = originalAtob;
  }
  assert.ok([...projects.pins.values()].every((count) => count === 0));
});

test("abort before apply preserves accepted state; abort at commit returns authoritative acceptance", async () => {
  const projects = projectFixture();
  const runtime = new WebRuntime(projects, "test-core");
  try {
    const before = new AbortController(); before.abort();
    await assert.rejects(runtime.rebuild({ snapshot: "s1", base: null }, operation(before.signal)), { code: "cancelled" });
    const abort = new AbortController();
    const events = [];
    runtime.subscribe((event) => { events.push(event); if (event.kind === "build" && event.phase === "applying") abort.abort(); });
    const accepted = await runtime.rebuild({ snapshot: "s1", base: null }, operation(abort.signal));
    assert.equal(accepted.ref.sourceVersion, 1);
    assert.ok(events.some((event) => event.kind === "build" && event.phase === "accepted"));
    await assert.rejects(runtime.inspect({ ...accepted.ref, engineEpoch: "dead" }, "summary", {}, operation()), { code: "stale_revision" });
    assert.equal((await runtime.inspect(accepted.ref, "summary", {}, operation())).next, null);
  } finally { await runtime.dispose(); }
  assert.ok([...projects.pins.values()].every((count) => count === 0));
});

test("source authorization failure never publishes accepted metadata", async () => {
  const projects = projectFixture();
  projects.validateSourceSnapshot = async () => { throw { code: "source_conflict", message: "Disk changed" }; };
  const runtime = new WebRuntime(projects, "test-core");
  const phases = [];
  runtime.subscribe((event) => { if (event.kind === "build") phases.push(event.phase); });
  try {
    await assert.rejects(runtime.rebuild({ snapshot: "s1", base: null }, operation()), { code: "source_conflict" });
    assert.ok(!phases.includes("applying"));
    assert.ok(!phases.includes("accepted"));
  } finally { await runtime.dispose(); }
});

test("coalesced queued builds retain only latest and expire only third accepted revision", async () => {
  const projects = projectFixture();
  let release;
  projects.validateSourceSnapshot = () => new Promise((resolve) => { release = resolve; });
  const runtime = new WebRuntime(projects, "test-core");
  try {
    const first = runtime.rebuild({ snapshot: "s1", base: null }, operation());
    const middle = runtime.rebuild({ snapshot: "s2", base: null }, operation());
    const middleRejected = assert.rejects(middle, { code: "cancelled" });
    const last = runtime.rebuild({ snapshot: "s3", base: null }, operation());
    while (!release) await Promise.resolve();
    projects.validateSourceSnapshot = async () => {};
    release();
    const accepted = await first;
    await middleRejected;
    await last;
    await runtime.inspect(accepted.ref, "summary", {}, operation());
    await runtime.rebuild({ snapshot: "s4", base: null }, operation());
    await assert.rejects(runtime.inspect(accepted.ref, "summary", {}, operation()), { code: "expired_revision" });
  } finally { await runtime.dispose(); }
  assert.ok([...projects.pins.values()].every((count) => count === 0));
});

test("format returns captured buffer version and explicit restart replaces engine identity", async () => {
  const projects = projectFixture();
  const runtime = new WebRuntime(projects, "test-core");
  try {
    assert.deepEqual(await runtime.format({ project: "project", path: "song.muz", bufferVersion: 4, source: " text " }, operation()), { bufferVersion: 4, source: "text" });
    const before = await runtime.rebuild({ snapshot: "s1", base: null }, operation());
    const after = await runtime.restart(operation());
    assert.notEqual(before.ref.engineEpoch, after.ref.engineEpoch);
    await assert.rejects(runtime.inspect(before.ref, "summary", {}, operation()), { code: "stale_revision" });
  } finally { await runtime.dispose(); }
});

test("export retains the selected accepted snapshot through later revisions and releases on cancellation", async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  };
  const projects = projectFixture();
  const runtime = new WebRuntime(projects, "test-core");
  try {
    const accepted = await runtime.rebuild({ snapshot: "s1", base: null }, operation());
    const abort = new AbortController();
    const exporting = runtime.export(accepted.ref, { kind: "masterWav" }, operation(abort.signal));
    const rejected = assert.rejects(exporting, { code: "cancelled" });
    await runtime.rebuild({ snapshot: "s2", base: null }, operation());
    await runtime.rebuild({ snapshot: "s3", base: null }, operation());
    assert.equal(projects.pins.get("s1"), 1, "the export independently pins the expired inspection revision");
    assert.equal(workers[0].message.snapshot.description.tracks[0].id, "lead");
    abort.abort();
    await rejected;
    assert.equal(projects.pins.get("s1"), 0);
    assert.equal(workers[0].terminated, true);
  } finally {
    await runtime.dispose();
    globalThis.Worker = originalWorker;
  }
});

test("successful project replacement stops playback and invalidates accepted restart handles", async () => {
  const projects = projectFixture();
  const runtime = new WebRuntime(projects, "test-core");
  try {
    const accepted = await runtime.rebuild({ snapshot: "s1", base: null }, operation());
    await runtime.transport(accepted.ref, { kind: "play" }, operation());
    await runtime.replaceProject();
    await assert.rejects(runtime.inspect(accepted.ref, "summary", {}, operation()), { code: "stale_revision" });
    assert.equal(await runtime.restart(operation()), null);
    assert.ok([...projects.pins.values()].every((count) => count === 0));
  } finally { await runtime.dispose(); }
});

test("paused seek waits for audio apply through metadata publication and rejects the old ref before mutation", async () => {
  const projects = projectFixture();
  const runtime = new WebRuntime(projects, "test-core");
  const acceptanceEntered = Promise.withResolvers();
  const releaseAcceptance = Promise.withResolvers();
  try {
    const first = await runtime.rebuild({ snapshot: "s1", base: null }, operation());
    const compilerCall = runtime.compiler.call.bind(runtime.compiler);
    runtime.compiler.call = async (message) => {
      if (message.command === "accept_compilation" && message.revision === 2) {
        acceptanceEntered.resolve();
        await releaseAcceptance.promise;
      }
      return compilerCall(message);
    };
    let seeks = 0;
    const seek = runtime.player.seek.bind(runtime.player);
    runtime.player.seek = async (beat) => { seeks++; return seek(beat); };
    const rebuilding = runtime.rebuild({ snapshot: "s2", base: first.ref }, operation());
    await acceptanceEntered.promise;
    assert.equal(runtime.player.playing, false);
    const staleSeek = runtime.transport(first.ref, { kind: "seek", beat: 6 }, operation());
    const rejected = assert.rejects(staleSeek, { code: "expired_revision" });
    await Promise.resolve();
    assert.equal(seeks, 0, "the seek cannot mutate applied audio before its metadata is published");
    releaseAcceptance.resolve();
    const accepted = await rebuilding;
    await rejected;
    assert.equal(seeks, 0, "the queued old ref is revalidated after publication");
    assert.equal(accepted.status.beat, 0);
    const position = await runtime.transport(accepted.ref, { kind: "seek", beat: 6 }, operation());
    assert.equal(position.beat, 6);
    assert.deepEqual(position.ref, accepted.ref);
  } finally {
    releaseAcceptance.resolve();
    await runtime.dispose();
  }
});
