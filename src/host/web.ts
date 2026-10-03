import { AudioPlayer, Compiler } from "../audio";
import { WebProjectStore } from "./web-projects";
import { WebPreferencesStore } from "./web-preferences";
import type {
  AcceptedRevision, AnalysisFrame, AudioConfiguration, DiffCategory, DiffPage,
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
  return Object.assign(new Error(message), failure);
}
function fail(code: string, message: string, phase: Failure["phase"]): never {
  throw hostFailure({ code, message }, phase);
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
  private analysisSequence = 0n;
  private analysisEnabled = false;
  private analysisSource: string | null = null;
  private timer: number;
  private lastAnalysis = 0;
  private latestPosition?: BrowserStatus;
  private waveform = new Float32Array(2048);
  private spectrum = new Float32Array(1024);
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
        statusHz: 20, analysisHz: 10, waveformSamples: 2048, spectrumBins: 1024,
        trackMeters: 1000, analysisBytes: 128 * 1024,
        exportWorkers: 2, exportQueue: 0, playableSnapshotBytes: 256 * 1024 * 1024 },
    };
    this.player.onPosition = (value) => {
      if (this.current && (value.revision === undefined || value.revision === this.current.audioRevision))
        this.latestPosition = value;
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
    this.timer = setInterval(() => this.observe(), 50);
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
  private async operation<T>(op: Operation, phase: Failure["phase"], action: () => Promise<T>): Promise<T> {
    cancelled(op, phase);
    if (this.stopped) fail("child_died", "Runtime has been disposed.", "engine");
    if (this.failed) fail("child_died", "Restart the engine before issuing another runtime operation.", "engine");
    if (!op.requestId || this.activeRequests.has(op.requestId)) fail("stale_request", "Request identity is already active.", phase);
    if (this.activeRequests.size >= this.capabilities.limits.outstandingRequests) fail("queue_full", "Too many runtime operations.", phase);
    this.activeRequests.add(op.requestId);
    try { return await action(); }
    catch (error) { throw hostFailure(error, phase, this.current ? "preserved" : "not-started"); }
    finally { this.activeRequests.delete(op.requestId); }
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
    const meters = (raw.meters ?? prior?.meters ?? []).map((meter) => ({
      track: meter.track ?? ("id" in meter ? meter.id! : ""), peak: playing ? meter.peak : 0, rms: playing ? (meter.rms ?? 0) : 0,
    }));
    return { ref, generation: String(this.generation), playing,
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
    if (this.latestPosition) {
      this.current.accepted.status = this.status(this.current.accepted.ref, this.latestPosition);
      this.emit({ kind: "status", status: this.current.accepted.status });
    }
    const now = performance.now();
    if (!this.analysisEnabled || now - this.lastAnalysis < 100) return;
    this.lastAnalysis = now;
    const status = this.current.accepted.status;
    const analyser = this.player.analyser;
    if (!analyser) return;
    const waveform: number[] = [], spectrum: number[] = [];
    if (this.player.playing) {
      analyser.getFloatTimeDomainData(this.waveform);
      analyser.getFloatFrequencyData(this.spectrum);
      for (const sample of this.waveform) waveform.push(sample);
      for (const db of this.spectrum) spectrum.push(Number.isFinite(db) ? 10 ** (db / 20) : 0);
    }
    const frame: AnalysisFrame = { ref: status.ref, generation: status.generation,
      sequence: String(++this.analysisSequence), source: this.analysisSource,
      sampleRate: status.audio.sampleRate, captureSeconds: status.seconds,
      waveform, spectrum, meters: status.meters, peak: status.peak, rms: status.rms, dropped: "0" };
    this.emit({ kind: "analysis", frame });
  }
  rebuild(input: { snapshot: string; base: RevisionRef | null }, op: Operation): Promise<AcceptedRevision> {
    return this.operation(op, "compile", () => new Promise((resolve, reject) => {
      const job: BuildJob = { input, op, resolve, reject, recovery: op.requestId === this.recoveryRequest,
        source: this.projects.getSourceSnapshotMetadata(input.snapshot) };
      this.projects.pinSourceSnapshot(input.snapshot);
      if (this.building) {
        if (this.queued) {
          this.buildEvent(this.queued, "cancelled", null, hostFailure({ code: "cancelled", message: "Superseded by a newer rebuild." }, "compile"));
          this.queued.reject(hostFailure({ code: "cancelled", message: "Superseded by a newer rebuild." }, "compile"));
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
          page: { offset: 0, limit: view === "summary" ? 1 : 1000 } });
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
    });
  }
  async checkEntries(input: { snapshot: string; entries: string[] }, op: Operation): Promise<EntryCheckResult> {
    return this.operation(op, "compile", async () => {
      this.projects.pinSourceSnapshot(input.snapshot);
      const run = async () => {
        const source = this.projects.getSourceSnapshot(input.snapshot);
        const entries: EntryCheckResult["entries"] = [];
        await this.utilityCompiler.call({ command: "assets", entries: source.assets });
        for (const entry of input.entries) {
          cancelled(op, "compile");
          let failure: Failure | null = null;
          try { await this.utilityCompiler.call({ command: "check_entry", files: source.files, entry }); }
          catch (error) { failure = hostFailure(error, "compile", "not-started"); }
          cancelled(op, "compile");
          entries.push({ entry, playable: failure === null, failure });
          this.emit({ kind: "entries", requestId: op.requestId, snapshot: input.snapshot, done: entries.length, total: input.entries.length });
        }
        return { snapshot: input.snapshot, sourceVersion: source.snapshot.sourceVersion, entries };
      };
      const pending = this.utilityTail.then(run);
      this.utilityTail = pending.catch(() => {});
      try { return await pending; }
      finally { this.projects.releaseSourceSnapshot(input.snapshot); }
    });
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
        const retained = this.retained(ref, true);
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
          case "stop": raw = await this.player.stop(); break;
          case "restart": raw = await this.player.seek(this.player.loop?.[0] ?? 0); break;
          case "seek": raw = await this.player.seek(command.beat); break;
          case "loop": raw = await this.player.setLoop(command.range); break;
          case "panic": raw = await this.player.panic(); break;
        }
        this.generation++;
        this.latestPosition = raw;
        const status = this.status(ref, raw);
        retained.accepted.status = status;
        this.emit({ kind: "status", status });
        return status;
      };
      return this.serializeControl(run);
    });
  }
  async audition(ref: RevisionRef, controls: { muted: string[]; solo: string[] }, op: Operation): Promise<void> {
    return this.operation(op, "transport", () => this.serializeControl(async () => {
      cancelled(op, "transport");
      this.retained(ref, true);
      await this.player.setAudition(controls.muted, controls.solo);
    }));
  }
  async analysis(ref: RevisionRef, source: string | null, enabled: boolean): Promise<void> {
    await this.serializeControl(async () => {
    const retained = this.retained(ref, true);
    if (source !== null && !retained.accepted.exportTracks.some((track) => track.id === source))
      fail("invalid_source", "Unknown analysis track.", "transport");
    this.analysisEnabled = enabled;
    this.analysisSource = source;
    this.player.setAnalysisEnabled(enabled);
    this.player.selectAnalysis(source);
    });
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
      this.engineEpoch = crypto.randomUUID(); this.generation = 0n; this.failed = false;
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
