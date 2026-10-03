import type {
  AcceptedRevision, AnalysisFrame, ArchiveResult, CloseReason, CloseResult, DiffPage, EntryCheckResult, ExplanationPage,
  ExportResult, Failure, HostCapabilities, HostEvent, HostLimits, EntryClassification, AttemptedAction,
  InspectionPage, Operation, PageRequest, ProjectEvent, ProjectRef,
  ProjectSnapshot, ProjectStore, RecentProject, RecoveryOffer, ResolvedSourceDocument, RevisionRef, RuntimeEvent, SaveResult,
  SourceLocation, SourceSnapshot, TransportStatus, WorkbenchHost, WorkbenchRuntime,
} from './contracts';

/** The injectable surface is deliberately smaller than the Tauri API. */
export interface DesktopBridge {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen(event: 'workbench://event', listener: (payload: unknown) => void): Promise<() => void | Promise<void>>;
}

type Context = {
  protocolVersion: 1; requestId: string; project: ProjectRef | null;
  engineEpoch: string | null; sourceVersion: number | null; revision: string | null;
};
type Envelope = Context & { sequence: string; barrier: boolean; event: { scope: 'runtime' | 'project' | 'host'; value: unknown } };
type Transfer = { transfer: { id: string; bytes: number; chunks: number } };
type SnapshotContext = Pick<SourceSnapshot, 'id' | 'project' | 'epoch' | 'sourceVersion'>;
type Bootstrap = { protocolVersion: 1; engineEpoch: string; capabilities: HostCapabilities; project: ProjectSnapshot | Transfer | null; recovery: RecoveryOffer[] };
type Internals = {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  transformCallback(callback: (event: { payload: unknown }) => void, once?: boolean): number;
  unregisterCallback(id: number): void;
};
const encoder = new TextEncoder();
const MAX_CHUNK = 256 * 1024;
const MAX_FRAME = 2 * 1024 * 1024;
// Protocol v1 parent reserves this much of its frame for the request envelope.
const INLINE_ENVELOPE_RESERVE = 16 * 1024;
// Imported assets are base64 on this boundary, unlike native playable snapshots.
const MAX_IMPORT_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
// Match the native project's four-slot window, including its two accepted pins.
const MAX_RETAINED_SOURCE_SNAPSHOTS = 4;
const MAX_U64 = 18446744073709551615n;

