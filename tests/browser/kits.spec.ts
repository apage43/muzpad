import { test, expect } from "@playwright/test";
import { clickCommand } from "./commands";
const source = `song({tracks: [
  track("rack.a", stack([
    phrase("C4:q").map_notes(fn(n) => {voice:"metal.high",velocity:0.9}),
    drums({kick:"..x."})
  ]).repeat(64), kit("custom", {"metal.high":synth("init")})),
  track("rack.a.lead", phrase("C4:q E4:q").repeat(64), synth("init"))
],tail:0.1})`;
test("kit lanes collapse, zoom into hits, select physical tracks, and retain source navigation", async ({
  page,
}) => {
  await page.addInitScript(
    (source) =>
      localStorage.setItem(
        "muzpad-draft-v1",
        JSON.stringify({
          id: "kit-test",
          title: "Kit test",
          entry: "song.muz",
          files: { "song.muz": source },
        }),
      ),
    source,
  );
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const group = page.getByRole("button", { name: "Collapse rack.a kit" });
  await expect(group).toBeVisible();
  await expect(page.locator("#arrangement")).toHaveAttribute(
    "data-kit-view",
    "density",
  );
  await expect(page.locator("#kit-legend")).toHaveText(
    "Kit lanes: onset density",
  );
  const expandedHeight = await page
    .locator(".arrangement-surface")
    .evaluate((el) => el.style.height);
  await group.click();
  await expect(
    page.getByRole("button", { name: "Expand rack.a kit" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
  await page.getByRole("button", { name: "Expand rack.a kit" }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Collapse rack.a kit" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    await page
      .locator(".arrangement-surface")
      .evaluate((el) => el.style.height),
  ).toBe(expandedHeight);
  await page.locator("#zoom").fill("5");
  await page.locator("#zoom").dispatchEvent("input");
  // Recenter on the start without resetting the zoom.
  await page.locator("#arrangement").evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect(page.locator("#arrangement")).toHaveAttribute(
    "data-inspection-state",
    "ready",
  );
  await expect(page.locator("#arrangement")).toHaveAttribute(
    "data-kit-view",
    "hits",
  );
  await expect(page.locator("#kit-legend")).toContainText("velocity");
  const kitMeter = page.locator('.track-meter[data-track="rack.a.metal.high"]');
  const kitMute = page.getByRole("button", { name: "Mute rack.a.metal.high", exact: true });
  await expect(kitMeter).toBeVisible();
  await expect(kitMute).toBeVisible();
  const meterBounds = await kitMeter.boundingBox();
  const muteBounds = await kitMute.boundingBox();
  if (!meterBounds || !muteBounds) throw new Error("Visible kit controls require geometry");
  expect(muteBounds.width).toBeGreaterThanOrEqual(30);
  expect(muteBounds.height).toBeGreaterThanOrEqual(30);
  expect(meterBounds.x + meterBounds.width).toBeLessThanOrEqual(muteBounds.x);
  await clickCommand(page, "#toggle-inspector");
  // The second compact lane starts at130, with its marker centered at144.
  await page
    .locator("#arrangement canvas")
    .click({ position: { x: 155, y: 144 } });
  await expect(page.locator("#selection-label")).toHaveText(
    "rack.a · metal.high hit",
  );
  await expect(page.locator("#inspector")).toContainText("metal.high");
  await expect(page.locator("#analysis-source")).toHaveValue(
    "rack.a.metal.high",
  );
  await page.locator("#jump-source").click();
  await expect(page.locator("#source-path")).toHaveText("song.muz");
  const viewport = page.locator("#arrangement");
  const collapse = page.getByRole("button", { name: "Collapse rack.a kit" });
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await collapse.focus();
  await viewport.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(viewport).toHaveAttribute("data-inspection-state", "ready");
  await expect(collapse).toBeEnabled();
  await collapse.focus();
  await expect(collapse).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Expand rack.a kit" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#selection-label")).toHaveText("rack.a · metal.high hit");
  await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
  await page.getByRole("button", { name: "Expand rack.a kit" }).press("Enter");
  await expect(page.getByRole("button", { name: "Collapse rack.a kit" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
  await page.locator("#play").click();
  await page.getByRole("button", { name: "Collapse rack.a kit" }).click();
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await expect(page.locator("#analysis-source")).toHaveValue(
    "rack.a.metal.high",
  );
});
