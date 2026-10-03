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
  setMetersEnabled() {}
  readAnalysis() { return null; }
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
  const metadata = (id) => ({ id, project: "project", epoch: "epoch", sourceVersion: Number(id.slice(1)), entry: "song.muz",
    files:["song.muz","module.MUZ","missing.muz"].map(path=>({fileId:path,path,bufferVersion:0,diskVersion:null})) });
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
    const middleRejected = assert.rejects(middle, { code: "superseded" });
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
    assert.equal(superseded.failure.code, "superseded");
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
    const middleRejected = assert.rejects(middle, { code: "superseded" });
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

test("root scans preserve evaluated songs/non-songs/unresolved and final cancellation is outer", async () => {
  const projects=projectFixture(),runtime=new WebRuntime(projects,"core");
  const abort=new AbortController(),events=[];
  let abortAtFinal=false;
  runtime.subscribe(event=>{events.push(event);if(abortAtFinal&&event.kind==="entries"&&event.done===3)abort.abort();});
  const classifications={
    "song.muz":{kind:"song",failure:null},
    "module.MUZ":{kind:"non-song",description:"null",failure:null},
    "missing.muz":{kind:"unresolved",failure:{code:"missing_module",message:"Missing palette",location:{path:"missing.muz",line:1,column:1,text:"import",indent:0,width:6}}},
  };
  runtime.utilityCompiler.call=async message=>message.command==="check_entry"?classifications[message.entry]:{};
  try {
    const scan=await runtime.checkEntries({snapshot:"s1",entries:Object.keys(classifications)},operation());
    assert.deepEqual(scan.entries.map(entry=>entry.kind),["song","non-song","unresolved"]);
    assert.ok(scan.entries.every(entry=>entry.readiness.kind==="unchecked"));
    assert.equal(scan.entries[2].failure.location.path,"missing.muz");
    abortAtFinal=true;
    await assert.rejects(runtime.checkEntries({snapshot:"s2",entries:Object.keys(classifications)},operation(abort.signal)),{code:"cancelled"});
    runtime.utilityCompiler.call=async()=>{throw {code:"child_timeout",message:"Utility timed out"};};
    await assert.rejects(runtime.checkEntries({snapshot:"s3",entries:["song.muz"]},operation()),{code:"child_timeout"});
  }finally{await runtime.dispose();}
  assert.ok([...projects.pins.values()].every(value=>value===0));
});

test("stop exposes authoritative paused-but-not-rewound partial outcome",async()=>{
  const runtime=new WebRuntime(projectFixture(),"core");
  try{
    const accepted=await runtime.rebuild({snapshot:"s1",base:null},operation());
    await runtime.transport(accepted.ref,{kind:"play"},operation());
    runtime.player.seek=async()=>{throw {code:"render_fault",message:"Seek failed"};};
    const op=operation();
    await assert.rejects(runtime.transport(accepted.ref,{kind:"stop"},op),error=>{
      assert.equal(error.operation.action,"stop");assert.equal(error.operation.requestId,op.requestId);
      assert.equal(error.operation.outcome,"partial");assert.equal(runtime.player.playing,false);return true;
    });
  }finally{await runtime.dispose();}
});

