import { test, expect, type Locator, type Page } from "@playwright/test";
import { clickCommand } from "./commands";

const project = {
  id: "layout-project", title: "Layout project", entry: "song.muz",
  files: {
    "song.muz": 'song({tempo:120,sections:[{name:"loop",duration:128b}],tracks:[track("lead",phrase("C4:q E4:q G4:q B4:q").repeat(32),synth("bell"))],tail:0})',
    "README.md": "# Layout guide\n\n" + Array.from({ length: 80 }, (_, index) => `Documentation paragraph ${index + 1}: source, music and saved layout remain independent.`).join("\n\n"),
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

test("desktop grouped commands dismiss their overlay without taking focus from an opened dialog", async ({ page }) => {
  await clickCommand(page, "#pane-inspector");
  await expect(page.locator("#inspector")).toBeVisible();
  await expect(page.locator("#pane-inspector")).toBeHidden();
  await page.locator("#follow").click();
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "false");
  await clickCommand(page, "#export-media");
  await expect(page.locator(".export-dialog")).toBeVisible();
  await expect(page.locator("#export-media")).toBeHidden();
  expect(await page.locator(".export-dialog").evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  await page.locator("#export-close").click();
  await clickCommand(page, "#new-project");
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#new-project")).toBeHidden();
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

test("short viewport failed action announcements do not extend the document beyond the allocated panes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("undefined_song");
  await page.locator("#run").click();
  await expect(page.locator(".action-status").filter({ hasText: /Rebuild · (failed|rejected)/ })).toBeVisible();
  const geometry = await page.evaluate(() => ({
    height: innerHeight, document: document.documentElement.scrollHeight,
    body: document.body.scrollHeight, app: document.getElementById("app")!.scrollHeight,
  }));
  expect(geometry.document, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.body, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.app, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.height + 1);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
});

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const geometry = await control.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    let left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
    let top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, rect.left); right = Math.min(right, rect.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
      }
    }
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return { width: right - left, height: bottom - top, hit: hit === element || !!hit && element.contains(hit) };
  });
  expect(geometry.width, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.height, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.hit, JSON.stringify(geometry)).toBe(true);
}

