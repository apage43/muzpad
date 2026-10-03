import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkbenchStatus, technicalDetails, describeActionFailure, olderObservation } from "../src/workbench-status.ts";

const outcome = (channel, requestId, action, result) => ({ channel, requestId, action, outcome: result, summary: result, nextAction: "Review the current state." });
const revisionRef = {
  project: "originating-project", epoch: "project-epoch", engineEpoch: "engine-epoch",
  revision: "revision-18446744073709551615", sourceVersion: 17, entry: "song.muz",
};
const stopDiagnostic = (requestId) => ({
  code: "cancelled", phase: "transport", continuity: "preserved",
  message: "Playback stopped, but resetting the position was cancelled.",
  operation: {
    action: "stop", requestId, ref: revisionRef, outcome: "partial", phase: "transport", continuity: "preserved",
    expectedRuntimeRevision: "18446744073709551614", actualRuntimeRevision: "18446744073709551615",
  },
});
test("late background failed build cannot overwrite a newer authoritative acceptance", () => {
  const status = new WorkbenchStatus();
  status.begin("build", "Rebuild", "older");
  status.begin("build", "Rebuild", "newer");
  assert.equal(status.settle(outcome("build", "newer", "Rebuild", "applied")), true);
  assert.equal(status.settle(outcome("build", "older", "Rebuild", "failed"), "background"), false);
  assert.equal(status.channels.get("build").outcome, "applied");
  assert.equal(status.channels.get("build").requestId, "newer");
  assert.equal(status.issues.size, 0);
});
test("save, recovery, playback, build and inspection remain independent", () => {
  const status = new WorkbenchStatus();
  for (const [channel, result] of [["save", "partial"], ["recovery", "failed"], ["playback", "rejected"], ["build", "applied"], ["operation", "failed"]]) {
    status.begin(channel, channel, channel);
    status.settle(outcome(channel, channel, channel, result));
  }
  assert.deepEqual([...status.channels.values()].map(value => value.outcome), ["partial", "failed", "rejected", "applied", "failed"]);
  status.begin("build", "Rebuild", "next");
  assert.equal(status.channels.get("save").outcome, "partial");
  assert.equal(status.channels.get("recovery").outcome, "failed");
});
test("an older compound Stop acknowledgment retains its partial outcome without replacing current playback", () => {
  const status = new WorkbenchStatus();
  status.begin("playback", "Stop", "stop");
  status.begin("playback", "Play", "play");
  const current = outcome("playback", "play", "Play", "applied");
  status.settle(current);
  const diagnostic = stopDiagnostic("stop");
  const failure = describeActionFailure(diagnostic);
  const receipt = { ...outcome("playback", failure.requestId, "Stop", failure.outcome), technical: failure.diagnostic };
  assert.equal(status.settle(receipt), true);
  assert.equal(status.channels.get("playback"), current);
  assert.equal(status.issues.get("stop"), receipt);
  assert.equal(status.issues.get("stop").outcome, "partial");
  assert.equal(status.issues.get("stop").technical.operation.ref, revisionRef);
});
test("starting later playback retains the already acknowledged compound Stop partial", () => {
  const status = new WorkbenchStatus();
  status.begin("playback", "Stop", "stop");
  const failure = describeActionFailure(stopDiagnostic("stop"));
  const receipt = { ...outcome("playback", failure.requestId, "Stop", failure.outcome), technical: failure.diagnostic };
  assert.equal(status.settle(receipt), true);
  status.begin("playback", "Play", "play");
  assert.equal(status.channels.get("playback").outcome, "pending");
  assert.equal(status.issues.get("stop"), receipt);
  assert.equal(status.issues.get("stop").outcome, "partial");
  status.settle(outcome("playback", "play", "Play", "applied"));
  assert.equal(status.issues.get("stop"), receipt);
});
for (const result of ["rejected", "cancelled", "partial", "unknown", "applied", "superseded", "failed"]) {
  test(`older explicit ${result} acknowledgments survive newer owned actions on every non-playback channel`, () => {
    for (const channel of ["operation", "build", "save", "recovery"]) {
      const status = new WorkbenchStatus();
      status.begin(channel, "Older action", "older");
      status.begin(channel, "Newer action", "newer");
      const current = outcome(channel, "newer", "Newer action", "applied");
      const origin = { project: revisionRef.project, epoch: revisionRef.epoch, title: "Originating workspace" };
      const technical = { operation: {
        action: "inspect", requestId: "older", ref: revisionRef, outcome: result,
        expectedRuntimeRevision: "18446744073709551614", actualRuntimeRevision: "18446744073709551615",
      } };
      const receipt = { ...outcome(channel, "older", "Older action", result), origin, technical };
      assert.equal(status.settle(current), true);
      assert.equal(status.settle(receipt), true);
      assert.equal(status.channels.get(channel), current);
      assert.equal(status.issues.get("older"), receipt);
      assert.equal(status.issues.get("older").origin, origin);
      assert.equal(status.issues.get("older").technical.operation.ref, revisionRef);
      assert.equal(status.issues.get("older").technical.operation.requestId, "older");
      assert.deepEqual(JSON.parse(technicalDetails(receipt.technical)), technical);
    }
  });
}
test("stale background terminal outcomes and stale pending statuses cannot alter current channels or issues", () => {
  for (const channel of ["operation", "build", "save", "recovery", "playback"]) {
    for (const result of ["rejected", "cancelled", "partial", "unknown", "applied", "superseded", "failed"]) {
      const status = new WorkbenchStatus();
      status.begin(channel, "Older action", "older");
      status.begin(channel, "Newer action", "newer");
      const current = outcome(channel, "newer", "Newer action", "applied");
      status.settle(current);
      assert.equal(status.settle(outcome(channel, "older", "Older action", result), "background"), false);
      assert.equal(status.settle(outcome(channel, "older", "Older action", "pending")), false);
      assert.equal(status.channels.get(channel), current);
      assert.equal(status.issues.size, 0);
    }
  }
});
test("starting another operation preserves unresolved issues until an owned successful save", () => {
  const status = new WorkbenchStatus();
  status.begin("save", "Save", "disk");
  status.settle(outcome("save", "disk", "Save", "failed"));
  status.begin("save", "Save", "retry");
  assert.equal(status.issues.get("disk").outcome, "failed");
  status.settle(outcome("save", "retry", "Save", "applied"));
  assert.equal(status.issues.size, 0);
});
test("successful Save, recovery and build keep late acknowledgments from different or unidentified origins", () => {
  const origin = { project: "project", epoch: "epoch", title: "Current workspace" };
  const origins = [
    [{ ...origin, project: "older-project" }, origin],
    [{ ...origin, epoch: "older-epoch" }, origin],
    [undefined, origin],
    [origin, undefined],
  ];
  for (const channel of ["save", "recovery", "build"]) {
    for (const [olderOrigin, currentOrigin] of origins) {
      for (const result of ["rejected", "cancelled", "partial", "unknown", "applied", "superseded", "failed"]) {
        const status = new WorkbenchStatus();
        status.begin(channel, "Older action", "older");
        status.begin(channel, "Current action", "current");
        const receipt = { ...outcome(channel, "older", "Older action", result), origin: olderOrigin };
        assert.equal(status.settle(receipt), true);
        const current = { ...outcome(channel, "current", "Current action", "applied"), origin: currentOrigin };
        assert.equal(status.settle(current), true);
        assert.equal(status.channels.get(channel), current);
        assert.equal(status.issues.get("older"), receipt);
      }
    }
  }
});
test("same-origin successful retries resolve archived issues using project and epoch, not workspace title", () => {
  for (const channel of ["save", "recovery", "build"]) {
    const status = new WorkbenchStatus();
    const origin = { project: "project", epoch: "epoch", title: "Original title" };
    status.begin(channel, "Attempt", "first");
    const receipt = { ...outcome(channel, "first", "Attempt", "partial"), origin };
    assert.equal(status.settle(receipt), true);
    status.begin(channel, "Retry", "retry");
    assert.equal(status.issues.get("first"), receipt);
    const retry = { ...outcome(channel, "retry", "Retry", "applied"), origin: { ...origin, title: "Renamed workspace" } };
    assert.equal(status.settle(retry), true);
    assert.equal(status.channels.get(channel), retry);
    assert.equal(status.issues.size, 0);
  }
});
test("retained explicit outcomes are bounded and preserve exact decimal technical tickets", () => {
  const status = new WorkbenchStatus();
  const channels = ["playback", "operation", "build", "save", "recovery"];
  for (const channel of channels) status.begin(channel, "Current action", `latest-${channel}`);
  for (let index = 0; index < 100; index++) {
    const channel = channels[index % channels.length];
    assert.equal(status.settle(outcome(channel, String(index), "Older action", "rejected")), true);
  }
  assert.equal(status.issues.size, 32);
  assert.deepEqual([...status.issues.keys()], Array.from({ length: 32 }, (_, index) => String(index + 68)));
  for (const channel of channels) {
    assert.equal(status.channels.get(channel).requestId, `latest-${channel}`);
    assert.equal(status.channels.get(channel).outcome, "pending");
  }
  const details = technicalDetails({ expectedRuntimeRevision: "18446744073709551615", error: new Error("callback rejected") });
  assert.match(details, /18446744073709551615/);
  assert.match(details, /callback rejected/);
});
test("background storage failures do not supersede an authoritative pending save", () => {
  const status = new WorkbenchStatus();
  status.begin("save", "Save", "saving");
  status.report(outcome("recovery", "background-recovery", "Preserve recovery copy", "failed"));
  assert.equal(status.channels.get("save").requestId, "saving");
  assert.equal(status.settle(outcome("save", "saving", "Save", "applied")), true);
  assert.equal(status.issues.get("background-recovery").outcome, "failed");
  status.begin("recovery", "Preserve recovery copy", "recovery-retry");
  status.settle(outcome("recovery", "recovery-retry", "Preserve recovery copy", "applied"));
  assert.equal(status.issues.has("background-recovery"), false);
});
test("recognized authoritative outcomes override cancellation codes and AbortError wrappers", () => {
  for (const result of ["applied", "rejected", "cancelled", "superseded", "unknown", "partial"]) {
    const diagnostic = {
      code: "cancelled", message: "Requested action did not finish normally.", requestId: "outer-receipt",
      operation: { action: "export", requestId: "receipt", ref: revisionRef, outcome: result, expectedRuntimeRevision: "18446744073709551615" },
    };
    for (const error of [diagnostic, Object.assign(new Error(diagnostic.message), { name: "AbortError", diagnostic })]) {
      const failure = describeActionFailure(error);
      assert.equal(failure.outcome, result);
      assert.equal(failure.requestId, "receipt");
      assert.equal(failure.diagnostic, diagnostic);
      assert.equal(failure.operation, diagnostic.operation);
      assert.equal(failure.operation.ref, revisionRef);
      assert.match(technicalDetails(failure.diagnostic), /18446744073709551615/);
    }
  }
});
test("unrecognized or missing authoritative outcomes use cancellation fallbacks", () => {
  for (const operation of [undefined, {}, { outcome: "pending" }, { outcome: "invalid" }]) {
    assert.equal(describeActionFailure(Object.assign(new Error("Cancelled"), { name: "AbortError", diagnostic: { operation } })).outcome, "cancelled");
    assert.equal(describeActionFailure({ code: "cancelled", message: "Cancelled", operation }).outcome, "cancelled");
    assert.equal(describeActionFailure({ code: "backend_receipt", message: "Failed", operation }).outcome, "failed");
  }
  assert.equal(describeActionFailure(Object.assign(new Error("Cancelled"), { name: "AbortError" })).outcome, "cancelled");
});
test("later observed receipts cannot be rewound by an accepted snapshot or older frame", () => {
  const current = { generation: "9223372036854775809", sequence: "18446744073709551614" };
  assert.equal(olderObservation({ generation: current.generation, sequence: "18446744073709551613" }, current), true);
  assert.equal(olderObservation({ generation: current.generation, sequence: "18446744073709551615" }, current), false);
  assert.equal(olderObservation({ generation: "9223372036854775808", sequence: "18446744073709551615" }, current), true);
  assert.equal(olderObservation({ generation: "9223372036854775810", sequence: "0" }, current), false);
  assert.equal(olderObservation(current, current), false);
});
