import { test, expect, type Page } from "@playwright/test";

const project = {
  id: "layout-project", title: "Layout project", entry: "song.muz",
  files: {
    "song.muz": 'song({tempo:120,sections:[{name:"loop",duration:128b}],tracks:[track("lead",phrase("C4:q E4:q G4:q B4:q").repeat(32),synth("bell"))],tail:0})',
    "README.md": "# Layout guide\n\nVisible source includes documentation.",
  },
};
const panes = ["explorer", "source", "visualization", "inspector"] as const;
const paneSelector = (pane: typeof panes[number]) => pane === "inspector" ? "#inspector" : `#${pane}-pane`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(value => {
    if (!localStorage.getItem("muzpad-draft-v1"))
      localStorage.setItem("muzpad-draft-v1", JSON.stringify(value));
  }, project);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
});

async function expectNoOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(geometry.page, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.body, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width + 1);
}

for (const viewport of [
  { width: 1512, height: 982 }, { width: 1000, height: 760 },
  { width: 390, height: 844 }, { width: 390, height: 420 },
  { width: 1000, height: 420 },
]) {
  test(`panes occupy only visible geometry at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const pane of panes) {
      await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-controls", paneSelector(pane).slice(1));
      await page.locator(`#pane-${pane}`).click();
      await expect(page.locator(paneSelector(pane))).toBeHidden();
      expect(await page.locator(paneSelector(pane)).boundingBox()).toBeNull();
      await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-expanded", "false");
      if (pane === "source" || pane === "visualization") {
        await expect(page.locator(".splitter")).toBeHidden();
        expect(await page.locator(".splitter").boundingBox()).toBeNull();
      }
      await expectNoOverflow(page);
      await page.locator(`#pane-${pane}`).click();
      await expect(page.locator(paneSelector(pane))).toBeVisible();
      await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-expanded", "true");
    }
    // Inspector is a stored preference, but its effective visibility also depends on Visualization.
    for (const inspector of [false, true]) {
      if (await page.locator("#pane-visualization").getAttribute("aria-expanded") === "false")
        await page.locator("#pane-visualization").click();
      if (await page.locator("#pane-inspector").getAttribute("aria-expanded") !== String(inspector))
        await page.locator("#pane-inspector").click();
      for (let mask = 0; mask < 8; mask++) {
        const visible = { explorer: !!(mask & 1), source: !!(mask & 2), visualization: !!(mask & 4) };
        await test.step(`visibility ${JSON.stringify(visible)}, inspector preference ${inspector}`, async () => {
          for (const pane of ["explorer", "source", "visualization"] as const) {
            if (await page.locator(`#pane-${pane}`).getAttribute("aria-expanded") !== String(visible[pane]))
              await page.locator(`#pane-${pane}`).click();
          }
          for (const pane of panes) {
            const effective = pane === "inspector" ? inspector && visible.visualization : visible[pane];
            await expect(page.locator(`#pane-${pane}`)).toBeVisible();
            await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-expanded", String(effective));
            const element = page.locator(paneSelector(pane));
            if (effective) {
              await expect(element).toBeVisible();
              const box = (await element.boundingBox())!;
              expect(box.width).toBeGreaterThan(0);
              expect(box.height).toBeGreaterThan(0);
            } else {
              await expect(element).toBeHidden();
              expect(await element.boundingBox()).toBeNull();
            }
          }
          await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-preferences-v1")!).layout.inspector)).toBe(inspector);
          if (viewport.width > 800 && visible.source && visible.visualization) {
            await expect(page.locator(".splitter")).toBeVisible();
          } else {
            await expect(page.locator(".splitter")).toBeHidden();
            expect(await page.locator(".splitter").boundingBox()).toBeNull();
          }
          const shown = (["explorer", "source", "visualization"] as const).filter(pane => visible[pane]);
          const boxes = await Promise.all(shown.map(pane => page.locator(paneSelector(pane)).boundingBox()));
          if (viewport.width <= 800) {
            for (let index = 1; index < boxes.length; index++)
              expect(boxes[index]!.y).toBeGreaterThanOrEqual(boxes[index - 1]!.y + boxes[index - 1]!.height - 1);
          }
          if (shown.length === 1 && shown[0] !== "explorer") {
            const workspace = (await page.locator(".workspace").boundingBox())!;
            expect(boxes[0]!.width).toBeGreaterThan(workspace.width - 4);
          }
          if (!shown.length)
            expect(await page.locator(".workspace").evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
          await expectNoOverflow(page);
        });
      }
    }
    // A source-only workspace fills the horizontal region instead of reserving explorer/visual tracks.
    await page.locator("#pane-explorer").click();
    await page.locator("#pane-visualization").click();
    const workspace = await page.locator(".workspace").boundingBox();
    const source = await page.locator("#source-pane").boundingBox();
    expect(source!.width).toBeGreaterThan(workspace!.width - 4);
    await page.locator("#pane-source").click();
    for (const pane of panes) {
      await expect(page.locator(paneSelector(pane))).toBeHidden();
      await expect(page.locator(`#pane-${pane}`)).toBeVisible();
      await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-expanded", "false");
    }
    await expect(page.locator("#play")).toBeVisible();
    await expect(page.locator("#run")).toBeVisible();
    await expect(page.locator("#theme-toggle")).toBeVisible();
    expect(await page.locator(".workspace").evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
    await expectNoOverflow(page);
    await page.locator("#pane-inspector").click();
    await expect(page.locator("#visualization-pane")).toBeVisible();
    await expect(page.locator("#inspector")).toBeVisible();
    await page.locator("#pane-source").click();
    await page.locator("#pane-explorer").click();
    await page.locator('[data-kind="project"][data-file="README.md"]').click();
    await expect(page.locator("#document h1")).toHaveText("Layout guide");
    await page.locator("#pane-source").click();
    await page.locator("#pane-source").click();
    await expect(page.locator("#document h1")).toHaveText("Layout guide");
    if (viewport.width <= 800) {
      const boxes = await Promise.all(["explorer", "source", "visualization"].map(pane => page.locator(`#${pane}-pane`).boundingBox()));
      expect(boxes[1]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height - 1);
      expect(boxes[2]!.y).toBeGreaterThanOrEqual(boxes[1]!.y + boxes[1]!.height - 1);
      expect(boxes[1]!.height).toBeGreaterThan(160);
      expect(boxes[2]!.height).toBeGreaterThan(160);
      await expect(page.locator(".splitter")).toBeHidden();
    }
    await expectNoOverflow(page);
  });
}