async function tabTo(page: Page, control: Locator) {
  for (let step = 0; step < 100; step++) {
    if (await control.evaluate(element => element === document.activeElement || element.contains(document.activeElement))) {
      await expectReachable(control);
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

async function expectAllocated(pane: Locator) {
  await expect(pane).toBeVisible();
  const bounds = (await pane.boundingBox())!;
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
}

for (const viewport of [
  { width: 1440, height: 1000 }, { width: 1280, height: 800 },
  { width: 1024, height: 768 }, { width: 1000, height: 420 },
]) {
  test(`desktop pane restore and compact chrome at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const pane of panes) {
      const command = page.locator(`#pane-${pane}`);
      await expect(command).toHaveAttribute("aria-controls", paneSelector(pane).slice(1));
      if (await command.getAttribute("aria-expanded") !== "true") await clickCommand(page, `#pane-${pane}`);
      await clickCommand(page, `#pane-${pane}`);
      await expect(page.locator(paneSelector(pane))).toBeHidden();
      await expect(command).toHaveAttribute("aria-expanded", "false");
      await clickCommand(page, `#pane-${pane}`);
      await expect(page.locator(paneSelector(pane))).toBeVisible();
      await expect(command).toHaveAttribute("aria-expanded", "true");
      await expectNoOverflow(page);
    }
    for (const inspector of [false, true]) {
      if (await page.locator("#pane-inspector").getAttribute("aria-expanded") !== String(inspector))
        await clickCommand(page, "#pane-inspector");
      for (let mask = 0; mask < 8; mask++) {
        const visible = { explorer: !!(mask & 1), source: !!(mask & 2), visualization: !!(mask & 4) };
        for (const pane of ["explorer", "source", "visualization"] as const)
          if (await page.locator(`#pane-${pane}`).getAttribute("aria-expanded") !== String(visible[pane]))
            await clickCommand(page, `#pane-${pane}`);
        for (const pane of panes) {
          const effective = pane === "inspector" ? inspector && visible.visualization : visible[pane];
          await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-expanded", String(effective));
          if (effective) await expect(page.locator(paneSelector(pane))).toBeVisible();
          else await expect(page.locator(paneSelector(pane))).toBeHidden();
        }
        await expectNoOverflow(page);
      }
    }
    await clickCommand(page, "#view-reset-layout");
    await expect(page.locator("#inspector")).toBeHidden();
    await expect(page.locator(".splitter")).toHaveAttribute("aria-valuenow", "60");
    const header = (await page.locator(".topbar").boundingBox())!;
    const transport = (await page.locator(".transport").boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(48);
    expect(transport.height).toBeLessThanOrEqual(44);
    for (const selector of ["#play", "#run", "#theme-toggle"]) await expect(page.locator(selector)).toBeVisible();
  });
}

for (const viewport of [{ width: 800, height: 600 }, { width: 390, height: 844 }, { width: 390, height: 420 }]) {
  test(`narrow single surface and Explorer drawer preserve editing at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await expect(page.locator("#source-pane")).toBeVisible();
    await expect(page.locator("#visualization-pane")).toBeHidden();
    await expect(page.locator("#explorer-pane")).toBeHidden();
    const desktopLayout = await page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"));
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" // retained buffer");
    const text = await page.locator(".cm-content").innerText();
    await page.locator("#surface-music").click();
    await expect(page.locator("#source-pane")).toBeHidden();
    await expect(page.locator("#visualization-pane")).toBeVisible();
    await page.locator("#surface-source").click();
    await expect(page.locator(".cm-content")).toHaveText(text);
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Control+z");
    await expect(page.locator(".cm-content")).not.toContainText("retained buffer");
    await page.locator("#explorer-drawer").click();
    await expect(page.locator("#file-search")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#explorer-pane")).toBeHidden();
    await expect(page.locator("#explorer-drawer")).toBeFocused();
    await page.locator("#explorer-drawer").click();
    await page.locator('[data-kind="project"][data-file="README.md"]').click();
    await expect(page.locator("#document h1")).toHaveText("Layout guide");
    await expect(page.locator("#explorer-pane")).toBeHidden();
    await expect(page.locator("#source-pane")).toBeVisible();
    for (const selector of ["#play", "#run", "#theme-toggle", "#surface-source", "#surface-music"]) await expect(page.locator(selector)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height + 1);
    await expectNoOverflow(page);
    // Responsive surfaces never replace the saved desktop layout.
    expect(await page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"))).toBe(desktopLayout);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator("#source-pane")).toBeVisible();
    await expect(page.locator("#visualization-pane")).toBeVisible();
    await expect(page.locator("#explorer-pane")).toBeVisible();
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
  await clickCommand(page, "#pane-explorer");
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
  await clickCommand(page, "#pane-explorer");
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
    await clickCommand(page, `#pane-${pane}`);
    await expect(splitter).toBeHidden();
    await clickCommand(page, `#pane-${pane}`);
  }
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
  for (const pane of ["explorer", "source", "visualization"] as const) await expect(page.locator(paneSelector(pane))).toBeVisible();
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(splitter).toHaveAttribute("aria-valuenow", "60");
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
  await page.locator("#analysis-disclosure > summary").click();
  await page.locator("#analysis-source").selectOption("lead");
  await expect(page.locator("#scope")).toBeVisible();
  const scroll = await page.locator("#arrangement").evaluate(element => element.scrollLeft);
  const zoom = await page.locator("#zoom").inputValue();
  for (const playing of [false, true]) {
    if (playing) await page.locator("#play").click();
    await clickCommand(page, "#pane-visualization");
    const clock = await page.locator("#clock").textContent();
    if (playing) await expect(page.locator("#clock")).not.toHaveText(clock!);
    await clickCommand(page, "#pane-visualization");
    await expect(page.locator("#inspector")).toBeHidden();
    await expect(page.locator("#zoom")).toHaveValue(zoom);
    expect(await page.locator("#arrangement").evaluate(element => element.scrollLeft)).toBe(scroll);
    await expect(page.locator("#analysis-source")).toHaveValue("lead");
    await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Solo lead", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.locator("#follow").click();
  await clickCommand(page, "#pane-visualization");
  const clock = await page.locator("#clock").textContent();
  await expect(page.locator("#clock")).not.toHaveText(clock!);
  await clickCommand(page, "#pane-visualization");
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#zoom")).toHaveValue(zoom);
  await expect(page.locator("#revision")).toHaveText("Revision 1 accepted");
});

test("1000px splitter extremes preserve preferences and usable view tabs with or without Explorer", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  const splitter = page.locator(".splitter");
  for (const explorer of [true, false]) {
    if (!explorer) await clickCommand(page, "#pane-explorer");
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
    await clickCommand(page, "#pane-visualization");
    await expect(graph).toBeHidden();
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme === "light" ? "dark" : "light");
    await page.locator("#settings-close").click();
    await clickCommand(page, "#pane-visualization");
    await expect(graph).toBeVisible();
    await expectRetainedNavigation();
  }
  await page.locator("#graph-previous").click();
  await expect(pagination).toHaveText(initialPage!);
});

