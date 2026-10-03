import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopHostWithBridge } from '../src/host/desktop.ts';

const audio = { backend: 'test-native', device: 'test', sampleRate: 48000, channels: 2, requestedPeriodFrames: null, periodFrames: 256 };
const available = { available: true, reason: null };
function capabilities(overrides = {}) {
  return {
    environment: 'desktop', platform: 'linux', coreRevision: 'pinned-core', protocolVersion: 1,
    nativePluginFormats: ['clap', 'vst3'], audio: { ...available, configuration: audio },
    filesystem: { folder: available, watch: available, reveal: available, recovery: available, nativeDialogs: available },
    pluginConfig: null,
    limits: { frameBytes: 2097152, sourceChunkBytes: 262144, sourceDocumentBytes: 8388608,
      sourceSnapshotBytes: 67108864, outstandingRequests: 64, preparingCandidates: 1, queuedCandidates: 1,
      inspectionRows: 1000, inspectionBytes: 1048576, statusHz: 20, analysisHz: 10,
      waveformSamples: 2048, spectrumBins: 1024, trackMeters: 1000, analysisBytes: 131072,
      exportWorkers: 2, exportQueue: 32, playableSnapshotBytes: 268435456, ...overrides },
  };
}
const project = {
  project: 'project', epoch: 'project-epoch', title: 'Native test', entry: 'main.muz', entries: ['main.muz'],
  sourceVersion: 1, diskGeneration: '0', settingsDiskVersion: null, files: [], resources: [], conflicts: [],
  dirty: false, rootLabel: 'native-folder',
};
const ref = { project: project.project, epoch: project.epoch, engineEpoch: 'engine-epoch', revision: 'opaque-revision', sourceVersion: 1, entry: 'main.muz' };
const capture = { project: project.project, epoch: project.epoch, sourceVersion: 1, entry: 'main.muz',
  expectedDiskGeneration: '0', buffers: [], settings: { title: project.title, entry: project.entry }, settingsDiskVersion: null };
const sourceSnapshot = { id: 'source-snapshot', project: project.project, epoch: project.epoch, sourceVersion: 1, entry: 'main.muz', diskGeneration: '0', files: [] };
function transport(generation = '1', revision = ref) {
  return { ref: revision, generation, playing: true, finished: false, beat: 0, seconds: 0, bpm: 120,
    meter: [4, 4], duration: 2, endBeat: 4, tail: 0, loop: null, peak: 0, rms: 0, meters: [], audio, health: {} };
}
function accepted(revision = ref) {
  return { ref: revision, status: transport('1', revision), effect: {}, exportTracks: [],
    initialPages: Object.fromEntries(['summary', 'graph', 'sections', 'track_groups', 'locations', 'diagnostics']
      .map(view => [view, { ref: revision, view, rows: [], total: 0, next: null }])) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fake(options = {}) {
  const calls = [], uploads = new Map(), transfers = new Map();
  let listener, unlistened = 0, sequence = 0;
  const cap = capabilities(options.limits);
  const handlers = {
    'project.snapshotSources': () => sourceSnapshot,
    'runtime.rebuild': () => accepted(),
    'runtime.transport': () => transport(),
    'runtime.inspect': request => ({ ref: request.payload.value.ref, view: request.payload.value.view, rows: [], total: 0, next: null }),
    'runtime.export': request => ({ ref: request.payload.value.ref, job: 'export-job', name: 'mix.wav', clipped: false }),
    ...options.handlers,
  };
  const harness = {
    calls, handlers, uploads, transfers, cap,
    get unlistened() { return unlistened; },
    event(scope, value, identity = {}) {
      assert.ok(listener, 'event listener registered before native activity');
      listener({ protocolVersion: 1, requestId: 'host-event', project: { project: project.project, epoch: project.epoch },
        engineEpoch: ref.engineEpoch, sourceVersion: 1, revision: value.status?.ref.revision ?? value.frame?.ref.revision ?? value.ref?.revision ?? null,
        sequence: String(++sequence), event: { scope, value }, ...identity });
    },
    transfer(value, size = 128) {
      const data = Buffer.from(JSON.stringify(value));
      const id = `transfer-${transfers.size}`;
      const chunks = [];
      for (let offset = 0; offset < data.length; offset += size) chunks.push(data.subarray(offset, offset + size).toString('base64'));
      transfers.set(id, chunks);
      return { transfer: { id, bytes: data.length, chunks: chunks.length } };
    },
    bridge: {
      async listen(name, receive) {
        assert.equal(name, 'workbench://event'); listener = receive;
        return () => { unlistened++; listener = undefined; };
      },
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === 'workbench_bootstrap') {
          assert.ok(listener);
          if (options.duringBootstrap) options.duringBootstrap(harness);
          return { protocolVersion: 1, engineEpoch: ref.engineEpoch, capabilities: cap,
            project: options.bootstrapProject ? options.bootstrapProject(harness) : project,
            recovery: options.recovery ?? [] };
        }
        if (command === 'workbench_cancel') return { target: args.target, state: 'requested' };
        if (command === 'workbench_upload_begin') { uploads.set('upload', { size: args.bytes, chunks: [] }); return { id: 'upload' }; }
        if (command === 'workbench_upload_chunk') {
          const upload = uploads.get(args.id); assert.equal(args.index, upload.chunks.length);
          const chunk = Buffer.from(args.data, 'base64'); assert.ok(chunk.length <= cap.limits.sourceChunkBytes);
          assert.ok(Buffer.byteLength(JSON.stringify(args)) <= cap.limits.frameBytes);
          upload.chunks.push(chunk); return { next: args.index + 1 };
        }
        if (command === 'workbench_upload_finish') {
          const upload = uploads.get(args.id); assert.equal(Buffer.concat(upload.chunks).length, upload.size);
          JSON.parse(Buffer.concat(upload.chunks)); return { id: args.id };
        }
        if (command === 'workbench_upload_discard') return null;
        assert.equal(command, 'workbench_request');
        const request = args.request;
        const { method, payload, ...context } = request;
        let value;
        if (method === 'transfer.read') {
          const { id, index } = payload.value, chunks = transfers.get(id);
          value = { index, data: chunks[index], last: index === chunks.length - 1 };
        } else if (method === 'transfer.release') { transfers.delete(payload.value.id); value = null; }
        else value = handlers[method] ? await handlers[method](request, harness) : null;
        if (value?.__reply) return value.__reply(context);
        return { ...context, ok: true, value };
      },
    },
  };
  return harness;
}
const op = requestId => ({ requestId });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function observeHostMaps(bridge) {
  // Inspect retained references deterministically, without GC timing or a host debug API.
  const NativeMap = globalThis.Map, maps = [];
  try {
    globalThis.Map = class extends NativeMap {
      constructor(...args) { super(...args); maps.push(this); }
    };
    return { host: await createDesktopHostWithBridge(bridge), maps };
  } finally { globalThis.Map = NativeMap; }
}