function failure(code: string, message: string, requestId?: string): Failure {
  return { code, message, phase: 'engine', continuity: 'preserved', ...(requestId ? { requestId } : {}) };
}
function ensure(condition: unknown, message: string, code = 'protocol_mismatch'): asserts condition {
  if (!condition) throw failure(code, message);
}
function object(value: unknown): asserts value is Record<string, any> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
}
function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && value.length > 0, 'Expected an opaque identity.');
}
function integer(value: unknown): asserts value is number {
  ensure(Number.isSafeInteger(value) && (value as number) >= 0, 'Expected a safe nonnegative integer.');
}
function u64(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'Expected a canonical U64 string.');
  const result = BigInt(value);
  ensure(result <= MAX_U64, 'U64 exceeds its range.');
  return result;
}
function finite(value: unknown): asserts value is number {
  ensure(typeof value === 'number' && Number.isFinite(value), 'Expected a finite number.');
}
function projectRef(value: unknown): asserts value is ProjectRef {
  object(value); id(value.project); id(value.epoch);
}
function revisionRef(value: unknown): asserts value is RevisionRef {
  projectRef(value);
  const ref = value as RevisionRef;
  id(ref.engineEpoch); id(ref.revision); integer(ref.sourceVersion); id(ref.entry);
}
function sameProject(a: ProjectRef | null, b: ProjectRef | null): boolean {
  return a === null ? b === null : b !== null && a.project === b.project && a.epoch === b.epoch;
}
function sameRef(a: RevisionRef, b: RevisionRef): boolean {
  return sameProject(a, b) && a.engineEpoch === b.engineEpoch && a.revision === b.revision &&
    a.sourceVersion === b.sourceVersion && a.entry === b.entry;
}
function context(value: unknown): asserts value is Context {
  object(value); ensure(value.protocolVersion === 1, 'Unsupported desktop protocol.'); id(value.requestId);
  if (value.project !== null) projectRef(value.project);
  if (value.engineEpoch !== null) id(value.engineEpoch);
  if (value.sourceVersion !== null) integer(value.sourceVersion);
  if (value.revision !== null) id(value.revision);
}
function validateEnvelope(value: unknown): asserts value is Envelope {
  object(value);
  const {sequence,barrier,event} = value;
  context(value); u64(sequence);
  ensure(typeof barrier === 'boolean', 'Missing ordered lifecycle barrier.');
  object(event);
  ensure(['runtime','project','host'].includes(event.scope) && 'value' in event,
    'Invalid desktop event envelope.');
}
function sameContext(a: Context, b: Context): boolean {
  return a.protocolVersion === b.protocolVersion && a.requestId === b.requestId &&
    sameProject(a.project, b.project) && a.engineEpoch === b.engineEpoch &&
    a.sourceVersion === b.sourceVersion && a.revision === b.revision;
}
function json(value: unknown, depth = 0): void {
  ensure(depth <= 128, 'JSON nesting exceeds the desktop boundary.', 'too_large');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { finite(value); return; }
  ensure(typeof value === 'object' && value !== null, 'Desktop values must be JSON.');
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return; }
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Desktop values must be plain JSON objects.');
  // Optional properties are omitted on the wire, never serialized as null.
  for (const item of Object.values(value)) if (item !== undefined) json(item, depth + 1);
}
function bytes(value: unknown): Uint8Array {
  json(value);
  return encoder.encode(JSON.stringify(value));
}
function isTransfer(value: unknown): value is Transfer {
  return value !== null && typeof value === 'object' && 'transfer' in value;
}
function base64(data: Uint8Array): string {
  let result = '';
  for (let i = 0; i < data.length; i += 8192) result += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(result);
}
function decode(data: unknown, ceiling: number): Uint8Array {
  ensure(typeof data === 'string' && data.length <= Math.ceil(ceiling / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data), 'Invalid transfer chunk.');
  const raw = atob(data);
  ensure(raw.length <= ceiling, 'Transfer chunk exceeds its limit.', 'too_large');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function validateFailure(value: unknown): asserts value is Failure {
  object(value); id(value.code); ensure(typeof value.message === 'string', 'Invalid failure message.');
  ensure(['project', 'compile', 'prepare', 'apply', 'transport', 'inspect', 'export', 'engine'].includes(value.phase), 'Invalid failure phase.');
  ensure(['preserved', 'lost', 'not-started'].includes(value.continuity), 'Invalid failure continuity.');
  if (value.runtime !== undefined) {
    object(value.runtime); id(value.runtime.code);
    if (value.runtime.expectedRevision !== null) u64(value.runtime.expectedRevision);
    if (value.runtime.observedRevision !== null) u64(value.runtime.observedRevision);
  }
  if (value.operation !== undefined) {
    object(value.operation); const operation = value.operation;
    id(operation.action); id(operation.requestId);
    ensure(['rebuild','classifyEntries','format','play','pause','stop','restart','panic','seek','loop',
      'audition','analysis','inspect','export','save','refresh','openProject','importProject',
      'trustAndRun','recovery','restartEngine','project'].includes(operation.action), 'Invalid attempted action.');
    if (operation.ref !== null) revisionRef(operation.ref);
    ensure(['applied','rejected','cancelled','superseded','unknown','partial'].includes(operation.outcome), 'Invalid operation outcome.');
    ensure(['preserved','lost','not-started'].includes(operation.continuity), 'Invalid operation continuity.');
    ensure(['project','compile','prepare','apply','transport','inspect','export','engine'].includes(operation.phase), 'Invalid operation phase.');
    for (const runtime of [operation.expectedRuntimeRevision, operation.actualRuntimeRevision]) if (runtime !== null) u64(runtime);
  }
}
function capabilities(value: unknown): asserts value is HostCapabilities {
  object(value); ensure(value.environment === 'desktop' && value.protocolVersion === 1, 'Not a desktop protocol-v1 host.');
  id(value.platform); id(value.coreRevision); object(value.limits);
  const names: (keyof HostLimits)[] = ['frameBytes', 'sourceChunkBytes', 'sourceDocumentBytes', 'sourceSnapshotBytes',
    'outstandingRequests', 'preparingCandidates', 'queuedCandidates', 'inspectionRows', 'inspectionBytes',
    'statusHz', 'analysisHz', 'waveformSamples', 'spectrumBins', 'trackMeters', 'analysisBytes',
    'exportWorkers', 'exportQueue', 'playableSnapshotBytes'];
  for (const name of names) integer(value.limits[name]);
  ensure(value.limits.frameBytes >= 1024 && value.limits.frameBytes <= MAX_FRAME &&
    value.limits.sourceChunkBytes > 0 && value.limits.sourceChunkBytes <= MAX_CHUNK &&
    value.limits.outstandingRequests > 0, 'Unusable desktop limits.');
  const ceilings: Partial<HostLimits> = {
    sourceDocumentBytes: 8 * 1024 * 1024, sourceSnapshotBytes: 64 * 1024 * 1024,
    outstandingRequests: 64, inspectionRows: 1000, inspectionBytes: 1024 * 1024,
    waveformSamples: 2048, spectrumBins: 1025, trackMeters: 1000, statusHz: 20, analysisHz: 30,
    analysisBytes: 128 * 1024, playableSnapshotBytes: 256 * 1024 * 1024,
  };
  for (const [name, ceiling] of Object.entries(ceilings)) {
    ensure(value.limits[name] <= ceiling, 'Desktop limits exceed protocol ceilings.');
  }
  ensure(Array.isArray(value.nativePluginFormats) && value.nativePluginFormats.every((x: unknown) => x === 'clap' || x === 'vst3'), 'Invalid plugin capabilities.');
  object(value.audio); object(value.filesystem);
  for (const availability of [value.audio, ...['folder', 'watch', 'reveal', 'recovery', 'nativeDialogs'].map(key => value.filesystem[key])]) {
    object(availability); ensure(typeof availability.available === 'boolean' && (availability.reason === null || typeof availability.reason === 'string'), 'Invalid availability.');
  }
}
function sourceBounds(value: unknown, limits: HostLimits): void {
  let total = 0;
  const walk = (node: unknown, key = '') => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, key); return; }
    for (const [name, child] of Object.entries(node)) {
      if (typeof child === 'string' && (name === 'text' || name === 'source' ||
        (['base', 'local', 'disk', 'mergedText'].includes(name) && key !== 'health'))) {
        const length = encoder.encode(child).byteLength;
        ensure(length <= limits.sourceDocumentBytes, 'Source document exceeds the native limit.', 'too_large');
        total += length;
        ensure(total <= limits.sourceSnapshotBytes, 'Source capture exceeds the native limit.', 'too_large');
      } else walk(child, name);
    }
  };
  walk(value);
}
function snapshot(value: unknown, limits: HostLimits): asserts value is ProjectSnapshot {
  projectRef(value);
  const item = value as ProjectSnapshot;
  integer(item.sourceVersion); u64(item.diskGeneration); id(item.entry);
  ensure(typeof item.title === 'string' && Array.isArray(item.entries) && Array.isArray(item.files) &&
    Array.isArray(item.resources) && Array.isArray(item.conflicts) && typeof item.dirty === 'boolean', 'Invalid project snapshot.');
  object(item.execution);
  ensure(typeof item.execution.trusted === 'boolean' &&
    ['account-native','preview'].includes(item.execution.policy) &&
    item.execution.trusted === (item.execution.policy === 'account-native'), 'Invalid native execution authority.');
  if (item.gist !== undefined) ensure(typeof item.gist === 'string' &&
    /^[a-f0-9]{32,40}(?:\/[a-f0-9]{40})?$/.test(item.gist), 'Invalid project gist origin.');
  for (const file of item.files) {
    object(file); id(file.id); id(file.path); integer(file.bufferVersion);
    ensure(typeof file.text === 'string' && ['source', 'document', 'text'].includes(file.kind) &&
      typeof file.readOnly === 'boolean' && typeof file.dirty === 'boolean' && typeof file.deleted === 'boolean', 'Invalid project file.');
    if (file.diskVersion !== null) id(file.diskVersion);
  }
  sourceBounds(item, limits);
}
function validateSave(value: unknown, limits: HostLimits): asserts value is SaveResult {
  object(value); u64(value.diskGeneration);
  ensure(Array.isArray(value.saved) && Array.isArray(value.conflicts) && Array.isArray(value.failures) &&
    typeof value.settingsSaved === 'boolean', 'Invalid save outcome.');
  if (value.settingsDiskVersion !== null) id(value.settingsDiskVersion);
  for (const saved of value.saved) {
    object(saved); id(saved.fileId); integer(saved.bufferVersion);
    if (saved.diskVersion !== null) id(saved.diskVersion);
  }
  for (const conflict of value.conflicts) {
    object(conflict); id(conflict.fileId); id(conflict.path); integer(conflict.bufferVersion);
    for (const name of ['base', 'local', 'disk']) ensure(conflict[name] === null || typeof conflict[name] === 'string', 'Invalid conflict text.');
    if (conflict.baseVersion !== null) id(conflict.baseVersion);
    if (conflict.diskVersion !== null) id(conflict.diskVersion);
  }
  for (const item of value.failures) {
    object(item); if (item.fileId !== null) id(item.fileId); validateFailure(item.failure);
  }
  sourceBounds(value, limits);
}
function validateInput(method: string, value: unknown): void {
  object(value);
  const input = value.input;
  if (input && typeof input === 'object' && 'epoch' in input) {
    id(input.project); id(input.epoch);
    if ('sourceVersion' in input) integer(input.sourceVersion);
    if ('expectedDiskGeneration' in input) u64(input.expectedDiskGeneration);
    if ('settingsDiskVersion' in input && input.settingsDiskVersion !== null) id(input.settingsDiskVersion);
    for (const file of input.buffers ?? input.files ?? []) {
      object(file); id(file.fileId); id(file.path); integer(file.bufferVersion);
      ensure(file.text === null || typeof file.text === 'string', 'Invalid captured source.');
      if (file.expectedDiskVersion !== null) id(file.expectedDiskVersion);
    }
  }
  const settings = value.settings ?? input?.settings;
  if (settings !== undefined) {
    object(settings); ensure(typeof settings.title === 'string', 'Invalid project title.'); id(settings.entry);
    if (settings.entries !== undefined) { ensure(Array.isArray(settings.entries), 'Invalid entry list.'); for (const entry of settings.entries) id(entry); }
  }
  if (method === 'project.importProject') {
    object(input); ensure(input.kind === 'zipDialog' || input.kind === 'content', 'Unknown project import kind.');
    if (input.kind === 'content') {
      object(input.project); object(input.project.settings);
      ensure(typeof input.project.settings.title === 'string', 'Invalid imported project title.'); id(input.project.settings.entry);
      ensure(Array.isArray(input.project.files) && Array.isArray(input.project.assets), 'Invalid imported project contents.');
      if (input.project.gist !== undefined) ensure(typeof input.project.gist === 'string' &&
        /^[a-f0-9]{32,40}(?:\/[a-f0-9]{40})?$/.test(input.project.gist), 'Invalid imported gist origin.');
      for (const file of input.project.files) { object(file); id(file.path); ensure(typeof file.text === 'string', 'Invalid imported source.'); }
      let assetBytes = 0;
      for (const asset of input.project.assets) {
        object(asset); id(asset.path);
        ensure(['midi', 'wav', 'flac'].includes(asset.format) && typeof asset.base64 === 'string', 'Invalid imported asset.');
        const data = asset.base64;
        ensure(data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(data) &&
          (data.indexOf('=') === -1 || /^(?:[^=]*)(?:={1,2})$/.test(data)), 'Invalid imported asset base64.');
        assetBytes += data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        ensure(assetBytes <= MAX_IMPORT_ASSET_BYTES, 'Imported assets exceed the decoded native budget.', 'too_large');
      }
    }
  }
  if (method === 'runtime.rebuild' || method === 'runtime.checkEntries') id(value.snapshot);
  if (method === 'runtime.checkEntries') {
    ensure(Array.isArray(value.entries), 'Invalid entry candidate list.');
    ensure(value.entries.length <= 1000, 'Entry candidates exceed the supported source scan budget.', 'resource_budget');
    ensure(new Set(value.entries).size === value.entries.length, 'Duplicate entry candidates.', 'invalid_source');
    for (const entry of value.entries) { id(entry); ensure(/\.muz$/i.test(entry), 'Entry must be a source path.'); }
  }
  if (method === 'runtime.inspect') ensure(['summary', 'graph', 'patches', 'patch_nodes', 'patch_detail',
    'performance', 'performance_overview', 'automation', 'automation_points', 'sections', 'track_groups',
    'locations', 'score', 'diagnostics'].includes(value.view), 'Unknown inspection view.');
  if (method === 'runtime.diff') ensure(['notes', 'metadata', 'occurrences', 'controllers', 'messages',
    'tempos', 'performed', 'consequences'].includes(value.category), 'Unknown diff category.');
  if (method === 'runtime.transport') ensure(['play', 'pause', 'stop', 'restart', 'panic', 'seek', 'loop'].includes(value.command.kind), 'Unknown transport command.');
  if (method === 'runtime.export') {
    ensure(['masterWav', 'wav', 'midi'].includes(value.spec.kind), 'Unknown export format.');
    if (value.spec.kind !== 'masterWav') { ensure(Array.isArray(value.spec.tracks), 'Invalid export tracks.'); for (const track of value.spec.tracks) id(track); }
  }
  if (method === 'runtime.audition') {
    object(value.controls);
    for (const tracks of [value.controls.muted, value.controls.solo]) {
      ensure(Array.isArray(tracks), 'Invalid audition controls.'); for (const track of tracks) id(track);
      ensure(new Set(tracks).size === tracks.length, 'Duplicate audition track.');
    }
  }
  if (method === 'runtime.analysis') {
    object(value.subscription); const subscription = value.subscription;
    ensure((subscription.source === null || typeof subscription.source === 'string') &&
      typeof subscription.detail === 'boolean' && typeof subscription.meters === 'boolean', 'Invalid analysis subscription.');
    integer(subscription.detailHz); integer(subscription.meterHz);
    ensure(subscription.detailHz > 0 && subscription.detailHz <= 30 &&
      subscription.meterHz > 0 && subscription.meterHz <= 20, 'Invalid analysis cadence.');
  }
  if (method === 'preferences.save') {
    object(value.value); const prefs = value.value;
    ensure(prefs.version === 1 && ['light', 'dark', 'soft-light', 'soft-dark'].includes(prefs.theme), 'Invalid preferences version or theme.');
    object(prefs.layout);
    for (const key of ['explorer', 'source', 'visualization', 'inspector']) ensure(typeof prefs.layout[key] === 'boolean', 'Invalid layout visibility.');
    finite(prefs.layout.sourceFraction); ensure(prefs.layout.sourceFraction > 0 && prefs.layout.sourceFraction < 1, 'Invalid source split.');
  }
}
function page(value: unknown, limits: HostLimits): asserts value is InspectionPage {
  object(value); revisionRef(value.ref); integer(value.total);
  ensure(Array.isArray(value.rows) && value.rows.length <= limits.inspectionRows, 'Inspection row limit exceeded.', 'too_large');
  if (value.next !== null) integer(value.next);
  ensure(bytes(value).length <= limits.inspectionBytes, 'Inspection byte limit exceeded.', 'too_large');
}
function meters(value: unknown, limits: HostLimits): void {
  ensure(Array.isArray(value) && value.length <= limits.trackMeters, 'Invalid track meters.');
  for (const meter of value) { object(meter); id(meter.track); finite(meter.peak); finite(meter.rms); }
}
function status(value: unknown, limits: HostLimits): asserts value is TransportStatus {
  object(value); revisionRef(value.ref); u64(value.generation); u64(value.sequence);
  ensure(typeof value.playing === 'boolean' && typeof value.finished === 'boolean', 'Invalid transport state.');
  for (const key of ['beat', 'seconds', 'bpm', 'duration', 'endBeat', 'tail', 'peak', 'rms']) finite(value[key]);
  ensure(Array.isArray(value.meter) && value.meter.length === 2, 'Invalid meter.');
  for (const number of value.meter) finite(number);
  if (value.loop !== null) { ensure(Array.isArray(value.loop) && value.loop.length === 2, 'Invalid loop.'); for (const number of value.loop) finite(number); }
  meters(value.meters, limits); object(value.audio); object(value.health);
}
function analysis(value: unknown, limits: HostLimits): asserts value is AnalysisFrame {
  object(value); revisionRef(value.ref); u64(value.generation); u64(value.sequence); u64(value.dropped);
  for (const key of ['sampleRate', 'captureSeconds', 'peak', 'rms']) finite(value[key]);
  u64(value.captureId);
  if (value.windowEndSample !== null) u64(value.windowEndSample);
  if (value.meterWindowEndSample !== null) u64(value.meterWindowEndSample);
  integer(value.sampleCount);
  ensure(value.sampleCount <= 2048 && typeof value.warmup === 'boolean' &&
    typeof value.metersPresent === 'boolean' && ['hann','blackman'].includes(value.window), 'Invalid analysis window metadata.');
  finite(value.smoothing); ensure(value.smoothing >= 0 && value.smoothing <= 1, 'Invalid analyser smoothing.');
  for (const [key, max] of [['waveform', limits.waveformSamples], ['spectrum', limits.spectrumBins]] as const) {
    ensure(Array.isArray(value[key]) && value[key].length <= max, 'Analysis sample limit exceeded.', 'too_large');
    for (const number of value[key]) finite(number);
  }
  meters(value.meters, limits);
  ensure(bytes(value).length <= limits.analysisBytes, 'Analysis byte limit exceeded.', 'too_large');
}
function accepted(value: unknown, limits: HostLimits): asserts value is AcceptedRevision {
  object(value); revisionRef(value.ref); status(value.status, limits);
  ensure(sameRef(value.ref, value.status.ref), 'Accepted status belongs to another revision.');
  object(value.initialPages);
  for (const view of ['summary', 'graph', 'sections', 'track_groups', 'locations', 'diagnostics']) {
    page(value.initialPages[view], limits);
    ensure(value.initialPages[view].view === view && sameRef(value.ref, value.initialPages[view].ref), 'Accepted inspection belongs to another revision.');
  }
  json(value.effect); ensure(Array.isArray(value.exportTracks), 'Invalid export tracks.');
  for (const track of value.exportTracks) { object(track); id(track.id); ensure(typeof track.name === 'string' && typeof track.midi === 'boolean', 'Invalid export track.'); }
}
function entryClassification(value: unknown): asserts value is EntryClassification {
  object(value); id(value.entry);
  ensure(['song','non-song','unresolved'].includes(value.kind), 'Invalid evaluated root kind.');
  if (value.description !== undefined) ensure(typeof value.description === 'string', 'Invalid root description.');
  object(value.readiness);
  ensure(['unchecked','validated','blocked'].includes(value.readiness.kind), 'Invalid readiness state.');
  if (value.readiness.kind === 'blocked') validateFailure(value.readiness.failure);
  if (value.failure !== null) validateFailure(value.failure);
  ensure(value.kind !== 'unresolved' || value.failure !== null, 'Unresolved root lacks its diagnostic.');
}

