import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InspectionClient,
  graphFromRows,
  performanceFromRows,
} from "../src/inspection.ts";

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
    { track: "lead", stream: "notes", event: { id: "a", start_tick: 0 } },
    { track: "lead", stream: "controllers", event: { tick: 0 } },
  ]);
  assert.equal(performance.length, 1);
  assert.equal(performance[0].notes[0].id, "a");
});
