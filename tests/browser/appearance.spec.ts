import { test, expect, type Page } from "@playwright/test";
import { clickCommand } from "./commands";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const themes = ["light", "dark", "soft-light", "soft-dark"] as const;
const project = {
  id: "appearance", title: "Appearance", entry: "song.muz",
  files: {
    "song.muz": '// Readable comment\nlet tempo = 120;\nsong({tempo:tempo,sections:[{name:"opening",duration:64b}],tracks:[track("lead",phrase("C4:q E4:q G4:q B4:q").repeat(16),synth("bell"))],tail:0})',
    "README.md": '# Appearance guide\n\nOrdinary text and **emphasis** with [a source link](song.muz).\n\n`inline code`\n\n```muz\nlet value = 120; // comment\n```',
  },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(value => {
    try {
      if (!localStorage.getItem("muzpad-draft-v1"))
        localStorage.setItem("muzpad-draft-v1", JSON.stringify(value));
    } catch {
      // Denied-storage cases deliberately start with the real default project.
    }
  }, project);
});

// These pairs mirror the actual Arrangement.draw paint operations, including
// globalAlpha on pitched overview marks. They are not arbitrary palette swatches.
const canvasPairs = [
  { name: "arrangement track label", foreground: "--c-d0d0d0", background: "--c-080808", alpha: 1, minimum: 4.5 },
  { name: "selected track label", foreground: "--c-d0d0d0", background: "--c-181818", alpha: 1, minimum: 4.5 },
  { name: "track note count", foreground: "--text-muted", background: "--c-080808", alpha: 1, minimum: 4.5 },
  { name: "selected note count", foreground: "--text-muted", background: "--c-181818", alpha: 1, minimum: 4.5 },
  { name: "group lane count", foreground: "--text-muted", background: "--c-151515", alpha: 1, minimum: 4.5 },
  { name: "section label", foreground: "--c-c9c9c9", background: "--c-121212", alpha: 1, minimum: 4.5 },
  { name: "bar and beat labels", foreground: "--text-muted", background: "--c-080808", alpha: 1, minimum: 4.5 },
  { name: "pitched overview", foreground: "--c-fff", background: "--c-080808", alpha: 0.7, minimum: 3 },
  { name: "analysis waveform", foreground: "--c-ddd", background: "--c-080808", alpha: 1, minimum: 3 },
];

type ContrastTarget = { selector: string; kind?: "text" | "focus" | "selection" | "svg" | "border" };

