import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { normalizePreferences, PreferencesController } from "../src/preferences.ts";

const savedPreferences = {
  version: 1, theme: "light",
  layout: { explorer: true, source: true, visualization: true, inspector: true, sourceFraction: 0.46 },
};


test("preferences validate individual fields without discarding neighboring valid values", () => {
  assert.deepEqual(normalizePreferences({
    version: 1, theme: "soft-dark", unexpected: "excluded",
    layout: { explorer: false, source: "false", visualization: 0, inspector: false, sourceFraction: 0.6, extra: 1 },
  }), {
    version: 1, theme: "soft-dark",
    layout: { explorer: false, source: true, visualization: true, inspector: false, sourceFraction: 0.6 },
  });
  for (const theme of ["light", "dark", "soft-light", "soft-dark"])
    assert.equal(normalizePreferences({ version: 1, theme }).theme, theme);
  for (const theme of ["sepia", "Dark", 0, false, null])
    assert.equal(normalizePreferences({ version: 1, theme, layout: { source: false } }).theme, "light");
});

test("fraction clamps inclusive bounds and preserves valid saved proportions", () => {
  for (const [input, expected] of [
    [0, 0.25], [-1, 0.25], [0.25, 0.25], [0.46, 0.46], [0.7, 0.7], [100, 0.7],
  ]) {
    assert.equal(normalizePreferences({ version: 1, layout: { sourceFraction: input } }).layout.sourceFraction, expected, String(input));
  }
});

test("controller applies changes immediately but serializes and coalesces newest saves", async () => {
  const writes = [];
  const releases = [];
  let active = 0;
  let maximum = 0;
  const controller = await PreferencesController.load({
    async load() { return null; },
    async save(value) {
      active++;
      maximum = Math.max(maximum, active);
      writes.push(value);
      await new Promise(resolve => releases.push(resolve));
      active--;
    },
  });
  const notifications = [];
  const unsubscribe = controller.subscribe((value, temporary) => notifications.push({ value, temporary }));
  controller.update({ theme: "dark" });
  controller.update({ layout: { source: false, sourceFraction: 0.66 } });
  controller.update({ theme: "soft-light" });
  controller.update({ theme: "soft-dark", layout: { inspector: false } });
  assert.equal(controller.value.theme, "soft-dark");
  assert.equal(controller.value.layout.source, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].theme, "dark");
  releases.shift()();
  await setImmediate();
  assert.equal(writes.length, 2, "intermediate queued values are replaced, not concurrently written");
  assert.deepEqual(writes[1], controller.value);
  assert.equal(maximum, 1);
  releases.shift()();
  await setImmediate();
  assert.equal(active, 0);
  assert.equal(controller.temporary, false);
  assert.equal(notifications.length, 4);
  unsubscribe();
  controller.update({ theme: "light" });
  releases.shift()();
  await setImmediate();
  assert.equal(notifications.length, 4);
});

test("a deferred rejected save preserves newer pending changes and recovers only after the latest save", async () => {
  const writes = [];
  const completions = [];
  let saved = savedPreferences;
  let active = 0;
  let maximum = 0;
  const controller = await PreferencesController.load({
    async load() { return saved; },
    async save(value) {
      active++;
      maximum = Math.max(maximum, active);
      writes.push(value);
      try {
        await new Promise((resolve, reject) => completions.push({ resolve, reject }));
        saved = value;
      } finally {
        active--;
      }
    },
  });
  const notifications = [];
  controller.subscribe((value, temporary) => notifications.push({ value, temporary }));
  controller.update({ theme: "dark" });
  controller.update({ layout: { explorer: false, sourceFraction: 0.7 } });
  controller.update({ theme: "soft-dark", layout: { inspector: false } });
  const pending = controller.value;
  assert.equal(writes.length, 1);
  assert.equal(controller.temporary, false);
  completions.shift().reject(new Error("deferred write denied"));
  await setImmediate();
  assert.equal(writes.length, 2, "the latest pending state starts after the rejected write settles");
  assert.deepEqual(writes[1], pending);
  assert.equal(active, 1);
  assert.equal(maximum, 1, "recovery writes must stay serialized");
  assert.deepEqual(saved, savedPreferences, "the rejected save must not become durable");
  assert.equal(controller.value, pending, "a failed older save must not roll back live preferences");
  assert.equal(controller.temporary, true);
  assert.deepEqual(notifications.at(-1), { value: pending, temporary: true });

  controller.update({ theme: "soft-light", layout: { source: false, sourceFraction: 0.25 } });
  const latest = controller.value;
  assert.equal(writes.length, 2);
  completions.shift().resolve();
  await setImmediate();
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[2], latest);
  assert.deepEqual(saved, pending);
  assert.equal(controller.value, latest);
  assert.equal(controller.temporary, true, "an older success cannot clear failure while newer changes are pending");
  assert.equal(notifications.at(-1).temporary, true);
  completions.shift().resolve();
  await setImmediate();
  assert.equal(active, 0);
  assert.equal(maximum, 1);
  assert.equal(writes.length, 3, "superseded intermediate preferences are never written");
  assert.deepEqual(saved, latest, "the final durable record contains every newest preference");
  assert.equal(controller.temporary, false);
  assert.deepEqual(notifications.at(-1), { value: latest, temporary: false });
});

test("load/save failures are temporary and never roll back current in-memory preferences", async () => {
  let failSave = true;
  const writes = [];
  const controller = await PreferencesController.load({
    async load() { throw new Error("read denied"); },
    async save(value) {
      if (failSave) throw new Error("write denied");
      writes.push(value);
    },
  });
  assert.equal(controller.temporary, true);
  controller.update({ theme: "soft-dark", layout: { explorer: false } });
  await setImmediate();
  assert.equal(controller.temporary, true);
  assert.equal(controller.value.theme, "soft-dark");
  assert.equal(controller.value.layout.explorer, false);
  failSave = false;
  controller.update({ theme: "soft-dark" });
  await setImmediate();
  assert.equal(controller.temporary, false);
  assert.deepEqual(writes, [controller.value]);
});

test("a host failure reported during an in-flight save is not cleared by that older success", async () => {
  let release;
  const controller = await PreferencesController.load({
    async load() { return savedPreferences; },
    async save() { await new Promise(resolve => { release = resolve; }); },
  });
  controller.update({ theme: "dark" });
  controller.reportFailure();
  release();
  await setImmediate();
  assert.equal(controller.temporary, true);
  controller.update({ theme: "soft-dark" });
  release();
  await setImmediate();
  assert.equal(controller.temporary, false);
});

test("reset preserves theme and immutable previous values without repeating unchanged writes", async () => {
  const writes = [];
  const controller = await PreferencesController.load({
    async load() { return { version: 1, theme: "soft-light", layout: { explorer: false, source: false, visualization: false, inspector: false, sourceFraction: 0.7 } }; },
    async save(value) { writes.push(value); },
  });
  const before = controller.value;
  controller.resetLayout();
  await setImmediate();
  assert.equal(controller.value.theme, "soft-light");
  assert.equal(before.layout.sourceFraction, 0.7);
  assert.equal(before.layout.source, false);
  assert.equal(Object.isFrozen(controller.value), true);
  assert.equal(Object.isFrozen(controller.value.layout), true);
  const count = writes.length;
  controller.resetLayout();
  await setImmediate();
  assert.equal(writes.length, count, "unchanged layout should not cause another write");
});