test('desktop registers before bootstrap and replays recovery, project and close events', async () => {
  const offer = { id: 'recovery', project: project.project, title: project.title, rootLabel: null, updatedAt: '2026-10-02' };
  const f = fake({ recovery: [offer], duringBootstrap: f => f.event('host', { kind: 'closeRequested', ticket: 'ticket', reason: 'quit' }) });
  const host = await createDesktopHostWithBridge(f.bridge);
  const first = [], second = [], events = [];
  host.projects.subscribe(event => first.push(event)); host.projects.subscribe(event => second.push(event)); host.subscribe(event => events.push(event));
  assert.deepEqual(first.map(event => event.kind), ['changed', 'recovery']);
  assert.deepEqual(second, first); assert.equal(events[0].ticket, 'ticket');
  await host.dispose(); assert.equal(f.unlistened, 1);
});

test('desktop assembles bootstrap project transfers with nullable bootstrap context', async () => {
  const f = fake({ bootstrapProject: f => f.transfer(project) });
  const host = await createDesktopHostWithBridge(f.bridge);
  const reads = f.calls.filter(call => call.args.request?.method === 'transfer.read');
  assert.ok(reads.length > 1); assert.equal(reads[0].args.request.project, null);
  assert.equal(f.transfers.size, 0);
  const events = []; host.projects.subscribe(event => events.push(event));
  assert.deepEqual(events[0].snapshot, project); await host.dispose();
});

test('desktop validates context echoes and rejects old project and engine identities', async () => {
  const f = fake({ handlers: { 'runtime.inspect': () => ({ __reply: context => ({ ...context, engineEpoch: 'wrong', ok: true, value: {} }) }) } });
  const host = await createDesktopHostWithBridge(f.bridge);
  await assert.rejects(host.runtime.inspect(ref, 'summary', {}, op('inspect')), error => error.code === 'protocol_mismatch');
  await assert.rejects(host.runtime.transport({ ...ref, epoch: 'old-project' }, { kind: 'play' }, op('project')), error => error.code === 'stale_request');
  await assert.rejects(host.runtime.transport({ ...ref, engineEpoch: 'old-engine' }, { kind: 'play' }, op('engine')), error => error.code === 'stale_request');
  await host.dispose();
});

