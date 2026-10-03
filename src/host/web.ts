import { AudioPlayer, Compiler } from "../audio";
import { WebProjectStore } from "./web-projects";
import { WebPreferencesStore } from "./web-preferences";
import type {
  AcceptedRevision, AnalysisFrame, AnalysisSubscription, AttemptedAction, AudioConfiguration, DiffCategory, DiffPage,
  EntryCheckResult, ExplanationPage, ExportResult, ExportSpec, Failure,
  HostCapabilities, HostEvent, InspectionPage, InspectionView, Json, Operation,
  PageRequest, RevisionRef, RuntimeEvent, SourceLocation, SourceSnapshot, TransportCommand,
  TransportStatus, WorkbenchHost, WorkbenchRuntime,
} from "./contracts";

const INITIAL_VIEWS = ["summary", "graph", "sections", "track_groups", "locations", "diagnostics"] as const;
const encoder = new TextEncoder();

export function sameRevision(a: RevisionRef, b: RevisionRef): boolean {
  return a.project === b.project && a.epoch === b.epoch && a.engineEpoch === b.engineEpoch &&
    a.revision === b.revision && a.sourceVersion === b.sourceVersion && a.entry === b.entry;
}

function isSourceLocation(value: unknown): value is SourceLocation {
  if (typeof value !== "object" || value === null) return false;
  return "path" in value && typeof value.path === "string" &&
    "text" in value && typeof value.text === "string" &&
    "line" in value && typeof value.line === "number" && Number.isSafeInteger(value.line) &&
    "column" in value && typeof value.column === "number" && Number.isSafeInteger(value.column) &&
    "indent" in value && typeof value.indent === "number" && Number.isSafeInteger(value.indent) &&
    "width" in value && typeof value.width === "number" && Number.isSafeInteger(value.width);
}
export function hostFailure(error: unknown, phase: Failure["phase"], continuity: Failure["continuity"] = "preserved"): Error & Failure {
  const diagnostic = typeof error === "object" && error !== null && "diagnostic" in error
    ? error.diagnostic : error;
  const value = typeof diagnostic === "object" && diagnostic !== null ? diagnostic : {};
  const message = "message" in value && typeof value.message === "string" ? value.message : String(error);
  const phases: Failure["phase"][] = ["project", "compile", "prepare", "apply", "transport", "inspect", "export", "engine"];
  const inheritedPhase = "phase" in value ? phases.find((candidate) => candidate === value.phase) : undefined;
  const inheritedContinuity = "continuity" in value &&
    (value.continuity === "preserved" || value.continuity === "lost" || value.continuity === "not-started")
    ? value.continuity : continuity;
  const failure: Failure = {
    code: "code" in value && typeof value.code === "string" ? value.code : "invalid_source",
    phase: inheritedPhase ?? phase, continuity: inheritedContinuity, message,
  };
  if ("help" in value && Array.isArray(value.help)) failure.help = value.help.filter((item): item is string => typeof item === "string");
  if ("location" in value && isSourceLocation(value.location)) failure.location = value.location;
  if ("callers" in value && Array.isArray(value.callers)) failure.callers = value.callers.filter(isSourceLocation);
  if ("path" in value && typeof value.path === "string") failure.path = value.path;
  if ("requestId" in value && typeof value.requestId === "string") failure.requestId = value.requestId;
  if ("revision" in value && typeof value.revision === "string") failure.revision = value.revision;
  if ("operation" in value && value.operation && typeof value.operation === "object")
    failure.operation = value.operation as Failure["operation"];
  if ("runtime" in value && value.runtime && typeof value.runtime === "object")
    failure.runtime = value.runtime as Failure["runtime"];
  return Object.assign(new Error(message), failure);
}
function fail(code: string, message: string, phase: Failure["phase"]): never {
  throw Object.assign(new Error(message), {code, phase});
}
function cancelled(op: Operation, phase: Failure["phase"]) {
  if (op.signal?.aborted) fail("cancelled", "Operation cancelled.", phase);
}

/** Convert only numeric WASM envelope fields; opaque public identities never go through Number. */
export function webPageRequest(page: PageRequest): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const field of ["offset", "limit"] as const) {
    const value = page[field];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0 || (field === "limit" && value > 1000))
        fail("resource_budget", "Inspection page is outside the supported row budget.", "inspect");
      result[field] = value;
    }
  }
  if (page.track !== undefined) result.track = page.track;
  for (const field of ["start_tick", "end_tick"] as const) {
    const value = page[field];
    if (value === undefined) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
      fail("resource_budget", "Tick cannot be represented losslessly by the browser engine.", "inspect");
    result[field] = Number(value);
  }
  return result;
}

type BrowserTrack = { id: string; name?: string; source: { kind: string } };
type BrowserSnapshot = {
  description: { tracks: BrowserTrack[]; extras?: { tail?: number } };
  [key: string]: unknown;
};
type BrowserStatus = {
  revision?: number; done?: boolean; finished?: boolean; beat?: number; seconds?: number;
  bpm?: number; meter?: [number, number]; duration?: number; endBeat?: number; tail?: number;
  peak?: number; rms?: number; latencyFrames?: number; underruns?: number; buffered?: number;
  effect?: Json; meters?: { id?: string; track?: string; peak: number; rms?: number }[];
};
type BrowserPage = { revision: number; rows: Json[]; total: number; next?: number | null };
type BrowserAsset = { path: string; version: string; bytes: Uint8Array };
type Retained = {
  accepted: AcceptedRevision; compilerRevision: number; audioRevision: number;
  snapshot: BrowserSnapshot; assets: BrowserAsset[]; sourceSnapshot: string; title: string;
};
type BuildJob = {
  input: { snapshot: string; base: RevisionRef | null }; op: Operation;
  source: SourceSnapshot; recovery: boolean;
  resolve: (value: AcceptedRevision) => void; reject: (error: unknown) => void;
};

