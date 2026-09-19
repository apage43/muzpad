import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
const fixture = {
  id: "browser-project",
  title: "Browser project",
  entry: "song.muz",
  files: {
    "song.muz": 'use "production.muz" as p; p.main',
    "production.muz": `use "std/synthesis" as s;
let main = song({title: "Browser project", tempo: 120,
  sections: [{name: "opening", duration: 8b}, {name: "answer", duration: 8b}],
  tracks: [track("lead", phrase("C4:q E4:q G4:q B4:q").repeat(4), s.pluck())],
  automation: [{target: "lead.out", curve: curve([[0b, -6], [8b, 0], [16b, -6]], "smooth")}],
  tail: 0.1});`,
  },
};
const countWorkers = async (page: any) =>
  page.evaluate(
    () =>
      (window as any).__muzpadWorkers.filter((url: string) =>
        url.includes("render.worker"),
      ).length,
  );
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__muzpadWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        (window as any).__muzpadWorkers.push(String(url));
        super(url, options);
      }
    };
  });
  await page.addInitScript((value) => {
    if (!localStorage.getItem("muzpad-draft-v1"))
      localStorage.setItem("muzpad-draft-v1", JSON.stringify(value));
  }, fixture);
});

test("Ctrl+Enter rebuilds without inserting a line", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const rendererWorkers = await countWorkers(page);
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await expect(page.locator("#revision")).toContainText("Edited");
  const lines = await page.locator(".cm-line").count();

  await page.keyboard.press("Control+Enter");

  await expect(page.locator("#revision")).toHaveText("Revision 2 accepted");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await expect(page.locator(".cm-line")).toHaveCount(lines);
  await page.locator("#revision-effects summary").click();
  await expect(page.locator("#diff-category")).toBeVisible();
  await expect(page.locator("#diff-page pre")).toBeVisible();
});

test("cancel keeps the accepted renderer and inspection revision", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const rendererWorkers = await countWorkers(page);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await page.locator("#run").click();
  await page.locator("#cancel").dispatchEvent("click");
  await expect(page.locator("#build-state")).toHaveText("Cancelled");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await page.locator('[data-view="routing"]').click();
  await expect(page.locator(".network")).toBeVisible();
});

test("folder MIDI assets survive compilation and ZIP export", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "muzpad-assets-"));
  try {
    await mkdir(join(dir, "assets"));
    await writeFile(
      join(dir, "song.muz"),
      'song({tracks:[track("midi",midi("assets/part.mid"),synth("bell"))],tail:0})',
    );
    await writeFile(
      join(dir, "assets", "part.mid"),
      Buffer.from(
        "4d546864000000060000000101e04d54726b0000000d00903c648360803c0000ff2f00",
        "hex",
      ),
    );
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#folder-input").setInputFiles(dir);
    await expect(page.locator("#project-title")).toHaveText(
      dir.split("/").at(-1)!,
    );
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#build-detail")).toContainText("1 tracks");
    await page.reload();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#project-title")).toHaveText(
      dir.split("/").at(-1)!,
    );
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#download").click();
    const download = await downloadEvent;
    const archivePath = await download.path();
    expect(archivePath).toBeTruthy();
    const archive = unzipSync(new Uint8Array(await readFile(archivePath!)));
    expect(Buffer.from(archive["assets/part.mid"]).toString("hex")).toBe(
      "4d546864000000060000000101e04d54726b0000000d00903c648360803c0000ff2f00",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static deployment: playback, rejected edits, source navigation, views, and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const rendererWorkers = await countWorkers(page);
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  await page.locator("#play").click();
  await expect(page.locator("#clock")).not.toHaveText("0:00", {
    timeout: 8000,
  });
  await expect(page.locator("#audio-health")).toHaveText("Audio running");
  // Break an imported source while accepted playback continues.
  await page.locator('[data-file="production.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("bad_symbol();\n");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Needs attention");
  await expect(page.locator("#diagnostic-list")).toContainText("bad_symbol");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await page.locator("[data-diagnostic]").click();
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  // Undo and recompile without losing the accepted snapshot.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Backspace");
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  expect(await countWorkers(page)).toBe(rendererWorkers);
  await page.locator("#play").click();
  await page.locator("#section").selectOption("1");
  await expect(page.locator("#clock")).toHaveText("0:04");
  await page.locator("#loop").click();
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-view="routing"]').click();
  await expect(page.locator(".network")).toBeVisible();
  await page.locator(".network [data-source]").first().click();
  await expect(page.locator("#source-path")).not.toHaveText("song.muz");
  await page.locator('[data-view="patch"]').click();
  await expect(page.locator(".network rect").first()).toBeVisible();
  await page.locator('[data-view="automation"]').click();
  await expect(page.locator(".automation-lane").first()).toBeVisible();
  // All interface typography is proportional, including the editor gutters.
  for (const selector of [
    ".brand",
    "#clock",
    ".file",
    ".view-tabs button",
    "#source-path",
    ".cm-gutters",
  ]) {
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).not.toMatch(/mono|Consolas|Courier/i);
  }
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("browser-project.zip");
  const archivePath = await download.path();
  await page.locator("#new-project").click();
  await page.locator("#zip-input").setInputFiles(archivePath!);
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  expect(errors).toEqual([]);
});