test('abort before dispatch sends nothing; abort after apply waits for authoritative success', async () => {
  const pending = deferred(), started = deferred();
  const f = fake({ handlers: { 'runtime.transport': () => { started.resolve(); return pending.promise; } } });
  const host = await createDesktopHostWithBridge(f.bridge);
  const early = new AbortController(); early.abort();
  await assert.rejects(host.runtime.transport(ref, { kind: 'play' }, { requestId: 'early', signal: early.signal }), error => error.code === 'cancelled');
  assert.equal(f.calls.filter(call => call.args.request?.method === 'runtime.transport').length, 0);
  const late = new AbortController();
  const result = host.runtime.transport(ref, { kind: 'play' }, { requestId: 'late', signal: late.signal });
  await started.promise; late.abort(); await flush();
  assert.equal(f.calls.filter(call => call.command === 'workbench_cancel').length, 1);
  pending.resolve(transport('2'));
  assert.equal((await result).generation, '2'); await host.dispose();
});

test('requested cancellation does not conceal authoritative rejected outcome', async () => {
  const pending = deferred(), started = deferred();
  const f = fake({ handlers: { 'runtime.transport': () => { started.resolve(); return pending.promise; } } });
  const host = await createDesktopHostWithBridge(f.bridge), controller = new AbortController();
  const result = host.runtime.transport(ref, { kind: 'play' }, { requestId: 'cancel', signal: controller.signal });
  await started.promise; controller.abort();
  pending.resolve({ __reply: context => ({ ...context, ok: false, failure: { code: 'cancelled', phase: 'transport', message: 'Prevented before apply', continuity: 'preserved' } }) });
  await assert.rejects(result, error => error.code === 'cancelled'); await host.dispose();
});

test('large UTF-8 recovery captures upload sequentially within encoded frame bounds', async () => {
  const f = fake({ limits: { frameBytes: 2048, sourceChunkBytes: 512 } });
  const host = await createDesktopHostWithBridge(f.bridge);
  const input = { ...capture, buffers: [{ fileId: 'new-file', path: 'main.muz', text: 'é🎹'.repeat(1000), bufferVersion: 1, expectedDiskVersion: null }] };
  await host.projects.persistRecovery(input, op('upload'));
  const call = f.calls.find(call => call.args.request?.method === 'project.persistRecovery');
  assert.equal(call.args.request.payload.kind, 'upload');
  assert.deepEqual(JSON.parse(Buffer.concat(f.uploads.get('upload').chunks)), { input });
  assert.equal(f.calls.at(-1).command, 'workbench_upload_discard'); await host.dispose();
});

test('transferred snapshots are released before delivery and malformed chunk order is rejected', async () => {
  const f = fake({ handlers: { 'project.openRecent': (_, f) => f.transfer({ ...project, title: 'Hydrated' }) } });
  const host = await createDesktopHostWithBridge(f.bridge);
  assert.equal((await host.projects.openRecent(project.project, op('open'))).title, 'Hydrated');
  assert.equal(f.transfers.size, 0);
  const invoke = f.bridge.invoke.bind(f.bridge);
  f.bridge.invoke = async (command, args) => {
    const result = await invoke(command, args);
    if (args.request?.method === 'transfer.read') result.value.index++;
    return result;
  };
  await assert.rejects(host.projects.openRecent(project.project, op('bad-chunk')), error => error.code === 'protocol_mismatch');
  assert.equal(f.transfers.size, 0); await host.dispose();
});

test('queue and inspection limits reject before native dispatch', async () => {
  const pending = deferred(), started = deferred();
  const f = fake({ limits: { outstandingRequests: 1 }, handlers: { 'preferences.load': () => { started.resolve(); return pending.promise; } } });
  const host = await createDesktopHostWithBridge(f.bridge);
  const loading = host.preferences.load(); await started.promise;
  await assert.rejects(host.projects.listRecent(), error => error.code === 'queue_full');
  pending.resolve(null); await loading;
  await assert.rejects(host.runtime.inspect(ref, 'score', { limit: 1001 }, op('large')), error => error.code === 'too_large');
  await assert.rejects(host.runtime.inspect(ref, 'score', { start_tick: '01' }, op('bad-u64')), error => error.code === 'protocol_mismatch');
  await host.dispose();
});

