import { test, expect } from "@playwright/test";

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
      (window as any).noteRects = [];
      const fill = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (
        x,
        y,
        width,
        height,
      ) {
        if (height === 2.5 && this.canvas.closest("#arrangement"))
          (window as any).noteRects.push({ x, y, width });
        return fill.call(this, x, y, width, height);
      };
    }, repeats);
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#arrangement")).toHaveAttribute(
      "data-inspection-state",
      mode,
    );
    // This is the same wide zoom which still uses density for kits.
    await expect(page.locator("#arrangement")).toHaveAttribute(
      "data-kit-view",
      "density",
    );
    const rects = await page.evaluate(() => (window as any).noteRects);
    expect(
      new Set(rects.map((rect: any) => rect.y)).size,
    ).toBeGreaterThanOrEqual(4);
    expect(rects.some((rect: any) => rect.width > 2)).toBe(true);
  });
}