test("new project, local draft recovery, and switchable paper theme", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#new-project").click();
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#build-detail")).toContainText("1 tracks");
  await page.reload();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#project-title")).toHaveText("Untitled project");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("folder import retains relative modules and switches the entry file", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "muzpad-import-"));
  try {
    await writeFile(join(dir, "song.muz"), fixture.files["song.muz"]);
    await writeFile(
      join(dir, "production.muz"),
      fixture.files["production.muz"],
    );
    await page.goto("./");
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#folder-input").setInputFiles(dir);
    await expect(page.locator('[data-file="production.muz"]')).toBeVisible();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator('[data-file="production.muz"]').click();
    await page.locator("#set-entry").click();
    await expect(page.locator("#entry-notice")).toHaveText(
      "Rebuild to use production.muz · song.muz is still active",
    );
    await expect(page.locator("#entry-label")).toHaveText(
      "Active entry: song.muz",
    );
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await page.locator("#run").click();
    await expect(page.locator("#build-state")).toHaveText("Accepted");
    await expect(page.locator("#entry-label")).toHaveText(
      "Entry: production.muz",
    );
    await expect(page.locator("#entry-notice")).toBeHidden();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("arrangement navigation stays usable at deep zoom and follows only when enabled", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  const viewport = page.locator("#arrangement");
  const canvas = viewport.locator("canvas");
  // A 512× timeline must not allocate a 512× bitmap.
  await page.locator("#zoom").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#zoom-value")).toHaveText("512×");
  const bounds = await viewport.boundingBox();
  const geometry = await viewport.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    bitmap: el.querySelector("canvas")!.width,
    ratio: devicePixelRatio,
  }));
  expect(geometry.scroll).toBeGreaterThan(geometry.width * 200);
  expect(geometry.bitmap).toBeLessThanOrEqual(
    Math.ceil(geometry.width * Math.min(2, geometry.ratio)),
  );
  // The ruler canvas stays at the viewport origin, even far into the timeline.
  expect(Math.abs((await canvas.boundingBox())!.x - bounds!.x)).toBeLessThan(2);
  const anchorX = 260;
  const fraction = () =>
    viewport.evaluate(
      (el, x) => (el.scrollLeft + x - 130) / (el.scrollWidth - 142),
      anchorX,
    );
  const before = await fraction();
  await page.mouse.move(bounds!.x + anchorX, bounds!.y + 110);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 90);
  await page.keyboard.up("Control");
  await expect.poll(fraction).toBeCloseTo(before, 4);
  await expect(page.locator("#zoom-value")).not.toHaveText("512×");
  // Follow reveals the playhead as audio advances, then yields to an intentional drag.
  await page.locator("#follow").click(); // off
  await page.locator("#follow").click(); // on; center the initial playhead
  await page.locator("#play").click();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(100);
  await page.mouse.move(bounds!.x + 330, bounds!.y + 110);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 380, bounds!.y + 110, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#follow")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const panned = await viewport.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(160);
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBe(panned);
  await page.locator("#follow").click();
  await expect(page.locator("#follow")).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollLeft))
    .not.toBe(panned);
  await page.locator("#play").click();
  await page.locator("#zoom-fit").click();
  await expect(page.locator("#zoom-value")).toHaveText("1×");
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBe(0);
  // Panning didn't turn a drag into a seek; ordinary ruler clicks still seek.
  const fitted = await viewport.evaluate((el) => el.clientWidth);
  await canvas.click({ position: { x: 130 + (fitted - 142) * 0.51, y: 43 } });
  await expect(page.locator("#clock")).toHaveText("0:04");
  await page.locator("#zoom").fill("4");
  await page.locator("#zoom").dispatchEvent("input");
  await viewport.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect(viewport).toHaveAttribute("data-inspection-state", "detail");
  await canvas.click({
    position: { x: 135, y: 70 },
  });
  await expect(page.locator("#selection-label")).toContainText("C4");
});