for (const width of [800, 390]) for (let mask = 0; mask < 8; mask++) {
  test(`saved desktop mask ${mask} cannot suppress narrow surfaces at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".splitter").focus();
    await page.keyboard.press("ArrowLeft");
    const visibility = { explorer: !!(mask & 1), source: !!(mask & 2), visualization: !!(mask & 4) };
    for (const pane of ["explorer", "source", "visualization"] as const)
      if (await page.locator(`#pane-${pane}`).getAttribute("aria-expanded") !== String(visibility[pane]))
        await clickCommand(page, `#pane-${pane}`);
    const preferredFraction = await page.locator(".workspace").evaluate(element => Number((element as HTMLElement).style.getPropertyValue("--source-fraction")));
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-preferences-v1")!).layout)).toMatchObject({
      ...visibility, sourceFraction: preferredFraction,
    });
    const saved = await page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"));
    const fraction = await page.locator(".workspace").evaluate(element => (element as HTMLElement).style.getPropertyValue("--source-fraction"));
    await page.setViewportSize({ width, height: 600 });
    await page.locator("#surface-source").focus();
    await page.keyboard.press("Enter");
    await expectAllocated(page.locator("#source-pane"));
    await expect(page.locator(".cm-content")).toBeFocused();
    await expectReachable(page.locator(".cm-content"));
    await page.locator("#surface-music").focus();
    await page.keyboard.press("Enter");
    await expectAllocated(page.locator("#visualization-pane"));
    await expect(page.locator('[data-view="arrangement"]')).toBeFocused();
    await expectReachable(page.locator('[data-view="arrangement"]'));
    await page.locator("#explorer-drawer").click();
    await expectAllocated(page.locator("#explorer-pane"));
    await expect(page.locator("#file-search")).toBeFocused();
    await expectReachable(page.locator("#file-search"));
    await page.keyboard.press("Escape");
    await expect(page.locator("#explorer-drawer")).toBeFocused();
    await page.locator("#surface-source").click();
    await expectAllocated(page.locator("#source-pane"));
    await expectNoOverflow(page);
    expect(await page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"))).toBe(saved);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const pane of ["explorer", "source", "visualization"] as const) {
      await expect(page.locator(`#pane-${pane}`)).toHaveAttribute("aria-expanded", String(visibility[pane]));
      if (visibility[pane]) await expectAllocated(page.locator(paneSelector(pane)));
      else await expect(page.locator(paneSelector(pane))).toBeHidden();
    }
    expect(await page.locator(".workspace").evaluate(element => (element as HTMLElement).style.getPropertyValue("--source-fraction"))).toBe(fraction);
    expect(await page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"))).toBe(saved);
  });
}

