import { loadGist, parseGist } from "./gist.js";
import { color, setTheme, isDarkTheme } from "./theme";
import "./style.css";
import { createWorkbenchHost } from "./host";
import type { AcceptedRevision, AnalysisFrame, CloseReason, DiffCategory, HostCapabilities, Json, JsonObject, ProjectEvent, ProjectSnapshot, RevisionRef, TransportCommand, TransportStatus, WorkingCapture } from "./host/contracts";
import { PreferencesController } from "./preferences";
import { ProjectExporter } from "./export";
import { ASSET_LIMITS, importArchiveEntries, isAssetPath, normalizeProjectPath } from "./assets.js";
import { SourceEditor } from "./editor";
import {
  InspectionClient,
  graphFromRows,
  performanceFromRows,
} from "./inspection";
import { renderDocument, revealDocumentAnchor } from "./document";
import { enableGraphPanning } from "./pan";
import {
  Arrangement,
  escapeHTML as esc,
  time,
  pitch,
  patchGraph,
  routingGraph,
  automationView,
  automationValue,
} from "./views";
import { unzipSync } from "fflate";

const host = await createWorkbenchHost();
const runtime = host.runtime;
const preferences = await PreferencesController.load(host.preferences);
const exporter = new ProjectExporter(runtime);
const operation = (signal?: AbortSignal) => ({ requestId: crypto.randomUUID(), signal });
type Catalog = {
  libraries: Record<string, string>;
  gists: { gist: string; title: string; description?: string }[];
  engine?: { commit: string };
  packages?: { directory: string; readme: string; requirements: string[] }[];
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let catalog: Catalog,
  project: ProjectSnapshot,
  revision = 0,
  accepted = -1,
  acceptedEntry = "",
  runToken = 0;
let acceptedRef: RevisionRef | null = null;
let buildAbort: AbortController | undefined;
let activeBuildRequest: string | null = null;
let folderWatch: Extract<ProjectEvent, { kind: "watch" }> | undefined;
let analysisSource: string | null = null;
let analysisFrame: AnalysisFrame | undefined;
let scopeDirty = true;
let engineAvailable = true;
let currentProjectEpoch = 0;
type TabKey = `project:${string}` | `library:${string}`;
let activeTab: TabKey | null = null;
let openTabs: TabKey[] = [];
let sourceNavigationToken = 0;
const activePath = () => activeTab?.slice(activeTab.indexOf(":") + 1) ?? "";
const activeLibrary = () => activeTab?.startsWith("library:") ?? false;
const textFiles = () => Object.fromEntries(project.files.filter(f => !f.deleted).map(f => [f.path, f.text]));
const projectFile = (path: string) => project?.files.find(f => f.path === path && !f.deleted);
const documentStates = new Map<TabKey, { text: string; top: number; details: boolean[] }>();
type LibraryDocument = { id: string; path: string; text: string; kind: "source" | "document" | "text" };
const libraryDocuments = new Map<string, LibraryDocument>();
let views: any,
  status: any,
  selected = "",
  view = "arrangement",
  busy = false,
  commitInProgress = false;
let inspection: InspectionClient | undefined;
let arrangementInspectionTimer: ReturnType<typeof setTimeout>;
let arrangementInspectionToken = 0;
let followInspectionPending = false;
let visualRevisionDirty = false;
let viewRenderToken = 0;
let explainedLocation: any;
let explanationToken = 0;
let validEntries = new Set<string>();
let entryScanPending = false;
let entryScanToken = 0;
let entryScanTimer: ReturnType<typeof setTimeout>;
let saving = false;
let reloading = false;
let draftTimer: ReturnType<typeof setTimeout>;
let closeInProgress = false;

$("app").innerHTML = `
  <header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">∿</span>muzpad<span class="alpha">01</span></div><div class="project-identity"><div class="project-title" id="project-title">A place for music in code</div><div class="workspace-status"><strong id="workspace-mode">Browser copy</strong><span id="folder-state">No folder connected</span></div></div><div class="project-actions" aria-label="Current workspace actions"><button id="reload-folder" title="Read files from the connected folder and rebuild. Keeps this working copy in Previous workspace." hidden>Reload</button><button id="save-folder" hidden>Save to folder</button><button id="export-media" disabled>Export audio / MIDI ↓</button><button id="download">Export ZIP ↓</button><a id="view-gist" class="button-link" target="_blank" rel="noopener noreferrer" hidden>View gist ↗</a></div><div class="top-actions"><button id="theme-toggle" aria-label="Switch color theme">Dark view ◐</button><button id="new-project">New project</button><button id="mount-folder" title="Connect a local folder to reload files and save changes back to disk" hidden>Connect folder</button><button id="open-folder" title="Import a browser copy; download a ZIP to keep your changes">Import folder</button><button id="import-gist">Import from gist</button><button id="open-zip">Open ZIP</button></div></header>
  <div class="transport"><div class="transport-buttons"><button id="restart" class="icon-button" aria-label="Restart" title="Restart">↤</button><button id="play" class="play-button" disabled>▶ Play</button><button id="stop" class="icon-button" aria-label="Stop" title="Stop" disabled>■</button></div><div class="clock"><span id="clock">0:00</span><span id="length">/ —</span></div><div class="position"><span id="bar">Bar 1 · Beat 1</span><span id="tempo">— BPM</span></div><select id="section" aria-label="Seek to section"><option value="">Sections</option></select><button id="loop" aria-pressed="false">↻ Loop section</button><details class="range-menu"><summary>Range</summary><div><label>Start beat <input id="loop-start" type="number" min="0" value="0"></label><label>End beat <input id="loop-end" type="number" min="0" value="16"></label><button id="apply-loop">Loop range</button></div></details><div class="master-meter" title="Master output peak"><span id="meter-fill"></span></div><span id="master-level">−∞ dB</span><div class="transport-spacer"></div><span id="revision">No accepted revision</span><button id="cancel" hidden>Cancel</button><button id="run" class="primary">Rebuild <span>⌘ / Ctrl ↵</span></button></div>
  <main class="workspace"><aside class="explorer"><div class="pane-heading">Workspace <button id="add-file" title="Add a source file" aria-label="Add a source file">＋</button></div><label class="file-search"><input id="file-search" placeholder="Find a file…" aria-label="Find a file"></label><div id="file-tree"></div><div class="explorer-foot" id="workspace-help">Browser copy. Download a ZIP to keep your work.</div></aside>
  <section class="source-pane"><div class="tabs" id="file-tabs"></div><div class="source-tools"><span id="source-path"></span><label class="entry-choice">Entrypoints <select id="entry-select" aria-label="Entrypoints" title="Choose the file to rebuild"></select></label><button id="format">Format</button><button id="set-entry">Use as entry</button></div><div id="entry-notice" role="status" hidden></div><div id="editor"></div><div id="requirements" hidden></div><div id="document" hidden></div><div class="source-foot"><span id="source-mode">muz source</span><span id="entry-label"></span></div></section>
  <div class="splitter" role="separator" tabindex="0" aria-label="Resize editor" aria-orientation="vertical"></div>
  <section class="visual-pane"><div class="view-tabs" role="tablist" aria-label="Inspection views"><button data-view="arrangement" role="tab" aria-selected="true">Arrangement</button><button data-view="routing" role="tab" aria-selected="false">Routing</button><button data-view="patch" role="tab" aria-selected="false">Voice patch</button><button data-view="automation" role="tab" aria-selected="false">Automation</button></div><div class="visual-tools"><span id="view-caption">The music your code makes</span><span id="kit-legend" hidden></span></div><div class="arrangement-tools" id="arrangement-controls" role="toolbar" aria-label="Arrangement navigation"><button id="zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button><input id="zoom" type="range" min="0" max="9" step=".05" value="0" aria-label="Arrangement zoom"><button id="zoom-in" aria-label="Zoom in" title="Zoom in (+)">＋</button><output id="zoom-value">1×</output><button id="zoom-fit" title="Fit the entire arrangement (Home)">Fit</button><button id="center-playhead" title="Center the view on the playhead">Center playhead</button><button id="follow" aria-pressed="true" title="Keep the playhead visible during playback; manual panning turns this off">Follow</button></div><div class="view-content"><div id="arrangement"></div><div id="graph-view" hidden></div></div><div class="selection-heading"><button id="toggle-inspector" aria-expanded="true" aria-controls="inspector" title="Show or hide inspector">Inspector ▾</button><span id="selection-label">Inspector</span><button id="jump-source" disabled>Open related source ↗</button></div><div id="inspector"><p class="empty">Select a track or note to inspect its performance and sound.</p></div><div class="analysis-heading"><label>Analyze <select id="analysis-source" aria-label="Analysis output"><option value="">Master</option></select></label><span id="analysis-detail">Master output</span></div><div class="analysis-strip"><div><span>Waveform</span><canvas id="scope" width="320" height="70" aria-label="Selected output waveform"></canvas></div><div><span>Spectrum</span><canvas id="spectrum" width="320" height="70" aria-label="Selected output spectrum"></canvas></div></div></section></main>
  <footer class="diagnostics"><div class="diagnostics-heading"><span id="build-state">Starting</span><span id="build-detail">Loading muz-core</span><span id="audio-health"></span><details id="revision-effects"><summary>Revision details</summary><div id="revision-effect-list"></div></details></div><div id="diagnostic-list" role="status" aria-live="polite"></div></footer>
  <input id="folder-input" type="file" webkitdirectory multiple hidden><input id="zip-input" type="file" accept=".zip" hidden>
  <dialog id="gist-dialog"><form id="gist-form"><h2>Import from gist</h2><label>Gist URL or ID<input id="gist-input" required autocomplete="off" spellcheck="false" placeholder="https://gist.github.com/…"></label><p>Open a local working copy. Share this page’s URL to share the gist; local edits are not included.</p><p id="gist-error" role="alert"></p><div><button type="button" id="gist-cancel">Cancel</button><button id="gist-submit" class="primary">Import</button></div></form></dialog>
  <dialog id="file-dialog"><form method="dialog"><h2>Add a source file</h2><label>Project-relative filename<input id="new-file-name" value="part.muz" required></label><p id="file-error"></p><div><button value="cancel">Cancel</button><button id="create-file" class="primary" value="create">Create file</button></div></form></dialog>`;
$("theme-toggle").textContent = "Settings";
$("theme-toggle").setAttribute("aria-label", "Settings");
$("stop").insertAdjacentHTML("afterend", '<button id="panic" title="Release sounding voices" disabled>Panic</button>');
document.querySelector(".explorer")!.id = "explorer-pane";
document.querySelector(".source-pane")!.id = "source-pane";
document.querySelector(".visual-pane")!.id = "visualization-pane";
$("file-tabs").setAttribute("role", "tablist");
$("file-tabs").setAttribute("aria-label", "Open files");
$("source-pane").setAttribute("role", "tabpanel");
$("document").tabIndex = 0;
$("inspector").tabIndex = -1;
$("source-path").insertAdjacentHTML("afterend", '<button id="collapse-source" aria-label="Collapse Source">Hide source</button>');
document.querySelector(".pane-heading")!.insertAdjacentHTML("beforeend", '<button id="collapse-explorer" aria-label="Collapse Explorer">−</button>');
document.querySelector(".visual-tools")!.insertAdjacentHTML("beforeend", '<button id="collapse-visualization" aria-label="Collapse Visualization">Hide visualization</button>');
$("editor").insertAdjacentHTML("beforebegin", '<div id="source-empty" hidden><h2>No file open</h2><p>Your buffers and accepted music are still here.</p><button id="open-entrypoint">Open entrypoint</button><button id="show-explorer">Show explorer</button></div>');
$("diagnostic-list").insertAdjacentHTML("afterend", '<div id="recovery-status" role="status" hidden></div>');
document.querySelector(".transport")!.insertAdjacentHTML("afterend", `<div class="panes-toolbar" role="toolbar" aria-label="Panes"><span>Panes</span>${(["explorer", "source", "visualization", "inspector"] as const).map(name => `<button id="pane-${name}" aria-controls="${name === "inspector" ? name : `${name}-pane`}">${name[0].toUpperCase() + name.slice(1)}</button>`).join("")}<button id="recent-projects">Recent projects</button><button id="reveal-project" hidden>Reveal project</button><button id="restart-engine" hidden>Restart engine</button><span id="host-capabilities"></span></div>`);
$("app").insertAdjacentHTML("beforeend", `<dialog id="settings-dialog" aria-labelledby="settings-title"><h2 id="settings-title">Settings</h2><label>Theme<select id="settings-theme"><option value="light">Light</option><option value="dark">Dark</option><option value="soft-light">Soft light</option><option value="soft-dark">Soft dark</option></select></label><fieldset><legend>Panes</legend>${(["explorer", "source", "visualization", "inspector"] as const).map(name => `<label><input type="checkbox" data-preference="${name}">${name[0].toUpperCase() + name.slice(1)}</label>`).join("")}</fieldset><p id="preferences-status" role="status"></p><div><button id="reset-layout">Reset layout</button><button id="settings-close">Close</button></div></dialog><dialog id="workflow-dialog" aria-labelledby="workflow-title"><h2 id="workflow-title"></h2><div id="workflow-body"></div><div id="workflow-actions"></div></dialog>`);
const editor = new SourceEditor(
  $("editor"),
  (text) => {
    if (!project || !activeTab || activeLibrary() || editor.path !== activeTab) return;
    const buffer = projectFile(activePath());
    if (!buffer || buffer.readOnly) return;
    buffer.text = text;
    buffer.bufferVersion++;
    buffer.dirty = true;
    project.dirty = true;
    revision = ++project.sourceVersion;
    updateRevision();
    saveDraft();
    updateFolderState();
    scheduleEntryScan();
  },
  () => void run(),
);
const arrangement = new Arrangement($("arrangement"));
enableGraphPanning($("graph-view"));
arrangement.onSeek = (beat) => seek(beat);
arrangement.onSelect = (track, note) => selectTrack(track, note);
arrangement.onAudition = (muted, solo) => {
  if (acceptedRef) void runtime.audition(acceptedRef, { muted, solo }, operation()).catch(error);
};

function capture(): WorkingCapture {
  return {
    project: project.project, epoch: project.epoch, sourceVersion: project.sourceVersion,
    entry: project.entry, expectedDiskGeneration: project.diskGeneration,
    buffers: project.files.map(f => ({ fileId: f.id, path: f.path, text: f.deleted ? null : f.text, bufferVersion: f.bufferVersion, expectedDiskVersion: f.diskVersion })),
    settings: { title: project.title, entry: project.entry, entries: project.entries },
    settingsDiskVersion: project.settingsDiskVersion,
  };
}
function updateFolderState() {
  const connected = !!project?.rootLabel;
  const watch = runtime.capabilities.environment === "desktop" && folderWatch && project && folderWatch.project.project === project.project
    && folderWatch.project.epoch === project.epoch ? folderWatch : undefined;
  const rootMissing = connected && watch?.state === "rootMissing";
  const pending = project?.files.filter(f => f.dirty).length ?? 0;
  $("save-folder").hidden = !connected;
  $("reload-folder").hidden = !connected;
  $("download").hidden = !!project?.gist;
  $("save-folder").toggleAttribute("disabled", saving || reloading || rootMissing || !project?.dirty);
  $("reload-folder").toggleAttribute("disabled", saving || reloading);
  $("save-folder").textContent = saving ? "Saving…" : "Save to folder";
  $("reload-folder").textContent = reloading ? "Reloading…" : "Reload";
  $("workspace-mode").textContent = connected
    ? rootMissing ? "Project root missing" : watch?.state === "degraded" ? "Folder watch degraded" : "Folder connected"
    : runtime.capabilities.environment === "desktop" ? "Native working copy" : "Browser copy";
  $("workspace-mode").dataset.mode = rootMissing ? "missing" : connected ? "connected" : "browser";
  $("workspace-mode").classList.toggle("unsaved", !!project?.dirty);
  $("folder-state").textContent = connected
    ? `${project.rootLabel} · ${project.dirty ? `${pending} unsaved file${pending === 1 ? "" : "s"}` : "Saved to folder"}${watch ? ` · ${watch.state === "ready" ? "Watch ready" : watch.state === "rootMissing" ? "Root unavailable" : "Watch degraded"}` : ""}`
    : "Recovery copy · export ZIP to keep a portable project";
  $("workspace-help").textContent = connected
    ? watch && watch.state !== "ready"
      ? `${watch.failure?.message ?? (rootMissing ? "Re-select the project root." : "Folder watching is unavailable; use Reload.")} Working buffers remain available.`
      : "Save writes buffers to disk. Reload checks external changes; conflicts require your choice."
    : "Edits remain in recovery independently of open tabs. Export ZIP to keep a copy.";
  $("reveal-project").hidden = !connected || !runtime.capabilities.filesystem.reveal.available;
}
function updateEntryChoices() {
  const entries = [
    ...new Set([...(project.entries ?? []), project.entry, ...validEntries]),
  ].filter((p) => validEntries.has(p));
  $("entry-select").innerHTML =
    `${validEntries.has(project.entry) ? "" : `<option value="" disabled selected>${entryScanPending ? "Checking entry points…" : entries.length ? "Choose entry point" : "No playable entry points"}</option>`}` +
    entries.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  if (validEntries.has(project.entry))
    $<HTMLSelectElement>("entry-select").value = project.entry;
  $("entry-select").toggleAttribute("disabled", !entries.length);
  $("set-entry").toggleAttribute(
    "disabled",
    !activeTab || activeLibrary() || !validEntries.has(activePath()) || activePath() === project.entry,
  );
}
function scheduleEntryScan(delay = 600) {
  clearTimeout(entryScanTimer);
  const token = ++entryScanToken;
  validEntries = new Set();
  entryScanPending = true;
  updateEntryChoices();
  entryScanTimer = setTimeout(async () => {
    const captured = capture();
    try {
      const snapshot = await host.projects.snapshotSources(captured, operation());
      const result = await runtime.checkEntries({ snapshot: snapshot.id, entries: project.files.filter(f => !f.deleted && f.path.endsWith(".muz")).map(f => f.path) }, operation());
      if (token !== entryScanToken || captured.epoch !== project.epoch || result.sourceVersion !== project.sourceVersion) return;
      validEntries = new Set(result.entries.filter(e => e.playable).map(e => e.entry));
    } catch (e) {
      if (token === entryScanToken) error(e);
    } finally {
      if (token === entryScanToken) { entryScanPending = false; updateEntryChoices(); }
    }
  }, delay);
}
let dialogQueue: Promise<unknown> = Promise.resolve();
function ask(title: string, body: string, choices: [string, string][], captureInput?: () => void): Promise<string> {
  const pending = dialogQueue.then(() => new Promise<string>(resolve => {
    const dialog = $<HTMLDialogElement>("workflow-dialog");
    const invoker = document.activeElement as HTMLElement | null;
    $("workflow-title").textContent = title;
    $("workflow-body").innerHTML = body;
    $("workflow-actions").replaceChildren();
    const finish = (answer: string) => {
      captureInput?.();
      dialog.oncancel = null;
      dialog.close();
      if (invoker?.isConnected && invoker.getClientRects().length) invoker.focus();
      else $("theme-toggle").focus();
      resolve(answer);
    };
    for (const [value, label] of choices) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = () => finish(value);
      $("workflow-actions").append(button);
    }
    dialog.oncancel = event => { event.preventDefault(); finish("cancel"); };
    dialog.showModal();
  }));
  dialogQueue = pending.catch(() => {});
  return pending;
}
let conflictResolution: Promise<boolean> | undefined;
let resolvingBuffer: (Pick<ProjectSnapshot, "project" | "epoch"> & { fileId: string; bufferVersion: number }) | undefined;
function resolveConflicts(conflicts = project.conflicts) {
  if (!conflictResolution) conflictResolution = resolveConflictBatch(conflicts).finally(() => { conflictResolution = undefined; });
  return conflictResolution;
}
async function resolveConflictBatch(conflicts = project.conflicts): Promise<boolean> {
  for (const conflict of conflicts) {
    if (!project.conflicts.some(c => c.fileId === conflict.fileId)) continue;
    const identity = { project: project.project, epoch: project.epoch };
    let mergedText = projectFile(conflict.path)?.text ?? conflict.local ?? "";
    const answer = await ask(`External change: ${conflict.path}`,
      `<p>Your buffer has not been overwritten. Choose disk, keep local, or edit a merged buffer. This does not save to disk.</p><details><summary>Disk text</summary><pre>${esc(conflict.disk ?? "(deleted)")}</pre></details><label>Merged text<textarea id="conflict-merge" rows="12">${esc(mergedText)}</textarea></label>`,
      [["disk", "Use disk"], ["local", "Keep local"], ["merge", "Use merged text"], ["cancel", "Later"]],
      () => { mergedText = $<HTMLTextAreaElement>("conflict-merge").value; });
    if (answer === "cancel") return false;
    if (project.project !== identity.project || project.epoch !== identity.epoch) return false;
    const captured = capture();
    const bufferVersion = captured.buffers.find(buffer => buffer.fileId === conflict.fileId)?.bufferVersion;
    await host.projects.persistRecovery(captured, operation());
    resolvingBuffer = bufferVersion === undefined ? undefined : { ...identity, fileId: conflict.fileId, bufferVersion };
    try {
      const next = await host.projects.resolveConflict({ ...identity, fileId: conflict.fileId, diskVersion: conflict.diskVersion, choice: answer as "disk" | "local" | "merge", ...(answer === "merge" ? { mergedText } : {}) }, operation());
      await openProject(next, false, "conflict", resolvingBuffer);
    } finally { resolvingBuffer = undefined; }
  }
  if (project.conflicts.length) return resolveConflictBatch(project.conflicts);
  return true;
}
async function saveFolder() {
  if (!project || saving || reloading) return false;
  saving = true;
  updateFolderState();
  try {
    const captured = capture();
    await host.projects.persistRecovery(captured, operation());
    const result = await host.projects.save({ project: captured.project, epoch: captured.epoch, files: captured.buffers, settings: captured.settings, settingsDiskVersion: captured.settingsDiskVersion }, operation());
    if (project.project !== captured.project || project.epoch !== captured.epoch) return false;
    for (const saved of result.saved) {
      const buffer = project.files.find(f => f.id === saved.fileId);
      if (buffer) { buffer.diskVersion = saved.diskVersion; if (buffer.bufferVersion === saved.bufferVersion) buffer.dirty = false; }
    }
    project.conflicts = result.conflicts;
    project.settingsDiskVersion = result.settingsDiskVersion;
    project.diskGeneration = result.diskGeneration;
    project.dirty = project.files.some(f => f.dirty) || !result.settingsSaved;
    for (const failure of result.failures) error(failure.failure);
    if (result.conflicts.length) await resolveConflicts();
    return !result.failures.length && !result.conflicts.length && result.settingsSaved;
  } catch (e) { error(e); return false; }
  finally { saving = false; updateFolderState(); }
}
async function prepareClose(reason: CloseReason, ticket: string | null = null) {
  if (!project || closeInProgress) return !project;
  closeInProgress = true;
  document.querySelector<HTMLElement>(".workspace")!.inert = true;
  try {
    if (conflictResolution) await conflictResolution;
    let cancelExports = false;
    const answer = project.dirty || project.conflicts.length || busy
      ? await ask("Leave this project?", "<p>Save your working buffers, discard changes, or stay here. Active export jobs must finish or be cancelled before closing.</p><label><input type=\"checkbox\" id=\"cancel-exports\">Cancel active exports</label>",
        [["save", "Save"], ["discard", "Discard"], ["cancel", "Cancel"]], () => { cancelExports = $<HTMLInputElement>("cancel-exports").checked; })
      : "discard";
    let result = await host.projects.prepareClose({ capture: capture(), reason, decision: answer as "save" | "discard" | "cancel", cancelExports, ticket }, operation());
    const exportsActive = result.failure && (
      (result.failure.phase === "export" && result.failure.code === "queue_full") ||
      (result.failure.phase === "project" && result.failure.code === "exports_active")
    );
    if (!result.allowed && exportsActive && answer !== "cancel" && !cancelExports) {
      const jobs = await ask("Exports are still active", "<p>Wait for export publication, or request cancellation. Closing remains blocked until the jobs release their resources.</p>", [["cancelExports", "Cancel exports and close"], ["cancel", "Stay here"]]);
      if (jobs === "cancelExports") result = await host.projects.prepareClose({ capture: capture(), reason, decision: answer as "save" | "discard", cancelExports: true, ticket }, operation());
    }
    if (result.failure) error(result.failure);
    for (const failure of result.save?.failures ?? []) error(failure.failure);
    if (result.save?.conflicts.length) { project.conflicts = result.save.conflicts; await resolveConflicts(); }
    if (!result.allowed || !result.token) return false;
    await host.projects.close({ project: project.project, epoch: project.epoch, token: result.token }, operation());
    return true;
  } catch (e) { error(e); return false; }
  finally { closeInProgress = false; document.querySelector<HTMLElement>(".workspace")!.inert = false; }
}
let replacementInProgress = false;
let replacementQueue: Promise<unknown> = Promise.resolve();
function replaceProject(load: () => Promise<ProjectSnapshot | null>): Promise<boolean> {
  const pending = replacementQueue.then(async () => {
    replacementInProgress = true;
    try {
      if (!await prepareClose("replaceProject")) return false;
      document.querySelector<HTMLElement>(".workspace")!.inert = true;
      const next = await load();
      if (!next) return false;
      await openProject(next);
      return true;
    } finally {
      replacementInProgress = false;
      document.querySelector<HTMLElement>(".workspace")!.inert = false;
    }
  });
  replacementQueue = pending.catch(() => {});
  return pending;
}
$("mount-folder").onclick = async () => {
  try {
    await replaceProject(() => host.projects.chooseFolder(operation()));
  } catch (e) { if ((e as Error).name !== "AbortError") error(e); }
};
$("save-folder").onclick = () => { void saveFolder(); };
$("reload-folder").onclick = async () => {
  if (!project || saving || reloading) return;
  reloading = true;
  updateFolderState();
  try {
    const next = await host.projects.refresh(capture(), operation());
    await openProject(next, false, "disk");
    if (!next.conflicts.length || await resolveConflicts()) await run();
  } catch (e) { error(e); }
  finally { reloading = false; updateFolderState(); }
};
window.addEventListener("keydown", event => {
  if (closeInProgress || replacementInProgress) return;
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "s") { event.preventDefault(); if (project?.rootLabel) void saveFolder(); else void download(); }
  if (runtime.capabilities.environment !== "desktop") return;
  if (document.querySelector("dialog[open]")) return;
  if (event.key === "Enter") { event.preventDefault(); void run(); }
  if (event.key.toLowerCase() === "n") { event.preventDefault(); $("new-project").click(); }
  if (event.key.toLowerCase() === "w" && !event.shiftKey) { event.preventDefault(); if (activeTab) closeTab(activeTab); }
  if (event.key.toLowerCase() === "o") { event.preventDefault(); $("mount-folder").click(); }
  if (event.key === ",") { event.preventDefault(); $("theme-toggle").click(); }
});
type Pane = "explorer" | "source" | "visualization" | "inspector";
const paneFocus = new Map<Pane, HTMLElement>();
const paneNode = (name: Pane) => $(name === "inspector" ? name : `${name}-pane`);
function setPane(name: Pane, visible: boolean, restoreFocus = false) {
  const node = paneNode(name), focused = document.activeElement as HTMLElement | null;
  if (!visible && focused && node.contains(focused)) { paneFocus.set(name, focused); $(`pane-${name}`).focus(); }
  preferences.update({ layout: { [name]: visible, ...(name === "inspector" && visible ? { visualization: true } : {}) } });
  if (visible && restoreFocus) {
    const remembered = paneFocus.get(name);
    if (remembered?.isConnected && remembered.getClientRects().length) remembered.focus();
    else if (name === "explorer") $("file-search").focus();
    else if (name === "source") { if (activeTab && activePath().endsWith(".muz")) editor.view.focus(); else $(activeTab ? "document" : "open-entrypoint").focus(); }
    else if (name === "visualization") document.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus();
    else $("inspector").focus();
  }
}
let appliedTheme = "";
function applyPreferences() {
  const value = preferences.value;
  const previousVisible = !$("visualization-pane").hidden;
  if (!value.layout.visualization) arrangement.setVisible(false);
  for (const name of ["explorer", "source", "visualization", "inspector"] as const) {
    paneNode(name).hidden = !value.layout[name];
    const effective = value.layout[name] && (name !== "inspector" || value.layout.visualization);
    $(`pane-${name}`).setAttribute("aria-expanded", String(effective));
    const checkbox = document.querySelector<HTMLInputElement>(`[data-preference="${name}"]`)!;
    checkbox.checked = value.layout[name];
    if (name !== "inspector") document.querySelector<HTMLElement>(".workspace")!.dataset[name] = String(value.layout[name]);
  }
  $("toggle-inspector").setAttribute("aria-expanded", String(value.layout.inspector && value.layout.visualization));
  $("toggle-inspector").textContent = value.layout.inspector ? "Inspector ▾" : "Inspector ▸";
  document.querySelector<HTMLElement>(".workspace")!.style.setProperty("--source-fraction", String(value.layout.sourceFraction));
  const splitter = document.querySelector<HTMLElement>(".splitter")!;
  splitter.hidden = !value.layout.source || !value.layout.visualization;
  splitter.setAttribute("aria-valuemin", "25"); splitter.setAttribute("aria-valuemax", "70");
  splitter.setAttribute("aria-valuenow", String(Math.round(value.layout.sourceFraction * 100)));
  $<HTMLSelectElement>("settings-theme").value = value.theme;
  $("preferences-status").textContent = preferences.temporary ? "Preferences are temporary" : "";
  if (appliedTheme !== value.theme) {
    appliedTheme = value.theme; setTheme(value.theme); editor.setTheme(isDarkTheme(value.theme));
    scopeDirty = true;
    arrangement.draw();
  }
  arrangement.setVisible(value.layout.visualization);
  if (value.layout.source) editor.remeasure();
  if (acceptedRef && previousVisible !== value.layout.visualization) void runtime.analysis(acceptedRef, analysisSource, value.layout.visualization).catch(error);
  if (!previousVisible && value.layout.visualization && views) {
    scopeDirty = true;
    if (visualRevisionDirty) void showView();
    else if (view === "arrangement") void refreshArrangement();
  }
}
preferences.subscribe(applyPreferences);
for (const name of ["explorer", "source", "visualization", "inspector"] as const) {
  $(`pane-${name}`).onclick = () => setPane(name, !(preferences.value.layout[name] && (name !== "inspector" || preferences.value.layout.visualization)), true);
  document.getElementById(`collapse-${name}`)?.addEventListener("click", () => setPane(name, false));
  document.querySelector<HTMLInputElement>(`[data-preference="${name}"]`)!.onchange = event => setPane(name, (event.target as HTMLInputElement).checked);
}
$("toggle-inspector").onclick = () => setPane("inspector", !preferences.value.layout.inspector);
let settingsInvoker: HTMLElement | null = null;
$("theme-toggle").onclick = () => { settingsInvoker = document.activeElement as HTMLElement; $<HTMLDialogElement>("settings-dialog").showModal(); };
$("settings-theme").onchange = () => preferences.update({ theme: $<HTMLSelectElement>("settings-theme").value as typeof preferences.value.theme });
$("reset-layout").onclick = () => preferences.resetLayout();
$("settings-close").onclick = () => $<HTMLDialogElement>("settings-dialog").close();
const settingsDialog = $<HTMLDialogElement>("settings-dialog");
settingsDialog.addEventListener("keydown", event => {
  if (event.key !== "Tab") return;
  const controls = [...settingsDialog.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")]
    .filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); settingsDialog.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !settingsDialog.contains(document.activeElement))) {
    event.preventDefault(); last!.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !settingsDialog.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
});
$("settings-dialog").addEventListener("close", () => {
  const focused = document.activeElement;
  // The close event is queued. Do not reclaim focus after the user has moved on.
  if (!settingsDialog.open && (!focused || focused === document.body || settingsDialog.contains(focused)))
    (settingsInvoker?.isConnected && settingsInvoker.getClientRects().length ? settingsInvoker : $("theme-toggle")).focus();
});
applyPreferences();
function chooseAnalysis(id: string | null) {
  analysisSource = id;
  analysisFrame = undefined;
  scopeDirty = true;
  if (acceptedRef) void runtime.analysis(acceptedRef, id, preferences.value.layout.visualization).catch(error);
  $<HTMLSelectElement>("analysis-source").value = id ?? "";
  $("analysis-detail").textContent = id
    ? "Track output · before buses"
    : "Master output";
}
$("analysis-source").onchange = () =>
  chooseAnalysis($<HTMLSelectElement>("analysis-source").value || null);

