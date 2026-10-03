// Shared workbench boundary. Native wire counters and identities stay lossless.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type U64 = string;
export type ProjectId = string;
export type ProjectEpoch = string;
export type EngineEpoch = string;
export type RevisionId = string;
export type RequestId = string;
export type DiskVersion = string;
export type SourceSnapshotId = string;
export type FileId = string;
export type ResourceId = string;
export type JobId = string;
export type ProjectRef = { project: ProjectId; epoch: ProjectEpoch };
export type RevisionRef = ProjectRef & {
  engineEpoch: EngineEpoch; revision: RevisionId; sourceVersion: number; entry: string;
};
export type Operation = { requestId: RequestId; signal?: AbortSignal };
export type SourceLocation = {
  path: string; line: number; column: number; text: string; indent: number; width: number;
};
export type AttemptedAction = 'rebuild'|'classifyEntries'|'format'|'play'|'pause'|'stop'|
  'restart'|'panic'|'seek'|'loop'|'audition'|'analysis'|'inspect'|'export'|
  'save'|'refresh'|'openProject'|'importProject'|'trustAndRun'|'recovery'|'restartEngine'|'project';
export type OperationContext = {
  action: AttemptedAction; requestId: RequestId; ref: RevisionRef|null;
  outcome: 'applied'|'rejected'|'cancelled'|'superseded'|'unknown'|'partial';
  continuity: Failure['continuity']; phase: Failure['phase'];
  expectedRuntimeRevision: U64|null; actualRuntimeRevision: U64|null;
};
export type Failure = {
  code: string;
  phase: 'project'|'compile'|'prepare'|'apply'|'transport'|'inspect'|'export'|'engine';
  message: string; help?: string[]; location?: SourceLocation;
  callers?: SourceLocation[]; path?: string; requestId?: RequestId;
  revision?: RevisionId; continuity: 'preserved'|'lost'|'not-started';
  operation?: OperationContext;
  runtime?: {code:string;expectedRevision:U64|null;observedRevision:U64|null};
};
export type Availability = { available: boolean; reason: string|null };
export type HostLimits = {
  frameBytes: number; sourceChunkBytes: number; sourceDocumentBytes: number;
  sourceSnapshotBytes: number; outstandingRequests: number; preparingCandidates: number;
  queuedCandidates: number; inspectionRows: number; inspectionBytes: number;
  statusHz: number; analysisHz: number; waveformSamples: number; spectrumBins: number;
  trackMeters: number; analysisBytes: number; exportWorkers: number; exportQueue: number;
  playableSnapshotBytes: number;
};
export type AudioConfiguration = {
  backend: string; device: string|null; sampleRate: number; channels: number;
  requestedPeriodFrames: number|null; periodFrames: number|null;
};
export type HostCapabilities = {
  environment: 'web'|'desktop'; platform: string; coreRevision: string;
  protocolVersion: 1; nativePluginFormats: ('clap'|'vst3')[];
  audio: Availability & { configuration: AudioConfiguration|null };
  filesystem: { folder: Availability; watch: Availability; reveal: Availability;
    recovery: Availability; nativeDialogs: Availability };
  pluginConfig: { label: string; resource: ResourceId|null }|null;
  limits: HostLimits;
};
export type ThemeId = 'light'|'dark'|'soft-light'|'soft-dark';
export type WorkbenchPreferences = {
  version: 1; theme: ThemeId;
  layout: { explorer: boolean; source: boolean; visualization: boolean;
    inspector: boolean; sourceFraction: number };
};
export interface PreferencesStore {
  load(): Promise<unknown|null>;
  save(value: WorkbenchPreferences): Promise<void>;
}
export type PageRequest = {
  offset?: number; limit?: number; track?: string;
  start_tick?: U64; end_tick?: U64;
};
export type InspectionView = 'summary'|'graph'|'patches'|'patch_nodes'|'patch_detail'|
  'performance'|'performance_overview'|'automation'|'automation_points'|
  'sections'|'track_groups'|'locations'|'score'|'diagnostics';
