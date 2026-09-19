import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditionState } from "../src/audition.ts";

test("kit controls use explicit members, support mixed state and independent solos", () => {
  const state = new AuditionState();
  const members = ["kit.kick", "kit.snare"];
  state.toggle("muted", ["kit.kick"]);
  assert.equal(state.state("muted", members), "mixed");
  state.toggle("muted", members);
  assert.equal(state.state("muted", members), "true");
  assert.equal(state.muted.has("kit.lead"), false);
  state.toggle("muted", members);
  assert.equal(state.muted.size, 0);
  state.toggle("solo", members);
  state.toggle("solo", ["kit.lead"]);
  assert.equal(state.solo.size, 3);
  state.retain(["kit.kick", "new"]);
  assert.deepEqual([...state.solo], ["kit.kick"]);
  state.clear();
  assert.equal(state.solo.size, 0);
});