function message(state: string, detail: string) {
  $("build-state").textContent = state;
  $("build-detail").textContent = detail;
}
function error(e: any) {
  const d = e.diagnostic ?? e;
  message(
    "Needs attention",
    d.continuity === "lost" || !engineAvailable
      ? "Engine unavailable · buffers are retained; restart explicitly"
      : acceptedRef ? "The accepted revision is still available" : "Edit the source and rebuild",
  );
  $("diagnostic-list").innerHTML =
    `<button class="diagnostic-message" ${d.location ? 'data-diagnostic="true"' : ""}>${d.location ? `${esc(d.location.path)} · ${d.location.line}:${d.location.column} — ` : ""}${esc(d.message ?? String(e))}</button>${(d.help ?? []).map((h: string) => `<p>${esc(h)}</p>`).join("")}`;
  $("diagnostic-list")
    .querySelector("[data-diagnostic]")
    ?.addEventListener("click", () => jump(d.location));
}
function updateRevision() {
  $("revision").textContent =
    accepted < 0
      ? "Not built yet"
      : !acceptedRef
        ? `Engine stopped · last entry ${acceptedEntry}`
        : accepted === revision
          ? `Revision ${acceptedRef.revision} accepted`
          : `Edited · revision ${acceptedRef.revision} accepted`;
  $("revision").classList.toggle("dirty", revision !== accepted);
  const entryPending = accepted >= 0 && project.entry !== acceptedEntry;
  $("entry-notice").hidden = !entryPending;
  $("entry-notice").textContent = entryPending
    ? `Rebuild to use ${project.entry} · ${acceptedEntry} is still active`
    : "";
  $("entry-label").textContent = entryPending
    ? `Active entry: ${acceptedEntry}`
    : `Entry: ${project.entry}`;
}
async function persistDraft() {
  if (!project) return;
  const captured = capture();
  try {
    await host.projects.persistRecovery(captured, operation());
    if (project?.project === captured.project && project?.epoch === captured.epoch) {
      $("recovery-status").hidden = true;
      $("recovery-status").textContent = "";
    }
  } catch (e) {
    if (project?.project === captured.project && project?.epoch === captured.epoch) {
      $("recovery-status").textContent = `Recovery unavailable · Export your project to keep these edits. ${e instanceof Error ? e.message : String(e)}`;
      $("recovery-status").hidden = false;
    }
  }
}
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void persistDraft(), 400);
}
if (runtime.capabilities.environment === "web") {
  window.addEventListener("pagehide", () => { void persistDraft(); });
  window.addEventListener("beforeunload", event => {
    if (project?.rootLabel && project.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
}
async function openProject(next: ProjectSnapshot, rebuild = true, reason?: "disk" | "save" | "conflict" | "recovery", resolution?: { fileId: string; bufferVersion: number }) {
  const same = project?.project === next.project && project?.epoch === next.epoch;
  checkpointSource();
  if (!same) {
    $("recovery-status").hidden = true;
    $("recovery-status").textContent = "";
    if (folderWatch?.project.project !== next.project || folderWatch.project.epoch !== next.epoch) folderWatch = undefined;
    currentProjectEpoch++;
    runToken++;
    buildAbort?.abort();
    busy = false;
    commitInProgress = false;
    acceptedRef = null;
    accepted = -1;
    acceptedEntry = "";
    inspection = undefined;
    views = undefined;
    status = undefined;
    selected = "";
    openTabs = [];
    activeTab = null;
    editor.clear();
    documentStates.clear();
    libraryDocuments.clear();
    arrangement.reset();
    exporter.set();
    exporter.close();
    analysisSource = null;
    analysisFrame = undefined;
    $("analysis-source").innerHTML = '<option value="">Master</option>';
    $("analysis-detail").textContent = "Master output";
    $("loop").setAttribute("aria-pressed", "false");
    $("play").setAttribute("disabled", "");
    $("stop").setAttribute("disabled", "");
    $("section").innerHTML = '<option value="">Sections</option>';
    $("clock").textContent = "0:00";
    $("length").textContent = "/ —";
    $("jump-source").setAttribute("disabled", "");
    $("selection-label").textContent = "Inspector";
    $("inspector").innerHTML = '<p class="empty">Select a track or note to inspect its performance and sound.</p>';
  }
  const merged = structuredClone(next);
  let recapture = false;
  if (same) {
    for (const local of project.files) {
      // A chosen disk deletion may omit the file entirely; only that captured
      // buffer is authoritative. Edits made after the choice remain protected.
      if (resolution?.fileId === local.id && resolution.bufferVersion === local.bufferVersion) continue;
      const incoming = merged.files.find(f => f.id === local.id);
      if (!incoming) {
        if (local.dirty) { merged.files.push(local); recapture ||= reason === "disk" || reason === "conflict"; }
      } else {
        const racingExternalEdit = (reason === "disk" || reason === "conflict") && local.dirty && (incoming.text !== local.text || incoming.deleted !== local.deleted);
        if (local.bufferVersion > incoming.bufferVersion || racingExternalEdit) {
          Object.assign(incoming, { text: local.text, bufferVersion: racingExternalEdit ? Math.max(local.bufferVersion, incoming.bufferVersion) + 1 : local.bufferVersion, dirty: local.dirty, deleted: local.deleted });
          if (racingExternalEdit) { incoming.diskVersion = local.diskVersion; recapture = true; }
        }
      }
    }
    if (project.sourceVersion > merged.sourceVersion) {
      merged.entry = project.entry; merged.entries = project.entries; merged.title = project.title;
    }
    merged.sourceVersion = Math.max(merged.sourceVersion, project.sourceVersion) + (recapture ? 1 : 0);
    merged.dirty ||= merged.files.some(f => f.dirty);
  }
  project = merged;
  revision = project.sourceVersion;
  if (recapture) saveDraft();
  if (same) {
    for (const key of [...openTabs])
      if (key.startsWith("project:") && !projectFile(key.slice(8))) closeTab(key);
  }
  $("run").toggleAttribute("disabled", busy || !engineAvailable);
  $("cancel").hidden = !busy || commitInProgress;
  $("project-title").textContent = project.title;
  $("view-gist").hidden = !project.gist;
  if (project.gist && runtime.capabilities.environment === "web") $<HTMLAnchorElement>("view-gist").href = `https://gist.github.com/${project.gist}`;
  else {
    $("view-gist").removeAttribute("href");
    $("view-gist").setAttribute("role", "link");
    $("view-gist").tabIndex = 0;
  }
  setGistURL(project.gist);
  updateFolderState();
  tree();
  scheduleEntryScan(0);
  if (!same) await openTab(`project:${project.entry}`, "tab");
  else { renderTabs(); renderActiveSource(); }
  updateRevision();
  if (!same) void showView();
  if (rebuild) await run();
}
function tree() {
  const query = $<HTMLInputElement>("file-search").value.toLowerCase();
  function files(
    items: Record<string, string>,
    kind: string,
    prefix = "",
  ): string {
    const paths = Object.keys(items)
      .filter((p) => p.startsWith(prefix) && p.toLowerCase().includes(query))
      .sort();
    const folders = [
      ...new Set(
        paths
          .map((p) => p.slice(prefix.length))
          .filter((p) => p.includes("/"))
          .map((p) => p.split("/")[0]),
      ),
    ];
    const branches = folders
      .map((name) => {
        const directory = prefix + name;
        const pack =
          kind === "library"
            ? catalog.packages?.find((p) => p.directory === directory)
            : undefined;
        return `<details class="tree-folder" data-folder="${esc(kind + ":" + directory)}" ${query ? "open" : ""}><summary>${esc(name)}</summary>${pack?.requirements.length ? `<p class="requirement-note">${esc(pack.requirements.join(" · "))} · browse only</p>` : ""}${files(items, kind, directory + "/")}</details>`;
      })
      .join("");
    return (
      branches +
      paths
        .filter((p) => !p.slice(prefix.length).includes("/"))
        .map(
          (p) =>
            `<button class="file ${activeTab === `${kind}:${p}` ? "active" : ""}" data-file="${esc(p)}" data-kind="${kind}" title="${esc(p)}"><span>${p.endsWith(".muz") ? "◇" : "·"}</span>${esc(p.slice(prefix.length))}${p === project.entry && kind === "project" ? "<em>entry</em>" : ""}</button>`,
        )
        .join("")
    );
  }
  const coreFiles = files(
    Object.fromEntries(
      Object.entries(catalog.libraries).filter(([p]) => !p.includes("/")),
    ),
    "library",
  );
  const coreFolders = ["std", "contrib", "docs", "examples"]
    .map((folder) => {
      const items = Object.fromEntries(
        Object.entries(catalog.libraries).filter(([p]) =>
          p.startsWith(`${folder}/`),
        ),
      );
      return `<details data-core-folder="${folder}" data-folder="${folder}" ${query ? "open" : ""}><summary>${folder}<span>${Object.keys(items).length}</span></summary>${files(items, "library", `${folder}/`)}</details>`;
    })
    .join("");
  const expanded = new Map(
    Array.from(
      $("file-tree").querySelectorAll<HTMLDetailsElement>(
        "details[data-folder]",
      ),
    ).map((el) => [el.dataset.folder!, el.open]),
  );
  $("file-tree").innerHTML =
    `<details data-folder="project" open><summary>Project <span>${project.files.filter(f => !f.deleted).length}</span></summary>${files(textFiles(), "project")}</details><details class="core-tree" data-folder="core" open><summary>muz-core</summary>${coreFiles}${coreFolders}</details>${catalog.gists.length ? `<details data-folder="gists" open><summary>Gists</summary>${catalog.gists.map(p => `<a class="project-link${p.gist === project.gist ? " active" : ""}" href="${esc(gistURL(p.gist))}" data-gist="${esc(p.gist)}" aria-current="${p.gist === project.gist}"><strong>${esc(p.title)}</strong><small>${esc(p.description || "Open from GitHub gist")}</small></a>`).join("")}</details>` : ""}`;
  if (!query)
    $("file-tree")
      .querySelectorAll<HTMLDetailsElement>("details[data-folder]")
      .forEach((el) => {
        if (expanded.has(el.dataset.folder!))
          el.open = expanded.get(el.dataset.folder!)!;
      });
  $("file-tree")
    .querySelectorAll<HTMLElement>("[data-file]")
    .forEach(
      (el) =>
        (el.onclick = () =>
          openFile(el.dataset.file!, el.dataset.kind === "library")),
    );
  $("file-tree")
    .querySelectorAll<HTMLAnchorElement>("[data-gist]")
    .forEach((el) => {
      if (runtime.capabilities.environment === "desktop") {
        el.removeAttribute("href"); el.setAttribute("role", "link"); el.tabIndex = 0;
        el.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); void importGist(el.dataset.gist!).catch(error); } };
        el.onauxclick = event => event.preventDefault();
      }
      el.onclick = (event) => {
        if (runtime.capabilities.environment === "web" && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))
          return;
        event.preventDefault();
        void importGist(el.dataset.gist!).catch(error);
      };
    });
}
function checkpointSource() {
  editor.detach();
  if (!activeTab || $("document").hidden) return;
  const text = activeLibrary() ? libraryDocuments.get(activePath())?.text ?? catalog.libraries[activePath()] : projectFile(activePath())?.text;
  if (text !== undefined) documentStates.set(activeTab, { text, top: $("document").scrollTop, details: Array.from($("document").querySelectorAll("details")).map(d => d.open) });
}
function openFile(path: string, isLibrary = false) {
  void openTab(`${isLibrary ? "library" : "project"}:${path}`, "navigation").catch(error);
}
async function openTab(key: TabKey, focusIntent: "navigation" | "tab" = "tab", resolvedDocument?: LibraryDocument) {
  const path = key.slice(key.indexOf(":") + 1);
  const navigationToken = ++sourceNavigationToken;
  if (key.startsWith("library:")) {
    const epoch = currentProjectEpoch;
    const result = resolvedDocument ?? await host.projects.readLibraryDocument({ project: project ? { project: project.project, epoch: project.epoch } : null, id: libraryDocuments.get(path)?.id ?? key }, operation());
    if (epoch !== currentProjectEpoch || navigationToken !== sourceNavigationToken) return;
    if (Object.hasOwn(catalog.libraries, path)) catalog.libraries[path] = result.text;
    else libraryDocuments.set(path, result);
  } else if (!projectFile(path)) return;
  checkpointSource();
  activeTab = key;
  if (!openTabs.includes(key)) openTabs.push(key);
  if (focusIntent === "navigation") setPane("source", true);
  renderTabs();
  renderActiveSource();
  if (focusIntent === "navigation") {
    if (libraryDocuments.get(path)?.kind === "source" || path.endsWith(".muz")) editor.view.focus();
    else $("document").focus();
  }
}
function closeTab(key: TabKey) {
  const index = openTabs.indexOf(key);
  if (index < 0) return;
  sourceNavigationToken++;
  const focused = document.activeElement as HTMLElement | null;
  const control = focused?.closest<HTMLElement>("[data-tab],[data-close-tab]");
  const removedFocus = control?.dataset.tab === key || control?.dataset.closeTab === key;
  const changing = activeTab === key;
  const sourceOwnedFocus = changing && focused !== null && $("source-pane").contains(focused);
  if (changing) {
    checkpointSource();
    activeTab = openTabs[index + 1] ?? openTabs[index - 1] ?? null;
  }
  openTabs.splice(index, 1);
  renderTabs();
  if (changing) renderActiveSource();
  if (removedFocus) {
    const survivor = Array.from($("file-tabs").querySelectorAll<HTMLElement>("[data-tab]")).find(el => el.dataset.tab === activeTab);
    (survivor ?? $("open-entrypoint")).focus();
  }
  else if (sourceOwnedFocus) {
    if (activeTab && activePath().endsWith(".muz")) editor.view.focus();
    else $(activeTab ? "document" : "open-entrypoint").focus();
  }
}
function renderTabs() {
  const focused = document.activeElement as HTMLElement | null;
  const focusedKey = focused?.dataset.tab;
  const closeKey = focused?.dataset.closeTab;
  $("file-tabs").innerHTML = openTabs.map((key, index) => {
    const path = key.slice(key.indexOf(":") + 1), kind = key.startsWith("library:") ? "library" : "project";
    return `<span class="file-tab"><button id="file-tab-${index}" role="tab" aria-controls="source-pane" aria-selected="${key === activeTab}" tabindex="${key === activeTab ? 0 : -1}" aria-label="${esc(`${kind} file ${path}`)}" data-tab="${esc(key)}" class="${key === activeTab ? "active" : ""}">${esc(path.split("/").at(-1))}${kind === "library" ? "<span>↗</span>" : ""}</button><button class="tab-close" data-close-tab="${esc(key)}" aria-label="${esc(`Close ${kind} file ${path}`)}">×</button></span>`;
  }).join("");
  for (const button of $("file-tabs").querySelectorAll<HTMLElement>("[data-tab]"))
    button.onclick = () => { void openTab(button.dataset.tab as TabKey).catch(error); };
  for (const button of $("file-tabs").querySelectorAll<HTMLElement>("[data-close-tab]"))
    button.onclick = () => closeTab(button.dataset.closeTab as TabKey);
  const selectedTab = Array.from($("file-tabs").querySelectorAll<HTMLElement>("[data-tab]")).find(el => el.dataset.tab === activeTab);
  if (selectedTab) { $("source-pane").setAttribute("aria-labelledby", selectedTab.id); selectedTab.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  else { $("source-pane").removeAttribute("aria-labelledby"); $("source-pane").setAttribute("aria-label", "Source"); }
  if (focusedKey || closeKey) {
    const replacement = Array.from($("file-tabs").querySelectorAll<HTMLElement>("[data-tab],[data-close-tab]")).find(el => focusedKey ? el.dataset.tab === focusedKey : el.dataset.closeTab === closeKey);
    replacement?.focus();
  }
}
$("file-tabs").onkeydown = event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tab],[data-close-tab]");
  if (!target) return;
  const key = (target.dataset.tab ?? target.dataset.closeTab) as TabKey;
  const index = openTabs.indexOf(key);
  if (event.key === "Delete") { event.preventDefault(); closeTab(key); return; }
  const next = event.key === "Home" ? 0 : event.key === "End" ? openTabs.length - 1 : event.key === "ArrowLeft" ? (index + openTabs.length - 1) % openTabs.length : event.key === "ArrowRight" ? (index + 1) % openTabs.length : -1;
  if (next >= 0) { event.preventDefault(); void openTab(openTabs[next]).then(() => { Array.from($("file-tabs").querySelectorAll<HTMLElement>("[data-tab]")).find(el => el.dataset.tab === activeTab)?.focus(); }).catch(error); }
};
function renderActiveSource() {
  const path = activePath(), isLibrary = activeLibrary(), key = activeTab;
  const libraryDocument = isLibrary ? libraryDocuments.get(path) : undefined;
  const text = isLibrary ? libraryDocument?.text ?? catalog.libraries[path] : projectFile(path)?.text;
  const code = !!key && (libraryDocument ? libraryDocument.kind === "source" : path.endsWith(".muz")), empty = !key || text === undefined;
  $("source-empty").hidden = !empty;
  $("editor").hidden = empty || !code;
  $("document").hidden = empty || code;
  $("source-path").textContent = empty ? "" : path;
  $("source-mode").textContent = empty ? "" : isLibrary ? libraryDocument ? "Authorized library · read only" : "muz-core · read only" : code ? "muz source · working buffer" : "Project documentation";
  $("format").toggleAttribute("disabled", empty || isLibrary || !code || !!projectFile(path)?.readOnly);
  $("set-entry").toggleAttribute("disabled", empty || isLibrary || !validEntries.has(path) || path === project.entry);
  const requirements = isLibrary ? catalog.packages?.filter(pack => path.startsWith(pack.directory + "/")).sort((a, b) => b.directory.length - a.directory.length)[0]?.requirements ?? [] : [];
  $("requirements").hidden = empty || !requirements.length;
  $("requirements").textContent = requirements.length ? `${requirements.join(" and ")} required. ${runtime.capabilities.environment === "web" ? "Browse only in this browser." : "Availability depends on your native plugin/sample configuration."}` : "";
  if (empty) editor.detach();
  else if (code) editor.open(key!, text!, isLibrary || !!projectFile(path)?.readOnly);
  else {
    editor.detach();
    renderDocument($("document"), text!, path, isLibrary ? catalog.libraries : textFiles(), (target, fragment) => {
      void openTab(`${isLibrary ? "library" : "project"}:${target}`, "navigation").then(() => {
        if (activeTab !== `${isLibrary ? "library" : "project"}:${target}`) return;
        if (target.endsWith(".muz")) { const line = /^L(\d+)/.exec(fragment); if (line) editor.jump(+line[1]); }
        else requestAnimationFrame(() => { if (activeTab === `${isLibrary ? "library" : "project"}:${target}`) revealDocumentAnchor($("document"), fragment); });
      }).catch(error);
    }, runtime.capabilities.environment === "desktop" ? url => host.openExternal(url) : undefined);
    const saved = documentStates.get(key!);
    if (saved?.text === text) {
      $("document").querySelectorAll("details").forEach((d, i) => { d.open = saved.details[i] ?? false; });
      requestAnimationFrame(() => { if (activeTab === key) $("document").scrollTop = saved.top; });
    } else documentStates.delete(key!);
  }
  $("file-tree").querySelectorAll<HTMLElement>("[data-file]").forEach(el => el.classList.toggle("active", activeTab === `${el.dataset.kind}:${el.dataset.file}`));
}
$("open-entrypoint").onclick = () => openFile(project.entry);
$("show-explorer").onclick = () => setPane("explorer", true, true);
async function jump(location: unknown) {
  if (!project || typeof location !== "object" || location === null ||
      !("path" in location) || typeof location.path !== "string" ||
      !("line" in location) || typeof location.line !== "number" || !Number.isSafeInteger(location.line) || location.line < 1 ||
      !("column" in location) || typeof location.column !== "number" || !Number.isSafeInteger(location.column) || location.column < 1) return;
  const epoch = currentProjectEpoch;
  const navigationToken = ++sourceNavigationToken;
  try {
    const resolved = await host.projects.resolveSourceDocument({
      project: { project: project.project, epoch: project.epoch },
      path: location.path.replace(/^<|>$/g, ""),
    }, operation());
    if (!resolved || epoch !== currentProjectEpoch || navigationToken !== sourceNavigationToken) return;
    if (resolved.kind === "project" && projectFile(resolved.path)?.id !== resolved.fileId) return;
    const key: TabKey = `${resolved.kind}:${resolved.path}`;
    await openTab(key, "navigation", resolved.kind === "library"
      ? { id: resolved.id, path: resolved.path, text: resolved.text, kind: resolved.documentKind } : undefined);
    if (epoch !== currentProjectEpoch || sourceNavigationToken !== navigationToken + 1 || activeTab !== key) return;
    if (resolved.kind === "project" || resolved.documentKind === "source") editor.jump(location.line, location.column);
  } catch (e) {
    if (epoch === currentProjectEpoch && navigationToken === sourceNavigationToken) error(e);
  }
}
function jumpId(id: string) {
  const cached = views?.locations[id];
  if (cached) jump(cached);
  else if (inspection) {
    const current = inspection;
    void current
      .location(id)
      .then((location) => {
        if (inspection === current) jump(location);
      })
      .catch(error);
  }
}
async function refreshArrangement(followScrollLeft?: number) {
  if (!inspection || !views || !status || !preferences.value.layout.visualization) return;
  clearTimeout(arrangementInspectionTimer);
  const current = inspection;
  const requestToken = ++arrangementInspectionToken;
  const range = arrangement.visibleRange(followScrollLeft);
  try {
    const ids = arrangement.visibleTrackIds();
    const tracks = ids.length
      ? views.graph.tracks.filter((track: any) => ids.includes(track.id))
      : views.graph.tracks.slice(0, 12);
    const kitTracks = new Set<string>(
      (views.graph.extras.track_groups ?? [])
        .filter((group: any) => group.kind === "kit")
        .flatMap((group: any) =>
          group.members.map((member: any) => member.track),
        ),
    );
    const pages = await Promise.all(
      tracks.map(async (track: any) => {
        const overview = arrangement.densityMode && kitTracks.has(track.id);
        const ppq = track.source?.summary?.ppq ?? 960_000;
        const start_tick = Math.floor(range.start * ppq);
        const request = {
          track: track.id,
          start_tick: String(start_tick),
          end_tick: String(Math.max(start_tick + 1, Math.ceil(range.end * ppq))),
        };
        let page = await current.inspect(
          overview ? "performance_overview" : "performance",
          request,
        );
        let trackOverview = overview;
        if (!overview && page.next != null) {
          page = await current.inspect("performance_overview", request);
          trackOverview = true;
        }
        return { track, ppq, page, overview: trackOverview };
      }),
    );
    if (inspection !== current || requestToken !== arrangementInspectionToken)
      return;
    if (
      followScrollLeft !== undefined &&
      (!status.playing || !arrangement.follow || view !== "arrangement")
    )
      return;
    if (!preferences.value.layout.visualization) return;
    // Keep detail only for the current visible request. Scrolling releases old
    // note/overview rows instead of accumulating a whole performance in the UI.
    const prior = new Map<string, any>();
    for (const { track, ppq, page, overview: trackOverview } of pages) {
      const performed = performanceFromRows(page.rows)[0];
      prior.set(track.id, {
        track: track.id,
        ppq,
        notes: trackOverview ? [] : (performed?.notes ?? []),
        overview: trackOverview ? page.rows : [],
        next: page.next,
      });
    }
    views.performance = views.graph.tracks.map(
      (track: any) =>
        prior.get(track.id) ?? {
          track: track.id,
          ppq: track.source?.summary?.ppq ?? 960_000,
          notes: [],
        },
    );
    arrangement.views = views;
    // Reveal a follow page only after its notes are ready, in the same paint.
    if (followScrollLeft !== undefined)
      arrangement.parent.scrollLeft = followScrollLeft;
    arrangement.layout();
    arrangement.draw();
    arrangement.parent.dataset.inspectionState = pages.some(
      (page) => page.overview,
    )
      ? "overview"
      : "detail";
  } catch (e) {
    if (inspection === current) error(e);
  }
}
function scheduleArrangementInspection() {
  clearTimeout(arrangementInspectionTimer);
  // Manual navigation invalidates an in-flight follow before the debounce fires.
  arrangementInspectionToken++;
  if (!preferences.value.layout.visualization) return;
  arrangement.parent.dataset.inspectionState = "loading";
  arrangementInspectionTimer = setTimeout(() => void refreshArrangement(), 100);
}
function renderRevisionEffect(effect: AcceptedRevision["effect"], revision: string, hasComparison: boolean) {
  const target = $("revision-effect-list");
  target.innerHTML = `<p>Revision ${revision} · ${esc(
    typeof effect === "string" ? effect : JSON.stringify(effect ?? "accepted"),
  )}</p>${!hasComparison ? '<p class="empty">This is the first accepted revision.</p>' : '<label>Difference <select id="diff-category"><option>notes</option><option>occurrences</option><option>metadata</option><option>controllers</option><option>messages</option><option>tempos</option><option>performed</option><option>consequences</option></select></label><div id="diff-page"></div>'}`;
  if (!hasComparison) return;
  const select = $<HTMLSelectElement>("diff-category");
  const history: number[] = [];
  let requestToken = 0;
  const load = async (offset = 0) => {
    if (!inspection) return;
    const current = inspection;
    const category = select.value as DiffCategory;
    const token = ++requestToken;
    try {
      const result = await current.diff(category, offset, 100);
      if (
        inspection !== current ||
        token !== requestToken ||
        select.value !== category ||
        document.getElementById("diff-category") !== select
      )
        return;
      const page = result;
      $("diff-page").innerHTML =
        `<pre>${esc(JSON.stringify(page.rows, null, 2))}</pre>` +
        `<div class="bounded-pages">${history.length ? '<button id="diff-previous">Previous page</button>' : ""}${page.next != null ? `<button id="diff-more">Load next ${esc(category)} page</button>` : ""}</div>`;
      document
        .getElementById("diff-previous")
        ?.addEventListener("click", () => {
          const previous = history.pop();
          if (previous != null) void load(previous);
        });
      document.getElementById("diff-more")?.addEventListener("click", () => {
        history.push(offset);
        void load(page.next!);
      });
    } catch (e) {
      if (
        inspection === current &&
        token === requestToken &&
        select.value === category &&
        document.getElementById("diff-category") === select
      )
        error(e);
    }
  };
  select.onchange = () => {
    history.length = 0;
    void load();
  };
  void load();
}
function attachInitialPageControls() {
  if (!inspection || !views) return;
  const host = $("revision-effect-list");
  const current = inspection;
  for (const name of ["sections", "track_groups", "locations", "diagnostics"] as const) {
    if (views.continuations?.[name] == null) continue;
    const controls = document.createElement("div");
    controls.className = "bounded-pages";
    const history: number[] = [];
    let offset = 0;
    let next = views.continuations[name];
    const apply = (page: any) => {
      if (inspection !== current) return;
      next = page.next;
      if (name === "sections") views.graph.extras.sections = page.rows;
      if (name === "track_groups") views.graph.extras.track_groups = page.rows;
      if (name === "locations")
        views.locations = Object.fromEntries(
          page.rows.map((row: any) => [row.key, row.location]),
        );
      if (name === "diagnostics") views.diagnostics = page.rows;
      if (name === "sections")
        $("section").innerHTML =
          '<option value="">Sections</option>' +
          page.rows
            .map(
              (section: any, i: number) =>
                `<option value="${i}">${esc(section.name.replaceAll("_", " "))}</option>`,
            )
            .join("");
      arrangement.layout();
      arrangement.draw();
      render();
    };
    const load = async (nextOffset: number) => {
      offset = nextOffset;
      apply(await current.inspect(name, { offset }));
    };
    const render = () => {
      controls.replaceChildren();
      if (history.length) {
        const previous = document.createElement("button");
        previous.textContent = `Previous ${name.replaceAll("_", " ")} page`;
        previous.onclick = () => {
          const previousOffset = history.pop();
          if (previousOffset != null) void load(previousOffset);
        };
        controls.append(previous);
      }
      if (next != null) {
        const more = document.createElement("button");
        more.textContent = `Next ${name.replaceAll("_", " ")} page`;
        more.onclick = () => {
          history.push(offset);
          void load(next!);
        };
        controls.append(more);
      }
    };
    render();
    host.append(controls);
  }
}
async function run() {
  if (busy || !project || !engineAvailable) return;
  busy = true;
  buildAbort = new AbortController();
  const token = ++runToken;
  $("run").setAttribute("disabled", "");
  $("cancel").hidden = false;
  $("cancel").removeAttribute("disabled");
  $("diagnostic-list").replaceChildren();
  message("Compiling", project.entry);
  try {
    const snapshot = await host.projects.snapshotSources(capture(), operation(buildAbort.signal));
    if (token !== runToken) return;
    const buildOperation = operation(buildAbort.signal);
    activeBuildRequest = buildOperation.requestId;
    const result = await runtime.rebuild({ snapshot: snapshot.id, base: acceptedRef }, buildOperation);
    if (token !== runToken || result.ref.project !== project.project || result.ref.epoch !== project.epoch) return;
    await acceptRevision(result);
  } catch (e) {
    if (token === runToken) {
      const cancelled = (e instanceof Error && e.name === "AbortError") ||
        (typeof e === "object" && e !== null && "code" in e && e.code === "cancelled");
      if (cancelled) message("Cancelled", "The accepted revision is still available");
      else error(e);
    }
  } finally {
    if (token === runToken) {
      commitInProgress = false; busy = false; buildAbort = undefined;
      activeBuildRequest = null;
      $("run").removeAttribute("disabled"); $("cancel").hidden = true;
    }
  }
}
async function acceptRevision(result: AcceptedRevision) {
  const hasComparison = acceptedRef !== null &&
    acceptedRef.project === result.ref.project && acceptedRef.epoch === result.ref.epoch &&
    acceptedRef.engineEpoch === result.ref.engineEpoch && acceptedRef.revision !== result.ref.revision;
  acceptedRef = result.ref;
  inspection = new InspectionClient(runtime, result.ref);
  const { summary: summaryPage, graph: graphPage, sections: sectionsPage, track_groups: groupsPage, locations: locationsPage, diagnostics: diagnosticsPage } = result.initialPages;
  $("graph-view").replaceChildren();
  views = {
    summary: summaryPage.rows[0],
    graph: graphFromRows(graphPage.rows, sectionsPage.rows, groupsPage.rows),
    performance: graphPage.rows.map(jsonRecord).filter(row => row?.kind === "track").map(row => {
      const summary = jsonRecord(jsonRecord(jsonRecord(row!.detail)?.source)?.summary);
      return { track: row!.id, ppq: summary?.ppq ?? 960_000, notes: [] };
    }),
    locations: Object.fromEntries(locationsPage.rows.map(value => {
      const row = jsonRecord(value);
      if (!row || typeof row.key !== "string") throw new Error("Invalid source location row.");
      return [row.key, row.location];
    })),
    diagnostics: diagnosticsPage.rows,
    continuations: { graph: graphPage.next, sections: sectionsPage.next, track_groups: groupsPage.next, locations: locationsPage.next, diagnostics: diagnosticsPage.next },
  };
  status = result.status;
  accepted = result.ref.sourceVersion;
  acceptedEntry = result.ref.entry;
  exporter.set({ ...result, name: project.title });
  $("play").removeAttribute("disabled");
  $("stop").removeAttribute("disabled");
  $("export-media").removeAttribute("disabled");
  updateRevision();
  $("length").textContent = `/ ${time(status.duration)}`;
  $("section").innerHTML = '<option value="">Sections</option>' + views.graph.extras.sections.map((s: { name: string }, i: number) => `<option value="${i}">${esc(s.name.replaceAll("_", " "))}</option>`).join("");
  arrangement.set(views, status.endBeat);
  await refreshArrangement();
  if (acceptedRef !== result.ref) return;
  selected = views.graph.tracks.some((t: { id: string }) => t.id === selected) ? selected : views.graph.tracks[0]?.id;
  const previousAnalysis = analysisSource;
  $("analysis-source").innerHTML = '<option value="">Master</option>' + views.graph.tracks.map((track: { id: string }) => `<option value="${esc(track.id)}">${esc(track.id)}</option>`).join("");
  if (selected) selectTrack(selected);
  chooseAnalysis(views.graph.tracks.some((t: { id: string }) => t.id === previousAnalysis) ? previousAnalysis : null);
  void showView();
  updateTransport(result.status);
  message("Accepted", `${views.graph.tracks.length} tracks · ${views.graph.extras.sections.length} sections · ${time(status.duration)}`);
  $("diagnostic-list").innerHTML = diagnosticsPage.rows.map(value => {
    const d = jsonRecord(value);
    return d ? `<p>${esc(d.severity)} · ${esc(d.track)} · beat ${d.beat}: ${esc(d.message)}</p>` : "";
  }).join("");
  renderRevisionEffect(result.effect, result.ref.revision, hasComparison);
  attachInitialPageControls();
  applyCapabilities(runtime.capabilities);
}
async function transport(command: TransportCommand) {
  if (!acceptedRef || !engineAvailable) return;
  const ref = acceptedRef;
  try {
    const result = await runtime.transport(ref, command, operation());
    if (acceptedRef === ref) updateTransport(result);
  } catch (e) { error(e); }
}
function seek(beat: number) {
  void transport({ kind: "seek", beat });
}
function selectTrack(id: string, note?: any) {
  selected = id;
  chooseAnalysis(id);
  arrangement.selected = id;
  const track = views.graph.tracks.find((t: any) => t.id === id);
  const performance = views.performance.find((t: any) => t.track === id);
  const group = views.graph.extras.track_groups?.find(
    (g: any) => g.kind === "kit" && g.members.some((m: any) => m.track === id),
  );
  const member = group?.members.find((m: any) => m.track === id);
  $("selection-label").textContent = note
    ? member
      ? `${group.id} · ${member.label} hit`
      : `${id} · ${pitch(note.key)}`
    : id;
  explainedLocation = undefined;
  const explainToken = ++explanationToken;
  $("jump-source").toggleAttribute("disabled", !views.locations[`track.${id}`]);
  const rows: [string, unknown][] = note
    ? [
        ...(member
          ? ([
              ["Kit", group.id],
              ["Lane", member.label],
            ] as [string, unknown][])
          : []),
        ["Pitch", pitch(note.key)],
        [
          "Start beat",
          (note.start_tick / (performance?.ppq ?? 960_000)).toFixed(3),
        ],
        [
          "Duration",
          `${(note.duration_ticks / (performance?.ppq ?? 960_000)).toFixed(3)} beats`,
        ],
        ["Velocity", note.attack_velocity],
        ["Tags", note.tags?.join(", ") || "—"],
        ...Object.entries(note.performance ?? {}).map(
          ([k, v]) =>
            [k, typeof v === "object" ? JSON.stringify(v) : v] as [
              string,
              unknown,
            ],
        ),
      ]
    : [
        [
          "Instrument",
          track.instrument.patch?.name ??
            track.instrument.kind.replace("builtin.", ""),
        ],
        [
          "Notes",
          track.source?.summary?.notes ?? performance?.notes?.length ?? 0,
        ],
        ["Output", track.output.to],
        [
          "Inserts",
          track.inserts
            .map((d: any) => d.kind.replace("builtin.", ""))
            .join(" → ") || "None",
        ],
        [
          "Sends",
          track.sends.map((s: any) => `${s.to} (${s.gain_db} dB)`).join(", ") ||
            "None",
        ],
      ];
  $("inspector").innerHTML =
    `<dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
  if (note && inspection && note.id) {
    const current = inspection;
    void current
      .explain(id, 0, 1, note.id)
      .then((page) => {
        if (
          inspection !== current ||
          selected !== id ||
          explainToken !== explanationToken
        )
          return;
        const explanation = jsonRecord(page.rows[0]);
        if (!explanation) return;
        const occurrences = Array.isArray(explanation.occurrences) ? explanation.occurrences.map(jsonRecord).filter((row): row is JsonObject => row !== null) : [];
        explainedLocation = explanation.latest_edit ?? occurrences[0]?.location ?? explanation.definition;
        $("jump-source").toggleAttribute("disabled", !explainedLocation);
        $("inspector").insertAdjacentHTML(
          "beforeend",
          `<p class="provenance-quality">${esc(explanation.location_quality)}</p><div class="provenance-links"></div>`,
        );
        const links = $("inspector").querySelector(".provenance-links")!;
        const destinations: [string, unknown][] = [
          ["Definition", explanation.definition],
          ["Latest relevant edit", explanation.latest_edit],
          ...occurrences.map((occurrence, i): [string, unknown] => [`Occurrence ${i + 1} · ${occurrence.operation}`, occurrence.location]),
          ...Object.entries(jsonRecord(explanation.field_edits) ?? {}).map(([field, location]): [string, unknown] => [`${field} edit`, location]),
        ];
        for (const [label, location] of destinations) {
          if (!location) continue;
          const button = document.createElement("button");
          button.textContent = label;
          button.onclick = () => jump(location);
          links.append(button);
        }
      })
      .catch(error);
  }
  if (view === "patch") showView();
}
async function showView() {
  if (!preferences.value.layout.visualization) { visualRevisionDirty = true; return; }
  visualRevisionDirty = false;
  const renderToken = ++viewRenderToken;
  $("arrangement").hidden = view !== "arrangement";
  $("graph-view").hidden = view === "arrangement";
  $("graph-view").classList.toggle(
    "pannable",
    view === "routing" || view === "patch",
  );
  $("arrangement-controls").hidden = view !== "arrangement";
  document
    .querySelectorAll<HTMLElement>("[data-view]")
    .forEach((el) =>
      el.setAttribute("aria-selected", String(el.dataset.view === view)),
    );
  const captions: Record<string, string> = {
    arrangement: "Drag to pan · Ctrl/⌘ + wheel to zoom · click ruler to seek",
    routing: "Drag to pan · dashed lines are sends and sidechains",
    patch: "Drag to pan · click a node to open related source",
    automation: "Parameter curves · read only",
  };
  $("view-caption").textContent = captions[view];
  arrangement.onNavigation();
  if (!views) {
    $("graph-view").innerHTML =
      '<p class="empty">Rebuild a project to inspect its sound.</p>';
    return;
  }
  if (view === "arrangement") arrangement.draw();
  if (view === "routing" && inspection) {
    const current = inspection;
    const history: number[] = [];
    let requestToken = 0;
    const load = async (offset = 0) => {
      const token = ++requestToken;
      try {
        const page = await current.inspect("graph", { offset });
        if (
          inspection !== current ||
          view !== "routing" ||
          token !== requestToken ||
          renderToken !== viewRenderToken
        )
          return;
        const graph = graphFromRows(
          page.rows,
          views.graph.extras.sections,
          views.graph.extras.track_groups,
        );
        $("graph-view").innerHTML =
          routingGraph(graph) +
          `<div class="bounded-pages">${history.length ? '<button id="graph-previous">Previous graph page</button>' : ""}${page.next != null ? '<button id="graph-next">Next graph page</button>' : ""}<span>${offset + 1}–${offset + page.rows.length} of ${page.total}</span></div>`;
        bindSourceHandlers();
        document
          .getElementById("graph-previous")
          ?.addEventListener("click", () => {
            const previous = history.pop();
            if (previous != null) void load(previous);
          });
        document.getElementById("graph-next")?.addEventListener("click", () => {
          history.push(offset);
          void load(page.next!);
        });
      } catch (e) {
        if (
          inspection === current &&
          view === "routing" &&
          token === requestToken &&
          renderToken === viewRenderToken
        )
          error(e);
      }
    };
    await load();
  }
  if (view === "patch" && inspection) {
    const current = inspection;
    const selectedId = selected;
    const history: number[] = [];
    let requestToken = 0;
    const load = async (offset = 0) => {
      const token = ++requestToken;
      try {
        const page = await current.inspect("patch_nodes", {
          track: selectedId,
          offset,
        });
        if (
          inspection !== current ||
          view !== "patch" ||
          selected !== selectedId ||
          token !== requestToken ||
          renderToken !== viewRenderToken
        )
          return;
        const devices = new Map<string, Json[]>();
        for (const value of page.rows) {
          const row = jsonRecord(value);
          if (!row || typeof row.device !== "string" || row.node === undefined) throw new Error("Invalid patch node inspection row.");
          const nodes = devices.get(row.device) ?? [];
          nodes.push(row.node);
          devices.set(row.device, nodes);
        }
        $("graph-view").innerHTML =
          [...devices.entries()]
            .map(
              ([device, nodes]) =>
                `<section class="patch-device"><h3>${esc(device)}</h3>${patchGraph({ nodes }, `device.${device}`)}</section>`,
            )
            .join("") +
          `<div class="bounded-pages">${history.length ? '<button id="patch-previous">Previous nodes</button>' : ""}${page.next != null ? '<button id="patch-next">Next nodes</button>' : ""}<span>${offset + 1}–${offset + page.rows.length} of ${page.total}</span></div>`;
        bindSourceHandlers();
        document
          .getElementById("patch-previous")
          ?.addEventListener("click", () => {
            const previous = history.pop();
            if (previous != null) void load(previous);
          });
        document.getElementById("patch-next")?.addEventListener("click", () => {
          history.push(offset);
          void load(page.next!);
        });
      } catch (e) {
        if (
          inspection === current &&
          view === "patch" &&
          selected === selectedId &&
          token === requestToken &&
          renderToken === viewRenderToken
        )
          error(e);
      }
    };
    await load();
  }
  if (view === "automation" && inspection) {
    const current = inspection;
    const history: number[] = [];
    let requestToken = 0;
    const load = async (offset = 0) => {
      const token = ++requestToken;
      try {
        const lanes = await current.inspect("automation", {
          offset,
          limit: 20,
        });
        const pointPages = await Promise.all(
          lanes.rows.map((lane: any) =>
            current.inspect("automation_points", { track: lane.target }),
          ),
        );
        if (
          inspection !== current ||
          view !== "automation" ||
          token !== requestToken ||
          renderToken !== viewRenderToken
        )
          return;
        const models = lanes.rows
          .map((lane: any, index: number) => ({
            ...lane,
            points: pointPages[index].rows.map((row: any) => row.point),
            pointOffset: 0,
            pointNext: pointPages[index].next,
            pointHistory: [] as number[],
            pointRequest: 0,
          }))
          .filter((lane: any) => lane.points.length);
        const render = () => {
          views.graph.extras.automation = models;
          $("graph-view").innerHTML =
            automationView(models, status.duration) +
            models
              .map(
                (lane: any, index: number) =>
                  `<div class="bounded-pages">${lane.pointOffset ? `<button data-points-previous="${index}">Previous ${esc(lane.target)} points</button>` : ""}${lane.pointNext != null ? `<button data-points-next="${index}">Next ${esc(lane.target)} points</button>` : ""}</div>`,
              )
              .join("") +
            `<div class="bounded-pages">${history.length ? '<button id="automation-previous">Previous lanes</button>' : ""}${lanes.next != null ? '<button id="automation-next">Next lanes</button>' : ""}<span>${offset + 1}–${offset + lanes.rows.length} of ${lanes.total}</span></div>`;
          bindSourceHandlers();
          $("graph-view")
            .querySelectorAll<HTMLButtonElement>("[data-points-next]")
            .forEach((button) => {
              button.onclick = async () => {
                const index = +button.dataset.pointsNext!;
                const lane = models[index];
                const nextOffset = lane.pointNext;
                const pointToken = ++lane.pointRequest;
                try {
                  const page = await current.inspect("automation_points", {
                    track: lane.target,
                    offset: nextOffset,
                  });
                  if (
                    inspection !== current ||
                    view !== "automation" ||
                    token !== requestToken ||
                    pointToken !== lane.pointRequest ||
                    renderToken !== viewRenderToken
                  )
                    return;
                  lane.pointHistory.push(lane.pointOffset);
                  lane.points = page.rows.map((row: any) => row.point);
                  lane.pointOffset = nextOffset;
                  lane.pointNext = page.next;
                  render();
                } catch (e) {
                  if (
                    inspection === current &&
                    view === "automation" &&
                    token === requestToken &&
                    pointToken === lane.pointRequest &&
                    renderToken === viewRenderToken
                  )
                    error(e);
                }
              };
            });
          $("graph-view")
            .querySelectorAll<HTMLButtonElement>("[data-points-previous]")
            .forEach((button) => {
              button.onclick = async () => {
                const index = +button.dataset.pointsPrevious!;
                const lane = models[index];
                const nextOffset = lane.pointHistory.pop();
                if (nextOffset == null) return;
                const pointToken = ++lane.pointRequest;
                try {
                  const page = await current.inspect("automation_points", {
                    track: lane.target,
                    offset: nextOffset,
                  });
                  if (
                    inspection !== current ||
                    view !== "automation" ||
                    token !== requestToken ||
                    pointToken !== lane.pointRequest ||
                    renderToken !== viewRenderToken
                  )
                    return;
                  lane.points = page.rows.map((row: any) => row.point);
                  lane.pointOffset = nextOffset;
                  lane.pointNext = page.next;
                  render();
                } catch (e) {
                  lane.pointHistory.push(nextOffset);
                  if (
                    inspection === current &&
                    view === "automation" &&
                    token === requestToken &&
                    pointToken === lane.pointRequest &&
                    renderToken === viewRenderToken
                  )
                    error(e);
                }
              };
            });
          document
            .getElementById("automation-previous")
            ?.addEventListener("click", () => {
              const previous = history.pop();
              if (previous != null) void load(previous);
            });
          document
            .getElementById("automation-next")
            ?.addEventListener("click", () => {
              history.push(offset);
              void load(lanes.next!);
            });
        };
        render();
      } catch (e) {
        if (
          inspection === current &&
          view === "automation" &&
          token === requestToken &&
          renderToken === viewRenderToken
        )
          error(e);
      }
    };
    await load();
  }
  bindSourceHandlers();
}
function bindSourceHandlers() {
  $("graph-view")
    .querySelectorAll<HTMLElement>("[data-source]")
    .forEach((el) => {
      el.onclick = () => jumpId(el.dataset.source!);
      el.onkeydown = (e) => {
        if (e.key === "Enter") jumpId(el.dataset.source!);
      };
    });
}
async function download() {
  if (!project) return;
  try {
    const result = await host.projects.exportArchive(capture(), operation());
    if (result.linkedResources.length) message("Archive exported", `${result.linkedResources.length} linked resources are not embedded; keep their native configuration available.`);
  } catch (e) { error(e); }
}
function validateFiles(files: Record<string, string>) {
  if (
    Object.keys(files).length > 500 ||
    Object.values(files).reduce((n, s) => n + s.length, 0) > 4_000_000
  )
    throw new Error(
      "Open a project with at most 500 source files and 4 MB of text.",
    );
  for (const p of Object.keys(files))
    if (
      p.startsWith("/") ||
      p.split("/").some((s) => s === "..") ||
      p.includes("\\")
    )
      throw new Error("Project contains an unsupported path.");
  if (!Object.keys(files).some((p) => p.endsWith(".muz")))
    throw new Error("This folder contains no muz source files.");
}
async function importProject(files: Record<string, string>, title: string, { assets = {}, gist }: { assets?: Record<string, { format: "midi" | "wav" | "flac"; base64: string }>; gist?: string } = {}) {
  validateFiles(files);
  let parsed: unknown;
  try { parsed = JSON.parse(files["muzpad.json"] ?? "{}"); } catch { parsed = {}; }
  const settings = parsed && typeof parsed === "object" ? parsed : {};
  const preferred = "entry" in settings && typeof settings.entry === "string" ? settings.entry : "";
  const entry = files[preferred] ? preferred : files["song.muz"] ? "song.muz" : Object.keys(files).find(p => p.endsWith(".muz"))!;
  const entries = "entries" in settings && Array.isArray(settings.entries) ? settings.entries.filter((p: unknown): p is string => typeof p === "string" && p.endsWith(".muz") && files[p] !== undefined) : undefined;
  await replaceProject(() => host.projects.importProject({ kind: "content", project: {
    settings: { title: "title" in settings && typeof settings.title === "string" ? settings.title : title, entry, ...(entries ? { entries } : {}) },
    files: Object.entries(files).filter(([path]) => path !== "muzpad.json").map(([path, text]) => ({ path, text })),
    assets: Object.entries(assets).map(([path, value]) => ({ path, format: value.format, base64: value.base64 })),
    ...(gist ? { gist: parseGist(gist) } : {}),
  } }, operation()));
}
$("run").onclick = () => void run();
$("cancel").onclick = () => {
  if (commitInProgress) return;
  buildAbort?.abort();
  $("cancel").setAttribute("disabled", "");
  message("Cancelling", "Waiting for the runtime outcome; the accepted revision remains available");
};
$("play").onclick = () => { void transport({ kind: status?.playing ? "pause" : "play" }); };
$("stop").onclick = () => { void transport({ kind: "stop" }); };
$("restart").onclick = () => { void transport({ kind: "restart" }); };
$("section").onchange = () => {
  const i = $<HTMLSelectElement>("section").value;
  if (i === "") return;
  const s = views.graph.extras.sections[+i];
  if (status?.loop) void transport({ kind: "loop", range: [s.start, s.end] });
  else seek(s.start);
  $<HTMLInputElement>("loop-start").value = s.start;
  $<HTMLInputElement>("loop-end").value = s.end;
};
$("loop").onclick = () => {
  if (status?.loop) void transport({ kind: "loop", range: null });
  else if (views) {
    const value = $<HTMLSelectElement>("section").value;
    const s =
      value === ""
        ? views.graph.extras.sections.find(
            (s: { start: number; end: number }) => status.beat >= s.start && status.beat < s.end,
          )
        : views.graph.extras.sections[+value];
    void transport({ kind: "loop", range: s ? [s.start, s.end] : [0, status.endBeat] });
  }
};
$("apply-loop").onclick = () => {
  const a = +$<HTMLInputElement>("loop-start").value,
    b = +$<HTMLInputElement>("loop-end").value;
  if (
    !status ||
    !Number.isFinite(a + b) ||
    a < 0 ||
    b <= a ||
    b > status.endBeat
  )
    return error({
      message:
        "Choose a loop inside the arrangement with its end after its start.",
    });
  void transport({ kind: "loop", range: [a, b] });
  document.querySelector("details.range-menu")?.removeAttribute("open");
};
let gistRequest: AbortController | undefined;
function gistURL(ref?: string) {
  const url = new URL(location.href);
  if (ref !== undefined) url.searchParams.set("gist", ref);
  else url.searchParams.delete("gist");
  return url.href;
}
function setGistURL(ref?: string) {
  history.replaceState(null, "", gistURL(ref));
}
async function importGist(input: string) {
  gistRequest?.abort();
  const request = new AbortController();
  gistRequest = request;
  message("Loading gist", "Fetching source from GitHub…");
  try {
    const next = await loadGist(input, { signal: request.signal });
    if (request.signal.aborted) return;
    await importProject(next.files, next.title, { gist: input });
  } catch (e) {
    if (!request.signal.aborted) throw e;
  } finally {
    if (gistRequest === request) gistRequest = undefined;
  }
}
$("import-gist").onclick = () => {
  $("gist-error").textContent = "";
  $<HTMLDialogElement>("gist-dialog").showModal();
};
$("gist-cancel").onclick = () => $<HTMLDialogElement>("gist-dialog").close();
$("gist-dialog").addEventListener("close", () => {
  if (gistRequest && !gistRequest.signal.aborted) {
    gistRequest.abort();
    gistRequest = undefined;
    message("Import canceled", "Your current workspace is unchanged");
  }
});
$("gist-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("gist-submit");
  button.disabled = true;
  $("gist-error").textContent = "";
  try {
    await importGist($<HTMLInputElement>("gist-input").value);
    $<HTMLDialogElement>("gist-dialog").close();
  } catch (e) {
    $("gist-error").textContent = e instanceof Error ? e.message : String(e);
    error(e);
  } finally {
    button.disabled = false;
  }
};
$("download").onclick = download;
$("export-media").onclick = () =>
  exporter.open(revision !== accepted || project.entry !== acceptedEntry);
$("file-search").oninput = tree;
$("new-project").onclick = async () => {
  try {
    await replaceProject(() => host.projects.newProject({ title: "Untitled project", entry: "song.muz" }, operation()));
  } catch (e) {
    error(e);
  }
};
$("format").onclick = async () => {
  if (!activeTab || activeLibrary()) return;
  const key = activeTab, epoch = currentProjectEpoch, path = activePath(), buffer = projectFile(path);
  if (!buffer || buffer.readOnly || !path.endsWith(".muz")) return;
  const before = buffer.text, version = buffer.bufferVersion, projectId = project.project;
  try {
    const result = await runtime.format({ project: projectId, path, bufferVersion: version, source: before }, operation());
    if (epoch === currentProjectEpoch && activeTab === key && editor.path === key && projectFile(path)?.bufferVersion === version && projectFile(path)?.text === before && result.bufferVersion === version)
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: result.source } });
  } catch (e) { error(e); }
};
function setEntry(path: string) {
  if (project.entry === path || !validEntries.has(path)) return;
  project.entry = path;
  revision = ++project.sourceVersion;
  project.dirty = true;
  updateRevision();
  updateEntryChoices();
  updateFolderState();
  saveDraft();
  tree();
  $("set-entry").toggleAttribute(
    "disabled",
    !activeTab || activeLibrary() || activePath() === path || !validEntries.has(activePath()),
  );
}
$("set-entry").onclick = () => { if (activeTab && !activeLibrary()) setEntry(activePath()); };
$("entry-select").onchange = () => {
  setEntry($<HTMLSelectElement>("entry-select").value);
  openFile(project.entry);
};
$("jump-source").onclick = () =>
  explainedLocation ? jump(explainedLocation) : jumpId(`track.${selected}`);
document.querySelectorAll<HTMLElement>("[data-view]").forEach(
  (el) =>
    (el.onclick = () => {
      view = el.dataset.view!;
      showView();
    }),
);
arrangement.onFollowScroll = (scrollLeft) => {
  if (followInspectionPending || view !== "arrangement") return;
  followInspectionPending = true;
  void refreshArrangement(scrollLeft).finally(() => {
    followInspectionPending = false;
  });
};
arrangement.onNavigation = () => {
  $<HTMLInputElement>("zoom").value = String(Math.log2(arrangement.zoom));
  $("zoom-value").textContent = `${Number(arrangement.zoom.toFixed(1))}×`;
  $("zoom").setAttribute(
    "aria-valuetext",
    `${Number(arrangement.zoom.toFixed(1))} times fit`,
  );
  $("zoom-out").toggleAttribute("disabled", arrangement.zoom <= 1);
  $("zoom-in").toggleAttribute(
    "disabled",
    arrangement.zoom >= arrangement.maxZoom,
  );
  $("follow").setAttribute("aria-pressed", String(arrangement.follow));
  $("kit-legend").hidden =
    view !== "arrangement" ||
    !arrangement.rows.some((row) => row.kind === "group");
  $("kit-legend").textContent = arrangement.densityMode
    ? "Kit lanes: hit density"
    : "◆ Hit · size and shade = velocity";
  scheduleArrangementInspection();
};
$("zoom").oninput = () =>
  arrangement.setZoom(2 ** +$<HTMLInputElement>("zoom").value);
$("zoom-in").onclick = () => arrangement.setZoom(arrangement.zoom * 2);
$("zoom-out").onclick = () => arrangement.setZoom(arrangement.zoom / 2);
$("zoom-fit").onclick = () => arrangement.fit();
$("center-playhead").onclick = () => arrangement.centerPlayhead();
$("follow").onclick = () => arrangement.setFollow(!arrangement.follow);
arrangement.onNavigation();
$("add-file").onclick = () => $<HTMLDialogElement>("file-dialog").showModal();
$("create-file").onclick = (e) => {
  let path: string;
  try {
    path = normalizeProjectPath($<HTMLInputElement>("new-file-name").value.trim());
    if (!path.endsWith(".muz") || path.split("/").some(part => part.startsWith(".muzpad-")) || projectFile(path))
      throw new Error("Choose a new relative .muz filename.");
  } catch {
    e.preventDefault();
    $("file-error").textContent = "Choose a new relative .muz filename.";
    return;
  }
  const tombstone = project.files.find(buffer => buffer.path === path && buffer.deleted);
  if (tombstone) {
    tombstone.text = "// New musical material\n";
    tombstone.bufferVersion++;
    tombstone.deleted = false;
    tombstone.dirty = true;
  } else {
    project.files.push({ id: crypto.randomUUID(), path, kind: "source", readOnly: false, bufferVersion: 1, diskVersion: null, text: "// New musical material\n", dirty: true, deleted: false });
  }
  project.dirty = true;
  scheduleEntryScan();
  updateFolderState();
  revision = ++project.sourceVersion;
  tree();
  openFile(path);
  updateRevision();
  saveDraft();
};
$("open-folder").onclick = () => {
  if (runtime.capabilities.environment === "desktop") $("mount-folder").click();
  else $<HTMLInputElement>("folder-input").click();
};
$("folder-input").onchange = async () => {
  try {
    const input = $<HTMLInputElement>("folder-input");
    const selectedFiles = Array.from(input.files ?? []);
    message("Opening project", "Reading folder files…");
    const entries: Record<string, Uint8Array> = {};
    let selectedBytes = 0;
    for (const f of selectedFiles) {
      const path = f.webkitRelativePath.split("/").slice(1).join("/");
      if (
        !isAssetPath(path) &&
        !/\.(muz|md)$/i.test(path) &&
        path !== "muzpad.json"
      )
        continue;
      if (isAssetPath(path) && f.size > ASSET_LIMITS.maxFileBytes)
        throw new Error(`${path} exceeds the per-file asset limit.`);
      selectedBytes += f.size;
      if (selectedBytes > ASSET_LIMITS.maxTotalBytes + 4_000_000)
        throw new Error("Folder exceeds the project import limit.");
      entries[path] = new Uint8Array(await f.arrayBuffer());
    }
    const { files, assets } = await importArchiveEntries(entries);
    await importProject(
      files,
      selectedFiles[0]?.webkitRelativePath.split("/")[0] ?? "Local project",
      { assets },
    );
    input.value = "";
  } catch (e) {
    error(e);
  }
};
$("open-zip").onclick = async () => {
  if (runtime.capabilities.environment === "web") { $<HTMLInputElement>("zip-input").click(); return; }
  try {
    await replaceProject(() => host.projects.importProject({ kind: "zipDialog" }, operation()));
  } catch (e) { error(e); }
};
$("zip-input").onchange = async () => {
  try {
    const input = $<HTMLInputElement>("zip-input");
    const f = input.files?.[0];
    if (!f) return;
    message("Opening project", "Reading project ZIP…");
    if (f.size > ASSET_LIMITS.maxTotalBytes + 4_000_000)
      throw new Error("Choose a project ZIP under 68 MB.");
    let archiveBytes = 0;
    const archive = unzipSync(new Uint8Array(await f.arrayBuffer()), {
      filter: (entry) => {
        const relevant =
          /\.(muz|md|mid|midi|wav|flac)$/i.test(entry.name) ||
          entry.name.endsWith("muzpad.json");
        if (!relevant) return false;
        if (entry.originalSize > ASSET_LIMITS.maxFileBytes)
          throw new Error("ZIP contains a file over the import limit.");
        archiveBytes += entry.originalSize;
        if (archiveBytes > ASSET_LIMITS.maxTotalBytes + 4_000_000)
          throw new Error("ZIP expands beyond the project import limit.");
        return true;
      },
    });
    const { files, assets } = await importArchiveEntries(archive);
    await importProject(files, f.name.replace(/\.zip$/i, ""), { assets });
    input.value = "";
  } catch (e) {
    error(e);
  }
};
function updateTransport(data: TransportStatus) {
  if (!acceptedRef || data.ref.project !== acceptedRef.project || data.ref.epoch !== acceptedRef.epoch || data.ref.engineEpoch !== acceptedRef.engineEpoch || data.ref.revision !== acceptedRef.revision) return;
  if (status && BigInt(data.generation) < BigInt(status.generation)) return;
  status = data;
  $("play").textContent = data.playing ? "Ⅱ Pause" : "▶ Play";
  $("loop").setAttribute("aria-pressed", String(!!data.loop));
  arrangement.position(data.beat, data.playing);
  arrangement.meters(data.playing ? data.meters.map(m => ({ id: m.track, peak: m.peak })) : []);
  if (!data.playing) analysisFrame = undefined;
  if (!data.playing) scopeDirty = true;
  $("clock").textContent = time(data.seconds);
  const meter = data.meter ?? [4, 4],
    bar = (meter[0] * 4) / meter[1];
  $("bar").textContent =
    `Bar ${Math.floor(data.beat / bar) + 1} · Beat ${((data.beat % bar) + 1).toFixed(1)}`;
  $("tempo").textContent = `${Math.round(data.bpm ?? 120)} BPM`;
  const db = data.playing && data.peak > 0.00001 ? 20 * Math.log10(data.peak) : -100;
  $("master-level").textContent = db < -80 ? "−∞ dB" : `${db.toFixed(1)} dB`;
  $("meter-fill").style.width =
    `${Math.min(100, Math.max(0, ((db + 60) / 60) * 100))}%`;
  const underruns = data.health.underruns;
  $("audio-health").textContent = typeof underruns === "number" && underruns > 0 ? `${underruns} audio underruns` : data.playing ? `Audio running · ${data.audio.backend}` : "";
  $("audio-health").title = JSON.stringify(data.health);
  if (preferences.value.layout.visualization && view === "automation" && views)
    document.querySelectorAll(".automation-value").forEach((el, i) => {
      el.textContent = automationValue(
        views.graph.extras.automation[i],
        data.seconds,
      ).toFixed(3);
    });
  if (preferences.value.layout.visualization && view === "automation" && status)
    document.querySelectorAll(".automation-cursor").forEach((el) => {
      const x = String(12 + (data.seconds / status.duration) * 676);
      el.setAttribute("x1", x);
      el.setAttribute("x2", x);
    });
}
const splitter = document.querySelector<HTMLElement>(".splitter")!;
let resizingFraction = preferences.value.layout.sourceFraction;
function resizeSource(x: number) {
  const source = $("source-pane").getBoundingClientRect();
  const visual = $("visualization-pane").getBoundingClientRect();
  const width = source.width + visual.width;
  if (!width) return;
  resizingFraction = Math.max(.25, Math.min(.70, (x - source.left) / width));
  document.querySelector<HTMLElement>(".workspace")!.style.setProperty("--source-fraction", String(resizingFraction));
  splitter.setAttribute("aria-valuenow", String(Math.round(resizingFraction * 100)));
}
splitter.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  splitter.setPointerCapture(event.pointerId);
  resizingFraction = preferences.value.layout.sourceFraction;
  splitter.onpointermove = move => resizeSource(move.clientX);
  const finish = (up: PointerEvent) => {
    splitter.onpointermove = null; splitter.onpointerup = null; splitter.onpointercancel = null;
    if (splitter.hasPointerCapture(up.pointerId)) splitter.releasePointerCapture(up.pointerId);
    preferences.update({ layout: { sourceFraction: resizingFraction } });
  };
  splitter.onpointerup = finish;
  splitter.onpointercancel = finish;
};
splitter.onkeydown = event => {
  const current = preferences.value.layout.sourceFraction;
  const fraction = event.key === "Home" ? .25 : event.key === "End" ? .70 : event.key === "ArrowLeft" ? current - .025 : event.key === "ArrowRight" ? current + .025 : null;
  if (fraction !== null) { event.preventDefault(); preferences.update({ layout: { sourceFraction: fraction } }); }
};
matchMedia("(max-width: 800px)").addEventListener("change", event => {
  if (event.matches && document.activeElement === splitter) $("pane-source").focus();
  editor.remeasure();
  arrangement.redraw();
});
let lastScope = 0;
function drawScopes(now: number) {
  requestAnimationFrame(drawScopes);
  if (!preferences.value.layout.visualization || !scopeDirty || now - lastScope < 66) return;
  lastScope = now;
  scopeDirty = false;
  const wave = status?.playing ? analysisFrame?.waveform ?? [] : [];
  const frequency = status?.playing ? analysisFrame?.spectrum ?? [] : [];
  for (const [id, data] of [
    ["scope", wave],
    ["spectrum", frequency],
  ] as const) {
    const canvas = $<HTMLCanvasElement>(id),
      c = canvas.getContext("2d")!;
    const w = canvas.width,
      h = canvas.height;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = color("#333");
    c.beginPath();
    c.moveTo(0, h / 2);
    c.lineTo(w, h / 2);
    c.stroke();
    c.strokeStyle = color("#ddd");
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x < w; x++) {
      const index =
        id === "scope"
          ? Math.floor((x / w) * data.length)
          : Math.min(data.length - 1, Math.floor(2 ** ((x / w) * 10) - 1));
      const value = data[index] ?? 0;
      const y = id === "scope" ? (1 - Math.max(-1, Math.min(1, value))) * h / 2 : h * (1 - Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, value)) + 100) / 100)));
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
}
requestAnimationFrame(drawScopes);
function applyCapabilities(capabilities: HostCapabilities) {
  $("mount-folder").hidden = !capabilities.filesystem.folder.available;
  $("mount-folder").title = capabilities.filesystem.folder.reason ?? "Open an authorized project folder";
  $("open-folder").hidden = capabilities.environment === "desktop";
  $("host-capabilities").textContent = capabilities.environment === "desktop"
    ? `${capabilities.platform} · native ${capabilities.nativePluginFormats.join(" / ") || "built-ins"}`
    : "Web · built-in instruments";
  $("host-capabilities").title = [capabilities.audio.reason, capabilities.filesystem.watch.reason, capabilities.pluginConfig?.label].filter(Boolean).join(" · ");
  $("play").toggleAttribute("disabled", !acceptedRef || !capabilities.audio.available || !engineAvailable);
  $("panic").toggleAttribute("disabled", !acceptedRef || !engineAvailable);
  if (project) updateFolderState();
}
runtime.subscribe(event => {
  if (event.kind === "status") updateTransport(event.status);
  else if (event.kind === "analysis") {
    const frame = event.frame;
    if (!acceptedRef || frame.ref.project !== acceptedRef.project || frame.ref.epoch !== acceptedRef.epoch || frame.ref.engineEpoch !== acceptedRef.engineEpoch || frame.ref.revision !== acceptedRef.revision || frame.source !== analysisSource) return;
    if (status && BigInt(frame.generation) < BigInt(status.generation)) return;
    if (analysisFrame && BigInt(frame.sequence) <= BigInt(analysisFrame.sequence)) return;
    analysisFrame = frame;
    scopeDirty = true;
  } else if (event.kind === "failure") error(event.failure);
  else if (event.kind === "engine") {
    engineAvailable = event.state === "ready";
    $("restart-engine").hidden = event.state !== "failed" && event.state !== "stopped";
    $("run").toggleAttribute("disabled", busy || !engineAvailable);
    if ((!engineAvailable && event.state !== "starting") || (acceptedRef && acceptedRef.engineEpoch !== event.engineEpoch)) {
      acceptedRef = null;
      inspection = undefined;
      analysisFrame = undefined;
      exporter.set();
      $("export-media").setAttribute("disabled", "");
      $("stop").setAttribute("disabled", "");
      arrangement.meters([]);
      arrangement.position(status?.beat ?? 0, false);
      scopeDirty = true;
      $("play").textContent = "▶ Play";
      $("meter-fill").style.width = "0";
      $("master-level").textContent = "−∞ dB";
      if (event.failure) error(event.failure);
    }
    applyCapabilities(event.capabilities);
    if (project) updateRevision();
  } else if (event.kind === "build" && event.requestId === activeBuildRequest && project && event.project.project === project.project && event.project.epoch === project.epoch) {
    commitInProgress = event.phase === "applying";
    $("cancel").hidden = !busy || commitInProgress;
    if (busy) message(event.phase[0].toUpperCase() + event.phase.slice(1), project.entry);
  }
});
$("panic").onclick = () => { void transport({ kind: "panic" }); };
host.subscribe(event => {
  if (event.kind === "preferencesFailure") preferences.reportFailure();
  else if (event.kind === "closeRequested") void prepareClose(event.reason, event.ticket);
});
$("restart-engine").onclick = async () => {
  $("restart-engine").setAttribute("disabled", "");
  try {
    const result = await host.restartEngine(operation());
    if (result && result.ref.project === project?.project && result.ref.epoch === project?.epoch) await acceptRevision(result);
  } catch (e) { error(e); }
  finally { $("restart-engine").removeAttribute("disabled"); }
};
$("reveal-project").onclick = () => {
  if (project) void host.projects.reveal({ project: project.project, epoch: project.epoch, id: activeTab && !activeLibrary() ? projectFile(activePath())?.id ?? null : null }, operation()).catch(error);
};
$("recent-projects").onclick = async () => {
  try {
    const recent = await host.projects.listRecent();
    const answer = await ask("Recent projects", recent.length ? "<p>Open a recent authorized project.</p>" : "<p>No recent projects.</p>", [...recent.map((item): [string, string] => [item.project, `${item.title} · ${item.rootLabel}${item.available ? "" : " (unavailable)"}`]), ["cancel", "Cancel"]]);
    if (answer === "cancel") return;
    await replaceProject(() => host.projects.openRecent(answer, operation()));
  } catch (e) { error(e); }
};
$("view-gist").onclick = event => {
  if (runtime.capabilities.environment !== "desktop") return;
  event.preventDefault();
  if (project?.gist) void host.openExternal(`https://gist.github.com/${project.gist}`).catch(error);
};
$("view-gist").onkeydown = event => { if (runtime.capabilities.environment === "desktop" && event.key === "Enter") $("view-gist").click(); };
$("view-gist").onauxclick = event => { if (runtime.capabilities.environment === "desktop") event.preventDefault(); };
applyCapabilities(runtime.capabilities);
function jsonRecord(value: Json | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
try {
  const response = await fetch(new URL("catalog.json", document.baseURI));
  if (!response.ok)
    throw new Error("Run npm run prepare:engine to bundle the source library.");
  catalog = await response.json();
  let initial: ProjectSnapshot | undefined;
  let starting = true;
  const offers = new Map<string, { id: string; title: string; rootLabel: string | null }>();
  host.projects.subscribe(event => {
    if (event.kind === "changed") {
      if (starting) { initial = event.snapshot; return; }
      if (!project || event.snapshot.project !== project.project || event.snapshot.epoch !== project.epoch) return;
      const resolution = event.reason === "conflict" && resolvingBuffer?.project === project.project && resolvingBuffer.epoch === project.epoch ? resolvingBuffer : undefined;
      void openProject(event.snapshot, false, event.reason, resolution).then(() => {
        if (project.conflicts.length) void resolveConflicts().catch(error);
      }).catch(error);
    } else if (event.kind === "recovery") {
      offers.set(event.offer.id, event.offer);
      renderRecoveryOffers();
    } else if (event.kind === "failure") error(event.failure);
    else if (event.kind === "watch") {
      if (project && (event.project.project !== project.project || event.project.epoch !== project.epoch)) return;
      folderWatch = event;
      if (project) updateFolderState();
    }
  });
  function renderRecoveryOffers() {
    document.getElementById("recovery-offers")?.remove();
    if (!offers.size) return;
    const region = document.createElement("div");
    region.id = "recovery-offers";
    for (const offer of offers.values()) {
      const button = document.createElement("button");
      button.textContent = offer.id === "muzpad-previous-v1" ? "Previous workspace" : `Recover ${offer.title}`;
      button.onclick = async () => {
        try {
          const answer = await ask("Recover working buffers?", `<p>${esc(offer.title)}${offer.rootLabel ? ` · ${esc(offer.rootLabel)}` : ""}</p><p>Restore recovered text or discard this recovery. Undo and view history are not stored across launches.</p>`, [["restore", "Restore"], ["discard", "Discard recovery"], ["cancel", "Cancel"]]);
          if (answer === "cancel") return;
          if (answer === "restore") {
            if (!await replaceProject(() => host.projects.restoreRecovery({ id: offer.id, action: "restore" }, operation()))) return;
          } else await host.projects.restoreRecovery({ id: offer.id, action: "discard" }, operation());
          offers.delete(offer.id); renderRecoveryOffers();
        } catch (e) { error(e); }
      };
      region.append(button);
    }
    document.querySelector(".panes-toolbar")!.append(region);
  }
  starting = false;
  const requested = new URL(location.href).searchParams.get("gist");
  if (requested !== null) {
    setGistURL(requested);
    await importGist(requested);
  } else {
    const next = initial ?? await host.projects.newProject({ title: "Untitled project", entry: "song.muz" }, operation());
    await openProject(next);
  }
} catch (e) {
  error(e);
}