test('partial saves preserve per-file captured versions, conflicts and failures', async () => {
  const saved = { saved: [{ fileId: 'a', bufferVersion: 3, diskVersion: 'written' }], conflicts: [{ fileId: 'b', path: 'b.muz', base: 'old', local: 'edit', disk: 'disk', baseVersion: 'old-disk', diskVersion: 'new-disk', bufferVersion: 4 }],
    failures: [{ fileId: 'c', failure: { code: 'file_write_failed', phase: 'project', message: 'Read only', continuity: 'preserved' } }], settingsDiskVersion: null, settingsSaved: false, diskGeneration: '18446744073709551615' };
  const f = fake({ handlers: { 'project.save': () => saved } }), host = await createDesktopHostWithBridge(f.bridge);
  assert.deepEqual(await host.projects.save({ project: project.project, epoch: project.epoch, files: [], settings: capture.settings, settingsDiskVersion: null }, op('save')), saved);
  await host.dispose();
});

test('previous accepted inspection and exports retain their exact opaque revision', async () => {
  const f = fake(), host = await createDesktopHostWithBridge(f.bridge);
  await host.projects.snapshotSources(capture, op('snapshot'));
  await host.runtime.rebuild({ snapshot: sourceSnapshot.id, base: null }, op('rebuild'));
  const previous = { ...ref, revision: 'previous-opaque' };
  assert.deepEqual((await host.runtime.inspect(previous, 'summary', {}, op('previous'))).ref, previous);
  assert.deepEqual((await host.runtime.export(previous, { kind: 'masterWav' }, op('export'))).ref, previous);
  await host.dispose();
});

test('desktop source metadata stays bounded without retaining file arrays or losing active request captures', async () => {
  const scanStarted = deferred(), scanResult = deferred(), buildStarted = deferred(), buildResult = deferred();
  let suppliedFiles;
  const f = fake({ handlers: {
    'project.snapshotSources': request => {
      const input = request.payload.value.input;
      suppliedFiles = Array.from({ length: 128 }, (_, index) => ({
        fileId: `file-${index}`, path: `module-${index}.muz`, bufferVersion: input.sourceVersion, diskVersion: null,
      }));
      return { ...sourceSnapshot, id: `scan-${input.sourceVersion}`, sourceVersion: input.sourceVersion, files: suppliedFiles };
    },
    'runtime.checkEntries': request => {
      if (request.requestId === 'active-scan') { scanStarted.resolve(); return scanResult.promise; }
      return { snapshot: request.payload.value.snapshot, sourceVersion: request.sourceVersion, entries: [] };
    },
    'runtime.rebuild': () => { buildStarted.resolve(); return buildResult.promise; },
  } });
  const { host, maps } = await observeHostMaps(f.bridge);
  try {
    const first = await host.projects.snapshotSources(capture, op('capture-1')), firstId = first.id;
    assert.equal(first.files, suppliedFiles, 'deliver the original descriptor array without copying it');
    const cache = maps.find(map => map.has(firstId));
    assert.ok(cache, 'observe the actual retained metadata map');
    assert.deepEqual(cache.get(firstId), { id: firstId, project: project.project, epoch: project.epoch, sourceVersion: 1 });
    first.sourceVersion = 999; first.project = 'mutated-consumer-descriptor';
    const scanning = host.runtime.checkEntries({ snapshot: firstId, entries: ['main.muz'] }, op('active-scan'));
    const building = host.runtime.rebuild({ snapshot: firstId, base: null }, op('active-build'));
    await Promise.all([scanStarted.promise, buildStarted.promise]);
    const active = maps.find(map => map.has('active-build'));
    assert.ok(active);
    assert.deepEqual(active.get('active-build').snapshot, cache.get(firstId));
    for (let version = 2; version <= 128; version++) {
      const result = await host.projects.snapshotSources({ ...capture, sourceVersion: version }, op(`capture-${version}`));
      assert.equal(result.files, suppliedFiles);
      assert.ok(cache.size <= 4, 'every capture remains within the native four-slot window');
      for (const metadata of cache.values()) {
        assert.deepEqual(Object.keys(metadata).sort(), ['epoch', 'id', 'project', 'sourceVersion']);
        assert.notEqual(metadata, result, 'the host must not retain the complete consumer descriptor');
      }
    }
    assert.deepEqual([...cache.keys()], ['scan-125', 'scan-126', 'scan-127', 'scan-128']);
    const callsBeforeExpired = f.calls.length;
    await assert.rejects(host.runtime.checkEntries({ snapshot: firstId, entries: [] }, op('expired-scan')), error => error.code === 'stale_request');
    await assert.rejects(host.runtime.rebuild({ snapshot: firstId, base: null }, op('expired-build')), error => error.code === 'stale_request');
    assert.equal(f.calls.length, callsBeforeExpired, 'expired handles are rejected before dispatch');
    scanResult.resolve({ snapshot: firstId, sourceVersion: 1, entries: [] });
    assert.equal((await scanning).sourceVersion, 1);
    buildResult.resolve(accepted({ ...ref, revision: 'active-revision', sourceVersion: 1 }));
    assert.equal((await building).ref.sourceVersion, 1);
    assert.equal(active.size, 0, 'settled rebuild captures are released');
    assert.equal(cache.has(firstId), false, 'an authoritative in-flight success must not revive an expired handle');
    f.handlers['runtime.checkEntries'] = request => ({
      snapshot: request.payload.value.snapshot, sourceVersion: request.sourceVersion + 1, entries: [],
    });
    await assert.rejects(host.runtime.checkEntries({ snapshot: 'scan-128', entries: [] }, op('mismatched-scan')), error => error.code === 'protocol_mismatch');
  } finally { await host.dispose(); }
});

