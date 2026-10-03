import { test, expect } from "@playwright/test";
import { build } from "vite";
import type { Arrangement, ArrangementTarget } from "../../src/views";

declare global {
  interface Window { ViewportConsumer: { Arrangement: typeof Arrangement } }
}

let viewportScript = "";
test.beforeAll(async () => {
  // Compile the real production consumer into an in-memory browser-realm fixture.
  // The ordinary static /studio/ server intentionally does not expose source files.
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    write: false, lib: { entry: "src/views.ts", name: "ViewportConsumer", formats: ["iife"] },
  } });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!output || !("output" in output)) throw new Error("Expected an in-memory viewport bundle.");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (!chunk) throw new Error("Viewport consumer bundle did not contain JavaScript.");
  viewportScript = chunk.code;
});

// These isolate the production canvas consumer using real browser rAF/scroll events,
// rather than mocking its bitmap, listeners or navigation generations.
test("queued covered follow scrolling loses to manual navigation before paint", async ({ page }) => {
  await page.goto("./");
  await page.addScriptTag({ content: viewportScript });
  const result = await page.evaluate(async () => {
    const { Arrangement } = window.ViewportConsumer;
    const parent = document.createElement("div");
    parent.style.cssText = "position:fixed;inset:0 auto auto 0;width:640px;height:220px;overflow:auto;z-index:99999";
    document.body.append(parent);
    const arrangement = new Arrangement(parent);
    arrangement.canvas.style.cssText = "display:block;position:sticky;left:0;top:0";
    arrangement.zoom = 16;
    const refresh = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
    await refresh();
    const ref = { project: "canvas-test", epoch: "epoch", engineEpoch: "engine", revision: "1", sourceVersion: 1, entry: "song.muz" };
    const views = { graph: { transport: { meter: [4, 4] }, tracks: [{ id: "lead" }], extras: { sections: [], track_groups: [] } },
      performance: [{ track: "lead", ppq: 100, notes: [{ id: "sustain", start_tick: 0, duration_ticks: 3200, key: 60, attack_velocity: 100 }], representation: "detail" }] };
    const frame = (target: ArrangementTarget) => ({ ref, views, end: 32, target,
      coverage: { start: 0, end: 32, span: 16 }, coveredTracks: new Set(["lead"]), coveredGroups: new Set<string>() });
    arrangement.beginRevision(ref);
    const initial = arrangement.target(views, 32);
    arrangement.setDesiredTarget(initial); arrangement.commitFrame(frame(initial));
    await refresh();
    const follow = arrangement.target(views, 32, 100);
    arrangement.setDesiredTarget(follow); arrangement.commitScroll(follow);
    arrangement.setFollow(false); parent.scrollLeft = 320;
    await refresh();
    const manual = parent.scrollLeft;
    // Staged A must also lose to a newer covered B without another status tick.
    arrangement.setFollow(true);
    await refresh();
    const oldFollow = arrangement.target(views, 32, 1000);
    arrangement.setDesiredTarget(oldFollow); arrangement.commitFrame(frame(oldFollow));
    const latest = arrangement.target(views, 32, 0);
    arrangement.setDesiredTarget(latest); arrangement.commitScroll(latest);
    await refresh();
    const latestScroll = parent.scrollLeft;
    parent.remove();
    return { manual, latestScroll };
  });
  expect(result.manual).toBe(320);
  expect(result.latestScroll).toBe(0);
});

test("kit coverage rejects unpadded reuse and preserves clipped marker identity", async ({ page }) => {
  await page.goto("./");
  await page.addScriptTag({ content: viewportScript });
  const result = await page.evaluate(async () => {
    const { Arrangement } = window.ViewportConsumer;
    const parent = document.createElement("div");
    parent.style.cssText = "position:fixed;inset:0 auto auto 0;width:254px;height:220px;overflow:auto;z-index:99999";
    document.body.append(parent);
    const arrangement = new Arrangement(parent);
    arrangement.canvas.style.cssText = "display:block;position:sticky;left:0;top:0";
    arrangement.zoom = 100 * 32 / (254 - 166);
    const refresh = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
    await refresh();
    const ref = { project: "kit-edge", epoch: "epoch", engineEpoch: "engine", revision: "1", sourceVersion: 1, entry: "song.muz" };
    const graph = { transport: { meter: [4, 4] }, tracks: [{ id: "kit.hit" }], extras: { sections: [], track_groups: [
      { id: "kit", kind: "kit", members: [{ track: "kit.hit", label: "hit" }] },
    ] } };
    const views = { graph, performance: [{ track: "kit.hit", ppq: 100, notes: [], representation: "detail" }] };
    arrangement.beginRevision(ref);
    parent.scrollLeft = 1000; await refresh();
    const initial = arrangement.target(views, 32);
    arrangement.setDesiredTarget(initial);
    arrangement.commitFrame({ ref, views, end: 32, target: initial, coverage: { start: 8, end: 12, span: 2 },
      coveredTracks: new Set(["kit.hit"]), coveredGroups: new Set<string>() });
    await refresh();
    parent.scrollLeft = 800; await refresh();
    const boundary = arrangement.target(views, 32);
    const leftCovered = arrangement.isCovered(boundary);
    const rightCovered = arrangement.isCovered(arrangement.target(views, 32, 1100));
    const note = { id: "edge-onset", start_tick: 797, duration_ticks: 0, key: 60, attack_velocity: 127 };
    const refreshed = { graph, performance: [{ track: "kit.hit", ppq: 100, notes: [note], representation: "detail" }] };
    arrangement.setDesiredTarget(boundary);
    arrangement.commitFrame({ ref, views: refreshed, end: 32, target: boundary, coverage: { start: 6, end: 10, span: 2 },
      coveredTracks: new Set(["kit.hit"]), coveredGroups: new Set<string>() });
    await refresh();
    let selected = "";
    arrangement.onSelect = (_track: string, event?: { id?: string }) => { selected = event?.id ?? ""; };
    const rect = arrangement.canvas.getBoundingClientRect();
    arrangement.canvas.dispatchEvent(new MouseEvent("click", { clientX: rect.left + 155, clientY: rect.top + 108, bubbles: true }));
    parent.remove();
    return { leftCovered, rightCovered, selected };
  });
  expect(result.leftCovered).toBe(false);
  expect(result.rightCovered).toBe(false);
  expect(result.selected).toBe("edge-onset");
});
