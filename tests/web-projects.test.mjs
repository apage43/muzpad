import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { unzipSync, strFromU8 } from "fflate";

// Load the browser TypeScript without writing generated files or starting Vite.
async function moduleURL(path, imports) {
  let source = stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), "utf8"));
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(url)}`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const assetsURL = new URL("../src/assets.js", import.meta.url).href;
const folderURL = await moduleURL("../src/folder.ts", { "./assets.js": assetsURL });
const projectsURL = await moduleURL("../src/host/web-projects.ts", {
  fflate: import.meta.resolve("fflate"), "../assets.js": assetsURL, "../folder": folderURL,
  "../project-storage.js": new URL("../src/project-storage.js", import.meta.url).href,
  "../gist.js": new URL("../src/gist.js", import.meta.url).href,
});
const { WebProjectStore } = await import(projectsURL);

class MemoryStorage {
  values = new Map();
  denied = false;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.denied) throw new Error("storage full"); this.values.set(key, String(value)); }
  removeItem(key) { if (this.denied) throw new Error("storage denied"); this.values.delete(key); }
}
class Folder {
  kind = "directory";
  name = "Project folder";
  files = new Map();
  failures = new Set();
  gate = null;
  permission = "granted";
  constructor(files) { this.files = new Map(Object.entries(files)); }
  async *values() { for (const name of this.files.keys()) yield { ...await this.getFileHandle(name), name }; }
  async queryPermission() { return this.permission; }
  async requestPermission() { return this.permission; }
  async isSameEntry(other) { return other === this; }
  async getDirectoryHandle() { throw new DOMException("missing", "NotFoundError"); }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name) && !options.create) throw new DOMException("missing", "NotFoundError");
    return {
      kind: "file",
      getFile: async () => new Blob([this.files.get(name) ?? ""]),
      createWritable: async () => {
        let text;
        return {
          write: async (value) => { text = value; if (this.gate) await this.gate(name); },
          close: async () => { if (this.failures.has(name)) throw new Error(`write failed: ${name}`); this.files.set(name, text); },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name) { this.files.delete(name); }
}
const oldGlobals = new Map();
const stores = [];
let nextOperation = 0;
const operation = () => ({ requestId: `request:${++nextOperation}` });
beforeEach(() => {
  for (const key of ["localStorage", "indexedDB", "fetch", "document", "window"]) oldGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: undefined });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ engine: { commit: "core-test-commit" }, libraries: { "std/test.muz": "library text", "docs/help.md": "# Help" } }) });
  globalThis.document = { baseURI: "http://localhost/", body: { append() {} } };
  globalThis.window = {};
});
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  for (const [key, descriptor] of oldGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
async function store() { const result = new WebProjectStore(); stores.push(result); await result.initialize(); return result; }
function capture(snapshot) {
  return { project: snapshot.project, epoch: snapshot.epoch, sourceVersion: snapshot.sourceVersion,
    entry: snapshot.entry, expectedDiskGeneration: snapshot.diskGeneration,
    settings: { title: snapshot.title, entry: snapshot.entry, entries: snapshot.entries }, settingsDiskVersion: snapshot.settingsDiskVersion,
    buffers: snapshot.files.map((file) => ({ fileId: file.id, path: file.path, text: file.deleted ? null : file.text, bufferVersion: file.bufferVersion, expectedDiskVersion: file.diskVersion })) };
}
function edit(snapshot, path, text) {
  const next = structuredClone(snapshot);
  const file = next.files.find((file) => file.path === path);
  file.text = text ?? file.text;
  file.deleted = text === null;
  file.bufferVersion++;
  next.sourceVersion++;
  return next;
}
function saveInput(snapshot) { const value = capture(snapshot); return { project: value.project, epoch: value.epoch, files: value.buffers, settings: value.settings, settingsDiskVersion: value.settingsDiskVersion }; }
async function imported(subject) {
  return subject.importProject({ kind: "content", project: { settings: { title: "Project", entry: "song.muz" },
    files: [{ path: "song.muz", text: "song original" }, { path: "closed.muz", text: "closed original" }], assets: [] } }, operation());
}
async function mounted(subject) {
  const root = new Folder({ "song.muz": "song original", "closed.muz": "closed original", "muzpad.json": JSON.stringify({ title: "Project", entry: "song.muz" }) });
  window.showDirectoryPicker = async () => root;
  const snapshot = await subject.chooseFolder(operation());
  return { root, snapshot };
}

 test("bootstrap replays legacy draft synchronously and exposes Previous as recovery", async () => {
  localStorage.setItem("muzpad-draft-v1", JSON.stringify({ id: "legacy", title: "Draft", entry: "song.muz", files: { "song.muz": "unsaved text" } }));
  localStorage.setItem("muzpad-previous-v1", JSON.stringify({ id: "prior", title: "Previous", entry: "old.muz", files: { "old.muz": "old text" } }));
  const subject = await store();
  const events = [];
  subject.subscribe((event) => events.push(event));
  assert.equal(subject.coreRevision, "core-test-commit");
  assert.equal(events[0].snapshot.files[0].text, "unsaved text");
  assert.equal(events.find((event) => event.kind === "recovery").offer.id, "muzpad-previous-v1");
  const current = events[0].snapshot;
  const permission = await subject.prepareClose({ capture: capture(current), reason: "replaceProject",
    decision: "discard", cancelExports: false, ticket: null }, operation());
  assert.equal(permission.allowed, true);
  await subject.close({ project: current.project, epoch: current.epoch, token: permission.token }, operation());
  const previous = await subject.restoreRecovery({ id: "muzpad-previous-v1", action: "restore" }, operation());
  assert.equal(previous.project, "prior");
  assert.equal(JSON.parse(localStorage.getItem("muzpad-previous-v1")).id, "legacy");
});

test("immutable snapshots capture every buffer, reject omissions and retain explicit pins", async () => {
  const subject = await store();
  const original = await imported(subject);
  const changed = edit(original, "closed.muz", "closed edited");
  const input = capture(changed);
  const pinned = await subject.snapshotSources(input, operation());
  subject.pinSourceSnapshot(pinned.id);
  input.buffers[1].text = "mutated caller input";
  assert.equal(subject.getSourceSnapshot(pinned.id).files["closed.muz"], "closed edited");
  assert.throws(() => { subject.getSourceSnapshot(pinned.id).files["closed.muz"] = "write"; }, TypeError);
  const incomplete = capture(changed); incomplete.buffers.pop();
  await assert.rejects(subject.snapshotSources(incomplete, operation()), /every canonical buffer/);
  const deleted = edit(changed, "closed.muz", null);
  const deletion = await subject.snapshotSources(capture(deleted), operation());
  assert.equal(Object.hasOwn(subject.getSourceSnapshot(deletion.id).files, "closed.muz"), false);
  for (let index = 0; index < 12; index++) await subject.snapshotSources(capture(deleted), operation());
  assert.equal(subject.getSourceSnapshot(pinned.id).files["closed.muz"], "closed edited");
  subject.releaseSourceSnapshot(pinned.id);
  assert.throws(() => subject.getSourceSnapshot(pinned.id), /expired/);
});

test("source metadata lookups never decode assets while transfers retain independently owned bytes", async () => {
  const subject = await store();
  const project = await subject.importProject({ kind: "content", project: {
    settings: { title: "Asset project", entry: "song.muz" },
    files: [{ path: "song.muz", text: "song source" }],
    assets: [{ path: "beat.mid", format: "midi", base64: "AQID" }, { path: "sample.wav", format: "wav", base64: "AP+A" }],
  } }, operation());
  const source = await subject.snapshotSources(capture(project), operation());
  const originalAtob = globalThis.atob;
  let decodes = 0;
  globalThis.atob = (value) => { decodes++; return originalAtob(value); };
  try {
    const metadata = subject.getSourceSnapshotMetadata(source.id);
    assert.deepEqual(metadata, source);
    assert.ok(Object.isFrozen(metadata));
    assert.throws(() => { metadata.sourceVersion++; }, TypeError);
    for (let index = 0; index < 20; index++) assert.strictEqual(subject.getSourceSnapshotMetadata(source.id), metadata);
    assert.equal(decodes, 0, "phase metadata does not read or decode binary asset content");
    const transfer = subject.getSourceSnapshot(source.id);
    assert.strictEqual(transfer.snapshot, metadata);
    assert.equal(decodes, 2, "the genuine source transfer decodes each asset");
    assert.deepEqual(transfer.assets.map(({ path, bytes }) => ({ path, bytes: [...bytes] })), [
      { path: "beat.mid", bytes: [1, 2, 3] }, { path: "sample.wav", bytes: [0, 255, 128] },
    ]);
    transfer.assets[0].bytes[0] = 255;
    assert.strictEqual(subject.getSourceSnapshotMetadata(source.id), metadata);
    assert.equal(decodes, 2);
    assert.equal(subject.getSourceSnapshot(source.id).assets[0].bytes[0], 1);
    assert.equal(decodes, 4, "separate real transfers remain independently owned");
    assert.throws(() => subject.getSourceSnapshotMetadata("missing"), /expired/);
  } finally { globalThis.atob = originalAtob; }
});

test("folder saves report independent conflicts and write failures without clobbering", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  const changed = edit(edit(snapshot, "song.muz", "song local"), "closed.muz", "closed local");
  await subject.persistRecovery(capture(changed), operation());
  root.files.set("song.muz", "outside change");
  const result = await subject.save(saveInput(changed), operation());
  assert.equal(result.conflicts[0].path, "song.muz");
  assert.equal(result.saved.some((file) => file.fileId === changed.files.find((file) => file.path === "closed.muz").id), true);
  assert.equal(root.files.get("song.muz"), "outside change");
  assert.equal(root.files.get("closed.muz"), "closed local");
  const resolved = await subject.resolveConflict({ project: snapshot.project, epoch: snapshot.epoch, fileId: result.conflicts[0].fileId, diskVersion: result.conflicts[0].diskVersion, choice: "local" }, operation());
  root.failures.add("song.muz");
  const failed = await subject.save(saveInput(resolved), operation());
  assert.equal(failed.failures.some((item) => item.fileId === result.conflicts[0].fileId), true);
  assert.equal(root.files.get("song.muz"), "outside change");
});

test("edits arriving during writes remain canonical and dirty after partial save", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  const first = edit(snapshot, "song.muz", "first edit");
  await subject.persistRecovery(capture(first), operation());
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  root.gate = async (path) => { if (path === "song.muz") { started.resolve(); await release.promise; } };
  let latest;
  subject.subscribe((event) => { if (event.kind === "changed") latest = event.snapshot; });
  const saving = subject.save(saveInput(first), operation());
  await started.promise;
  const second = edit(first, "song.muz", "second edit");
  const persisting = subject.persistRecovery(capture(second), operation());
  release.resolve();
  const result = await saving;
  await persisting;
  assert.equal(result.saved.find((item) => item.fileId === second.files.find((file) => file.path === "song.muz").id).bufferVersion, 1);
  assert.equal(root.files.get("song.muz"), "first edit");
  assert.equal(latest.files.find((file) => file.path === "song.muz").text, "second edit");
  assert.equal(latest.files.find((file) => file.path === "song.muz").dirty, true);
});

test("refresh merges clean disk changes but preserves dirty conflicts and deletions", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  const changed = edit(snapshot, "song.muz", "local edit");
  await subject.persistRecovery(capture(changed), operation());
  root.files.set("song.muz", "disk edit");
  root.files.delete("closed.muz");
  root.files.set("added.muz", "added source");
  const refreshed = await subject.refresh(capture(changed), operation());
  assert.equal(refreshed.files.find((file) => file.path === "song.muz").text, "local edit");
  assert.equal(refreshed.conflicts[0].disk, "disk edit");
  assert.equal(refreshed.files.find((file) => file.path === "closed.muz").deleted, true);
  assert.equal(refreshed.files.find((file) => file.path === "added.muz").text, "added source");
  await assert.rejects(subject.snapshotSources(capture(changed), operation()), /capture its current buffers again/);
});

test("source authorization detects clean dependency drift and accepts retained recovery", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  const pinned = await subject.snapshotSources(capture(snapshot), operation());
  subject.pinSourceSnapshot(pinned.id);
  root.files.set("closed.muz", "outside");
  await assert.rejects(subject.validateSourceSnapshot(pinned.id), /Clean dependency/);
  await subject.validateSourceSnapshot(pinned.id, true);
  assert.equal(subject.getSourceSnapshot(pinned.id).files["closed.muz"], "closed original");
});

test("close tokens bind buffers, block exports and preserve cancelled folder replacement", async () => {
  const subject = await store();
  const initial = await imported(subject);
  const changed = edit(initial, "song.muz", "local");
  await subject.persistRecovery(capture(changed), operation());
  await assert.rejects(subject.newProject({ title: "Replacement", entry: "song.muz" }, operation()), /before replacing/);
  let active = 1;
  subject.configureExports({ active: () => active, cancel: async () => { active = 0; } });
  const closeInput = { capture: capture(changed), reason: "replaceProject", decision: "discard", cancelExports: false, ticket: null };
  assert.equal((await subject.prepareClose(closeInput, operation())).allowed, false);
  const permission = await subject.prepareClose({ ...closeInput, cancelExports: true }, operation());
  assert.equal(permission.allowed, true);
  await subject.close({ project: changed.project, epoch: changed.epoch, token: permission.token }, operation());
  window.showDirectoryPicker = async () => { throw new DOMException("cancelled", "AbortError"); };
  assert.equal(await subject.chooseFolder(operation()), null);
  const old = await subject.snapshotSources(capture(changed), operation());
  subject.pinSourceSnapshot(old.id);
  const replacement = await subject.newProject({ title: "Replacement", entry: "song.muz" }, operation());
  assert.notEqual(replacement.epoch, changed.epoch);
  assert.equal(subject.getSourceSnapshot(old.id).files["song.muz"], "local");
  await assert.rejects(subject.validateSourceSnapshot(old.id, true), /no longer open/);
});

test("new edits invalidate issued close permission", async () => {
  const subject = await store();
  const initial = await imported(subject);
  const permitted = await subject.prepareClose({ capture: capture(initial), reason: "closeWindow", decision: "discard", cancelExports: false, ticket: null }, operation());
  const changed = edit(initial, "song.muz", "typed after confirmation");
  await subject.persistRecovery(capture(changed), operation());
  await assert.rejects(subject.close({ project: initial.project, epoch: initial.epoch, token: permitted.token }, operation()), /expired/);
});

test("failed browser persistence keeps edits dirty and never reports saved buffers", async () => {
  const subject = await store();
  const initial = await imported(subject);
  const changed = edit(initial, "song.muz", "not durable");
  await subject.persistRecovery(capture(changed), operation());
  let latest;
  subject.subscribe((event) => { if (event.kind === "changed") latest = event.snapshot; });
  localStorage.denied = true;
  const result = await subject.save(saveInput(changed), operation());
  assert.deepEqual(result.saved, []);
  assert.equal(result.settingsSaved, false);
  assert.equal(latest.files.find((file) => file.path === "song.muz").dirty, true);
  assert.equal(latest.files.find((file) => file.path === "song.muz").text, "not durable");
});

test("library documents retain a distinct identity and stale projects are refused", async () => {
  const subject = await store();
  const project = await imported(subject);
  const library = await subject.readLibraryDocument({ project, id: "library:docs/help.md" }, operation());
  assert.deepEqual(library, { id: "library:docs/help.md", path: "docs/help.md", text: "# Help", kind: "document" });
  await assert.rejects(subject.readLibraryDocument({ project, id: "../song.muz" }, operation()), /escapes/);
  await subject.newProject({ title: "Next", entry: "song.muz" }, operation());
  await assert.rejects(subject.snapshotSources(capture(project), operation()), /no longer open/);
});

test("settings conflicts require an explicit baseline resolution", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  const changed = structuredClone(snapshot);
  changed.title = "Local title"; changed.sourceVersion++;
  await subject.persistRecovery(capture(changed), operation());
  root.files.set("muzpad.json", JSON.stringify({ title: "External title", entry: "song.muz" }));
  const result = await subject.save(saveInput(changed), operation());
  assert.equal(result.settingsSaved, false);
  assert.equal(result.failures.find((item) => item.fileId === null).failure.code, "source_conflict");
  assert.match(result.failures[0].failure.message, /settings changed/);
  let latest;
  subject.subscribe((event) => { if (event.kind === "changed") latest = event.snapshot; });
  const conflict = latest.conflicts.find((item) => item.path === "muzpad.json");
  const resolved = await subject.resolveConflict({ project: latest.project, epoch: latest.epoch,
    fileId: conflict.fileId, diskVersion: conflict.diskVersion, choice: "disk" }, operation());
  assert.equal(resolved.title, "External title");
  assert.equal(resolved.dirty, false);
});

test("archive captures working text and project-owned binary assets, not preferences", async () => {
  const subject = await store();
  const imported = await subject.importProject({ kind: "content", project: {
    settings: { title: "Archive project", entry: "song.muz" },
    files: [{ path: "song.muz", text: "before" }],
    assets: [{ path: "beat.mid", format: "midi", base64: "AQID" }],
  } }, operation());
  const changed = edit(imported, "song.muz", "working edit");
  const source = await subject.snapshotSources(capture(changed), operation());
  const first = subject.getSourceSnapshot(source.id);
  first.assets[0].bytes[0] = 255;
  assert.equal(subject.getSourceSnapshot(source.id).assets[0].bytes[0], 1);
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let blob, downloaded;
  URL.createObjectURL = (value) => { blob = value; return "blob:archive"; };
  URL.revokeObjectURL = () => {};
  document.createElement = () => ({ href: "", download: "", click() { downloaded = this.download; } });
  try {
    const result = await subject.exportArchive(capture(changed), operation());
    assert.equal(result.name, downloaded);
    assert.deepEqual(result.linkedResources, []);
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    assert.equal(strFromU8(entries["song.muz"]), "working edit");
    assert.deepEqual([...entries["beat.mid"]], [1, 2, 3]);
    assert.equal(JSON.parse(strFromU8(entries["muzpad.json"])).title, "Archive project");
    assert.deepEqual(Object.keys(entries).sort(), ["beat.mid", "muzpad.json", "song.muz"]);
  } finally { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});

test("recent browser projects reopen with stable project identity and fresh epochs", async () => {
  const subject = await store();
  const original = await imported(subject);
  await subject.newProject({ title: "Other", entry: "song.muz" }, operation());
  const recent = (await subject.listRecent()).find((item) => item.project === original.project);
  assert.equal(recent.available, true);
  const reopened = await subject.openRecent(original.project, operation());
  assert.equal(reopened.project, original.project);
  assert.notEqual(reopened.epoch, original.epoch);
  assert.equal(reopened.files.find((file) => file.path === "closed.muz").text, "closed original");
});

test("denied browser storage still creates a usable in-memory workspace", async () => {
  localStorage.getItem = () => { throw new DOMException("storage denied", "SecurityError"); };
  localStorage.denied = true;
  const subject = await store();
  const events = [];
  subject.subscribe((event) => events.push(event));
  const project = await subject.newProject({ title: "Temporary", entry: "song.muz" }, operation());
  const source = await subject.snapshotSources(capture(project), operation());
  assert.match(subject.getSourceSnapshot(source.id).files["song.muz"], /song\(/);
  assert.equal(events.some((event) => event.kind === "failure" && /denied/.test(event.failure.message)), true);
});

test("runtime replacement occurs only after a successful selection and preserves failures", async () => {
  const subject = await store();
  const original = await imported(subject);
  let replacements = 0;
  subject.configureRuntime({ replace: async () => { replacements++; } });
  window.showDirectoryPicker = async () => { throw new DOMException("cancelled", "AbortError"); };
  assert.equal(await subject.chooseFolder(operation()), null);
  assert.equal(replacements, 0);
  const next = await subject.newProject({ title: "Next", entry: "song.muz" }, operation());
  assert.equal(replacements, 1);
  subject.configureRuntime({ replace: async () => { throw new Error("runtime stop failed"); } });
  await assert.rejects(subject.newProject({ title: "Failed", entry: "song.muz" }, operation()), /runtime stop failed/);
  const retained = await subject.snapshotSources(capture(next), operation());
  assert.equal(subject.getSourceSnapshot(retained.id).snapshot.project, next.project);
  assert.notEqual(next.project, original.project);
});

test("a newer local edit racing a clean refresh becomes a durable explicit conflict", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  const withDirtyOther = edit(snapshot, "closed.muz", "other local");
  await subject.persistRecovery(capture(withDirtyOther), operation());
  root.files.set("closed.muz", "other disk");
  root.files.set("song.muz", "song disk");
  const refreshed = await subject.refresh(capture(withDirtyOther), operation());
  assert.equal(refreshed.conflicts.length, 1);
  const oldSong = snapshot.files.find((file) => file.path === "song.muz");
  const diskSong = refreshed.files.find((file) => file.path === "song.muz");
  // UI protects its concurrent local edit, bumps beyond the equal-version disk update,
  // and recaptures the latest project generation without adopting the disk baseline.
  const raced = edit(refreshed, "song.muz", "song concurrent local");
  raced.files.find((file) => file.path === "song.muz").diskVersion = oldSong.diskVersion;
  let latest;
  subject.subscribe((event) => { if (event.kind === "changed") latest = event.snapshot; });
  await subject.persistRecovery(capture(raced), operation());
  const conflict = latest.conflicts.find((item) => item.path === "song.muz");
  assert.deepEqual({ base: conflict.base, local: conflict.local, disk: conflict.disk },
    { base: "song original", local: "song concurrent local", disk: "song disk" });
  assert.equal(conflict.baseVersion, oldSong.diskVersion);
  assert.equal(conflict.diskVersion, diskSong.diskVersion);
  assert.equal(latest.files.find((file) => file.path === "song.muz").diskVersion, oldSong.diskVersion);
  assert.equal(latest.conflicts.length, 2);
  await subject.persistRecovery(capture(latest), operation());
  const recovered = JSON.parse(localStorage.getItem("muzpad-draft-v1"));
  assert.equal(recovered.files["song.muz"], "song concurrent local");
  assert.equal(recovered._web.conflicts.length, 2);
  await assert.rejects(subject.snapshotSources(capture(latest), operation()), { code: "source_conflict" });
  const refreshedAgain = await subject.refresh(capture(latest), operation());
  assert.equal(refreshedAgain.files.find((file) => file.path === "song.muz").text, "song concurrent local");
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let archive;
  URL.createObjectURL = (blob) => { archive = blob; return "blob:conflicted"; };
  URL.revokeObjectURL = () => {};
  document.createElement = () => ({ click() {} });
  try {
    await subject.exportArchive(capture(refreshedAgain), operation());
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    assert.equal(strFromU8(entries["song.muz"]), "song concurrent local");
  } finally { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
  const saving = saveInput(refreshedAgain);
  // Even a caller supplying the observed disk version cannot skip explicit resolution.
  saving.files.find((file) => file.path === "song.muz").expectedDiskVersion = diskSong.diskVersion;
  const blocked = await subject.save(saving, operation());
  assert.equal(blocked.saved.length, 0);
  assert.equal(blocked.conflicts.length, 2);
  assert.equal(root.files.get("song.muz"), "song disk");
  let resolved = latest;
  for (const item of [...latest.conflicts]) {
    resolved = await subject.resolveConflict({ project: latest.project, epoch: latest.epoch,
      fileId: item.fileId, diskVersion: item.diskVersion, choice: item.path === "song.muz" ? "local" : "disk" }, operation());
  }
  assert.equal(resolved.conflicts.length, 0);
  await subject.snapshotSources(capture(resolved), operation());
  const saved = await subject.save(saveInput(resolved), operation());
  assert.equal(saved.conflicts.length, 0);
  assert.equal(root.files.get("song.muz"), "song concurrent local");
});

test("a stale-baseline capture without a strictly newer buffer cannot replace clean disk text", async () => {
  const subject = await store();
  const { root, snapshot } = await mounted(subject);
  root.files.set("song.muz", "song disk");
  const refreshed = await subject.refresh(capture(snapshot), operation());
  const stale = capture(refreshed);
  const buffer = stale.buffers.find((file) => file.path === "song.muz");
  buffer.expectedDiskVersion = snapshot.files.find((file) => file.path === "song.muz").diskVersion;
  stale.sourceVersion++;
  assert.throws(() => subject.persistRecovery(stale, operation()), { code: "stale_request" });
  assert.equal((await subject.refresh(capture(refreshed), operation())).files.find((file) => file.path === "song.muz").text, "song disk");
});

for (const local of [null, "song original"]) {
  test(`refresh preserves raced ${local === null ? "deletions" : "old-baseline edits"} until resolution`, async () => {
    const subject = await store();
    const { root, snapshot } = await mounted(subject);
    root.files.set("song.muz", "song disk");
    const refreshed = await subject.refresh(capture(snapshot), operation());
    const raced = edit(refreshed, "song.muz", local);
    raced.files.find((file) => file.path === "song.muz").diskVersion =
      snapshot.files.find((file) => file.path === "song.muz").diskVersion;
    let latest;
    subject.subscribe((event) => { if (event.kind === "changed") latest = event.snapshot; });
    await subject.persistRecovery(capture(raced), operation());
    assert.equal(latest.conflicts[0].local, local);
    const again = await subject.refresh(capture(latest), operation());
    const preserved = again.files.find((file) => file.path === "song.muz");
    assert.equal(preserved.deleted ? null : preserved.text, local);
    assert.equal(again.conflicts.length, 1);
    const result = await subject.save(saveInput(again), operation());
    assert.equal(result.conflicts.length, 1);
    assert.equal(root.files.get("song.muz"), "song disk");
  });
}

test("a startup gist URL offers the draft as Previous without resuming it as the current project", async () => {
  document.baseURI = "http://localhost/?gist=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const draft = { id: "cached-gist", title: "Cached gist", entry: "song.muz",
    files: { "song.muz": "unsaved cached source" } };
  localStorage.setItem("muzpad-draft-v1", JSON.stringify(draft));
  const subject = await store();
  const events = [];
  subject.subscribe(event => events.push(event));
  assert.equal(events.some(event => event.kind === "changed"), false);
  assert.equal(events.find(event => event.kind === "recovery").offer.id, "muzpad-previous-v1");
  const remote = await imported(subject);
  assert.notEqual(remote.project, draft.id);
  assert.equal(JSON.parse(localStorage.getItem("muzpad-previous-v1")).files["song.muz"], draft.files["song.muz"]);
});

test("gist provenance survives content import, safe replacement and Previous restoration", async () => {
  const subject = await store();
  const gist = `${"a".repeat(32)}/${"b".repeat(40)}`;
  const initial = await subject.importProject({ kind: "content", project: {
    settings: { title: "Gist", entry: "song.muz" }, gist,
    files: [{ path: "song.muz", text: "remote source" }], assets: [],
  } }, operation());
  assert.equal(initial.gist, gist);
  const changed = edit(initial, "song.muz", "local gist edit");
  await subject.persistRecovery(capture(changed), operation());
  assert.equal(JSON.parse(localStorage.getItem("muzpad-draft-v1"))._gist, gist);
  const permission = await subject.prepareClose({ capture: capture(changed), reason: "replaceProject",
    decision: "discard", cancelExports: false, ticket: null }, operation());
  await subject.close({ project: changed.project, epoch: changed.epoch, token: permission.token }, operation());
  await subject.newProject({ title: "Replacement", entry: "song.muz" }, operation());
  const restored = await subject.restoreRecovery({ id: "muzpad-previous-v1", action: "restore" }, operation());
  assert.equal(restored.gist, gist);
  assert.equal(restored.files[0].text, "local gist edit");
});

test("legacy gist provenance migrates to normalized host snapshot metadata", async () => {
  const gist = "a".repeat(32);
  localStorage.setItem("muzpad-draft-v1", JSON.stringify({ id: "legacy-gist", title: "Legacy gist",
    entry: "song.muz", files: { "song.muz": "local work" }, _gist: `https://gist.github.com/author/${gist.toUpperCase()}` }));
  const subject = await store();
  const events = [];
  subject.subscribe(event => events.push(event));
  assert.equal(events[0].snapshot.gist, gist);
  assert.equal(events[0].snapshot.files[0].text, "local work");
});