test('desktop source eviction preserves current and previous accepted pins, including acceptance before its reply', async () => {
  const started = deferred(), reply = deferred();
  const f = fake({ handlers: {
    'project.snapshotSources': request => {
      const input = request.payload.value.input;
      return { ...sourceSnapshot, id: `retained-${input.sourceVersion}`, sourceVersion: input.sourceVersion };
    },
    'runtime.rebuild': request => {
      if (request.requestId === 'accept-before-reply') { started.resolve(); return reply.promise; }
      return accepted({ ...ref, revision: `revision-${request.sourceVersion}`, sourceVersion: request.sourceVersion });
    },
    'runtime.checkEntries': request => ({ snapshot: request.payload.value.snapshot, sourceVersion: request.sourceVersion, entries: [] }),
  } });
  const { host, maps } = await observeHostMaps(f.bridge);
  try {
    await host.projects.snapshotSources(capture, op('pin-capture-1'));
    const cache = maps.find(map => map.has('retained-1'));
    await host.runtime.rebuild({ snapshot: 'retained-1', base: null }, op('pin-build-1'));
    await host.projects.snapshotSources({ ...capture, sourceVersion: 2 }, op('pin-capture-2'));
    await host.runtime.rebuild({ snapshot: 'retained-2', base: null }, op('pin-build-2'));
    for (let version = 3; version <= 33; version++) {
      await host.projects.snapshotSources({ ...capture, sourceVersion: version }, op(`pin-capture-${version}`));
      assert.ok(cache.size <= 4);
    }
    assert.deepEqual([...cache.keys()], ['retained-1', 'retained-2', 'retained-32', 'retained-33']);
    for (const snapshot of ['retained-1', 'retained-2']) {
      assert.equal((await host.runtime.checkEntries({ snapshot, entries: [] }, op(`check-${snapshot}`))).snapshot, snapshot);
    }
    const building = host.runtime.rebuild({ snapshot: 'retained-33', base: null }, op('accept-before-reply'));
    await started.promise;
    const fresh = { ...ref, revision: 'revision-33', sourceVersion: 33 };
    f.event('runtime', { kind: 'build', requestId: 'accept-before-reply', project, sourceVersion: 33,
      phase: 'accepted', ref: fresh, failure: null }, { requestId: 'accept-before-reply', sourceVersion: 33, revision: fresh.revision });
    await flush();
    for (let version = 34; version <= 64; version++) {
      await host.projects.snapshotSources({ ...capture, sourceVersion: version }, op(`pin-capture-${version}`));
      assert.ok(cache.size <= 4);
    }
    assert.deepEqual([...cache.keys()], ['retained-2', 'retained-33', 'retained-63', 'retained-64']);
    await host.runtime.rebuild({ snapshot: 'retained-64', base: null }, op('next-accepted'));
    reply.resolve(accepted(fresh)); await building;
    assert.equal((await host.runtime.checkEntries({ snapshot: 'retained-2', entries: [] }, op('previous-pin'))).sourceVersion, 2);
    await assert.rejects(host.runtime.rebuild({ snapshot: 'retained-1', base: null }, op('released-pin')), error => error.code === 'stale_request');
    await host.projects.snapshotSources({ ...capture, sourceVersion: 65 }, op('pin-capture-65'));
    assert.deepEqual([...cache.keys()], ['retained-33', 'retained-63', 'retained-64', 'retained-65']);
    await assert.rejects(host.runtime.checkEntries({ snapshot: 'retained-2', entries: [] }, op('expired-previous')), error => error.code === 'stale_request');
    await host.runtime.rebuild({ snapshot: 'retained-65', base: null }, op('latest-accepted'));
    await host.projects.snapshotSources({ ...capture, sourceVersion: 66 }, op('pin-capture-66'));
    assert.deepEqual([...cache.keys()], ['retained-63', 'retained-64', 'retained-65', 'retained-66'],
      'a delayed earlier reply must not rotate the native accepted pins again');
    await assert.rejects(host.runtime.checkEntries({ snapshot: 'retained-33', entries: [] }, op('expired-delayed-previous')), error => error.code === 'stale_request');
  } finally { await host.dispose(); }
});