export async function createDesktopHost(): Promise<WorkbenchHost> {
  const native = (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
  ensure(native && typeof native.invoke === 'function' && typeof native.transformCallback === 'function' &&
    typeof native.unregisterCallback === 'function', 'The trusted Tauri bridge is unavailable.');
  return createDesktopHostWithBridge({
    invoke: (command, args) => native.invoke(command, args),
    async listen(event, listener) {
      const callback = native.transformCallback(message => listener(message.payload));
      let eventId: number;
      try {
        eventId = await native.invoke<number>('plugin:event|listen', { event, target: { kind: 'Any' }, handler: callback });
      } catch (error) { native.unregisterCallback(callback); throw error; }
      return async () => {
        try { await native.invoke('plugin:event|unlisten', { event, eventId }); }
        finally { native.unregisterCallback(callback); }
      };
    },
  });
}

export async function createDesktopHostWithBridge(bridge: DesktopBridge): Promise<WorkbenchHost> {
  let caps: HostCapabilities;
  let engineEpoch: string;
  let currentProject: ProjectRef | null = null;
  let currentSourceVersion: number | null = null;
  let currentRevision: RevisionRef | null = null;
  let transportGeneration: bigint | null = null;
  let statusSequence: bigint|null = null;
  let analysisSequence: bigint | null = null;
  let closePermission: { token: string; project: ProjectRef; reason: CloseReason } | null = null;
  let disposed = false;
  let runtimeDisposed = false;
  let disposePromise: Promise<void> | undefined;
  let runtimeDisposePromise: Promise<void> | undefined;
  let engineReady = true;
  let entryScanGeneration = 0;
  let preferencesQueue: Promise<void> = Promise.resolve();
  let bootstrapping = true;
  let counter = 0;
  const prefix = crypto.randomUUID();
  const pending = new Set<string>();
  let activeTransferBytes = 0;
  let activeRequestBytes = 0;
  let activeReaders = 0;
  const snapshots = new Map<string, SnapshotContext>();
  const activeRebuilds = new Map<string, { snapshot: SnapshotContext; accepted: boolean }>();
  let retainedSnapshot: string | null = null;
  let previousSnapshot: string | null = null;
  const runtimeListeners = new Set<(event: RuntimeEvent) => void>();
  const projectListeners = new Set<(event: ProjectEvent) => void>();
  const hostListeners = new Set<(event: HostEvent) => void>();
  const recoveries = new Map<string, RecoveryOffer>();
  let lastProject: ProjectEvent | null = null;
  let lastEngine: RuntimeEvent | null = null;
  let lastStatus: RuntimeEvent | null = null;
  let lastAnalysis: RuntimeEvent | null = null;
  let lastClose: HostEvent | null = null;
  let lastPreferencesFailure: HostEvent | null = null;
  const reliableBacklog: RuntimeEvent[] = [];
  const bootstrapEvents: unknown[] = [];
  let bootstrapBytes = 0;
  let bootstrapError: unknown;
  const eventQueue: { raw: Envelope; size: number }[] = [];
  const latestTelemetry: Partial<Record<'status'|'analysis', Envelope>> = {};
  let lifecycleBarriers = 0;
  let telemetryScheduled = false;
  let queuedEventBytes = 0;
  let drainingEvents = false;
  let eventBoundaryFailure: Failure | null = null;
  let coalescedAnalysis = 0n;
  let sequence: bigint | null = null;
  const retiredEngines = new Set<string>();
  const nextOp = (): Operation => ({ requestId: `${prefix}:${++counter}` });
  const emit = <T>(listeners: Set<(event: T) => void>, event: T) => {
    for (const listener of listeners) {
      // A consumer exception must not interrupt reliable event delivery.
      try { listener(event); } catch (error) { console.error('Workbench event listener failed', error); }
    }
  };
  const emitFailure = (error: unknown) => {
    const item = error && typeof error === 'object' && 'code' in error ? error as Failure : failure('protocol_mismatch', String(error));
    if (!runtimeListeners.size && reliableBacklog.length < 512) reliableBacklog.push({ kind: 'failure', failure: item });
    emit(runtimeListeners, { kind: 'failure', failure: item });
  };
  const live = (ctx: Context, engine = true) => {
    ensure(!disposed, 'Desktop host has been disposed.', 'stale_request');
    const retainedPreview = engine && lastProject?.kind === 'changed' &&
      lastProject.snapshot.execution.policy === 'preview' && currentRevision !== null &&
      sameProject(ctx.project, currentRevision) && ctx.engineEpoch === currentRevision.engineEpoch &&
      ctx.revision === currentRevision.revision && ctx.sourceVersion === currentRevision.sourceVersion;
    ensure(sameProject(ctx.project, currentProject) || retainedPreview,
      'Project changed while the request was in flight.', 'stale_request');
    if (engine && ctx.engineEpoch !== null) ensure(ctx.engineEpoch === engineEpoch, 'Engine changed while the request was in flight.', 'stale_request');
  };
  function makeContext(op: Operation, ref?: RevisionRef | ProjectRef | null, sourceVersion?: number | null): Context {
    id(op.requestId);
    if (ref) projectRef(ref);
    const revision = ref && 'revision' in ref ? ref as RevisionRef : null;
    if (revision) revisionRef(revision);
    if (revision && !sameProject(revision,currentProject) && lastProject?.kind === 'changed' &&
        lastProject.snapshot.execution.policy === 'preview') {
      ensure(currentRevision !== null && sameRef(revision,currentRevision),
        'Preview operations require the exact retained accepted revision.', 'stale_revision');
    }
    return { protocolVersion: 1, requestId: op.requestId, project: ref ? { project: ref.project, epoch: ref.epoch } : currentProject,
      engineEpoch: revision?.engineEpoch ?? engineEpoch, sourceVersion: sourceVersion ?? revision?.sourceVersion ?? currentSourceVersion,
      revision: revision?.revision ?? null };
  }
  async function wire(ctx: Context, method: string, payload: unknown): Promise<unknown> {
    const { protocolVersion, requestId, project, engineEpoch: targetEngine, sourceVersion, revision } = ctx;
    const request = { protocolVersion, requestId, project, engineEpoch: targetEngine, sourceVersion, revision, method, payload };
    ensure(bytes({ request }).length <= caps.limits.frameBytes, 'Encoded request exceeds the frame limit.', 'too_large');
    const reply = await bridge.invoke<unknown>('workbench_request', { request });
    context(reply);
    ensure(sameContext(ctx, reply), 'Desktop reply context does not match its request.');
    ensure(bytes(reply).length <= caps.limits.frameBytes, 'Encoded reply exceeds the frame limit.', 'too_large');
    const result = reply as Context & { ok: boolean; value?: unknown; failure?: unknown };
    ensure(typeof result.ok === 'boolean', 'Missing reply outcome.');
    if (!result.ok) { validateFailure(result.failure); throw result.failure; }
    ensure('value' in result, 'Missing reply value.'); json(result.value);
    return result.value;
  }
  async function transfer(value: unknown, ctx: Context, check: () => void, max = caps.limits.playableSnapshotBytes): Promise<unknown> {
    if (!isTransfer(value)) return value;
    object(value.transfer);
    const { id: transferId, bytes: length, chunks } = value.transfer;
    id(transferId);
    let reserved = false;
    try {
      integer(length); integer(chunks); check();
      ensure(length > 0 && length <= max && chunks > 0 && chunks <= length &&
        chunks * caps.limits.sourceChunkBytes >= length, 'Invalid transfer size.', 'too_large');
      ensure(activeReaders < caps.limits.outstandingRequests &&
        activeTransferBytes + length <= caps.limits.playableSnapshotBytes, 'Concurrent transfer budget exceeded.', 'resource_budget');
      activeReaders++; activeTransferBytes += length; reserved = true;
      const data = new Uint8Array(length);
      let offset = 0;
      for (let index = 0; index < chunks; index++) {
        check();
        const part = await wire({ ...ctx, requestId: nextOp().requestId }, 'transfer.read', { kind: 'inline', value: { id: transferId, index } });
        check(); object(part);
        ensure(part.index === index && part.last === (index === chunks - 1), 'Out-of-order transfer chunk.');
        const chunk = decode(part.data, Math.min(MAX_CHUNK, caps.limits.sourceChunkBytes));
        ensure(chunk.length > 0 && offset + chunk.length <= length, 'Transfer exceeds its announced length.');
        data.set(chunk, offset); offset += chunk.length;
      }
      ensure(offset === length, 'Incomplete transfer.');
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      json(decoded); ensure(!isTransfer(decoded), 'Nested transfers are forbidden.');
      sourceBounds(decoded, caps.limits); check();
      return decoded;
    } finally {
      if (reserved) { activeReaders--; activeTransferBytes -= length; }
      try { await wire({ ...ctx, requestId: nextOp().requestId }, 'transfer.release', { kind: 'inline', value: { id: transferId } }); }
      catch (error) { emitFailure(error); }
    }
  }
  function clearSnapshots() {
    snapshots.clear(); activeRebuilds.clear();
    retainedSnapshot = null; previousSnapshot = null;
  }
  function retainSnapshot(captured: SnapshotContext) {
    // An in-flight response may finish after eviction; it must not revive a handle.
    if (!snapshots.has(captured.id) || retainedSnapshot === captured.id) return;
    previousSnapshot = retainedSnapshot; retainedSnapshot = captured.id;
  }
  function setProject(value: ProjectSnapshot) {
    snapshot(value, caps.limits);
    ensure(!sameProject(currentProject, value) || currentSourceVersion === null || value.sourceVersion >= currentSourceVersion,
      'Project response predates a newer local working capture.', 'stale_request');
    if (!sameProject(currentProject,value) || (value.execution.trusted && currentRevision !== null &&
        !sameProject(currentRevision,value))) {
      closePermission = null;
      const preservesAccepted = value.execution.policy === 'preview' ||
        (currentRevision !== null && sameProject(currentRevision,value));
      if (!preservesAccepted) {
        clearSnapshots(); currentRevision = null; transportGeneration = null; statusSequence = null; analysisSequence = null;
        lastStatus = null; lastAnalysis = null;
      }
    }
    currentProject = { project: value.project, epoch: value.epoch };
    currentSourceVersion = value.sourceVersion;
    lastProject = { kind: 'changed', snapshot: value, reason: 'recovery' };
  }
  function accept(value: AcceptedRevision) {
    accepted(value, caps.limits);
    ensure(value.ref.engineEpoch === engineEpoch && sameProject(value.ref, currentProject), 'Accepted revision has stale identities.', 'stale_revision');
    const generation = u64(value.status.generation), next = u64(value.status.sequence);
    if (currentRevision !== null && sameRef(currentRevision,value.ref) && transportGeneration !== null &&
        (generation < transportGeneration || (generation === transportGeneration && statusSequence !== null && next <= statusSequence))) return;
    const resetDetail = currentRevision === null || !sameRef(currentRevision,value.ref) || generation !== transportGeneration;
    currentRevision = value.ref; transportGeneration = generation; statusSequence = next;
    lastStatus = { kind: 'status', status: value.status };
    if (resetDetail) { analysisSequence = null; lastAnalysis = null; }
  }
  function checkPage(input: PageRequest) {
    if (input.offset !== undefined) integer(input.offset);
    if (input.limit !== undefined) { integer(input.limit); ensure(input.limit <= caps.limits.inspectionRows, 'Inspection row request exceeds the limit.', 'too_large'); }
    if (input.start_tick !== undefined) u64(input.start_tick);
    if (input.end_tick !== undefined) u64(input.end_tick);
    if (input.start_tick !== undefined && input.end_tick !== undefined) ensure(u64(input.start_tick) <= u64(input.end_tick), 'Invalid inspection tick range.');
  }
  async function request<T>(method: string, payload: unknown, op = nextOp(), ref?: RevisionRef | ProjectRef | null, sourceVersion?: number | null): Promise<T> {
    try {
    ensure(!disposed && (!runtimeDisposed || !method.startsWith('runtime.')), 'Desktop runtime has been disposed.', 'stale_request');
    const ctx = makeContext(op, ref, sourceVersion);
    const engineBound = method.startsWith('runtime.');
    live(ctx, engineBound);
    ensure(!op.signal?.aborted, 'Operation was cancelled before dispatch.', 'cancelled');
    if (engineBound && !engineReady && method !== 'runtime.dispose') throw failure('child_died', 'The native engine is not ready; restart it explicitly.', op.requestId);
    if (eventBoundaryFailure && method !== 'host.dispose') throw eventBoundaryFailure;
    ensure(!pending.has(op.requestId), 'Request identity is already in flight.', 'stale_request');
    ensure(pending.size < caps.limits.outstandingRequests, 'Desktop request queue is full.', 'queue_full');
    validateInput(method, payload);
    const encoded = bytes(payload); sourceBounds(payload, caps.limits);
    ensure(encoded.length <= (method === 'project.importProject' ? MAX_UPLOAD_BYTES : caps.limits.playableSnapshotBytes),
      'Request exceeds the encoded transfer limit.', 'too_large');
    if (sourceVersion !== undefined && sourceVersion !== null) {
      integer(sourceVersion);
      currentSourceVersion = Math.max(currentSourceVersion ?? 0, sourceVersion);
    }
    ensure(activeRequestBytes + encoded.length <= MAX_UPLOAD_BYTES, 'Concurrent request payload budget exceeded.', 'resource_budget');
    activeRequestBytes += encoded.length;
    pending.add(op.requestId);
    let upload: string | undefined;
    let dispatched = false;
    let cancelSent = false;
    const cancel = () => {
      if (!dispatched || cancelSent) return;
      cancelSent = true;
      void bridge.invoke<unknown>('workbench_cancel', { context: ctx, target: ctx.requestId }).then(receipt => {
        object(receipt); ensure(receipt.target === ctx.requestId && ['requested', 'finished', 'unknown'].includes(receipt.state), 'Invalid cancellation receipt.');
      }).catch(emitFailure);
    };
    op.signal?.addEventListener('abort', cancel, { once: true });
    try {
      let content: { kind: 'inline'; value: unknown } | { kind: 'upload'; id: string } = { kind: 'inline', value: payload };
      if (encoded.length > Math.max(0, caps.limits.frameBytes - INLINE_ENVELOPE_RESERVE) ||
          bytes({ request: { ...ctx, method, payload: content } }).length > caps.limits.frameBytes) {
        const begun = await bridge.invoke<unknown>('workbench_upload_begin', { context: ctx, purpose: 'request', bytes: encoded.length });
        object(begun); id(begun.id); upload = begun.id;
        const chunkBytes = Math.min(MAX_CHUNK, caps.limits.sourceChunkBytes, Math.floor((caps.limits.frameBytes - bytes({ context: ctx, id: upload, index: Number.MAX_SAFE_INTEGER, data: '' }).length - 64) / 4) * 3);
        ensure(chunkBytes > 0, 'Frame limit cannot fit an upload chunk.', 'too_large');
        for (let offset = 0, index = 0; offset < encoded.length; offset += chunkBytes, index++) {
          live(ctx, engineBound); ensure(!op.signal?.aborted, 'Operation was cancelled before dispatch.', 'cancelled');
          const result = await bridge.invoke<unknown>('workbench_upload_chunk', { context: ctx, id: upload, index, data: base64(encoded.subarray(offset, offset + chunkBytes)) });
          object(result); ensure(result.next === index + 1, 'Upload chunk was not acknowledged in order.');
        }
        const finished = await bridge.invoke<unknown>('workbench_upload_finish', { context: ctx, id: upload });
        object(finished); ensure(finished.id === upload, 'Upload finish identity mismatch.');
        content = { kind: 'upload', id: upload! };
      }
      live(ctx, engineBound); ensure(!op.signal?.aborted, 'Operation was cancelled before dispatch.', 'cancelled');
      dispatched = true;
      const response = wire(ctx, method, content);
      if (op.signal?.aborted) cancel();
      let result = await response;
      const check = () => {
        live(ctx, engineBound);
        if (engineBound && !engineReady && method !== 'runtime.dispose') throw failure('child_died', 'The native engine failed while the request was in flight.', op.requestId);
      };
      result = await transfer(result, ctx, check, ['runtime.inspect', 'runtime.explain', 'runtime.diff'].includes(method) ? caps.limits.inspectionBytes : caps.limits.playableSnapshotBytes);
      check(); sourceBounds(result, caps.limits);
      if (['runtime.audition', 'runtime.analysis', 'runtime.dispose', 'project.persistRecovery',
        'project.reveal', 'project.close', 'preferences.save', 'host.openExternal', 'host.dispose'].includes(method)) {
        ensure(result === null, 'Void desktop replies must contain null.');
      }
      // A requested cancellation never replaces this authoritative success/failure.
      return result as T;
    } finally {
      op.signal?.removeEventListener('abort', cancel);
      if (upload) {
        try { await bridge.invoke('workbench_upload_discard', { context: ctx, id: upload }); }
        catch (error) { emitFailure(error); }
      }
      pending.delete(op.requestId); activeRequestBytes -= encoded.length;
    }
    } catch (error) {
      const item = error && typeof error === 'object' && 'code' in error ? error as Failure : failure('protocol_mismatch', String(error));
      if (!item.operation && currentRevision === null) item.continuity = 'not-started';
      const action: AttemptedAction = method === 'runtime.transport' && payload && typeof payload === 'object' &&
        'command' in payload && payload.command && typeof payload.command === 'object' && 'kind' in payload.command ?
        payload.command.kind as AttemptedAction :
        method === 'runtime.checkEntries' ? 'classifyEntries' : method === 'host.restartEngine' ? 'restartEngine' :
        method === 'runtime.format' ? 'format' : method.startsWith('runtime.') ?
          ({rebuild:'rebuild',audition:'audition',analysis:'analysis',export:'export'} as Record<string,AttemptedAction>)[method.slice(8)] ?? 'inspect' :
        ({'project.save':'save','project.refresh':'refresh','project.importProject':'importProject',
          'project.trustAndRun':'trustAndRun','project.chooseFolder':'openProject','project.openRecent':'openProject',
          'project.restoreRecovery':'recovery'} as Record<string,AttemptedAction>)[method] ?? 'project';
      item.requestId ??= op.requestId;
      item.operation ??= {action,requestId:op.requestId,ref:ref && 'revision' in ref ? ref as RevisionRef : null,
        outcome:item.code === 'cancelled' ? 'cancelled' : item.code === 'superseded' ? 'superseded' : item.continuity === 'lost' ? 'unknown' : 'rejected',
        phase:item.phase,continuity:item.continuity,
        expectedRuntimeRevision:item.runtime?.expectedRevision ?? null,actualRuntimeRevision:item.runtime?.observedRevision ?? null};
      throw item;
    }
  }
  async function projectRequest(method: string, payload: unknown, op: Operation, ref?: ProjectRef, version?: number): Promise<ProjectSnapshot | null> {
    const result = await request<ProjectSnapshot | null>(method, payload, op, ref, version);
    if (result !== null) setProject(result);
    return result;
  }
  async function requiredProject(method: string, payload: unknown, op: Operation, ref?: ProjectRef, version?: number): Promise<ProjectSnapshot> {
    const result = await projectRequest(method, payload, op, ref, version);
    ensure(result !== null, 'Missing project snapshot.'); return result;
  }
  function telemetryRef(ref: RevisionRef): boolean {
    const retainedPreview = lastProject?.kind === 'changed' && lastProject.snapshot.execution.policy === 'preview' &&
      currentRevision !== null && sameRef(ref,currentRevision);
    return engineReady && ref.engineEpoch === engineEpoch &&
      (sameProject(ref,currentProject) || retainedPreview) && (currentRevision === null || sameRef(ref,currentRevision));
  }
  async function onEvent(raw: unknown) {
    context(raw); object(raw);
    const envelope = raw as Envelope;
    object(envelope.event);
    ensure(['runtime', 'project', 'host'].includes(envelope.event.scope), 'Invalid desktop event scope.');
    const rawValue = envelope.event.value;
    const possiblyEngine = envelope.event.scope === 'runtime' && (isTransfer(rawValue) ||
      (rawValue !== null && typeof rawValue === 'object' && 'kind' in rawValue && rawValue.kind === 'engine'));
    const retainedEngineEnvelope = envelope.event.scope === 'runtime' && lastProject?.kind === 'changed' &&
      lastProject.snapshot.execution.policy === 'preview' && currentRevision !== null &&
      sameProject(envelope.project,currentRevision) && envelope.engineEpoch === currentRevision.engineEpoch &&
      envelope.revision === null && envelope.sourceVersion === null;
    const check = () => {
      ensure(!disposed, 'Host is disposed.', 'stale_request');
      if (retainedEngineEnvelope) return;
      if (envelope.event.scope === 'runtime' && !possiblyEngine) live(envelope);
      else if (envelope.project !== null) ensure(sameProject(envelope.project, currentProject), 'Stale project event.', 'stale_request');
    };
    const value = await transfer(envelope.event.value, envelope, check);
    object(value); id(value.kind);
    check();
    if (envelope.event.scope === 'runtime' && value.kind !== 'engine' &&
        !(value.kind === 'failure' && retainedEngineEnvelope)) live(envelope);
    if (envelope.event.scope === 'runtime' && value.kind === 'engine' && retiredEngines.has(value.engineEpoch)) return;
    if (envelope.event.scope === 'runtime') {
      const event = value as RuntimeEvent;
      switch (event.kind) {
        case 'engine':
          id(event.engineEpoch); capabilities(event.capabilities);
          ensure(['starting', 'ready', 'failed', 'stopped'].includes(event.state), 'Invalid engine state.');
          ensure(envelope.engineEpoch === event.engineEpoch, 'Engine event identity mismatch.');
          if (retiredEngines.has(event.engineEpoch)) return;
          if (event.engineEpoch !== engineEpoch) {
            retiredEngines.add(engineEpoch); engineEpoch = event.engineEpoch;
            currentRevision = null; transportGeneration = null; statusSequence = null; analysisSequence = null; lastStatus = null; lastAnalysis = null;
          }
          if (event.state === 'failed' || event.state === 'stopped') {
            currentRevision = null; transportGeneration = null; statusSequence = null; analysisSequence = null; lastStatus = null; lastAnalysis = null;
          }
          caps = event.capabilities; lastEngine = event;
          engineReady = event.state === 'ready';
          break;
        case 'status': {
          status(event.status, caps.limits);
          ensure(sameProject(event.status.ref, envelope.project) && event.status.ref.engineEpoch === envelope.engineEpoch &&
            event.status.ref.sourceVersion === envelope.sourceVersion && event.status.ref.revision === envelope.revision,
            'Status event context mismatch.');
          if (!telemetryRef(event.status.ref)) return;
          const generation = u64(event.status.generation), next = u64(event.status.sequence);
          if (transportGeneration !== null && (generation < transportGeneration ||
              (generation === transportGeneration && statusSequence !== null && next <= statusSequence))) return;
          if (transportGeneration !== generation) { analysisSequence = null; lastAnalysis = null; }
          transportGeneration = generation; statusSequence = next; lastStatus = event;
          break;
        }
        case 'analysis': {
          analysis(event.frame, caps.limits);
          ensure(sameProject(event.frame.ref, envelope.project) && event.frame.ref.engineEpoch === envelope.engineEpoch &&
            event.frame.ref.sourceVersion === envelope.sourceVersion && event.frame.ref.revision === envelope.revision,
            'Analysis event context mismatch.');
          event.frame = { ...event.frame, dropped: (u64(event.frame.dropped) + coalescedAnalysis).toString() };
          u64(event.frame.dropped);
          if (!telemetryRef(event.frame.ref)) return;
          const generation = u64(event.frame.generation), next = u64(event.frame.sequence);
          if (transportGeneration !== null && generation < transportGeneration) return;
          if (generation === transportGeneration && analysisSequence !== null && next <= analysisSequence) return;
          if (generation !== transportGeneration) statusSequence = null;
          transportGeneration = generation; analysisSequence = next; lastAnalysis = event;
          break;
        }
        case 'build':
          id(event.requestId); projectRef(event.project); integer(event.sourceVersion);
          ensure(event.requestId === envelope.requestId && sameProject(event.project, envelope.project) && event.sourceVersion === envelope.sourceVersion, 'Build event context mismatch.');
          ensure(['queued', 'compiling', 'preparing', 'applying', 'accepted', 'rejected', 'cancelled'].includes(event.phase), 'Invalid build phase.');
          if (event.ref !== null) { revisionRef(event.ref); ensure(event.ref.engineEpoch === engineEpoch && sameProject(event.ref, currentProject), 'Invalid build revision.'); }
          if (event.failure !== null) validateFailure(event.failure);
          if (event.phase === 'accepted') {
            ensure(event.ref !== null && event.ref.engineEpoch === engineEpoch && sameProject(event.ref, currentProject), 'Missing accepted revision.');
            const rebuilding = activeRebuilds.get(event.requestId);
            if (rebuilding && !rebuilding.accepted) {
              retainSnapshot(rebuilding.snapshot); rebuilding.accepted = true;
            }
            if (currentRevision === null || !sameRef(currentRevision,event.ref)) {
              currentRevision = event.ref; transportGeneration = null; statusSequence = null; analysisSequence = null;
              lastStatus = null; lastAnalysis = null;
            }
          }
          break;
        case 'entries':
          id(event.requestId); id(event.snapshot); integer(event.done); integer(event.total);
          ensure(event.requestId === envelope.requestId && event.done <= event.total, 'Invalid entry progress.');
          if (event.currentEntry !== null) id(event.currentEntry);
          if (event.result !== null) entryClassification(event.result);
          break;
        case 'exportProgress':
          id(event.requestId); id(event.job); revisionRef(event.ref);
          ensure(event.requestId === envelope.requestId && event.ref.engineEpoch === engineEpoch &&
            (sameProject(event.ref,currentProject) || telemetryRef(event.ref)), 'Stale export progress.', 'stale_revision');
          ensure(event.ref.revision === envelope.revision && event.ref.sourceVersion === envelope.sourceVersion, 'Export progress context mismatch.');
          ensure(['queued', 'preparing', 'rendering', 'publishing'].includes(event.phase), 'Invalid export phase.');
          if (event.progress !== null) { finite(event.progress); ensure(event.progress >= 0 && event.progress <= 1, 'Invalid export progress.'); }
          break;
        case 'failure': validateFailure(event.failure); break;
        default: throw failure('protocol_mismatch', 'Unknown runtime event.');
      }
      if (!runtimeListeners.size && !['engine', 'status', 'analysis'].includes(event.kind)) {
        ensure(reliableBacklog.length < caps.limits.outstandingRequests * 8, 'Unconsumed reliable event queue is full.', 'queue_full');
        reliableBacklog.push(event);
      }
      emit(runtimeListeners, event);
    } else if (envelope.event.scope === 'project') {
      const event = value as ProjectEvent;
      switch (event.kind) {
        case 'changed':
          snapshot(event.snapshot, caps.limits);
          ensure(sameProject(event.snapshot, currentProject), 'Stale project snapshot.', 'stale_request');
          if (currentSourceVersion !== null && event.snapshot.sourceVersion < currentSourceVersion) return;
          setProject(event.snapshot); lastProject = event; break;
        case 'watch': projectRef(event.project); ensure(sameProject(event.project, currentProject), 'Stale project watch.', 'stale_request'); break;
        case 'recovery':
          ensure(Array.isArray(event.offers), 'Invalid recovery offers.');
          for (const offer of event.offers) { object(offer); id(offer.id); }
          recoveries.clear();
          for (const offer of event.offers) recoveries.set(offer.id, offer);
          break;
        case 'failure': validateFailure(event.failure); break;
        default: throw failure('protocol_mismatch', 'Unknown project event.');
      }
      emit(projectListeners, event);
    } else {
      const event = value as HostEvent;
      if (event.kind === 'closeRequested') {
        id(event.ticket); ensure(['replaceProject', 'closeProject', 'closeWindow', 'quit'].includes(event.reason), 'Invalid close reason.'); lastClose = event;
      } else if (event.kind === 'preferencesFailure') { validateFailure(event.failure); lastPreferencesFailure = event; }
      else throw failure('protocol_mismatch', 'Unknown host event.');
      emit(hostListeners, event);
    }
  }
  function scheduleTelemetry() {
    if (telemetryScheduled || lifecycleBarriers || disposed) return;
    telemetryScheduled = true;
    queueMicrotask(() => {
      telemetryScheduled = false;
      if (lifecycleBarriers || disposed) return;
      const retained = Object.values(latestTelemetry).sort((a,b) =>
        u64(a.sequence) < u64(b.sequence) ? -1 : 1);
      delete latestTelemetry.status; delete latestTelemetry.analysis;
      for (const event of retained) void onEvent(event).catch(emitFailure);
    });
  }
  const unlisten = await bridge.listen('workbench://event', raw => {
    if (disposed) return;
    try {
      const size = bytes(raw).length;
      ensure(size <= (bootstrapping ? MAX_FRAME : caps.limits.frameBytes), 'Event exceeds its frame limit.', 'too_large');
      if (bootstrapping) {
        ensure(bootstrapEvents.length < 512 && bootstrapBytes + size <= 64 * 1024 * 1024, 'Bootstrap event queue is full.', 'queue_full');
        bootstrapEvents.push(raw); bootstrapBytes += size;
        return;
      }
      validateEnvelope(raw);
      const envelope = raw;
      const nextSequence = u64(envelope.sequence);
      if (sequence !== null && nextSequence <= sequence) {
        if (isTransfer(envelope.event.value)) void wire({...envelope,requestId:nextOp().requestId},
          'transfer.release',{kind:'inline',value:{id:envelope.event.value.transfer.id}}).catch(emitFailure);
        return;
      }
      sequence = nextSequence;
      const eventValue = envelope.event.value;
      const kind = envelope.event.scope === 'runtime' && eventValue !== null && typeof eventValue === 'object' &&
        'kind' in eventValue ? eventValue.kind : null;
      if (kind === 'status' || kind === 'analysis') {
        ensure(!envelope.barrier, 'Telemetry cannot establish a lifecycle barrier.');
        if (latestTelemetry[kind] && kind === 'analysis') coalescedAnalysis++;
        latestTelemetry[kind] = envelope;
        scheduleTelemetry();
        return;
      }
      ensure(eventQueue.length < caps.limits.outstandingRequests * 8 &&
        queuedEventBytes + size <= caps.limits.sourceSnapshotBytes, 'Desktop event queue is full.', 'queue_full');
      if (envelope.barrier) {
        lifecycleBarriers++;
        delete latestTelemetry.status; delete latestTelemetry.analysis;
      }
      eventQueue.push({raw:envelope,size}); queuedEventBytes += size;
      if (!drainingEvents) {
        drainingEvents = true;
        void (async () => {
          try {
            while (eventQueue.length && !disposed) {
              const item = eventQueue.shift()!; queuedEventBytes -= item.size;
              try { await onEvent(item.raw); } catch (error) { emitFailure(error); }
              finally {
                if (item.raw.barrier) lifecycleBarriers--;
                scheduleTelemetry();
              }
            }
          } finally { drainingEvents = false; }
        })();
      }
    } catch (error) {
      if (bootstrapping) bootstrapError = error;
      else {
        eventBoundaryFailure = failure('queue_full', 'The native event boundary exceeded its negotiated bounds; restart the workbench.');
        emitFailure(error);
      }
    }
  });
  try {
    const initial = await bridge.invoke<Bootstrap>('workbench_bootstrap', {});
    object(initial); ensure(initial.protocolVersion === 1, 'Unsupported desktop bootstrap protocol.');
    capabilities(initial.capabilities); id(initial.engineEpoch);
    caps = initial.capabilities; engineEpoch = initial.engineEpoch;
    ensure(bytes(initial).length <= caps.limits.frameBytes, 'Bootstrap exceeds its frame limit.', 'too_large');
    if (initial.project !== null) {
      const bootstrapContext: Context = { protocolVersion: 1, requestId: nextOp().requestId,
        project: null, engineEpoch, sourceVersion: null, revision: null };
      const project = await transfer(initial.project, bootstrapContext, () => live(bootstrapContext));
      snapshot(project, caps.limits); setProject(project);
    }
    ensure(Array.isArray(initial.recovery), 'Invalid recovery offers.');
    for (const offer of initial.recovery) { object(offer); id(offer.id); recoveries.set(offer.id, offer); }
    if (bootstrapError) throw bootstrapError;
    // Bootstrap is authoritative for identities; an earlier starting epoch cannot roll it back.
    for (const raw of bootstrapEvents) {
      validateEnvelope(raw);
      if (raw.engineEpoch !== null && raw.engineEpoch !== engineEpoch) continue;
      const nextSequence = u64(raw.sequence);
      if (sequence !== null && nextSequence <= sequence) continue;
      sequence = nextSequence;
      await onEvent(raw);
    }
    bootstrapEvents.length = 0; bootstrapping = false;
  } catch (error) { disposed = true; await unlisten(); throw error; }

  const runtime: WorkbenchRuntime = {
    get capabilities() { return caps; },
    async rebuild(input, op) {
      const captured = snapshots.get(input.snapshot);
      ensure(captured, 'Source snapshot is not retained by this host.', 'stale_request');
      ensure(!activeRebuilds.has(op.requestId), 'Request identity is already in flight.', 'stale_request');
      ensure(activeRebuilds.size < caps.limits.outstandingRequests, 'Desktop request queue is full.', 'queue_full');
      const rebuilding = { snapshot: captured, accepted: false };
      activeRebuilds.set(op.requestId, rebuilding);
      try {
        const result = await request<AcceptedRevision>('runtime.rebuild', input, op, input.base ?? captured, captured.sourceVersion);
        accept(result);
        if (!rebuilding.accepted) retainSnapshot(captured);
        return result;
      } finally { activeRebuilds.delete(op.requestId); }
    },
    async format(input, op) {
      ensure(input.project === currentProject?.project, 'Formatting targets a stale project.', 'stale_request'); integer(input.bufferVersion);
      const result = await request<{ bufferVersion: number; source: string }>('runtime.format', input, op);
      object(result); ensure(result.bufferVersion === input.bufferVersion && typeof result.source === 'string', 'Format response mismatch.'); return result;
    },
    async checkEntries(input, op) {
      const captured = snapshots.get(input.snapshot); ensure(captured, 'Unknown source snapshot.', 'stale_request');
      const scanGeneration = ++entryScanGeneration;
      const result = await request<EntryCheckResult>('runtime.checkEntries', input, op, captured, captured.sourceVersion);
      ensure(scanGeneration === entryScanGeneration, 'A newer source scan replaced this reply.', 'superseded');
      object(result); ensure(result.snapshot === input.snapshot && result.sourceVersion === captured.sourceVersion &&
        Array.isArray(result.entries) && result.entries.length === input.entries.length, 'Entry check context mismatch.');
      for (let index = 0; index < result.entries.length; index++) {
        entryClassification(result.entries[index]);
        ensure(result.entries[index].entry === input.entries[index], 'Entry classification order mismatch.');
      }
      return result;
    },
    async inspect(ref, view, input, op) {
      checkPage(input); const result = await request<InspectionPage>('runtime.inspect', { ref, view, page: input }, op, ref);
      page(result, caps.limits); ensure(sameRef(result.ref, ref) && result.view === view, 'Inspection response mismatch.'); return result;
    },
    async explain(ref, track, query, op) {
      checkPage(query); const result = await request<ExplanationPage>('runtime.explain', { ref, track, query }, op, ref);
      page(result, caps.limits); ensure(sameRef(result.ref, ref), 'Explanation response mismatch.'); return result;
    },
    async location(ref, key, op) {
      const result = await request<SourceLocation | null>('runtime.location', { ref, key }, op, ref);
      if (result !== null) { object(result); id(result.path); for (const number of [result.line, result.column, result.indent, result.width]) integer(number); ensure(typeof result.text === 'string', 'Invalid source location.'); }
      return result;
    },
    async diff(ref, category, input, op) {
      checkPage(input); const result = await request<DiffPage>('runtime.diff', { ref, category, page: input }, op, ref);
      page(result, caps.limits); revisionRef(result.base);
      ensure(sameRef(result.ref, ref) && result.category === category && sameProject(result.base, ref) && result.base.engineEpoch === ref.engineEpoch, 'Diff response mismatch.'); return result;
    },
    async transport(ref, command, op) {
      const beat = (value: number) => { finite(value); ensure(value >= 0 && Number.isSafeInteger(Math.round(value * 960000)), 'Transport beat cannot be represented safely.', 'invalid_source'); };
      if (command.kind === 'seek') beat(command.beat);
      if (command.kind === 'loop' && command.range !== null) { beat(command.range[0]); beat(command.range[1]); ensure(command.range[1] > command.range[0], 'Loop must be half-open and nonempty.', 'invalid_source'); }
      const result = await request<TransportStatus>('runtime.transport', { ref, command }, op, ref);
      status(result, caps.limits);
      const global = ['play','pause','stop','panic'].includes(command.kind);
      ensure(sameRef(result.ref, ref) || (global && sameProject(result.ref, ref) &&
        result.ref.engineEpoch === ref.engineEpoch && result.ref.sourceVersion >= ref.sourceVersion),
        'Transport response mismatch.');
      const generation = u64(result.generation);
      // The reply is an authoritative applied receipt even if newer telemetry or
      // acceptance has already advanced the displayed state. Never recast it as rejection.
      const next = u64(result.sequence);
      if (telemetryRef(result.ref) && (transportGeneration === null || generation > transportGeneration ||
          (generation === transportGeneration && (statusSequence === null || next > statusSequence)))) {
        if (generation !== transportGeneration) { analysisSequence = null; lastAnalysis = null; }
        transportGeneration = generation; statusSequence = next; lastStatus = { kind: 'status', status: result };
      }
      return result;
    },
    async audition(ref, controls, op) { await request('runtime.audition', { ref, controls }, op, ref); },
    async analysis(ref, subscription) {
      ensure(subscription.detailHz <= caps.limits.analysisHz && subscription.meterHz <= caps.limits.statusHz,
        'Analysis cadence exceeds the negotiated budget.', 'resource_budget');
      await request('runtime.analysis', { ref, subscription }, nextOp(), ref);
    },
    async export(ref, spec, op) {
      if (spec.kind === 'wav') { finite(spec.start); finite(spec.end); ensure(spec.start >= 0 && spec.end > spec.start && [44100, 48000, 96000].includes(spec.rate) && [16, 24].includes(spec.bits), 'Invalid WAV export range or format.', 'invalid_source'); }
      const result = await request<ExportResult>('runtime.export', { ref, spec }, op, ref);
      object(result); revisionRef(result.ref); id(result.job);
      ensure(sameRef(result.ref, ref) && typeof result.name === 'string' && typeof result.clipped === 'boolean', 'Export response mismatch.'); return result;
    },
    subscribe(listener) {
      ensure(!disposed && !runtimeDisposed, 'Runtime is disposed.', 'stale_request'); runtimeListeners.add(listener);
      for (const event of [lastEngine, ...reliableBacklog.splice(0), lastStatus, lastAnalysis]) if (event) emit(new Set([listener]), event);
      return () => { runtimeListeners.delete(listener); };
    },
    dispose() {
      if (disposed) return Promise.resolve();
      return runtimeDisposePromise ??= (async () => {
        await request('runtime.dispose', {}); runtimeDisposed = true;
        lastStatus = null; lastAnalysis = null; runtimeListeners.clear();
      })();
    },
  };
  const projects: ProjectStore = {
    chooseFolder: op => projectRequest('project.chooseFolder', {}, op),
    openRecent: (project, op) => requiredProject('project.openRecent', { project }, op),
    async listRecent() {
      const result = await request<RecentProject[]>('project.listRecent', {});
      ensure(Array.isArray(result), 'Invalid recent project list.');
      for (const recent of result) {
        object(recent); id(recent.project);
        ensure(typeof recent.title === 'string' && typeof recent.rootLabel === 'string' &&
          typeof recent.available === 'boolean' && typeof recent.lastOpened === 'string', 'Invalid recent project.');
      }
      return result;
    },
    newProject: (settings, op) => requiredProject('project.newProject', { settings }, op),
    importProject: (input, op) => projectRequest('project.importProject', { input }, op),
    trustAndRun: (input, op) => projectRequest('project.trustAndRun', {input}, op, input.project),
    async readLibraryDocument(input, op) {
      const result = await request<{ id: string; path: string; text: string; kind: 'source' | 'document' | 'text' }>('project.readLibraryDocument', { input }, op, input.project);
      object(result); ensure(result.id === input.id && typeof result.path === 'string' && typeof result.text === 'string' && ['source', 'document', 'text'].includes(result.kind), 'Invalid library document.'); return result;
    },
    async resolveSourceDocument(input, op) {
      ensure(sameProject(input.project, currentProject), 'Source navigation targets a stale project.', 'stale_request');
      id(input.path);
      const result = await request<ResolvedSourceDocument | null>('project.resolveSourceDocument', { input }, op, input.project);
      if (result === null) return null;
      object(result); id(result.path);
      if (result.kind === 'project') {
        id(result.fileId);
        ensure(lastProject?.kind === 'changed' && lastProject.snapshot.files.some(file => !file.deleted && file.id === result.fileId && file.path === result.path),
          'Resolved source is not an existing canonical project buffer.', 'stale_request');
      } else {
        ensure(result.kind === 'library', 'Invalid resolved source kind.');
        id(result.id);
        ensure(typeof result.text === 'string' && ['source', 'document', 'text'].includes(result.documentKind),
          'Invalid resolved library document.');
      }
      return result;
    },
    async save(input, op) {
      const result = await request<SaveResult>('project.save', { input }, op, input);
      validateSave(result, caps.limits); return result;
    },
    refresh: (input, op) => requiredProject('project.refresh', { input }, op, input, input.sourceVersion),
    resolveConflict: (input, op) => requiredProject('project.resolveConflict', { input }, op, input),
    async snapshotSources(input, op) {
      const result = await request<SourceSnapshot>('project.snapshotSources', { input }, op, input, input.sourceVersion);
      object(result); id(result.id); projectRef(result); u64(result.diskGeneration);
      ensure(sameProject(result, input) && result.sourceVersion === input.sourceVersion && result.entry === input.entry && Array.isArray(result.files), 'Source snapshot context mismatch.');
      if (!snapshots.has(result.id) && snapshots.size >= MAX_RETAINED_SOURCE_SNAPSHOTS) {
        for (const key of snapshots.keys()) {
          if (key === retainedSnapshot || key === previousSnapshot) continue;
          snapshots.delete(key); break;
        }
      }
      // Consumers receive the descriptor; requests need only its identity/version.
      snapshots.set(result.id, { id: result.id, project: result.project, epoch: result.epoch, sourceVersion: result.sourceVersion });
      currentSourceVersion = Math.max(currentSourceVersion ?? 0, input.sourceVersion);
      return result;
    },
    async persistRecovery(input, op) {
      await request('project.persistRecovery', { input }, op, input, input.sourceVersion);
      currentSourceVersion = Math.max(currentSourceVersion ?? 0, input.sourceVersion);
    },
    async restoreRecovery(input, op) {
      const result = await projectRequest('project.restoreRecovery', { input }, op);
      recoveries.delete(input.id); return result;
    },
    async exportArchive(input, op) {
      const result = await request<ArchiveResult>('project.exportArchive', { input }, op, input, input.sourceVersion);
      object(result); ensure(typeof result.name === 'string' && Array.isArray(result.linkedResources), 'Invalid archive outcome.');
      return result;
    },
    async reveal(input, op) { await request('project.reveal', { input }, op, input); },
    async prepareClose(input, op) {
      const result = await request<CloseResult>('project.prepareClose', { input }, op, input.capture, input.capture.sourceVersion);
      object(result); ensure(typeof result.allowed === 'boolean', 'Invalid close reply.');
      if (result.token !== null) id(result.token);
      if (result.save !== null) validateSave(result.save, caps.limits);
      if (result.failure !== null) validateFailure(result.failure);
      closePermission = result.allowed && result.token !== null
        ? { token: result.token, project: { project: input.capture.project, epoch: input.capture.epoch }, reason: input.reason }
        : null;
      if (input.ticket && lastClose?.kind === 'closeRequested' && lastClose.ticket === input.ticket) lastClose = null;
      return result;
    },
    async close(input, op) {
      ensure(closePermission !== null && closePermission.token === input.token &&
        sameProject(closePermission.project, input), 'Close permission is stale or belongs to another project.', 'stale_request');
      const permission = closePermission;
      await request('project.close', { input }, op, input);
      closePermission = null;
      // Replacement consumes permission, not the workspace. A chooser may still cancel.
      if (permission.reason === 'replaceProject') return;
      currentProject = null; currentSourceVersion = null; currentRevision = null; transportGeneration = null; statusSequence = null; analysisSequence = null;
      clearSnapshots(); lastProject = null; lastStatus = null; lastAnalysis = null;
    },
    subscribe(listener) {
      ensure(!disposed, 'Host is disposed.', 'stale_request'); projectListeners.add(listener);
      if (lastProject) emit(new Set([listener]), lastProject);
      if (recoveries.size) emit(new Set([listener]), { kind: 'recovery', offers: [...recoveries.values()] });
      return () => { projectListeners.delete(listener); };
    },
  };
  return {
    runtime, projects,
    preferences: {
      async load() {
        await preferencesQueue;
        return request('preferences.load', {});
      },
      save(value) {
        const captured = structuredClone(value);
        const saving = preferencesQueue.then(async () => { await request('preferences.save', { value: captured }); });
        preferencesQueue = saving.catch(() => {});
        return saving;
      },
    },
    subscribe(listener) {
      ensure(!disposed, 'Host is disposed.', 'stale_request'); hostListeners.add(listener);
      if (lastClose) emit(new Set([listener]), lastClose);
      if (lastPreferencesFailure) emit(new Set([listener]), lastPreferencesFailure);
      return () => { hostListeners.delete(listener); };
    },
    async restartEngine(op) {
      const previousEpoch = engineEpoch;
      const result = await request<AcceptedRevision | null>('host.restartEngine', {}, op);
      if (result !== null) {
        accepted(result, caps.limits);
        ensure(result.ref.engineEpoch !== previousEpoch, 'Restart returned an old engine revision.', 'stale_revision');
        if (engineEpoch !== result.ref.engineEpoch) {
          retiredEngines.add(engineEpoch); engineEpoch = result.ref.engineEpoch;
        }
        engineReady = true; runtimeDisposed = false; runtimeDisposePromise = undefined; accept(result);
      }
      if (result === null) {
        // A restart without retained sources still changes the engine identity.
        // Reconcile via the same bootstrap command if its ready event is delayed.
        if (engineEpoch === previousEpoch) {
          const fresh = await bridge.invoke<Bootstrap>('workbench_bootstrap', {});
          object(fresh); ensure(fresh.protocolVersion === 1, 'Unsupported restart bootstrap.');
          capabilities(fresh.capabilities); id(fresh.engineEpoch);
          ensure(fresh.engineEpoch !== previousEpoch, 'Restart did not establish a fresh engine epoch.');
          retiredEngines.add(engineEpoch); engineEpoch = fresh.engineEpoch; caps = fresh.capabilities;
          if (fresh.project !== null) {
            const ctx: Context = { protocolVersion: 1, requestId: nextOp().requestId,
              project: null, engineEpoch, sourceVersion: null, revision: null };
            const retained = await transfer(fresh.project, ctx, () => ensure(!disposed, 'Host is disposed.', 'stale_request'));
            snapshot(retained, caps.limits); setProject(retained);
          }
        }
        currentRevision = null; transportGeneration = null; statusSequence = null; analysisSequence = null;
        lastStatus = null; lastAnalysis = null; engineReady = true;
        runtimeDisposed = false; runtimeDisposePromise = undefined;
      }
      return result;
    },
    async openExternal(url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw failure('denied_path', 'External links must be absolute HTTP(S) URLs.'); }
      ensure(parsed.protocol === 'http:' || parsed.protocol === 'https:', 'Only HTTP(S) external links are allowed.', 'denied_path');
      await request('host.openExternal', { url: parsed.href });
    },
    dispose() {
      return disposePromise ??= (async () => {
        try { await preferencesQueue; await request('host.dispose', {}); }
        finally {
          disposed = true; runtimeDisposed = true;
          await unlisten();
          runtimeListeners.clear(); projectListeners.clear(); hostListeners.clear();
          clearSnapshots(); recoveries.clear(); reliableBacklog.length = 0;
          eventQueue.length = 0; queuedEventBytes = 0;
          delete latestTelemetry.status; delete latestTelemetry.analysis;
        }
      })();
    },
  };
}
