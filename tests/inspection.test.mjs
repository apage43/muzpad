import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InspectionClient,
  graphFromRows,
  performanceFromRows,
} from "../src/inspection.ts";

test("inspection client bounds requests, caches pages and rejects stale revisions", async () => {
  const calls = [];
  const compiler = {
    async call(message) {
      calls.push(message);
      return { revision: 7, rows: [{ id: 1 }], total: 1 };
    },
  };
  const client = new InspectionClient(compiler, 7);
  const first = await client.inspect("graph", { limit: 5000 });
  const second = await client.inspect("graph", { limit: 5000 });
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].page.limit, 1000);
  assert.equal(calls[0].revision, 7);

  const stale = new InspectionClient(
    { call: async () => ({ revision: 6, rows: [], total: 0 }) },
    7,
  );
  await assert.rejects(stale.inspect("sections"), /Stale inspection revision/);
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