test('desktop source metadata and accepted pins clear on project replacement, close and host disposal', async () => {
  const replacement = { ...project, project: 'replacement-project', epoch: 'replacement-epoch' };
  let captures = 0;
  const f = fake({ handlers: {
    'project.snapshotSources': request => ({ ...sourceSnapshot, ...request.project, id: `lifecycle-${++captures}` }),
    'project.newProject': () => replacement,
    'project.prepareClose': () => ({ allowed: true, token: 'close-source-cache', save: null, failure: null }),
    'runtime.rebuild': request => accepted({ ...ref, ...request.project }),
  } });
  const { host, maps } = await observeHostMaps(f.bridge);
  try {
    const first = await host.projects.snapshotSources(capture, op('lifecycle-capture-1'));
    const cache = maps.find(map => map.has(first.id));
    await host.runtime.rebuild({ snapshot: first.id, base: null }, op('lifecycle-build'));
    await host.projects.newProject(capture.settings, op('replace-project'));
    assert.equal(cache.size, 0);
    await assert.rejects(host.runtime.rebuild({ snapshot: first.id, base: null }, op('replaced-snapshot')), error => error.code === 'stale_request');
    const nextCapture = { ...capture, project: replacement.project, epoch: replacement.epoch };
    const next = await host.projects.snapshotSources(nextCapture, op('lifecycle-capture-2'));
    await host.runtime.rebuild({ snapshot: next.id, base: null }, op('lifecycle-next-build'));
    await host.projects.prepareClose({ capture: nextCapture, reason: 'closeProject', decision: 'discard',
      cancelExports: true, ticket: null }, op('prepare-cache-close'));
    await host.projects.close({ ...replacement, token: 'close-source-cache' }, op('close-cache-project'));
    assert.equal(cache.size, 0);
    await host.projects.newProject(capture.settings, op('reopen-project'));
    await host.projects.snapshotSources(nextCapture, op('lifecycle-capture-3'));
    assert.equal(cache.size, 1);
    await host.dispose();
    assert.equal(cache.size, 0);
  } finally { await host.dispose(); }
});

test('stale transport and analysis generations never replace acknowledged state', async () => {
  const f = fake(), host = await createDesktopHostWithBridge(f.bridge), received = [];
  host.runtime.subscribe(event => received.push(event));
  await host.runtime.transport(ref, { kind: 'play' }, op('transport'));
  f.event('runtime', { kind: 'status', status: transport('0') });
  f.event('runtime', { kind: 'status', status: transport('2') });
  await flush();
  assert.deepEqual(received.filter(event => event.kind === 'status').map(event => event.status.generation), ['2']);
  await assert.rejects(host.runtime.transport(ref, { kind: 'pause' }, op('stale')), error => error.code === 'stale_transport');
  await host.dispose();
});

test('external URL policy, native preferences and disposal never use a web fallback', async () => {
  const f = fake(), host = await createDesktopHostWithBridge(f.bridge);
  await assert.rejects(host.openExternal('file:///etc/passwd'), error => error.code === 'denied_path');
  await host.openExternal('https://example.com/docs');
  await host.preferences.save({ version: 1, theme: 'dark', layout: { explorer: true, source: true, visualization: true, inspector: false, sourceFraction: 0.5 } });
  await Promise.all([host.dispose(), host.dispose()]);
  assert.equal(f.calls.filter(call => call.args.request?.method === 'host.dispose').length, 1);
  assert.equal(f.unlistened, 1);
  await assert.rejects(host.projects.listRecent(), error => error.code === 'stale_request');
});

test('native restart promotes only a fresh epoch and rejects pre-restart replies', async () => {
  const pending = deferred(), started = deferred(), fresh = { ...ref, engineEpoch: 'fresh-engine' };
  const f = fake({ handlers: {
    'runtime.inspect': () => { started.resolve(); return pending.promise; },
    'host.restartEngine': (_, f) => {
      f.event('runtime', { kind: 'engine', state: 'ready', engineEpoch: fresh.engineEpoch, capabilities: f.cap, failure: null }, { engineEpoch: fresh.engineEpoch });
      return accepted(fresh);
    },
  } });
  const host = await createDesktopHostWithBridge(f.bridge);
  const old = host.runtime.inspect(ref, 'summary', {}, op('old-inspection'));
  await started.promise;
  assert.deepEqual((await host.restartEngine(op('restart'))).ref, fresh);
  pending.resolve({ ref, view: 'summary', rows: [], total: 0, next: null });
  await assert.rejects(old, error => error.code === 'stale_request');
  await assert.rejects(host.runtime.export(ref, { kind: 'masterWav' }, op('old-export')), error => error.code === 'stale_request');
  await host.dispose();
});

