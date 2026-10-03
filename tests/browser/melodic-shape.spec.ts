import { test, expect } from "@playwright/test";
import { clickCommand } from "./commands";

declare global { interface Window { noteRects: { x: number; y: number; width: number }[] } }

for (const [repeats, mode] of [
  [16, "detail"],
  [400, "overview"],
] as const) {
  test(`melodic shape survives wide zoom with ${mode}`, async ({ page }) => {
    await page.addInitScript((repeats) => {
      localStorage.setItem(
        "muzpad-draft-v1",
        JSON.stringify({
          id: "shape",
          title: "Melodic shape",
          entry: "song.muz",
          files: {
            "song.muz": `song({tracks:[track("lead",phrase("C4:q E4:h G4:q B4:w").repeat(${repeats}),synth("init"))],tail:0})`,
          },
        }),
      );
      window.noteRects = [];
      const fill = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (
        x,
        y,
        width,
        height,
      ) {
        if (x === 0 && y === 0 && height > 58 && this.canvas.closest("#arrangement"))
          window.noteRects = [];
        if (height === 2.5 && this.canvas.closest("#arrangement"))
          window.noteRects.push({ x, y, width });
        return fill.call(this, x, y, width, height);
      };
    }, repeats);
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#arrangement")).toHaveAttribute(
      "data-representation",
      mode,
    );
    // This is the same wide zoom which still uses density for kits.
    await expect(page.locator("#arrangement")).toHaveAttribute(
      "data-kit-view",
      "density",
    );
    const rects = await page.evaluate(() => window.noteRects);
    expect(
      new Set(rects.map((rect) => rect.y)).size,
    ).toBeGreaterThanOrEqual(4);
    expect(rects.some((rect) => rect.width > 2)).toBe(true);
  });
}

test("simultaneous octave notes select the nearest actually painted pitch", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("muzpad-draft-v1", JSON.stringify({
      id: "octave-selection", title: "Octave selection", entry: "song.muz",
      files: { "song.muz": 'song({tracks:[track("chord",stack([note(60,4b),note(72,4b)]),synth("init"))],tail:0})' },
    }));
    window.noteRects = [];
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      if (this.canvas.closest("#arrangement")) {
        if (x === 0 && y === 0 && height > 58) window.noteRects = [];
        if (height === 2.5) window.noteRects.push({ x, y, width });
      }
      return fill.call(this, x, y, width, height);
    };
  });
  await page.goto("./");
  await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
  await expect(page.locator("#arrangement")).toHaveAttribute("data-representation", "detail");
  await clickCommand(page, "#toggle-inspector");
  const rects = await page.evaluate(() => [...window.noteRects].sort((a, b) => b.y - a.y));
  expect(rects).toHaveLength(2);
  expect(rects[0].y - rects[1].y).toBeLessThan(6);
  for (const [index, name] of ["C4", "C5"].entries()) {
    await page.locator("#arrangement").evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
    const currentRects = await page.evaluate(() => [...window.noteRects].sort((a, b) => b.y - a.y));
    await page.locator("#arrangement canvas").click({ position: {
      x: Math.max(154, currentRects[index].x) + Math.min(20, currentRects[index].width / 2), y: currentRects[index].y + 1.25,
    } });
    await expect(page.locator("#selection-label")).toHaveText(`chord · ${name}`);
    await expect(page.locator("#inspector")).toContainText(name);
  }
});