export class WebRuntime implements WorkbenchRuntime {
  readonly capabilities: HostCapabilities;
  private compiler = new Compiler();
  private utilityCompiler = new Compiler();
  private player = new AudioPlayer();
  private engineEpoch = crypto.randomUUID();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private current?: Retained;
  private previous?: Retained;
  private building = false;
  private queued?: BuildJob;
  private buildPromise?: Promise<void>;
  private restartSnapshot?: string;
  private recoveryRequest?: string;
  private activeRequests = new Set<string>();
  private exports = new Map<string, { worker: Worker; cancel: () => void }>();
  private utilityTail: Promise<unknown> = Promise.resolve();
  private controls: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private failed = false;
  private engineFailure: Failure | null = null;
  private resetting = false;
  private generation = 0n;
  private statusSequence = 0n;
  private analysisSequence = 0n;
  private analysisEnabled = false;
  private analysisMeters = true;
  private analysisHz = 30;
  private meterHz = 20;
  private nextStatusPublication = 0;
  private scanGeneration = 0;
  private scanActive = false;
  private queuedScan?: {start:()=>void; supersede:()=>void};
  private analysisSource: string | null = null;
  private timer: number;
  private nextAnalysisPublication = 0;
  private latestPosition?: BrowserStatus;
  private projects: WebProjectStore;