test("recovered browser folder buffers detach the prior session's directory grant", async () => {
  const first = await store();
  const { root, snapshot } = await mounted(first);
  const changed = edit(snapshot, "song.muz", "retained folder draft");
  await first.persistRecovery(capture(changed), operation());
  root.permission = "denied";
  const recovered = await store();
  const events = [];
  recovered.subscribe(event => events.push(event));
  const working = events[0].snapshot;
  assert.equal(working.rootLabel, null);
  assert.equal(working.files.find(file => file.path === "song.muz").text, "retained folder draft");
  assert.ok((await recovered.snapshotSources(capture(working), operation())).id);
});

test("browser source resolution keeps canonical buffers and readonly catalog documents distinct", async () => {
  const subject = await store();
  const snapshot = await imported(subject);
  const project = { project: snapshot.project, epoch: snapshot.epoch };
  assert.deepEqual(await subject.resolveSourceDocument({ project, path: "song.muz" }, operation()),
    { kind: "project", path: "song.muz", fileId: snapshot.files.find(file => file.path === "song.muz").id });
  assert.deepEqual(await subject.resolveSourceDocument({ project, path: "std/test" }, operation()),
    { kind: "library", id: "library:std/test.muz", path: "std/test.muz", text: "library text", documentKind: "source" });
  assert.deepEqual(await subject.resolveSourceDocument({ project, path: "docs/help.md" }, operation()),
    { kind: "library", id: "library:docs/help.md", path: "docs/help.md", text: "# Help", documentKind: "document" });
  assert.equal(await subject.resolveSourceDocument({ project, path: "elsewhere/song.muz" }, operation()), null);
  await assert.rejects(subject.resolveSourceDocument({ project, path: "/ungranted/song.muz" }, operation()), /project-relative/);
  await assert.rejects(subject.resolveSourceDocument({ project: { ...project, epoch: "stale" }, path: "song.muz" }, operation()),
    error => error.code === "stale_request");
});