export type DiffCategory = 'notes'|'metadata'|'occurrences'|'controllers'|'messages'|
  'tempos'|'performed'|'consequences';
export type RowPage = { rows: Json[]; total: number; next: number|null };
export type InspectionPage = RowPage & { ref: RevisionRef; view: InspectionView };
export type ExplanationPage = RowPage & { ref: RevisionRef };
export type DiffPage = RowPage & { ref: RevisionRef; base: RevisionRef; category: DiffCategory };
export type TransportCommand =
  { kind: 'play'|'pause'|'stop'|'restart'|'panic' } |
  { kind: 'seek'; beat: number } | { kind: 'loop'; range: [number,number]|null };
export type TrackMeter = { track: string; peak: number; rms: number };
export type TransportStatus = {
  ref: RevisionRef; generation: U64; sequence: U64; playing: boolean; finished: boolean;
  beat: number; seconds: number; bpm: number; meter: [number,number];
  duration: number; endBeat: number; tail: number; loop: [number,number]|null;
  peak: number; rms: number; meters: TrackMeter[];
  audio: AudioConfiguration; health: JsonObject;
};
export type AnalysisSubscription = {
  source: string|null; detail: boolean; meters: boolean; detailHz: number; meterHz: number;
};
export type AnalysisFrame = {
  ref: RevisionRef; generation: U64; sequence: U64; source: string|null;
  sampleRate: number; captureSeconds: number; waveform: number[]; spectrum: number[];
  /** Peak/RMS describe the same selected unwindowed mono history, not master meters. */
  meters: TrackMeter[]; peak: number; rms: number; dropped: U64;
  /** Warmup carries no measured waveform/spectrum; it retires previously presented detail. */
  captureId: U64; windowEndSample: U64|null; sampleCount: number; warmup: boolean;
  window: 'hann'|'blackman'; smoothing: number;
  metersPresent: boolean; meterWindowEndSample: U64|null;
};
export type AcceptedRevision = {
  ref: RevisionRef; status: TransportStatus; effect: Json;
  initialPages: Record<'summary'|'graph'|'sections'|'track_groups'|'locations'|'diagnostics',InspectionPage>;
  exportTracks: { id: string; name: string; midi: boolean }[];
};
export type EntryClassification = {
  entry: string; kind: 'song'|'non-song'|'unresolved'; description?: string;
  readiness: {kind: 'unchecked'|'validated'}|{kind: 'blocked'; failure: Failure};
  failure: Failure|null;
};
export type EntryCheckResult = {
  snapshot: SourceSnapshotId; sourceVersion: number; entries: EntryClassification[];
};
export type ExportSpec =
  { kind: 'masterWav' } |
  { kind: 'wav'; tracks: string[]; rate: 44100|48000|96000; bits: 16|24;
    start: number; end: number } |
  { kind: 'midi'; tracks: string[] };
export type ExportResult = { job: JobId; ref: RevisionRef; name: string; clipped: boolean };
export type RuntimeEvent =
  { kind: 'build'; requestId: RequestId; project: ProjectRef; sourceVersion: number;
    phase: 'queued'|'compiling'|'preparing'|'applying'|'accepted'|'rejected'|'cancelled';
    ref: RevisionRef|null; failure: Failure|null } |
  { kind: 'entries'; requestId: RequestId; snapshot: SourceSnapshotId; done: number; total: number;
    currentEntry: string|null; result: EntryClassification|null } |
  { kind: 'status'; status: TransportStatus } |
  { kind: 'analysis'; frame: AnalysisFrame } |
  { kind: 'exportProgress'; requestId: RequestId; job: JobId; ref: RevisionRef;
    phase: 'queued'|'preparing'|'rendering'|'publishing'; progress: number|null } |
  { kind: 'failure'; failure: Failure } |
  { kind: 'engine'; state: 'starting'|'ready'|'failed'|'stopped'; engineEpoch: EngineEpoch;
    capabilities: HostCapabilities; failure: Failure|null };