test("analysis negotiates detail independently from meters without claiming browser sample clock",async()=>{
  const runtime=new WebRuntime(projectFixture(),"core"),events=[];
  runtime.subscribe(event=>events.push(event));
  try{
    const accepted=await runtime.rebuild({snapshot:"s1",base:null},operation());
    let reads=0;
    runtime.player.readAnalysis=()=>{reads++;return {waveform:[0],spectrum:[0],peak:0,rms:0,sampleRate:48000,
      captureSeconds:1,sampleCount:2048,captureId:"9007199254740993",warmup:false,window:"blackman",smoothing:0};};
    await runtime.analysis(accepted.ref,{source:null,detail:false,meters:true,detailHz:30,meterHz:20});
    runtime.observe();assert.equal(reads,0);
    await runtime.analysis(accepted.ref,{source:null,detail:true,meters:false,detailHz:30,meterHz:20});
    runtime.nextAnalysisPublication=0;runtime.observe();
    const frame=events.filter(event=>event.kind==="analysis").at(-1).frame;
    assert.equal(frame.windowEndSample,null);assert.equal(frame.captureId,"9007199254740993");
    assert.equal(frame.metersPresent,false);assert.deepEqual(frame.meters,[]);
    await assert.rejects(runtime.analysis(accepted.ref,{source:null,detail:true,meters:true,detailHz:31,meterHz:20}),{code:"resource_budget"});
  }finally{await runtime.dispose();}
});

test("selected detail scalars and immediate warmup retirement stay independent of master meters",async()=>{
  const runtime=new WebRuntime(projectFixture(),"core"),events=[];
  clearInterval(runtime.timer);runtime.subscribe(event=>events.push(event));
  try{
    const accepted=await runtime.rebuild({snapshot:"s1",base:null},operation());
    await runtime.analysis(accepted.ref,{source:"lead",detail:true,meters:true,detailHz:30,meterHz:20});
    await runtime.transport(accepted.ref,{kind:"play"},operation());
    runtime.player.onPosition({revision:runtime.current.audioRevision,beat:0,seconds:0,
      peak:0.75,rms:0.5,meters:[{track:"lead",peak:0,rms:0}]});
    runtime.player.readAnalysis=()=>({waveform:[0],spectrum:[0],peak:0,rms:0,sampleRate:48000,
      captureSeconds:1,sampleCount:2048,captureId:"10",warmup:false,window:"blackman",smoothing:0});
    runtime.nextAnalysisPublication=0;runtime.observe();
    const frame=events.filter(event=>event.kind==="analysis").at(-1).frame;
    assert.equal(frame.source,"lead");assert.equal(frame.peak,0);assert.equal(frame.rms,0);
    assert.equal(runtime.current.accepted.status.peak,0.75,"master status remains independent");
    assert.deepEqual(frame.meters,[{track:"lead",peak:0,rms:0}]);
    runtime.player.onAnalysisInvalidated("10");
    const invalidated=events.filter(event=>event.kind==="analysis").at(-1).frame;
    assert.equal(invalidated.warmup,true);assert.deepEqual(invalidated.waveform,[]);assert.deepEqual(invalidated.spectrum,[]);
    assert.equal(invalidated.captureId,"10");assert.equal(invalidated.source,"lead");
    assert.equal(BigInt(invalidated.sequence),BigInt(frame.sequence)+1n);
    assert.equal(invalidated.windowEndSample,null,"warmup is not a fabricated sample clock/window");
    assert.equal(invalidated.metersPresent,false);
    const count=events.length;
    await runtime.analysis(accepted.ref,{source:"lead",detail:false,meters:true,detailHz:30,meterHz:20});
    runtime.player.onAnalysisInvalidated("11");
    assert.equal(events.length,count,"disabled detail emits no warmup work");
  }finally{await runtime.dispose();}
});

