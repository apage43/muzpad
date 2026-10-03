import { unzipSync, zipSync } from "fflate";
import type {
  ArchiveResult, BufferCapture, CloseInput, CloseResult, Failure, ImportInput,
  Operation, ProjectEvent, ProjectFile, ProjectRef, ProjectSettings, ProjectSnapshot,
  ProjectStore, RecentProject, RecoveryOffer, ResolvedSourceDocument, ResourceDescriptor, SaveInput,
  SaveResult, SourceConflict, SourceSnapshot, WorkingCapture,
} from "./contracts";
import {
  ASSET_LIMITS, assetFormat, assetTransfers, createAsset, importArchiveEntries,
  normalizeProjectPath, projectArchiveEntries, verifiedAssetTransfers,
} from "../assets.js";
import { canMountFolder, pickFolder, readProjectFolder, type DirectoryHandle } from "../folder";
import {
  hasStoredProject, loadStoredProject, saveStoredProject, removeStoredProject,
  loadProjectDirectory, saveProjectDirectory, removeProjectDirectory,
} from "../project-storage.js";
import { parseGist } from "../gist.js";

const DRAFT = "muzpad-draft-v1";
const PREVIOUS = "muzpad-previous-v1";
const RECENTS = "muzpad-recents-v1";
const SETTINGS = "muzpad.json";
const MAX_TEXT_BYTES = 4_000_000;
const MAX_FILES = 500;
const MAX_RECENTS = 20;
const MAX_SNAPSHOTS = 8;
const MAX_PINNED = 16;
const encoder = new TextEncoder();
const starter = 'use "std/synthesis" as synths;\n\nlet motif = phrase("C4:q E4:q G4:q B4:q");\n\nsong({\n    title: "Untitled project",\n    tempo: 120,\n    tracks: [track("lead", motif.repeat(4), synths.pluck())],\n    tail: 2\n})\n';
type Asset = { format: "midi" | "wav" | "flac"; version: string; byteLength: number; base64: string };
type AssetTransfer = { path: string; format: "midi" | "wav" | "flac"; version: string; bytes: Uint8Array };
type Assets = Record<string, Asset>;
type Baseline = { text: string | null; version: string | null };
type FileState = ProjectFile & { base: string | null; priorBase?: Baseline };
type State = ProjectRef & {
  settings: ProjectSettings; settingsBase: Baseline; sourceVersion: number;
  diskGeneration: string; files: Map<string, FileState>; assets: Assets;
  conflicts: Map<string, SourceConflict>; root: DirectoryHandle | null;
  rootLabel: string | null; folder: boolean; replacementAllowed: string | null;
  gist?: string;
};
type Stored = {
  id: string; title: string; entry: string; entries?: string[];
  files: Record<string, string>; assets?: Assets; folderName?: string;
  _gist?: string;
  _web?: {
    sourceVersion: number; diskGeneration: string; settingsBase: Baseline;
    buffers: FileState[]; conflicts: SourceConflict[]; updatedAt: string;
    folder: boolean;
  };
};
type PinnedSource = {
  snapshot: SourceSnapshot; files: Record<string, string>; assets: Assets;
  title: string; pins: number;
  root: DirectoryHandle | null; folder: boolean; clean: { path: string; version: string | null }[];
};
const uid = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const copy = <T>(value: T): T => structuredClone(value);
const fileKind = (path: string): ProjectFile["kind"] => /\.muz$/i.test(path) ? "source" : /\.md$/i.test(path) ? "document" : "text";
const settingsText = (settings: ProjectSettings) => JSON.stringify(settings, null, 2) + "\n";
const sameSettings = (a: ProjectSettings, b: ProjectSettings) => settingsText(a) === settingsText(b);
const recentKey = (id: string) => `muzpad-project-v1:${id}`;
function failure(code: string, message: string, op?: Operation, path?: string): Failure {
  return { code, message, phase: "project", continuity: "preserved", ...(op ? { requestId: op.requestId } : {}), ...(path ? { path } : {}) };
}
function error(code: string, message: string, op?: Operation, path?: string): Error & Failure {
  const detail = failure(code, message, op, path);
  return Object.assign(new Error(message), detail, { failure: detail });
}
function asFailure(value: unknown, op?: Operation, path?: string): Failure {
  if (value && typeof value === "object" && "phase" in value && "code" in value) {
    const detail = value as Failure;
    // Error.message is non-enumerable; retain it explicitly in the wire failure.
    return { ...detail, message: detail.message };
  }
  return failure("file_write_failed", value instanceof Error ? value.message : String(value), op, path);
}
function abort(op: Operation) {
  if (op.signal?.aborted) throw error("cancelled", "Project operation cancelled.", op);
}
function versionNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw error("invalid_source", "Source and buffer versions must be nonnegative safe integers.");
}
function settings(value: ProjectSettings): ProjectSettings {
  if (!value || typeof value.title !== "string" || !value.title.trim()) throw error("invalid_source", "A project needs a title.");
  const entry = normalizeProjectPath(value.entry);
  if (!/\.muz$/i.test(entry)) throw error("invalid_source", "Choose a .muz entrypoint.");
  const entries = [...new Set((value.entries ?? []).map((path) => normalizeProjectPath(path)))];
  if (entries.some((path) => !/\.muz$/i.test(path))) throw error("invalid_source", "Entrypoints must be .muz source files.");
  return { title: value.title, entry, entries };
}
function settingsDirty(state: State): boolean {
  if (state.settingsBase.text === null) return true;
  try { return !sameSettings(state.settings, settings(JSON.parse(state.settingsBase.text))); }
  catch { return true; }
}
function validateFiles(files: Record<string, string>) {
  if (Object.keys(files).length > MAX_FILES) throw error("too_large", "Open a project with at most 500 source files.");
  let bytes = 0;
  for (const [path, text] of Object.entries(files)) {
    normalizeProjectPath(path);
    if (typeof text !== "string") throw error("invalid_source", `Source text is invalid: ${path}`);
    bytes += encoder.encode(text).byteLength;
  }
  if (bytes > MAX_TEXT_BYTES) throw error("too_large", "Open a project with at most 4 MB of text.");
}
async function baseline(text: string | null): Promise<Baseline> {
  if (text === null) return { text, version: null };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return { text, version: `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}` };
}
function localText(file: FileState): string | null { return file.deleted ? null : file.text; }
function updateDirty(file: FileState) { file.dirty = localText(file) !== file.base; }
function workingFiles(state: State): Record<string, string> {
  return Object.fromEntries([...state.files.values()].filter((file) => !file.deleted).map((file) => [file.path, file.text]));
}
function fingerprint(state: State): string {
  return JSON.stringify([state.project, state.epoch, state.sourceVersion, state.diskGeneration, state.settings,
    [...state.files.values()].map((file) => [file.id, file.path, file.bufferVersion, file.diskVersion, file.deleted, file.text]),
    state.settingsBase.version, [...state.conflicts.values()]]);
}
function dirty(state: State): boolean {
  return state.conflicts.size > 0 || [...state.files.values()].some((file) => file.dirty) || settingsDirty(state);
}