test("short desktop 1000x420 details remain reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 420 });
    await page.locator("#toggle-inspector").scrollIntoViewIfNeeded();
    await expectReachable(page.locator("#toggle-inspector"));
    await page.locator("#toggle-inspector").click();
    await expectAllocated(page.locator("#inspector"));
    const summary = page.locator("#analysis-disclosure > summary");
    await expectReachable(summary);
    await summary.click();
    await expect(page.locator("#analysis-disclosure")).toHaveAttribute("open", "");
    await expectReachable(page.locator("#analysis-source"));
    await page.locator("#analysis-source").selectOption("lead");
    await expect(page.locator("#analysis-source")).toHaveValue("lead");
    await expectReachable(page.locator("#scope"));
    await expectReachable(page.locator("#spectrum"));
    const music = page.locator("#visualization-pane");
    const allocated = (await music.boundingBox())!;
    expect(allocated.height).toBeLessThanOrEqual(420);
    await summary.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await tabTo(page, page.locator("#analysis-source"));
    await page.keyboard.press("Home");
    await expect(page.locator("#analysis-source")).toHaveValue("");
    await expectReachable(page.locator("#jump-source"));
    await page.locator("#jump-source").click();
    await expectReachable(page.locator("#entry-select"));
    await page.locator("#entry-select").selectOption("song.muz");
    await expectReachable(page.locator(".cm-content"));
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(" // short viewport editing");
    await expect(page.locator(".cm-content")).toContainText("short viewport editing");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".cm-content")).not.toContainText("short viewport editing");
    await expectNoOverflow(page);
  });

test("playing desktop loop can be disabled and Panic invoked from the real narrow disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#loop").click();
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  const oldLoop = await page.locator(".action-status").filter({ hasText: "Set loop · applied" }).getAttribute("data-action-request");
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await page.setViewportSize({ width: 390, height: 420 });
  const more = page.locator("#transport-overflow > summary");
  await expect(page.locator("#transport-overflow")).not.toHaveAttribute("open", "");
  await more.click();
  await expectReachable(page.locator("#loop"));
  await page.locator("#loop").click();
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#status-details > summary").click();
  const loopReceipt = page.locator(".action-status").filter({ hasText: "Set loop · applied" });
  await expect(loopReceipt).not.toHaveAttribute("data-action-request", oldLoop!);
  await loopReceipt.locator("details > summary").click();
  const actualLoop = JSON.parse((await loopReceipt.locator("pre").textContent())!);
  expect(actualLoop.command).toEqual({ kind: "loop", range: null });
  expect(actualLoop.observed).toMatchObject({ playing: true, loop: null });
  expect(actualLoop.appliedRef).toEqual(actualLoop.requestedRef);
  expect(actualLoop.requestId).toBe(await loopReceipt.getAttribute("data-action-request"));
  expect(actualLoop.appliedRef).toMatchObject({ entry: "song.muz" });
  for (const key of ["project", "epoch", "engineEpoch"])
    expect(actualLoop.appliedRef[key]).toEqual(expect.any(String));
  expect(actualLoop.sequence).toMatch(/^\d+$/);
  expect(actualLoop.generation).toMatch(/^\d+$/);
  await page.setViewportSize({ width: 390, height: 420 });
  await more.focus();
  await page.keyboard.press("Enter");
  await tabTo(page, page.locator("#panic"));
  await page.keyboard.press("Enter");
  await expect(page.locator("#workflow-announcement")).toContainText("Panic: applied");
  await page.setViewportSize({ width: 1440, height: 900 });
  const panicReceipt = page.locator(".action-status").filter({ hasText: "Panic · applied" });
  await panicReceipt.locator("details > summary").click();
  const actualPanic = JSON.parse((await panicReceipt.locator("pre").textContent())!);
  expect(actualPanic.command).toEqual({ kind: "panic" });
  expect(actualPanic.appliedRef).toEqual(actualPanic.requestedRef);
  expect(actualPanic.appliedRef).toEqual(actualLoop.appliedRef);
  expect(actualPanic.requestId).toBe(await panicReceipt.getAttribute("data-action-request"));
  expect(actualPanic.generation).toMatch(/^\d+$/);
  expect(actualPanic.sequence).toMatch(/^\d+$/);
  expect(BigInt(actualPanic.generation) > BigInt(actualLoop.generation)
    || actualPanic.generation === actualLoop.generation && BigInt(actualPanic.sequence) > BigInt(actualLoop.sequence)).toBe(true);
  expect(actualPanic.observed.loop).toBeNull();
});


