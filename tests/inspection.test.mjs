import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithOxc } from "vite";

const sourceURL = new URL("../src/inspection.ts", import.meta.url);
const source = await readFile(sourceURL, "utf8");
const { code: compiled } = await transformWithOxc(source, sourceURL.pathname);
const {
  InspectionClient,
  graphFromRows,
  performanceFromRows,
  ArrangementInspection,
  arrangementCoverage,
  coversArrangementRange,
} = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

const ref = { project: "project", epoch: "project-epoch", engineEpoch: "engine",
  revision: "7", sourceVersion: 1, entry: "song.muz" };

test("inspection client bounds requests, caches pages and rejects stale revisions", async () => {
  const calls = [];
  const runtime = {
    async inspect(received, view, page) {
      calls.push({ ref: received, view, page });
      return { ref, view, rows: [{ id: 1 }], total: 1, next: null };
    },
  };
  const client = new InspectionClient(runtime, ref);
  const first = await client.inspect("graph", { limit: 5000 });
  const second = await client.inspect("graph", { limit: 5000 });
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].page.limit, 1000);
  assert.deepEqual(calls[0].ref, ref);
  for (const field of ["project", "epoch", "engineEpoch", "revision", "entry", "sourceVersion"]) {
    const stale = new InspectionClient({
      inspect: async () => ({ ref: { ...ref, [field]: field === "sourceVersion" ? 2 : "stale" }, rows: [], total: 0, next: null }),
    }, ref);
    await assert.rejects(stale.inspect("sections"), /Stale inspection revision/);
  }
});

test("inspection convenience operations preserve ref and bounded previous diff", async () => {
  const base = { ...ref, revision: "6" };
  const runtime = {
    async explain(received, track, query) {
      assert.deepEqual(received, ref); assert.equal(track, "lead"); assert.equal(query.limit, 1000);
      return { ref, rows: [], total: 0, next: null };
    },
    async diff(received, category) { return { ref: received, base, category, rows: [], total: 0, next: null }; },
    async location(received, key) { assert.deepEqual(received, ref); assert.equal(key, "note"); return null; },
  };
  const client = new InspectionClient(runtime, ref);
  await client.explain("lead", 0, 5000);
  assert.deepEqual((await client.diff("notes")).base, base);
  assert.equal(await client.location("note"), null);
});

test("paged graph and performance rows adapt without restoring full views", () => {
  const graph = graphFromRows(
    [
      { kind: "transport", id: "transport", detail: { meter: [3, 4] } },
      { kind: "master", id: "master", detail: { inserts: [], sends: [] } },
      { kind: "track", id: "lead", detail: { name: "Lead" } },
    ],
    [{ name: "intro", start: 0, end: 4 }],
    [{ id: "kit", kind: "kit", members: [] }],
  );
  assert.deepEqual(graph.transport.meter, [3, 4]);
  assert.equal(graph.tracks[0].id, "lead");
  assert.equal(graph.extras.sections.length, 1);

  const performance = performanceFromRows([
    { track: "lead", stream: "notes", event: { id: "a", start_tick: 0, duration_ticks: 960, key: 60, attack_velocity: 100 } },
    { track: "lead", stream: "controllers", event: { tick: 0 } },
  ]);
  assert.equal(performance.length, 1);
  assert.equal(performance[0].notes[0].id, "a");
});

test("coalesced requests dispatch once; cancellation does not retire another subscriber", async () => {
  let finish, calls = 0;
  const client = new InspectionClient({ inspect: async () => {
    calls++; return await new Promise((resolve) => { finish = resolve; });
  } }, ref);
  const abort = new AbortController();
  const canceled = client.inspect("performance", { track: "lead", start_tick: "000", end_tick: "100" }, { signal: abort.signal });
  const kept = client.inspect("performance", { end_tick: "100", start_tick: "0", track: "lead" });
  const rejected = assert.rejects(canceled, { name: "AbortError" });
  abort.abort();
  finish({ ref, view: "performance", rows: [], total: 0, next: null });
  await rejected; await kept;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(client.metrics.coalesced, 1);
  assert.equal(client.retention.active, 0);
});