export interface WorkbenchRuntime {
  readonly capabilities: HostCapabilities;
  rebuild(input: {snapshot: SourceSnapshotId; base: RevisionRef|null}, op: Operation): Promise<AcceptedRevision>;
  format(input: {project: ProjectId; path: string; bufferVersion: number; source: string}, op: Operation): Promise<{bufferVersion: number; source: string}>;
  checkEntries(input: {snapshot: SourceSnapshotId; entries: string[]}, op: Operation): Promise<EntryCheckResult>;
  inspect(ref: RevisionRef, view: InspectionView, page: PageRequest, op: Operation): Promise<InspectionPage>;
  explain(ref: RevisionRef, track: string, query: {key?: string; offset: number; limit: number}, op: Operation): Promise<ExplanationPage>;
  location(ref: RevisionRef, key: string, op: Operation): Promise<SourceLocation|null>;
  diff(ref: RevisionRef, category: DiffCategory, page: PageRequest, op: Operation): Promise<DiffPage>;
  transport(ref: RevisionRef, command: TransportCommand, op: Operation): Promise<TransportStatus>;
  audition(ref: RevisionRef, controls: {muted: string[]; solo: string[]}, op: Operation): Promise<void>;
  analysis(ref: RevisionRef, subscription: AnalysisSubscription): Promise<void>;
  export(ref: RevisionRef, spec: ExportSpec, op: Operation): Promise<ExportResult>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}

export type ProjectSettings = { title: string; entry: string; entries?: string[] };
export type ProjectFile = {
  id: FileId; path: string; kind: 'source'|'document'|'text'; readOnly: boolean;
  bufferVersion: number; diskVersion: DiskVersion|null; text: string;
  dirty: boolean; deleted: boolean;
};
export type ResourceDescriptor = {
  id: ResourceId; path: string; kind: 'midi'|'wav'|'flac'|'sample'|'plugin'|'library'|'config';
  version: string|null; byteLength: number|null; linked: boolean; availability: Availability;
};
export type SourceConflict = {
  fileId: FileId; path: string; base: string|null; local: string|null; disk: string|null;
  baseVersion: DiskVersion|null; diskVersion: DiskVersion|null; bufferVersion: number;
};
export type ProjectSnapshot = ProjectRef & {
  title: string; entry: string; entries: string[]; sourceVersion: number;
  diskGeneration: U64; settingsDiskVersion: DiskVersion|null;
  files: ProjectFile[]; resources: ResourceDescriptor[]; conflicts: SourceConflict[];
  dirty: boolean; rootLabel: string|null;
  execution: {trusted: boolean; policy: 'account-native'|'preview'|'sandbox'};
  gist?: string; // Normalized ID[/revision] provenance, separate from source settings.
};
export type BufferCapture = {
  fileId: FileId; path: string; text: string|null; bufferVersion: number;
  expectedDiskVersion: DiskVersion|null;
};
export type WorkingCapture = ProjectRef & {
  sourceVersion: number; entry: string; expectedDiskGeneration: U64;
  buffers: BufferCapture[]; settings: ProjectSettings;
  settingsDiskVersion: DiskVersion|null;
};
export type SourceSnapshot = {
  id: SourceSnapshotId; project: ProjectId; epoch: ProjectEpoch;
  sourceVersion: number; entry: string; diskGeneration: U64;
  files: {fileId: FileId; path: string; bufferVersion: number; diskVersion: DiskVersion|null}[];
};
export type SaveInput = ProjectRef & {
  files: BufferCapture[]; settings: ProjectSettings; settingsDiskVersion: DiskVersion|null;
};
export type SavedFile = {fileId: FileId; bufferVersion: number; diskVersion: DiskVersion|null};
export type SaveResult = {
  saved: SavedFile[]; conflicts: SourceConflict[];
  failures: {fileId: FileId|null; failure: Failure}[];
  settingsDiskVersion: DiskVersion|null; settingsSaved: boolean; diskGeneration: U64;
};
export type RecentProject = {project: ProjectId; title: string; rootLabel: string; available: boolean; lastOpened: string};
export type ImportedProject = {
  settings: ProjectSettings; files: {path: string; text: string}[];
  assets: {path: string; format: 'midi'|'wav'|'flac'; base64: string}[];
  gist?: string; // Normalized ID[/revision] provenance, separate from source settings.
};
export type ImportInput = {kind: 'content'; project: ImportedProject} | {kind: 'zipDialog'};
export type RecoveryOffer = {id: string; project: ProjectId; title: string; rootLabel: string|null; updatedAt: string};
export type CloseReason = 'replaceProject'|'closeProject'|'closeWindow'|'quit';
export type CloseInput = {
  capture: WorkingCapture; reason: CloseReason; decision: 'save'|'discard'|'cancel';
  cancelExports: boolean; ticket: string|null;
};
export type CloseResult = {allowed: boolean; token: string|null; save: SaveResult|null; failure: Failure|null};
export type ArchiveResult = {name: string; linkedResources: ResourceDescriptor[]};
export type ResolvedSourceDocument =
  {kind: 'project'; path: string; fileId: FileId} |
  {kind: 'library'; id: string; path: string; text: string; documentKind: 'source'|'document'|'text'};
