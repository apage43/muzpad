import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangementRows, hitDensity } from "../src/arrangement-layout.ts";
const note = (tick, velocity = 100) => ({
  start_tick: tick,
  duration_ticks: 200,
  key: 60,
  attack_velocity: velocity,
});
const views = {
  performance: [
    { track: "rack.a.metal.high", ppq: 100, notes: [note(50)] },
    { track: "rack.a.low", ppq: 200, notes: [note(100), note(200)] },
    { track: "rack.a.lead", ppq: 100, notes: [note(0)] },
  ],
  graph: {
    extras: {
      track_groups: [
        {
          id: "rack.a",
          kind: "kit",
          members: [
            { track: "rack.a.metal.high", label: "metal.high" },
            { track: "rack.a.low", label: "low" },
          ],
        },
      ],
    },
  },
};
test("kit layout uses explicit members, compact heights, and exact custom labels", () => {
  const rows = arrangementRows(views, new Set());
  assert.deepEqual(
    rows.map((r) => [r.label, r.kind, r.top, r.height]),
    [
      ["rack.a", "group", 58, 36],
      ["metal.high", "kit", 94, 36],
      ["low", "kit", 130, 36],
      ["rack.a.lead", "pitched", 166, 56],
    ],
  );
  assert.equal(rows[0].notes.length, 0, "group tiles reference member notes, not copies");
  assert.equal(rows[0].memberRows[0].notes, views.performance[0].notes);
  assert.deepEqual(hitDensity(rows[0], 8, 0, 2).map((bin) => [bin.beat, bin.count]), [
    [0.5, 2], [1, 1],
  ]);
  const closed = arrangementRows(views, new Set(["rack.a"]));
  assert.deepEqual(
    closed.map((r) => [r.id, r.top]),
    [
      ["rack.a", 58],
      ["rack.a.lead", 94],
    ],
  );
  const old = arrangementRows({ ...views, graph: { extras: {} } }, new Set());
  assert.ok(old.every((r) => r.kind === "pitched"));
});
test("density aggregates onsets and velocity, without treating note gates as sustained hits", () => {
  const row = arrangementRows(views, new Set())[1];
  row.notes = [note(0, 127), note(1, 0), note(10000, 127)];
  assert.deepEqual(hitDensity(row, 1, 0, 4), [
    { beat: 0, count: 2, velocity: 1 },
  ]);
  assert.equal(hitDensity(row, 1, 50, 54).length, 0);
});

test("catalog geometry does not lose unqueried tracks or change pitch bounds per tile", () => {
  const graph = { tracks: Array.from({ length: 140 }, (_, i) => ({ id: `track.${i}` })), extras: {} };
  const first = arrangementRows({ graph, performance: [{ track: "track.0", notes: [{ ...note(0), key: 5 }] }] }, new Set());
  const next = arrangementRows({ graph, performance: [{ track: "track.0", notes: [{ ...note(500), key: 126 }] }] }, new Set());
  assert.equal(first.length, 140);
  assert.equal(first[139].pending, true);
  assert.deepEqual(first.map((row) => [row.id, row.top, row.min, row.max]),
    next.map((row) => [row.id, row.top, row.min, row.max]));
  assert.deepEqual([first[0].min, first[0].max], [0, 127]);
});

test("collapsed kits use independent bounded onset summaries", () => {
  const overview = [{ start_tick: 0, end_tick: 4, onsets: 2, notes: 90 }];
  const rows = arrangementRows({ ...views, groupOverviews: { "rack.a": overview } }, new Set(["rack.a"]));
  assert.equal(rows[0].overview, overview);
  assert.equal(rows[0].pending, false);
  assert.equal(rows[0].notes.length, 0);
  assert.equal(rows[0].overview[0].onsets, 2, "sustained occupancy is not onset density");
});