test("LRU retains more than eight tracks with hard row and entry bounds", async () => {
  const calls = [];
  const client = new InspectionClient({ inspect: async (_, view, request) => {
    calls.push(request.track);
    return { ref, view, rows: [], total: 0, next: null };
  } }, ref);
  for (let i = 0; i < 128; i++) await client.inspect("performance", { track: String(i) });
  await client.inspect("performance", { track: "0" });
  await client.inspect("performance", { track: "128" });
  await client.inspect("performance", { track: "0" });
  assert.equal(calls.filter((track) => track === "0").length, 1);
  await client.inspect("performance", { track: "1" });
  assert.equal(calls.filter((track) => track === "1").length, 2);
  assert.ok(client.retention.entries <= 128);
  const heavy = new InspectionClient({ inspect: async (_, view) => ({
    ref, view, rows: Array.from({ length: 1000 }, (_, id) => ({ id })), total: 1000, next: null,
  }) }, ref);
  for (let i = 0; i < 30; i++) await heavy.inspect("performance", { track: String(i) });
  assert.ok(heavy.retention.rows <= 24_000);
  assert.ok(heavy.retention.bytes <= 8 * 1024 * 1024);
});

test("catalog follows byte-shrunk continuations past buses and never rolls metadata back", async () => {
  const rows = [
    ...Array.from({ length: 150 }, (_, i) => ({ kind: "bus", id: `bus${i}`, detail: {} })),
    ...Array.from({ length: 140 }, (_, i) => ({ kind: "track", id: `track${i}`, detail: {} })),
  ];
  const calls = [];
  const client = new InspectionClient({ inspect: async (_, view, request) => {
    const offset = request.offset; calls.push(offset);
    const end = Math.min(rows.length, offset + 37);
    return { ref, view, rows: rows.slice(offset, end), total: rows.length, next: end < rows.length ? end : null };
  } }, ref);
  const catalog = await client.catalog("graph", { ref, view: "graph", rows: rows.slice(0, 37), total: rows.length, next: 37 });
  const graph = graphFromRows(catalog, [{ name: "whole", start: 0, end: 16 }], []);
  assert.equal(graph.tracks.length, 140); assert.equal(graph.buses.length, 150);
  assert.equal(graph.extras.sections[0].name, "whole");
  assert.deepEqual(calls, [37, 74, 111, 148, 185, 222, 259]);
});

test("retired and irrelevant requests do not populate cache", async () => {
  let finish;
  const client = new InspectionClient({ inspect: async () => await new Promise((resolve) => { finish = resolve; }) }, ref);
  const pending = client.inspect("performance", { track: "lead" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  client.retire(); finish({ ref, rows: [], total: 0, next: null });
  await rejected; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.retention.entries, 0);
  await assert.rejects(client.inspect("graph"), { name: "AbortError" });
  const irrelevant = new InspectionClient({ inspect: async () => ({ ref, rows: [], total: 0, next: null }) }, ref);
  await irrelevant.inspect("graph", {}, { retain: () => false });
  assert.equal(irrelevant.retention.entries, 0);
});

test("aligned coverage shares nearby ranges and includes kit marker overhang", () => {
  const range = arrangementCoverage(10, 11, 100);
  assert.ok(range.start <= 10 - 6 / 100);
  assert.ok(range.end >= 11 + 6 / 100);
  assert.deepEqual(arrangementCoverage(10.02, 11.02, 100), range);
});

test("visible frame staging waits for all rows and discards superseded revisions", async () => {
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  try {
    const pending = new Map(), commits = [];
    const arrangement = {
      parent: { scrollLeft: 0 }, follow: true,
      beginRevision(value) { this.ref = value; }, markPending() {}, setVisible() {}, reset() {},
      setDesiredTarget(target) { this.desired = target; },
      target(views, end, left) { return { key: this.ref.revision, start: 0, end: 4, scale: 100,
        tracks: views.graph.tracks.map((track) => track.id), groups: [], layoutGeneration: 0,
        scrollLeft: left ?? 0, follow: left !== undefined }; },
      targetMatches(target) { return target.key === this.ref.revision; },
      isCovered() { return false; },
      commitFrame(frame) { commits.push(frame); },
    };
    const runtime = { inspect: async (accepted, view, request) => await new Promise((resolve) => {
      pending.set(`${accepted.revision}:${request.track}`, () => resolve({ ref: accepted, view, rows: [
        { track: request.track, stream: "notes", event: { id: request.track, start_tick: 0, duration_ticks: 960_000, key: 60, attack_velocity: 100 } },
      ], total: 1, next: null }));
    }) };
    const initial = (accepted) => Object.fromEntries(["summary", "graph", "sections", "track_groups", "locations", "diagnostics"].map((view) => [view, {
      ref: accepted, view, rows: view === "graph" ? ["a", "b"].map((id) => ({ kind: "track", id, detail: {} })) : [], total: view === "graph" ? 2 : 0, next: null,
    }]));
    const controller = new ArrangementInspection(arrangement, (error) => { throw error; });
    const first = controller.accept(new InspectionClient(runtime, ref), initial(ref), 16);
    await new Promise((resolve) => setImmediate(resolve));
    pending.get("7:b")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commits.length, 0, "one completed row cannot commit a frame");
    pending.get("7:a")(); await first;
    assert.equal(commits.length, 1);
    assert.deepEqual([...commits[0].coveredTracks], ["b", "a"]);
    const nextRef = { ...ref, revision: "8" };
    const second = controller.accept(new InspectionClient(runtime, nextRef), initial(nextRef), 16);
    await new Promise((resolve) => setImmediate(resolve));
    controller.setVisible(false);
    assert.equal((await second).catalogComplete, true, "hidden arrangement still completes accepted catalogs");
    pending.get("8:a")(); pending.get("8:b")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commits.length, 1);
    controller.retire();
  } finally {
    globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel;
  }
});

