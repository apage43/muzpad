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
      ["rack.a", "group", 58, 32],
      ["metal.high", "kit", 90, 28],
      ["low", "kit", 118, 28],
      ["rack.a.lead", "pitched", 146, 56],
    ],
  );
  assert.deepEqual(
    rows[0].notes.map((n) => n.start_tick),
    [0.5, 0.5, 1],
  );
  const closed = arrangementRows(views, new Set(["rack.a"]));
  assert.deepEqual(
    closed.map((r) => [r.id, r.top]),
    [
      ["rack.a", 58],
      ["rack.a.lead", 90],
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