test("Markdown renders safely with local navigation", async ({ page }) => {
  await page.addInitScript((base) => {
    localStorage.setItem(
      "muzpad-draft-v1",
      JSON.stringify({
        ...base,
        files: {
          ...base.files,
          "README.md": `# Project guide

Read the **instructions**, then [continue](notes/guide.md#examples) or [open source](production.muz#L2).

| Control | Meaning |
| --- | --- |
| Play | Start music |

- First item
- Second item

\`\`\`muz
let note = phrase("C4:q");
\`\`\`

<script>window.markdownExecuted = true</script>
<img src=x onerror="window.markdownExecuted = true">
<a href="javascript:window.markdownExecuted=true">unsafe link</a>
<div id="run" style="position:fixed">Plain content</div>`,
          "notes/guide.md": `# Further reading\n\n[Back](../README.md)\n\n${"A paragraph.\n\n".repeat(60)}## Examples\n\nThe destination.`,
        },
      }),
    );
  }, fixture);
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator('[data-file="README.md"][data-kind="project"]').click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#format")).toBeDisabled();
  const doc = page.locator("#document");
  await expect(doc.locator("h1")).toHaveText("Project guide");
  await expect(doc.locator("strong")).toHaveText("instructions");
  await expect(doc.locator("table tbody td")).toHaveCount(2);
  await expect(doc.locator("ul li")).toHaveCount(2);
  await expect(doc.locator("pre code")).toContainText('phrase("C4:q")');
  expect(
    await doc
      .locator("p")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily),
  ).not.toMatch(/mono|Consolas|Courier/i);
  await expect(
    doc.locator("script, img, [style], [id=run], a[href^='javascript:']"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).markdownExecuted),
  ).toBeUndefined();
  await doc.getByRole("link", { name: "continue" }).click();
  await expect(page.locator("#source-path")).toHaveText("notes/guide.md");
  expect(await doc.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await doc.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page.locator("#source-path")).toHaveText("README.md");
  await doc.getByRole("link", { name: "open source" }).click();
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(doc).toBeHidden();
});

test("nested libraries, entry selection, inspector visibility, and analysis source", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#run")).toContainText("Rebuild");
  await page.locator('[data-core-folder="contrib"] > summary').click();
  await page
    .locator('[data-folder="library:contrib/unreal"] > summary')
    .click();
  await page
    .locator('[data-folder="library:contrib/unreal/metal-gtx"] > summary')
    .click();
  await expect(
    page.locator('[data-file="contrib/unreal/metal-gtx/metal-gtx.muz"]'),
  ).toBeVisible();
  await page
    .locator('[data-file="contrib/unreal/metal-gtx/metal-gtx.muz"]')
    .click();
  await expect(page.locator("#requirements")).toContainText("External samples");
  await page.locator("#entry-select").selectOption("production.muz");
  await expect(page.locator("#source-path")).toHaveText("production.muz");
  await expect(page.locator("#entry-label")).toHaveText(
    "Active entry: song.muz",
  );
  await page.locator("#run").click();
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#toggle-inspector").click();
  await expect(page.locator("#inspector")).toBeHidden();
  await page.locator("#analysis-source").selectOption("lead");
  await expect(page.locator("#analysis-detail")).toHaveText(
    "Track output · before buses",
  );
  const silent = await page
    .locator("#scope")
    .evaluate((el: HTMLCanvasElement) => el.toDataURL());
  await page.locator("#play").click();
  await expect
    .poll(() =>
      page
        .locator("#scope")
        .evaluate((el: HTMLCanvasElement) => el.toDataURL()),
    )
    .not.toBe(silent);
  await page.locator("#analysis-source").selectOption("");
  await expect(page.locator("#analysis-detail")).toHaveText("Master output");
});