/** Browser filesystem/draft authority. Runtime reads only explicitly pinned captures. */
export class WebProjectStore implements ProjectStore {
  private current: State | null = null;
  private listeners = new Set<(event: ProjectEvent) => void>();
  private offers = new Map<string, RecoveryOffer>();
  private recovery = new Map<string, Stored>();
  private recents: RecentProject[] = [];
  private libraries: Record<string, string> = {};
  private initialized: Promise<void> | null = null;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private snapshots = new Map<string, PinnedSource>();
  private closeTokens = new Map<string, { ref: ProjectRef; fingerprint: string }>();
  private revision = "";
  private exports: { active: () => number; cancel: () => Promise<void> } | null = null;
  private runtime: { replace: () => Promise<void> } | null = null;
  private startupFailures: Failure[] = [];

  get coreRevision(): string { return this.revision; }
  configureExports(exports: { active: () => number; cancel: () => Promise<void> }): void { this.exports = exports; }
  configureRuntime(runtime: { replace: () => Promise<void> }): void { this.runtime = runtime; }

  initialize(): Promise<void> {
    this.initialized ??= this.initializeStore();
    return this.initialized;
  }

  private async initializeStore() {
    const response = await fetch(new URL("catalog.json", document.baseURI));
    if (!response.ok) throw error("missing_module", "Run npm run prepare:engine to bundle the source library.");
    const catalog = await response.json();
    if (!catalog.libraries || typeof catalog.libraries !== "object") throw error("invalid_source", "The bundled source library is invalid.");
    if (typeof catalog.engine?.commit !== "string" || !catalog.engine.commit) throw error("protocol_mismatch", "The source catalog has no pinned core revision.");
    this.revision = catalog.engine.commit;
    this.libraries = Object.freeze(Object.fromEntries(Object.entries(catalog.libraries).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
    try {
      const value = JSON.parse(localStorage.getItem(RECENTS) ?? "[]");
      if (Array.isArray(value)) this.recents = value.filter((item) => item && typeof item.project === "string" && typeof item.title === "string" && typeof item.rootLabel === "string" && typeof item.lastOpened === "string").slice(0, MAX_RECENTS);
    } catch (cause) { this.emitFailure(cause); }
    for (const key of [DRAFT, PREVIOUS]) {
      try {
        const stored = await loadStoredProject(key) as Stored | null;
        if (!stored) continue;
        this.validateStored(stored);
        this.recovery.set(key, stored);
        if (key === DRAFT && new URL(document.baseURI).searchParams.has("gist")) {
          await saveStoredProject(PREVIOUS, stored);
          this.recovery.set(PREVIOUS, stored);
          this.offer(PREVIOUS, stored);
          continue;
        }
        if (key === DRAFT) {
          this.current = await this.fromStored(stored);
          this.emit({ kind: "changed", snapshot: this.snapshot(this.current), reason: "recovery" });
        } else this.offer(key, stored);
      } catch (cause) { this.emitFailure(cause); }
    }
  }

  private assertLive() { if (this.disposed) throw error("stale_request", "The project store has been disposed."); }
  private state(ref: ProjectRef): State {
    this.assertLive();
    if (!this.current || this.current.project !== ref.project || this.current.epoch !== ref.epoch) throw error("stale_request", "This project is no longer open.");
    return this.current;
  }
  private emit(event: ProjectEvent) {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try { listener(copy(event)); } catch (cause) { console.error("Project listener failed", cause); }
    }
  }
  private emitFailure(cause: unknown, op?: Operation) {
    if (!this.listeners.size && this.startupFailures.length < 8) this.startupFailures.push(asFailure(cause, op));
    this.emit({ kind: "failure", project: this.current ? { project: this.current.project, epoch: this.current.epoch } : null, failure: asFailure(cause, op) });
  }
  private serial<T>(op: Operation, run: () => Promise<T>): Promise<T> {
    this.assertLive();
    if (this.queued >= 32) return Promise.reject(error("queue_full", "Too many pending project operations.", op));
    this.queued++;
    const pending = this.queue.catch(() => {}).then(async () => {
      await this.initialize();
      this.assertLive();
      abort(op);
      return run();
    });
    this.queue = pending;
    return pending.finally(() => { this.queued--; });
  }
  private changed(state: State, reason: "disk" | "save" | "conflict" | "recovery") {
    state.replacementAllowed = null;
    this.closeTokens.clear();
    this.emit({ kind: "changed", snapshot: this.snapshot(state), reason });
  }
  private snapshot(state: State): ProjectSnapshot {
    const resources: ResourceDescriptor[] = Object.entries(state.assets).map(([path, asset]) => ({
      id: `asset:${path}`, path, kind: asset.format, version: asset.version, byteLength: asset.byteLength,
      linked: false, availability: { available: true, reason: null },
    }));
    return { project: state.project, epoch: state.epoch, ...copy(state.settings), entries: [...(state.settings.entries ?? [])],
      sourceVersion: state.sourceVersion, diskGeneration: state.diskGeneration, settingsDiskVersion: state.settingsBase.version,
      files: [...state.files.values()].map(({ base: _base, priorBase: _priorBase, ...file }) => ({ ...file })), resources,
      conflicts: copy([...state.conflicts.values()]), dirty: dirty(state), rootLabel: state.rootLabel,
      ...(state.gist ? { gist: state.gist } : {}) };
  }
  private invalidate(state: State) { state.replacementAllowed = null; this.closeTokens.clear(); }
  private advanceDisk(state: State) { state.diskGeneration = String(BigInt(state.diskGeneration) + 1n); this.invalidate(state); }
  private validateStored(stored: Stored) {
    settings(stored);
    validateFiles(stored.files);
    assetTransfers(stored.assets ?? {});
    if (!Object.hasOwn(stored.files, stored.entry) && !stored._web?.buffers.some((file) => file.path === stored.entry)) throw error("invalid_source", "The saved project has no entrypoint.");
    if (stored._web) {
      if (stored._web.buffers.length > MAX_FILES) throw error("too_large", "Recovery contains too many canonical files.");
      const ids = new Set<string>(), paths = new Set<string>();
      for (const file of stored._web.buffers) {
        normalizeProjectPath(file.path);
        versionNumber(file.bufferVersion);
        if (!file.id || ids.has(file.id) || paths.has(file.path) || file.path === SETTINGS ||
            typeof file.text !== "string" || (file.base !== null && typeof file.base !== "string") ||
            typeof file.deleted !== "boolean" || (file.diskVersion !== null && typeof file.diskVersion !== "string"))
          throw error("invalid_source", "Recovery contains an invalid canonical buffer.");
        ids.add(file.id); paths.add(file.path);
      }
    }
  }
  private async makeState(value: ProjectSettings, files: Record<string, string>, assets: Assets, root: DirectoryHandle | null = null, settingsSource: string | null = settingsText(value), project = uid("project")): Promise<State> {
    const config = settings(value);
    validateFiles(files);
    await verifiedAssetTransfers(assets);
    if (!(config.entry in files)) throw error("invalid_source", `Entrypoint ${config.entry} is missing.`);
    if (SETTINGS in files) throw error("invalid_source", "muzpad.json is managed through project settings.");
    for (const path of Object.keys(assets)) if (path in files) throw error("invalid_source", `Duplicate project path: ${path}`);
    const records = await Promise.all(Object.entries(files).map(async ([path, text]): Promise<[string, FileState]> => {
      const disk = await baseline(text);
      const id = uid("file");
      return [id, { id, path, kind: fileKind(path), readOnly: false, bufferVersion: 0, diskVersion: disk.version, text, dirty: false, deleted: false, base: text }];
    }));
    return { project, epoch: uid("epoch"), settings: config, settingsBase: await baseline(settingsSource), sourceVersion: 0,
      diskGeneration: "0", files: new Map(records), assets: Object.freeze(copy(assets)), conflicts: new Map(), root,
      rootLabel: root?.name ?? null, folder: !!root, replacementAllowed: null };
  }
  private async fromStored(stored: Stored, reconnect = false): Promise<State> {
    this.validateStored(stored);
    const sourceFiles = { ...stored.files };
    // Recovery may contain a deliberately deleted entry; retain its canonical tombstone.
    if (!(stored.entry in sourceFiles)) sourceFiles[stored.entry] = "";
    const state = await this.makeState(stored, sourceFiles, stored.assets ?? {}, null, stored._web?.settingsBase.text ?? settingsText(settings(stored)), stored.id);
    state.gist = stored._gist === undefined ? undefined : parseGist(stored._gist);
    state.rootLabel = reconnect ? stored.folderName ?? null : null;
    if (stored._web) {
      state.folder = reconnect && stored._web.folder;
      versionNumber(stored._web.sourceVersion);
      if (!/^(0|[1-9]\d*)$/.test(stored._web.diskGeneration)) throw error("invalid_source", "Invalid recovery disk generation.");
      state.sourceVersion = stored._web.sourceVersion;
      state.diskGeneration = stored._web.diskGeneration;
      state.settingsBase = copy(stored._web.settingsBase);
      state.files = new Map(stored._web.buffers.map((file) => [file.id, copy(file)]));
      state.conflicts = new Map(stored._web.conflicts.map((conflict) => [conflict.fileId, copy(conflict)]));
      if (state.folder) {
        try { state.root = await loadProjectDirectory(state.project) as DirectoryHandle | null; }
        catch (cause) { this.emitFailure(cause); }
      }
    }
    return state;
  }
  private stored(state: State): Stored {
    return { id: state.project, ...copy(state.settings), files: workingFiles(state), assets: copy(state.assets), ...(state.rootLabel ? { folderName: state.rootLabel } : {}),
      ...(state.gist ? { _gist: state.gist } : {}),
      _web: { sourceVersion: state.sourceVersion, diskGeneration: state.diskGeneration, settingsBase: copy(state.settingsBase),
        buffers: copy([...state.files.values()]), conflicts: copy([...state.conflicts.values()]), updatedAt: new Date().toISOString(), folder: state.folder } };
  }
  private offer(id: string, stored: Stored) {
    const offer: RecoveryOffer = { id, project: stored.id, title: stored.title, rootLabel: stored.folderName ?? null, updatedAt: stored._web?.updatedAt ?? new Date().toISOString() };
    this.offers.set(id, offer);
    this.emit({ kind: "recovery", offer });
  }
  private async remember(state: State) {
    const item: RecentProject = { project: state.project, title: state.settings.title, rootLabel: state.rootLabel ?? "Browser copy", available: true, lastOpened: new Date().toISOString() };
    const all = [item, ...this.recents.filter((recent) => recent.project !== state.project)];
    this.recents = all.slice(0, MAX_RECENTS);
    await saveStoredProject(recentKey(state.project), this.stored(state));
    if (state.root) await saveProjectDirectory(state.project, state.root);
    localStorage.setItem(RECENTS, JSON.stringify(this.recents));
    for (const old of all.slice(MAX_RECENTS)) {
      await removeStoredProject(recentKey(old.project));
      await removeProjectDirectory(old.project);
    }
  }
  private async preserve(state: State) {
    const stored = this.stored(state);
    await saveStoredProject(PREVIOUS, stored);
    this.recovery.set(PREVIOUS, stored);
    this.offer(PREVIOUS, stored);
  }
  private async install(next: State, op: Operation): Promise<ProjectSnapshot> {
    abort(op);
    const prior = this.current;
    if (prior && dirty(prior) && prior.replacementAllowed !== fingerprint(prior)) throw error("source_conflict", "Close or save the current working project before replacing it.", op);
    if (prior && this.exports?.active()) throw error("exports_active", "Wait for running exports or cancel them before replacing the project.", op);
    const priorIdentity = prior ? fingerprint(prior) : null;
    if (prior) await this.preserve(prior);
    abort(op);
    if (prior && fingerprint(prior) !== priorIdentity) throw error("stale_request", "The working copy changed while preserving Previous; review the latest edits.", op);
    if (prior) await this.runtime?.replace();
    abort(op);
    if (prior && fingerprint(prior) !== priorIdentity) throw error("stale_request", "The working copy changed during runtime replacement; its buffers are preserved.", op);
    this.current = next;
    this.closeTokens.clear();
    try {
      await saveStoredProject(DRAFT, this.stored(next));
      await this.remember(next);
    } catch (cause) { this.emitFailure(cause, op); }
    this.changed(next, "recovery");
    if (next.root) this.emit({ kind: "watch", project: { project: next.project, epoch: next.epoch }, state: "degraded", failure: failure("watch_unavailable", "Browser folders are refreshed explicitly; automatic watching is unavailable.") });
    return this.snapshot(next);
  }

  private capture(input: WorkingCapture): { state: State; input: WorkingCapture } {
    const captured = copy(input);
    const state = this.state(captured);
    versionNumber(captured.sourceVersion);
    if (captured.sourceVersion < state.sourceVersion || captured.expectedDiskGeneration !== state.diskGeneration || captured.settingsDiskVersion !== state.settingsBase.version) throw error("stale_request", "The project changed; capture its current buffers again.");
    const config = settings(captured.settings);
    if (captured.entry !== config.entry) throw error("invalid_source", "Captured entry and settings must match.");
    captured.settings = config;
    this.validateBuffers(state, captured.buffers, true);
    const changed = captured.buffers.some((buffer) => {
      const file = state.files.get(buffer.fileId);
      return !file || file.bufferVersion !== buffer.bufferVersion || localText(file) !== buffer.text;
    }) || !sameSettings(config, state.settings);
    if (changed && captured.sourceVersion <= state.sourceVersion) throw error("stale_request", "Changed buffers require a newer source version.");
    const conflictsBefore = state.conflicts.size;
    for (const buffer of captured.buffers) this.adoptBuffer(state, buffer);
    state.settings = config;
    state.sourceVersion = captured.sourceVersion;
    if (changed) this.invalidate(state);
    if (state.conflicts.size > conflictsBefore) this.changed(state, "conflict");
    return { state, input: captured };
  }
  private validateBuffers(state: State, buffers: BufferCapture[], complete: boolean) {
    if (buffers.length > MAX_FILES) throw error("too_large", "A working copy may contain at most 500 canonical files.");
    if (state.files.size + buffers.filter((buffer) => !state.files.has(buffer.fileId)).length > MAX_FILES) throw error("too_large", "A working copy may contain at most 500 canonical files.");
    const ids = new Set<string>();
    const paths = new Set<string>();
    const texts: Record<string, string> = Object.create(null);
    for (const buffer of buffers) {
      versionNumber(buffer.bufferVersion);
      normalizeProjectPath(buffer.path);
      if (!buffer.fileId || ids.has(buffer.fileId) || paths.has(buffer.path) || buffer.path === SETTINGS || buffer.path in state.assets) throw error("invalid_source", "Captured files must have unique project identities and paths.");
      ids.add(buffer.fileId); paths.add(buffer.path);
      if (buffer.text !== null) {
        if (typeof buffer.text !== "string") throw error("invalid_source", "Captured source must be text or an explicit deletion.");
        texts[buffer.path] = buffer.text;
      }
      const file = state.files.get(buffer.fileId);
      const pathFile = [...state.files.values()].find((candidate) => candidate.path === buffer.path);
      if (file && (file.path !== buffer.path || file.readOnly)) throw error("denied_path", "A captured file cannot change identity or edit a library document.");
      if (!file && (pathFile || buffer.expectedDiskVersion !== null)) throw error("source_conflict", "A new file must have a unique path and a missing-disk baseline.");
      if (file && buffer.bufferVersion === file.bufferVersion && buffer.text !== localText(file)) throw error("stale_request", "A buffer changed without incrementing its version.");
      if (complete && file && (buffer.bufferVersion < file.bufferVersion ||
          (buffer.expectedDiskVersion !== file.diskVersion &&
            (buffer.bufferVersion <= file.bufferVersion || state.conflicts.has(file.id)))))
        throw error("stale_request", "A captured buffer no longer matches the acknowledged working copy.");
    }
    if (complete && [...state.files.values()].some((file) => !file.readOnly && !ids.has(file.id))) throw error("invalid_source", "A source capture must include every canonical buffer, including closed and deleted files.");
    const combined = complete ? texts : { ...workingFiles(state), ...texts };
    validateFiles(combined);
  }
  private adoptBuffer(state: State, buffer: BufferCapture) {
    let file = state.files.get(buffer.fileId);
    if (!file) {
      file = { id: buffer.fileId, path: buffer.path, kind: fileKind(buffer.path), readOnly: false, bufferVersion: buffer.bufferVersion,
        diskVersion: null, text: buffer.text ?? "", dirty: true, deleted: buffer.text === null, base: null };
      state.files.set(file.id, file);
    } else if (buffer.bufferVersion >= file.bufferVersion) {
      let racedDisk: Baseline | undefined;
      if (buffer.bufferVersion > file.bufferVersion && buffer.expectedDiskVersion !== file.diskVersion &&
          !state.conflicts.has(file.id)) {
        racedDisk = { text: file.base, version: file.diskVersion };
        // The newer local edit was made against the pre-refresh baseline, not this disk text.
        file.base = file.priorBase?.version === buffer.expectedDiskVersion ? file.priorBase.text : null;
        file.diskVersion = buffer.expectedDiskVersion;
      }
      file.text = buffer.text ?? file.text;
      file.deleted = buffer.text === null;
      file.bufferVersion = buffer.bufferVersion;
      if (racedDisk) this.conflict(state, file, racedDisk);
    }
    updateDirty(file);
    const conflict = state.conflicts.get(file.id);
    if (conflict) { conflict.local = localText(file); conflict.bufferVersion = file.bufferVersion; }
  }

  chooseFolder(op: Operation): Promise<ProjectSnapshot | null> {
    return this.serial(op, async () => {
      if (!canMountFolder()) {
        const picked = await this.pickFiles(true, op);
        if (!picked?.length) return null;
        const entries: Record<string, Uint8Array> = {};
        let total = 0;
        for (const file of picked) {
          const path = file.webkitRelativePath.split("/").slice(1).join("/");
          if (!/\.(muz|md|mid|midi|wav|flac)$/i.test(path) && path !== SETTINGS) continue;
          total += file.size;
          if (total > ASSET_LIMITS.maxTotalBytes + MAX_TEXT_BYTES) throw error("too_large", "Folder exceeds the project import limit.", op);
          entries[path] = new Uint8Array(await file.arrayBuffer());
        }
        const data = await importArchiveEntries(entries);
        const title = picked[0].webkitRelativePath.split("/")[0] || "Imported project";
        return this.install(await this.fromFiles(data.files, data.assets, title), op);
      }
      let root: DirectoryHandle;
      try { root = await pickFolder(); } catch (cause) { if ((cause as Error).name === "AbortError") return null; throw cause; }
      const data = await readProjectFolder(root);
      let project: string | undefined;
      if (this.current?.root?.isSameEntry && await this.current.root.isSameEntry(root)) project = this.current.project;
      if (!project && root.isSameEntry) {
        for (const recent of this.recents) {
          const handle = await loadProjectDirectory(recent.project).catch(() => null);
          if (handle && await root.isSameEntry(handle)) { project = recent.project; break; }
        }
      }
      return this.install(await this.fromFiles(data.files, data.assets, root.name, root, project), op);
    });
  }
  private async fromFiles(files: Record<string, string>, assets: Assets, title: string, root: DirectoryHandle | null = null, project?: string) {
    const source = { ...files };
    const raw = source[SETTINGS] ?? null;
    delete source[SETTINGS];
    const first = Object.keys(source).filter((path) => /\.muz$/i.test(path)).sort();
    if (!first.length) throw error("invalid_source", "This project contains no muz source files.");
    let parsed: unknown;
    try { parsed = raw === null ? null : JSON.parse(raw); } catch { parsed = null; }
    const metadata = parsed && typeof parsed === "object" ? parsed : {};
    const preferred = "entry" in metadata && typeof metadata.entry === "string" ? metadata.entry : "";
    const entry = first.includes(preferred) ? preferred : first.includes("song.muz") ? "song.muz" : first[0];
    const entries = "entries" in metadata && Array.isArray(metadata.entries)
      ? metadata.entries.filter((path): path is string => typeof path === "string" && first.includes(path)) : [];
    const config = settings({ title: "title" in metadata && typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : title, entry, entries });
    return this.makeState(config, source, assets, root, root ? raw : settingsText(config), project);
  }
  async listRecent(): Promise<RecentProject[]> {
    await this.initialize(); this.assertLive();
    return Promise.all(this.recents.map(async (recent) => {
      let available = false;
      try {
        available = hasStoredProject(recentKey(recent.project));
        if (available && recent.rootLabel !== "Browser copy") {
          const root = await loadProjectDirectory(recent.project) as DirectoryHandle | null;
          available = !!root && await root.queryPermission({ mode: "readwrite" }) !== "denied";
        }
      } catch { available = false; }
      return { ...recent, available };
    }));
  }
  openRecent(project: string, op: Operation): Promise<ProjectSnapshot> {
    return this.serial(op, async () => {
      const stored = await loadStoredProject(recentKey(project)) as Stored | null;
      if (!stored || stored.id !== project) throw error("grant_required", "This recent project is no longer available.", op);
      const state = await this.fromStored(stored, true);
      if (stored._web?.folder) {
        if (!state.root) throw error("grant_required", "Reconnect the project folder to reopen it.", op);
        await this.permission(state.root, op);
        const data = await readProjectFolder(state.root);
        return this.install(await this.fromFiles(data.files, data.assets, state.root.name, state.root, project), op);
      }
      return this.install(state, op);
    });
  }
  newProject(value: ProjectSettings, op: Operation): Promise<ProjectSnapshot> {
    const config = settings(copy(value));
    return this.serial(op, async () => this.install(await this.makeState(config, { [config.entry]: starter }, {}), op));
  }
  importProject(input: ImportInput, op: Operation): Promise<ProjectSnapshot | null> {
    const captured = copy(input);
    return this.serial(op, async () => {
      if (captured.kind === "zipDialog") {
        const file = (await this.pickFiles(false, op))?.[0];
        if (!file) return null;
        if (file.size > ASSET_LIMITS.maxTotalBytes + MAX_TEXT_BYTES) throw error("too_large", "Choose a project ZIP under 68 MB.", op);
        let total = 0;
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
          if (!/\.(muz|md|mid|midi|wav|flac)$/i.test(entry.name) && entry.name !== SETTINGS) return false;
          total += entry.originalSize;
          if (entry.originalSize > ASSET_LIMITS.maxFileBytes || total > ASSET_LIMITS.maxTotalBytes + MAX_TEXT_BYTES) throw error("too_large", "ZIP expands beyond the project import limit.", op);
          return true;
        } });
        const data = await importArchiveEntries(archive);
        return this.install(await this.fromFiles(data.files, data.assets, file.name.replace(/\.zip$/i, "")), op);
      }
      const files: Record<string, string> = {};
      for (const file of captured.project.files) {
        const path = normalizeProjectPath(file.path);
        if (Object.hasOwn(files, path)) throw error("invalid_source", `Duplicate project path: ${path}`, op);
        files[path] = file.text;
      }
      const assets: Assets = {};
      let total = 0;
      if (captured.project.assets.length > ASSET_LIMITS.maxFiles) throw error("too_large", "Too many project assets.", op);
      for (const asset of captured.project.assets) {
        const path = normalizeProjectPath(asset.path);
        if (asset.format !== assetFormat(path) || Object.hasOwn(assets, path) || Object.hasOwn(files, path)) throw error("invalid_source", `Invalid or duplicate asset: ${path}`, op);
        if (asset.base64.length > Math.ceil(ASSET_LIMITS.maxFileBytes / 3) * 4) throw error("too_large", `Asset is too large: ${path}`, op);
        const bytes = Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0));
        total += bytes.byteLength;
        if (total > ASSET_LIMITS.maxTotalBytes) throw error("too_large", "Project assets exceed the import limit.", op);
        assets[path] = await createAsset(path, bytes);
      }
      if (captured.project.gist !== undefined && (typeof captured.project.gist !== "string" ||
          !/^[a-f0-9]{32,40}(?:\/[a-f0-9]{40})?$/.test(captured.project.gist)))
        throw error("invalid_source", "Invalid imported gist origin.", op);
      const state = await this.makeState(captured.project.settings, files, assets);
      state.gist = captured.project.gist;
      return this.install(state, op);
    });
  }
  private pickFiles(folder: boolean, op: Operation): Promise<File[] | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.hidden = true;
      if (folder) { input.multiple = true; input.setAttribute("webkitdirectory", ""); }
      else input.accept = ".zip,application/zip";
      const cleanup = () => { input.remove(); op.signal?.removeEventListener("abort", cancelled); };
      const cancelled = () => { cleanup(); reject(error("cancelled", "Project selection cancelled.", op)); };
      input.onchange = () => { const files = Array.from(input.files ?? []); cleanup(); resolve(files.length ? files : null); };
      input.addEventListener("cancel", () => { cleanup(); resolve(null); }, { once: true });
      op.signal?.addEventListener("abort", cancelled, { once: true });
      document.body.append(input);
      if (op.signal?.aborted) cancelled(); else input.click();
    });
  }

  async readLibraryDocument(input: { project: ProjectRef | null; id: string }, op: Operation) {
    await this.initialize(); this.assertLive(); abort(op);
    if (input.project) this.state(input.project);
    const path = normalizeProjectPath(input.id.startsWith("library:") ? input.id.slice(8) : input.id);
    const text = this.libraries[path];
    if (typeof text !== "string") throw error("missing_module", `Library document is unavailable: ${path}`, op);
    return { id: `library:${path}`, path, text, kind: fileKind(path) };
  }
  async resolveSourceDocument(input: { project: ProjectRef; path: string }, op: Operation): Promise<ResolvedSourceDocument | null> {
    await this.initialize(); this.assertLive(); abort(op);
    const state = this.state(input.project);
    const path = normalizeProjectPath(input.path);
    const file = [...state.files.values()].find(file => !file.deleted && file.path === path);
    if (file) return { kind: "project", path: file.path, fileId: file.id };
    const libraryPath = Object.hasOwn(this.libraries, path) ? path
      : path.startsWith("std/") && !path.endsWith(".muz") && Object.hasOwn(this.libraries, `${path}.muz`) ? `${path}.muz` : null;
    if (libraryPath === null) return null;
    return { kind: "library", id: `library:${libraryPath}`, path: libraryPath,
      text: this.libraries[libraryPath], documentKind: fileKind(libraryPath) };
  }
  async snapshotSources(input: WorkingCapture, op: Operation): Promise<SourceSnapshot> {
    abort(op);
    const { state, input: captured } = this.capture(input);
    if (state.conflicts.size) throw error("source_conflict", "Resolve project conflicts before rebuilding.", op);
    const snapshot: SourceSnapshot = { id: uid("source"), project: state.project, epoch: state.epoch,
      sourceVersion: captured.sourceVersion, entry: captured.entry, diskGeneration: state.diskGeneration,
      files: captured.buffers.filter((buffer) => buffer.text !== null).map((buffer) => ({ fileId: buffer.fileId, path: buffer.path, bufferVersion: buffer.bufferVersion, diskVersion: buffer.expectedDiskVersion })) };
    const files = { ...this.libraries, ...Object.fromEntries(captured.buffers.filter((buffer) => buffer.text !== null).map((buffer) => [buffer.path, buffer.text as string])) };
    for (const buffer of captured.buffers) if (buffer.text === null) delete files[buffer.path];
    if (!captured.buffers.some((buffer) => buffer.path === captured.entry && buffer.text !== null)) throw error("missing_module", `Entrypoint ${captured.entry} is deleted.`, op);
    for (const file of snapshot.files) Object.freeze(file);
    Object.freeze(snapshot.files);
    Object.freeze(snapshot);
    const clean = [...state.files.values()].filter((file) => !file.dirty).map((file) => ({ path: file.path, version: file.diskVersion }));
    if (!settingsDirty(state)) clean.push({ path: SETTINGS, version: state.settingsBase.version });
    this.snapshots.set(snapshot.id, { snapshot, files: Object.freeze(files), assets: state.assets, title: state.settings.title, pins: 0, root: state.root, folder: state.folder, clean });
    this.pruneSnapshots();
    return copy(snapshot);
  }
  getSourceSnapshotMetadata(id: string): SourceSnapshot {
    this.assertLive();
    const source = this.snapshots.get(id);
    if (!source) throw error("expired_revision", "The immutable source capture has expired; capture the project again.");
    return source.snapshot;
  }
  getSourceSnapshot(id: string): { snapshot: SourceSnapshot; files: Record<string, string>; assets: AssetTransfer[]; title: string } {
    this.assertLive();
    const source = this.snapshots.get(id);
    if (!source) throw error("expired_revision", "The immutable source capture has expired; capture the project again.");
    // assets.js validates format strings against the same closed format vocabulary.
    const assets = assetTransfers(source.assets) as AssetTransfer[];
    return { snapshot: source.snapshot, files: source.files, assets, title: source.title };
  }
  async validateSourceSnapshot(id: string, recovery = false): Promise<void> {
    this.assertLive();
    const source = this.snapshots.get(id);
    if (!source) throw error("expired_revision", "The source snapshot has expired.");
    const state = this.state(source.snapshot);
    // Explicit engine recovery reuses the accepted immutable capture, not later edits.
    if (recovery) return;
    if (state.conflicts.size) throw error("source_conflict", "Resolve project conflicts before applying a rebuild.");
    if (source.folder && !source.root) throw error("grant_required", "Reconnect the project folder before rebuilding clean disk dependencies.");
    if (state.sourceVersion !== source.snapshot.sourceVersion || state.diskGeneration !== source.snapshot.diskGeneration) throw error("stale_request", "The source capture changed during preparation.");
    if (source.root) {
      for (const file of source.clean) {
        const disk = await baseline(await this.diskText(source.root, file.path));
        if (disk.version !== file.version) throw error("source_conflict", `Clean dependency ${file.path} changed on disk; refresh before rebuilding.`, undefined, file.path);
      }
    }
    this.state(source.snapshot);
    if (state.conflicts.size) throw error("source_conflict", "Resolve project conflicts before applying a rebuild.");
    if (state.sourceVersion !== source.snapshot.sourceVersion || state.diskGeneration !== source.snapshot.diskGeneration) throw error("stale_request", "The source capture changed during preparation.");
  }
  pinSourceSnapshot(id: string): void {
    this.assertLive();
    const source = this.snapshots.get(id);
    if (!source) throw error("expired_revision", "The source snapshot has expired.");
    if (!source.pins && [...this.snapshots.values()].filter((item) => item.pins > 0).length >= MAX_PINNED) throw error("resource_budget", "Too many source snapshots are pinned.");
    source.pins++;
  }
  releaseSourceSnapshot(id: string): void {
    const source = this.snapshots.get(id);
    if (source?.pins) source.pins--;
    this.pruneSnapshots();
  }
  private pruneSnapshots() {
    let unpinned = [...this.snapshots.values()].filter((source) => !source.pins).length;
    for (const [id, source] of this.snapshots) if (!source.pins && unpinned > MAX_SNAPSHOTS) { this.snapshots.delete(id); unpinned--; }
  }

  persistRecovery(input: WorkingCapture, op: Operation): Promise<void> {
    abort(op);
    const { state } = this.capture(input);
    return this.serial(op, async () => {
      this.state(state);
      const stored = this.stored(state);
      await saveStoredProject(DRAFT, stored);
      this.recovery.set(DRAFT, stored);
    });
  }
  restoreRecovery(input: { id: string; action: "restore" | "discard" }, op: Operation): Promise<ProjectSnapshot | null> {
    return this.serial(op, async () => {
      if (input.id !== DRAFT && input.id !== PREVIOUS) throw error("denied_path", "Unknown recovery identity.", op);
      const stored = await loadStoredProject(input.id) as Stored | null ?? this.recovery.get(input.id);
      if (!stored) throw error("stale_request", "This recovery copy is no longer available.", op);
      if (input.action === "discard") {
        await removeStoredProject(input.id);
        this.offers.delete(input.id); this.recovery.delete(input.id);
        return null;
      }
      const state = await this.fromStored(stored);
      const result = await this.install(state, op);
      if (input.id !== PREVIOUS) this.offers.delete(input.id);
      return result;
    });
  }

  private async permission(root: DirectoryHandle, op: Operation) {
    const mode = { mode: "readwrite" } as const;
    if (await root.queryPermission(mode) !== "granted" && await root.requestPermission(mode) !== "granted") throw error("permission_denied", "Folder access was not granted. Your working copy is preserved; download a ZIP to keep it.", op);
  }
  private async fileDirectory(root: DirectoryHandle, path: string, create: boolean) {
    const parts = normalizeProjectPath(path).split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name: parts.at(-1)! };
  }
  private async diskText(root: DirectoryHandle, path: string): Promise<string | null> {
    try {
      const { directory, name } = await this.fileDirectory(root, path, false);
      return await (await (await directory.getFileHandle(name)).getFile()).text();
    } catch (cause) { if ((cause as Error).name === "NotFoundError") return null; throw cause; }
  }
  private async writeText(root: DirectoryHandle, path: string, text: string | null) {
    if (text === null) {
      try { const { directory, name } = await this.fileDirectory(root, path, false); await directory.removeEntry(name); }
      catch (cause) { if ((cause as Error).name !== "NotFoundError") throw cause; }
      return;
    }
    const { directory, name } = await this.fileDirectory(root, path, true);
    const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
    try { await writer.write(text); await writer.close(); }
    catch (cause) { await writer.abort().catch(() => {}); throw cause; }
  }
  private conflict(state: State, file: FileState, disk: Baseline): SourceConflict {
    const conflict = { fileId: file.id, path: file.path, base: file.base, local: localText(file), disk: disk.text,
      baseVersion: file.diskVersion, diskVersion: disk.version, bufferVersion: file.bufferVersion };
    state.conflicts.set(file.id, conflict);
    return conflict;
  }
  save(input: SaveInput, op: Operation): Promise<SaveResult> {
    abort(op);
    const captured = copy(input);
    const state = this.state(captured);
    const config = settings(captured.settings);
    this.validateBuffers(state, captured.files, false);
    for (const buffer of captured.files) this.adoptBuffer(state, buffer);
    state.settings = config;
    this.invalidate(state);
    return this.serial(op, async () => this.saveCaptured(state, captured, op));
  }
  private async saveCaptured(state: State, input: SaveInput, op: Operation): Promise<SaveResult> {
    this.state(state);
    const result: SaveResult = { saved: [], conflicts: [], failures: [], settingsDiskVersion: state.settingsBase.version, settingsSaved: false, diskGeneration: state.diskGeneration };
    const oldBaselines = new Map([...state.files.values()].map((file) => [file.id, { text: file.base, version: file.diskVersion }]));
    const oldSettings = state.settingsBase;
    const oldGeneration = state.diskGeneration;
    let observedChange = false;
    if (state.folder && !state.root) {
      result.failures.push({ fileId: null, failure: failure("grant_required", "Reconnect the project folder before saving, or export a ZIP of the preserved working copy.", op) });
      return result;
    }
    if (state.root) {
      try { await this.permission(state.root, op); }
      catch (cause) { result.failures.push({ fileId: null, failure: asFailure(cause, op) }); return result; }
    }
    for (const buffer of input.files) {
      const file = state.files.get(buffer.fileId)!;
      try {
        abort(op);
        const unresolved = state.conflicts.get(file.id);
        if (unresolved) {
          result.conflicts.push(copy(unresolved));
          continue;
        }
        const disk = state.root ? await baseline(await this.diskText(state.root, buffer.path)) : { text: file.base, version: file.diskVersion };
        if (disk.version !== buffer.expectedDiskVersion) {
          result.conflicts.push(copy(this.conflict(state, file, disk)));
          observedChange = true;
          continue;
        }
        if (state.root && disk.text !== buffer.text) await this.writeText(state.root, buffer.path, buffer.text);
        const saved = await baseline(buffer.text);
        if (saved.version !== file.diskVersion) {
          observedChange = true;
          file.priorBase = { text: file.base, version: file.diskVersion };
        }
        file.base = saved.text; file.diskVersion = saved.version; updateDirty(file);
        state.conflicts.delete(file.id);
        result.saved.push({ fileId: buffer.fileId, bufferVersion: buffer.bufferVersion, diskVersion: saved.version });
      } catch (cause) { result.failures.push({ fileId: buffer.fileId, failure: asFailure(cause, op, buffer.path) }); }
    }
    try {
      abort(op);
      const disk = state.root ? await baseline(await this.diskText(state.root, SETTINGS)) : state.settingsBase;
      if (disk.version !== input.settingsDiskVersion) {
        observedChange = true;
        state.conflicts.set(`${state.project}:settings`, { fileId: `${state.project}:settings`, path: SETTINGS,
          base: state.settingsBase.text, local: settingsText(state.settings), disk: disk.text,
          baseVersion: state.settingsBase.version, diskVersion: disk.version, bufferVersion: state.sourceVersion });
        result.failures.push({ fileId: null, failure: failure("source_conflict", "Project settings changed outside muzpad. Refresh and resolve the settings conflict.", op, SETTINGS) });
      } else {
        const text = settingsText(settings(input.settings));
        if (state.root && disk.text !== text) await this.writeText(state.root, SETTINGS, text);
        const saved = await baseline(text);
        if (saved.version !== state.settingsBase.version) observedChange = true;
        state.settingsBase = saved;
        state.conflicts.delete(`${state.project}:settings`);
        result.settingsSaved = true;
      }
    } catch (cause) { result.failures.push({ fileId: null, failure: asFailure(cause, op, SETTINGS) }); }
    if (observedChange) this.advanceDisk(state);
    result.settingsDiskVersion = state.settingsBase.version;
    result.diskGeneration = state.diskGeneration;
    let durable = !!state.root;
    try {
      // Persist one complete browser checkpoint before publishing successful saves.
      await saveStoredProject(recentKey(state.project), this.stored(state));
      durable = true;
      await saveStoredProject(DRAFT, this.stored(state));
      await this.remember(state);
    } catch (cause) {
      result.failures.push({ fileId: null, failure: asFailure(cause, op) });
      if (!durable) {
        for (const file of state.files.values()) {
          const old = oldBaselines.get(file.id);
          if (old) { file.base = old.text; file.diskVersion = old.version; updateDirty(file); }
        }
        state.settingsBase = oldSettings;
        state.diskGeneration = oldGeneration;
        result.saved = []; result.settingsSaved = false;
        result.settingsDiskVersion = oldSettings.version; result.diskGeneration = oldGeneration;
      }
    }
    this.changed(state, result.conflicts.length || state.conflicts.size ? "conflict" : "save");
    return result;
  }

  refresh(input: WorkingCapture, op: Operation): Promise<ProjectSnapshot> {
    abort(op);
    const { state } = this.capture(input);
    return this.serial(op, async () => {
      this.state(state);
      if (state.folder && !state.root) throw error("grant_required", "Reconnect the project folder before refreshing its working copy.", op);
      if (!state.root) return this.snapshot(state);
      let disk: { files: Record<string, string>; assets: Assets };
      try { disk = await readProjectFolder(state.root); }
      catch (cause) {
        this.emit({ kind: "watch", project: { project: state.project, epoch: state.epoch }, state: (cause as Error).name === "NotFoundError" ? "rootMissing" : "degraded", failure: asFailure(cause, op) });
        throw cause;
      }
      abort(op);
      const versions = new Map(await Promise.all(Object.entries(disk.files).map(async ([path, text]) => [path, await baseline(text)] as const)));
      let changed = false;
      let sourcesChanged = false;
      const paths = new Set<string>();
      for (const file of state.files.values()) {
        paths.add(file.path);
        const observed = versions.get(file.path) ?? { text: null, version: null };
        const previous = state.conflicts.get(file.id);
        if (observed.version === file.diskVersion) {
          if (previous) { state.conflicts.delete(file.id); changed = true; }
          continue;
        }
        if (previous?.diskVersion !== observed.version) changed = true;
        if ((file.dirty || previous) && localText(file) !== observed.text) this.conflict(state, file, observed);
        else {
          file.priorBase = { text: file.base, version: file.diskVersion };
          if (localText(file) !== observed.text) { file.text = observed.text ?? file.text; file.deleted = observed.text === null; file.bufferVersion++; sourcesChanged = true; }
          file.base = observed.text; file.diskVersion = observed.version; updateDirty(file);
          state.conflicts.delete(file.id);
        }
      }
      for (const [path, observed] of versions) if (path !== SETTINGS && !paths.has(path)) {
        const id = uid("file");
        state.files.set(id, { id, path, kind: fileKind(path), text: observed.text!, base: observed.text, diskVersion: observed.version, bufferVersion: 0, readOnly: false, deleted: false, dirty: false });
        changed = true; sourcesChanged = true;
      }
      const observedSettings = versions.get(SETTINGS) ?? { text: null, version: null };
      const settingsId = `${state.project}:settings`;
      if (observedSettings.version !== state.settingsBase.version) {
        if (state.conflicts.get(settingsId)?.diskVersion !== observedSettings.version) changed = true;
        if (settingsDirty(state) || observedSettings.text === null) {
          state.conflicts.set(settingsId, { fileId: settingsId, path: SETTINGS, base: state.settingsBase.text, local: settingsText(state.settings), disk: observedSettings.text,
            baseVersion: state.settingsBase.version, diskVersion: observedSettings.version, bufferVersion: state.sourceVersion });
        } else {
          try { state.settings = settings(JSON.parse(observedSettings.text)); state.settingsBase = observedSettings; state.conflicts.delete(settingsId); sourcesChanged = true; }
          catch (cause) { this.emitFailure(cause, op); state.conflicts.set(settingsId, { fileId: settingsId, path: SETTINGS, base: state.settingsBase.text, local: settingsText(state.settings), disk: observedSettings.text, baseVersion: state.settingsBase.version, diskVersion: observedSettings.version, bufferVersion: state.sourceVersion }); }
        }
      } else if (state.conflicts.delete(settingsId)) changed = true;
      if (JSON.stringify(Object.entries(state.assets).map(([path, asset]) => [path, asset.version])) !== JSON.stringify(Object.entries(disk.assets).map(([path, asset]) => [path, asset.version]))) {
        state.assets = Object.freeze(copy(disk.assets)); changed = true; sourcesChanged = true;
      }
      if (sourcesChanged) state.sourceVersion++;
      if (changed) {
        this.advanceDisk(state);
        this.changed(state, state.conflicts.size ? "conflict" : "disk");
        try { await saveStoredProject(DRAFT, this.stored(state)); } catch (cause) { this.emitFailure(cause, op); }
      }
      return this.snapshot(state);
    });
  }
  resolveConflict(input: ProjectRef & { fileId: string; diskVersion: string | null; choice: "disk" | "local" | "merge"; mergedText?: string }, op: Operation): Promise<ProjectSnapshot> {
    const captured = copy(input);
    return this.serial(op, async () => {
      const state = this.state(captured);
      const conflict = state.conflicts.get(captured.fileId);
      if (!conflict || conflict.diskVersion !== captured.diskVersion) throw error("stale_request", "This conflict changed; refresh before resolving it.", op);
      if (captured.choice === "merge" && typeof captured.mergedText !== "string") throw error("invalid_source", "A merge needs explicit merged text.", op);
      const beforeResolution = fingerprint(state);
      if (state.root) {
        const actual = await baseline(await this.diskText(state.root, conflict.path));
        if (actual.version !== conflict.diskVersion) throw error("source_conflict", "The disk changed again; refresh before resolving this conflict.", op);
      }
      abort(op);
      if (fingerprint(state) !== beforeResolution) throw error("stale_request", "The working copy changed while resolving this conflict; review its latest text.", op);
      if (conflict.path === SETTINGS) {
        if (captured.choice !== "local") {
          const text = captured.choice === "disk" ? conflict.disk : captured.mergedText!;
          if (text === null) throw error("invalid_source", "Deleted settings cannot select an entrypoint; keep the local settings.", op);
          state.settings = settings(JSON.parse(text));
        }
        state.settingsBase = { text: conflict.disk, version: conflict.diskVersion };
      } else {
        const file = state.files.get(captured.fileId)!;
        if (captured.choice !== "local") {
          const text = captured.choice === "disk" ? conflict.disk : captured.mergedText!;
          file.text = text ?? file.text; file.deleted = text === null; file.bufferVersion++;
        }
        if (file.diskVersion !== conflict.diskVersion)
          file.priorBase = { text: file.base, version: file.diskVersion };
        file.base = conflict.disk; file.diskVersion = conflict.diskVersion; updateDirty(file);
      }
      state.conflicts.delete(captured.fileId);
      state.sourceVersion++;
      this.changed(state, "conflict");
      await saveStoredProject(DRAFT, this.stored(state));
      return this.snapshot(state);
    });
  }

  exportArchive(input: WorkingCapture, op: Operation): Promise<ArchiveResult> {
    abort(op);
    const { state } = this.capture(input);
    const files = { ...workingFiles(state), [SETTINGS]: settingsText(state.settings) };
    const assets = state.assets;
    const name = `${state.settings.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "muz-project"}.zip`;
    return this.serial(op, async () => {
      const archive = zipSync(projectArchiveEntries(files, assets));
      abort(op);
      const url = URL.createObjectURL(new Blob([archive as BlobPart], { type: "application/zip" }));
      try { const link = document.createElement("a"); link.href = url; link.download = name; link.click(); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
      return { name, linkedResources: [] };
    });
  }
  async reveal(input: ProjectRef & { id: string | null }, op: Operation): Promise<void> {
    this.state(input); abort(op);
    throw error("unsupported", "Browsers cannot reveal project files in a native file manager.", op);
  }
  prepareClose(input: CloseInput, op: Operation): Promise<CloseResult> {
    abort(op);
    const { state, input: captured } = this.capture(input.capture);
    return this.serial(op, async () => {
      this.state(state);
      if (input.decision === "cancel") return { allowed: false, token: null, save: null, failure: null };
      if (this.exports?.active()) {
        if (!input.cancelExports) return { allowed: false, token: null, save: null, failure: failure("exports_active", "Wait for running exports or choose to cancel them before closing.", op) };
        try { await this.exports.cancel(); }
        catch (cause) { return { allowed: false, token: null, save: null, failure: asFailure(cause, op) }; }
        if (this.exports.active()) return { allowed: false, token: null, save: null, failure: failure("exports_active", "An export is still completing; retry closing after it finishes.", op) };
      }
      const sourceIdentity = JSON.stringify([captured.sourceVersion, captured.settings, captured.buffers]);
      let saved: SaveResult | null = null;
      if (input.decision === "save") {
        saved = await this.saveCaptured(state, { project: state.project, epoch: state.epoch, files: captured.buffers,
          settings: captured.settings, settingsDiskVersion: captured.settingsDiskVersion }, op);
        if (saved.conflicts.length || saved.failures.length || !saved.settingsSaved || dirty(state)) return { allowed: false, token: null, save: saved, failure: failure("source_conflict", "Some changes remain unsaved. Resolve them before closing.", op) };
      }
      const latestIdentity = JSON.stringify([state.sourceVersion, state.settings, captured.buffers.map((buffer) => {
        const file = state.files.get(buffer.fileId)!;
        return { ...buffer, text: localText(file), bufferVersion: file.bufferVersion };
      })]);
      if (sourceIdentity !== latestIdentity) return { allowed: false, token: null, save: saved, failure: failure("stale_request", "The working copy changed while closing. Review the latest changes.", op) };
      // Replacement preserves Previous only after its new project is validated.
      // Preserving here would overwrite the recovery offer the user chose to restore.
      const preservedIdentity = fingerprint(state);
      try { if (input.reason !== "replaceProject") await this.preserve(state); }
      catch (cause) { return { allowed: false, token: null, save: saved, failure: asFailure(cause, op) }; }
      abort(op);
      if (fingerprint(state) !== preservedIdentity) return { allowed: false, token: null, save: saved, failure: failure("stale_request", "The working copy changed while preserving recovery; review it again.", op) };
      const token = uid("close");
      this.closeTokens.clear();
      this.closeTokens.set(token, { ref: { project: state.project, epoch: state.epoch }, fingerprint: fingerprint(state) });
      return { allowed: true, token, save: saved, failure: null };
    });
  }
  close(input: ProjectRef & { token: string }, op: Operation): Promise<void> {
    return this.serial(op, async () => {
      const state = this.state(input);
      const permission = this.closeTokens.get(input.token);
      if (!permission || permission.ref.project !== state.project || permission.ref.epoch !== state.epoch || permission.fingerprint !== fingerprint(state)) throw error("stale_request", "Close permission has expired; review the current working copy.", op);
      this.closeTokens.delete(input.token);
      state.replacementAllowed = permission.fingerprint;
    });
  }
  subscribe(listener: (event: ProjectEvent) => void): () => void {
    this.assertLive();
    this.listeners.add(listener);
    if (this.current) listener({ kind: "changed", snapshot: this.snapshot(this.current), reason: "recovery" });
    for (const offer of this.offers.values()) listener({ kind: "recovery", offer: copy(offer) });
    for (const detail of this.startupFailures) listener({ kind: "failure", project: null, failure: copy(detail) });
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear(); this.closeTokens.clear(); this.snapshots.clear();
    this.recovery.clear(); this.offers.clear(); this.current = null;
  }
}
