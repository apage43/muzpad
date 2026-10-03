import { loadGist, parseGist } from "./gist.js";
import { setTheme, isDarkTheme } from "./theme";
import "./style.css";
import { createWorkbenchHost } from "./host";
import type { AcceptedRevision, AnalysisFrame, CloseReason, DiffCategory, EntryClassification, HostCapabilities, Json, JsonObject, ProjectEvent, ProjectSnapshot, RevisionRef, TransportCommand, TransportStatus, WorkingCapture } from "./host/contracts";
import { PreferencesController } from "./preferences";
import { ProjectExporter } from "./export";
import { ASSET_LIMITS, importArchiveEntries, isAssetPath, normalizeProjectPath } from "./assets.js";
import { SourceEditor } from "./editor";
import { WorkbenchStatus, technicalDetails, describeActionFailure, olderObservation } from "./workbench-status";
import type { PerformedNote } from "./arrangement-layout";
import type { StatusChannel, ActionOutcome, ActionStatus } from "./workbench-status";
import {
  InspectionClient,
  ArrangementInspection,
  revisionIdentity,
  graphFromRows,
} from "./inspection";
import { renderDocument, revealDocumentAnchor } from "./document";
import { enableGraphPanning } from "./pan";
import {
  Arrangement,
  AnalysisRenderer,
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
const ownedRequests = new Set<string>();
const operation = (signal?: AbortSignal) => {
  const requestId = crypto.randomUUID();
  ownedRequests.add(requestId);
  if (ownedRequests.size > 256) ownedRequests.delete(ownedRequests.values().next().value!);
  return { requestId, signal };
};
const exporter = new ProjectExporter(runtime, operation, reportAcceptedExport);
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
  status: TransportStatus | undefined,
  selected = "",
  view = "arrangement",
  busy = false,
  commitInProgress = false;
let inspection: InspectionClient | undefined;
let latestTransportReceipt: TransportStatus | undefined;
let visualRevisionDirty = false;
let viewRenderToken = 0;
let explainedLocation: any;
let explanationToken = 0;
let selectionOrigin: "arrangement" | "catalog" = "catalog";
type ClassifiedEntry = { value: EntryClassification; project: string; epoch: string; sourceVersion: number };
let entryResults: Record<string, ClassifiedEntry> = {};
let lastEntryBuild: { project: string; epoch: string; entry: string; sourceVersion: number; outcome: ActionOutcome; summary: string } | undefined;
const deferredProjectFailures: Extract<ProjectEvent, { kind: "failure" }>[] = [];
let entryScanPending = false;
let entryScanToken = 0;
let entryScanTimer: number;
let entryScanAbort: AbortController | undefined;
let entryScanRequest: string | null = null;
let entryScanSnapshot: string | null = null;
let entryScanSource: Pick<WorkingCapture, "project" | "epoch" | "sourceVersion"> | undefined;
let entryScanProgress = "";
let workflowStatus = new WorkbenchStatus();
let recoveryAcknowledgedVersion: number | null = null;
let saving = false;
let reloading = false;
let draftTimer: ReturnType<typeof setTimeout>;
let closeInProgress = false;
type RetainedNativeWorkspace = {
  project: ProjectSnapshot; activeTab: TabKey | null; openTabs: TabKey[];
  editorStates: SourceEditor["states"]; documents: typeof documentStates; libraries: typeof libraryDocuments;
  ref: RevisionRef | null; accepted: number; entry: string; inspection: InspectionClient | undefined;
  views: typeof views; status: TransportStatus | undefined; selected: string;
  note: PerformedNote | undefined; origin: "arrangement" | "catalog"; analysisSource: string | null;
  surface: "source" | "music";
  workflow: WorkbenchStatus; recoveryVersion: number | null;
  buildState: string; buildDetail: string;
};
let retainedNativeWorkspace: RetainedNativeWorkspace | undefined;
let selectedNote: PerformedNote | undefined;
let automationPresentation: { ref: RevisionRef; identity: string; models: Parameters<typeof automationView>[0] } | undefined;
type OwnedAction = {
  channel: StatusChannel; action: string; requestId: string; owner: WorkbenchStatus;
  origin: ActionStatus["origin"]; ref: RevisionRef | null;
};
function acceptedStatusOwner(ref: RevisionRef) {
  const retained = retainedNativeWorkspace;
  return retained && ref.project === retained.project.project && ref.epoch === retained.project.epoch ? retained.workflow : workflowStatus;
}
function beginAction(channel: StatusChannel, action: string, requestId?: string, owner = workflowStatus, ref: RevisionRef | null = acceptedRef?.project === project?.project && acceptedRef?.epoch === project?.epoch ? acceptedRef : null): OwnedAction {
  const retained = retainedNativeWorkspace;
  const source = retained && owner === retained.workflow ? retained.project : project;
  const origin = source ? { project: source.project, epoch: source.epoch, title: source.title } : undefined;
  const id = owner.begin(channel, action, requestId);
  const pending = owner.channels.get(channel)!;
  owner.channels.set(channel, { ...pending, origin, technical: { requestId: id, ref, origin } });
  return { channel, action, requestId: id, owner, origin, ref };
}
function visibleStatusOwners() {
  return retainedNativeWorkspace && retainedNativeWorkspace.workflow !== workflowStatus ? [retainedNativeWorkspace.workflow, workflowStatus] : [workflowStatus];
}
function settleAction(ticket: OwnedAction, result: Omit<ActionStatus, "channel" | "action" | "requestId" | "origin">, ownership: "explicit" | "background" = "explicit") {
  const details = result.technical && typeof result.technical === "object" && !Array.isArray(result.technical) ? result.technical : { details: result.technical };
  const receipt: ActionStatus = { ...result, channel: ticket.channel, action: ticket.action, requestId: ticket.requestId, origin: ticket.origin, technical: { requestId: ticket.requestId, ref: ticket.ref, origin: ticket.origin, ...details } };
  const acknowledged = ticket.owner.settle(receipt, ownership);
  if (acknowledged && ownership === "explicit" && !visibleStatusOwners().includes(ticket.owner)) workflowStatus.report(receipt);
  renderWorkflowStatus();
  return acknowledged && ticket.owner.channels.get(ticket.channel)?.requestId === ticket.requestId;
}
function reportAcceptedExport(revision: AcceptedRevision & { name: string }) {
  const owner = acceptedStatusOwner(revision.ref);
  const origin = { project: revision.ref.project, epoch: revision.ref.epoch, title: revision.name };
  return (outcome: ActionStatus) => {
    const receipt = { ...outcome, origin };
    owner.report(receipt);
    if (!visibleStatusOwners().includes(owner)) workflowStatus.report(receipt);
    renderWorkflowStatus();
  };
}
function syncRetainedPresentation(ref: RevisionRef, buildDetail: string) {
  const retained = retainedNativeWorkspace;
  if (!retained?.ref || revisionIdentity(retained.ref) !== revisionIdentity(ref)) return;
  Object.assign(retained, { ref, accepted, entry: acceptedEntry, inspection, views, status, selected,
    note: selectedNote, origin: selectionOrigin, analysisSource, buildState: "Accepted", buildDetail });
}

$("app").innerHTML = `
  <header class="topbar"><details class="command-menu" id="project-menu"><summary>Project</summary><div class="command-items"><button id="new-project">New project</button><button id="mount-folder" hidden>Connect folder…</button><button id="open-folder" title="Edits are not written back; export ZIP to keep a portable copy.">Import folder copy…</button><button id="import-gist">Import from gist</button><button id="open-zip">Import ZIP preview…</button><button id="reload-folder" hidden>Reload folder</button><button id="recent-projects">Recent projects</button><button id="reveal-project" hidden>Reveal project</button><a id="view-gist" class="button-link" target="_blank" rel="noopener noreferrer" hidden>View gist ↗</a></div></details><div class="project-identity"><div class="project-title" id="project-title">muzpad</div><div class="workspace-status"><strong id="workspace-mode">Browser copy</strong><span id="folder-state">No folder connected</span></div></div><div class="project-actions" aria-label="Current workspace actions"><button id="save-folder" hidden>Save</button><details class="command-menu"><summary>Export</summary><div class="command-items"><button id="export-media" disabled>Accepted audio / MIDI…</button><button id="download">Working project ZIP…</button></div></details><details class="command-menu" id="view-menu"><summary>View</summary><div class="command-items panes-toolbar">${(["explorer", "source", "visualization", "inspector"] as const).map(name => `<button id="pane-${name}" aria-controls="${name === "inspector" ? name : `${name}-pane`}">${name === "visualization" ? "Music" : name[0].toUpperCase() + name.slice(1)}</button>`).join("")}<button id="view-reset-layout">Reset layout</button></div></details><button id="theme-toggle" aria-label="Settings">Settings</button></div></header>
  <div class="transport" role="region" aria-label="Music transport"><div class="transport-buttons"><button id="restart" class="icon-button" aria-label="Return to start" title="Return to start">↤</button><button id="play" class="play-button" disabled>▶ Play</button><button id="stop" class="icon-button" aria-label="Stop" title="Stop" disabled>■</button></div><div class="clock"><span id="clock">0:00</span><span id="length">/ —</span></div><div class="position"><span id="bar">Bar 1 · Beat 1</span><span id="tempo">— BPM</span></div><select id="section" aria-label="Seek to section"><option value="">Sections</option></select><button id="loop" aria-pressed="false">↻ Loop section</button><details class="range-menu"><summary>Range</summary><div><label>Start beat <input id="loop-start" type="number" min="0" value="0"></label><label>End beat <input id="loop-end" type="number" min="0" value="16"></label><button id="apply-loop">Loop range</button></div></details><div class="master-meter" title="Master output peak"><span id="meter-fill"></span></div><span id="master-level">−∞ dB</span><div class="transport-spacer"></div><span id="revision">No accepted revision</span><button id="cancel" hidden>Cancel</button><button id="run" class="primary">Rebuild</button></div>
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
const transportOverflow = document.createElement("details");
transportOverflow.id = "transport-overflow";
transportOverflow.innerHTML = '<summary aria-label="More transport">More</summary><div id="transport-secondary"></div>';
$("section").before(transportOverflow);
$("transport-secondary").append($("section"), $("loop"), document.querySelector(".range-menu")!, $("panic"));
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
$("diagnostic-list").insertAdjacentHTML("afterend", '<div id="recovery-status" hidden></div>');
document.querySelector(".transport")!.insertAdjacentHTML("afterend", '<div class="surface-toolbar" role="toolbar" aria-label="Workspace surface"><button id="explorer-drawer" aria-expanded="false" aria-controls="explorer-pane">Explorer</button><button id="surface-source" aria-pressed="true">Source</button><button id="surface-music" aria-pressed="false">Music</button></div>');
document.querySelector(".diagnostics-heading")!.insertAdjacentHTML("beforeend", '<button id="restart-engine" hidden>Restart engine</button><span id="host-capabilities"></span>');
$("diagnostic-list").insertAdjacentHTML("beforebegin", '<div id="workflow-status" role="region" aria-label="Independent action outcomes"></div><span id="workflow-announcement" class="sr-only" role="status" aria-live="polite"></span>');
document.querySelector(".visual-pane")!.insertAdjacentHTML("afterbegin", '<div id="displayed-music-context" role="status" hidden></div>');
$("entry-notice").insertAdjacentHTML("afterend", '<div id="entry-classification" role="status"></div><button id="trust-and-run" hidden>Trust and run…</button><button id="cancel-entry-scan" hidden>Cancel entry scan</button>');
document.querySelector(".selection-heading")!.insertAdjacentHTML("afterbegin", '<select id="track-select" aria-label="Inspect track"><option value="">No accepted tracks</option></select>');
document.querySelector(".arrangement-tools")!.insertAdjacentHTML("beforeend", '<details class="seek-menu"><summary>Seek</summary><label>Beat <input id="seek-beat" type="number" min="0" value="0"></label><button id="seek-beat-apply">Seek to beat</button></details>');
document.addEventListener("pointerdown", event => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(".command-menu[open], #transport-overflow[open]")) {
    if (menu === transportOverflow && !narrowWorkspace.matches) continue;
    if (!menu.contains(target)) menu.open = false;
  }
});
document.addEventListener("click", event => {
  const control = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".command-items button, .command-items a");
  const menu = control?.closest<HTMLDetailsElement>(".command-menu");
  if (!control || !menu?.open) return;
  const focused = document.activeElement;
  menu.open = false;
  // A command may already have moved focus to a dialog or restored pane.
  // Otherwise return it to a visible invoker, never a now-hidden menu item.
  if (focused === control || focused === document.body) menu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
  const menu = (document.activeElement as HTMLElement | null)?.closest<HTMLDetailsElement>(".command-menu[open], #transport-overflow[open]");
  if (menu && (menu !== transportOverflow || narrowWorkspace.matches)) { event.preventDefault(); menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus(); }
});
const analysisDisclosure = document.createElement("details");
analysisDisclosure.id = "analysis-disclosure";
analysisDisclosure.innerHTML = '<summary>Analysis <span id="analysis-state">Stopped</span></summary>';
document.querySelector(".analysis-heading")!.before(analysisDisclosure);
analysisDisclosure.append(document.querySelector(".analysis-heading")!, document.querySelector(".analysis-strip")!);
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
const arrangementInspection = new ArrangementInspection(arrangement, failure => error(failure, "Refresh arrangement"));
const analysisRenderer = new AnalysisRenderer($<HTMLCanvasElement>("scope"), $<HTMLCanvasElement>("spectrum"));
enableGraphPanning($("graph-view"));
arrangement.onSeek = (beat) => seek(beat);
arrangement.onSelect = (track, note) => selectTrack(track, note, "arrangement");
arrangement.onAudition = (muted, solo) => {
  if (!acceptedRef || acceptedRef.project !== project.project) return;
  const ref = acceptedRef, op = operation();
  const ticket = beginAction("playback", "Change track audition", op.requestId, acceptedStatusOwner(ref), ref);
  renderWorkflowStatus();
  void runtime.audition(ref, { muted, solo }, op).then(() => {
    settleAction(ticket, { outcome: "applied", summary: "Track audition applied.", nextAction: "Continue listening or change track controls.", technical: { requestedRef: ref, muted, solo } });
  }).catch(e => error(e, "Change track audition", "playback", ticket));
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
  for (const facts of document.querySelectorAll<HTMLElement>("[data-usable-facts]")) facts.textContent = `${facts.dataset.workspaceFacts === "current" ? "Current workspace: " : ""}${usableFacts()}`;
}
function currentClassification(path: string) {
  const result = entryResults[path];
  return result && result.project === project.project && result.epoch === project.epoch && result.sourceVersion === project.sourceVersion ? result.value : undefined;
}
function classifiedEntry(value: EntryClassification, source: Pick<WorkingCapture, "project" | "epoch" | "sourceVersion">): ClassifiedEntry {
  return { value, project: source.project, epoch: source.epoch, sourceVersion: source.sourceVersion };
}
function entrySelectable(path: string) {
  return !!projectFile(path) && /\.muz$/i.test(path) && currentClassification(path)?.kind !== "non-song";
}
function updateEntryChoices() {
  const entries = [...new Set([...(project.entries ?? []), project.entry, ...Object.keys(entryResults).sort()])].filter(Boolean);
  const attempt = lastEntryBuild?.project === project.project && lastEntryBuild.epoch === project.epoch && lastEntryBuild.sourceVersion === project.sourceVersion ? lastEntryBuild : undefined;
  $("entry-select").innerHTML = entries.map(path => {
    const result = currentClassification(path), previous = entryResults[path]?.value;
    const blocked = attempt?.entry === path && (attempt.outcome === "failed" || attempt.outcome === "rejected");
    const reason = !projectFile(path) ? "missing" : !/\.muz$/i.test(path) ? "not a .muz source entry"
      : result ? `${result.kind} · ${blocked ? "blocked by last rebuild" : result.readiness.kind}` : previous ? `unchecked · previous ${previous.kind} result is stale` : "unchecked";
    return `<option value="${esc(path)}" ${(!projectFile(path) || !/\.muz$/i.test(path) || result?.kind === "non-song") && path !== project.entry ? "disabled" : ""}>${esc(path)} · ${esc(reason)}</option>`;
  }).join("");
  $<HTMLSelectElement>("entry-select").value = project.entry;
  $("entry-select").toggleAttribute("disabled", !entries.length);
  $("set-entry").toggleAttribute("disabled", !activeTab || activeLibrary() || !entrySelectable(activePath()) || activePath() === project.entry);
  const result = currentClassification(project.entry), previous = entryResults[project.entry]?.value;
  const declared = project.entries?.includes(project.entry) ? "Declared and selected" : "Selected";
  const reason = !projectFile(project.entry) ? "Source file is missing; select another candidate or restore it."
    : !/\.muz$/i.test(project.entry) ? "This declaration is not a .muz source entry; Rebuild will report the selected entry's typed failure. Select a source alternative explicitly."
    : result ? `${result.kind} · readiness ${result.readiness.kind}. ${result.failure?.message ?? (result.readiness.kind === "blocked" ? result.readiness.failure.message : result.description ?? "Classification does not certify playback; Rebuild validates and applies music.")}`
    : previous ? `Current source is unchecked; previous ${previous.kind} classification is stale.` : "Not classified.";
  const buildReason = attempt?.entry === project.entry ? ` Last Rebuild ${attempt.outcome}: ${attempt.summary}` : "";
  $("entry-classification").textContent = `${declared}: ${project.entry}. ${reason}${buildReason}${entryScanPending ? ` Checking entries${entryScanProgress ? ` · ${entryScanProgress}` : "…"}; previous results are stale.` : entryScanProgress ? ` ${entryScanProgress}` : ""}`;
  $("cancel-entry-scan").hidden = !entryScanPending;
  $("trust-and-run").hidden = project.execution.trusted;
}
function scheduleEntryScan(delay = 600) {
  clearTimeout(entryScanTimer);
  entryScanAbort?.abort();
  entryScanRequest = null; entryScanSnapshot = null; entryScanSource = undefined;
  const token = ++entryScanToken;
  entryScanProgress = "";
  if (!project.execution.trusted) { entryScanPending = false; updateEntryChoices(); return; }
  entryScanPending = true;
  updateEntryChoices();
  const controller = new AbortController();
  entryScanAbort = controller;
  entryScanTimer = window.setTimeout(async () => {
    const captured = capture();
    const scanOperation = operation(controller.signal);
    entryScanRequest = scanOperation.requestId;
    try {
      const snapshot = await host.projects.snapshotSources(captured, operation(controller.signal));
      if (token !== entryScanToken || controller.signal.aborted) return;
      entryScanSnapshot = snapshot.id;
      entryScanSource = captured;
      const candidates = [...new Set([...(project.entries ?? []), project.entry, ...project.files.filter(f => !f.deleted && /\.muz$/i.test(f.path)).map(f => f.path).sort()])].filter(path => !!projectFile(path) && /\.muz$/i.test(path));
      if (!candidates.length) { entryScanProgress = "No existing .muz source candidates to classify; declared choices remain visible."; return; }
      const result = await runtime.checkEntries({ snapshot: snapshot.id, entries: candidates }, scanOperation);
      if (token !== entryScanToken || captured.project !== project.project || captured.epoch !== project.epoch || result.snapshot !== snapshot.id || result.sourceVersion !== project.sourceVersion) return;
      entryResults = Object.fromEntries(result.entries.map(entry => [entry.entry, classifiedEntry(acceptedRef?.project === captured.project && acceptedRef.epoch === captured.epoch && acceptedRef.entry === entry.entry && acceptedRef.sourceVersion === captured.sourceVersion ? { ...entry, readiness: { kind: "validated" as const } } : entry, captured)]));
      entryScanProgress = "Classification complete; readiness remains separate from accepted playback.";
    } catch (e) {
      if (token === entryScanToken) {
        entryScanProgress = controller.signal.aborted ? "Scan cancelled; previous results retained as stale." : "Scan failed; previous results retained as stale.";
        if (!controller.signal.aborted) error(e, "Classify entries");
      }
    } finally {
      if (token === entryScanToken) { entryScanPending = false; entryScanRequest = null; entryScanSnapshot = null; entryScanSource = undefined; updateEntryChoices(); }
    }
  }, delay);
}
$("cancel-entry-scan").onclick = () => { clearTimeout(entryScanTimer); entryScanAbort?.abort(); entryScanToken++; entryScanRequest = null; entryScanSnapshot = null; entryScanSource = undefined; entryScanPending = false; entryScanProgress = "Scan cancelled; previous results are stale."; updateEntryChoices(); };
$("trust-and-run").onclick = async () => {
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  workspace.inert = true;
  $("trust-and-run").setAttribute("disabled", "");
  try {
    if (!await persistDraft()) return;
    const next = await host.projects.trustAndRun({ project: { project: project.project, epoch: project.epoch } }, operation());
    workspace.inert = false;
    if (next) await openProject(next);
  } catch (e) { error(e, "Trust and run"); }
  finally { workspace.inert = false; $("trust-and-run").removeAttribute("disabled"); }
};
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
  const captured = capture(), op = operation();
  const ticket = beginAction("save", "Save to folder", op.requestId);
  renderWorkflowStatus();
  updateFolderState();
  try {
    await persistDraft();
    const result = await host.projects.save({ project: captured.project, epoch: captured.epoch, files: captured.buffers, settings: captured.settings, settingsDiskVersion: captured.settingsDiskVersion }, op);
    const currentWorkspace = project.project === captured.project && project.epoch === captured.epoch;
    if (!currentWorkspace) {
      settleAction(ticket, { outcome: result.failures.length || result.conflicts.length || !result.settingsSaved ? result.saved.length || result.settingsSaved ? "partial" : "failed" : "applied", summary: `${result.saved.length} captured files saved; ${result.failures.length} failures and ${result.conflicts.length} conflicts reported for the originating workspace.`, nextAction: "Return to that workspace to review disk state before retrying.", technical: { project: captured.project, epoch: captured.epoch, sourceVersion: captured.sourceVersion, result } });
      return !result.failures.length && !result.conflicts.length && result.settingsSaved;
    }
    for (const saved of result.saved) {
      const buffer = project.files.find(f => f.id === saved.fileId);
      if (buffer) { buffer.diskVersion = saved.diskVersion; if (buffer.bufferVersion === saved.bufferVersion) buffer.dirty = false; }
    }
    project.conflicts = result.conflicts;
    project.settingsDiskVersion = result.settingsDiskVersion;
    project.diskGeneration = result.diskGeneration;
    const savedEntries = captured.settings.entries ?? [], currentEntries = project.entries ?? [];
    const newerSettings = project.title !== captured.settings.title || project.entry !== captured.settings.entry || savedEntries.length !== currentEntries.length || savedEntries.some((entry, index) => entry !== currentEntries[index]);
    project.dirty = project.files.some(f => f.dirty) || !result.settingsSaved || newerSettings;
    if (result.failures.length || result.conflicts.length || !result.settingsSaved) {
      settleAction(ticket, { outcome: result.saved.length || result.settingsSaved ? "partial" : "failed", summary: `${result.saved.length} files saved; ${result.failures.length} failures and ${result.conflicts.length} conflicts remain.`, nextAction: "Resolve conflicts or inspect failed file diagnostics before retrying Save explicitly.", technical: { project: captured.project, epoch: captured.epoch, sourceVersion: captured.sourceVersion, result } });
    } else {
      settleAction(ticket, { outcome: "applied", summary: project.dirty ? "Captured buffers saved; newer edits remain unsaved." : "Working buffers saved to disk.", nextAction: project.dirty ? "Save again to write newer edits." : "Continue editing.", technical: { project: captured.project, epoch: captured.epoch, sourceVersion: captured.sourceVersion, result } });
    }
    if (result.conflicts.length) await resolveConflicts();
    return !result.failures.length && !result.conflicts.length && result.settingsSaved;
  } catch (e) { error(e, "Save to folder", "save", ticket); return false; }
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
    for (const failure of result.save?.failures ?? []) error(failure.failure, "Save before closing", "save");
    if (result.save?.conflicts.length) { project.conflicts = result.save.conflicts; await resolveConflicts(); }
    if (!result.allowed || !result.token) return false;
    await host.projects.close({ project: project.project, epoch: project.epoch, token: result.token }, operation());
    return true;
  } catch (e) { error(e, "Close project"); return false; }
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
  } catch (e) { if (!(e instanceof Error && e.name === "AbortError")) error(e, runtime.capabilities.environment === "desktop" ? "Open folder…" : "Connect folder…"); }
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
  } catch (e) { error(e, "Reload folder", "save"); }
  finally { reloading = false; updateFolderState(); }
};
window.addEventListener("keydown", event => {
  if (closeInProgress || replacementInProgress) return;
  if (!(event.ctrlKey || event.metaKey)) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.key.toLowerCase() === "s") { event.preventDefault(); if (project?.rootLabel) void saveFolder(); else void download(); }
  if (runtime.capabilities.environment !== "desktop") return;
  if (event.key === "Enter") { event.preventDefault(); void run(); }
  if (event.key.toLowerCase() === "n") { event.preventDefault(); $("new-project").click(); }
  if (event.key.toLowerCase() === "w" && !event.shiftKey) { event.preventDefault(); if (activeTab) closeTab(activeTab); }
  if (event.key.toLowerCase() === "o") { event.preventDefault(); $("mount-folder").click(); }
  if (event.key === ",") { event.preventDefault(); $("theme-toggle").click(); }
});
type Pane = "explorer" | "source" | "visualization" | "inspector";
const paneFocus = new Map<Pane, HTMLElement>();
const paneNode = (name: Pane) => $(name === "inspector" ? name : `${name}-pane`);
const narrowWorkspace = matchMedia("(max-width: 800px)");
const tinyTransport = matchMedia("(max-width: 360px)");
let activeSurface: "source" | "music" = "source";
let explorerDrawerOpen = false;
let explorerInvoker: HTMLElement | null = null;
let analysisSubscriptionKey = "";
function musicVisible() {
  return !document.hidden && (narrowWorkspace.matches ? activeSurface === "music" : preferences.value.layout.visualization);
}
function updateVisibility() {
  const visible = musicVisible();
  arrangementInspection.setVisible(visible && view === "arrangement");
  updateArrangementToolbar();
  const detail = visible && analysisDisclosure.open;
  analysisRenderer.setVisible(detail);
  if (!detail) { analysisFrame = undefined; analysisRenderer.reset(); }
  $("analysis-state").textContent = !acceptedRef ? "No accepted music" : !status?.playing ? "Stopped" : !detail ? "Suspended" : analysisFrame && !analysisFrame.warmup ? "Live" : "Loading fresh window…";
  const subscriptionKey = `${acceptedRef?.project}:${acceptedRef?.epoch}:${acceptedRef?.engineEpoch}:${acceptedRef?.revision}:${analysisSource}:${detail}:${visible}`;
  if (acceptedRef && subscriptionKey !== analysisSubscriptionKey) {
    analysisSubscriptionKey = subscriptionKey;
    void runtime.analysis(acceptedRef, { source: analysisSource, detail, meters: visible, detailHz: Math.min(30, runtime.capabilities.limits.analysisHz), meterHz: Math.min(20, runtime.capabilities.limits.statusHz) }).catch(e => { $("analysis-state").textContent = "Analysis unavailable"; error(e, "Observe analysis"); });
  }
}
function setSurface(surface: "source" | "music", focus = false) {
  activeSurface = surface;
  document.querySelector<HTMLElement>(".workspace")!.dataset.surface = surface;
  $("surface-source").setAttribute("aria-pressed", String(surface === "source"));
  $("surface-music").setAttribute("aria-pressed", String(surface === "music"));
  if (narrowWorkspace.matches) {
    $("source-pane").hidden = surface !== "source";
    $("visualization-pane").hidden = surface !== "music";
    explorerDrawerOpen = false;
    $("explorer-pane").hidden = true;
    $("explorer-drawer").setAttribute("aria-expanded", "false");
  }
  updateVisibility();
  editor.remeasure();
  if (surface === "music" && views && visualRevisionDirty) void showView();
  if (focus) {
    if (surface === "source") { if (activeTab && !$("editor").hidden) editor.view.focus(); else $(activeTab && !$("document").hidden ? "document" : "open-entrypoint").focus(); }
    else document.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus();
  }
}
$("surface-source").onclick = () => setSurface("source", true);
$("surface-music").onclick = () => setSurface("music", true);
$("explorer-drawer").onclick = () => {
  if (!explorerDrawerOpen) explorerInvoker = document.activeElement as HTMLElement;
  explorerDrawerOpen = !explorerDrawerOpen;
  $("explorer-pane").hidden = !explorerDrawerOpen;
  $("explorer-drawer").setAttribute("aria-expanded", String(explorerDrawerOpen));
  if (explorerDrawerOpen) $("file-search").focus(); else explorerInvoker?.focus();
};
$("explorer-pane").addEventListener("keydown", event => {
  if (event.key === "Escape" && narrowWorkspace.matches && explorerDrawerOpen) { event.preventDefault(); $("explorer-drawer").click(); }
});
analysisDisclosure.ontoggle = updateVisibility;
document.addEventListener("visibilitychange", updateVisibility);
function setPane(name: Pane, visible: boolean, restoreFocus = false) {
  const node = paneNode(name), focused = document.activeElement as HTMLElement | null;
  if (narrowWorkspace.matches && name !== "inspector") {
    if (name === "explorer") {
      if (visible !== explorerDrawerOpen) $("explorer-drawer").click();
    } else setSurface(visible ? name === "source" ? "source" : "music" : name === "source" ? "music" : "source", restoreFocus);
    return;
  }
  if (!visible && focused && node.contains(focused)) {
    paneFocus.set(name, focused);
    $("view-menu").setAttribute("open", "");
    $(`pane-${name}`).focus();
  }
  preferences.update({ layout: { [name]: visible, ...(name === "inspector" && visible ? { visualization: true } : {}) } });
  if (visible && restoreFocus) {
    const remembered = paneFocus.get(name);
    if (remembered?.isConnected && remembered.getClientRects().length) remembered.focus();
    else if (name === "explorer") $("file-search").focus();
    else if (name === "source") { if (activeTab && /\.muz$/i.test(activePath())) editor.view.focus(); else $(activeTab ? "document" : "open-entrypoint").focus(); }
    else if (name === "visualization") document.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus();
    else $("inspector").focus();
  }
}
let appliedTheme = "";
function applyPreferences() {
  transportOverflow.open = !narrowWorkspace.matches;
  if (tinyTransport.matches) $("transport-secondary").prepend($("restart"), $("stop"), $("cancel"), $("run"));
  else {
    document.querySelector(".transport-buttons")!.prepend($("restart"));
    $("play").after($("stop"));
    document.querySelector(".transport")!.append($("cancel"), $("run"));
  }
  const value = preferences.value;
  for (const name of ["explorer", "source", "visualization", "inspector"] as const) {
    paneNode(name).hidden = name === "explorer" && narrowWorkspace.matches ? !explorerDrawerOpen : name === "source" && narrowWorkspace.matches ? activeSurface !== "source" : name === "visualization" && narrowWorkspace.matches ? activeSurface !== "music" : !value.layout[name];
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
    analysisRenderer.redraw();
    arrangement.requestDraw();
  }
  updateVisibility();
  if (value.layout.source) editor.remeasure();
  if (musicVisible() && visualRevisionDirty && views) void showView();
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
$("view-reset-layout").onclick = () => { preferences.resetLayout(); setSurface("source"); };
applyPreferences();
function chooseAnalysis(id: string | null) {
  analysisSource = id;
  analysisFrame = undefined;
  analysisRenderer.reset();
  updateVisibility();
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
function actionMessage(action: string, summary: string, outcome: ActionOutcome = "pending") {
  const ticket = beginAction("operation", action);
  settleAction(ticket, { outcome, summary, nextAction: outcome === "pending" ? "You can continue editing." : "Review the current workspace before another action." });
  return ticket;
}
function usableFacts() {
  const uncertain = visibleStatusOwners().flatMap(owner => [...owner.channels.values(), ...owner.issues.values()]).some(issue =>
    (issue.channel === "build" || issue.channel === "playback") && (!issue.origin || (issue.origin.project === acceptedRef?.project && issue.origin.epoch === acceptedRef?.epoch)) && (issue.outcome === "unknown" || issue.outcome === "partial"));
  const music = !engineAvailable ? "Engine unavailable; working buffers remain usable."
    : acceptedRef ? uncertain
      ? `Last acknowledged music is revision ${acceptedRef.revision} (${acceptedRef.entry}); the latest action's playback effects are uncertain.`
      : `Revision ${acceptedRef.revision} (${acceptedRef.entry}) remains loaded; ${status?.playing ? "playback last observed running" : "playback last observed paused"}.`
    : "No accepted music is loaded; working buffers remain usable.";
  const disk = !project?.rootLabel ? "Disconnected copy; edits are not written back." : project.dirty ? "Working edits are not saved to disk." : "Current buffers are saved to disk.";
  const recovery = recoveryAcknowledgedVersion === null ? "Recovery has not been acknowledged." : `Recovery acknowledged through source version ${recoveryAcknowledgedVersion}${project && recoveryAcknowledgedVersion < project.sourceVersion ? "; newer edits are not acknowledged" : ""}.`;
  return `${music} ${disk} ${recovery}`;
}
const announcedOutcomes = new Map<string, ActionOutcome>();
function statusSourceAvailable(issue: ActionStatus): boolean {
  const technical = issue.technical;
  if (!technical || typeof technical !== "object" || !("ref" in technical) || technical.ref == null) return true;
  const ref = technical.ref;
  return typeof ref === "object" && "project" in ref && "epoch" in ref && !!project && ref.project === project.project && ref.epoch === project.epoch;
}
const renderedOutcomes = new WeakMap<HTMLElement, string>();
function renderWorkflowStatus() {
  const region = $("workflow-status");
  const expanded = new Set([...region.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.request));
  const focused = region.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusedRequest = focused?.closest<HTMLDetailsElement>("details[data-request]")?.dataset.request;
  const focusedOpenError = focused?.dataset.openError;
  const owners = visibleStatusOwners();
  const outcomes = [...new Map(owners.flatMap(owner => [...owner.issues.values(), ...owner.channels.values()]).map(issue => [issue.requestId, issue])).values()];
  const existing = new Map([...region.querySelectorAll<HTMLElement>("section[data-action-request]")].map(node => [node.dataset.actionRequest, node]));
  const nextNodes = outcomes.map(issue => {
    const previousWorkspace = !!issue.origin && (issue.origin.project !== project?.project || issue.origin.epoch !== project?.epoch);
    const archived = owners.some(owner => owner.issues.has(issue.requestId));
    const markup = `<section class="action-status" data-action-request="${esc(issue.requestId)}" data-outcome="${issue.outcome}"><strong>${esc(issue.action)} · ${esc(issue.outcome)}</strong>${previousWorkspace ? `<span>Originating workspace: ${esc(issue.origin!.title)}.</span>` : ""}<span>${esc(issue.summary)}</span><p><span data-usable-facts data-workspace-facts="${previousWorkspace ? "current" : "origin"}"></span> ${esc(issue.nextAction)}</p>${issue.location ? `<button data-open-error="${esc(issue.requestId)}" ${statusSourceAvailable(issue) ? "" : 'disabled title="This diagnostic belongs to another project; return to that project to open its source."'}>Open error</button>` : ""}${archived ? `<button data-acknowledge="${esc(issue.requestId)}">Acknowledge outcome</button>` : ""}${issue.technical !== undefined ? `<details data-request="${esc(issue.requestId)}"><summary>Technical diagnostics</summary><button data-copy-request="${esc(issue.requestId)}">Copy diagnostics</button><pre tabindex="0">${esc(technicalDetails(issue.technical))}</pre></details>` : ""}</section>`;
    const retained = existing.get(issue.requestId);
    if (retained && renderedOutcomes.get(retained) === markup) return retained;
    const template = document.createElement("template");
    template.innerHTML = markup;
    const node = template.content.firstElementChild as HTMLElement;
    const details = node.querySelector("details");
    if (details) details.open = expanded.has(issue.requestId);
    renderedOutcomes.set(node, markup);
    return node;
  });
  nextNodes.forEach((node, index) => {
    if (region.children[index] !== node) region.insertBefore(node, region.children[index] ?? null);
  });
  const retainedNodes = new Set(nextNodes);
  for (const node of [...region.children]) if (!retainedNodes.has(node as HTMLElement)) node.remove();
  for (const facts of region.querySelectorAll<HTMLElement>("[data-usable-facts]"))
    facts.textContent = `${facts.dataset.workspaceFacts === "current" ? "Current workspace: " : ""}${usableFacts()}`;
  const retainedIds = new Set(outcomes.map(issue => issue.requestId));
  for (const id of announcedOutcomes.keys()) if (!retainedIds.has(id)) announcedOutcomes.delete(id);
  const announcements: string[] = [];
  for (const issue of outcomes) {
    if (issue.channel === "recovery" && (issue.outcome === "applied" || issue.outcome === "pending")) continue;
    if (announcedOutcomes.get(issue.requestId) !== issue.outcome) {
      announcedOutcomes.set(issue.requestId, issue.outcome);
      announcements.push(`${issue.action}: ${issue.outcome}. ${issue.summary}`);
    }
  }
  if (announcements.length) $("workflow-announcement").textContent = announcements.join(" ");
  if (focused) {
    const replacement = focusedRequest
      ? [...region.querySelectorAll<HTMLDetailsElement>("details[data-request]")].find(node => node.dataset.request === focusedRequest)?.querySelector<HTMLElement>(focused.tagName === "BUTTON" ? "button" : "summary")
      : [...region.querySelectorAll<HTMLElement>("[data-open-error]")].find(node => node.dataset.openError === focusedOpenError);
    replacement?.focus({ preventScroll: true });
  }
  for (const button of region.querySelectorAll<HTMLElement>("[data-copy-request]")) button.onclick = () => {
    const issue = outcomes.find(value => value.requestId === button.dataset.copyRequest);
    if (issue) void navigator.clipboard.writeText(technicalDetails(issue.technical)).then(() => { button.textContent = "Copied"; }).catch(() => { button.textContent = "Select diagnostics to copy"; });
  };
  for (const button of region.querySelectorAll<HTMLElement>("[data-open-error]")) button.onclick = () => {
    const issue = outcomes.find(value => value.requestId === button.dataset.openError);
    if (issue && statusSourceAvailable(issue)) void jump(issue.location);
  };
  for (const button of region.querySelectorAll<HTMLElement>("[data-acknowledge]")) button.onclick = () => { for (const owner of owners) owner.issues.delete(button.dataset.acknowledge!); renderWorkflowStatus(); };
}
function error(e: unknown, action = "Operation", channel: StatusChannel = "operation", ticket?: OwnedAction, background = false) {
  const failure = describeActionFailure(e);
  const { diagnostic, operation: context, outcome, detail } = failure;
  const summary = context.outcome === "partial" ? `Partially applied: ${detail}` : detail;
  const attemptedAction = action === "Operation" && typeof context.action === "string" ? context.action : action;
  const nextAction = outcome === "unknown" ? "Do not assume this action applied. Review the current playback and request diagnostics before choosing another action."
    : channel === "save" ? "Resolve disk conflicts or retry Save explicitly; export ZIP to keep a portable copy."
    : channel === "recovery" ? "Export ZIP to preserve the current working copy."
    : !engineAvailable || failure.continuity === "lost" ? "Restart engine explicitly when ready."
    : channel === "build" ? "Review the diagnostic, correct the source or runtime cause, then Rebuild explicitly."
    : "Review the diagnostics, then repeat the intended action explicitly if it is still appropriate.";
  const reportedRequest = ticket?.requestId ?? failure.requestId;
  const technical = { action: attemptedAction, requestId: reportedRequest, ref: "ref" in context ? context.ref : ticket?.ref ?? acceptedRef, diagnostic };
  if (background && !ticket) {
    const origin = project ? { project: project.project, epoch: project.epoch, title: project.title } : undefined;
    workflowStatus.report({ channel, requestId: reportedRequest ?? crypto.randomUUID(), action: attemptedAction, outcome, summary, nextAction, technical, location: failure.location, origin });
    renderWorkflowStatus();
  } else settleAction(ticket ?? beginAction(channel, attemptedAction), { outcome, summary, nextAction, technical, location: failure.location }, background ? "background" : "explicit");
}
function showProjectFailure(event: Extract<ProjectEvent, { kind: "failure" }>) {
  const action = event.failure.operation?.action.toLowerCase() ?? "";
  const channel: StatusChannel = action.includes("recovery") ? "recovery" : action.includes("save") ? "save" : "operation";
  error(event.failure, channel === "recovery" ? "Preserve recovery copy" : channel === "save" ? "Save" : "Refresh project", channel, undefined, true);
}
function updateRevision() {
  $("revision").textContent =
    acceptedRef && acceptedRef.project !== project.project
      ? `Previous project · revision ${acceptedRef.revision} loaded`
      : accepted < 0
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
async function persistDraft(ownership: "explicit" | "background" = "explicit") {
  if (!project) return false;
  const captured = capture();
  const op = operation();
  const ticket = beginAction("recovery", "Preserve recovery copy", op.requestId);
  try {
    await host.projects.persistRecovery(captured, op);
    const current = settleAction(ticket, { outcome: "applied", summary: `Recovery acknowledged through source version ${captured.sourceVersion}.`, nextAction: "Recovery is not a disk save.", technical: { project: captured.project, epoch: captured.epoch, sourceVersion: captured.sourceVersion } }, ownership);
    if (project?.project === captured.project && project?.epoch === captured.epoch) {
      recoveryAcknowledgedVersion = Math.max(recoveryAcknowledgedVersion ?? 0, captured.sourceVersion);
      if (current) { $("recovery-status").hidden = true; $("recovery-status").textContent = ""; }
      return project.sourceVersion === captured.sourceVersion;
    }
    const retained = retainedNativeWorkspace;
    if (retained && retained.project.project === captured.project && retained.project.epoch === captured.epoch)
      retained.recoveryVersion = Math.max(retained.recoveryVersion ?? 0, captured.sourceVersion);
  } catch (e) {
    error(e, "Preserve recovery copy", "recovery", ticket, ownership === "background");
    if (project?.project === captured.project && project?.epoch === captured.epoch) {
      if (ticket.owner === workflowStatus && ticket.owner.channels.get("recovery")?.requestId === ticket.requestId) {
        $("recovery-status").textContent = `Recovery unavailable · Export your project to keep these edits. ${e instanceof Error ? e.message : String(e)}`;
        $("recovery-status").hidden = false;
      }
    }
  }
  return false;
}
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void persistDraft("background"), 400);
}
function retireAcceptedMusic() {
  acceptedRef = null; accepted = -1; acceptedEntry = "";
  latestTransportReceipt = undefined;
  inspection = undefined; views = undefined; status = undefined; selected = ""; selectedNote = undefined;
  automationPresentation = undefined;
  explainedLocation = undefined; explanationToken++;
  arrangementInspection.retire(); arrangement.parent.inert = false; analysisRenderer.reset();
  exporter.set(); exporter.close(); analysisSource = null; analysisFrame = undefined;
  $("analysis-source").innerHTML = '<option value="">Master</option>';
  $("analysis-detail").textContent = "Master output";
  $("track-select").innerHTML = '<option value="">No accepted tracks</option>';
  $("loop").setAttribute("aria-pressed", "false");
  $("play").setAttribute("disabled", ""); $("stop").setAttribute("disabled", "");
  $("section").innerHTML = '<option value="">Sections</option>';
  $("clock").textContent = "0:00"; $("length").textContent = "/ —";
  $("jump-source").setAttribute("disabled", "");
  $("selection-label").textContent = "Inspector";
  $("inspector").innerHTML = '<p class="empty">Select a track or note to inspect its performance and sound.</p>';
  $("diagnostic-list").innerHTML = "";
  $("revision-effects").hidden = true; $("revision-effect-list").innerHTML = "";
}
if (runtime.capabilities.environment === "web") {
  window.addEventListener("pagehide", () => { void persistDraft("background"); });
  window.addEventListener("beforeunload", event => {
    if (project?.rootLabel && project.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
}
async function openProject(next: ProjectSnapshot, rebuild = true, reason?: "disk" | "save" | "conflict" | "recovery", resolution?: { fileId: string; bufferVersion: number }) {
  checkpointSource();
  let restoredSurface: "source" | "music" | undefined;
  const restoring = retainedNativeWorkspace && next.project === retainedNativeWorkspace.project.project && next.epoch === retainedNativeWorkspace.project.epoch;
  if (restoring && retainedNativeWorkspace) {
    const retained = retainedNativeWorkspace;
    project = retained.project;
    activeTab = retained.activeTab; openTabs = [...retained.openTabs];
    editor.states = new Map(retained.editorStates);
    documentStates.clear(); for (const [key, value] of retained.documents) documentStates.set(key, value);
    libraryDocuments.clear(); for (const [key, value] of retained.libraries) libraryDocuments.set(key, value);
    const continuingStatus = acceptedRef && retained.ref && revisionIdentity(acceptedRef) === revisionIdentity(retained.ref) ? status : retained.status;
    acceptedRef = retained.ref; accepted = retained.accepted; acceptedEntry = retained.entry;
    inspection = retained.inspection; views = retained.views; status = continuingStatus;
    selected = retained.selected; selectedNote = retained.note; selectionOrigin = retained.origin;
    analysisSource = retained.analysisSource;
    workflowStatus = retained.workflow; recoveryAcknowledgedVersion = retained.recoveryVersion;
    message(retained.buildState, retained.buildDetail);
    restoredSurface = retained.surface;
    retainedNativeWorkspace = undefined;
    rebuild = false;
  }
  const same = project?.project === next.project && project?.epoch === next.epoch;
  const approvingPreview = same && !project.execution.trusted && next.execution.trusted;
  if (approvingPreview) retireAcceptedMusic();
  const preview = runtime.capabilities.environment === "desktop" && !next.execution.trusted;
  if (preview && !same && project && !retainedNativeWorkspace) {
    retainedNativeWorkspace = { project, activeTab, openTabs: [...openTabs], editorStates: new Map(editor.states),
      documents: new Map(documentStates), libraries: new Map(libraryDocuments), ref: acceptedRef,
      accepted, entry: acceptedEntry, inspection, views, status, selected, note: selectedNote,
      origin: selectionOrigin, analysisSource, workflow: workflowStatus, recoveryVersion: recoveryAcknowledgedVersion,
      buildState: $("build-state").textContent ?? "Not built", buildDetail: $("build-detail").textContent ?? "", surface: activeSurface };
  } else if (!preview && !restoring) retainedNativeWorkspace = undefined;
  const retainMusic = preview && !!retainedNativeWorkspace;
  sourceNavigationToken++;
  if (!same) {
    entryScanAbort?.abort(); clearTimeout(entryScanTimer); entryScanToken++;
    entryResults = {}; entryScanProgress = "";
    workflowStatus = new WorkbenchStatus(); recoveryAcknowledgedVersion = null; renderWorkflowStatus();
    $("recovery-status").hidden = true;
    $("recovery-status").textContent = "";
    if (folderWatch?.project.project !== next.project || folderWatch.project.epoch !== next.epoch) folderWatch = undefined;
    currentProjectEpoch++;
    runToken++;
    buildAbort?.abort();
    busy = false;
    commitInProgress = false;
    if (!retainMusic) retireAcceptedMusic();
    explainedLocation = undefined; explanationToken++;
    openTabs = [];
    activeTab = null;
    editor.clear();
    documentStates.clear();
    libraryDocuments.clear();
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
  $("run").toggleAttribute("disabled", busy || !engineAvailable || !project.execution.trusted);
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
  updateEntryChoices();
  const previousMusic = !!acceptedRef && acceptedRef.project !== project.project;
  arrangement.parent.inert = previousMusic;
  if (restoredSurface) setSurface(restoredSurface);
  $("displayed-music-context").hidden = !previousMusic;
  $("displayed-music-context").textContent = previousMusic ? `Previous project music: ${retainedNativeWorkspace?.project.title ?? acceptedRef!.project} · ${acceptedEntry}. Read-only while the imported preview is selected; the preview has not run.` : "";
  for (const id of ["restart", "section", "loop", "apply-loop", "seek-beat-apply", "track-select"])
    $(id).toggleAttribute("disabled", previousMusic || !acceptedRef);
  if (previousMusic) { $("jump-source").setAttribute("disabled", ""); $("inspector").querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; }); }
  if (restoring && views && selected) {
    const restoredAnalysis = analysisSource;
    selectTrack(selected, selectedNote, selectionOrigin); chooseAnalysis(restoredAnalysis); renderWorkflowStatus();
  }
  if (!project.execution.trusted) message("Imported preview", "Edit and inspect archive data; Trust and run enables native evaluation. Approved native plugins have your account's privileges.");
  for (let index = 0; index < deferredProjectFailures.length;) {
    const event = deferredProjectFailures[index];
    if (!event.project || (event.project.project === project.project && event.project.epoch === project.epoch)) {
      deferredProjectFailures.splice(index, 1); showProjectFailure(event);
    } else index++;
  }
  if (!same || approvingPreview) void showView();
  if (rebuild) await run("background");
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
            `<button class="file ${activeTab === `${kind}:${p}` ? "active" : ""}" data-file="${esc(p)}" data-kind="${kind}" title="${esc(p)}"><span>${/\.muz$/i.test(p) ? "◇" : "·"}</span>${esc(p.slice(prefix.length))}${p === project.entry && kind === "project" ? "<em>entry</em>" : ""}</button>`,
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
    `<details data-folder="project" open><summary>Project <span>${project.files.filter(f => !f.deleted).length}</span></summary>${files(textFiles(), "project")}</details><details class="core-tree" data-folder="core" open><summary>Libraries · read only</summary>${coreFiles}${coreFolders}</details>${catalog.gists.length ? `<details data-folder="gists" open><summary>Gists</summary>${catalog.gists.map(p => `<a class="project-link${p.gist === project.gist ? " active" : ""}" href="${esc(gistURL(p.gist))}" data-gist="${esc(p.gist)}" aria-current="${p.gist === project.gist}"><strong>${esc(p.title)}</strong><small>${esc(p.description || "Open from GitHub gist")}</small></a>`).join("")}</details>` : ""}`;
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
        el.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); void importGist(el.dataset.gist!); } };
        el.onauxclick = event => event.preventDefault();
      }
      el.onclick = (event) => {
        if (runtime.capabilities.environment === "web" && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))
          return;
        event.preventDefault();
        void importGist(el.dataset.gist!);
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
async function openTab(key: TabKey, focusIntent: "navigation" | "tab" = "tab", resolvedDocument?: LibraryDocument, navigationToken = ++sourceNavigationToken) {
  const path = key.slice(key.indexOf(":") + 1);
  if (navigationToken !== sourceNavigationToken) return;
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
  if (focusIntent === "navigation") { setPane("source", true); setSurface("source"); }
  renderTabs();
  renderActiveSource();
  if (focusIntent === "navigation") {
    if (libraryDocuments.get(path)?.kind === "source" || /\.muz$/i.test(path)) editor.view.focus();
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
    if (activeTab && /\.muz$/i.test(activePath())) editor.view.focus();
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
  if (next >= 0) {
    event.preventDefault();
    const navigationToken = ++sourceNavigationToken;
    void openTab(openTabs[next], "tab", undefined, navigationToken).then(() => {
      if (navigationToken === sourceNavigationToken) Array.from($("file-tabs").querySelectorAll<HTMLElement>("[data-tab]")).find(el => el.dataset.tab === activeTab)?.focus();
    }).catch(e => { if (navigationToken === sourceNavigationToken) error(e, "Open source tab"); });
  }
};
function renderActiveSource() {
  const path = activePath(), isLibrary = activeLibrary(), key = activeTab;
  const libraryDocument = isLibrary ? libraryDocuments.get(path) : undefined;
  const text = isLibrary ? libraryDocument?.text ?? catalog.libraries[path] : projectFile(path)?.text;
  const code = !!key && (libraryDocument ? libraryDocument.kind === "source" : /\.muz$/i.test(path)), empty = !key || text === undefined;
  $("source-empty").hidden = !empty;
  $("editor").hidden = empty || !code;
  $("document").hidden = empty || code;
  $("source-path").textContent = empty ? "" : path;
  $("source-mode").textContent = empty ? "" : isLibrary ? "Library · read only" : code ? "Source · working buffer" : "Project documentation";
  $("format").toggleAttribute("disabled", empty || isLibrary || !code || !!projectFile(path)?.readOnly);
  $("set-entry").toggleAttribute("disabled", empty || isLibrary || !entrySelectable(path) || path === project.entry);
  const requirements = isLibrary ? catalog.packages?.filter(pack => path.startsWith(pack.directory + "/")).sort((a, b) => b.directory.length - a.directory.length)[0]?.requirements ?? [] : [];
  $("requirements").hidden = empty || !requirements.length;
  $("requirements").textContent = requirements.length ? `${requirements.join(" and ")} required. ${runtime.capabilities.environment === "web" ? "Browse only in this browser." : "Availability depends on your native plugin/sample configuration."}` : "";
  if (empty) editor.detach();
  else if (code) editor.open(key!, text!, isLibrary || !!projectFile(path)?.readOnly);
  else {
    editor.detach();
    renderDocument($("document"), text!, path, isLibrary ? catalog.libraries : textFiles(), (target, fragment) => {
      const navigationToken = ++sourceNavigationToken;
      const targetKey: TabKey = `${isLibrary ? "library" : "project"}:${target}`;
      void openTab(targetKey, "navigation", undefined, navigationToken).then(() => {
        if (navigationToken !== sourceNavigationToken || activeTab !== targetKey) return;
        if (/\.muz$/i.test(target)) { const line = /^L(\d+)/.exec(fragment); if (line) editor.jump(+line[1]); }
        else requestAnimationFrame(() => { if (navigationToken === sourceNavigationToken && activeTab === targetKey) revealDocumentAnchor($("document"), fragment); });
      }).catch(e => { if (navigationToken === sourceNavigationToken) error(e, "Open document link"); });
    }, runtime.capabilities.environment === "desktop" ? url => host.openExternal(url) : undefined);
    const saved = documentStates.get(key!);
    if (saved?.text === text) {
      $("document").querySelectorAll("details").forEach((d, i) => { d.open = saved.details[i] ?? false; });
      const navigationToken = sourceNavigationToken;
      requestAnimationFrame(() => { if (navigationToken === sourceNavigationToken && activeTab === key) $("document").scrollTop = saved.top; });
    } else documentStates.delete(key!);
  }
  $("file-tree").querySelectorAll<HTMLElement>("[data-file]").forEach(el => el.classList.toggle("active", activeTab === `${el.dataset.kind}:${el.dataset.file}`));
}
$("open-entrypoint").onclick = () => openFile(project.entry);
$("show-explorer").onclick = () => setPane("explorer", true, true);
async function jump(location: unknown, navigationToken = ++sourceNavigationToken) {
  if (!project || typeof location !== "object" || location === null ||
      !("path" in location) || typeof location.path !== "string" ||
      !("line" in location) || typeof location.line !== "number" || !Number.isSafeInteger(location.line) || location.line < 1 ||
      !("column" in location) || typeof location.column !== "number" || !Number.isSafeInteger(location.column) || location.column < 1) return;
  const epoch = currentProjectEpoch;
  try {
    const resolved = await host.projects.resolveSourceDocument({
      project: { project: project.project, epoch: project.epoch },
      path: location.path.replace(/^<|>$/g, ""),
    }, operation());
    if (epoch !== currentProjectEpoch || navigationToken !== sourceNavigationToken) return;
    if (!resolved) { error(new Error(`Source document is unavailable: ${location.path}`), "Open related source"); return; }
    if (resolved.kind === "project" && projectFile(resolved.path)?.id !== resolved.fileId) return;
    const key: TabKey = `${resolved.kind}:${resolved.path}`;
    await openTab(key, "navigation", resolved.kind === "library"
      ? { id: resolved.id, path: resolved.path, text: resolved.text, kind: resolved.documentKind } : undefined, navigationToken);
    if (epoch !== currentProjectEpoch || sourceNavigationToken !== navigationToken || activeTab !== key) return;
    if (resolved.kind === "project" || resolved.documentKind === "source") {
      editor.jump(location.line, location.column);
      if (resolved.kind === "project" && projectFile(resolved.path)?.dirty) $("source-mode").textContent = "Working buffer · accepted source coordinates are best effort after edits";
    }
  } catch (e) {
    if (epoch === currentProjectEpoch && navigationToken === sourceNavigationToken) error(e);
  }
}
async function jumpId(id: string) {
  const navigationToken = ++sourceNavigationToken;
  const current = inspection;
  if (!current || current.ref.project !== project.project || (view === "arrangement" && !arrangement.identityActionsEnabled)) return;
  try {
    const location = await current.location(id);
    if (inspection !== current || navigationToken !== sourceNavigationToken) return;
    if (location) await jump(location, navigationToken);
    else error(new Error(`No authored source is available for ${id}; generated or master-bus origins may have no source location.`), "Open related source");
  } catch (e) { if (inspection === current && navigationToken === sourceNavigationToken) error(e, "Open related source"); }
}
function renderRevisionEffect(effect: AcceptedRevision["effect"], revision: string, hasComparison: boolean) {
  $("revision-effects").hidden = false;
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
  for (const name of ["locations", "diagnostics"] as const) {
    if (views.continuations?.[name] == null) continue;
    const controls = document.createElement("div");
    controls.className = "bounded-pages";
    const history: number[] = [];
    let offset = 0;
    let next = views.continuations[name];
    const apply = (page: any) => {
      if (inspection !== current) return;
      next = page.next;
      if (name === "locations")
        views.locations = Object.fromEntries(
          page.rows.map((row: any) => [row.key, row.location]),
        );
      if (name === "diagnostics") views.diagnostics = page.rows;
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
async function run(ownership: "explicit" | "background" = "explicit") {
  if (busy || !project || !engineAvailable || !project.execution.trusted) return;
  busy = true;
  buildAbort = new AbortController();
  const token = ++runToken;
  const buildOperation = operation(buildAbort.signal);
  const ticket = beginAction("build", "Rebuild", buildOperation.requestId);
  activeBuildRequest = ticket.requestId;
  const captured = capture();
  const base = acceptedRef?.project === captured.project && acceptedRef.epoch === captured.epoch ? acceptedRef : null;
  renderWorkflowStatus();
  $("run").setAttribute("disabled", "");
  $("cancel").hidden = false;
  $("cancel").removeAttribute("disabled");
  message("Compiling", project.entry);
  try {
    const snapshot = await host.projects.snapshotSources(captured, operation(buildAbort.signal));
    if (token !== runToken) {
      if (ownership === "explicit") settleAction(ticket, { outcome: "superseded", summary: "Rebuild was not dispatched: the workspace changed after source capture.", nextAction: "Choose the intended workspace and Rebuild explicitly.", technical: { stage: "before-rebuild", snapshot: snapshot.id } });
      return;
    }
    const result = await runtime.rebuild({ snapshot: snapshot.id, base }, buildOperation);
    settleAction(ticket, { outcome: "applied", summary: `Music updated to revision ${result.ref.revision}.`, nextAction: "Play the accepted music or continue editing.", technical: { ref: result.ref } }, ownership);
    if (token !== runToken || result.ref.project !== project.project || result.ref.epoch !== project.epoch) return;
    lastEntryBuild = undefined;
    try { await acceptRevision(result); } catch (e) { error(e, "Present accepted music"); }
  } catch (e) {
    error(e, "Rebuild", "build", ticket, ownership === "background");
    if (token === runToken) {
      const issue = workflowStatus.channels.get("build");
      const outcome = issue?.outcome ?? "failed";
      message(outcome === "cancelled" ? "Cancelled" : outcome === "superseded" ? "Superseded" : outcome === "unknown" ? "Build outcome unknown" : outcome === "partial" ? "Build partly applied" : "Build failed", acceptedRef ? (outcome === "unknown" || outcome === "partial" ? "Last acknowledged music remains available; review this action's outcome." : "Previous accepted music remains loaded") : "No music has been accepted");
      if (issue && (outcome === "failed" || outcome === "rejected"))
        lastEntryBuild = { project: captured.project, epoch: captured.epoch, entry: captured.entry, sourceVersion: captured.sourceVersion, outcome, summary: issue.summary };
      updateEntryChoices();
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
  const previousSelection = selected, previousAnalysis = analysisSource;
  acceptedRef = result.ref;
  views = undefined; selected = ""; selectedNote = undefined; selectionOrigin = "catalog";
  $("track-select").innerHTML = '<option value="">Loading accepted tracks…</option>';
  $("track-select").setAttribute("disabled", "");
  $("section").innerHTML = '<option value="">Loading accepted sections…</option>';
  $("section").setAttribute("disabled", "");
  $("selection-label").textContent = "Inspector";
  $("inspector").innerHTML = '<p class="empty">Loading accepted music inspection…</p>';
  explainedLocation = undefined; explanationToken++;
  $("jump-source").setAttribute("disabled", "");
  sourceNavigationToken++;
  arrangement.beginRevision(result.ref);
  analysisFrame = undefined;
  analysisRenderer.reset();
  inspection = new InspectionClient(runtime, result.ref);
  const diagnosticsPage = result.initialPages.diagnostics;
  status = latestTransportReceipt && revisionIdentity(latestTransportReceipt.ref) === revisionIdentity(result.ref) && !olderObservation(latestTransportReceipt, result.status) ? latestTransportReceipt : result.status;
  accepted = result.ref.sourceVersion;
  acceptedEntry = result.ref.entry;
  exporter.set({ ...result, name: project.title });
  $("play").removeAttribute("disabled");
  $("stop").removeAttribute("disabled");
  $("export-media").removeAttribute("disabled");
  updateRevision();
  if (result.ref.sourceVersion === project.sourceVersion) entryResults[result.ref.entry] = classifiedEntry({ entry: result.ref.entry, kind: "song", readiness: { kind: "validated" }, failure: null, description: "A normal prepare/apply receipt accepted this song." }, result.ref);
  updateEntryChoices();
  $("displayed-music-context").hidden = true;
  $("length").textContent = `/ ${time(status.duration)}`;
  updateTransport(status);
  message("Accepted", `Music updated · revision ${result.ref.revision}`);
  renderWorkflowStatus();
  const current = inspection;
  try {
    const preparedViews = await arrangementInspection.accept(current, result.initialPages, status.endBeat);
    if (inspection !== current || acceptedRef !== result.ref) return;
    views = preparedViews;
  } catch (e) {
    if (inspection === current) error(e, "Refresh accepted music inspection");
    return;
  }
  $("section").innerHTML = '<option value="">Sections</option>' + views.graph.extras.sections.map((s: { name: string }, i: number) => `<option value="${i}">${esc(s.name.replaceAll("_", " "))}</option>`).join("");
  if (acceptedRef !== result.ref) return;
  selected = views.graph.tracks.some((t: { id: string }) => t.id === previousSelection) ? previousSelection : views.graph.tracks[0]?.id ?? "";
  $("analysis-source").innerHTML = '<option value="">Master</option>' + views.graph.tracks.map((track: { id: string }) => `<option value="${esc(track.id)}">${esc(track.id)}</option>`).join("");
  $("track-select").innerHTML = views.graph.tracks.map((track: { id: string }) => `<option value="${esc(track.id)}">${esc(track.id)}</option>`).join("");
  if (selected) selectTrack(selected);
  chooseAnalysis(views.graph.tracks.some((t: { id: string }) => t.id === previousAnalysis) ? previousAnalysis : null);
  const buildDetail = `${views.graph.tracks.length} tracks · ${views.graph.extras.sections.length} sections · ${time(status.duration)}`;
  syncRetainedPresentation(result.ref, buildDetail);
  void showView();
  updateTransport(status);
  if (result.ref.project === project.project && result.ref.epoch === project.epoch) message("Accepted", buildDetail);
  $("diagnostic-list").innerHTML = diagnosticsPage.rows.map(value => {
    const d = jsonRecord(value);
    return d ? `<p>${esc(d.severity)} · ${esc(d.track)} · beat ${d.beat}: ${esc(d.message)}</p>` : "";
  }).join("");
  renderRevisionEffect(result.effect, result.ref.revision, hasComparison);
  attachInitialPageControls();
  applyCapabilities(runtime.capabilities);
}
$("track-select").onchange = () => selectTrack($<HTMLSelectElement>("track-select").value);
$("seek-beat-apply").onclick = () => {
  const beat = $<HTMLInputElement>("seek-beat").valueAsNumber;
  if (!status || !Number.isFinite(beat) || beat < 0 || beat > status.endBeat) { error(new Error("Choose a beat inside the accepted arrangement."), "Seek"); return; }
  seek(beat);
};
async function transport(command: TransportCommand) {
  if (!acceptedRef || !engineAvailable) return;
  if (acceptedRef.project !== project.project && (command.kind === "seek" || command.kind === "restart" || command.kind === "loop")) return;
  const ref = acceptedRef;
  const labels: Record<TransportCommand["kind"], string> = { play: "Play", pause: "Pause", stop: "Stop", panic: "Panic", seek: "Seek", restart: "Return to start", loop: "Set loop" };
  const action = labels[command.kind];
  const op = operation();
  const ticket = beginAction("playback", action, op.requestId, acceptedStatusOwner(ref), ref);
  renderWorkflowStatus();
  try {
    const result = await runtime.transport(ref, command, op);
    if (!latestTransportReceipt || revisionIdentity(result.ref) !== revisionIdentity(latestTransportReceipt.ref) || !olderObservation(result, latestTransportReceipt)) latestTransportReceipt = result;
    updateTransport(result);
    settleAction(ticket, { outcome: "applied", summary: `Applied to revision ${result.ref.revision}; receipt observed playback ${result.playing ? "running" : "paused"} at beat ${result.beat.toFixed(2)}.`, nextAction: "Continue editing or use transport.", technical: { requestedRef: ref, appliedRef: result.ref, command, generation: result.generation, sequence: result.sequence, observed: { playing: result.playing, loop: result.loop } } });
  } catch (e) { error(e, action, "playback", ticket); }
}
function seek(beat: number) {
  void transport({ kind: "seek", beat });
}
function selectTrack(id: string, note?: PerformedNote, origin: "arrangement" | "catalog" = "catalog") {
  if (!acceptedRef || acceptedRef.project !== project.project) return;
  selectedNote = note;
  selectionOrigin = origin;
  sourceNavigationToken++;
  $<HTMLSelectElement>("track-select").value = id;
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
  $("jump-source").setAttribute("disabled", "");
  $("jump-source").textContent = "Checking related source…";
  const currentSource = inspection;
  if (currentSource) void currentSource.location(`track.${id}`).then(location => {
    if (inspection !== currentSource || selected !== id || explainToken !== explanationToken || acceptedRef?.project !== project.project) return;
    explainedLocation ??= location;
    $("jump-source").toggleAttribute("disabled", !explainedLocation || (selectionOrigin === "arrangement" && !arrangement.identityActionsEnabled));
    $("jump-source").textContent = explainedLocation ? "Open related source ↗" : "No authored source";
    $("jump-source").title = explainedLocation ? "Open accepted source coordinates in the current working buffer (best effort after edits)." : "Generated or master-bus origins may have no authored location.";
  }).catch(e => { if (inspection === currentSource && explainToken === explanationToken) { $("jump-source").textContent = "Source unavailable"; error(e, "Find related source"); } });
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
        ["Tags", Array.isArray(note.tags) ? note.tags.filter(tag => typeof tag === "string").join(", ") || "—" : "—"],
        ...Object.entries(note.performance && typeof note.performance === "object" && !Array.isArray(note.performance) ? note.performance : {}).map(
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
    `<dl>${rows.slice(0, 3).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${rows.length > 3 ? `<details><summary>${note ? "Performance" : "Sound and routing"} details</summary><dl>${rows.slice(3).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></details>` : ""}`;
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
        explainedLocation = explanation.latest_edit ?? occurrences[0]?.location ?? explanation.definition ?? explainedLocation;
        $("jump-source").toggleAttribute("disabled", !explainedLocation || acceptedRef?.project !== project.project || (selectionOrigin === "arrangement" && !arrangement.identityActionsEnabled));
        $("jump-source").textContent = explainedLocation ? "Open related source ↗" : "No authored source";
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
          button.onclick = () => { if (inspection === current && (selectionOrigin === "catalog" || arrangement.identityActionsEnabled)) void jump(location); };
          links.append(button);
        }
      })
      .catch(e => { if (inspection === current && explainToken === explanationToken) error(e, "Explain note source"); });
  }
  if (view === "patch") showView();
}
arrangement.onPending = () => {
  if (selectionOrigin === "arrangement") {
    $("jump-source").setAttribute("disabled", "");
    $("inspector").querySelectorAll<HTMLButtonElement>(".provenance-links button").forEach(button => { button.disabled = true; });
  }
};
arrangement.onPresented = () => {
  $("jump-source").toggleAttribute("disabled", !explainedLocation || acceptedRef?.project !== project.project);
  $("inspector").querySelectorAll<HTMLButtonElement>(".provenance-links button").forEach(button => { button.disabled = acceptedRef?.project !== project.project; });
  updateArrangementToolbar();
};
async function showView() {
  if (!musicVisible()) { visualRevisionDirty = true; return; }
  visualRevisionDirty = false;
  updateVisibility();
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
    .forEach(el => {
      el.setAttribute("aria-selected", String(el.dataset.view === view));
      el.tabIndex = el.dataset.view === view ? 0 : -1;
    });
  const captions: Record<string, string> = {
    arrangement: "Drag to pan · Ctrl/⌘ + wheel to zoom · click ruler to seek",
    routing: "Drag to pan · dashed lines are sends and sidechains",
    patch: "Drag to pan · click a node to open related source",
    automation: "Parameter curves · read only",
  };
  $("view-caption").textContent = captions[view];
  arrangement.onNavigation();
  if (!views) {
    $("view-caption").textContent = acceptedRef
      ? `Loading accepted revision ${acceptedRef.revision} inspection`
      : project.execution.trusted ? "No accepted music · Rebuild to inspect sound" : "Imported preview · Trust and run to produce music";
    $("graph-view").innerHTML = acceptedRef
      ? '<p class="empty">Loading accepted music inspection…</p>'
      : '<p class="empty">Rebuild a project to inspect its sound.</p>';
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
          error(e, "Inspect routing");
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
          error(e, "Inspect voice patch");
      }
    };
    await load();
  }
  if (view === "automation" && inspection) {
    const acceptedStatus = status;
    if (!acceptedStatus) return;
    const current = inspection;
    if (automationPresentation && automationPresentation.identity !== revisionIdentity(current.ref))
      $("view-caption").textContent = `Previous displayed revision ${automationPresentation.ref.revision} · loading accepted automation`;
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
          $("graph-view").innerHTML =
            automationView(models, acceptedStatus.duration) +
            models
              .map(
                (lane: any, index: number) =>
                  `<div class="bounded-pages">${lane.pointOffset ? `<button data-points-previous="${index}">Previous ${esc(lane.target)} points</button>` : ""}${lane.pointNext != null ? `<button data-points-next="${index}">Next ${esc(lane.target)} points</button>` : ""}</div>`,
              )
              .join("") +
            `<div class="bounded-pages">${history.length ? '<button id="automation-previous">Previous lanes</button>' : ""}${lanes.next != null ? '<button id="automation-next">Next lanes</button>' : ""}<span>${offset + 1}–${offset + lanes.rows.length} of ${lanes.total}</span></div>`;
          // Publish the model with the DOM it actually produced, never with the
          // structural catalog of a newer accepted revision.
          automationPresentation = { ref: current.ref, identity: revisionIdentity(current.ref), models };
          $("view-caption").textContent = captions.automation;
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
                    error(e, "Inspect automation points");
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
                    error(e, "Inspect automation points");
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
          error(e, "Inspect automation");
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
      const current = inspection;
      const available = current?.ref.project === project.project;
      el.setAttribute("aria-disabled", String(!available));
      el.setAttribute("tabindex", available ? "0" : "-1");
      el.setAttribute("aria-label", `Open related source for ${el.dataset.source}`);
      el.onclick = () => { if (inspection === current) void jumpId(el.dataset.source!); };
      el.onkeydown = event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (inspection === current) void jumpId(el.dataset.source!); }
      };
    });
}
async function download() {
  if (!project) return;
  const captured = capture(), op = operation();
  const ticket = beginAction("operation", "Export working project ZIP", op.requestId);
  renderWorkflowStatus();
  try {
    const result = await host.projects.exportArchive(captured, op);
    settleAction(ticket, { outcome: "applied", summary: result.linkedResources.length ? `${result.linkedResources.length} linked resources are not embedded; keep their native configuration available.` : "Working project ZIP exported; this is not a disk save.", nextAction: "Continue editing or save the connected folder.", technical: { project: captured.project, epoch: captured.epoch, sourceVersion: captured.sourceVersion, result } });
  } catch (e) { error(e, "Export working project ZIP", "operation", ticket); }
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
  if (!Object.keys(files).some(p => /\.muz$/i.test(p)))
    throw new Error("This folder contains no muz source files.");
}
async function importProject(files: Record<string, string>, title: string, { assets = {}, gist }: { assets?: Record<string, { format: "midi" | "wav" | "flac"; base64: string }>; gist?: string } = {}) {
  validateFiles(files);
  let parsed: unknown;
  try { parsed = JSON.parse(files["muzpad.json"] ?? "{}"); } catch { parsed = {}; }
  const settings = parsed && typeof parsed === "object" ? parsed : {};
  const preferred = "entry" in settings && typeof settings.entry === "string" ? settings.entry : "";
  const entry = preferred || (Object.hasOwn(files, "song.muz") ? "song.muz" : Object.hasOwn(files, "main.muz") ? "main.muz" : Object.keys(files).filter(p => /\.muz$/i.test(p)).sort()[0]);
  const entries = "entries" in settings && Array.isArray(settings.entries) ? settings.entries.filter((p: unknown): p is string => typeof p === "string") : undefined;
  return replaceProject(() => host.projects.importProject({ kind: "content", project: {
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
  message("Cancelling", acceptedRef ? "Waiting for the runtime outcome; previous music remains loaded" : "Waiting for the runtime outcome; no music has been accepted");
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
  const current = status;
  if (!current) return;
  if (current.loop) void transport({ kind: "loop", range: null });
  else if (views) {
    const value = $<HTMLSelectElement>("section").value;
    const s =
      value === ""
        ? views.graph.extras.sections.find(
            (s: { start: number; end: number }) => current.beat >= s.start && current.beat < s.end,
          )
        : views.graph.extras.sections[+value];
    void transport({ kind: "loop", range: s ? [s.start, s.end] : [0, current.endBeat] });
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
  gistRequest?.abort("superseded");
  const request = new AbortController();
  gistRequest = request;
  const ticket = actionMessage("Import gist", "Fetching source from GitHub…");
  try {
    const next = await loadGist(input, { signal: request.signal });
    if (request.signal.aborted) return;
    const replaced = await importProject(next.files, next.title, { gist: input });
    settleAction(ticket, { outcome: replaced ? "applied" : "cancelled",
      summary: replaced ? "Gist imported into a local working copy." : "Cancelled; your current workspace is unchanged.",
      nextAction: "Review the current workspace before another action." });
    return replaced;
  } catch (e) {
    if (!request.signal.aborted) {
      error(e, "Import gist", "operation", ticket);
      $("gist-error").textContent = e instanceof Error ? e.message : String(e);
      return false;
    }
  } finally {
    if (request.signal.aborted) settleAction(ticket, {
      outcome: request.signal.reason === "superseded" ? "superseded" : "cancelled",
      summary: request.signal.reason === "superseded" ? "A newer gist import replaced this request." : "Cancelled; your current workspace is unchanged.",
      nextAction: "Review the current workspace before another action.",
    });
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
    gistRequest.abort("cancelled");
    gistRequest = undefined;
  }
});
$("gist-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("gist-submit");
  button.disabled = true;
  $("gist-error").textContent = "";
  try {
    if (await importGist($<HTMLInputElement>("gist-input").value)) $<HTMLDialogElement>("gist-dialog").close();
  } catch (e) {
    $("gist-error").textContent = e instanceof Error ? e.message : String(e);
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
    error(e, "New project");
  }
};
$("format").onclick = async () => {
  if (!activeTab || activeLibrary()) return;
  const key = activeTab, epoch = currentProjectEpoch, path = activePath(), buffer = projectFile(path);
  if (!buffer || buffer.readOnly || !/\.muz$/i.test(path)) return;
  const before = buffer.text, version = buffer.bufferVersion, projectId = project.project;
  try {
    const result = await runtime.format({ project: projectId, path, bufferVersion: version, source: before }, operation());
    if (epoch === currentProjectEpoch && activeTab === key && editor.path === key && projectFile(path)?.bufferVersion === version && projectFile(path)?.text === before && result.bufferVersion === version)
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: result.source } });
  } catch (e) { error(e, "Format source"); }
};
function setEntry(path: string) {
  if (project.entry === path || !entrySelectable(path)) return;
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
    !activeTab || activeLibrary() || activePath() === path || !entrySelectable(activePath()),
  );
}
$("set-entry").onclick = () => { if (activeTab && !activeLibrary()) setEntry(activePath()); };
$("entry-select").onchange = () => {
  setEntry($<HTMLSelectElement>("entry-select").value);
  openFile(project.entry);
};
$("jump-source").onclick = () => {
  if (acceptedRef?.project !== project.project || (selectionOrigin === "arrangement" && !arrangement.identityActionsEnabled)) return;
  if (explainedLocation) void jump(explainedLocation); else void jumpId(`track.${selected}`);
};
document.querySelectorAll<HTMLElement>("[data-view]").forEach(
  (el) =>
    (el.onclick = () => {
      view = el.dataset.view!;
      showView();
    }),
);
document.querySelector<HTMLElement>(".view-tabs")!.onkeydown = event => {
  const tabs = [...document.querySelectorAll<HTMLElement>("[data-view]")];
  const index = tabs.indexOf(event.target as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
  if (next >= 0) { event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
};
arrangement.onFollowScroll = scrollLeft => {
  if (view === "arrangement") arrangementInspection.request(scrollLeft);
};
function updateArrangementToolbar() {
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
    ? "Kit lanes: onset density"
    : "◆ Hit · size and shade = velocity";
}
arrangement.onNavigation = () => { updateArrangementToolbar(); arrangementInspection.request(); };
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
    if (!/\.muz$/i.test(path) || path.split("/").some(part => part.startsWith(".muzpad-")) || projectFile(path))
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
  let ticket: OwnedAction | undefined;
  try {
    const input = $<HTMLInputElement>("folder-input");
    const selectedFiles = Array.from(input.files ?? []);
    if (!selectedFiles.length) return;
    ticket = actionMessage("Import folder copy…", "Reading folder files; edits will not be written back.");
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
    const replaced = await importProject(
      files,
      selectedFiles[0]?.webkitRelativePath.split("/")[0] ?? "Local project",
      { assets },
    );
    settleAction(ticket, { outcome: replaced ? "applied" : "cancelled",
      summary: replaced ? "Folder imported as a disconnected working copy." : "Cancelled; your current workspace is unchanged.",
      nextAction: "Export ZIP to keep edits; they are not written back to the imported folder." });
    input.value = "";
  } catch (e) {
    error(e, "Import folder copy…", "operation", ticket);
  }
};
$("open-zip").onclick = async () => {
  if (runtime.capabilities.environment === "web") { $<HTMLInputElement>("zip-input").click(); return; }
  try {
    await replaceProject(() => host.projects.importProject({ kind: "zipDialog" }, operation()));
  } catch (e) { error(e, "Import ZIP preview"); }
};
$("zip-input").onchange = async () => {
  let ticket: OwnedAction | undefined;
  try {
    const input = $<HTMLInputElement>("zip-input");
    const f = input.files?.[0];
    if (!f) return;
    ticket = actionMessage("Import project ZIP", "Reading archive data…");
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
    const replaced = await importProject(files, f.name.replace(/\.zip$/i, ""), { assets });
    settleAction(ticket, { outcome: replaced ? "applied" : "cancelled",
      summary: replaced ? "Project ZIP imported into a working copy." : "Cancelled; your current workspace is unchanged.",
      nextAction: "Review the current workspace before another action." });
    input.value = "";
  } catch (e) {
    error(e, "Import project ZIP", "operation", ticket);
  }
};
function updateTransport(data: TransportStatus) {
  const identity = revisionIdentity(data.ref);
  if (!acceptedRef || identity !== revisionIdentity(acceptedRef)) return;
  if (status && revisionIdentity(status.ref) === identity && olderObservation(data, status)) return;
  status = data;
  $("play").textContent = data.playing ? "Ⅱ Pause" : "▶ Play";
  $("loop").setAttribute("aria-pressed", String(!!data.loop));
  arrangement.position(data.beat, data.playing);
  arrangement.meters(data.playing ? data.meters.map(m => ({ id: m.track, peak: m.peak })) : []);
  if (!data.playing || (analysisFrame && analysisFrame.generation !== data.generation)) analysisFrame = undefined;
  analysisRenderer.update(analysisFrame, data.playing);
  $("analysis-state").textContent = !data.playing ? "Stopped" : analysisFrame && !analysisFrame.warmup ? "Live" : "Loading fresh window…";
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
  const automation = automationPresentation;
  if (preferences.value.layout.visualization && view === "automation" && automation?.identity === identity && automation.models.length) {
    $("graph-view").querySelectorAll(".automation-value").forEach((el, i) => {
      el.textContent = automationValue(automation.models[i], data.seconds).toFixed(3);
    });
    const x = String(12 + (data.seconds / data.duration) * 676);
    $("graph-view").querySelectorAll(".automation-cursor").forEach((el) => {
      el.setAttribute("x1", x);
      el.setAttribute("x2", x);
    });
  }
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
narrowWorkspace.addEventListener("change", event => {
  if (event.matches && document.activeElement === splitter) $("surface-source").focus();
  applyPreferences();
  setSurface(activeSurface);
  editor.remeasure();
  arrangement.redraw();
});
tinyTransport.addEventListener("change", applyPreferences);
function applyCapabilities(capabilities: HostCapabilities) {
  $("mount-folder").hidden = !capabilities.filesystem.folder.available;
  const folderLabel = capabilities.environment === "desktop" ? "Open folder…" : "Connect folder…";
  $("mount-folder").textContent = folderLabel;
  $("mount-folder").setAttribute("aria-label", folderLabel);
  $("mount-folder").title = capabilities.filesystem.folder.reason ?? (capabilities.environment === "desktop" ? "Open a local project. Trusted native projects use your account's ordinary read authority; approved plugins have account privileges." : "Connect a writable folder; Save writes edits back.");
  $("open-folder").textContent = "Import folder copy…";
  $("open-folder").setAttribute("aria-label", "Import folder copy…");
  $("open-folder").hidden = capabilities.environment === "desktop";
  $("host-capabilities").textContent = capabilities.environment === "desktop"
    ? `${capabilities.platform} · native ${capabilities.nativePluginFormats.join(" / ") || "built-ins"}`
    : "Web · built-in instruments";
  $("host-capabilities").title = [capabilities.audio.reason, capabilities.filesystem.watch.reason, capabilities.pluginConfig?.label].filter(Boolean).join(" · ");
  $("play").toggleAttribute("disabled", !acceptedRef || !capabilities.audio.available || !engineAvailable);
  $("panic").toggleAttribute("disabled", !acceptedRef || !engineAvailable);
  for (const id of ["restart", "section", "loop", "apply-loop", "seek-beat-apply", "track-select"])
    $(id).toggleAttribute("disabled", !acceptedRef || !engineAvailable || (project && acceptedRef.project !== project.project));
  if (project) updateFolderState();
}
let pendingTransportStatus: TransportStatus | undefined;
let transportPaint = 0;
runtime.subscribe(event => {
  if (event.kind === "entries" && event.requestId === entryScanRequest && event.snapshot === entryScanSnapshot && entryScanPending && entryScanSource?.project === project.project && entryScanSource.epoch === project.epoch && entryScanSource.sourceVersion === project.sourceVersion) {
    entryScanProgress = `${event.done}/${event.total}${event.currentEntry ? ` · ${event.currentEntry}` : ""}`;
    if (event.result) entryResults[event.result.entry] = classifiedEntry(acceptedRef?.project === project.project && acceptedRef.epoch === project.epoch && acceptedRef.entry === event.result.entry && acceptedRef.sourceVersion === project.sourceVersion ? { ...event.result, readiness: { kind: "validated" } } : event.result, entryScanSource);
    updateEntryChoices();
  }
  if (event.kind === "status") {
    pendingTransportStatus = event.status;
    if (!transportPaint) transportPaint = requestAnimationFrame(() => {
      transportPaint = 0;
      const latest = pendingTransportStatus; pendingTransportStatus = undefined;
      if (latest) updateTransport(latest);
    });
  }
  else if (event.kind === "analysis") {
    const frame = event.frame;
    if (!musicVisible() || !analysisDisclosure.open) return;
    if (!acceptedRef || revisionIdentity(frame.ref) !== revisionIdentity(acceptedRef) || frame.source !== analysisSource) return;
    if (status && BigInt(frame.generation) < BigInt(status.generation)) return;
    if (analysisFrame) {
      const generation = BigInt(frame.generation), priorGeneration = BigInt(analysisFrame.generation);
      if (generation < priorGeneration) return;
      if (generation === priorGeneration && (BigInt(frame.captureId) < BigInt(analysisFrame.captureId) || (frame.captureId === analysisFrame.captureId && BigInt(frame.sequence) <= BigInt(analysisFrame.sequence)))) return;
    }
    analysisFrame = frame;
    analysisRenderer.update(frame, !!status?.playing);
    $("analysis-state").textContent = !status?.playing ? "Stopped" : frame.warmup ? "Loading fresh window…" : "Live";
  } else if (event.kind === "failure") {
    const requestId = event.failure.operation?.requestId ?? event.failure.requestId;
    if (!requestId || !ownedRequests.has(requestId)) error(event.failure, "Engine operation", "operation", undefined, true);
  }
  else if (event.kind === "engine") {
    engineAvailable = event.state === "ready";
    $("restart-engine").hidden = event.state !== "failed" && event.state !== "stopped";
    $("run").toggleAttribute("disabled", busy || !engineAvailable || (project && !project.execution.trusted));
    if ((!engineAvailable && event.state !== "starting") || (acceptedRef && acceptedRef.engineEpoch !== event.engineEpoch)) {
      sourceNavigationToken++;
      arrangementInspection.retire();
      analysisRenderer.reset();
      acceptedRef = null;
      if (retainedNativeWorkspace) {
        retainedNativeWorkspace.ref = null; retainedNativeWorkspace.inspection = undefined;
        retainedNativeWorkspace.views = undefined; retainedNativeWorkspace.status = undefined;
      }
      inspection = undefined;
      analysisFrame = undefined;
      exporter.set();
      $("export-media").setAttribute("disabled", "");
      $("stop").setAttribute("disabled", "");
      arrangement.meters([]);
      arrangement.position(status?.beat ?? 0, false);
      analysisSubscriptionKey = "";
      $("play").textContent = "▶ Play";
      $("meter-fill").style.width = "0";
      $("master-level").textContent = "−∞ dB";
      if (event.failure) error(event.failure, "Engine continuity", "playback");
    }
    applyCapabilities(event.capabilities);
    updateVisibility();
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
  } catch (e) { error(e, "Restart engine", "playback"); }
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
  } catch (e) { error(e, "Open recent project"); }
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
    } else if (event.kind === "failure") {
      if (!project || (event.project && (event.project.project !== project.project || event.project.epoch !== project.epoch))) {
        deferredProjectFailures.push(event); if (deferredProjectFailures.length > 32) deferredProjectFailures.shift();
      } else showProjectFailure(event);
    }
    else if (event.kind === "watch") {
      if (project && (event.project.project !== project.project || event.project.epoch !== project.epoch)) return;
      folderWatch = event;
      if (event.failure) error(event.failure, "Watch project folder", "operation", undefined, true);
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
        } catch (e) { error(e, "Restore recovery", "recovery"); }
      };
      region.append(button);
    }
    document.querySelector(".diagnostics")!.append(region);
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
  error(e, "Start workbench");
}