test("real indentation folds preserve dirty source, selection, scroll and undo across themes, panes and tabs", async ({ page }) => {
  const source = 'song({\n\ttempo:120,\n\ttracks:[\n\t\ttrack("lead",phrase("C4:q"),synth("bell"))\n\t],\n\n\ttail:0\n})\n'
    + Array.from({ length: 140 }, (_, index) => `// source scroll line ${index}`).join("\n");
  await page.addInitScript(value => localStorage.setItem("muzpad-draft-v1", JSON.stringify(value)), {
    ...project, files: { ...project.files, "song.muz": source },
  });
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// retained fold edit");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.locator('.cm-foldGutter [title="Fold line"]').first().click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  const scroller = page.locator(".cm-scroller");
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const wheelTarget = await scroller.evaluate(element => Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 220));
  await page.mouse.wheel(0, 220);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(wheelTarget);
  const scroll = await scroller.evaluate(element => element.scrollTop);
  for (const theme of ["dark", "soft-light", "soft-dark", "light"]) {
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme);
    await page.locator("#settings-close").click();
    await clickCommand(page, "#pane-source");
    await clickCommand(page, "#pane-source");
    await page.locator('[data-kind="project"][data-file="README.md"]').click();
    await page.locator('[data-tab="project:song.muz"]').click();
    await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scroll);
  }
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scroll);
  const currentBox = (await scroller.boundingBox())!;
  await page.mouse.move(currentBox.x + currentBox.width / 2, currentBox.y + currentBox.height / 2);
  await page.mouse.wheel(0, -scroll);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
  await page.locator(".cm-content").evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("song({");
  await page.keyboard.press("Control+Shift+BracketRight");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+BracketLeft");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.keyboard.press("Control+End");
  await expect(page.locator(".cm-content")).toContainText("retained fold edit");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".cm-content")).not.toContainText("retained fold edit");
});

test("manual arrangement pan survives themes and hidden panes", async ({ page }) => {
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  await page.locator("#follow").click();
  await page.locator("#arrangement").evaluate(element => { element.scrollLeft = 627; });
  await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
  await expect.poll(() => page.locator("#arrangement").evaluate(element => element.scrollLeft)).toBe(627);
  await page.locator("#loop").click();
  await page.locator("#play").click();
  for (const theme of ["dark", "soft-light", "soft-dark", "light"]) {
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme);
    await page.locator("#settings-close").click();
    await clickCommand(page, "#pane-visualization");
    await clickCommand(page, "#pane-visualization");
    await expect.poll(() => page.locator("#arrangement").evaluate(element => element.scrollLeft)).toBe(627);
  }
  await expect(page.locator("#arrangement")).toHaveAttribute("data-inspection-state", "ready");
  await expect.poll(() => page.locator("#arrangement").evaluate(element => element.scrollLeft)).toBe(627);
  await expect(page.locator("#zoom")).toHaveValue("3");
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#play")).toContainText("Pause");
  await expect(page.locator("#revision")).toHaveText("Revision 1 accepted");
});