test("entry scans retain one queued latest capture, reject supersession immediately and release cancelled captures",async()=>{
  const projects=projectFixture(),runtime=new WebRuntime(projects,"core");
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),commands=[];
  runtime.utilityCompiler.call=async message=>{
    commands.push(message);
    if(message.command==="assets"&&commands.length===1){entered.resolve();await release.promise;}
    return message.command==="check_entry"?{kind:"song",failure:null}:{};
  };
  try{
    const first=runtime.checkEntries({snapshot:"s1",entries:["song.muz"]},operation());
    const firstRejected=assert.rejects(first,{code:"superseded"});
    await entered.promise;
    const middle=runtime.checkEntries({snapshot:"s2",entries:["song.muz"]},operation());
    const middleRejected=assert.rejects(middle,{code:"superseded"});
    const abort=new AbortController();
    const cancelled=runtime.checkEntries({snapshot:"s3",entries:["song.muz"]},operation(abort.signal));
    const cancelledRejected=assert.rejects(cancelled,{code:"cancelled"});
    await middleRejected;
    assert.equal(projects.pins.get("s2"),0,"superseded queued capture releases before active utility completes");
    abort.abort();await cancelledRejected;
    assert.equal(projects.pins.get("s3"),0);
    const latest=runtime.checkEntries({snapshot:"s4",entries:["song.muz"]},operation());
    release.resolve();await firstRejected;
    assert.equal((await latest).sourceVersion,4);
    assert.equal(commands.filter(message=>message.command==="check_entry").length,1);
  }finally{release.resolve();await runtime.dispose();}
  assert.ok([...projects.pins.values()].every(value=>value===0));
});

test("first cancelled build does not invent continuity and technical failures retain typed attempt identity",async()=>{
  const runtime=new WebRuntime(projectFixture(),"core"),abort=new AbortController();
  abort.abort();
  const op=operation(abort.signal);
  try{
    await assert.rejects(runtime.rebuild({snapshot:"s1",base:null},op),error=>{
      assert.equal(error.continuity,"not-started");assert.equal(error.operation.outcome,"cancelled");
      assert.equal(error.operation.action,"rebuild");assert.equal(error.operation.requestId,op.requestId);
      assert.equal(error.operation.ref,null);return true;
    });
  }finally{await runtime.dispose();}
});

test("global playback intentions revalidate at new acceptance while score-bound seek stays pinned",async()=>{
  const runtime=new WebRuntime(projectFixture(),"core"),entered=Promise.withResolvers(),release=Promise.withResolvers();
  try{
    const first=await runtime.rebuild({snapshot:"s1",base:null},operation());
    const call=runtime.compiler.call.bind(runtime.compiler);
    runtime.compiler.call=async message=>{
      if(message.command==="accept_compilation"&&message.revision===2){entered.resolve();await release.promise;}
      return call(message);
    };
    const building=runtime.rebuild({snapshot:"s2",base:first.ref},operation());
    await entered.promise;
    const pause=runtime.transport(first.ref,{kind:"pause"},operation());
    const seek=runtime.transport(first.ref,{kind:"seek",beat:1},operation());
    const rejected=assert.rejects(seek,{code:"expired_revision"});
    release.resolve();
    const accepted=await building;
    assert.deepEqual((await pause).ref,accepted.ref);
    await rejected;
  }finally{release.resolve();await runtime.dispose();}
});

test("entry scan1000 candidate boundary processes every uppercase root;1001 rejects whole scan with attempted identity",async()=>{
  const projects=projectFixture(),entries=Array.from({length:1000},(_,index)=>`root-${index}.${index%2?"MuZ":"MUZ"}`);
  const snapshot={id:"s1",project:"project",epoch:"epoch",sourceVersion:1,entry:entries[0],
    files:entries.map(path=>({fileId:path,path,bufferVersion:0,diskVersion:null}))};
  projects.getSourceSnapshotMetadata=()=>snapshot;
  projects.getSourceSnapshot=()=>({snapshot,files:Object.fromEntries(entries.map(path=>[path,"null"])),assets:[],title:"Boundary"});
  const runtime=new WebRuntime(projects,"core"),evaluated=[],progress=[];
  runtime.subscribe(event=>{if(event.kind==="entries"&&event.result)progress.push(event.done);});
  runtime.utilityCompiler.call=async message=>{
    if(message.command==="check_entry"){
      assert.equal(message.files[message.entry],"null");evaluated.push(message.entry);
      return {kind:"non-song",description:"null",failure:null};
    }
    return {};
  };
  try{
    const result=await runtime.checkEntries({snapshot:"s1",entries},operation());
    assert.equal(result.entries.length,1000);
    assert.deepEqual(evaluated,entries);assert.equal(progress.at(-1),1000);
    const tooLarge=operation(),callsBefore=evaluated.length;
    await assert.rejects(runtime.checkEntries({snapshot:"s1",entries:[...entries,"extra.muz"]},tooLarge),error=>{
      assert.equal(error.code,"resource_budget");assert.equal(error.operation.action,"classifyEntries");
      assert.equal(error.operation.requestId,tooLarge.requestId);assert.equal(error.operation.outcome,"rejected");
      return true;
    });
    assert.equal(evaluated.length,callsBefore,"oversized scan performs no partial classification");
  }finally{await runtime.dispose();}
  assert.ok([...projects.pins.values()].every(count=>count===0));
});