export type ProjectEvent =
  {kind: 'changed'; snapshot: ProjectSnapshot; reason: 'disk'|'save'|'conflict'|'recovery'} |
  {kind: 'watch'; project: ProjectRef; state: 'ready'|'degraded'|'rootMissing'; failure: Failure|null} |
  {kind: 'recovery'; offer: RecoveryOffer} |
  {kind: 'failure'; project: ProjectRef|null; failure: Failure};
export interface ProjectStore {
  chooseFolder(op: Operation): Promise<ProjectSnapshot|null>;
  openRecent(project: ProjectId, op: Operation): Promise<ProjectSnapshot>;
  listRecent(): Promise<RecentProject[]>;
  newProject(settings: ProjectSettings, op: Operation): Promise<ProjectSnapshot>;
  importProject(input: ImportInput, op: Operation): Promise<ProjectSnapshot|null>;
  trustAndRun(input: {project: ProjectRef}, op: Operation): Promise<ProjectSnapshot|null>;
  readLibraryDocument(input: {project: ProjectRef|null; id: string}, op: Operation): Promise<{id: string; path: string; text: string; kind: 'source'|'document'|'text'}>;
  resolveSourceDocument(input: {project: ProjectRef; path: string}, op: Operation): Promise<ResolvedSourceDocument|null>;
  save(input: SaveInput, op: Operation): Promise<SaveResult>;
  refresh(input: WorkingCapture, op: Operation): Promise<ProjectSnapshot>;
  resolveConflict(input: ProjectRef & {fileId: FileId; diskVersion: DiskVersion|null; choice: 'disk'|'local'|'merge'; mergedText?: string}, op: Operation): Promise<ProjectSnapshot>;
  snapshotSources(input: WorkingCapture, op: Operation): Promise<SourceSnapshot>;
  persistRecovery(input: WorkingCapture, op: Operation): Promise<void>;
  restoreRecovery(input: {id: string; action: 'restore'|'discard'}, op: Operation): Promise<ProjectSnapshot|null>;
  exportArchive(input: WorkingCapture, op: Operation): Promise<ArchiveResult>;
  reveal(input: ProjectRef & {id: FileId|ResourceId|null}, op: Operation): Promise<void>;
  prepareClose(input: CloseInput, op: Operation): Promise<CloseResult>;
  close(input: ProjectRef & {token: string}, op: Operation): Promise<void>;
  subscribe(listener: (event: ProjectEvent) => void): () => void;
}
export type HostEvent =
  {kind: 'closeRequested'; ticket: string; reason: CloseReason} |
  {kind: 'preferencesFailure'; failure: Failure};
export interface WorkbenchHost {
  runtime: WorkbenchRuntime; projects: ProjectStore; preferences: PreferencesStore;
  subscribe(listener: (event: HostEvent) => void): () => void;
  restartEngine(op: Operation): Promise<AcceptedRevision|null>;
  openExternal(url: string): Promise<void>;
  dispose(): Promise<void>;
}