async function assertContrast(page: Page, targets: ContrastTarget[], includeCanvas = false) {
  const results = await page.evaluate(({ targets, pairs }) => {
    type RGBA = [number, number, number, number];
    const context = document.createElement("canvas").getContext("2d")!;
    function parse(value: string): RGBA {
      if (!CSS.supports("color", value)) throw new Error(`Unparseable computed color: ${value}`);
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const rgba = context.getImageData(0, 0, 1, 1).data;
      return [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3] / 255];
    }
    function over(front: RGBA, back: RGBA): RGBA {
      const a = front[3] + back[3] * (1 - front[3]);
      if (!a) return [0, 0, 0, 0];
      return [0, 1, 2].map(index => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / a).concat(a) as RGBA;
    }
    function pixel(element: Element, foreground: RGBA): RGBA {
      let paint = foreground;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") throw new Error(`Contrast requires explicit gradient sampling: ${node.tagName}.${node.className}`);
        paint = over(paint, parse(style.backgroundColor));
        paint[3] *= Number(style.opacity);
      }
      // Opaque root palettes normally terminate compositing before this canvas.
      const canvas: RGBA = getComputedStyle(document.documentElement).colorScheme === "dark" ? [0, 0, 0, 1] : [1, 1, 1, 1];
      return over(paint, canvas);
    }
    function ratio(a: RGBA, b: RGBA) {
      const luminance = (color: RGBA) => color.slice(0, 3).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const first = luminance(a), second = luminance(b);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }
    const output: { name: string; ratio: number; minimum: number; foreground: RGBA; background: RGBA }[] = [];
    for (const target of targets) {
      const elements = [...document.querySelectorAll(target.selector)].filter(element => element.getClientRects().length && !(element instanceof HTMLButtonElement && element.disabled));
      if (!elements.length) throw new Error(`Contrast target has no visible samples: ${target.selector}`);
      for (const [index, element] of elements.entries()) {
        const style = getComputedStyle(element);
        const kind = target.kind ?? "text";
        let background = pixel(element, [0, 0, 0, 0]);
        let foreground = pixel(element, parse(style.color));
        const size = Number.parseFloat(style.fontSize), weight = Number.parseInt(style.fontWeight);
        let minimum = size >= 24 || (size >= 18.6667 && weight >= 700) ? 3 : 4.5;
        if (kind === "svg") {
          const rect = element.parentElement?.querySelector("rect");
          if (!rect) throw new Error("SVG label has no painted node background");
          background = pixel(element, parse(getComputedStyle(rect).fill));
          foreground = over(parse(style.fill), background);
        } else if (kind === "selection") {
          // CodeMirror paints a separate layer: syntax retains its own foreground,
          // rather than inheriting the native ::selection foreground.
          const bounds = element.getBoundingClientRect();
          const selection = [...document.querySelectorAll(".cm-selectionBackground")].find(layer => {
            const rect = layer.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left < bounds.right
              && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top;
          });
          if (!selection) throw new Error(`No real CodeMirror selection backdrop under ${element.textContent}`);
          background = pixel(selection, [0, 0, 0, 0]);
          foreground = over(parse(style.color), background);
          minimum = 4.5;
          const selectionStyle = getComputedStyle(selection);
          const adjacent = pixel(element, [0, 0, 0, 0]);
          const hasOutline = Number.parseFloat(selectionStyle.outlineWidth) > 0 && selectionStyle.outlineStyle !== "none";
          if (!hasOutline) throw new Error("Focused CodeMirror selection must retain its essential outline");
          const boundary = over(parse(selectionStyle.outlineColor), adjacent);
          output.push({ name: "selection boundary outside", ratio: ratio(boundary, adjacent), minimum: 3, foreground: boundary, background: adjacent });
          const insideBoundary = over(parse(selectionStyle.outlineColor), background);
          output.push({ name: "selection boundary inside", ratio: ratio(insideBoundary, background), minimum: 3, foreground: insideBoundary, background });
        } else if (kind === "focus" || kind === "border") {
          const color = kind === "focus" ? style.outlineColor : style.borderTopColor;
          const width = Number.parseFloat(kind === "focus" ? style.outlineWidth : style.borderTopWidth);
          if (!(width > 0)) throw new Error(`No visible ${kind} at ${target.selector}`);
          const outside = pixel(element.parentElement!, [0, 0, 0, 0]);
          const outerRing = kind === "focus" && style.boxShadow !== "none"
            ? style.boxShadow.match(/^(rgba?\([^)]*\))\s/)?.[1] : undefined;
          if (kind === "focus" && style.boxShadow !== "none" && !outerRing)
            throw new Error(`Unsupported focus shadow paint: ${style.boxShadow}`);
          const paint = over(parse(outerRing ?? color), outside);
          output.push({ name: `${target.selector}[${index}] ${kind} outside`, ratio: ratio(paint, outside), minimum: 3, foreground: paint, background: outside });
          foreground = over(parse(color), background);
          minimum = 3;
        }
        output.push({ name: `${target.selector}[${index}] ${kind}: ${element.textContent?.trim().slice(0, 45)}`, ratio: ratio(foreground, background), minimum, foreground, background });
      }
    }
    const root = getComputedStyle(document.documentElement);
    for (const pair of pairs) {
      const front = parse(root.getPropertyValue(pair.foreground).trim());
      front[3] *= pair.alpha;
      const background = pixel(document.documentElement, parse(root.getPropertyValue(pair.background).trim()));
      const foreground = over(front, background);
      output.push({ name: `canvas: ${pair.name} (${pair.foreground} @ ${pair.alpha} / ${pair.background})`, ratio: ratio(foreground, background), minimum: pair.minimum, foreground, background });
    }
    return output;
  }, { targets, pairs: includeCanvas ? canvasPairs : [] });
  await test.info().attach("computed-contrast", {
    body: JSON.stringify(results, null, 2), contentType: "application/json",
  });
  const failing = results.filter(result => result.ratio + 0.001 < result.minimum);
  expect(failing, failing.map(pair => `${pair.name}: ${pair.ratio.toFixed(3)}:1 < ${pair.minimum}:1; fg=${JSON.stringify(pair.foreground)} bg=${JSON.stringify(pair.background)}`).join("\n")).toEqual([]);
}