test("browser status sequence is a distinct producer counter across same-generation snapshots and resets only with engine epoch",async()=>{
  const runtime=new WebRuntime(projectFixture(),"core");
  try{
    const accepted=await runtime.rebuild({snapshot:"s1",base:null},operation());
    const first=runtime.status(accepted.ref,accepted.status);
    const second=runtime.status(accepted.ref,accepted.status);
    assert.equal(first.generation,second.generation);
    assert.equal(BigInt(second.sequence),BigInt(first.sequence)+1n);
    assert.equal(runtime.analysisSequence,0n,"status production does not borrow the independent detail clock");
    runtime.statusSequence=9007199254740993n;
    assert.equal(runtime.status(accepted.ref,accepted.status).sequence,"9007199254740994");
    const oldEpoch=accepted.ref.engineEpoch;
    await runtime.replaceProject();
    assert.notEqual(runtime.engineEpoch,oldEpoch);assert.equal(runtime.statusSequence,0n);
  }finally{await runtime.dispose();}
});

test("fractional cadence deadlines do not halve publication on integer33ms ticks or queue catch-up after stalls",async()=>{
  const ownNow=Object.getOwnPropertyDescriptor(performance,"now");
  let now=0;
  Object.defineProperty(performance,"now",{configurable:true,value:()=>now});
  const runtime=new WebRuntime(projectFixture(),"core"),events=[];
  clearInterval(runtime.timer);
  runtime.subscribe(event=>events.push(event));
  try{
    const accepted=await runtime.rebuild({snapshot:"s1",base:null},operation());
    let reads=0;
    runtime.player.readAnalysis=()=>{reads++;return {waveform:[0],spectrum:[0],peak:0,rms:0,sampleRate:48000,
      captureSeconds:now/1000,sampleCount:2048,captureId:"1",warmup:false,window:"blackman",smoothing:0};};
    await runtime.analysis(accepted.ref,{source:null,detail:true,meters:true,detailHz:30,meterHz:20});
    events.length=0;
    for(let tick=1;tick<=240;tick++){now=tick*33;runtime.observe();}
    const analyses=events.filter(event=>event.kind==="analysis");
    const statuses=events.filter(event=>event.kind==="status");
    assert.ok(analyses.length>=230&&analyses.length<=240,"30Hz publication must not alternate-skip into15Hz");
    assert.ok(statuses.length>=150&&statuses.length<=165,"independent20Hz status must not alternate-skip into15Hz");
    assert.equal(reads,analyses.length);
    const before=analyses.length;
    now=13000;runtime.observe();runtime.observe();
    assert.equal(events.filter(event=>event.kind==="analysis").length,before+1,"long stall keeps one latest frame rather than backlog");
    await runtime.analysis(accepted.ref,{source:null,detail:false,meters:true,detailHz:30,meterHz:20});
    for(let tick=0;tick<30;tick++){now+=33;runtime.observe();}
    assert.equal(events.filter(event=>event.kind==="analysis").length,before+1,"hidden detail performs no reads/publications");
  }finally{
    await runtime.dispose();
    if(ownNow)Object.defineProperty(performance,"now",ownNow);else delete performance.now;
  }
});