test('preference saves serialize snapshots in invocation order and recover after failure', async () => {
  const first = deferred(), started = deferred(), saves = [];
  const f = fake({ handlers: { 'preferences.save': request => {
    saves.push(request.payload.value.value);
    if (saves.length === 1) { started.resolve(); return first.promise; }
    return null;
  } } });
  const host = await createDesktopHostWithBridge(f.bridge);
  const preference = { version: 1, theme: 'light', layout: { explorer: true, source: true, visualization: true, inspector: false, sourceFraction: 0.5 } };
  const savingFirst = host.preferences.save(preference);
  await started.promise;
  preference.theme = 'dark';
  const savingSecond = host.preferences.save(preference);
  preference.theme = 'soft-dark';
  await flush();
  assert.equal(saves.length, 1);
  first.resolve({ __reply: context => ({ ...context, ok: false, failure: { code: 'permission_denied', phase: 'project', message: 'Settings directory denied', continuity: 'preserved' } }) });
  await assert.rejects(savingFirst, error => error.code === 'permission_denied');
  await savingSecond;
  assert.deepEqual(saves.map(value => value.theme), ['light', 'dark']);
  await host.dispose();
});


test('replacement permission followed by a canceled chooser preserves project and accepted runtime handles', async () => {
  const f = fake({ handlers: {
    'project.prepareClose': () => ({ allowed: true, token: 'replace-token', save: null, failure: null }),
    'project.chooseFolder': () => null,
  } });
  const host = await createDesktopHostWithBridge(f.bridge);
  try {
    await host.projects.snapshotSources(capture, op('captured'));
    await host.runtime.rebuild({ snapshot: sourceSnapshot.id, base: null }, op('accepted'));
    await host.projects.prepareClose({ capture, reason: 'replaceProject', decision: 'discard',
      cancelExports: true, ticket: null }, op('permission'));
    await host.projects.close({ ...project, token: 'replace-token' }, op('consume-permission'));
    assert.equal(await host.projects.chooseFolder(op('canceled-chooser')), null);
    const replay = [];
    host.projects.subscribe(event => replay.push(event));
    assert.deepEqual(replay[0].snapshot, project);
    assert.deepEqual((await host.runtime.transport(ref, { kind: 'pause' }, op('pause-after-cancel'))).ref, ref);
    assert.deepEqual((await host.runtime.export(ref, { kind: 'masterWav' }, op('export-after-cancel'))).ref, ref);
    await host.runtime.rebuild({ snapshot: sourceSnapshot.id, base: ref }, op('rebuild-after-cancel'));
  } finally { await host.dispose(); }
});

test('inline payload selection honors the parent envelope reserve at its exact boundary', async () => {
  const f = fake(), host = await createDesktopHostWithBridge(f.bridge);
  const input = { ...capture, buffers: [{ fileId: 'file', path: 'main.muz', text: '',
    bufferVersion: 1, expectedDiskVersion: null }] };
  const cap = f.cap.limits.frameBytes - 16384;
  const overhead = Buffer.byteLength(JSON.stringify({ input }));
  try {
    input.buffers[0].text = 'x'.repeat(cap - overhead);
    await host.projects.persistRecovery(input, op('at-inline-cap'));
    const inline = f.calls.find(call => call.args.request?.requestId === 'at-inline-cap').args.request;
    assert.equal(inline.payload.kind, 'inline');
    assert.equal(Buffer.byteLength(JSON.stringify(inline.payload.value)), cap);
    input.buffers[0].text += 'x';
    await host.projects.persistRecovery(input, op('above-inline-cap'));
    const uploaded = f.calls.find(call => call.args.request?.requestId === 'above-inline-cap').args.request;
    assert.equal(uploaded.payload.kind, 'upload');
    assert.ok(Buffer.byteLength(JSON.stringify({ request: { ...inline,
      requestId: 'above-inline-cap', payload: { kind: 'inline', value: { input } } } })) < f.cap.limits.frameBytes,
      'the payload requires upload despite fitting the total encoded frame');
  } finally { await host.dispose(); }
});

