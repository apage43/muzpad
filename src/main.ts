import { loadGist, parseGist } from "./gist.js";
import { color, setTheme, currentTheme } from "./theme";
import "./style.css";
import { AudioPlayer, Compiler } from "./audio";
import {
  canMountFolder,
  pickFolder,
  readProjectFolder,
  MountedFolder,
} from "./folder";
import {
  ASSET_LIMITS,
  assetTransfers,
  importArchiveEntries,
  isAssetPath,
  projectArchiveEntries,
  verifiedAssetTransfers,
} from "./assets.js";
import { SourceEditor } from "./editor";
import {
  hasStoredProject,
  loadStoredProject,
  saveStoredProject,
} from "./project-storage.js";
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
import { zipSync, unzipSync } from "fflate";

type Project = {
  id: string;
  title: string;
  entry: string;
  files: Record<string, string>;
  assets?: Record<
    string,
    {
      format: "midi" | "wav" | "flac";
      version: string;
      byteLength: number;
      base64: string;
    }
  >;
  entries?: string[];
  description?: string;
  gist?: string;
  folderName?: string;
};
type Catalog = {
  libraries: Record<string, string>;
  gists: { gist: string; title: string; description?: string }[];
  engine?: { commit: string; sourceArchive?: string };
  packages?: { directory: string; readme: string; requirements: string[] }[];
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const player = new AudioPlayer(),
  compiler = new Compiler();
let catalog: Catalog,
  project: Project,
  file = "",
  revision = 0,
  accepted = -1,
  acceptedEntry = "",
  runToken = 0;
let views: any,
  status: any,
  selected = "",
  view = "arrangement",
  busy = false,
  commitInProgress = false;
let inspection: InspectionClient | undefined;
let arrangementInspectionTimer: ReturnType<typeof setTimeout>;
let arrangementInspectionToken = 0;
let viewRenderToken = 0;
let explainedLocation: any;
let explanationToken = 0;
const entryCompiler = new Compiler();
let validEntries = new Set<string>();
let entryScanPending = false;
let entryScanToken = 0;
let entryScanTimer: ReturnType<typeof setTimeout>;
let mount: MountedFolder | undefined;
let saving = false;
let reloading = false;
let mountedSettings: string | undefined;
let inspectorOpen = localStorage.getItem("muzpad-inspector") !== "closed";
let draftTimer: ReturnType<typeof setTimeout>;
let tabs: string[] = [],
  library = false;
const starter =
  'use "std/synthesis" as synths;\n\nlet motif = phrase("C4:q E4:q G4:q B4:q");\n\nsong({\n    title: "Untitled project",\n    tempo: 120,\n    tracks: [track("lead", motif.repeat(4), synths.pluck())],\n    tail: 2\n})\n';

$("app").innerHTML = `
  <header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">∿</span>muzpad<span class="alpha">01</span></div><div class="project-identity"><div class="project-title" id="project-title">A place for music in code</div><div class="workspace-status"><strong id="workspace-mode">Browser copy</strong><span id="folder-state">No folder connected</span></div></div><div class="project-actions" aria-label="Current workspace actions"><button id="reload-folder" title="Read files from the connected folder and rebuild. Keeps this working copy in Previous workspace." hidden>Reload</button><button id="save-folder" hidden>Save to folder</button><button id="download">Export ZIP ↓</button><a id="view-gist" class="button-link" target="_blank" rel="noopener noreferrer" hidden>View gist ↗</a></div><div class="top-actions"><button id="theme-toggle" aria-label="Switch color theme">Dark view ◐</button><button id="new-project">New project</button><button id="mount-folder" title="Connect a local folder to reload files and save changes back to disk" hidden>Connect folder</button><button id="open-folder" title="Import a browser copy; download a ZIP to keep your changes">Import folder</button><button id="import-gist">Import from gist</button><button id="open-zip">Open ZIP</button></div></header>
  <div class="transport"><div class="transport-buttons"><button id="restart" class="icon-button" aria-label="Restart" title="Restart">↤</button><button id="play" class="play-button" disabled>▶ Play</button><button id="stop" class="icon-button" aria-label="Stop" title="Stop" disabled>■</button></div><div class="clock"><span id="clock">0:00</span><span id="length">/ —</span></div><div class="position"><span id="bar">Bar 1 · Beat 1</span><span id="tempo">— BPM</span></div><select id="section" aria-label="Seek to section"><option value="">Sections</option></select><button id="loop" aria-pressed="false">↻ Loop section</button><details class="range-menu"><summary>Range</summary><div><label>Start beat <input id="loop-start" type="number" min="0" value="0"></label><label>End beat <input id="loop-end" type="number" min="0" value="16"></label><button id="apply-loop">Loop range</button></div></details><div class="master-meter" title="Master output peak"><span id="meter-fill"></span></div><span id="master-level">−∞ dB</span><div class="transport-spacer"></div><span id="revision">No accepted revision</span><button id="cancel" hidden>Cancel</button><button id="run" class="primary">Rebuild <span>⌘ / Ctrl ↵</span></button></div>
  <main class="workspace"><aside class="explorer"><div class="pane-heading">Workspace <button id="add-file" title="Add a source file" aria-label="Add a source file">＋</button></div><label class="file-search"><input id="file-search" placeholder="Find a file…" aria-label="Find a file"></label><div id="file-tree"></div><div class="explorer-foot" id="workspace-help">Browser copy. Download a ZIP to keep your work.</div></aside>
  <section class="source-pane"><div class="tabs" id="file-tabs"></div><div class="source-tools"><span id="source-path"></span><label class="entry-choice">Entrypoints <select id="entry-select" aria-label="Entrypoints" title="Choose the file to rebuild"></select></label><button id="format">Format</button><button id="set-entry">Use as entry</button></div><div id="entry-notice" role="status" hidden></div><div id="editor"></div><div id="requirements" hidden></div><div id="document" hidden></div><div class="source-foot"><span id="source-mode">muz source</span><span id="entry-label"></span></div></section>
  <div class="splitter" role="separator" tabindex="0" aria-label="Resize editor" aria-orientation="vertical"></div>
  <section class="visual-pane"><div class="view-tabs" role="tablist" aria-label="Inspection views"><button data-view="arrangement" role="tab" aria-selected="true">Arrangement</button><button data-view="routing" role="tab" aria-selected="false">Routing</button><button data-view="patch" role="tab" aria-selected="false">Voice patch</button><button data-view="automation" role="tab" aria-selected="false">Automation</button></div><div class="visual-tools"><span id="view-caption">The music your code makes</span><span id="kit-legend" hidden></span></div><div class="arrangement-tools" id="arrangement-controls" role="toolbar" aria-label="Arrangement navigation"><button id="zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button><input id="zoom" type="range" min="0" max="9" step=".05" value="0" aria-label="Arrangement zoom"><button id="zoom-in" aria-label="Zoom in" title="Zoom in (+)">＋</button><output id="zoom-value">1×</output><button id="zoom-fit" title="Fit the entire arrangement (Home)">Fit</button><button id="center-playhead" title="Center the view on the playhead">Center playhead</button><button id="follow" aria-pressed="true" title="Keep the playhead visible during playback; manual panning turns this off">Follow</button></div><div class="view-content"><div id="arrangement"></div><div id="graph-view" hidden></div></div><div class="selection-heading"><button id="toggle-inspector" aria-expanded="true" aria-controls="inspector" title="Show or hide inspector">Inspector ▾</button><span id="selection-label">Inspector</span><button id="jump-source" disabled>Open related source ↗</button></div><div id="inspector"><p class="empty">Select a track or note to inspect its performance and sound.</p></div><div class="analysis-heading"><label>Analyze <select id="analysis-source" aria-label="Analysis output"><option value="">Master</option></select></label><span id="analysis-detail">Master output</span></div><div class="analysis-strip"><div><span>Waveform</span><canvas id="scope" width="320" height="70" aria-label="Selected output waveform"></canvas></div><div><span>Spectrum</span><canvas id="spectrum" width="320" height="70" aria-label="Selected output spectrum"></canvas></div></div></section></main>
  <footer class="diagnostics"><div class="diagnostics-heading"><span id="build-state">Starting</span><span id="build-detail">Loading muz-core</span><span id="audio-health"></span><details id="revision-effects"><summary>Revision details</summary><div id="revision-effect-list"></div></details></div><div id="diagnostic-list" role="status" aria-live="polite"></div></footer>
  <input id="folder-input" type="file" webkitdirectory multiple hidden><input id="zip-input" type="file" accept=".zip" hidden>
  <dialog id="gist-dialog"><form id="gist-form"><h2>Import from gist</h2><label>Gist URL or ID<input id="gist-input" required autocomplete="off" spellcheck="false" placeholder="https://gist.github.com/…"></label><p>Open a local working copy. Share this page’s URL to share the gist; local edits are not included.</p><p id="gist-error" role="alert"></p><div><button type="button" id="gist-cancel">Cancel</button><button id="gist-submit" class="primary">Import</button></div></form></dialog>
  <dialog id="file-dialog"><form method="dialog"><h2>Add a source file</h2><label>Project-relative filename<input id="new-file-name" value="part.muz" required pattern="[a-zA-Z0-9_./-]+\\.muz"></label><p id="file-error"></p><div><button value="cancel">Cancel</button><button id="create-file" class="primary" value="create">Create file</button></div></form></dialog>`;
$("theme-toggle").textContent =
  currentTheme() === "dark" ? "Light view ◐" : "Dark view ◐";
const editor = new SourceEditor(
  $("editor"),
  (text) => {
    if (!project || library) return;
    project.files[file] = text;
    revision++;
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
  void player.setAudition(muted, solo).catch(error);
};

function projectDiskFiles() {
  return {
    ...project.files,
    "muzpad.json": JSON.stringify(
      { title: project.title, entry: project.entry, entries: project.entries },
      null,
      2,
    ),
  };
}
function updateFolderState() {
  const pending =
    mount && project
      ? mount
          .changes(projectDiskFiles())
          .filter(
            ([path, text]) =>
              path !== "muzpad.json" || text !== mountedSettings,
          ).length
      : 0;
  $("save-folder").hidden = !mount;
  $("reload-folder").hidden = !mount;
  $("download").hidden = !!project?.gist;
  $("save-folder").toggleAttribute("disabled", saving || reloading || !pending);
  $("reload-folder").toggleAttribute("disabled", saving || reloading);
  $("save-folder").textContent = saving ? "Saving…" : "Save to folder";
  $("reload-folder").textContent = reloading ? "Reloading…" : "Reload";
  $("workspace-mode").textContent = mount ? "Folder connected" : "Browser copy";
  $("workspace-mode").dataset.mode = mount ? "connected" : "browser";
  $("workspace-mode").classList.toggle("unsaved", !!pending);
  $("folder-state").textContent = mount
    ? `${mount.root.name} · ${pending ? `${pending} unsaved file${pending === 1 ? "" : "s"}` : "Saved to folder"}`
    : project?.gist
      ? "From GitHub gist · no folder connected"
      : project?.folderName
        ? `${project.folderName} · no longer connected`
        : "No folder connected";
  $("workspace-help").textContent = mount
    ? "Save writes your changes to this folder. Reload reads files from disk and keeps your current edits in Previous workspace."
    : project?.gist
      ? "Edits stay in this browser. View gist opens the original; sharing this page does not include your edits."
      : project?.folderName
        ? "This recovered copy is disconnected. Download your edits to keep them; Connect folder opens the files on disk."
        : "Edits stay in this browser. Download a ZIP to keep a copy, or Connect folder to work directly with files on disk.";
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
    library || !validEntries.has(file) || file === project.entry,
  );
}
function compilationFiles() {
  return {
    ...Object.fromEntries(
      Object.entries(catalog.libraries).filter(
        ([p]) => p.startsWith("contrib/") && p.endsWith(".muz"),
      ),
    ),
    ...project.files,
  };
}
async function workerAssetEntries() {
  return (await verifiedAssetTransfers(project.assets)).map(
    ({ path, version, bytes }) => ({
      path,
      version,
      bytes,
    }),
  );
}
function scheduleEntryScan(delay = 600) {
  clearTimeout(entryScanTimer);
  const token = ++entryScanToken;
  validEntries = new Set();
  entryScanPending = true;
  updateEntryChoices();
  entryScanTimer = setTimeout(async () => {
    entryCompiler.reset();
    const files = compilationFiles();
    const candidates = [
      ...new Set([
        project.entry,
        ...(project.entries ?? []),
        ...Object.keys(project.files).sort(),
      ]),
    ].filter((p) => p.endsWith(".muz") && project.files[p] !== undefined);
    try {
      await entryCompiler.call({
        command: "assets",
        entries: await workerAssetEntries(),
      });
    } catch {
      // Asset validation failures are reported by the explicit build.
    }
    for (const entry of candidates) {
      if (token !== entryScanToken) return;
      try {
        await entryCompiler.call({ command: "check_entry", files, entry });
        if (token !== entryScanToken) return;
        validEntries.add(entry);
        updateEntryChoices();
      } catch {
        /* A module is only an entry point if the compiler produces a playable session. */
      }
    }
    if (token === entryScanToken) {
      entryScanPending = false;
      updateEntryChoices();
    }
  }, delay);
}
async function saveFolder() {
  if (!mount || saving || reloading) return;
  const target = mount;
  const files = projectDiskFiles();
  saving = true;
  updateFolderState();
  try {
    await target.save(files);
    if (mount === target) mountedSettings = target.baseline["muzpad.json"];
  } catch (e) {
    error(e);
  } finally {
    saving = false;
    updateFolderState();
  }
}
$("mount-folder").hidden = !canMountFolder();
$("mount-folder").onclick = async () => {
  try {
    const root = await pickFolder();
    const { files, assets } = await readProjectFolder(root);
    const mounted = new MountedFolder(root, files);
    await importProject(files, root.name, { assets });
    mount = mounted;
    project.folderName = root.name;
    mountedSettings = projectDiskFiles()["muzpad.json"];
    await persistDraft();
    updateFolderState();
  } catch (e) {
    if ((e as Error).name !== "AbortError") error(e);
  }
};
$("save-folder").onclick = () => void saveFolder();
$("reload-folder").onclick = async () => {
  if (!mount || saving || reloading) return;
  const target = mount,
    current = project;
  reloading = true;
  updateFolderState();
  try {
    const { files, assets } = await readProjectFolder(target.root);
    if (mount !== target || project !== current) return;
    const connected = new MountedFolder(target.root, files);
    await importProject(files, target.root.name, {
      preserveRequired: true,
      preferredEntry: current.entry,
      keepSession: true,
      assets,
    });
    mount = connected;
    project.folderName = target.root.name;
    mountedSettings = projectDiskFiles()["muzpad.json"];
    await persistDraft();
    updateFolderState();
  } catch (e) {
    if (project === current || mount?.root === target.root) error(e);
  } finally {
    reloading = false;
    updateFolderState();
  }
};
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (mount) void saveFolder();
    else download();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (mount?.changes(projectDiskFiles()).length) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function updateInspector() {
  $("inspector").hidden = !inspectorOpen;
  $("toggle-inspector").setAttribute("aria-expanded", String(inspectorOpen));
  $("toggle-inspector").textContent = inspectorOpen
    ? "Inspector ▾"
    : "Inspector ▸";
}
$("toggle-inspector").onclick = () => {
  inspectorOpen = !inspectorOpen;
  localStorage.setItem("muzpad-inspector", inspectorOpen ? "open" : "closed");
  updateInspector();
};
updateInspector();
function chooseAnalysis(id: string | null) {
  player.selectAnalysis(id);
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
    views
      ? "The accepted revision is still available"
      : "Edit the source and rebuild",
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
      : accepted === revision
        ? `Revision ${accepted + 1} accepted`
        : `Edited · revision ${accepted + 1} accepted`;
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
  try {
    await saveStoredProject("muzpad-draft-v1", project);
  } catch {
    message("Draft storage full", "Download your project to keep these edits");
  }
}
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void persistDraft(), 400);
}
window.addEventListener("pagehide", () => void persistDraft());
async function openProject(next: Project, rebuild = true, keepSession = false) {
  if (keepSession && commitInProgress)
    throw new Error(
      "The current revision is being applied; retry reload when it finishes.",
    );
  mount = undefined;
  mountedSettings = undefined;
  if (!keepSession) {
    player.stop();
    player.loop = null;
    $("loop").setAttribute("aria-pressed", "false");
  }
  const openingToken = ++runToken;
  commitInProgress = false;
  if (keepSession) {
    compiler.cancel();
    player.cancelPending();
  } else {
    compiler.reset();
    inspection = undefined;
  }
  busy = false;
  $("run").removeAttribute("disabled");
  $("cancel").hidden = true;
  project = structuredClone(next);
  project.assets ??= {};
  assetTransfers(project.assets);
  gistRequest?.abort();
  gistRequest = undefined;
  $("download").hidden = !!project.gist;
  $("view-gist").hidden = !project.gist;
  if (project.gist)
    $<HTMLAnchorElement>("view-gist").href =
      `https://gist.github.com/${parseGist(project.gist)}`;
  setGistURL(project.gist);
  updateFolderState();
  if (keepSession) revision++;
  else {
    revision = 0;
    accepted = -1;
    acceptedEntry = "";
  }
  if (keepSession) {
    tabs = tabs.filter(
      (key) =>
        key.startsWith("library:") ||
        project.files[key.slice("project:".length)] !== undefined,
    );
  } else {
    tabs = [];
    editor.states.clear();
    editor.path = "";
  }
  if (!keepSession) {
    views = undefined;
    status = undefined;
    selected = "";
    arrangement.reset();
    player.selectAnalysis(null);
    $("analysis-source").innerHTML = '<option value="">Master</option>';
    $("analysis-detail").textContent = "Master output";
    player.dispose();
    $("play").setAttribute("disabled", "");
    $("stop").setAttribute("disabled", "");
    $("section").innerHTML = '<option value="">Sections</option>';
    $("clock").textContent = "0:00";
    $("length").textContent = "/ —";
    $("jump-source").setAttribute("disabled", "");
    $("selection-label").textContent = "Inspector";
    $("inspector").innerHTML =
      '<p class="empty">Select a track or note to inspect its performance and sound.</p>';
  }
  $("project-title").textContent = project.title;
  $("diagnostic-list").replaceChildren();
  tree();
  scheduleEntryScan(0);
  if (keepSession && (library || project.files[file] !== undefined))
    openFile(file, library);
  else openFile(project.entry);
  updateRevision();
  showView();
  // Finish the initial save before exposing a completed project switch. Asset
  // projects do not publish their IndexedDB marker until both records commit.
  await persistDraft();
  if (openingToken !== runToken) return;
  message("Ready to rebuild", "Edit the source, then Rebuild to hear it");
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
            `<button class="file ${file === p && (kind === "library") === library ? "active" : ""}" data-file="${esc(p)}" data-kind="${kind}" title="${esc(p)}"><span>${p.endsWith(".muz") ? "◇" : "·"}</span>${esc(p.slice(prefix.length))}${p === project.entry && kind === "project" ? "<em>entry</em>" : ""}</button>`,
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
    `<details data-folder="project" open><summary>Project <span>${Object.keys(project.files).length}</span></summary>${files(project.files, "project")}</details><details class="core-tree" data-folder="core" open><summary>muz-core${catalog.engine?.sourceArchive ? ` <a class="source-archive" href="${esc(catalog.engine.sourceArchive)}" title="Download muz-core source at ${esc(catalog.engine.commit)}">.tgz</a>` : ""}</summary>${coreFiles}${coreFolders}</details>${catalog.gists.length ? `<details data-folder="gists" open><summary>Gists</summary>${catalog.gists.map((p) => `<a class="project-link${p.gist.split("/")[0] === project.gist?.split("/")[0] ? " active" : ""}" href="${esc(gistURL(p.gist))}" data-gist="${esc(p.gist)}" aria-current="${p.gist.split("/")[0] === project.gist?.split("/")[0]}"><span>↗</span>${p.gist.split("/")[0] === project.gist?.split("/")[0] ? '<em class="project-current">Open</em>' : ""}<strong>${esc(p.title)}</strong><small>${esc(p.description || "Open from GitHub gist")}</small></a>`).join("")}</details>` : ""}`;
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
  if (hasStoredProject("muzpad-previous-v1")) {
    const button = document.createElement("button");
    button.className = "project-link";
    button.textContent = "↶ Previous workspace";
    button.onclick = async () => {
      try {
        const previous = await loadStoredProject("muzpad-previous-v1");
        if (!previous) throw new Error("Previous workspace is unavailable.");
        validateFiles(previous.files);
        await preserveProject(true);
        await openProject(previous);
      } catch (e) {
        error(e);
      }
    };
    $("file-tree").append(button);
  }
  $("file-tree")
    .querySelectorAll<HTMLAnchorElement>("[data-gist]")
    .forEach((el) => {
      el.onclick = (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        void importGist(el.dataset.gist!).catch(error);
      };
    });
}
async function preserveProject(required = false, previous = project) {
  // Keep the previous workspace recoverable when switching projects without a modal.
  if (previous) {
    try {
      await saveStoredProject("muzpad-previous-v1", previous);
    } catch {
      if (required)
        throw new Error(
          "Could not preserve your current edits in browser storage. Download them before reloading the folder.",
        );
    }
  }
}
function openFile(path: string, isLibrary = false) {
  const text = (isLibrary ? catalog.libraries : project.files)[path];
  if (text === undefined) return;
  file = path;
  library = isLibrary;
  const key = (isLibrary ? "library:" : "project:") + path;
  if (!tabs.includes(key)) tabs.push(key);
  $("file-tabs").innerHTML = tabs
    .map((t) => {
      const p = t.slice(t.indexOf(":") + 1);
      return `<button data-tab="${esc(t)}" class="${t === key ? "active" : ""}">${esc(p.split("/").at(-1))}${t.startsWith("library:") ? "<span>↗</span>" : ""}</button>`;
    })
    .join("");
  $("file-tabs")
    .querySelectorAll<HTMLElement>("[data-tab]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          const t = el.dataset.tab!;
          openFile(t.slice(t.indexOf(":") + 1), t.startsWith("library:"));
        }),
    );
  const requirements = isLibrary
    ? ((catalog.packages ?? [])
        .filter((pack) => path.startsWith(pack.directory + "/"))
        .sort((a, b) => b.directory.length - a.directory.length)[0]
        ?.requirements ?? [])
    : [];
  $("requirements").hidden = requirements.length === 0;
  $("requirements").textContent = requirements.length
    ? `${requirements.join(" and ")} required. Available to browse; these dependencies cannot run in the browser.`
    : "";
  const code = path.endsWith(".muz");
  $("editor").hidden = !code;
  $("document").hidden = code;
  if (code) editor.open(key, text, isLibrary);
  else
    renderDocument(
      $("document"),
      text,
      path,
      isLibrary ? catalog.libraries : project.files,
      (target, fragment) => {
        openFile(target, isLibrary);
        if (target.endsWith(".muz")) {
          const line = /^L(\d+)/.exec(fragment);
          if (line) editor.jump(+line[1]);
        } else revealDocumentAnchor($("document"), fragment);
      },
    );
  $("source-path").textContent = path;
  $("source-mode").textContent = isLibrary
    ? "muz-core · read only"
    : code
      ? "muz source · local working copy"
      : "Project documentation";
  $("format").toggleAttribute("disabled", isLibrary || !code);
  $("set-entry").toggleAttribute(
    "disabled",
    isLibrary || !validEntries.has(path) || path === project.entry,
  );
  // Preserve expanded library folders when changing the active file.
  $("file-tree")
    .querySelectorAll<HTMLElement>("[data-file]")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        el.dataset.file === file && (el.dataset.kind === "library") === library,
      ),
    );
}
function jump(location: any) {
  if (!location) return;
  let path = location.path.replace(/^<|>$/g, "");
  if (path.startsWith("std/") && !path.endsWith(".muz")) path += ".muz";
  if (project.files[path] !== undefined) openFile(path);
  else if (catalog.libraries[path] !== undefined) openFile(path, true);
  else return;
  editor.jump(location.line, location.column);
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
async function refreshArrangement() {
  if (!inspection || !views || !status) return;
  const current = inspection;
  const requestToken = ++arrangementInspectionToken;
  const range = arrangement.visibleRange();
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
          start_tick,
          end_tick: Math.max(start_tick + 1, Math.ceil(range.end * ppq)),
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
  arrangement.parent.dataset.inspectionState = "loading";
  arrangementInspectionTimer = setTimeout(() => void refreshArrangement(), 100);
}
function renderRevisionEffect(effect: any, revision: number) {
  const target = $("revision-effect-list");
  target.innerHTML = `<p>Revision ${revision} · ${esc(
    typeof effect === "string" ? effect : JSON.stringify(effect ?? "accepted"),
  )}</p>${effect == null ? '<p class="empty">This is the first accepted revision.</p>' : '<label>Difference <select id="diff-category"><option>notes</option><option>occurrences</option><option>metadata</option><option>controllers</option><option>messages</option><option>tempos</option><option>performed</option><option>consequences</option></select></label><div id="diff-page"></div>'}`;
  if (effect == null) return;
  const select = $<HTMLSelectElement>("diff-category");
  const history: number[] = [];
  let requestToken = 0;
  const load = async (offset = 0) => {
    if (!inspection) return;
    const current = inspection;
    const category = select.value;
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
      const page = result.page ?? result;
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
        void load(page.next);
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
  for (const name of ["sections", "track_groups", "locations", "diagnostics"]) {
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
  if (busy || !project) return;
  busy = true;
  $("run").setAttribute("disabled", "");
  $("cancel").hidden = false;
  const token = ++runToken,
    sourceRevision = revision,
    sourceEntry = project.entry;
  $("diagnostic-list").replaceChildren();
  message("Compiling", project.entry);
  try {
    const files = compilationFiles();
    const assetEntries = await workerAssetEntries();
    await compiler.call({ command: "assets", entries: assetEntries });
    if (token !== runToken) return;
    const result = await compiler.call({
      command: "compile",
      files,
      entry: sourceEntry,
    });
    if (token !== runToken) return;
    const candidateInspection = new InspectionClient(compiler, result.revision);
    const [
      summaryPage,
      graphPage,
      sectionsPage,
      groupsPage,
      locationsPage,
      diagnosticsPage,
    ] = await Promise.all([
      candidateInspection.inspect("summary", { limit: 1 }),
      candidateInspection.inspect("graph"),
      candidateInspection.inspect("sections"),
      candidateInspection.inspect("track_groups"),
      candidateInspection.inspect("locations"),
      candidateInspection.inspect("diagnostics"),
    ]);
    if (token !== runToken) return;
    const candidateViews = {
      summary: summaryPage.rows[0],
      graph: graphFromRows(graphPage.rows, sectionsPage.rows, groupsPage.rows),
      performance: graphPage.rows
        .filter((row: any) => row.kind === "track")
        .map((row: any) => ({
          track: row.id,
          ppq: row.detail.source?.summary?.ppq ?? 960_000,
          notes: [],
        })),
      locations: Object.fromEntries(
        locationsPage.rows.map((row: any) => [row.key, row.location]),
      ),
      diagnostics: diagnosticsPage.rows,
      continuations: {
        graph: graphPage.next,
        sections: sectionsPage.next,
        track_groups: groupsPage.next,
        locations: locationsPage.next,
        diagnostics: diagnosticsPage.next,
      },
    };
    message("Preparing audio", "Building native instruments and effects");
    const nextStatus = await player.accept(
      result.snapshot,
      () => token === runToken,
      assetEntries,
      () => {
        commitInProgress = true;
        $("cancel").hidden = true;
      },
    );
    if (!nextStatus || token !== runToken) return;
    await compiler.call({
      command: "accept_compilation",
      revision: result.revision,
    });
    if (token !== runToken) return;
    inspection = candidateInspection;
    views = candidateViews;
    status = nextStatus;
    accepted = sourceRevision;
    acceptedEntry = sourceEntry;
    $("loop").setAttribute("aria-pressed", String(!!player.loop));
    $("play").removeAttribute("disabled");
    $("stop").removeAttribute("disabled");
    updateRevision();
    $("length").textContent = `/ ${time(status.duration)}`;
    $("tempo").textContent = `${Math.round(status.bpm)} BPM`;
    $("section").innerHTML =
      '<option value="">Sections</option>' +
      views.graph.extras.sections
        .map(
          (s: any, i: number) =>
            `<option value="${i}">${esc(s.name.replaceAll("_", " "))}</option>`,
        )
        .join("");
    arrangement.set(views, status.endBeat);
    await refreshArrangement();
    selected = views.graph.tracks.some((t: any) => t.id === selected)
      ? selected
      : views.graph.tracks[0]?.id;
    $("analysis-source").innerHTML =
      '<option value="">Master</option>' +
      views.graph.tracks
        .map(
          (track: any) =>
            `<option value="${esc(track.id)}">${esc(track.id)}</option>`,
        )
        .join("");
    if (selected) selectTrack(selected);
    chooseAnalysis(null);
    showView();
    message(
      "Accepted",
      `${views.graph.tracks.length} tracks · ${views.graph.extras.sections.length} sections · ${time(status.duration)}`,
    );
    $("diagnostic-list").innerHTML = (views.diagnostics ?? [])
      .map(
        (d: any) =>
          `<p>${esc(d.severity)} · ${esc(d.track)} · beat ${d.beat}: ${esc(d.message)}</p>`,
      )
      .join("");
    renderRevisionEffect(result.effect, result.revision);
    attachInitialPageControls();
  } catch (e: any) {
    if (token === runToken && e.message !== "Cancelled") error(e);
  } finally {
    if (token === runToken) {
      commitInProgress = false;
      busy = false;
      $("run").removeAttribute("disabled");
      $("cancel").hidden = true;
    }
  }
}
function seek(beat: number) {
  player.seek(beat);
  arrangement.position(beat);
  arrangement.reveal();
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
        const explanation = page.rows[0];
        if (!explanation) return;
        explainedLocation =
          explanation.latest_edit ??
          explanation.occurrences?.[0]?.location ??
          explanation.definition;
        $("jump-source").toggleAttribute("disabled", !explainedLocation);
        $("inspector").insertAdjacentHTML(
          "beforeend",
          `<p class="provenance-quality">${esc(explanation.location_quality)}</p><div class="provenance-links"></div>`,
        );
        const links = $("inspector").querySelector(".provenance-links")!;
        const destinations: [string, any][] = [
          ["Definition", explanation.definition],
          ["Latest relevant edit", explanation.latest_edit],
          ...(explanation.occurrences ?? []).map(
            (occurrence: any, i: number) => [
              `Occurrence ${i + 1} · ${occurrence.operation}`,
              occurrence.location,
            ],
          ),
          ...Object.entries(explanation.field_edits ?? {}).map(
            ([field, location]) => [`${field} edit`, location] as [string, any],
          ),
        ].filter((entry) => entry[1]);
        for (const [label, location] of destinations) {
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
        const devices = new Map<string, any[]>();
        for (const row of page.rows) {
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
function download() {
  if (!project || project.gist) return;
  const archive = zipSync(
    projectArchiveEntries(
      {
        ...project.files,
        "muzpad.json": JSON.stringify(
          {
            title: project.title,
            entry: project.entry,
            entries: project.entries,
          },
          null,
          2,
        ),
      },
      project.assets,
    ),
  );
  const url = URL.createObjectURL(
    new Blob([archive as BlobPart], { type: "application/zip" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.id || "muz-project"}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
async function importProject(
  files: Record<string, string>,
  title: string,
  {
    preserveRequired = false,
    preferredEntry,
    keepSession = false,
    assets = {},
  }: {
    preserveRequired?: boolean;
    preferredEntry?: string;
    keepSession?: boolean;
    assets?: Project["assets"];
  } = {},
) {
  validateFiles(files);
  let settings: any = {};
  try {
    settings = JSON.parse(files["muzpad.json"] ?? "{}");
  } catch {}
  delete files["muzpad.json"];
  const entry =
    preferredEntry !== undefined && files[preferredEntry] !== undefined
      ? preferredEntry
      : files[settings.entry]
        ? settings.entry
        : files["song.muz"]
          ? "song.muz"
          : Object.keys(files).find((p) => p.endsWith(".muz"))!;
  await preserveProject(preserveRequired);
  return openProject(
    {
      id: title.replace(/[^a-z0-9-]/gi, "-"),
      title: typeof settings.title === "string" ? settings.title : title,
      entry,
      entries: Array.isArray(settings.entries)
        ? settings.entries.filter(
            (p: unknown) =>
              typeof p === "string" &&
              p.endsWith(".muz") &&
              files[p] !== undefined,
          )
        : undefined,
      files,
      assets,
    },
    true,
    keepSession,
  );
}

$("theme-toggle").onclick = () => {
  const dark = currentTheme() !== "dark";
  setTheme(dark ? "dark" : "light");
  editor.setTheme(dark);
  $("theme-toggle").textContent = dark ? "Light view ◐" : "Dark view ◐";
  arrangement.draw();
  showView();
};
$("run").onclick = () => void run();
$("cancel").onclick = () => {
  if (commitInProgress) return;
  runToken++;
  compiler.cancel();
  player.cancelPending();
  busy = false;
  $("run").removeAttribute("disabled");
  $("cancel").hidden = true;
  message("Cancelled", "The accepted revision is still available");
};
$("play").onclick = () => {
  if (player.playing) player.pause();
  else {
    if (status && player.beat >= status.endBeat)
      player.seek(player.loop?.[0] ?? 0);
    void player.play().catch(error);
  }
};
$("stop").onclick = () => player.stop();
$("restart").onclick = () => seek(player.loop?.[0] ?? 0);
$("section").onchange = () => {
  const i = $<HTMLSelectElement>("section").value;
  if (i === "") return;
  const s = views.graph.extras.sections[+i];
  if (player.loop) player.setLoop([s.start, s.end]);
  else seek(s.start);
  $<HTMLInputElement>("loop-start").value = s.start;
  $<HTMLInputElement>("loop-end").value = s.end;
};
$("loop").onclick = () => {
  if (player.loop) player.setLoop(null);
  else if (views) {
    const value = $<HTMLSelectElement>("section").value;
    const s =
      value === ""
        ? views.graph.extras.sections.find(
            (s: any) => player.beat >= s.start && player.beat < s.end,
          )
        : views.graph.extras.sections[+value];
    player.setLoop(s ? [s.start, s.end] : [0, status.endBeat]);
  }
  $("loop").setAttribute("aria-pressed", String(!!player.loop));
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
  player.setLoop([a, b]);
  $("loop").setAttribute("aria-pressed", "true");
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
async function importGist(input: string, previous = project) {
  gistRequest?.abort();
  const request = new AbortController();
  gistRequest = request;
  message("Loading gist", "Fetching source from GitHub…");
  try {
    const next = await loadGist(input, { signal: request.signal });
    if (request.signal.aborted) return;
    await preserveProject(false, previous);
    await openProject(next);
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
$("file-search").oninput = tree;
$("new-project").onclick = async () => {
  try {
    message("Switching project", "Preserving the current workspace…");
    await preserveProject(true);
    await openProject({
      id: "untitled-project",
      title: "Untitled project",
      entry: "song.muz",
      files: { "song.muz": starter },
    });
  } catch (e) {
    error(e);
  }
};
$("format").onclick = async () => {
  const path = file,
    before = project.files[file];
  try {
    const result = await compiler.call({ command: "format", source: before });
    if (file === path && project.files[path] === before)
      editor.view.dispatch({
        changes: {
          from: 0,
          to: editor.view.state.doc.length,
          insert: result.source,
        },
      });
  } catch (e) {
    error(e);
  }
};
function setEntry(path: string) {
  if (project.entry === path || !validEntries.has(path)) return;
  project.entry = path;
  revision++;
  updateRevision();
  updateEntryChoices();
  updateFolderState();
  saveDraft();
  tree();
  $("set-entry").toggleAttribute(
    "disabled",
    library || file === path || !validEntries.has(file),
  );
}
$("set-entry").onclick = () => setEntry(file);
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
  const path = $<HTMLInputElement>("new-file-name").value.trim();
  if (
    !/^[\w./-]+\.muz$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((s) => s === ".." || !s) ||
    project.files[path] !== undefined
  ) {
    e.preventDefault();
    $("file-error").textContent = "Choose a new relative .muz filename.";
    return;
  }
  project.files[path] = "// New musical material\n";
  scheduleEntryScan();
  updateFolderState();
  revision++;
  tree();
  openFile(path);
  updateRevision();
  saveDraft();
};
$("open-folder").onclick = () => $<HTMLInputElement>("folder-input").click();
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
$("open-zip").onclick = () => $<HTMLInputElement>("zip-input").click();
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
player.onPlaying = () => {
  $("play").textContent = player.playing ? "Ⅱ Pause" : "▶ Play";
  if (!player.playing) {
    arrangement.meters([]);
    $("meter-fill").style.width = "0";
    $("master-level").textContent = "−∞ dB";
    $("audio-health").textContent = "";
  }
};
player.onError = error;
player.onPosition = (data) => {
  arrangement.position(data.beat, player.playing);
  arrangement.meters(data.meters ?? []);
  $("clock").textContent = time(data.seconds);
  const meter = data.meter ?? [4, 4],
    bar = (meter[0] * 4) / meter[1];
  $("bar").textContent =
    `Bar ${Math.floor(data.beat / bar) + 1} · Beat ${((data.beat % bar) + 1).toFixed(1)}`;
  $("tempo").textContent = `${Math.round(data.bpm ?? 120)} BPM`;
  const db = data.peak > 0.00001 ? 20 * Math.log10(data.peak) : -100;
  $("master-level").textContent = db < -80 ? "−∞ dB" : `${db.toFixed(1)} dB`;
  $("meter-fill").style.width =
    `${Math.min(100, Math.max(0, ((db + 60) / 60) * 100))}%`;
  $("audio-health").textContent = data.underruns
    ? `${data.underruns} audio underrun${data.underruns > 1 ? "s" : ""}`
    : player.playing
      ? "Audio running"
      : "";
  if (view === "automation" && views)
    document.querySelectorAll(".automation-value").forEach((el, i) => {
      el.textContent = automationValue(
        views.graph.extras.automation[i],
        data.seconds,
      ).toFixed(3);
    });
  if (view === "automation" && status)
    document.querySelectorAll(".automation-cursor").forEach((el) => {
      const x = String(12 + (data.seconds / status.duration) * 676);
      el.setAttribute("x1", x);
      el.setAttribute("x2", x);
    });
};
const splitter = document.querySelector<HTMLElement>(".splitter")!;
function resizeSource(x: number) {
  const workspace = document
    .querySelector(".workspace")!
    .getBoundingClientRect();
  const fraction = Math.max(
    0.25,
    Math.min(0.7, (x - workspace.left - 202) / (workspace.width - 202)),
  );
  document.documentElement.style.setProperty(
    "--source-fraction",
    String(fraction),
  );
}
splitter.onpointerdown = (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.onpointermove = (event) => resizeSource(event.clientX);
  splitter.onpointerup = () => {
    splitter.onpointermove = null;
  };
};
splitter.onkeydown = (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    resizeSource(
      splitter.getBoundingClientRect().left +
        (e.key === "ArrowLeft" ? -30 : 30),
    );
  }
};
const wave = new Uint8Array(2048),
  frequency = new Uint8Array(1024);
let lastScope = 0;
function drawScopes(now: number) {
  requestAnimationFrame(drawScopes);
  if (now - lastScope < 66) return;
  lastScope = now;
  if (player.analyser && player.playing) {
    player.analyser.getByteTimeDomainData(wave);
    player.analyser.getByteFrequencyData(frequency);
  } else {
    wave.fill(128);
    frequency.fill(0);
  }
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
      const y =
        id === "scope" ? (data[index] / 255) * h : h - (data[index] / 255) * h;
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
}
requestAnimationFrame(drawScopes);
try {
  const response = await fetch(new URL("catalog.json", document.baseURI));
  if (!response.ok)
    throw new Error("Run npm run prepare:engine to bundle the source library.");
  catalog = await response.json();
  let restored: Project | undefined;
  try {
    const draft = await loadStoredProject("muzpad-draft-v1");
    if (draft?.files && draft.files[draft.entry]) {
      validateFiles(draft.files);
      restored = draft;
    }
  } catch {}
  const requested = new URL(location.href).searchParams.get("gist");
  const needsGist = requested !== null;
  // A share URL always fetches its source. Keep the draft recoverable, but never
  // present it as the requested gist, including when GitHub cannot be reached.
  if (needsGist && restored) await preserveProject(false, restored);
  const initialBuild = openProject(
    (!needsGist && restored) || {
      id: "untitled-project",
      title: "Untitled project",
      entry: "song.muz",
      files: { "song.muz": starter },
    },
    !needsGist,
  );
  if (needsGist) {
    await initialBuild;
    // Keep the requested URL on failure so a reload can retry the same gist.
    setGistURL(requested);
    await importGist(requested, restored);
  } else {
    await initialBuild;
  }
} catch (e) {
  error(e);
}
