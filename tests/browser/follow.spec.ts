import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    followFrames: { right: number };
  }
}

test("following never exposes a frame with unpaged notes", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "muzpad-draft-v1",
      JSON.stringify({
        id: "follow",
        title: "Follow paging",
        entry: "song.muz",
        files: {
          "song.muz":
            'song({tempo:400,tracks:[track("lead",phrase("C4:q E4:q G4:q B4:q").repeat(32),synth("init"))],tail:0})',
        },
      }),
    );
    const state = (window.followFrames = { right: 0 });
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (
      x,
      y,
      width,
      height,
    ) {
      if (this.canvas.closest("#arrangement")) {
        if (x === 0 && y === 0 && height > 58) state.right = 0;
        if (height === 2.5) state.right = Math.max(state.right, x + width);
      }
      return fill.call(this, x, y, width, height);
    };
  });
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#zoom").fill("5");
  await page.locator("#zoom").dispatchEvent("input");
  await page.locator("#follow").click();
  await page.locator("#follow").click();
  await expect(page.locator("#arrangement")).toHaveAttribute(
    "data-inspection-state",
    "ready",
  );
  await page.locator("#play").click();
  const frames = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("#arrangement")!;
    const samples: { scroll: number; missing: boolean }[] = [];
    const end = performance.now() + 2400;
    while (performance.now() < end) {
      const { promise, resolve } = Promise.withResolvers<number>();
      requestAnimationFrame(resolve);
      await promise;
      if (viewport.scrollLeft > 0)
        samples.push({
          scroll: viewport.scrollLeft,
          missing: window.followFrames.right < viewport.clientWidth * 0.75,
        });
    }
    return samples;
  });
  await page.locator("#play").click();
  expect(
    new Set(frames.map((frame) => frame.scroll)).size,
  ).toBeGreaterThanOrEqual(3);
  expect(frames.filter((frame) => frame.missing)).toEqual([]);
});