  constructor(projects: WebProjectStore, coreRevision: string) {
    this.projects = projects;
    const unavailable = (reason: string) => ({ available: false, reason });
    this.capabilities = {
      environment: "web", platform: navigator.platform, coreRevision, protocolVersion: 1,
      nativePluginFormats: [],
      audio: typeof AudioContext === "undefined" ? { ...unavailable("Web Audio is unavailable in this browser."), configuration: null }
        : { available: true, reason: null, configuration: null },
      filesystem: {
        folder: "showDirectoryPicker" in globalThis ? { available: true, reason: null }
          : unavailable("This browser cannot connect folders; import or export a ZIP instead."),
        watch: unavailable("Browser folders require explicit refresh."),
        reveal: unavailable("Browsers cannot reveal filesystem entries."),
        recovery: { available: true, reason: null },
        nativeDialogs: unavailable("Native dialogs require the desktop application."),
      },
      pluginConfig: null,
      limits: { frameBytes: 2 * 1024 * 1024, sourceChunkBytes: 256 * 1024,
        sourceDocumentBytes: 8 * 1024 * 1024, sourceSnapshotBytes: 64 * 1024 * 1024,
        outstandingRequests: 64, preparingCandidates: 1, queuedCandidates: 1,
        inspectionRows: 1000, inspectionBytes: 1024 * 1024,
        statusHz: 20, analysisHz: 30, waveformSamples: 2048, spectrumBins: 1025,
        trackMeters: 1000, analysisBytes: 128 * 1024,
        exportWorkers: 2, exportQueue: 0, playableSnapshotBytes: 256 * 1024 * 1024 },
    };
    this.player.onPosition = (value) => {
      if (this.current && (value.revision === undefined || value.revision === this.current.audioRevision))
        this.latestPosition = value;
    };
    this.player.onAnalysisInvalidated = captureId => {
      if (!this.current || !this.analysisEnabled || this.stopped || this.failed) return;
      const status = this.current.accepted.status;
      this.emit({ kind: "analysis", frame: {
        ref: status.ref, generation: status.generation, sequence: String(++this.analysisSequence),
        source: this.analysisSource, sampleRate: status.audio.sampleRate,
        captureSeconds: this.player.context?.currentTime ?? 0, captureId,
        windowEndSample: null, sampleCount: 2048, warmup: true, window: "blackman", smoothing: 0,
        waveform: [], spectrum: [], peak: 0, rms: 0, dropped: "0",
        meters: [], metersPresent: false, meterWindowEndSample: null,
      } });
    };
    this.player.onPlaying = () => {
      if (this.current) {
        this.current.accepted.status = this.status(this.current.accepted.ref, this.latestPosition ?? this.current.accepted.status);
        this.emit({ kind: "status", status: this.current.accepted.status });
      }
    };
    this.player.onError = (error) => {
      this.failed = true;
      const failure = hostFailure(error, "engine", "lost");
      this.engineFailure = failure;
      this.emit({ kind: "engine", state: "failed", engineEpoch: this.engineEpoch, capabilities: this.capabilities, failure });
    };
    this.compiler.onFailure = this.utilityCompiler.onFailure = (message) => {
      this.failed = true;
      const failure = hostFailure({ code: "child_died", message }, "engine", this.current ? "preserved" : "not-started");
      this.engineFailure = failure;
      this.emit({ kind: "engine", state: "failed", engineEpoch: this.engineEpoch, capabilities: this.capabilities, failure });
    };
    this.timer = setInterval(() => this.observe(), 1000 / 30);
  }
  private emit(event: RuntimeEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error("Workbench event listener failed", error); }
    }
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    listener({ kind: "engine", state: this.failed ? "failed" : this.stopped ? "stopped" : "ready",
      engineEpoch: this.engineEpoch, capabilities: this.capabilities, failure: this.engineFailure });
    return () => { this.listeners.delete(listener); };
  }
  private async operation<T>(op: Operation, phase: Failure["phase"], action: () => Promise<T>,
    attempted: AttemptedAction = phase === "compile" ? "rebuild" : phase === "transport" ? "audition" : phase === "export" ? "export" : "inspect",
    ref: RevisionRef|null = null): Promise<T> {
    try {
      cancelled(op, phase);
      if (this.stopped) fail("child_died", "Runtime has been disposed.", "engine");
      if (this.failed) fail("child_died", "Restart the engine before issuing another runtime operation.", "engine");
      if (!op.requestId || this.activeRequests.has(op.requestId)) fail("stale_request", "Request identity is already active.", phase);
      if (this.activeRequests.size >= this.capabilities.limits.outstandingRequests) fail("queue_full", "Too many runtime operations.", phase);
      this.activeRequests.add(op.requestId);
      try { return await action(); } finally { this.activeRequests.delete(op.requestId); }
    } catch (error) {
      const failure = hostFailure(error, phase, this.current ? "preserved" : "not-started");
      failure.requestId = op.requestId;
      failure.operation ??= { action: attempted, requestId: op.requestId, ref,
        outcome: failure.code === "cancelled" ? "cancelled" : failure.code === "superseded" ? "superseded" : failure.continuity === "lost" ? "unknown" : "rejected",
        continuity: failure.continuity, phase: failure.phase, expectedRuntimeRevision: null, actualRuntimeRevision: null };
      throw failure;
    }
  }
  private retained(ref: RevisionRef, currentOnly = false): Retained {
    const retained = [this.current, ...(currentOnly ? [] : [this.previous])]
      .find((value) => value && sameRevision(value.accepted.ref, ref));
    if (!retained) fail(ref.engineEpoch !== this.engineEpoch ? "stale_revision" : "expired_revision", "Revision is no longer retained by this engine.", "inspect");
    return retained;
  }
  private audioConfiguration(): AudioConfiguration {
    return { backend: "Web Audio", device: null, sampleRate: this.player.context!.sampleRate,
      channels: 2, requestedPeriodFrames: null, periodFrames: 128 };
  }
  private status(ref: RevisionRef, raw: BrowserStatus): TransportStatus {
    const prior = this.current?.accepted.status;
    const playing = this.player.playing;
    const meters = (this.analysisMeters ? raw.meters ?? prior?.meters ?? [] : []).map((meter) => ({
      track: meter.track ?? ("id" in meter ? meter.id! : ""), peak: playing ? meter.peak : 0, rms: playing ? (meter.rms ?? 0) : 0,
    }));
    return { ref, generation: String(this.generation), sequence: String(++this.statusSequence), playing,
      finished: raw.done ?? raw.finished ?? false, beat: raw.beat ?? 0, seconds: raw.seconds ?? 0,
      bpm: raw.bpm ?? prior?.bpm ?? 120, meter: raw.meter ?? prior?.meter ?? [4, 4],
      duration: raw.duration ?? prior?.duration ?? 0, endBeat: raw.endBeat ?? prior?.endBeat ?? 0,
      tail: raw.tail ?? prior?.tail ?? 0, loop: this.player.loop,
      peak: playing ? raw.peak ?? 0 : 0, rms: playing ? raw.rms ?? 0 : 0,
      meters, audio: this.audioConfiguration(),
      health: { ...(raw.latencyFrames === undefined ? {} : { latencyFrames: raw.latencyFrames }),
        ...(raw.underruns === undefined ? {} : { underruns: raw.underruns }),
        ...(raw.buffered === undefined ? {} : { buffered: raw.buffered }) },
    };
  }
  private observe() {
    if (!this.current || this.stopped || this.failed) return;
    const now = performance.now();
    if (this.latestPosition && now >= this.nextStatusPublication) {
      const period = 1000 / this.meterHz;
      this.nextStatusPublication += (Math.floor((now - this.nextStatusPublication) / period) + 1) * period;
      this.current.accepted.status = this.status(this.current.accepted.ref, this.latestPosition);
      this.emit({ kind: "status", status: this.current.accepted.status });
    }
    if (!this.analysisEnabled || now < this.nextAnalysisPublication) return;
    const period = 1000 / this.analysisHz;
    this.nextAnalysisPublication += (Math.floor((now - this.nextAnalysisPublication) / period) + 1) * period;
    const status = this.current.accepted.status;
    const measured = this.player.readAnalysis();
    if (!measured) return;
    const frame: AnalysisFrame = { ref: status.ref, generation: status.generation,
      sequence: String(++this.analysisSequence), source: this.analysisSource,
      sampleRate: measured.sampleRate, captureSeconds: measured.captureSeconds,
      waveform: measured.waveform, spectrum: measured.spectrum,
      meters: this.analysisMeters ? status.meters : [], peak: measured.peak, rms: measured.rms, dropped: "0",
      captureId: measured.captureId, windowEndSample: null, sampleCount: measured.sampleCount,
      warmup: measured.warmup, window: measured.window, smoothing: measured.smoothing,
      metersPresent: this.analysisMeters, meterWindowEndSample: null };
    this.emit({ kind: "analysis", frame });
  }
  rebuild(input: { snapshot: string; base: RevisionRef | null }, op: Operation): Promise<AcceptedRevision> {
    return this.operation(op, "compile", () => new Promise((resolve, reject) => {
      const job: BuildJob = { input, op, resolve, reject, recovery: op.requestId === this.recoveryRequest,
        source: this.projects.getSourceSnapshotMetadata(input.snapshot) };
      this.projects.pinSourceSnapshot(input.snapshot);
      if (this.building) {
        if (this.queued) {
          this.buildEvent(this.queued, "cancelled", null, hostFailure({ code: "superseded", message: "Superseded by a newer rebuild." }, "compile", this.current ? "preserved" : "not-started"));
          this.queued.reject(hostFailure({ code: "superseded", message: "Superseded by a newer rebuild." }, "compile", this.current ? "preserved" : "not-started"));
          this.projects.releaseSourceSnapshot(this.queued.input.snapshot);
        }
        this.queued = job;
        this.buildEvent(job, "queued");
      } else this.startBuild(job);
    }));
  }
  private startBuild(job: BuildJob) {
    this.building = true;
    this.buildPromise = this.build(job).then(job.resolve, job.reject).finally(() => {
      this.building = false;
      const next = this.queued;
      this.queued = undefined;
      if (next) this.startBuild(next);
    });
  }
  private buildEvent(job: BuildJob, phase: Extract<RuntimeEvent, { kind: "build" }>["phase"], ref: RevisionRef | null = null, failure: Failure | null = null) {
    const snapshot = job.source;
    if (failure) failure.operation ??= {action:"rebuild",requestId:job.op.requestId,ref:job.input.base,
      outcome:failure.code === "cancelled" ? "cancelled" : failure.code === "superseded" ? "superseded" :
        failure.continuity === "lost" ? "unknown" : "rejected",continuity:failure.continuity,phase:failure.phase,
      expectedRuntimeRevision:null,actualRuntimeRevision:null};
    this.emit({ kind: "build", requestId: job.op.requestId,
      project: { project: snapshot.project, epoch: snapshot.epoch }, sourceVersion: snapshot.sourceVersion,
      phase, ref, failure });
  }
  private async build(job: BuildJob): Promise<AcceptedRevision> {
    const { input, op } = job;
    let retained = false;
    let applied = false;
    try {
      cancelled(op, "compile");
      if (input.base && (!this.current || !sameRevision(input.base, this.current.accepted.ref)))
        fail("stale_revision", "Rebuild base no longer matches the accepted revision.", "compile");
      const source = this.projects.getSourceSnapshot(input.snapshot);
      if (!source.snapshot.files.some((file) => file.path === source.snapshot.entry))
        fail("missing_module", `Project entry ${source.snapshot.entry} is missing or deleted.`, "compile");
      this.buildEvent(job, "compiling");
      await this.compiler.call({ command: "assets", entries: source.assets });
      cancelled(op, "compile");
      const compiled = await this.compiler.call({ command: "compile", files: source.files, entry: source.snapshot.entry });
      cancelled(op, "compile");
      if (!Number.isSafeInteger(compiled.revision) || compiled.revision < 0)
        fail("protocol_mismatch", "Browser compiler returned an invalid revision.", "compile");
      if (compiled.snapshot.description.tracks.length > this.capabilities.limits.trackMeters)
        fail("resource_budget", "Browser metering supports at most 1000 physical tracks.", "prepare");
      const ref: RevisionRef = { project: source.snapshot.project, epoch: source.snapshot.epoch,
        engineEpoch: this.engineEpoch, revision: String(compiled.revision),
        sourceVersion: source.snapshot.sourceVersion, entry: source.snapshot.entry };
      const initialPages = {} as AcceptedRevision["initialPages"];
      for (const view of INITIAL_VIEWS) {
        const raw = await this.compiler.call({ command: "inspect", revision: compiled.revision, view,
          page: { offset: 0, limit: view === "summary" ? 1 : view === "locations" ? 100 : 1000 } });
        initialPages[view] = this.inspectionPage(ref, view, raw, compiled.revision);
        cancelled(op, "compile");
      }
      return await this.serializeControl(async () => {
      cancelled(op, "prepare");
      if (input.base && (!this.current || !sameRevision(input.base, this.current.accepted.ref)))
        fail("stale_revision", "Rebuild base changed before audio application.", "prepare");
      this.buildEvent(job, "preparing");
      const raw = await this.player.accept(compiled.snapshot,
        () => !op.signal?.aborted && !this.stopped && !this.failed,
        source.assets, () => this.buildEvent(job, "applying"),
        () => this.projects.validateSourceSnapshot(input.snapshot, job.recovery));
      if (!raw) fail("cancelled", "Rebuild cancelled before audio application.", "prepare");
      applied = true;
      // Audio apply is the commit boundary. An abort after this point must return acceptance.
      await this.compiler.call({ command: "accept_compilation", revision: compiled.revision });
      this.generation++;
      const status = this.status(ref, { ...raw, tail: compiled.snapshot.description.extras?.tail ?? 0 });
      const accepted: AcceptedRevision = { ref, status, effect: raw.effect ?? compiled.effect ?? null,
        initialPages, exportTracks: compiled.snapshot.description.tracks.map((track: BrowserTrack) => ({
          id: track.id, name: track.name || track.id, midi: track.source.kind === "midi",
        })) };
      if (this.previous) this.projects.releaseSourceSnapshot(this.previous.sourceSnapshot);
      this.previous = this.current;
      this.current = { accepted, compilerRevision: compiled.revision, audioRevision: raw.revision,
        snapshot: compiled.snapshot, assets: source.assets, sourceSnapshot: input.snapshot, title: source.title };
      retained = true;
      this.projects.pinSourceSnapshot(input.snapshot);
      if (this.restartSnapshot) this.projects.releaseSourceSnapshot(this.restartSnapshot);
      this.restartSnapshot = input.snapshot;
      if (this.analysisSource !== null && !accepted.exportTracks.some((track) => track.id === this.analysisSource)) {
        this.analysisSource = null;
        this.analysisEnabled = false;
        this.player.setAnalysisEnabled(false);
        this.player.selectAnalysis(null);
      }
      this.latestPosition = raw;
      this.capabilities.audio.configuration = status.audio;
      this.buildEvent(job, "accepted", ref);
      this.emit({ kind: "status", status });
      return accepted;
      });
    } catch (error) {
      const failure = hostFailure(error, applied ? "apply" : "compile", applied ? "lost" : this.current ? "preserved" : "not-started");
      if (applied) {
        this.failed = true;
        this.engineFailure = failure;
        this.emit({ kind: "engine", state: "failed", engineEpoch: this.engineEpoch,
          capabilities: this.capabilities, failure });
      }
      this.buildEvent(job, failure.code === "cancelled" ? "cancelled" : "rejected", null, failure);
      throw failure;
    } finally {
      if (!retained) this.projects.releaseSourceSnapshot(input.snapshot);
    }
  }
  private inspectionPage(ref: RevisionRef, view: InspectionView, raw: BrowserPage, expected: number): InspectionPage {
    if (raw.revision !== expected) fail("stale_revision", "Stale browser inspection reply.", "inspect");
    const page = { ref, view, rows: raw.rows, total: raw.total, next: raw.next ?? null };
    this.boundPage(page);
    return page;
  }
  private boundPage(page: { rows: Json[] }) {
    if (!Array.isArray(page.rows) || page.rows.length > 1000 || encoder.encode(JSON.stringify(page)).length > 1024 * 1024)
      fail("resource_budget", "Inspection reply exceeds the bounded page size.", "inspect");
  }
  async format(input: { project: string; path: string; bufferVersion: number; source: string }, op: Operation) {
    return this.operation(op, "compile", async () => {
      if (encoder.encode(input.source).length > this.capabilities.limits.sourceDocumentBytes)
        fail("too_large", "Source document exceeds the format budget.", "compile");
      const value = await this.utilityCompiler.call({ command: "format", source: input.source });
      cancelled(op, "compile");
      return { bufferVersion: input.bufferVersion, source: value.source as string };
    }, "format");
  }
  async checkEntries(input: { snapshot: string; entries: string[] }, op: Operation): Promise<EntryCheckResult> {
    const generation = ++this.scanGeneration;
    return this.operation(op, "compile", async () => {
      if (input.entries.length > 1000 || new Set(input.entries).size !== input.entries.length ||
          input.entries.some((entry) => !/\.muz$/i.test(entry)))
        fail("resource_budget", "Entry candidates exceed the supported source scan budget.", "compile");
      this.projects.pinSourceSnapshot(input.snapshot);
      const check = () => {
        cancelled(op, "compile");
        if (generation !== this.scanGeneration) fail("superseded", "A newer source scan replaced this scan.", "compile");
      };
      const run = async () => {
        check();
        const source = this.projects.getSourceSnapshot(input.snapshot);
        const entries: EntryCheckResult["entries"] = [];
        await this.utilityCompiler.call({ command: "assets", entries: source.assets });
        for (const entry of input.entries) {
          check();
          this.emit({ kind: "entries", requestId: op.requestId, snapshot: input.snapshot,
            done: entries.length, total: input.entries.length, currentEntry: entry, result: null });
          // Utility timeout/runtime/global limit failure rejects the scan, never a candidate.
          const raw = source.snapshot.files.some((file) => file.path === entry) ?
            await this.utilityCompiler.call({ command: "check_entry", files: source.files, entry }) :
            {kind:"unresolved",failure:{code:"missing_module",message:`Project entry ${entry} is missing or deleted.`,path:entry}};
          check();
          if (!["song", "non-song", "unresolved"].includes(raw.kind))
            fail("protocol_mismatch", "Invalid root classification.", "compile");
          const result: EntryCheckResult["entries"][number] = { entry, kind: raw.kind,
            readiness: { kind: "unchecked" }, failure: raw.failure ? hostFailure(raw.failure, "compile", "not-started") : null,
            ...(typeof raw.description === "string" ? { description: raw.description } : {}) };
          entries.push(result);
          this.emit({ kind: "entries", requestId: op.requestId, snapshot: input.snapshot,
            done: entries.length, total: input.entries.length, currentEntry: entry, result });
        }
        check();
        return { snapshot: input.snapshot, sourceVersion: source.snapshot.sourceVersion, entries };
      };
      let abortQueued: (()=>void)|undefined;
      const pending = new Promise<EntryCheckResult>((resolve,reject) => {
        const start = () => {
          this.scanActive = true;
          const work = this.utilityTail.then(run);
          this.utilityTail = work.catch(() => {});
          void work.then(resolve,reject).finally(() => {
            this.scanActive = false;
            const queued = this.queuedScan;
            this.queuedScan = undefined;
            queued?.start();
          });
        };
        if (this.scanActive) {
          this.queuedScan?.supersede();
          const queued = {start,supersede:()=>reject(hostFailure({
            code:"superseded",message:"A newer queued source scan replaced this scan.",
          },"compile","not-started"))};
          this.queuedScan = queued;
          abortQueued = () => {
            if (this.queuedScan === queued) this.queuedScan = undefined;
            reject(hostFailure({code:"cancelled",message:"Queued source scan cancelled."},"compile","not-started"));
          };
          op.signal?.addEventListener("abort",abortQueued,{once:true});
          if (op.signal?.aborted) abortQueued();
        } else start();
      });
      try { return await pending; }
      finally {
        if (abortQueued) op.signal?.removeEventListener("abort",abortQueued);
        this.projects.releaseSourceSnapshot(input.snapshot);
      }
    }, "classifyEntries");
  }
  async inspect(ref: RevisionRef, view: InspectionView, page: PageRequest, op: Operation): Promise<InspectionPage> {
    return this.operation(op, "inspect", async () => {
      const retained = this.retained(ref);
      const result = await this.compiler.call({ command: "inspect", revision: retained.compilerRevision, view, page: webPageRequest(page) });
      cancelled(op, "inspect");
      this.retained(ref);
      return this.inspectionPage(ref, view, result, retained.compilerRevision);
    });
  }
  async explain(ref: RevisionRef, track: string, query: { key?: string; offset: number; limit: number }, op: Operation): Promise<ExplanationPage> {
    return this.operation(op, "inspect", async () => {
      const retained = this.retained(ref);
      const raw = await this.compiler.call({ command: "explain", revision: retained.compilerRevision, track,
        ...(query.key === undefined ? {} : { key: query.key }), page: webPageRequest({ offset: query.offset, limit: query.limit }) });
      cancelled(op, "inspect"); this.retained(ref);
      if (raw.revision !== retained.compilerRevision) fail("stale_revision", "Stale explanation reply.", "inspect");
      const result = { ref, rows: raw.page.rows, total: raw.page.total, next: raw.page.next ?? null };
      this.boundPage(result);
      return result;
    });
  }
  async location(ref: RevisionRef, key: string, op: Operation): Promise<SourceLocation | null> {
    return this.operation(op, "inspect", async () => {
      const retained = this.retained(ref);
      const raw = await this.compiler.call({ command: "location", revision: retained.compilerRevision, key });
      cancelled(op, "inspect"); this.retained(ref);
      if (raw.revision !== retained.compilerRevision) fail("stale_revision", "Stale source location reply.", "inspect");
      return raw.location;
    });
  }
  async diff(ref: RevisionRef, category: DiffCategory, page: PageRequest, op: Operation): Promise<DiffPage> {
    return this.operation(op, "inspect", async () => {
      const retained = this.retained(ref);
      const raw = await this.compiler.call({ command: "diff", revision: retained.compilerRevision, category, page: webPageRequest(page) });
      cancelled(op, "inspect"); this.retained(ref);
      const base = [this.current, this.previous].find((value) => value?.compilerRevision === raw.base_revision);
      if (raw.revision !== retained.compilerRevision || !base) fail("expired_revision", "Comparison revision expired.", "inspect");
      const result = { ref, base: base.accepted.ref, category,
        rows: raw.page.rows, total: raw.page.total, next: raw.page.next ?? null };
      this.boundPage(result);
      return result;
    });
  }
  /** Audio application and accepted metadata publication form one control transaction. */
  private serializeControl<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.controls.then(() => {
      if (this.stopped || this.failed)
        fail("child_died", "The engine is unavailable for this queued control.", "engine");
      return action();
    });
    this.controls = pending.catch(() => {});
    return pending;
  }
  async transport(ref: RevisionRef, command: TransportCommand, op: Operation): Promise<TransportStatus> {
    return this.operation(op, "transport", async () => {
      const run = async () => {
        cancelled(op, "transport");
        const global = ["play","pause","stop","panic"].includes(command.kind);
        const currentRef = this.current?.accepted.ref;
        const retained = global && currentRef && currentRef.project === ref.project && currentRef.epoch === ref.epoch &&
          currentRef.engineEpoch === ref.engineEpoch ? this.current! : this.retained(ref, true);
        if (command.kind === "seek" && (!Number.isFinite(command.beat) || command.beat < 0 || command.beat * 960000 > Number.MAX_SAFE_INTEGER))
          fail("invalid_source", "Choose a finite nonnegative seek position.", "transport");
        if (command.kind === "loop" && command.range && (!command.range.every(Number.isFinite) || command.range[0] < 0 || command.range[1] <= command.range[0] || command.range[1] > retained.accepted.status.endBeat))
          fail("invalid_source", "Choose a half-open loop within the accepted song.", "transport");
        let raw: BrowserStatus = this.latestPosition ?? retained.accepted.status;
        switch (command.kind) {
          case "play":
            if (raw.done || raw.finished) raw = await this.player.seek(this.player.loop?.[0] ?? 0);
            await this.player.play(); break;
          case "pause": this.player.pause(); break;
          case "stop":
            this.player.pause();
            try { raw = await this.player.seek(this.player.loop?.[0] ?? 0); }
            catch (error) {
              retained.accepted.status = this.status(retained.accepted.ref, raw);
              this.emit({kind:"status",status:retained.accepted.status});
              const issue = hostFailure(error, "transport");
              issue.operation = {action:"stop",requestId:op.requestId,ref,outcome:"partial",
                continuity:"preserved",phase:"transport",expectedRuntimeRevision:null,actualRuntimeRevision:null};
              throw issue;
            }
            break;
          case "restart": raw = await this.player.seek(this.player.loop?.[0] ?? 0); break;
          case "seek": raw = await this.player.seek(command.beat); break;
          case "loop": raw = await this.player.setLoop(command.range); break;
          case "panic": raw = await this.player.panic(); break;
        }
        this.generation++;
        this.latestPosition = raw;
        const status = this.status(retained.accepted.ref, raw);
        retained.accepted.status = status;
        this.emit({ kind: "status", status });
        return status;
      };
      return this.serializeControl(run);
    }, command.kind, ref);
  }
  async audition(ref: RevisionRef, controls: { muted: string[]; solo: string[] }, op: Operation): Promise<void> {
    return this.operation(op, "transport", () => this.serializeControl(async () => {
      cancelled(op, "transport");
      this.retained(ref, true);
      await this.player.setAudition(controls.muted, controls.solo);
    }), "audition", ref);
  }
  async analysis(ref: RevisionRef, subscription: AnalysisSubscription): Promise<void> {
    await this.operation({ requestId: crypto.randomUUID() }, "transport", () => this.serializeControl(async () => {
    const retained = this.retained(ref, true);
    const {source, detail, meters, detailHz, meterHz} = subscription;
    if (source !== null && !retained.accepted.exportTracks.some((track) => track.id === source))
      fail("invalid_source", "Unknown analysis track.", "transport");
    if (![detailHz, meterHz].every((hz) => Number.isSafeInteger(hz) && hz > 0) ||
        detailHz > this.capabilities.limits.analysisHz || meterHz > this.capabilities.limits.statusHz)
      fail("resource_budget", "Analysis cadence exceeds the negotiated budget.", "transport");
    this.analysisEnabled = detail;
    this.analysisMeters = meters;
    this.player.setMetersEnabled(meters, meterHz);
    this.analysisHz = detailHz;
    this.meterHz = meterHz;
    this.nextAnalysisPublication = performance.now();
    this.nextStatusPublication = this.nextAnalysisPublication;
    this.analysisSource = source;
    this.player.setAnalysisEnabled(detail);
    this.player.selectAnalysis(source);
    }), "analysis", ref);
  }
  async export(ref: RevisionRef, spec: ExportSpec, op: Operation): Promise<ExportResult> {
    return this.operation(op, "export", async () => {
      const retained = this.retained(ref);
      if (this.exports.size >= this.capabilities.limits.exportWorkers)
        fail("queue_full", "Two browser exports are already running.", "export");
      const tracks = spec.kind === "masterWav" ? retained.accepted.exportTracks.map((track) => track.id) : spec.tracks;
      if (!tracks.length || new Set(tracks).size !== tracks.length || tracks.some((id) => !retained.accepted.exportTracks.some((track) => track.id === id && (spec.kind !== "midi" || track.midi))))
        fail("invalid_source", "Choose valid physical export tracks.", "export");
      const end = spec.kind === "wav" ? spec.end : retained.accepted.status.duration + retained.accepted.status.tail;
      if (spec.kind === "wav" && (![44100, 48000, 96000].includes(spec.rate) || ![16, 24].includes(spec.bits) || !Number.isFinite(spec.start) || !Number.isFinite(end) || spec.start < 0 || end <= spec.start || end > retained.accepted.status.duration + retained.accepted.status.tail + 1e-6))
        fail("invalid_source", "Choose a valid export range and PCM format.", "export");
      const job = crypto.randomUUID();
      const worker = new Worker(new URL("../export.worker.ts", import.meta.url), { type: "module" });
      this.projects.pinSourceSnapshot(retained.sourceSnapshot);
      try {
        return await new Promise<ExportResult>((resolve, reject) => {
          let finished = false;
          const finish = (error?: unknown, value?: ExportResult) => {
            if (finished) return;
            finished = true;
            worker.terminate();
            this.exports.delete(job);
            op.signal?.removeEventListener("abort", abort);
            if (error) reject(error); else resolve(value!);
          };
          const abort = () => finish(hostFailure({ code: "cancelled", message: "Export cancelled." }, "export"));
          this.exports.set(job, { worker, cancel: abort });
          op.signal?.addEventListener("abort", abort, { once: true });
          if (op.signal?.aborted) { abort(); return; }
          worker.onerror = (event) => finish(new Error(event.message));
          worker.onmessage = ({ data }) => {
            if (data.progress !== undefined) {
              this.emit({ kind: "exportProgress", requestId: op.requestId, job, ref, phase: "rendering", progress: data.progress });
              return;
            }
            if (data.error) { finish(new Error(data.error)); return; }
            const extension = spec.kind === "midi" ? "mid" : "wav";
            const scope = spec.kind === "masterWav" ? "master" : tracks.length === 1 ? tracks[0] : "mix";
            const name = `${retained.title}-${scope}`.replace(/[^a-zA-Z0-9._-]+/g, "-") + `.${extension}`;
            this.emit({ kind: "exportProgress", requestId: op.requestId, job, ref, phase: "publishing", progress: 1 });
            const url = URL.createObjectURL(new Blob([data.bytes], { type: extension === "wav" ? "audio/wav" : "audio/midi" }));
            const link = document.createElement("a"); link.href = url; link.download = name; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            finish(undefined, { job, ref, name, clipped: !!data.clipped });
          };
          this.emit({ kind: "exportProgress", requestId: op.requestId, job, ref, phase: "preparing", progress: null });
          worker.postMessage({ format: spec.kind === "midi" ? "midi" : "wav",
            snapshot: retained.snapshot, assets: spec.kind === "midi" ? [] : retained.assets, tracks,
            rate: spec.kind === "wav" ? spec.rate : 48000, bits: spec.kind === "wav" ? spec.bits : 24,
            start: spec.kind === "wav" ? spec.start : 0, end });
        });
      } finally { this.projects.releaseSourceSnapshot(retained.sourceSnapshot); }
    });
  }
  get activeExports() { return this.exports.size; }
  async cancelExports() {
    for (const job of this.exports.values()) job.cancel();
  }
  async replaceProject(): Promise<void> {
    await this.resetEngine(false);
  }
  private async resetEngine(retainSource: boolean, recoverFailure = false): Promise<void> {
    if (this.stopped) fail("child_died", "The workbench has been disposed.", "engine");
    if (this.resetting) fail("queue_full", "Engine replacement is already in progress.", "engine");
    this.resetting = true;
    const preserveFailure = this.failed && !recoverFailure;
    try {
    this.failed = true;
    this.scanGeneration++;
    this.queuedScan?.supersede();
    this.queuedScan = undefined;
    if (this.queued) {
      this.queued.reject(hostFailure({ code: "cancelled", message: "The active project changed." }, "engine"));
      this.projects.releaseSourceSnapshot(this.queued.input.snapshot);
      this.queued = undefined;
    }
    await this.cancelExports();
    this.compiler.dispose(); this.utilityCompiler.dispose();
    await this.player.shutdown();
    await this.buildPromise;
    if (this.stopped) fail("child_died", "The workbench has been disposed.", "engine");
    if (this.current) this.projects.releaseSourceSnapshot(this.current.sourceSnapshot);
    if (this.previous) this.projects.releaseSourceSnapshot(this.previous.sourceSnapshot);
    if (!retainSource && this.restartSnapshot) {
      this.projects.releaseSourceSnapshot(this.restartSnapshot);
      this.restartSnapshot = undefined;
    }
    this.current = undefined; this.previous = undefined; this.latestPosition = undefined;
    this.player.loop = null;
    this.player.beat = 0;
    this.player.setAnalysisEnabled(false);
    this.analysisEnabled = false; this.analysisSource = null;
    this.player.selectAnalysis(null);
    this.capabilities.audio.configuration = null;
    if (preserveFailure) {
      this.emit({ kind: "engine", state: "failed", engineEpoch: this.engineEpoch,
        capabilities: this.capabilities, failure: this.engineFailure });
    } else {
      this.compiler.reset(); this.utilityCompiler.reset();
      this.engineEpoch = crypto.randomUUID(); this.generation = 0n; this.statusSequence = 0n; this.failed = false;
      this.engineFailure = null;
      this.emit({ kind: "engine", state: "ready", engineEpoch: this.engineEpoch, capabilities: this.capabilities, failure: null });
    }
    } finally {
      this.resetting = false;
    }
  }
  async restart(op: Operation): Promise<AcceptedRevision | null> {
    cancelled(op, "engine");
    if (this.building) fail("queue_full", "Wait for the active rebuild before restarting.", "engine");
    if (this.stopped) fail("child_died", "The workbench has been disposed.", "engine");
    const snapshot = this.restartSnapshot;
    await this.resetEngine(true, true);
    if (!snapshot) return null;
    this.recoveryRequest = op.requestId;
    try { return await this.rebuild({ snapshot, base: null }, op); }
    finally {
      this.recoveryRequest = undefined;
    }
  }
  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    if (this.queued) {
      this.queued.reject(hostFailure({ code: "cancelled", message: "Runtime disposed." }, "engine"));
      this.projects.releaseSourceSnapshot(this.queued.input.snapshot);
      this.queued = undefined;
    }
    await this.cancelExports();
    this.compiler.dispose(); this.utilityCompiler.dispose();
    await this.player.shutdown();
    await this.buildPromise;
    if (this.current) this.projects.releaseSourceSnapshot(this.current.sourceSnapshot);
    if (this.previous) this.projects.releaseSourceSnapshot(this.previous.sourceSnapshot);
    if (this.restartSnapshot) this.projects.releaseSourceSnapshot(this.restartSnapshot);
    this.restartSnapshot = undefined;
    this.current = undefined; this.previous = undefined;
    this.emit({ kind: "engine", state: "stopped", engineEpoch: this.engineEpoch, capabilities: this.capabilities, failure: null });
    this.listeners.clear();
  }
}

