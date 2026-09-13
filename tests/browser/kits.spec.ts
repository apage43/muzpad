import { test, expect } from "@playwright/test";
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
    "Kit lanes: hit density",
  );
  const expandedHeight = await page
    .locator(".arrangement-surface")
    .evaluate((el) => el.style.height);
  await group.click();
  await expect(
    page.getByRole("button", { name: "Expand rack.a kit" }),
  ).toHaveAttribute("aria-expanded", "false");
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
    "data-kit-view",
    "hits",
  );
  await expect(page.locator("#kit-legend")).toContainText("velocity");
  // kick sorts before metal.high; the second compact row centers at y=132.
  await page
    .locator("#arrangement canvas")
    .click({ position: { x: 131, y: 132 } });
  await expect(page.locator("#selection-label")).toHaveText(
    "rack.a · metal.high hit",
  );
  await expect(page.locator("#inspector")).toContainText("metal.high");
  await expect(page.locator("#analysis-source")).toHaveValue(
    "rack.a.metal.high",
  );
  await page.locator("#jump-source").click();
  await expect(page.locator("#source-path")).toHaveText("song.muz");
  await page.locator("#play").click();
  await expect(page.locator("#audio-health")).toHaveText("Audio running");
  await page.getByRole("button", { name: "Collapse rack.a kit" }).click();
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await expect(page.locator("#analysis-source")).toHaveValue(
    "rack.a.metal.high",
  );
});