test("native byte-budget rejection reduces only batch rows at the same continuation offset", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `section-${i}-${"x".repeat(1400)}`, start: i, end: i + 1 }));
  const calls = [];
  const client = new InspectionClient({ inspect: async (_, view, request) => {
    calls.push({ ...request });
    const selected = rows.slice(request.offset, request.offset + request.limit);
    if (Buffer.byteLength(JSON.stringify(selected)) > 1024 * 1024)
      throw { code: "too_large", phase: "inspect", message: "Inspection page byte limit exceeded." };
    const end = request.offset + selected.length;
    return { ref, view, rows: selected, total: rows.length, next: end < rows.length ? end : null };
  } }, ref);
  const complete = await client.catalog("sections", { ref, view: "sections", rows: rows.slice(0, 100), total: 1000, next: 100 });
  assert.equal(complete.length, 1000);
  assert.equal(complete[999].name, rows[999].name);
  assert.deepEqual(calls.map(({ offset, limit }) => [offset, limit]), [[100, 1000], [100, 500], [600, 1000]]);
  assert.equal(client.metrics.dispatched, 3);
});

test("detail and overview use bounded native byte adaptation without generic retries", async () => {
  for (const view of ["performance", "performance_overview"]) {
    const limits = [];
    const client = new InspectionClient({ inspect: async (_, received, request, operation) => {
      assert.equal(received, view); assert.equal(request.offset, 11);
      assert.equal(request.start_tick, "0"); assert.equal(request.end_tick, "100");
      assert.equal(operation.signal.aborted, false);
      limits.push(request.limit);
      if (request.limit > 2) throw { code: "too_large", phase: "inspect", message: "Batch does not fit." };
      return { ref, view, rows: [{ id: 11 }, { id: 12 }], total: 20, next: 13 };
    } }, ref);
    const page = await client.inspect(view, { track: "lead", offset: 11, start_tick: "0", end_tick: "100", limit: 8 });
    assert.deepEqual(limits, [8, 4, 2]); assert.equal(page.next, 13);
  }
  let calls = 0;
  const failed = new InspectionClient({ inspect: async () => { calls++; throw { code: "internal", phase: "inspect", message: "Real producer fault." }; } }, ref);
  await assert.rejects(failed.inspect("sections"), { code: "internal" });
  assert.equal(calls, 1);
  const one = new InspectionClient({ inspect: async () => { throw { code: "too_large", phase: "inspect", message: "One row cannot fit." }; } }, ref);
  await assert.rejects(one.inspect("sections", { limit: 1 }), { code: "too_large" });
});

test("coverage reuse and latest-target adoption include clamped kit overhang", () => {
  const coverage = { start: 8, end: 12 };
  assert.equal(coversArrangementRange(coverage, { start: 8, end: 11, scale: 100 }, 32), false);
  assert.equal(coversArrangementRange(coverage, { start: 9, end: 12, scale: 100 }, 32), false);
  assert.equal(coversArrangementRange(coverage, { start: 8.06, end: 11.94, scale: 100 }, 32), true);
  assert.equal(coversArrangementRange({ start: 0, end: 4 }, { start: 0, end: 4, scale: 100 }, 4), true);
});