export async function createWebHost(): Promise<WorkbenchHost> {
  const projects = new WebProjectStore();
  await projects.initialize();
  const runtime = new WebRuntime(projects, projects.coreRevision);
  projects.configureExports({ active: () => runtime.activeExports, cancel: () => runtime.cancelExports() });
  projects.configureRuntime({ replace: () => runtime.replaceProject() });
  const listeners = new Set<(event: HostEvent) => void>();
  const preferenceFailures: HostEvent[] = [];
  const preferences = new WebPreferencesStore((failure) => {
    const event: HostEvent = { kind: "preferencesFailure", failure };
    if (!listeners.size) { preferenceFailures.length = 0; preferenceFailures.push(event); }
    for (const listener of listeners) listener(event);
  });
  let disposed = false;
  return {
    runtime, projects, preferences,
    subscribe(listener) {
      listeners.add(listener);
      for (const event of preferenceFailures) listener(event);
      preferenceFailures.length = 0;
      return () => { listeners.delete(listener); };
    },
    restartEngine(op) { return runtime.restart(op); },
    async openExternal(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        fail("denied_path", "Only HTTP(S) links can be opened externally.", "project");
      window.open(parsed.href, "_blank", "noopener,noreferrer");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runtime.dispose(); projects.dispose(); listeners.clear();
    },
  };
}