test("mounted folder saves source and new files, and refuses external changes", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Writable directory picker integration targets supporting browsers",
  );
  await page.addInitScript(() => {
    // Real browser file handles and writable streams; only the OS picker and its permission UI are substituted.
    const setup = async () => {
      const root = await navigator.storage.getDirectory();
      const song = await root.getFileHandle("song.muz", { create: true });
      const writer = await song.createWritable();
      await writer.write(
        'use "std/synthesis" as s; song({tracks: [track("tone", phrase("C4:q"), s.pluck())]})',
      );
      await writer.close();
      return root;
    };
    let mounted: Promise<FileSystemDirectoryHandle> | undefined;
    (window as any).showDirectoryPicker = async () => {
      const root = await (mounted ??= setup());
      return {
        kind: "directory",
        name: "Mounted project",
        values: async function* () {
          if ((window as any).failFolderRead)
            throw new Error("Folder temporarily unavailable");
          yield* (root as any).values();
        },
        getDirectoryHandle: root.getDirectoryHandle.bind(root),
        getFileHandle: root.getFileHandle.bind(root),
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
      };
    };
  });
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator("#mount-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Mounted project");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await expect(page.locator("#reload-folder")).toBeVisible();
  await expect(page.locator("#save-folder")).toBeDisabled();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// saved from muzpad");
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("song.muz")
        ).getFile()
      ).text(),
    ),
  ).toContain("saved from muzpad");
  await page.locator("#add-file").click();
  await page.locator("#new-file-name").fill("parts/nested/voice.muz");
  await page.locator("#create-file").click();
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const nested = await (
        await root.getDirectoryHandle("parts")
      ).getDirectoryHandle("nested");
      return (await (await nested.getFileHandle("voice.muz")).getFile()).text();
    }),
  ).toContain("New musical material");
  await page.locator('[data-file="song.muz"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// local edit");
  await page.evaluate(async () => {
    const file = await (
      await navigator.storage.getDirectory()
    ).getFileHandle("song.muz");
    const writer = await file.createWritable();
    await writer.write("// edited outside");
    await writer.close();
  });
  await page.locator("#save-folder").click();
  await expect(page.locator("#diagnostic-list")).toContainText(
    "changed outside muzpad",
  );
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("song.muz")
        ).getFile()
      ).text(),
    ),
  ).toBe("// edited outside");
  await expect(page.locator(".cm-content")).toContainText("local edit");
  await page.evaluate(() => {
    (window as any).failFolderRead = true;
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#diagnostic-list")).toContainText(
    "Folder temporarily unavailable",
  );
  await expect(page.locator(".cm-content")).toContainText("local edit");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await page.evaluate(async () => {
    (window as any).failFolderRead = false;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("song.muz");
    await root.removeEntry("parts", { recursive: true });
    for (const [path, text] of Object.entries({
      "main.muz":
        'song({tracks:[track("reloaded", phrase("C4:q"), synth("init"))],tail:0.1})',
      "muzpad.json": JSON.stringify({
        title: "Reloaded from disk",
        entry: "main.muz",
      }),
      "README.md": "# New disk document",
    })) {
      const writer = await (
        await root.getFileHandle(path, { create: true })
      ).createWritable();
      await writer.write(text);
      await writer.close();
    }
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Reloaded from disk");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(
    page.locator('[data-kind="project"][data-file="song.muz"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-kind="project"][data-file="README.md"]'),
  ).toBeVisible();
  await expect(page.locator("#source-path")).toHaveText("main.muz");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await expect(page.locator("#save-folder")).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("muzpad-previous-v1")!).files[
          "song.muz"
        ],
    ),
  ).toContain("local edit");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// saved after reload");
  await expect(page.locator("#folder-state")).toContainText("1 unsaved file");
  await page.locator("#save-folder").click();
  await expect(page.locator("#folder-state")).toContainText("Saved to folder");
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("main.muz")
        ).getFile()
      ).text(),
    ),
  ).toContain("saved after reload");
  await page.reload();
  await expect(page.locator("#workspace-mode")).toHaveText("Browser copy");
  await expect(page.locator("#folder-state")).toContainText(
    "no longer connected",
  );
  await expect(page.locator("#reload-folder")).toBeHidden();
  await expect(page.locator("#save-folder")).toBeHidden();
  await expect(page.locator("#download")).toBeVisible();
});