test("returning to covered A cancels executing follow B without cache pollution or eviction", async () => {
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map(); let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const flush = async () => {
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(performance.now());
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    let releaseB; const calls = [], commits = [], errors = [];
    const runtime = { inspect: async (accepted, view, request) => {
      calls.push({ view, ...request });
      const page = { ref: accepted, view, rows: [], total: 0, next: null };
      if (view === "performance" && Number(request.start_tick) >= 8 * 960_000)
        return await new Promise((resolve) => { releaseB = () => resolve(page); });
      return page;
    } };
    const arrangement = {
      parent: { scrollLeft: 0 }, follow: true,
      beginRevision(value) { this.ref = value; }, markPending() {}, setVisible() {}, reset() {},
      setDesiredTarget(target) { this.desired = target; },
      target(views, end, left = this.parent.scrollLeft) {
        return { key: String(left), start: left / 100, end: left / 100 + 1, scale: 100,
          scrollLeft: left, tracks: ["a"], groups: [], layoutGeneration: 0, follow: true };
      },
      targetMatches(target) { return target.key === this.desired?.key; },
      isCovered(target) { return !!this.frame && coversArrangementRange(this.frame.coverage, target, 32); },
      commitFrame(frame) { commits.push(frame); this.frame = frame; },
      commitScroll(target) { this.parent.scrollLeft = target.scrollLeft; },
    };
    const client = new InspectionClient(runtime, ref);
    const controller = new ArrangementInspection(arrangement, (error) => errors.push(error));
    const initial = Object.fromEntries(["summary", "graph", "sections", "track_groups", "locations", "diagnostics"].map((view) => [view, {
      ref, view, rows: view === "graph" ? [{ kind: "track", id: "a", detail: {} }] : [], total: view === "graph" ? 1 : 0, next: null,
    }]));
    await controller.accept(client, initial, 32);
    for (let offset = 1; offset <= 127; offset++) await client.inspect("locations", { offset });
    assert.equal(client.retention.entries, 128);
    controller.request(1000); await flush();
    assert.equal(typeof releaseB, "function");
    controller.request(0); await flush();
    releaseB(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commits.length, 1); assert.equal(arrangement.parent.scrollLeft, 0);
    assert.equal(client.retention.entries, 128);
    await client.inspect("locations", { offset: 1 });
    assert.equal(calls.filter((call) => call.view === "locations" && call.offset === 1).length, 1);
    assert.deepEqual(errors, []);
    controller.retire();
  } finally {
    globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel;
  }
});

test("visible and hidden acceptance finish byte-budgeted catalogs independently of note pages", async () => {
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  try {
    const sections = Array.from({ length: 1000 }, (_, i) => ({ name: `section${i}-${"x".repeat(1400)}`, start: i, end: i + 1 }));
    for (const visible of [true, false]) {
      const commits = [];
      const arrangement = {
        parent: { scrollLeft: 0 }, follow: true,
        beginRevision() {}, markPending() {}, setVisible() {}, reset() {},
        setDesiredTarget(target) { this.desired = target; },
        target() { return { key: "empty", start: 0, end: 4, scale: 100, tracks: [], groups: [], layoutGeneration: 0, follow: false }; },
        targetMatches(target) { return target.key === this.desired?.key; }, isCovered() { return false; },
        commitFrame(frame) { commits.push(frame); },
      };
      const runtime = { inspect: async (_, view, request) => {
        assert.equal(view, "sections", "catalog completion must not fetch performance");
        const rows = sections.slice(request.offset, request.offset + request.limit);
        if (Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024) throw { code: "too_large", phase: "inspect", message: "Batch too large." };
        const next = request.offset + rows.length;
        return { ref, view, rows, total: 1000, next: next < 1000 ? next : null };
      } };
      const initial = Object.fromEntries(["summary", "graph", "sections", "track_groups", "locations", "diagnostics"].map((view) => [view, {
        ref, view, rows: view === "sections" ? sections.slice(0, 100) : [], total: view === "sections" ? 1000 : 0, next: view === "sections" ? 100 : null,
      }]));
      const controller = new ArrangementInspection(arrangement, (error) => { throw error; });
      controller.setVisible(visible);
      const accepted = await controller.accept(new InspectionClient(runtime, ref), initial, 1000);
      assert.equal(accepted.catalogComplete, true);
      assert.equal(accepted.graph.extras.sections.length, 1000);
      assert.equal(commits.length, visible ? 1 : 0);
      controller.retire();
    }
  } finally {
    globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel;
  }
});