for (const theme of themes) {
  test(`${theme}: actual editor, Markdown, settings, graph and canvas contrast`, async ({ page }, testInfo) => {
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#theme-toggle").click();
    await expect(page.locator("#settings-theme option")).toHaveCount(4);
    await page.locator("#settings-theme").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.locator("html").evaluate(element => getComputedStyle(element).colorScheme)).toBe(theme.endsWith("dark") ? "dark" : "light");
    const themeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
    expect(await page.evaluate(color => {
      const probe = document.createElement("span");
      probe.style.color = color!;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.style.color = "var(--c-080808)";
      const base = getComputedStyle(probe).color;
      probe.remove();
      return value === base;
    }, themeColor)).toBe(true);
    await assertContrast(page, [{ selector: "#settings-dialog label" }, { selector: "#settings-dialog button" }, { selector: "#settings-theme" }, { selector: "#settings-theme", kind: "border" }]);
    await page.locator("#settings-close").click();
    await page.locator(".range-menu > summary").click();
    await assertContrast(page, [{ selector: ".range-menu label" }, { selector: ".range-menu button" }]);
    await page.locator(".range-menu > summary").click();
    await clickCommand(page, "#export-media");
    await expect(page.locator(".export-dialog")).toBeVisible();
    await assertContrast(page, [{ selector: ".export-dialog label" }, { selector: ".export-dialog button" }]);
    await page.locator("#export-close").click();
    await page.locator("#analysis-disclosure > summary").click();
    await page.locator("#toggle-inspector").click();
    await assertContrast(page, [
      { selector: "#source-path" }, { selector: "#revision" }, { selector: "[data-tab]" },
      { selector: ".view-tabs button" }, { selector: ".cm-line" }, { selector: ".cm-line span" },
      { selector: ".cm-lineNumbers .cm-gutterElement" }, { selector: "#analysis-detail" },
      { selector: "#inspector dt, #inspector dd" }, { selector: "#run" },
    ], true);
    await page.locator("#run").hover();
    await assertContrast(page, [{ selector: "#run" }]);
    await page.locator("#run").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await assertContrast(page, [{ selector: "#run", kind: "focus" }]);
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+End");
    await expect(page.locator(".cm-line").nth(0)).toHaveText("// Readable comment");
    await expect(page.locator(".cm-line").nth(1)).toHaveText("let tempo = 120;");
    await expect.poll(() => page.evaluate(() => {
      const layers = [...document.querySelectorAll(".cm-selectionBackground")].map(layer => layer.getBoundingClientRect());
      return [...document.querySelectorAll(".cm-line")].slice(0, 2).every(line => {
        const bounds = line.getBoundingClientRect();
        return layers.some(rect => rect.width > 0 && rect.height > 0 && rect.left < bounds.right
          && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top);
      });
    })).toBe(true);
    await assertContrast(page, [
      { selector: ".cm-line:first-child span", kind: "selection" },
      { selector: ".cm-line:nth-child(2)", kind: "selection" },
      { selector: ".cm-line:nth-child(2) span", kind: "selection" },
    ]);
    await page.locator('[data-kind="project"][data-file="README.md"]').click();
    await assertContrast(page, [{ selector: "#document p" }, { selector: "#document a" }, { selector: "#document code" }, { selector: "[data-tab]" }]);
    await page.locator('[data-view="routing"]').click();
    await expect(page.locator(".network")).toBeVisible();
    await assertContrast(page, [{ selector: ".network text", kind: "svg" }]);
    await testInfo.attach(`${theme}-workbench`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.locator('[data-tab="project:song.muz"]').click();
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.insertText("unknown_symbol();\n");
    await page.locator("#run").click();
    await expect(page.locator("#build-state")).toHaveText("Build failed");
    await assertContrast(page, [{ selector: "#workflow-status .action-status" }, { selector: "#workflow-status [data-open-error]" }, { selector: "#build-state" }]);
  });

  test(`${theme}: theme and layout persist without entering project archives`, async ({ page }) => {
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    const revision = await page.locator("#revision").textContent();
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme);
    await page.locator('[data-preference="explorer"]').uncheck();
    await page.locator('[data-preference="inspector"]').uncheck();
    await page.locator("#settings-close").click();
    await expect(page.locator("#revision")).toHaveText(revision!);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"))).toContain(theme);
    const downloadEvent = page.waitForEvent("download");
    await clickCommand(page, "#download");
    const archive = unzipSync(new Uint8Array(await readFile((await (await downloadEvent).path())!)));
    expect(Object.keys(archive).sort()).toEqual(["README.md", "muzpad.json", "song.muz"]);
    const settings = JSON.parse(new TextDecoder().decode(archive["muzpad.json"]));
    expect(settings).not.toHaveProperty("theme");
    expect(settings).not.toHaveProperty("layout");
    expect(settings).not.toHaveProperty("preferences");
    expect(new TextDecoder().decode(archive["song.muz"])).toBe(project.files["song.muz"]);
    await page.reload();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#explorer-pane")).toBeHidden();
    await expect(page.locator("#inspector")).toBeHidden();
    await clickCommand(page, "#new-project");
    await expect(page.locator("#project-title")).toHaveText("Untitled project");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#explorer-pane")).toBeHidden();
  });
}

