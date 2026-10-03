import { test, expect } from "@playwright/test";
import { clickCommand } from "./commands";
import { viewportProfileSource } from "./viewport-fixture";

declare global {
  interface Window {
    delayInspections: number;
    viewportPaint: { revision: string; state: string; notes: number };
    viewportRequests: number;
    holdRevisionInspections: boolean;
    heldRevisionRequests: number;
    releaseRevisionInspections: () => void;
  }
}

const source = `song({tracks:[track("lead",stack([note(0,128b),phrase("C4:q E4:q G4:q B4:q").repeat(32)]),synth("init"))],tail:0})`;

test("delayed navigation and rebuild retain truthful coordinates and disable previous identities", async ({ page }) => {
  await page.addInitScript((source) => {
    localStorage.setItem("muzpad-draft-v1", JSON.stringify({ id: "coherent", title: "Coherent viewport", entry: "song.muz", files: { "song.muz": source } }));
    window.delayInspections = 0; window.viewportRequests = 0;
    window.holdRevisionInspections = false; window.heldRevisionRequests = 0;
    const heldRevisionRequests: (() => void)[] = [];
    window.releaseRevisionInspections = () => {
      window.holdRevisionInspections = false;
      for (const send of heldRevisionRequests.splice(0)) send();
    };
    window.viewportPaint = { revision: "", state: "", notes: 0 };
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args: unknown[]) {
      const envelope = args[0];
      if (envelope && typeof envelope === "object" && "message" in envelope) {
        const message = envelope.message;
        if (message && typeof message === "object" && "command" in message && message.command === "inspect") {
          window.viewportRequests++;
          if (window.holdRevisionInspections && "view" in message &&
              (message.view === "performance" || message.view === "performance_overview")) {
            window.heldRevisionRequests++;
            heldRevisionRequests.push(() => Reflect.apply(send, this, args));
            return;
          }
          if (window.delayInspections) {
            // Delay the real producer request, not a mocked page or response.
            setTimeout(() => Reflect.apply(send, this, args), window.delayInspections);
            return;
          }
        }
      }
      return Reflect.apply(send, this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      const parent = this.canvas.closest<HTMLElement>("#arrangement");
      if (parent) {
        if (x === 0 && y === 0 && height > 58) window.viewportPaint = {
          revision: parent.dataset.displayedRevision ?? "", state: parent.dataset.inspectionState ?? "", notes: 0,
        };
        if (height === 2.5) window.viewportPaint.notes++;
      }
      return fill.call(this, x, y, width, height);
    };
  }, source);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const viewport = page.locator("#arrangement");
  await expect(viewport).toHaveAttribute("data-displayed-revision", "1");
  await clickCommand(page, "#toggle-inspector");
  await page.locator("#zoom").fill("6");
  await page.locator("#zoom").dispatchEvent("input");
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await page.evaluate(() => { window.delayInspections = 180; });
  await viewport.evaluate((element) => { element.scrollLeft = element.clientWidth * 5; });
  await expect(viewport).toHaveAttribute("data-inspection-state", "pending");
  await expect(page.getByRole("button", { name: "Mute lead", exact: true })).toBeDisabled();
  await viewport.evaluate((element) => { element.scrollLeft = element.clientWidth * 12; });
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  expect(await page.evaluate(() => window.viewportPaint.notes), "left-overlap sustained note remains painted").toBeGreaterThan(0);
  await viewport.evaluate((element) => { element.scrollLeft = 0; });
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  const editor = page.locator(".cm-content");
  await editor.click(); await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(source.replace('synth("init")', 'synth("bell")'));
  await page.evaluate(() => { window.holdRevisionInspections = true; });
  try {
    await page.locator("#run").click();
    await expect.poll(() => page.evaluate(() => window.heldRevisionRequests)).toBeGreaterThan(0);
    await expect(viewport).toHaveAttribute("data-inspection-state", "previous-revision");
    await expect(viewport).toHaveAttribute("data-displayed-revision", "1");
    await expect(page.getByRole("button", { name: "Mute lead", exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.viewportPaint.notes)).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => window.releaseRevisionInspections());
  }
  await expect(viewport).toHaveAttribute("data-displayed-revision", "2");
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await expect(page.getByRole("button", { name: "Mute lead", exact: true })).toBeEnabled();
});

test("catalogs beyond first-page buses retain every selectable track and bounded visible controls", async ({ page }) => {
  const source = viewportProfileSource({ tracks: 120, buses: 105, repeats: 8, kitLanes: 12 });
  await page.addInitScript((source) => localStorage.setItem("muzpad-draft-v1", JSON.stringify({
    id: "catalog-profile", title: "Catalog profile", entry: "song.muz", files: { "song.muz": source },
  })), source);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted", { timeout: 60_000 });
  await clickCommand(page, "#toggle-inspector");
  await expect(page.locator("#track-select option")).toHaveCount(132);
  await page.locator("#track-select").selectOption("lane119");
  await expect(page.locator("#selection-label")).toHaveText("lane119");
  const viewport = page.locator("#arrangement");
  // Consume a covered no-op commit, then navigate vertically to unqueried rows.
  await page.locator("#zoom").fill("3");
  await page.locator("#zoom").dispatchEvent("input");
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await viewport.evaluate((element) => { element.scrollLeft = 32; });
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await viewport.dispatchEvent("scroll");
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await viewport.evaluate((element) => { element.scrollTop = 120 * 56; });
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await expect(page.getByRole("button", { name: "Collapse profilekit kit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse profilekit kit", exact: true }).focus();
  // Native focus may scroll the real viewport; wait for its newly covered frame
  // before invoking a score-identity-sensitive action.
  await viewport.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await expect(page.getByRole("button", { name: "Collapse profilekit kit", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Collapse profilekit kit", exact: true }).focus();
  await expect(page.getByRole("button", { name: "Collapse profilekit kit", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Expand profilekit kit", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await expect(page.getByRole("button", { name: "Mute profilekit kit", exact: true })).toBeEnabled();
  const geometry = await viewport.evaluate(element => {
    const parent = element.getBoundingClientRect();
    const canvas = element.querySelector("canvas")!.getBoundingClientRect();
    const surface = element.querySelector<HTMLElement>(".arrangement-surface")!;
    return { offset: canvas.top - parent.top, bitmapHeight: canvas.height,
      viewportHeight: element.clientHeight, top: element.scrollTop,
      maximum: Math.max(0, parseFloat(surface.style.height) - element.clientHeight) };
  });
  expect(Math.abs(geometry.offset), JSON.stringify(geometry)).toBeLessThanOrEqual(1);
  expect(geometry.bitmapHeight).toBe(geometry.viewportHeight);
  expect(geometry.top, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.maximum);
  expect(await page.locator(".track-audition button").count()).toBeLessThan(60);
});