test("latest replacement inside unpadded coverage still refetches kit boundary onsets", async () => {
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map(); let id = 0;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  try {
    let release; const calls = [], commits = [];
    const event = { id: "edge", start_tick: 797, duration_ticks: 0, key: 60, attack_velocity: 127 };
    const runtime = { inspect: async (_, view, request) => {
      calls.push({ ...request });
      const rows = event.start_tick >= Number(request.start_tick) && event.start_tick < Number(request.end_tick)
        ? [{ track: "kit.hit", stream: "notes", event }] : [];
      const page = { ref, view, rows, total: rows.length, next: null };
      if (calls.length === 1) return await new Promise((resolve) => { release = () => resolve(page); });
      return page;
    } };
    const arrangement = {
      parent: { scrollLeft: 1000 }, follow: true,
      beginRevision() {}, markPending() {}, setVisible() {}, reset() {},
      setDesiredTarget(target) { this.desired = target; },
      target(views, end, left = this.parent.scrollLeft) {
        return { key: String(left), start: left / 100, end: left / 100 + 1, scale: 100, scrollLeft: left,
          tracks: ["kit.hit"], groups: [], layoutGeneration: 0, follow: left !== this.parent.scrollLeft };
      },
      targetMatches(target) { return target.key === this.desired?.key; }, isCovered() { return false; },
      commitFrame(frame) { commits.push(frame); },
    };
    const initial = Object.fromEntries(["summary", "graph", "sections", "track_groups", "locations", "diagnostics"].map((view) => [view, {
      ref, view, rows: view === "graph" ? [{ kind: "track", id: "kit.hit", detail: { source: { summary: { ppq: 100 } } } }]
        : view === "track_groups" ? [{ id: "kit", kind: "kit", members: [{ track: "kit.hit", label: "hit" }] }] : [],
      total: view === "graph" || view === "track_groups" ? 1 : 0, next: null,
    }]));
    const controller = new ArrangementInspection(arrangement, (error) => { throw error; });
    const accepted = controller.accept(new InspectionClient(runtime, ref), initial, 32);
    await new Promise((resolve) => setImmediate(resolve));
    controller.request(800);
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(performance.now());
    release(); await accepted;
    assert.deepEqual(calls.map((request) => request.start_tick), ["800", "600"]);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].target.start, 8);
    assert.equal(commits[0].views.performance[0].notes[0].id, "edge");
    controller.retire();
  } finally {
    globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel;
  }
});

test("all-pinned cache still enforces encoded-byte limits", async () => {
  const client = new InspectionClient({ inspect: async (_, view) => ({
    ref, view, rows: [{ metadata: "x".repeat(750_000) }], total: 1, next: null,
  }) }, ref);
  const keys = [];
  for (let offset = 0; offset < 12; offset++) {
    await client.inspect("locations", { offset });
    keys.push(client.key("locations", { offset })); client.pin(keys);
    assert.ok(client.retention.bytes <= 8 * 1024 * 1024);
    assert.ok(client.retention.entries <= 128);
  }
});

test("queue and native stalled work remain bounded through retirement", async () => {
  const releases = [];
  const client = new InspectionClient({ inspect: async (_, view) => await new Promise((resolve) => {
    releases.push(() => resolve({ ref, view, rows: [], total: 0, next: null }));
  }) }, ref);
  const pending = Array.from({ length: 68 }, (_, offset) => client.inspect("locations", { offset }).catch((error) => error));
  assert.equal(client.retention.active, 4); assert.equal(client.retention.queued, 64);
  await assert.rejects(client.inspect("locations", { offset: 69 }), /Inspection queue is full/);
  client.retire(); await Promise.all(pending);
  assert.equal(client.retention.queued, 0);
  assert.equal(client.retention.active, 4, "AbortSignal cannot pretend stalled native producer work has finished");
  for (const release of releases) release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.retention.active, 0); assert.equal(client.metrics.dispatched, 4);
});

test("native byte adaptation stops at cancellation before the next smaller batch", async () => {
  const abort = new AbortController(); let calls = 0;
  const client = new InspectionClient({ inspect: async () => {
    calls++; abort.abort();
    throw { code: "too_large", phase: "inspect", message: "Batch too large." };
  } }, ref);
  await assert.rejects(client.inspect("sections", {}, { signal: abort.signal }), { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(client.retention.entries, 0);
});