for (const theme of ["light", "dark"]) for (const inspector of ["open", "closed"]) {
  test(`migrates legacy ${theme}/${inspector}`, async ({ page }) => {
    await page.addInitScript(({ theme, inspector }) => {
      localStorage.setItem("muzpad-theme", theme);
      localStorage.setItem("muzpad-inspector", inspector);
    }, { theme, inspector });
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#pane-inspector")).toHaveAttribute("aria-expanded", String(inspector === "open"));
    await expect.poll(() => page.evaluate(() => localStorage.getItem("muzpad-preferences-v1"))).toContain(theme);
    expect(await page.evaluate(() => [localStorage.getItem("muzpad-theme"), localStorage.getItem("muzpad-inspector")])).toEqual([null, null]);
  });
}

test("settings traps focus, leaves checkbox focus intact, escapes safely and saves newest rapid change", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#theme-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#settings-dialog")).toBeVisible();
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press(index < 8 ? "Tab" : "Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("#settings-dialog"))).toBe(true);
  }
  await page.locator('[data-preference="source"]').uncheck();
  await expect(page.locator('[data-preference="source"]')).toBeFocused();
  for (const theme of [...themes, "light", "soft-dark"])
    await page.locator("#settings-theme").selectOption(theme);
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#theme-toggle")).toBeFocused();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muzpad-preferences-v1")!).theme)).toBe("soft-dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "soft-dark");
  await expect(page.locator("#source-pane")).toBeHidden();
});

test("queued Settings close respects newer editor focus and source cursor", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#theme-toggle").click();
  const retainedFocus = await page.evaluate(() => new Promise<boolean>(resolve => {
    const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    dialog.addEventListener("close", () => {
      requestAnimationFrame(() => resolve(document.activeElement === content));
    }, { once: true });
    document.querySelector<HTMLButtonElement>("#settings-close")!.click();
    content.focus();
  }));
  expect(retainedFocus).toBe(true);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// closing settings preserves the source cursor");
  await expect(page.locator(".cm-line").last()).toHaveText("// closing settings preserves the source cursor");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#revision")).toHaveText(/Revision 2 accepted/i);
});