test('content imports use their encoded asset budget rather than the playable reply budget', async () => {
  const f = fake({ limits: { frameBytes: 2048, sourceChunkBytes: 512, playableSnapshotBytes: 1024 },
    handlers: { 'project.importProject': () => project } });
  const host = await createDesktopHostWithBridge(f.bridge);
  try {
    const input = { kind: 'content', project: { settings: capture.settings,
      files: [{ path: 'main.muz', text: 'source' }],
      assets: [{ path: 'sample.wav', format: 'wav', base64: Buffer.alloc(3072).toString('base64') }] } };
    const result = await host.projects.importProject(input, op('import-assets'));
    assert.deepEqual(result, project);
    const request = f.calls.find(call => call.args.request?.method === 'project.importProject').args.request;
    assert.equal(request.payload.kind, 'upload');
    assert.ok(f.uploads.get('upload').size > f.cap.limits.playableSnapshotBytes);
    assert.deepEqual(JSON.parse(Buffer.concat(f.uploads.get('upload').chunks)), { input });
  } finally { await host.dispose(); }
});

test('desktop preserves optional normalized gist provenance in bootstrap and content imports', async () => {
  const gist = `${'a'.repeat(32)}/${'b'.repeat(40)}`;
  const f = fake({ bootstrapProject: () => ({ ...project, gist }),
    handlers: { 'project.importProject': request => ({ ...project, gist: request.payload.value.input.project.gist }) } });
  const host = await createDesktopHostWithBridge(f.bridge);
  try {
    const events = [];
    host.projects.subscribe(event => events.push(event));
    assert.equal(events[0].snapshot.gist, gist);
    const input = { kind: 'content', project: { settings: capture.settings,
      files: [{ path: 'main.muz', text: 'source' }], assets: [], gist } };
    assert.equal((await host.projects.importProject(input, op('gist-import'))).gist, gist);
    await assert.rejects(host.projects.importProject({ ...input, project: { ...input.project, gist: gist.toUpperCase() } },
      op('invalid-gist-import')), error => error.code === 'protocol_mismatch');
    assert.equal(f.calls.filter(call => call.args.request?.method === 'project.importProject').length, 1);
  } finally { await host.dispose(); }
});

test('desktop rejects malformed gist metadata in a project snapshot', async () => {
  const f = fake({ bootstrapProject: () => ({ ...project, gist: 'https://example.com/not-a-gist' }) });
  await assert.rejects(createDesktopHostWithBridge(f.bridge), error => error.code === 'protocol_mismatch');
});

test('native source resolution consumes exact authorized identities and canonical buffer IDs', async () => {
  const file = { id: 'file-main', path: 'main.muz', kind: 'source', readOnly: false,
    bufferVersion: 0, diskVersion: null, text: 'working text', dirty: true, deleted: false };
  let resolved = { kind: 'project', path: 'main.muz', fileId: file.id };
  const f = fake({ bootstrapProject: () => ({ ...project, files: [file] }),
    handlers: { 'project.resolveSourceDocument': request => {
      assert.deepEqual(request.payload.value, { input: { project: { project: project.project, epoch: project.epoch },
        path: '/authorized/Project space α/main.muz' } });
      return resolved;
    } } });
  const host = await createDesktopHostWithBridge(f.bridge);
  const input = { project: { project: project.project, epoch: project.epoch },
    path: '/authorized/Project space α/main.muz' };
  try {
    assert.deepEqual(await host.projects.resolveSourceDocument(input, op('project-source')), resolved);
    resolved = { kind: 'library', id: 'library:/granted/external.muz', path: '/granted/external.muz',
      text: 'external authorized source', documentKind: 'source' };
    assert.deepEqual(await host.projects.resolveSourceDocument(input, op('library-source')), resolved);
    resolved = { kind: 'project', path: 'main.muz', fileId: 'different-file' };
    await assert.rejects(host.projects.resolveSourceDocument(input, op('wrong-source-buffer')), error => error.code === 'stale_request');
    const requests = f.calls.filter(call => call.args.request?.method === 'project.resolveSourceDocument').length;
    await assert.rejects(host.projects.resolveSourceDocument({ ...input, project: { ...input.project, epoch: 'old-epoch' } },
      op('stale-source')), error => error.code === 'stale_request');
    assert.equal(f.calls.filter(call => call.args.request?.method === 'project.resolveSourceDocument').length, requests);
  } finally { await host.dispose(); }
});

test('native source resolution enforces the authorized document byte budget', async () => {
  const f = fake({ limits: { sourceDocumentBytes: 16 }, handlers: {
    'project.resolveSourceDocument': () => ({ kind: 'library', id: 'library:/granted/external.muz',
      path: '/granted/external.muz', text: 'α'.repeat(9), documentKind: 'source' }),
  } });
  const host = await createDesktopHostWithBridge(f.bridge);
  try {
    await assert.rejects(host.projects.resolveSourceDocument({ project: { project: project.project, epoch: project.epoch },
      path: '/granted/external.muz' }, op('oversized-source')), error => error.code === 'too_large');
  } finally { await host.dispose(); }
});