test("mounted folder reload preserves the selected entry and active playback", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Requires writable directory handles");
  await page.addInitScript(() => {
    (window as any).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      for (const [path, source] of Object.entries({
        "muzpad.json": JSON.stringify({ entry: "song.muz" }),
        "song.muz":
          'song({tracks:[track("default", phrase("C4:q").repeat(128), synth("init"))],tail:0.1})',
        "audition.muz":
          'song({tracks:[track("audition", phrase("D4:q"), synth("init"))],tail:0.1})',
      })) {
        const writer = await (
          await root.getFileHandle(path, { create: true })
        ).createWritable();
        await writer.write(source);
        await writer.close();
      }
      return {
        kind: "directory",
        name: "Audition project",
        values: (root as any).values.bind(root),
        getDirectoryHandle: root.getDirectoryHandle.bind(root),
        getFileHandle: root.getFileHandle.bind(root),
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
      };
    };
  });
  await page.goto("./");
  await page.locator("#mount-folder").click();
  await expect(page.locator("#project-title")).toHaveText("Audition project");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await page.locator(".range-menu > summary").click();
  await page.locator("#loop-start").fill("0");
  await page.locator("#loop-end").fill("64");
  await page.locator("#apply-loop").click();
  await page.locator(".range-menu > summary").click();
  await page.locator("#play").click();
  const seconds = async () => {
    const [minutes, seconds] = (await page.locator("#clock").innerText())
      .split(":")
      .map(Number);
    return minutes * 60 + seconds;
  };
  await expect.poll(seconds).toBeGreaterThanOrEqual(2);
  await page.locator("#entry-select").selectOption("audition.muz");
  await expect(page.locator("#entry-label")).toHaveText(
    "Active entry: song.muz",
  );
  await page.locator('[data-kind="project"][data-file="song.muz"]').click();
  await page.locator("#zoom-in").click();
  const zoom = await page.locator("#zoom").inputValue();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write(
      'song({tracks:[track("audition_updated", phrase("E4:q").repeat(128), synth("init"))],tail:0.1})',
    );
    await writer.close();
  });
  // Hold the replacement engine's WASM fetch so playback must survive the rebuild.
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  await page.route("**/muz.wasm", async (route) => {
    await buildGate;
    await route.continue();
  });
  const beforeReload = await seconds();
  try {
    await page.locator("#reload-folder").click();
    await expect(page.locator("#build-state")).toHaveText("Compiling");
    await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
    await expect(page.locator("#play")).toBeEnabled();
    await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#analysis-source option[value='default']"),
    ).toHaveCount(1);
    await expect.poll(seconds).toBeGreaterThan(beforeReload);
    await expect(page.locator("#audio-health")).toHaveText("Audio running");
  } finally {
    releaseBuild();
  }
  await expect(
    page.locator("#analysis-source option[value='audition_updated']"),
  ).toHaveCount(1);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#entry-select")).toHaveValue("audition.muz");
  await expect(page.locator("#source-path")).toHaveText("song.muz");
  await expect(page.locator('[data-tab="project:audition.muz"]')).toBeVisible();
  await expect(page.locator("#zoom")).toHaveValue(zoom);
  await expect(page.locator("#entry-label")).not.toContainText("song.muz");
  await expect(page.locator("#workspace-mode")).toHaveText("Folder connected");
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(seconds).toBeGreaterThan(beforeReload);

  // A rejected disk edit keeps the accepted arrangement and audio running.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write("bad_symbol();");
    await writer.close();
  });
  await page.locator("#reload-folder").click();
  await expect(page.locator("#build-state")).toHaveText("Needs attention");
  await expect(page.locator("#diagnostic-list")).toContainText("bad_symbol");
  await expect(
    page.locator("#analysis-source option[value='audition_updated']"),
  ).toHaveCount(1);
  await expect(page.locator("#play")).toHaveText("Ⅱ Pause");
  const afterFailure = await seconds();
  await expect.poll(seconds).toBeGreaterThan(afterFailure);

  // Reload also respects a paused transport rather than starting it.
  await page.locator("#play").click();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (
      await root.getFileHandle("audition.muz")
    ).createWritable();
    await writer.write(
      'song({tracks:[track("recovered", phrase("F4:q").repeat(128), synth("init"))],tail:0.1})',
    );
    await writer.close();
  });
  await page.locator("#reload-folder").click();
  await expect(
    page.locator("#analysis-source option[value='recovered']"),
  ).toHaveCount(1);
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.locator("#play")).toHaveText("▶ Play");
  await expect.poll(seconds).toBeGreaterThanOrEqual(afterFailure);
});

test("Entrypoints excludes helper modules and refreshes after edits", async ({
  page,
}) => {
  await page.addInitScript(
    (base) =>
      localStorage.setItem(
        "muzpad-draft-v1",
        JSON.stringify({
          ...base,
          files: { ...base.files, "helper.muz": "fn double(x) = x * 2;" },
        }),
      ),
    fixture,
  );
  await page.goto("./");
  await expect(page.locator("#build-state")).toHaveText("Accepted");
  await expect(page.getByLabel("Entrypoints")).toBeEnabled();
  await expect(
    page.locator('#entry-select option[value="production.muz"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('#entry-select option[value="helper.muz"]'),
  ).toHaveCount(0);
  await page.locator('[data-file="helper.muz"]').click();
  await expect(page.locator("#set-entry")).toBeDisabled();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(fixture.files["production.muz"]);
  await expect(
    page.locator('#entry-select option[value="helper.muz"]'),
  ).toHaveCount(1);
  await expect(page.locator("#set-entry")).toBeEnabled();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("fn double(x) = x * 2;");
  await expect(
    page.locator('#entry-select option[value="helper.muz"]'),
  ).toHaveCount(0);
  await expect(page.locator("#set-entry")).toBeDisabled();
});