test("collapse moves only affected focus and direct restore returns to retained descendants", async ({ page }) => {
  await page.locator(".cm-content").focus();
  // Dispatch the collapse action without moving focus to its button first.
  await page.locator("#collapse-source").dispatchEvent("click");
  await expect(page.locator("#pane-source")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.locator("#collapse-explorer").dispatchEvent("click");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.locator("#pane-explorer").click();
  const focused = await page.evaluate(() => document.activeElement?.id);
  expect(focused).not.toBe("");
  await page.locator("#collapse-explorer").dispatchEvent("click");
  await expect(page.locator("#pane-explorer")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(focused);
  await page.locator('[data-view="routing"]').focus();
  await page.locator("#collapse-visualization").dispatchEvent("click");
  await expect(page.locator("#pane-visualization")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-view="routing"]')).toBeFocused();
});

test("splitter uses actual content bounds, releases cancellation and persists its preferred fraction", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 982 });
  const splitter = page.locator(".splitter");
  await expect(splitter).toHaveAttribute("role", "separator");
  await expect(splitter).toHaveAttribute("aria-valuemin", "25");
  await expect(splitter).toHaveAttribute("aria-valuemax", "70");
  await splitter.focus();
  await page.keyboard.press("Home");
  await expect(splitter).toHaveAttribute("aria-valuenow", "25");
  await page.keyboard.press("End");
  await expect(splitter).toHaveAttribute("aria-valuenow", "70");
  await page.keyboard.press("ArrowLeft");
  expect(Number(await splitter.getAttribute("aria-valuenow"))).toBeLessThan(70);
  await page.locator("#pane-explorer").click();
  const source = (await page.locator("#source-pane").boundingBox())!;
  const visual = (await page.locator("#visualization-pane").boundingBox())!;
  const bar = (await splitter.boundingBox())!;
  const target = source.x + (source.width + visual.width) * 0.55;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 40);
  await page.mouse.down();
  await page.mouse.move(target, bar.y + 40, { steps: 5 });
  await page.mouse.up();
  expect(Number(await splitter.getAttribute("aria-valuenow"))).toBeCloseTo(55, 0);
  const persisted = await page.locator(".workspace").evaluate(element => Number((element as HTMLElement).style.getPropertyValue("--source-fraction")));
  await splitter.evaluate(element => {
    element.addEventListener("pointerdown", event => {
      if (event instanceof PointerEvent) element.setAttribute("data-test-pointer", String(event.pointerId));
    }, { once: true });
  });
  const currentBar = (await splitter.boundingBox())!;
  await page.mouse.move(currentBar.x + currentBar.width / 2, currentBar.y + 40);
  await page.mouse.down();
  await splitter.dispatchEvent("pointercancel", {
    pointerId: Number(await splitter.getAttribute("data-test-pointer")), clientX: target,
  });
  await page.mouse.move(target + 100, bar.y + 40);
  await page.mouse.up();
  expect(await page.locator(".workspace").evaluate(element => Number((element as HTMLElement).style.getPropertyValue("--source-fraction")))).toBe(persisted);
  for (const pane of ["source", "visualization"]) {
    await page.locator(`#pane-${pane}`).click();
    await expect(splitter).toBeHidden();
    await page.locator(`#pane-${pane}`).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(splitter).toBeHidden();
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect(splitter).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-preferences-v1")!).layout.sourceFraction)).toBe(persisted);
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  expect(await page.locator(".workspace").evaluate(element => Number((element as HTMLElement).style.getPropertyValue("--source-fraction")))).toBe(persisted);
  await page.locator("#theme-toggle").click();
  await page.locator("#settings-theme").selectOption("soft-dark");
  const revision = await page.locator("#revision").textContent();
  await page.locator("#reset-layout").click();
  await page.locator("#settings-close").click();
  for (const pane of panes) await expect(page.locator(paneSelector(pane))).toBeVisible();
  await expect(splitter).toHaveAttribute("aria-valuenow", "46");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "soft-dark");
  await expect(page.locator("#project-title")).toHaveText("Layout project");
  await expect(page.locator("#revision")).toHaveText(revision!);
});