test("theme changes redraw idle and hidden visualization without resetting graph navigation or undo", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const canvas = page.locator("#arrangement canvas");
  const initial = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// theme retains undo");
  const revision = await page.locator("#revision").textContent();
  await page.locator("#theme-toggle").click();
  await page.locator("#settings-theme").selectOption("dark");
  await page.locator("#settings-close").click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(initial);
  await page.locator('[data-view="routing"]').click();
  const network = await page.locator(".network").elementHandle();
  await page.locator("#play").click();
  await clickCommand(page, "#pane-visualization");
  for (const theme of themes) {
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption(theme);
    await page.locator("#settings-close").click();
  }
  await clickCommand(page, "#pane-visualization");
  expect(await network!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.locator(".network")).toBeVisible();
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await expect(page.locator("#revision")).toHaveText(revision!);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).not.toContainText("theme retains undo");
});

for (const failure of ["getter", "setter"]) {
  test(`denied storage ${failure} remains nonblocking`, async ({ page }) => {
    await page.addInitScript(({ project, failure }) => {
      localStorage.setItem("muzpad-draft-v1", JSON.stringify(project));
      if (failure === "getter") {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Denied", "SecurityError"); } });
      } else {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "muzpad-preferences-v1") throw new DOMException("Denied", "QuotaExceededError");
          original.call(this, key, value);
        };
      }
    }, { project, failure });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#theme-toggle").click();
    await page.locator("#settings-theme").selectOption("soft-dark");
    await expect(page.locator("#preferences-status")).toContainText("Preferences are temporary");
    await page.locator("#settings-close").click();
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n// editing remains available");
    await expect(page.locator(".cm-line").last()).toHaveText("// editing remains available");
    await page.locator("#run").click();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "soft-dark");
    if (failure === "getter") {
      await expect(page.locator("#recovery-status")).toContainText("Recovery unavailable");
      await expect(page.locator("#build-state")).toHaveText("Accepted");
      await expect(page.locator("#revision")).toHaveText(/Revision 2 accepted/i);
      await expect(page.locator("#diagnostic-list")).toBeEmpty();
      await page.locator(".cm-content").focus();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText("song({ tracks: [missing()] })");
      await page.locator("#run").click();
      await expect(page.locator("#workflow-status")).toContainText("unknown function 'missing'");
      await expect(page.locator("#recovery-status")).toContainText("Recovery unavailable");
      await expect(page.locator("#build-state")).toHaveText("Build failed");
      await expect(page.locator("#build-detail")).toContainText("Previous accepted music remains loaded");
      for (const theme of themes) {
        await page.locator("#theme-toggle").click();
        await page.locator("#settings-theme").selectOption(theme);
        await page.locator("#settings-close").click();
        await assertContrast(page, [{ selector: "#recovery-status" }]);
        await expect(page.locator("#build-state")).toHaveText("Build failed");
        await expect(page.locator("#workflow-status")).toContainText("unknown function 'missing'");
      }
      await page.locator("[data-open-error]").first().click();
      await expect(page.locator(".cm-content")).toBeFocused();
      await expect(page.locator("#source-path")).toHaveText("song.muz");
    }
    expect(errors).toEqual([]);
  });
}

test("fresh absent preferences allocate a source majority with optional Inspector closed before any reset", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("muzpad-preferences-v1");
    localStorage.removeItem("muzpad-theme");
    localStorage.removeItem("muzpad-inspector");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const source = (await page.locator("#source-pane").boundingBox())!;
  const music = (await page.locator("#visualization-pane").boundingBox())!;
  expect(source.width).toBeGreaterThan(music.width);
  expect(source.width).toBeGreaterThan(0);
  expect(music.width).toBeGreaterThan(0);
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(page.locator("#pane-inspector")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#theme-toggle").click();
  await expect(page.locator('[data-preference="inspector"]')).not.toBeChecked();
  await page.locator("#settings-close").click();
});