test("visual hide retains paused and playing follow-off viewport, analysis, audition and loop", async ({ page }) => {
  await page.locator("#zoom").fill("8");
  await page.locator("#zoom").dispatchEvent("input");
  await page.locator("#follow").click();
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#arrangement").evaluate(element => { element.scrollLeft = 450; });
  await page.locator("#loop").click();
  await page.getByRole("button", { name: "Solo lead", exact: true }).click();
  await page.locator("#analysis-source").selectOption("lead");
  await page.locator("#pane-inspector").click();
  await expect(page.locator("#scope")).toBeVisible();
  const scroll = await page.locator("#arrangement").evaluate(element => element.scrollLeft);
  const zoom = await page.locator("#zoom").inputValue();
  for (const playing of [false, true]) {
    if (playing) await page.locator("#play").click();
    await page.locator("#pane-visualization").click();
    const clock = await page.locator("#clock").textContent();
    if (playing) await expect(page.locator("#clock")).not.toHaveText(clock!);
    await page.locator("#pane-visualization").click();
    await expect(page.locator("#inspector")).toBeHidden();
    await expect(page.locator("#zoom")).toHaveValue(zoom);
    expect(await page.locator("#arrangement").evaluate(element => element.scrollLeft)).toBe(scroll);
    await expect(page.locator("#analysis-source")).toHaveValue("lead");
    await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Solo lead", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.locator("#follow").click();
  await page.locator("#pane-visualization").click();
  const clock = await page.locator("#clock").textContent();
  await expect(page.locator("#clock")).not.toHaveText(clock!);
  await page.locator("#pane-visualization").click();
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zoom")).toHaveValue(zoom);
  await expect(page.locator("#revision")).toHaveText("Revision 1 accepted");
});

test("1000px splitter extremes preserve preferences and usable view tabs with or without Explorer", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  const splitter = page.locator(".splitter");
  for (const explorer of [true, false]) {
    if (!explorer) await page.locator("#pane-explorer").click();
    for (const [key, fraction] of [["End", 0.7], ["Home", 0.25]] as const) {
      await test.step(`Explorer ${explorer ? "shown" : "hidden"}, ${key}`, async () => {
        await splitter.focus();
        await page.keyboard.press(key);
        await expect(splitter).toHaveAttribute("aria-valuenow", String(fraction * 100));
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-preferences-v1")!).layout.sourceFraction)).toBe(fraction);
        const source = (await page.locator("#source-pane").boundingBox())!;
        const visual = (await page.locator("#visualization-pane").boundingBox())!;
        const available = source.width + visual.width;
        expect(visual.width).toBeGreaterThanOrEqual(359);
        expect(Math.abs(source.width - Math.min(available * fraction, available - 360))).toBeLessThanOrEqual(2);
        for (const view of ["arrangement", "routing", "patch", "automation"]) {
          const tab = page.locator(`[data-view="${view}"]`);
          await expect(tab).toBeVisible();
          const box = (await tab.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(visual.x - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(visual.x + visual.width + 1);
          expect(box.width).toBeGreaterThan(20);
          expect(box.height).toBeGreaterThan(20);
          expect(await tab.evaluate(element => {
            const box = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          })).toBe(true);
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await expectNoOverflow(page);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(splitter).toBeHidden();
        await page.setViewportSize({ width: 1000, height: 760 });
        await expect(splitter).toHaveAttribute("aria-valuenow", String(fraction * 100));
        expect(await page.locator(".workspace").evaluate(element => Number((element as HTMLElement).style.getPropertyValue("--source-fraction")))).toBe(fraction);
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-preferences-v1")!).layout.sourceFraction)).toBe(fraction);
        await expectNoOverflow(page);
      });
    }
  }
});

test("real graph noninitial page and manual pan survive hide, reveal and every theme", async ({ page }) => {
  test.setTimeout(90_000);
  // Routing buses add enough real rows for a scrollable noninitial graph page,
  // without violating the independently bounded 1000 physical-track meter budget.
  const tracks = Array.from({ length: 1000 }, (_, index) =>
    `track("lane${index}",phrase("C4:q"),synth("bell"))`);
  const buses = Array.from({ length: 100 }, (_, index) => `bus("route${index}",[])`);
  await page.addInitScript(value => localStorage.setItem("muzpad-draft-v1", JSON.stringify(value)), {
    ...project,
    files: { ...project.files, "song.muz": `song({tempo:120,tracks:[${tracks.join(",")}],buses:[${buses.join(",")}],tail:0})` },
  });
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted", { timeout: 60_000 });
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.locator('[data-view="routing"]').click();
  const graph = page.locator("#graph-view");
  const pagination = graph.locator(".bounded-pages span");
  await expect(page.locator("#graph-next")).toBeVisible();
  const initialPage = await pagination.textContent();
  await page.locator("#graph-next").click();
  await expect(page.locator("#graph-previous")).toBeVisible();
  await expect(pagination).not.toHaveText(initialPage!);
  const currentPage = (await pagination.textContent())!;
  expect(Number(currentPage.split("–")[0])).toBeGreaterThan(1);
  await expect(graph.locator(".network [data-source]").first()).toBeAttached();
  const sourceIds = await graph.locator(".network [data-source]").evaluateAll(elements => elements.map(element => element.getAttribute("data-source")));
  expect(sourceIds.length).toBeGreaterThan(1);

  // Paging controls sit below the SVG; start the gesture in visible graph content,
  // then assert that a real pointer drag moved both axes away from their origins.
  await graph.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
  const box = (await graph.boundingBox())!;
  const start = { x: box.x + Math.min(box.width - 25, 240), y: box.y + Math.min(box.height - 25, 180) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y - 100, { steps: 8 });
  await page.mouse.up();
  const navigation = await graph.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
  expect(navigation.left).toBeGreaterThan(0);
  expect(navigation.top).toBeGreaterThan(0);
  const revision = (await page.locator("#revision").textContent())!;
  const sourcePath = (await page.locator("#source-path").textContent())!;
  const expectRetainedNavigation = async () => {
    await expect(pagination).toHaveText(currentPage);
    await expect(page.locator("#graph-previous")).toBeAttached();
    expect(await graph.locator(".network [data-source]").evaluateAll(elements => elements.map(element => element.getAttribute("data-source")))).toEqual(sourceIds);
    expect(await graph.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual(navigation);
    await expect(page.locator("#revision")).toHaveText(revision);
    await expect(page.locator("#source-path")).toHaveText(sourcePath);
    await expect(page.locator('[data-view="routing"]')).toHaveAttribute("aria-selected", "true");
  };
  for (const theme of ["dark", "soft-light", "soft-dark", "light"]) {
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme);
    await page.locator("#settings-close").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectRetainedNavigation();
    await page.locator("#pane-visualization").click();
    await expect(graph).toBeHidden();
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme === "light" ? "dark" : "light");
    await page.locator("#settings-close").click();
    await page.locator("#pane-visualization").click();
    await expect(graph).toBeVisible();
    await expectRetainedNavigation();
  }
  await page.locator("#graph-previous").click();
  await expect(pagination).toHaveText(initialPage!);
});
